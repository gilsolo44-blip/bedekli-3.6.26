'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getArchetypeRules } = require('../lib/archetypeRules');

// ── Test: HIERARCHICAL rules ─────────────────────────────────────────────────

test('returns HIERARCHICAL rules with expected keys', () => {
  const rules = getArchetypeRules('HIERARCHICAL');
  assert.ok(rules.description, 'should have description');
  assert.ok(rules.toc_skip_signals, 'should have toc_skip_signals');
  assert.ok(rules.structure_hint, 'should have structure_hint');
  assert.ok(rules.delimiter_pattern, 'should have delimiter_pattern');
  assert.ok(rules.extraction_hints, 'should have extraction_hints');
  assert.ok(Array.isArray(rules.extraction_hints), 'extraction_hints should be array');
  assert.ok(rules.extraction_hints.length > 0, 'extraction_hints should have items');
});

// ── Test: fallback to UNKNOWN ────────────────────────────────────────────────

test('falls back to UNKNOWN for unrecognised archetype', () => {
  const rules = getArchetypeRules('NONEXISTENT');
  assert.ok(rules.description, 'should have description');
  assert.match(rules.description, /לא מזוהה/, 'description should mention unknown');
});

// ── Test: few_shot slot ──────────────────────────────────────────────────────

test('returns object with few_shot slot', () => {
  const rules = getArchetypeRules('KW_PARAGRAPH');
  assert.ok(rules.few_shot, 'should have few_shot');
  assert.ok(rules.few_shot.input !== undefined, 'few_shot should have input');
  assert.ok(rules.few_shot.output !== undefined, 'few_shot should have output');
});
