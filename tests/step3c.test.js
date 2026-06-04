'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { step3c_sectionBudget, SEV_WEIGHT, buildCatchAllChunks } = require('../server');

// helpers
const mkDefect = (overrides) => ({
  s: 'medium', c: 0, ds: 'תיאור', area: 'כללי', _cs: undefined, ...overrides
});

// ── Pass C: no costTableText ──────────────────────────────────────────────────

test('Pass C runs when costTableText is empty — all uncostled defects get _cs=report', () => {
  const defects = [
    mkDefect({ s: 'high' }),
    mkDefect({ s: 'medium' }),
    mkDefect({ s: 'low' }),
  ];
  const result = step3c_sectionBudget(defects, '', 60000);
  assert.equal(result.length, 3);
  result.forEach(d => {
    assert.equal(d._cs, 'report', `defect with s=${d.s} should have _cs=report`);
    assert.ok(d.c >= 200, `defect cost should be >= 200, got ${d.c}`);
  });
  // costs should sum to roughly reportTotal
  const total = result.reduce((s, d) => s + d.c, 0);
  assert.ok(total <= 60000 * 1.01, `sum ${total} should not exceed reportTotal`);
});

test('Pass C respects SEV_WEIGHT proportions', () => {
  const defects = [
    mkDefect({ s: 'critical' }),
    mkDefect({ s: 'low' }),
  ];
  const result = step3c_sectionBudget(defects, '', 90000);
  const critCost = result.find(d => d.s === 'critical').c;
  const lowCost  = result.find(d => d.s === 'low').c;
  // critical:low weight = 8:1 — critical should cost significantly more
  assert.ok(critCost > lowCost * 4, `critical (${critCost}) should be >> low (${lowCost})`);
});

test('Pass C does not touch defects already costed by Pass A', () => {
  const defects = [
    mkDefect({ s: 'high', c: 5000, _cs: 'report' }),  // already from Pass A
    mkDefect({ s: 'medium' }),
  ];
  const result = step3c_sectionBudget(defects, '', 50000);
  assert.equal(result[0]._cs, 'report');
  assert.equal(result[0].c, 5000, 'Pass A defect cost should be unchanged');
  assert.equal(result[1]._cs, 'report', 'uncostled defect should get Pass C');
  // remaining budget = 50000 - 5000 = 45000
  assert.ok(result[1].c <= 45000, `Pass C cost should not exceed remaining budget`);
});

test('Pass C skips when reportTotal is 0', () => {
  const defects = [mkDefect({ s: 'medium' })];
  const result = step3c_sectionBudget(defects, '', 0);
  assert.equal(result[0]._cs, undefined, 'should not assign _cs when reportTotal=0');
});

// ── Pass B + Pass C integration ───────────────────────────────────────────────

test('Pass B runs when costTableText has sections, Pass C covers remainder', () => {
  const costTableText = 'ריצוף: 30,000\nחשמל: 20,000';
  const defects = [
    mkDefect({ s: 'high', area: 'ריצוף' }),
    mkDefect({ s: 'medium', area: 'ריצוף' }),
    mkDefect({ s: 'medium', area: 'מסדרון' }),  // no matching section → Pass C
  ];
  const result = step3c_sectionBudget(defects, costTableText, 80000);

  const [d0, d1, d2] = result;
  assert.equal(d0._cs, 'section', 'ריצוף defect should get _cs=section from Pass B');
  assert.equal(d1._cs, 'section', 'ריצוף defect should get _cs=section from Pass B');
  assert.equal(d2._cs, 'report',  'מסדרון defect not in table should get _cs=report from Pass C');
});

// ── buildCatchAllChunks: section header detection ─────────────────────────────

test('buildCatchAllChunks: numbered header "1. עבודות ריצוף" → uses it as label', () => {
  const map = { 5: '1. עבודות ריצוף\nנמצא סדק בין אריחים' };
  const result = buildCatchAllChunks(map, new Set());
  const labels = Object.keys(result);
  assert.ok(labels.some(l => l.includes('עבודות ריצוף')), `expected work-type label, got: ${labels}`);
});

test('buildCatchAllChunks: unnumbered header "עבודות חשמל" → uses it as label', () => {
  const map = { 6: 'עבודות חשמל\nשקע לא תקין בסלון' };
  const result = buildCatchAllChunks(map, new Set());
  const labels = Object.keys(result);
  assert.ok(labels.some(l => l.includes('עבודות חשמל')), `expected work-type label, got: ${labels}`);
});

test('buildCatchAllChunks: Hebrew-letter prefix "א. עבודות נגרות" → uses it as label', () => {
  const map = { 7: 'א. עבודות נגרות\nדלת כניסה לא נסגרת כראוי' };
  const result = buildCatchAllChunks(map, new Set());
  const labels = Object.keys(result);
  assert.ok(labels.some(l => l.includes('עבודות נגרות')), `expected work-type label, got: ${labels}`);
});

test('buildCatchAllChunks: no recognizable header → falls back to ממצאים כלליים', () => {
  const map = { 8: 'פגם כללי בקיר המזרחי\nצריך בדיקה נוספת' };
  const result = buildCatchAllChunks(map, new Set());
  const labels = Object.keys(result);
  assert.ok(labels.some(l => l.includes('ממצאים כלליים')), `expected fallback label, got: ${labels}`);
});
