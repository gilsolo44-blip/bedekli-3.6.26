#!/usr/bin/env node
// Sprint 2 — Price Display Gate
// Proves the buildHero() disconnect BEFORE fix, then verifies after:
//   FLAW-P1: displayMin computed but not used — RT=0 hides price from hero
//   FLAW-P2: viewer.html may have same silent gap
'use strict';
const fs   = require('fs');
const path = require('path');

const REPORT_SRC = fs.readFileSync(path.join(__dirname, '../public/report.html'), 'utf8');
const VIEWER_SRC = fs.readFileSync(path.join(__dirname, '../public/viewer.html'), 'utf8');

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
let failures = 0;

function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ${PASS}  ${label}`); }
  else           { console.log(`  ${FAIL}  ${label}${detail ? ' — ' + detail : ''}`); failures++; }
}

console.log('\n══════════════════════════════════════════════════');
console.log(' Sprint 2 — Price Display Gate');
console.log('══════════════════════════════════════════════════\n');

// ── FLAW-P1: buildHero() uses displayMin for reportCol ────────────────────
console.log('FLAW-P1: buildHero() shows price when RT=0 via displayMin fallback');

// The fix: reportCol condition changes from `RT > 0` to `displayMin > 0`
// and label changes to show 'הערכה' vs 'לפי הדוח'
const heroFn = REPORT_SRC.match(/function buildHero\(\)[\s\S]{0,600}/)?.[0] || '';

const usesDisplayMin = /displayMin\s*>\s*0[\s\S]{0,40}reportCol/.test(heroFn) ||
                       /reportCol\s*=\s*displayMin/.test(heroFn);

assert(
  'buildHero() uses displayMin (not RT) as reportCol condition',
  usesDisplayMin,
  'reportCol gated on RT>0 — disappears when LLM/regex cannot extract PDF total'
);

const hasFallbackLabel = /הערכה/.test(heroFn);
assert(
  "buildHero() shows 'הערכה' label when falling back to summed costs",
  hasFallbackLabel,
  "When RT=0, label should read 'הערכה' not 'לפי הדוח'"
);

// ── FLAW-P2: viewer.html same fix ────────────────────────────────────────
console.log('\nFLAW-P2: viewer.html has matching buildHero() fix');
const viewerHeroFn = VIEWER_SRC.match(/function buildHero\(\)[\s\S]{0,600}/)?.[0] || '';

if (!viewerHeroFn) {
  console.log('  INFO  viewer.html has no buildHero() — skipping');
} else {
  const viewerUsesDisplayMin = /reportCol[\s\S]{0,20}displayMin/.test(viewerHeroFn) ||
                                /displayMin[\s\S]{0,100}reportCol/.test(viewerHeroFn) ||
                                /displayMin\s*>\s*0[\s\S]{0,80}reportCol/.test(viewerHeroFn);
  assert(
    'viewer.html buildHero() also uses displayMin fallback',
    viewerUsesDisplayMin,
    'viewer.html has same RT=0 gap as report.html'
  );
}

// ── STRUCTURAL: dead variable check ──────────────────────────────────────
console.log('\nSTRUCTURAL: displayMin is used (not dead)');
const reportColLine = heroFn.match(/const reportCol\s*=.{0,200}/)?.[0] || '';
const usedInReportCol = /displayMin/.test(reportColLine);
assert(
  'displayMin appears in the reportCol assignment (not a dead variable)',
  usedInReportCol,
  'reportCol expression does not reference displayMin — dead variable'
);

// ── SUMMARY ───────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════');
if (failures === 0) {
  console.log(` ${PASS}  Price display fix verified — RT=0 fallback active.`);
} else {
  console.log(` ${FAIL}  ${failures} flaw(s) — apply buildHero() patch.`);
}
console.log('══════════════════════════════════════════════════\n');
process.exit(failures > 0 ? 1 : 0);
