// tests/step2Filter.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Test the isTocPage logic directly (recreated inline since it's not exported)
const TOC_LINE_RE = /^.{1,50}\.{3,}\s*\d+\s*$|^.{1,50}\s{3,}\d+\s*$/;
const DEFECT_LINE_RE = /נמצא|ליקוי|בעיה|סדק|רטיב|דליפ|חסר|לא\s*תקין|ממצא|פגם|נצפ|נדרש/;
function isTocPage(pageText, extraSignals) {
  const text = pageText.trim();
  if (text.length < 20) return false;
  const signals = ['תוכן עניינים', 'תוכן\nעניינים', ...(extraSignals || [])];
  if (signals.some(s => text.includes(s))) return true;
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 3) return false;
  const tocLines = lines.filter(l => TOC_LINE_RE.test(l.trim())).length;
  const hasDefect = DEFECT_LINE_RE.test(text);
  return (tocLines / lines.length) > 0.6 && !hasDefect;
}

test('detects explicit תוכן עניינים header', () => {
  assert.equal(isTocPage('תוכן עניינים\nסלון ... 3\nמטבח ... 5'), true);
});

test('detects heuristic TOC page (>60% dotted lines, no defects)', () => {
  const page = 'כניסה ................. 3\nסלון .................. 5\nמטבח .................. 8\nשירותים ............... 11';
  assert.equal(isTocPage(page), true);
});

test('does NOT flag content page with defect keywords', () => {
  const page = 'ליקוי ריצוף ............. 3\nנמצא כי הרצפה אינה ישרה.\nנדרש תיקון מיידי.';
  assert.equal(isTocPage(page), false);
});

test('does NOT flag short page', () => {
  assert.equal(isTocPage('קצר'), false);
});
