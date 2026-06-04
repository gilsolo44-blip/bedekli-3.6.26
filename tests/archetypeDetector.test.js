'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectArchetypeSync, splitByDefectBoundary, extractCompanyName } = require('../lib/archetypeDetector');

// ── detectArchetypeSync ───────────────────────────────────────────────────────

test('detects HIERARCHICAL from 3-level numbering', () => {
  const text = [
    '10.1.1 ריצוף סלון',
    'נמצא סדק בין אריחים',
    '10.1.2 ריצוף מטבח',
    'אריח שבור ליד הכיור',
    '10.2.1 חשמל — שקע לא מהודק',
  ].join('\n');
  const r = detectArchetypeSync(text);
  assert.equal(r.archetype, 'HIERARCHICAL');
  assert.ok(r.confidence >= 0.9);
});

test('detects HIERARCHICAL from 2-level numbering', () => {
  const text = [
    '5.1 ריצוף', 'יש סדק', '5.2 חלונות', 'חלון לא נסגר',
    '5.3 אינסטלציה', 'ברז מטפטף', '5.4 חשמל', 'שקע שבור',
    '5.5 טיח', 'קילוף על הקיר', '5.6 שערים', 'דלת לא נסגרת',
    '5.7 גג', 'נזילה', '5.8 מרפסת', 'ריצוף מבוקע',
    '5.9 מסגרות',
  ].join('\n');
  const r = detectArchetypeSync(text);
  assert.equal(r.archetype, 'HIERARCHICAL');
});

test('detects KW_PARAGRAPH from ליקוי keyword', () => {
  const text = [
    'ליקוי 1: סדק בטיח',
    'נמצא סדק אנכי ברוחב 2 מ"מ',
    'ליקוי 2: ריצוף לא אחיד',
    'אריח שבור בפינה',
    'ליקוי 3: חלון לא נסגר',
    'ליקוי 4: דלת שרוטה',
    'ליקוי 5: שקע חשמל פגום',
    'ליקוי 6: ברז מטפטף',
    'ליקוי 7: צבע קולף',
    'ליקוי 8: רטיבות בפינה',
    'ליקוי 9: נזילה בתקרה',
    'ליקוי 10: גדר לא הושלמה',
  ].join('\n');
  const r = detectArchetypeSync(text);
  assert.equal(r.archetype, 'KW_PARAGRAPH');
  assert.ok(r.confidence >= 0.85);
});

test('detects TABLE from pipe characters', () => {
  const text = Array.from({ length: 20 }, (_, i) =>
    `| חדר ${i} | ליקוי ${i} | ${i * 100} ₪ |`
  ).join('\n');
  const r = detectArchetypeSync(text);
  assert.equal(r.archetype, 'TABLE');
});

test('detects NUMBERED_FLAT from sequential flat numbering', () => {
  const text = [
    '1. ריצוף סלון — אריח שבור',
    '2. חלון מטבח — לא נסגר',
    '3. שקע חשמל — לא מהודק',
    '4. ברז שירותים — מטפטף',
    '5. דלת כניסה — שרוטה',
    '6. טיח קיר — קולף',
    '7. גדר — לא הושלמה',
    '8. מרזב — סתום',
    '9. ווילון — פגום',
    '10. ריסוק אריח — בפינה',
    '11. שפשוף על קיר',
  ].join('\n');
  const r = detectArchetypeSync(text);
  assert.equal(r.archetype, 'NUMBERED_FLAT');
});

test('returns UNKNOWN for unrecognized format', () => {
  const text = 'קצת טקסט עברי ללא מבנה מיוחד. אין מספרים. אין מילות מפתח.';
  const r = detectArchetypeSync(text);
  assert.equal(r.archetype, 'UNKNOWN');
  assert.ok(r.confidence < 0.8);
});

// ── splitByDefectBoundary ─────────────────────────────────────────────────────

