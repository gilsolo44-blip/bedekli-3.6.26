#!/usr/bin/env node
// Sprint 1 — Scale Audit Failure Gate
// Proves 5 architectural flaws BEFORE any fix:
//   FLAW-A: PROVIDERS_LARGE === PROVIDERS_FAST (identical arrays → rate-limit collision)
//   FLAW-B: makeStructureOutline sends unbounded text (no char cap → LLM truncates)
//   FLAW-C: Rejection gate avg>15 too permissive (5 sections on 73p passes)
//   FLAW-D: step3d_llmCostRefine is a hidden serialized LLM call in the hot path
//   FLAW-E: No server.setTimeout() — dead connections burn API quota
// Run BEFORE fixes: all 5 must FAIL. Run AFTER fixes: all 5 must PASS.
'use strict';
const fs   = require('fs');
const path = require('path');
const http = require('http');

const SRC = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
let failures = 0;

function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ${PASS}  ${label}`); }
  else           { console.log(`  ${FAIL}  ${label}${detail ? ' — ' + detail : ''}`); failures++; }
}

// ── Build a realistic 100-page synthetic PDF ─────────────────────────────────
const ROOMS_100P = [
  { name: 'כניסה לדירה',      start: 5,  end: 14 },
  { name: 'סלון ופינת אוכל',  start: 15, end: 24 },
  { name: 'מטבח',              start: 25, end: 34 },
  { name: 'חדר שינה הורים',   start: 35, end: 44 },
  { name: 'חדר רחצה הורים',   start: 45, end: 54 },
  { name: 'ממ"ד',              start: 55, end: 64 },
  { name: 'חדר ילדים 1',      start: 65, end: 74 },
  { name: 'חדר ילדים 2',      start: 75, end: 84 },
  { name: 'שירותים',           start: 85, end: 90 },
  { name: 'מרפסת סלון',        start: 91, end: 95 },
  { name: 'חניה ומחסן',        start: 96, end: 100 },
];

function make100PagePdf() {
  let doc = '';
  for (let p = 1; p <= 4; p++) {
    doc += `\n--- עמוד ${p} ---\nמבוא ומתודולוגיה\nחברת בדק-בית מקצועי\n`;
  }
  for (const { name, start, end } of ROOMS_100P) {
    for (let p = start; p <= end; p++) {
      const heading = p === start ? name : `המשך ${name}`;
      doc += `\n--- עמוד ${p} ---\n${heading}\n`;
      doc += `ליקוי מספר ${p - start + 1}: בעיה בגימור הקירות\n`;
      doc += `תיאור: נמצאה בעיה בינונית המצריכה טיפול מקצועי בהקדם האפשרי\n`;
      doc += `המלצה: יש לתקן ולבצע בדיקת ביקורת תוך 30 יום\nעלות משוערת: ₪2,500-4,000\n`;
    }
  }
  doc += `\n--- עמוד 100 ---\nטבלת סיכום עלויות\nסה"כ ₪287,450\n`;
  return doc;
}

