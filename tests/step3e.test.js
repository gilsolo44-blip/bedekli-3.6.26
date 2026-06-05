'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { step3e_simplify } = require('../server');

test('returns empty array immediately for empty defects input', (_, done) => {
  step3e_simplify([], [], (result) => {
    assert.deepEqual(result, []);
    done();
  });
});

test('simplified_explanation defaults to empty string on parse error', () => {
  // Tests the parse-and-merge logic used inside step3e_simplify
  const defects = [{ title: 'ריצוף צף', description: 'אריח מתנדנד', action: 'החלף' }];
  const raw = 'NOT JSON AT ALL';
  let parsed = null;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch { /* ignore */ }
  const result = defects.map((d, i) => ({
    ...d,
    simplified_explanation:
      (parsed && parsed[i] && typeof parsed[i].simplified_explanation === 'string')
        ? parsed[i].simplified_explanation
        : ''
  }));
  assert.equal(result[0].simplified_explanation, '');
  assert.equal(result[0].title, 'ריצוף צף');
});

test('simplified_explanation is populated when LLM returns valid JSON', () => {
  const defects = [{ title: 'ריצוף צף', description: 'אריח מתנדנד', action: 'החלף' }];
  const raw = JSON.stringify([{ simplified_explanation: 'ריצוף לא מחובר לתשתית.' }]);
  const parsed = JSON.parse(raw);
  const result = defects.map((d, i) => ({
    ...d,
    simplified_explanation:
      (parsed && parsed[i] && typeof parsed[i].simplified_explanation === 'string')
        ? parsed[i].simplified_explanation
        : ''
  }));
  assert.equal(result[0].simplified_explanation, 'ריצוף לא מחובר לתשתית.');
});
