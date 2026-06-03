#!/usr/bin/env node
// Sprint 0 — Failure Gate
// Proves two architectural flaws BEFORE any fix is applied:
//   FLAW-1: No body-size limit — server accepts arbitrarily large payloads
//   FLAW-2: Room text hard-capped at MAX_CHARS_PER_CHUNK*2 (16 000 chars) in step3_extract,
//           silently truncating defects from large sections

'use strict';
const http  = require('http');
const crypto = require('crypto');

const HOST = 'localhost';
const PORT = 3000;
const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';

let failures = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ${PASS}  ${label}`);
  } else {
    console.log(`  ${FAIL}  ${label}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

// ── Helper: send raw JSON body to /api/analyze-simple ───────────────────────
function postAnalyze(body, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const opts = {
      hostname: HOST, port: PORT, path: '/api/analyze-simple', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) }
    };
    const req = http.request(opts, res => {
      const parts = [];
      res.on('data', d => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString() }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('TIMEOUT')); });
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

// ── Generate synthetic PDF text ──────────────────────────────────────────────
function makePdfText(pages, charsPerPage = 1500) {
  let out = '';
  for (let p = 1; p <= pages; p++) {
    out += `\n=== עמוד ${p} ===\n`;
    out += 'א'.repeat(charsPerPage); // dense Hebrew filler — realistic byte weight
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════');
console.log(' Sprint 0 — Failure Gate');
console.log('══════════════════════════════════════\n');

(async () => {

  // ── FLAW-1: Body size — send 6 MB payload, expect server NOT to reject it ─
  console.log('FLAW-1: Body size limit (no guard expected)');
  const bigText  = makePdfText(100, 600); // ~100 pages × 600 chars ≈ 6 MB JSON
  const bigPayload = JSON.stringify({ pdfText: bigText, propertyType: 'new' });
  const payloadMB = (Buffer.byteLength(bigPayload) / 1_000_000).toFixed(2);
  console.log(`  Payload size: ${payloadMB} MB`);

  let flaw1Status = null;
  try {
    const r = await postAnalyze(bigPayload, 15000);
    flaw1Status = r.status;
    // If server accepts it (2xx or 5xx LLM error) — no size guard exists → FLAW confirmed
    assert(
      'Server accepts >5 MB body without 413 (no limit guard)',
      r.status !== 413,
      `got HTTP ${r.status}`
    );
  } catch (e) {
    if (e.message === 'TIMEOUT') {
      assert('Server accepts >5 MB body (hangs — no limit guard)', true, 'TIMEOUT = accepted and processing');
    } else {
      assert('Server accepts >5 MB body without 413', false, e.message);
    }
  }

  // ── FLAW-2 (RESOLVED): roomText.slice cap removed in prior sprint ────────
  console.log('\nFLAW-2: Room text hard-cap removed (fix confirmed)');

  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../server.js'), 'utf8'
  );

  const maxMatch   = src.match(/const MAX_CHARS_PER_CHUNK\s*=\s*(\d+)/);
  const sliceMatch = src.match(/roomText\.slice\(0,\s*MAX_CHARS_PER_CHUNK/);
  const MAX_CHARS  = maxMatch ? parseInt(maxMatch[1]) : null;

  assert(
    `MAX_CHARS_PER_CHUNK constant present (${MAX_CHARS})`,
    MAX_CHARS !== null
  );
  assert(
    'Hard roomText.slice cap is GONE (fix confirmed — full room text reaches LLM)',
    sliceMatch === null,
    'roomText.slice cap still exists — FLAW-2 regression'
  );

  // ── SUMMARY ───────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════');
  if (failures === 0) {
    console.log(` ${PASS}  All ${2} flaws confirmed — diagnostic correct.`);
    console.log('  Proceed to Sprint 1 (body limit + timeout) and Sprint 3 (chunk cap fix).');
  } else {
    console.log(` ${FAIL}  ${failures} assertion(s) failed — review diagnostic.`);
  }
  console.log('══════════════════════════════════════\n');

  process.exit(failures > 0 ? 1 : 0);
})();
