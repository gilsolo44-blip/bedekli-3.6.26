'use strict';
const fs   = require('fs');
const path = require('path');

const MEMORY_PATH       = path.join(__dirname, '../data/company_memory.json');
const MAX_PER_COMPANY   = 50;
const MAX_PER_ARCHETYPE = 200;
const SAVE_FIELDS       = ['title', 'desc', 'action', 'category', 'severity', 'workType', 'area'];

function _load() {
  try { return JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf8')); }
  catch { return {}; }
}

function _save(data) {
  try { fs.writeFileSync(MEMORY_PATH, JSON.stringify(data, null, 2)); } catch {}
}

function _toRecord(d) {
  const out = {};
  SAVE_FIELDS.forEach(f => { if (d[f]) out[f] = d[f]; });
  return out;
}

// Pick up to n diverse defects, spread across categories. Skips titles in `exclude` Set.
function _pickDiverse(defects, n, exclude) {
  const byCategory = {};
  defects.forEach(d => {
    if (exclude && exclude.has(d.title)) return;
    const cat = d.category || 'CAT-16';
    (byCategory[cat] = byCategory[cat] || []).push(d);
  });
  const cats = Object.keys(byCategory);
  const result = [];
  for (let i = 0; result.length < n && i < cats.length * n; i++) {
    const pool = byCategory[cats[i % cats.length]];
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (!result.find(r => r.title === pick.title)) result.push(pick);
  }
  return result.slice(0, n);
}

// Save defects for a specific company (called after each successful pipeline run).
function saveDefects(companyName, defects, archetype) {
  if (!companyName || companyName === 'unknown' || !defects || defects.length === 0) return;
  const mem = _load();
  if (!mem[companyName]) mem[companyName] = { archetype, defects: [] };
  const existing = new Set(mem[companyName].defects.map(d => d.title));
  const novel = defects
    .filter(d => d.title && d.title.length > 5 && !existing.has(d.title))
    .map(_toRecord);
  mem[companyName].defects = [...mem[companyName].defects, ...novel].slice(-MAX_PER_COMPANY);
  mem[companyName].archetype = archetype || mem[companyName].archetype;
  _save(mem);
}

// Save defects at the archetype level (broader pool, used as fallback).
function saveDefectsByArchetype(archetype, defects) {
  if (!archetype || archetype === 'UNKNOWN' || !defects || defects.length === 0) return;
  const mem = _load();
  if (!mem._archetypes) mem._archetypes = {};
  if (!mem._archetypes[archetype]) mem._archetypes[archetype] = { defects: [] };
  const existing = new Set(mem._archetypes[archetype].defects.map(d => d.title));
  const novel = defects
    .filter(d => d.title && d.title.length > 5 && !existing.has(d.title))
    .map(_toRecord);
  mem._archetypes[archetype].defects =
    [...mem._archetypes[archetype].defects, ...novel].slice(-MAX_PER_ARCHETYPE);
  _save(mem);
}

// Return n diverse examples: company-specific first, then archetype fallback.
function getExamples(companyName, n, archetype) {
  n = n || 3;
  const mem = _load();
  const result = [];

  if (companyName && companyName !== 'unknown' && mem[companyName]) {
    result.push(..._pickDiverse(mem[companyName].defects, n, null));
  }

  if (result.length < n && archetype && archetype !== 'UNKNOWN' &&
      mem._archetypes && mem._archetypes[archetype]) {
    const exclude = new Set(result.map(d => d.title));
    result.push(..._pickDiverse(mem._archetypes[archetype].defects, n - result.length, exclude));
  }

  return result.slice(0, n);
}

// Build the few-shot hint block injected into the step3 prompt.
function buildFewShotBlock(companyName, archetype, n) {
  const examples = getExamples(companyName, n || 3, archetype);
  if (examples.length === 0) return '';
  const lines = examples.map(e =>
    `- "${e.title}"${e.category ? ` [${e.category}]` : ''}${e.severity ? ` [${e.severity}]` : ''}${e.workType ? ` [${e.workType}]` : ''}`
  );
  return `\n[דוגמאות ליקויים אופייניים של החברה הזו]\n${lines.join('\n')}`;
}

module.exports = { saveDefects, saveDefectsByArchetype, getExamples, buildFewShotBlock };
