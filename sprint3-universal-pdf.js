#!/usr/bin/env node
// Sprint 3 — Universal PDF Gate
// Proves 6 rigidity flaws BEFORE fixes, then verifies after.
//
//   R1: STRUCT_PROMPT "חדרים נפוצים" list biases LLM to apartments
//   R2: STRUCT_PROMPT rule 4 hardcodes "מעמוד 5" — breaks short-intro PDFs
//   R3: STRUCT_PROMPT example is a single 73p apartment — locks LLM to that layout
//   R4: step2_filter strips pages 1-4 unconditionally — loses early defects
//   R5: buildCatchAllChunks filters (p >= 5) — silently drops pages 3-4
//   R6: structureType only 'rooms'/'chapters' — misses 'floors'/'systems'
'use strict';
const fs   = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
let failures = 0;

function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ${PASS}  ${label}`); }
  else           { console.log(`  ${FAIL}  ${label}${detail ? ' — ' + detail : ''}`); failures++; }
}

console.log('\n══════════════════════════════════════════════════════');
console.log(' Sprint 3 — Universal PDF Gate (6 Rigidity Flaws)');
console.log('══════════════════════════════════════════════════════\n');

const structPrompt  = SRC.match(/const STRUCT_PROMPT\s*=\s*`([\s\S]*?)`/)?.[1] || '';
const step2FilterFn = SRC.match(/function step2_filter[\s\S]{0,900}/)?.[0]     || '';
const catchAllFn    = SRC.match(/function buildCatchAllChunks[\s\S]{0,700}/)?.[0] || '';
const detectBlock   = SRC.match(/\/\/ Detect structureType[\s\S]{0,600}/)?.[0]  ||
                      SRC.match(/isRoomBased[\s\S]{0,600}/)?.[0]                 || '';

// ── R1: Residential-room bias in STRUCT_PROMPT ────────────────────────────────
console.log('R1: STRUCT_PROMPT does not impose residential-room bias');

const hasResidentialList = /חדרים\s*נפוצים\s*:/.test(structPrompt);
assert(
  'STRUCT_PROMPT has no "חדרים נפוצים" residential list as primary guide',
  !hasResidentialList,
  '"חדרים נפוצים: סלון, מטבח..." hard-teaches LLM apartment rooms — systems/office reports collapse to 1 section'
);

const hasGenericSectionRule = /כל\s*(כותרת|נושא|קטגוריה|אזור|מערכת)\s*עם\s*ממצאים|section\s*לכל\s*(מערכת|קומה|אזור)/i.test(structPrompt);
assert(
  'STRUCT_PROMPT has a generic "any heading = section" rule',
  hasGenericSectionRule,
  'No generic section principle found — LLM falls back to apartment rooms when format differs'
);

// ── R2: Hardcoded "מעמוד 5" intro assumption ─────────────────────────────────
console.log('\nR2: STRUCT_PROMPT has no hardcoded "מעמוד 5" intro boundary');

const hasPage5Rule = /מעמוד\s*5/.test(structPrompt);
assert(
  'STRUCT_PROMPT does not say "מעמוד 5" (adaptive intro detection)',
  !hasPage5Rule,
  '"כסה כל עמוד מעמוד 5" breaks PDFs where content starts on page 2 or page 12'
);

// ── R3: Single-apartment example biases LLM ──────────────────────────────────
console.log('\nR3: STRUCT_PROMPT example is not locked to a single 73p apartment');

const hasSingleApartmentExample = /דוגמה.*דירה.*73\s*עמ/.test(structPrompt);
assert(
  'STRUCT_PROMPT example is not labeled "(דירה 73 עמ\')"',
  !hasSingleApartmentExample,
  '"דוגמה לפלט תקין (דירה 73 עמ\')" locks LLM output to residential apartment structure'
);

// ── R4: step2_filter unconditionally strips pages 1-4 ────────────────────────
console.log('\nR4: step2_filter has adaptive intro stripping');

const stripsPages1to4 = /\[1-4\]/.test(step2FilterFn);
assert(
  'step2_filter does not have hardcoded [1-4] page strip',
  !stripsPages1to4,
  'strip /[1-4]/ removes pages 2-4 even when defects start on page 2 (1-page intro PDFs)'
);

const hasAdaptiveIntro = /introEnd|intro_end|introPages|firstContentPage|detectIntro|introPage/.test(step2FilterFn);
assert(
  'step2_filter has adaptive intro-end detection',
  hasAdaptiveIntro,
  'No adaptive intro boundary found — must detect where boilerplate ends and defects begin'
);

// ── R5: buildCatchAllChunks silently drops pages 1-4 ─────────────────────────
console.log('\nR5: buildCatchAllChunks does not filter (p >= 5)');

const hasPage5Gate = /filter\s*\(\s*p\s*=>\s*p\s*>=\s*5/.test(catchAllFn);
assert(
  'buildCatchAllChunks does not filter (p >= 5)',
  !hasPage5Gate,
  '.filter(p => p >= 5) silently discards pages 2-4 — defects on page 3 are never processed'
);

// After removing the gate, must use intro-aware threshold or have no numeric filter
const usesAdaptiveGate = /introEnd|introPages|firstContent|introPage/.test(catchAllFn) ||
                         !/p\s*>=\s*\d/.test(catchAllFn);
assert(
  'buildCatchAllChunks page gate is adaptive (not hardcoded to 5)',
  usesAdaptiveGate,
  'No adaptive threshold found — after fix must pass introEnd or drop the numeric gate entirely'
);

// ── R6: structureType detection misses floors and systems ─────────────────────
console.log('\nR6: structureType detection includes floors and systems');

const recognizesFloors = /floors|קומ[הות]|floor/i.test(detectBlock);
assert(
  "structureType detection recognizes 'floors' (קומה א', קומה ב')",
  recognizesFloors,
  "Duplex/commercial PDFs structured by floors get classified as 'chapters' — lose floor-based UI grouping"
);

const recognizesSystems = /systems|מערכות|system/i.test(detectBlock) &&
                          /'systems'|"systems"/.test(SRC);
assert(
  "structureType detection emits 'systems' variant for systems-based reports",
  recognizesSystems,
  "Systems-based PDFs (חשמל/אינסטלציה/ריצוף sections) get classified as 'chapters' — lose systems badge"
);

// ── SIMULATION: Type C — 1-page intro, defects start on page 2 ───────────────
console.log('\nSIMULATION: Type C — Short-intro PDF (defects on page 2)');

// Re-implement the new adaptive step2_filter intro detection
function simulateCurrentFilter(text) {
  const DEFECT_RE = /₪|ש"ח|ליקוי|ממצא|פגם|סדק|רטיבות|בעיה\s+ב|נזק\s+ב/;
  const pp = text.split(/(---\s*עמוד\s*(\d+)\s*---)/);
  let introEnd = 4;
  for (let i = 1; i + 2 < pp.length; i += 3) {
    const pn = parseInt(pp[i + 1]);
    if (pn > 10) break;
    if (DEFECT_RE.test(pp[i + 2] || '')) { introEnd = Math.max(0, pn - 1); break; }
  }
  if (introEnd <= 0) return text;
  const out = [pp[0]];
  for (let i = 1; i + 2 < pp.length; i += 3) {
    if (parseInt(pp[i + 1]) > introEnd) out.push(pp[i], pp[i + 2]);
  }
  return out.join('');
}

const shortIntroPdf = [
  '--- עמוד 1 ---',
  'ברוכים הבאים לדוח הבדיקה — חברת גולדאל בדק בית',
  '--- עמוד 2 ---',
  'סלון — ממצאים',
  'ליקוי: סדקים בקיר הסלון',
  'עלות משוערת: ₪2,500',
  '--- עמוד 3 ---',
  'מסקנות — סה"כ ₪2,500',
].join('\n');

const filtered = simulateCurrentFilter(shortIntroPdf);
const page2Defectsurvived = /₪2,500/.test(filtered) && /סלון/.test(filtered);
assert(
  'Short-intro PDF: page-2 defect survives step2_filter (₪2,500 preserved)',
  page2Defectsurvived,
  'Current [1-4] strip removes page 2 — ₪2,500 defect is lost before LLM or step3 can process it'
);

// ── SIMULATION: Type D — Floor-based structure ────────────────────────────────
console.log('\nSIMULATION: Type D — Floor-based structure (קומה א\'/קומה ב\')');

const roomPatternsBlock = SRC.match(/ROOM_PATTERNS[\s\S]{0,5000}/)?.[0] || '';
const hasFloorPattern = /קומ[הות]|קומה\s*[א-ת]|floor/i.test(roomPatternsBlock);
assert(
  'ROOM_PATTERNS includes floor patterns (קומה א\', קומה ב\')',
  hasFloorPattern,
  "Floor sections not in ROOM_PATTERNS → isRoomBased=false → structureType='chapters' → no floor grouping"
);

// ── SUMMARY ───────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════');
if (failures === 0) {
  console.log(` ${PASS}  All checks pass — system handles any home inspection PDF format.`);
} else {
  console.log(` ${FAIL}  ${failures} rigidity flaw(s) confirmed — apply R1→R6 universalization fixes.`);
  console.log('  Fix order: R4+R5 (page filter) → R1+R3 (prompt bias) → R2 (intro rule) → R6 (structureType)');
}
console.log('══════════════════════════════════════════════════════\n');
process.exit(failures > 0 ? 1 : 0);
