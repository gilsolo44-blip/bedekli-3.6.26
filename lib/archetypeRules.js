'use strict';

const path = require('path');
let _rules = null;

const FALLBACK = {
  description: 'מבנה לא מזוהה — גישה כללית',
  toc_skip_signals: ['תוכן עניינים'],
  structure_hint: '',
  delimiter_pattern: '',
  cost_location: '',
  extraction_hints: [],
  few_shot: { input: '', output: [] }
};

/**
 * Load and cache archetype rules from data/archetype_rules.json
 * Falls back to UNKNOWN if archetype not found, or FALLBACK if rules file missing.
 *
 * @param {string} archetype - Archetype key (e.g., 'HIERARCHICAL', 'KW_PARAGRAPH')
 * @returns {object} Rules object with description, toc_skip_signals, structure_hint, etc.
 */
function getArchetypeRules(archetype) {
  // Load and cache rules on first call
  if (!_rules) {
    try {
      _rules = require(path.join(__dirname, '../data/archetype_rules.json'));
    } catch (e) {
      _rules = {};
    }
  }

  // Return requested archetype, or fallback to UNKNOWN, or final FALLBACK
  return _rules[archetype] || _rules['UNKNOWN'] || FALLBACK;
}

module.exports = { getArchetypeRules };
