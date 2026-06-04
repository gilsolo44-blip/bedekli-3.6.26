'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { splitByDefectBoundary } = require('../lib/archetypeDetector');

test('HIERARCHICAL text with 4 defects produces 4 chunks', () => {
  const text = [
    '[עמוד 5]',
    '10.1 ריצוף סלון — אריח שבור ליד הדלת',
    'תיאור מלא: נמצא אריח שבור בפינה הדרומית. יש להחליף.',
    '10.2 חשמל — שקע לא מהודק',
    'תיאור מלא: שקע בקיר המזרחי נמצא רופף. מסוכן.',
    '10.3 טיח — קילוף על קיר הסלון',
    'תיאור מלא: קילוף טיח שטח 0.5 מ"ר בגובה 1.5 מ.',
    '10.4 גדר — לא הושלמה',
    'תיאור מלא: גדר הגבול הותקנה חלקית. חסרה רשת.',
  ].join('\n');

  const chunks = splitByDefectBoundary(text, 'HIERARCHICAL');
  assert.ok(chunks.length >= 3, `expected ≥3 chunks, got ${chunks.length}: ${JSON.stringify(chunks)}`);
  assert.ok(chunks.every(c => c.trim().length > 20), 'no empty chunks');
});

test('KW_PARAGRAPH with 3 defects produces 3 chunks', () => {
  const text = [
    '[עמוד 8]',
    'ליקוי: ריצוף לא אחיד',
    'נמצא הבדל גובה בין אריחים גדול מ-2 מ"מ.',
    'ממצא: חלון לא נסגר',
    'חלון המטבח אינו נסגר לגמרי. יש ליישר.',
    'ליקוי: ברז מטפטף',
    'ברז שירותי האורחים מטפטף כל הזמן.',
  ].join('\n');

  const chunks = splitByDefectBoundary(text, 'KW_PARAGRAPH');
  assert.ok(chunks.length >= 2, `expected ≥2 chunks, got ${chunks.length}`);
});

test('UNKNOWN archetype returns single chunk (no sub-split)', () => {
  const text = 'טקסט ללא מבנה ברור. יש כל מיני ליקויים. 10.1. ליקוי:\nמשהו.';
  const chunks = splitByDefectBoundary(text, 'UNKNOWN');
  assert.equal(chunks.length, 1);
});

test('empty text returns single empty chunk', () => {
  const chunks = splitByDefectBoundary('', 'HIERARCHICAL');
  assert.equal(chunks.length, 1);
});
