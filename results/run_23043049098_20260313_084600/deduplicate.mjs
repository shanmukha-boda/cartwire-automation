import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const resultsDir = process.argv[2];
const runId = process.argv[3];
const timestamp = process.argv[4];

// Read all JSON files
const files = fs.readdirSync(resultsDir)
  .filter(f => f.endsWith('.json') && !f.includes('PROBLEMATIC') && !f.includes('MASTER') && !f.includes('deduplicate'));

console.log(`Processing ${files.length} JSON files for deduplication...`);

// Collect all problematic pages
let allProblematicPages = [];
let allBrandResults = [];
let fileStats = [];

files.forEach(file => {
  try {
    const filePath = path.join(resultsDir, file);
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    
    // Track file stats
    fileStats.push({
      file: file,
      hasProblematicPages: content.problematicPages ? content.problematicPages.length : 0,
      hasSuccessfulPages: content.successfulPages ? content.successfulPages.length : 0,
      hasErrors: content.errors ? content.errors : 0
    });

    // Collect problematic pages
    if (content.problematicPages && Array.isArray(content.problematicPages)) {
      // Add runId to each problematic page for tracking
      const pagesWithRunId = content.problematicPages.map(page => ({
        ...page,
        discoveredInRun: runId,
        sourceFile: file
      }));
      allProblematicPages = [...allProblematicPages, ...pagesWithRunId];
    }

    // Collect brand results
    if (content.brand && content.assortmentCode) {
      allBrandResults.push({
        brand: content.brand,
        assortmentCode: content.assortmentCode,
        feedUrl: content.feedUrl,
        totalUrlsChecked: content.totalUrlsChecked || 0,
        problematicPagesFound: content.problematicPagesFound || 0,
        successfulPages: content.successfulPages ? content.successfulPages.length : 0,
        errors: content.errors || 0,
        duration: content.duration,
        speedMetrics: content.speedMetrics,
        sourceFile: file
      });
    }
  } catch (err) {
    console.error(`Error processing ${file}:`, err.message);
  }
});

// Deduplicate problematic pages by URL and GTIN
const uniqueProblematicPages = [];
const seen = new Set();

allProblematicPages.forEach(page => {
  // Create a unique key based on URL and GTIN
  const key = `${page.url}|${page.gtin}`;
  
  if (!seen.has(key)) {
    seen.add(key);
    uniqueProblematicPages.push(page);
  } else {
    console.log(`Duplicate found and removed: ${page.url} (GTIN: ${page.gtin})`);
  }
});

console.log(`\nDeduplication Summary:`);
console.log(`- Total raw problematic pages: ${allProblematicPages.length}`);
console.log(`- Unique problematic pages: ${uniqueProblematicPages.length}`);
console.log(`- Duplicates removed: ${allProblematicPages.length - uniqueProblematicPages.length}`);

// Calculate totals
const totalUrlsChecked = fileStats.reduce((sum, stat) => sum + (stat.hasProblematicPages + stat.hasSuccessfulPages + stat.hasErrors), 0);
const totalProblematic = uniqueProblematicPages.length;
const totalSuccessful = fileStats.reduce((sum, stat) => sum + stat.hasSuccessfulPages, 0);
const totalErrors = fileStats.reduce((sum, stat) => sum + stat.hasErrors, 0);

// Create problematic pages report
const problematicReport = {
  generatedAt: new Date().toISOString(),
  runId: runId,
  timestamp: timestamp,
  workflowRun: process.env.GITHUB_RUN_ID || runId,
  totalProblematicPages: totalProblematic,
  totalRawProblematicPages: allProblematicPages.length,
  duplicatesRemoved: allProblematicPages.length - uniqueProblematicPages.length,
  problematicPages: uniqueProblematicPages,
  brandsProcessed: allBrandResults.map(b => ({
    brand: b.brand,
    assortmentCode: b.assortmentCode,
    totalProblematicPages: b.problematicPagesFound
  }))
};

fs.writeFileSync(
  path.join(resultsDir, 'pdpCheckResults_ALL_PROBLEMATIC.json'),
  JSON.stringify(problematicReport, null, 2)
);

// Create master report
const masterReport = {
  generatedAt: new Date().toISOString(),
  runId: runId,
  timestamp: timestamp,
  workflowRun: process.env.GITHUB_RUN_ID || runId,
  totalFilesProcessed: files.length,
  summary: {
    totalUrlsChecked: totalUrlsChecked,
    totalProblematicPages: totalProblematic,
    totalSuccessfulPages: totalSuccessful,
    totalErrors: totalErrors,
    duplicatesRemoved: allProblematicPages.length - uniqueProblematicPages.length
  },
  fileStats: fileStats,
  brandResults: allBrandResults
};

fs.writeFileSync(
  path.join(resultsDir, 'pdpCheckResults_MASTER_REPORT.json'),
  JSON.stringify(masterReport, null, 2)
);

// Create summary
const summary = {
  runId: runId,
  timestamp: timestamp,
  workflowRun: process.env.GITHUB_RUN_ID || runId,
  totalUrlsChecked: totalUrlsChecked,
  totalProblematicPages: totalProblematic,
  totalSuccessfulPages: totalSuccessful,
  totalErrors: totalErrors,
  duplicatesRemoved: allProblematicPages.length - uniqueProblematicPages.length,
  successRate: totalUrlsChecked > 0 ? ((totalSuccessful / totalUrlsChecked) * 100).toFixed(2) + '%' : '0%',
  errorRate: totalUrlsChecked > 0 ? ((totalErrors / totalUrlsChecked) * 100).toFixed(2) + '%' : '0%',
  problematicRate: totalUrlsChecked > 0 ? ((totalProblematic / totalUrlsChecked) * 100).toFixed(2) + '%' : '0%'
};

fs.writeFileSync(
  path.join(resultsDir, 'summary.json'),
  JSON.stringify(summary, null, 2)
);

console.log('\nFinal Summary:');
console.log(JSON.stringify(summary, null, 2));
