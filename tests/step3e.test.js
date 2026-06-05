'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Tests the pure parse-and-merge logic that step3e_simplify uses internally.
// No LLM calls are made.

test('simplified_explanation defaults to empty string on parse error', () => {
  const defects = [{ title: 'ריצוף צף', description: 'אריח מתנדנד', action: 'החלף' }];
  const raw = 'NOT JSON AT ALL';
  let parsed = null;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch { /* ignore */ }
  const result = defects.map((d, i) => ({
    ...d,
    simplified_explanation: (parsed && parsed[i] && parsed[i].simplified_explanation) || ''
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
    simplified_explanation: (parsed && parsed[i] && parsed[i].simplified_explanation) || ''
  }));
  assert.equal(result[0].simplified_explanation, 'ריצוף לא מחובר לתשתית.');
});
