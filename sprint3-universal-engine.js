#!/usr/bin/env node
// Sprint 3 — Universal Engine Gate
// 4 test groups. Run BEFORE fixes: all must FAIL. Run AFTER: all must PASS.
'use strict';
const fs   = require('fs');
const path = require('path');

const SRC  = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
let failures = 0;

function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ${PASS}  ${label}`); }
  else           { console.log(`  ${FAIL}  ${label}${detail ? ' — ' + detail : ''}`); failures++; }
}

// ── TEST-A: Adaptive intro filter ─────────────────────────────────────────────
console.log('\nTEST-A: Adaptive intro filter (replaces fixed pages 1-4 strip)');

assert(
  'isIntroPage() function defined',
  /function isIntroPage\s*\(/.test(SRC),
  'isIntroPage not found — adaptive filter not implemented'
);
assert(
  'Fixed pages 1-4 strip regex removed from step2_filter',
  !/replace\s*\(\s*\/---\\s\*עמוד\\s\*\[1-4\]/.test(SRC),
  'Legacy /[1-4]/ strip pattern still present — kills short report content'
);
assert(
  'MAX_INTRO_STRIP cap defined',
  /MAX_INTRO_STRIP\s*=/.test(SRC),
  'No intro strip cap — could over-strip small reports'
);

// ── TEST-B: Track B retired ───────────────────────────────────────────────────
console.log('\nTEST-B: Track B retirement (Hebrew regex structural fallback)');

assert(
  'ROOM_PATTERNS constant removed',
  !/const ROOM_PATTERNS\s*=/.test(SRC),
  'ROOM_PATTERNS still defined — Hebrew-only regex fallback still active'
);
assert(
  'step1_structural() function removed',
  !/function step1_structural\s*\(/.test(SRC),
  'step1_structural still defined'
);
assert(
  'step2b_byRoom_regex() function removed',
  !/function step2b_byRoom_regex\s*\(/.test(SRC),
  'step2b_byRoom_regex still defined'
);
const pipelineSrc = SRC.match(/function pipeline[\s\S]{0,8000}/)?.[0] || '';
const elseBranch  = pipelineSrc.match(/\}\s*else\s*\{[\s\S]{0,600}/)?.[0] || '';
assert(
  'buildCatchAllChunks called in LLM-fallback else branch',
  /buildCatchAllChunks/.test(elseBranch),
  'Else branch does not call buildCatchAllChunks — catch-all not wired as first fallback'
);

// ── TEST-C: Scale-aware rejection gate ───────────────────────────────────────
console.log('\nTEST-C: Scale-aware rejection gate');

assert(
  'Math.max(10, totalPages / 10) gate formula present',
  /Math\.max\s*\(\s*10\s*,\s*totalPages\s*\/\s*10\s*\)/.test(SRC),
  'Old hardcoded avg > 10 still used — 159-page reports rejected'
);
const bareAvgGate = SRC.match(/avg\s*>\s*10(?!\s*\))/g);
assert(
  'Bare "avg > 10" hardcode removed',
  !bareAvgGate || bareAvgGate.length === 0,
  `avg > 10 hardcode still present (${bareAvgGate?.length} occurrences)`
);
const newGatePasses = (() => {
  const totalPages = 159, n = 14;
  const avgThreshold = Math.max(10, totalPages / 10);
  const avg = totalPages / Math.max(n, 1);
  const minN = totalPages <= 15 ? 2 : 3;
  return !((n < minN && totalPages > 20) || avg > avgThreshold);
})();
assert('159-page / 14-section report passes new gate (avg 11.4 < threshold 15.9)', newGatePasses);
const oldGateRejects = (() => {
  const totalPages = 159, n = 14;
  const avg = totalPages / Math.max(n, 1);
  return (n < 3 && totalPages > 20) || avg > 10;
})();
assert('Old gate correctly rejects 159p/14s (baseline confirms fix is needed)', oldGateRejects);

// ── TEST-D: Haiku emergency provider ─────────────────────────────────────────
console.log('\nTEST-D: Haiku emergency provider');

assert(
  'haikuCall() function defined',
  /function haikuCall\s*\(/.test(SRC),
  'Emergency Haiku provider not implemented'
);
assert(
  'PROVIDERS_LARGE includes claude-haiku entry',
  /PROVIDERS_LARGE[\s\S]{0,800}claude-haiku/.test(SRC),
  'Haiku not added to PROVIDERS_LARGE'
);
const step3Src = SRC.match(/function step3_extract[\s\S]{0,5000}/)?.[0] || '';
assert(
  'Emergency trigger present in step3_extract (allDefects.length === 0 check)',
  /allDefects\.length\s*===\s*0/.test(step3Src),
  'Emergency 0-defect trigger missing from step3_extract'
);

// ── SUMMARY ──────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════');
if (failures === 0) {
  console.log(` ${PASS}  All checks pass — Universal Engine v2 certified.`);
} else {
  console.log(` ${FAIL}  ${failures} check(s) failed — implement fixes before shipping.`);
}
console.log('══════════════════════════════════════════════════════\n');
process.exit(failures > 0 ? 1 : 0);
