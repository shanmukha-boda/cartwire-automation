import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { JSDOM } from "jsdom";
 
/*
Usage:
  node checkPdpPages.js [brand] [assortmentCode]
 
Examples:
  node checkPdpPages.js                                    # Show available brands
  node checkPdpPages.js all                                # Process all brands
  node checkPdpPages.js allthingsbeauty PH                 # Process a specific brand/assortment
*/
 
async function fetchWidgetData(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml",
        "Connection": "keep-alive"
      }
    });
 
    if (!res.ok) {
      throw new Error(`HTTP Error: ${res.status} ${res.statusText}`);
    }
 
    const html = await res.text();
    const dom = new JSDOM(html);
    const document = dom.window.document;
 
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
  // Try to extract GTIN from URL - adjust pattern based on your URL structure
  // Common patterns: /GTIN-, -GTIN, GTIN=, or last numeric sequence
  const gtinPatterns = [
    /[/-](\d{12,14})[/-]/, // 12-14 digit number between slashes or hyphens
    /gtin[=:](\d{12,14})/i, // gtin= or gtin:
    /(\d{12,14})(?:\.html|\/)/, // before .html or /
    /\.html\/(\d{12,14})/, // after .html/
  ];
 
  for (const pattern of gtinPatterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }
 
  return null;
}
 
async function searchForBinErrorScript(widgetData, pageUrl) {
  const gtin = extractGtinFromUrl(pageUrl);
 
  if (!gtin) {
    return {
      found: false,
      gtin: null,
      reason: "Could not extract GTIN from URL",
    };
  }
 
  if (!widgetData) {
    return {
      type: "successful",
      url: pageUrl,
      gtin: extractGtinFromUrl(pageUrl),
      checkedAt: new Date().toISOString(),
    };
  }
 
  const url = `https://bin.cartwire.co/services/hashlanginfobutton?brand_name=${widgetData.brandName}&locale=${widgetData.locale}&brand_code=${widgetData.brandCode}&gtin=${widgetData.gtin}`;
  const response = await fetch(url);
  const scriptText = await response.text();
  const match = scriptText.match(/console\.log\("([^"]+)"\)/);
 
  if (match) {
    console.log("Console message:", match[1]);
  } else {
    console.log("No console message found");
  }
 
  const searchText = `There is a problem with one of the products Buy It Now (BIN) button on this Product Page. BIN button is not working because Widget is inActive for GTIN : ${gtin}. Please reach out to Cartwire Team.`;
 
  // Some pages may split the message or inject via javascript so check pieces too
  if (match && searchText === match[1]) {
    return {
      found: true,
      gtin: gtin,
      url: pageUrl,
      debug: {},
    };
  }
 
  return {
    found: false,
    gtin: gtin,
    debug: {},
  };
}
 
