import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { HttpsAgent } from "agentkeepalive";

const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 200 });

// Generate a short, unique hash from a string (first 8 chars of SHA256)
function shortHash(str) {
  return createHash("sha256").update(str).digest("hex").slice(0, 8);
}

async function fetchWidgetData(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, {
      agent: httpsAgent,
      signal: controller.signal,
      headers: {
        "User-Agent": 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml",
        "Connection": "keep-alive"
      }
    });
    if (!res.ok) throw new Error(`HTTP Error: ${res.status} ${res.statusText}`);
    const html = await res.text();
    clearTimeout(timeout);
    const widgetMatch = html.match(/<[^>]*data-ref="cartwire-bin-widget"[^>]*>/);
    if (!widgetMatch) return null;
    const tag = widgetMatch[0];
    return {
      gtin: tag.match(/data-gtin="([^"]+)"/)?.[1],
      brandCode: tag.match(/data-brand-code="([^"]+)"/)?.[1],
      locale: tag.match(/data-locale="([^"]+)"/)?.[1],
      brandName: tag.match(/data-nltx-brand-name="([^"]+)"/)?.[1]
    };
  } catch (err) {
    throw err;
  }
}

function extractGtinFromUrl(url) {
  const patterns = [
    /[/-](\d{12,14})[/-]/,
    /gtin[=:](\d{12,14})/i,
    /(\d{12,14})(?:\.html|\/)/,
    /\.html\/(\d{12,14})/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function checkBinForError(widgetData, pageUrl, gtinFromUrl) {
  const gtin = widgetData?.gtin || gtinFromUrl;
  if (!gtin) return { found: false, reason: "No GTIN available" };
  if (!widgetData || !widgetData.brandName || !widgetData.locale || !widgetData.brandCode) {
    return { found: false, reason: "Insufficient widget data to construct bin URL" };
  }
  const url = `https://bin.cartwire.co/services/hashlanginfobutton?brand_name=${encodeURIComponent(widgetData.brandName)}&locale=${widgetData.locale}&brand_code=${widgetData.brandCode}&gtin=${gtin}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, { agent: httpsAgent, signal: controller.signal });
    clearTimeout(timeout);
    const scriptText = await response.text();
    const errorPhrases = [
      `Widget is inActive for GTIN : ${gtin}`,
      `There is a problem with one of the products Buy It Now`,
      `BIN button is not working`
    ];
    const found = errorPhrases.some(phrase => scriptText.includes(phrase));
    return { found, gtin, debug: { url, scriptPreview: scriptText.slice(0, 200) } };
  } catch (err) {
    return { found: false, error: err.message };
  }
}

async function main() {
  console.log("Start time", new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }));
  const args = process.argv.slice(2);

  // Determine worker index from env or third argument
  let worker = 0;
  if (process.env.WORKER) worker = parseInt(process.env.WORKER, 10) || 0;
  if (args.length >= 3) worker = parseInt(args[2], 10) || worker;

  let targetBrand = null;
  let targetAssortmentCode = null;
  let processAll = false;

  const productUrlsFile = path.join(process.cwd(), "productPageUrls.json");
  if (!fs.existsSync(productUrlsFile)) {
    throw new Error(`File not found: ${productUrlsFile}`);
  }
  const productData = JSON.parse(fs.readFileSync(productUrlsFile, "utf8"));

  if (args.length === 0) {
    console.log("\nAvailable brands and assortment codes:");
    productData.data.forEach((entry, index) => {
      console.log(`${index + 1}. ${entry.brand} (${entry.assortmentCode}) - ${entry.productPageUrls.length} URLs`);
    });
    console.log("\nUsage: node checkPdpPages.js [brand] [assortmentCode] or node checkPdpPages.js all");
    process.exit(0);
  }

  if (args[0] === "all") {
    processAll = true;
  } else {
    targetBrand = args[0];
    targetAssortmentCode = args[1] || (() => { console.error("Assortment code required"); process.exit(1); })();
  }

  let brandsToProcess = productData.data;
  if (!processAll) {
    const targetEntry = productData.data.find(e => e.brand === targetBrand && e.assortmentCode === targetAssortmentCode);
    if (!targetEntry) {
      console.error(`Brand not found: ${targetBrand} (${targetAssortmentCode})`);
      process.exit(1);
    }
    brandsToProcess = [targetEntry];
  }

  const allResults = [];
  const allProblematicPages = [];

  for (let brandIndex = 0; brandIndex < brandsToProcess.length; brandIndex++) {
    const brandData = brandsToProcess[brandIndex];
    const { brand, assortmentCode, feedUrl, productPageUrls } = brandData;
    const uniqueId = shortHash(feedUrl); // unique per feed URL
    console.log(`\nProcessing: ${brand} (${assortmentCode}) – ${productPageUrls.length} URLs [worker ${worker}, id ${uniqueId}]`);

    const startTime = Date.now();
    const results = [];
    const batchSize = 80;

    for (let i = 0; i < productPageUrls.length; i += batchSize) {
      const batch = productPageUrls.slice(i, i + batchSize);
      const batchPromises = batch.map(async (url, idx) => {
        const globalIndex = i + idx + 1;
        process.stdout.write(`\r[${globalIndex}/${productPageUrls.length}] Checking...`);
        try {
          const widgetData = await fetchWidgetData(url);
          const gtinFromUrl = extractGtinFromUrl(url);
          const binCheck = await checkBinForError(widgetData, url, gtinFromUrl);
          if (binCheck.found) {
            return {
              type: "problematic",
              brand,
              assortmentCode,
              feedUrl,
              url,
              gtin: binCheck.gtin,
              checkedAt: new Date().toISOString(),
              debug: binCheck.debug,
            };
          } else {
            return {
              type: "successful",
              url,
              gtin: gtinFromUrl,
              checkedAt: new Date().toISOString(),
              note: binCheck.reason || "No error detected",
            };
          }
        } catch (err) {
          return {
            type: "error",
            url,
            error: err.message,
            checkedAt: new Date().toISOString(),
          };
        }
      });
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    const problematic = results.filter(r => r.type === "problematic");
    const successful = results.filter(r => r.type === "successful");
    const errors = results.filter(r => r.type === "error");
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\nSummary: ${problematic.length} problematic, ${successful.length} successful, ${errors.length} errors in ${duration}s`);

    const brandResult = {
      brand,
      assortmentCode,
      feedUrl,
      totalUrlsChecked: results.length,
      problematicPagesFound: problematic.length,
      successfulPages: successful.length,
      errors: errors.length,
      duration: `${duration}s`,
      speed: `${(results.length / duration).toFixed(2)} URLs/s`,
      problematicPages: problematic,
    };
    allResults.push(brandResult);
    allProblematicPages.push(...problematic);

    // Unique filenames with brand, assortment, uniqueId, and worker
    const outputFileName = `pdpCheckResults_${brand}_${assortmentCode}_${uniqueId}_worker_${worker}.json`;
    const problematicFileName = `pdpCheckResults_PROBLEMATIC_${brand}_${assortmentCode}_${uniqueId}_worker_${worker}.json`;

    fs.writeFileSync(outputFileName, JSON.stringify(brandResult, null, 2));
    console.log(`Saved ${outputFileName}`);

    if (problematic.length > 0) {
      fs.writeFileSync(problematicFileName, JSON.stringify({
        generatedAt: new Date().toISOString(),
        brand,
        assortmentCode,
        feedUrl,
        totalProblematicPages: problematic.length,
        problematicPages: problematic,
      }, null, 2));
      console.log(`Saved problematic pages to ${problematicFileName}`);
    }
  }

  // Optionally save a combined problematic file per worker (all feed URLs)
  if (allProblematicPages.length > 0) {
    const allProblematicFile = `pdpCheckResults_ALL_PROBLEMATIC_worker_${worker}.json`;
    fs.writeFileSync(allProblematicFile, JSON.stringify({
      generatedAt: new Date().toISOString(),
      worker,
      totalProblematicPages: allProblematicPages.length,
      problematicPages: allProblematicPages,
    }, null, 2));
    console.log(`All problematic pages saved to ${allProblematicFile}`);
  }

  console.log("End time:", new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }));
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
