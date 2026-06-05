// E2E test: sends text-layer PDF through the full pipeline
// PDF: הורביץ מהנדסים - report_0025 (KW_PARAGRAPH archetype, 21 pages)
'use strict';
const fs = require('fs');
const http = require('http');

const textPath = '/tmp/test_pdf_text.txt';
const b64Path  = '/tmp/test_pdf_b64.txt';

if (!fs.existsSync(textPath) || !fs.existsSync(b64Path)) {
  console.error('Missing /tmp/test_pdf_text.txt or /tmp/test_pdf_b64.txt');
  process.exit(1);
}

const pdfText   = fs.readFileSync(textPath, 'utf8');
const pdfBase64 = fs.readFileSync(b64Path,  'utf8').trim();

const pageCount = 21;
const pageMeta  = Array.from({ length: pageCount }, (_, i) => ({
  page: i + 1,
  hasTextLayer: true,
  hasImages: false
}));

const body = JSON.stringify({
  pdfText,
  propertyType: 'new',
  pdfBase64,
  pageMeta
});

console.log(`Sending ${(body.length / 1024 / 1024).toFixed(2)}MB to localhost:339 ...`);
console.log('Waiting for pipeline (up to 5 min)...\n');

const startMs = Date.now();

const req = http.request({
  hostname: 'localhost',
  port: 339,
  path: '/api/analyze-simple',
  method: 'POST',
  headers: {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body)
  }
}, (res) => {
  let data = '';
  let dots = 0;
  res.on('data', d => {
    data += d;
    if (++dots % 20 === 0) process.stdout.write('.');
  });
  res.on('end', () => {
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log(`\n\nDone in ${elapsed}s\n`);

    let j;
    try { j = JSON.parse(data); }
    catch (e) {
      console.error('JSON parse error:', e.message);
      console.error(data.slice(0, 800));
      process.exit(1);
    }

    if (j.error) {
      console.error('API error:', j.error);
      process.exit(1);
    }

    // ── Summary ────────────────────────────────────────────────
    console.log('=== SUMMARY ===');
    console.log('defects        :', j.defects?.length ?? 'N/A');
    console.log('structureType  :', j.structureType);
    console.log('archetype      :', j.archetype);
    console.log('reportTotal    :', j.reportTotal);
    console.log('');

    // ── Analysis log ───────────────────────────────────────────
    console.log('=== ANALYSIS LOG ===');
    (j.analysisLog || []).forEach(l => console.log(l));
    console.log('');

    // ── Defect spot-check ──────────────────────────────────────
    const defects = j.defects || [];
    console.log(`=== DEFECTS (${defects.length} total) ===`);
    defects.slice(0, 10).forEach((d, i) => {
      console.log(`\n[${i+1}] ${d.title}`);
      console.log(`    area   : ${d.area}`);
      console.log(`    cost   : ₪${d.cost}`);
      console.log(`    action : ${(d.action||'').slice(0,80)}`);
      console.log(`    simple : ${(d.simplified_explanation||'(empty)').slice(0,100)}`);
    });
    if (defects.length > 10) console.log(`\n... and ${defects.length - 10} more`);

    // ── Validation checks ──────────────────────────────────────
    console.log('\n=== VALIDATION ===');
    const hasSimplified = defects.filter(d => d.simplified_explanation && d.simplified_explanation.length > 0);
    const hasArea       = defects.filter(d => d.area && d.area !== 'כללי' && d.area !== '');
    const hasCost       = defects.filter(d => d.cost > 0);

    console.log(`simplified_explanation populated : ${hasSimplified.length}/${defects.length} ${hasSimplified.length > 0 ? '✓' : '✗'}`);
    console.log(`area field non-generic           : ${hasArea.length}/${defects.length} ${hasArea.length > 0 ? '✓' : '~'}`);
    console.log(`cost > 0                         : ${hasCost.length}/${defects.length} ${hasCost.length > 0 ? '✓' : '~'}`);
    console.log(`defects >= 5                     : ${defects.length >= 5 ? '✓' : '✗'} (${defects.length})`);
  });
});

req.on('error', e => { console.error('Request error:', e.message); process.exit(1); });
req.setTimeout(300000, () => { console.log('[timeout 5min]'); req.destroy(); });
req.write(body);
req.end();