async function main() {
  try {
    // Parse command line arguments
    console.log("start time",new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }));
    const args = process.argv.slice(2);
    let targetBrand = null;
    let targetAssortmentCode = null;
    let processAll = false;
 
    const productUrlsFile = path.join(process.cwd(), "productPageUrls.json");
 
    if (!fs.existsSync(productUrlsFile)) {
      throw new Error(`File not found: ${productUrlsFile}`);
    }
 
    console.log(`Reading product URLs from: ${productUrlsFile}`);
    const productData = JSON.parse(fs.readFileSync(productUrlsFile, "utf8"));
 
    // Show available brands if no arguments provided
    if (args.length === 0) {
      console.log("\nAvailable brands and assortment codes:");
      console.log("=====================================");
      productData.data.forEach((entry, index) => {
        console.log(
          `${index + 1}. ${entry.brand} (${entry.assortmentCode}) - ${entry.productPageUrls.length} URLs`,
        );
      });
      console.log("=====================================");
      console.log("\nUsage:");
      console.log("  node checkPdpPages.js [brand] [assortmentCode]");
      console.log("  node checkPdpPages.js all                          # Process all brands");
      console.log("  node checkPdpPages.js allthingsbeauty PH           # Process specific brand");
      process.exit(0);
    }
 
    // Parse arguments
    if (args.length >= 1) {
      if (args[0] === "all") {
        processAll = true;
      } else {
        targetBrand = args[0];
        if (args.length >= 2) {
          targetAssortmentCode = args[1];
        } else {
          console.error("When specifying brand, you must also provide assortment code.");
          process.exit(1);
        }
      }
    }
 
    // Find brands to process
    let brandsToProcess = productData.data;
 
    if (targetBrand && targetAssortmentCode) {
      console.log(`Looking for brand: ${targetBrand}, assortment: ${targetAssortmentCode}`);
      const targetEntry = productData.data.find(
        (entry) =>
          entry.brand === targetBrand &&
          entry.assortmentCode === targetAssortmentCode,
      );
 
      if (!targetEntry) {
        console.error(`Brand entry not found: ${targetBrand} (${targetAssortmentCode})`);
        console.log("\nAvailable brands:");
        productData.data.forEach((entry) => {
          console.log(`  ${entry.brand} (${entry.assortmentCode})`);
        });
        process.exit(1);
      }
 
      brandsToProcess = [targetEntry];
      console.log(`Found target brand entry. Processing only this brand.`);
    } else if (processAll) {
      console.log(`Processing all ${productData.data.length} brands.`);
    } else {
      console.error('Invalid arguments. Please specify brand and assortment code, or use "all".');
      process.exit(1);
    }
 
    console.log(`Found ${brandsToProcess.length} brands to check`);
 
    const allResults = [];
    const allProblematicPages = [];
 
    for (let brandIndex = 0; brandIndex < brandsToProcess.length; brandIndex++) {
      const brandData = brandsToProcess[brandIndex];
      const brand = brandData.brand;
      const assortmentCode = brandData.assortmentCode;
      const feedUrl = brandData.feedUrl;
 
      console.log(`\n${"=".repeat(80)}`);
      console.log(`[${brandIndex + 1}/${brandsToProcess.length}] Processing: ${brand} (${assortmentCode})`);
      console.log(`Feed URL: ${feedUrl}`);
      console.log(`Total URLs to check: ${brandData.productPageUrls.length}`);
      console.log(`${"=".repeat(80)}\n`);
 
      const startTime = Date.now();
 
      const processUrlFn = async (url, index, total) => {
        try {
          const currentIndex = index + 1;
          process.stdout.write(`\r[${currentIndex}/${total}] Checking: ${url.substring(0, 70)}...`);
         
          const widgetData = await fetchWidgetData(url);
          const result = await searchForBinErrorScript(widgetData, url);
         
          console.log(result);
         
          // Debug: Show what we're checking
          const gtin = extractGtinFromUrl(url);
          if (index < 3) {
            // Log first 3 URLs for debugging
            console.log(`\n  [DEBUG] URL: ${url}`);
            console.log(`  [DEBUG] GTIN extracted: ${gtin}`);
            console.log(`  [DEBUG] Search found: ${result.found}`);
          }
 
          if (result.found) {
            return {
              type: "problematic",
              brand: brand,
              assortmentCode: assortmentCode,
              feedUrl: feedUrl,
              url: url,
              gtin: result.gtin,
              checkedAt: new Date().toISOString(),
            };
          } else {
            return {
              type: "successful",
              url: url,
              gtin: result.gtin,
              checkedAt: new Date().toISOString(),
            };
          }
        } catch (err) {
          return {
            type: "error",
            url: url,
            error: err.message,
            checkedAt: new Date().toISOString(),
          };
        }
      };
 
      const results = [];
      const batchSize = 1000; // You can likely increase this now that Puppeteer is gone
     
      for (let i = 0; i < brandData.productPageUrls.length; i += batchSize) {
    
        const batch = brandData.productPageUrls.slice(i, i + batchSize);
        const batchPromises = batch.map((url, idx) =>
          processUrlFn(url, i + idx, brandData.productPageUrls.length),
        );
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
      }
 
      const problematicPages = results.filter((r) => r.type === "problematic");
      const successfulPages = results.filter((r) => r.type === "successful");
      const errorPages = results.filter((r) => r.type === "error");
 
      const endTime = Date.now();
      const duration = ((endTime - startTime) / 1000).toFixed(2);
 
      console.log(`\n\nSummary for ${brand} (${assortmentCode}):`);
      console.log(`  Total URLs Checked: ${results.length}`);
      console.log(`  Problematic Pages Found: ${problematicPages.length}`);
      console.log(`  Successful Pages: ${successfulPages.length}`);
      console.log(`  Errors: ${errorPages.length}`);
      console.log(`  Time Taken: ${duration}s`);
      console.log(`  Speed: ${(results.length / duration).toFixed(2)} URLs/second`);
 
      const brandResult = {
        brand: brand,
        assortmentCode: assortmentCode,
        feedUrl: feedUrl,
        totalUrlsChecked: results.length,
        problematicPagesFound: problematicPages.length,
        successfulPages: successfulPages.length,
        errors: errorPages.length,
        duration: `${duration}s`,
        speedMetrics: `${(results.length / duration).toFixed(2)} URLs/second`,
        problematicPages: problematicPages,
      };
 
      allResults.push(brandResult);
      if (problematicPages.length > 0) {
        allProblematicPages.push(...problematicPages);
      }
 
      const outputFileName = `pdpCheckResults_${brand}_${assortmentCode}.json`;
      const outputFile = path.join(process.cwd(), outputFileName);
      const output = {
        generatedAt: new Date().toISOString(),
        ...brandResult,
        successfulPages: successfulPages,
        errorPages: errorPages,
      };
 
      fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), "utf8");
      console.log(`Results saved to: ${outputFileName}`);
 
      if (problematicPages.length > 0) {
        const problematicFileName = `pdpCheckResults_PROBLEMATIC_${brand}_${assortmentCode}.json`;
        const problematicFile = path.join(process.cwd(), problematicFileName);
        const problematicOutput = {
          generatedAt: new Date().toISOString(),
          brand: brand,
          assortmentCode: assortmentCode,
          feedUrl: feedUrl,
          totalProblematicPages: problematicPages.length,
          problematicPages: problematicPages,
        };
 
        fs.writeFileSync(
          problematicFile,
          JSON.stringify(problematicOutput, null, 2),
          "utf8",
        );
        console.log(`Problematic pages saved to: ${problematicFileName}`);
      }
    }
 
    console.log(`\n\n${"=".repeat(80)}`);
    console.log(`FINAL SUMMARY`);
    console.log(`${"=".repeat(80)}\n`);
 
    const totalChecked = allResults.reduce((sum, b) => sum + b.totalUrlsChecked, 0);
    const totalProblematic = allResults.reduce((sum, b) => sum + b.problematicPagesFound, 0);
    const totalSuccessful = allResults.reduce((sum, b) => sum + b.successfulPages, 0);
    const totalErrors = allResults.reduce((sum, b) => sum + b.errors, 0);
 
    console.log(`Total Brands Processed: ${allResults.length}`);
    console.log(`Total URLs Checked: ${totalChecked}`);
    console.log(`Total Problematic Pages Found: ${totalProblematic}`);
    console.log(`Total Successful Pages: ${totalSuccessful}`);
    console.log(`Total Errors: ${totalErrors}`);
    console.log(`${"=".repeat(80)}\n`);
 
    // Only create master report if processing multiple brands
    if (brandsToProcess.length > 1) {
      const masterReportFile = path.join(process.cwd(), "pdpCheckResults_MASTER_REPORT.json");
      const masterReport = {
        generatedAt: new Date().toISOString(),
        totalBrandsProcessed: allResults.length,
        totalUrlsChecked: totalChecked,
        totalProblematicPagesFound: totalProblematic,
        totalSuccessfulPages: totalSuccessful,
        totalErrors: totalErrors,
        brandResults: allResults,
      };
 
      fs.writeFileSync(masterReportFile, JSON.stringify(masterReport, null, 2), "utf8");
      console.log(`Master report saved to: pdpCheckResults_MASTER_REPORT.json`);
    }
 
    if (allProblematicPages.length > 0) {
      const allProblematicFile = path.join(process.cwd(), "pdpCheckResults_ALL_PROBLEMATIC.json");
      const allProblematicOutput = {
        generatedAt: new Date().toISOString(),
        totalProblematicPages: allProblematicPages.length,
        problematicPages: allProblematicPages,
      };
 
      fs.writeFileSync(allProblematicFile, JSON.stringify(allProblematicOutput, null, 2), "utf8");
      console.log(`All problematic pages saved to: pdpCheckResults_ALL_PROBLEMATIC.json`);
    }
    console.log("END Time: ",new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }));
  } catch (err) {
    console.error("Error:", err.message || err);
    process.exitCode = 1;
  }
}
 
 main();