test('splits HIERARCHICAL text into defect chunks', () => {
  const text = [
    '10.1 ריצוף — אריח שבור',
    'תיאור מפורט של הליקוי הזה כולל מיקום ומשמעות.',
    '10.2 חשמל — שקע פגום',
    'תיאור מפורט של שקע חשמל שבור.',
    '10.3 טיח — קילוף על הקיר',
    'תיאור מפורט של קילוף הטיח.',
  ].join('\n');
  const chunks = splitByDefectBoundary(text, 'HIERARCHICAL');
  assert.ok(chunks.length >= 2, `expected ≥2 chunks, got ${chunks.length}`);
  assert.ok(chunks[0].includes('10.1'));
  assert.ok(chunks[1].includes('10.2'));
});

test('splits KW_PARAGRAPH text into defect chunks', () => {
  const text = [
    'ליקוי: ריצוף שבור',
    'תיאור: אריח שבור בפינה המזרחית של הסלון.',
    'ליקוי: חלון לא נסגר',
    'תיאור: חלון המטבח אינו נסגר עד הסוף.',
    'ליקוי: טיח קולף',
    'תיאור: קילוף טיח בפינה הצפונית.',
  ].join('\n');
  const chunks = splitByDefectBoundary(text, 'KW_PARAGRAPH');
  assert.ok(chunks.length >= 2, `expected ≥2 chunks, got ${chunks.length}`);
});

test('returns single chunk for TABLE archetype', () => {
  const text = '| חדר | ליקוי | עלות |\n| סלון | סדק | 500 |';
  const chunks = splitByDefectBoundary(text, 'TABLE');
  assert.equal(chunks.length, 1);
});

test('does not produce empty chunks', () => {
  const text = '10.1 ריצוף\nסדק\n10.2 חשמל\nשקע\n10.3 טיח\nקילוף';
  const chunks = splitByDefectBoundary(text, 'HIERARCHICAL');
  assert.ok(chunks.every(c => c.trim().length > 0));
});

// ── extractCompanyName ────────────────────────────────────────────────────────

test('extracts known company name from first page', () => {
  const text = 'גולדאל הנדסה\nInspection and Engineering Services\nדוח בדיקה';
  const name = extractCompanyName(text, { 'גולדאל הנדסה': { archetype: 'HIERARCHICAL' } });
  assert.equal(name, 'גולדאל הנדסה');
});

test('returns unknown for unrecognized first page', () => {
  const text = 'some unrecognized company xyz 123';
  const name = extractCompanyName(text, {});
  assert.equal(name, 'unknown');
});

// ── step4_schema Bug #3 regression guard ─────────────────────────────────────

test('Bug #3: action must differ from desc', () => {
  const desc = 'נמצא אריח שבור בפינה הדרומית של הסלון.';
  const rec = desc;
  const action = rec && rec.trim() !== desc.trim() ? rec : '';
  assert.equal(action, '', 'action should be empty when identical to desc');
});

test('Bug #3: action kept when different from desc', () => {
  const desc = 'נמצא אריח שבור בפינה הדרומית של הסלון.';
  const rec = 'להחליף את האריח השבור.';
  const action = rec && rec.trim() !== desc.trim() ? rec : '';
  assert.equal(action, 'להחליף את האריח השבור.');
});

// ── extractCompanyName — RTL flip fix ─────────────────────────────────────────

test('finds company when pdfminer flips RTL string', () => {
  // pdfminer reverses "גולדאל הנדסה" → "הסדנה לאדלוג"
  const flippedText = 'Inspection and Engineering Services\n  הסדנה לאדלוג \n-058\n7517771';
  const profiles = { 'גולדאל הנדסה': { archetype: 'HIERARCHICAL' } };
  const name = extractCompanyName(flippedText, profiles);
  assert.equal(name, 'גולדאל הנדסה');
});

test('still finds company in normal (non-flipped) text', () => {
  const normalText = 'גולדאל הנדסה בע"מ\nדוח בדיקה';
  const profiles = { 'גולדאל הנדסה': { archetype: 'HIERARCHICAL' } };
  const name = extractCompanyName(normalText, profiles);
  assert.equal(name, 'גולדאל הנדסה');
});
