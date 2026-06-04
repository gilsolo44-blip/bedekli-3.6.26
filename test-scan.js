// Test script: sends scanned PDF through the pipeline
const fs = require('fs');
const http = require('http');
const path = require('path');

const pdfPath = '/Users/gilsolo44/Downloads/בדק בית דוגמאות/חברות שונות [35]/בית חדש- לדוגמא.pdf';
const buf = fs.readFileSync(pdfPath);
const pdfBase64 = buf.toString('base64');

// For a scanned PDF: empty text, all pages visual
// Try to detect page count from PDF cross-ref table
let pageCount = 20; // fallback
const raw = buf.toString('binary');
const countMatch = raw.match(/\/N\s+(\d+)/);
if (countMatch) pageCount = parseInt(countMatch[1]);
// Better: count /Page objects
const pageMatches = raw.match(/\/Type\s*\/Page[^s]/g);
if (pageMatches) pageCount = pageMatches.length;
console.log(`Estimated pages: ${pageCount}`);

const pageMeta = Array.from({length: pageCount}, (_, i) => ({
  page: i + 1,
  hasTextLayer: false,
  hasImages: true
}));

const body = JSON.stringify({
  pdfText: '',       // scanned — no text
  propertyType: 'new',
  pdfBase64,
  pageMeta
});

console.log(`Sending ${(body.length / 1024 / 1024).toFixed(1)}MB request...`);
console.log('Watch server output for pipeline logs.\n');

const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/api/analyze-simple',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
}, (res) => {
  let data = '';
  res.on('data', d => { data += d; process.stdout.write('.'); });
  res.on('end', () => {
    console.log('\n--- Response ---');
    try {
      const j = JSON.parse(data);
      console.log('defects:', j.defects?.length ?? 'N/A');
      console.log('structureType:', j.structureType);
      console.log('reportTotal:', j.reportTotal);
      console.log('\n--- analysisLog ---');
      (j.analysisLog || []).forEach(l => console.log(l));
      if (j.defects?.length) {
        console.log('\n--- First 5 defects ---');
        j.defects.slice(0,5).forEach(d => console.log(`[${d.room}] ${d.title} | ${d.severity} | ₪${d.cost}`));
      }
    } catch(e) {
      console.log('Parse error:', e.message);
      console.log(data.slice(0, 500));
    }
  });
});
req.on('error', e => console.error('Request error:', e.message));
req.setTimeout(300000, () => { console.log('\n[timeout after 5min]'); req.destroy(); });
req.write(body);
req.end();