// ── Helper: POST to analyze-simple ───────────────────────────────────────────
function postAnalyze(pdfText, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify({ pdfText, propertyType: 'new' });
    const req = http.request({
      hostname: 'localhost', port: 3000,
      path: '/api/analyze-simple', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) }
    }, res => {
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

console.log('\n══════════════════════════════════════════════════════');
console.log(' Sprint 1 — Scale Audit Gate (5 Flaws)');
console.log('══════════════════════════════════════════════════════\n');

(async () => {

  // ── FLAW-A: PROVIDERS_STRUCT exists and step1_llm uses it ───────────────
  console.log('FLAW-A: Provider array differentiation');
  const hasStructArray = /const PROVIDERS_STRUCT\s*=/.test(SRC);
  assert(
    'PROVIDERS_STRUCT defined (Gemini-first, isolated from step3 rate limits)',
    hasStructArray,
    'No PROVIDERS_STRUCT found — step1_llm competes with step3 for same Groq quota'
  );
  // step1_llm must call tryProviders with PROVIDERS_STRUCT
  const step1Fn = SRC.match(/function step1_llm[\s\S]{0,1400}/)?.[0] || '';
  const step1UsesStruct = /PROVIDERS_STRUCT/.test(step1Fn);
  assert(
    'step1_llm routes to PROVIDERS_STRUCT (not PROVIDERS_FAST or PROVIDERS_LARGE)',
    step1UsesStruct,
    'step1_llm still uses shared provider — rate-limit collision with step3 remains'
  );

  // ── FLAW-B: makeStructureOutline — char cap ──────────────────────────────
  console.log('\nFLAW-B: makeStructureOutline output size cap');
  const outlineFn = SRC.match(/function makeStructureOutline[\s\S]{0,600}/)?.[0] || '';
  const hasCharCap = /slice\s*\(\s*0\s*,|\.substring\s*\(|OUTLINE_MAX|MAX_OUTLINE|outline.*slice|lines\.slice/.test(outlineFn);
  assert(
    'makeStructureOutline has output size cap (prevents LLM truncation)',
    hasCharCap,
    'No cap found — 100p PDF sends ~70KB to LLM, truncating structured output'
  );
  // Must also check the cap is <= 6000 chars
  const capVal = outlineFn.match(/(?:OUTLINE_MAX|MAX_OUTLINE|\bslice\b\s*\(\s*0\s*,)\s*(\d+)/)?.[1];
  if (hasCharCap && capVal) {
    assert(
      `Outline cap is ≤ 6000 chars (got ${capVal})`,
      parseInt(capVal) <= 6000,
      `cap=${capVal} — Groq 6144-token output limit makes larger caps unreliable`
    );
  }

  // ── FLAW-C: Rejection gate permissiveness ────────────────────────────────
  console.log('\nFLAW-C: step1_llm rejection gate tightness');
  // Accept either: dynamic Math.max(10, totalPages/10) gate OR legacy literal ≤ 10
  const hasDynamicGate = /Math\.max\s*\(\s*10\s*,\s*totalPages\s*\/\s*10\s*\)/.test(SRC);
  const legacyMatch = SRC.match(/avg\s*[>>=]+\s*(\d+(?:\.\d+)?)/g);
  const legacyThresholds = legacyMatch ? legacyMatch.map(m => parseFloat(m.match(/[\d.]+$/)[0])) : [];
  const tightest = legacyThresholds.length ? Math.min(...legacyThresholds) : null;
  const legacyOk = tightest !== null && tightest <= 10;
  assert(
    `Rejection gate is scale-aware (dynamic Math.max gate OR legacy threshold ≤ 10)`,
    hasDynamicGate || legacyOk,
    hasDynamicGate ? '' : `avg>${tightest} — gate too permissive for large PDFs`
  );

  // ── FLAW-D: step3d in hot path ───────────────────────────────────────────
  console.log('\nFLAW-D: step3d_llmCostRefine removed from synchronous hot path');
  // Verify step3d either doesn't exist, has a fast-path bypass, or is fire-and-forget
  const hasStep3d = /function step3d_llmCostRefine/.test(SRC);
  const step3dCallInPipeline = /step3d_llmCostRefine\s*\(/.test(
    SRC.slice(SRC.indexOf('function pipeline'), SRC.indexOf('function startServer') || SRC.length)
  );
  if (!hasStep3d) {
    assert('step3d_llmCostRefine removed from codebase', true);
  } else {
    // If it exists, it must have a candidate-count short-circuit at 0
    const step3dFn = SRC.match(/function step3d_llmCostRefine[\s\S]{0,1000}/)?.[0] || '';
    const hasQuickReturn = /candidates\.length\s*===\s*0[\s\S]{0,120}return\s*callback/.test(step3dFn) ||
                           /candidates\.length\s*<\s*1[\s\S]{0,120}return\s*callback/.test(step3dFn);
    const hasMaxCandidates = /\.slice\s*\(\s*0\s*,\s*(?:MAX_3D\w*|\d+)\s*\)/.test(step3dFn) ||
                             /MAX_3D_CANDIDATES/.test(step3dFn);
    assert(
      'step3d is bypassed or capped (not an unbounded serialized LLM call)',
      !step3dCallInPipeline || (hasQuickReturn && hasMaxCandidates),
      step3dCallInPipeline
        ? `step3d is in pipeline with hasQuickReturn=${hasQuickReturn} hasMaxCandidates=${hasMaxCandidates}`
        : 'step3d not called in pipeline'
    );
  }

  // ── FLAW-E: Server connection timeout ────────────────────────────────────
  console.log('\nFLAW-E: HTTP server connection timeout guard');
  const serverBlock = SRC.slice(SRC.indexOf('function startServer') || 0);
  const hasServerTimeout = /server\.setTimeout\s*\(|server\.headersTimeout\s*=|createServer[\s\S]{0,200}\.setTimeout|socket\.setTimeout\s*\(|on\s*\(\s*['"]connection['"][\s\S]{0,100}setTimeout/.test(serverBlock);
  assert(
    'http server has connection/socket timeout guard',
    hasServerTimeout,
    'Dead connections hold sockets open; server keeps burning API quota for disconnected clients'
  );

  // ── LIVE E2E: 100-page synthetic — step1 section count ──────────────────
  console.log('\nE2E: 100-page synthetic PDF — step1 section detection');
  console.log('  (sending to localhost:3000, timeout=30s, checks step1 log only)');
  const pdfText = make100PagePdf();
  console.log(`  PDF size: ${(Buffer.byteLength(pdfText)/1024).toFixed(0)} KB, pages: 100`);
  try {
    const t0 = Date.now();
    const r  = await postAnalyze(pdfText, 30000);
    const ms = Date.now() - t0;
    if (r.status === 200) {
      const data = JSON.parse(r.body);
      const log  = data.analysisLog || [];
      const step1Line = log.find(l => l.includes('[Step 1] ->'));
      const sections  = parseInt((step1Line || '').match(/(\d+)\s*סקשנים/)?.[1] || '0');
      console.log(`  Response: ${ms}ms | ${data.defects?.length ?? 0} defects | step1: "${step1Line || 'not found'}"`);
      assert(
        `step1 detects ≥ 8 sections on 100-page PDF (got ${sections})`,
        sections >= 8,
        `Expected ≥8 room sections; got ${sections} — LLM returned under-segmented structure`
      );
      assert(
        `≥ 10 defects extracted from 100-page PDF (got ${data.defects?.length ?? 0})`,
        (data.defects?.length ?? 0) >= 10,
        'Scale failure: 100-page PDF should yield many defects'
      );
      assert(
        `Response latency < 120s (got ${Math.round(ms/1000)}s)`,
        ms < 120000,
        `${Math.round(ms/1000)}s — pipeline too slow for production`
      );
    } else if (r.status === 413) {
      assert('Server did not 413 reject valid 100-page PDF', false, 'Payload limit too low');
    } else {
      const err = (() => { try { return JSON.parse(r.body).error; } catch { return r.body.slice(0,80); } })();
      assert('Server returned 200 for 100-page PDF', false, `HTTP ${r.status}: ${err}`);
    }
  } catch (e) {
    if (e.message === 'TIMEOUT') {
      assert('E2E response within 30s', false, 'TIMEOUT — pipeline stalled');
    } else {
      assert('E2E request succeeded', false, e.message);
    }
  }

  // ── SUMMARY ─────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  const total = 9; // A(2) + B(1-2) + C(1) + D(1) + E(1) + live(3) — approximate
  if (failures === 0) {
    console.log(` ${PASS}  All checks pass — system is scale-agnostic. Ship it.`);
  } else {
    console.log(` ${FAIL}  ${failures} flaw(s) confirmed — execute Sprint 2→4 fixes.`);
    console.log(`  Priority order: FLAW-A → FLAW-B → FLAW-C → FLAW-D → FLAW-E`);
  }
  console.log('══════════════════════════════════════════════════════\n');
  process.exit(failures > 0 ? 1 : 0);
})();
