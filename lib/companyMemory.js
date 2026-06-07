'use strict';
const fs   = require('fs');
const path = require('path');

const MEMORY_PATH     = path.join(__dirname, '../data/company_memory.json');
const MAX_PER_COMPANY = 50;
const SAVE_FIELDS     = ['title', 'desc', 'action', 'category', 'severity', 'workType', 'area'];

function _load() {
  try { return JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf8')); }
  catch { return {}; }
}

function _save(data) {
  try { fs.writeFileSync(MEMORY_PATH, JSON.stringify(data, null, 2)); } catch {}
}

// Persist up to MAX_PER_COMPANY defects per company after a successful pipeline run.
function saveDefects(companyName, defects, archetype) {
  if (!companyName || companyName === 'unknown' || !defects || defects.length === 0) return;
  const mem = _load();
  if (!mem[companyName]) mem[companyName] = { archetype, defects: [] };
  const existing = new Set(mem[companyName].defects.map(d => d.title));
  const novel = defects
    .filter(d => d.title && d.title.length > 5 && !existing.has(d.title))
    .map(d => {
      const out = {};
      SAVE_FIELDS.forEach(f => { if (d[f]) out[f] = d[f]; });
      return out;
    });
  mem[companyName].defects = [...mem[companyName].defects, ...novel].slice(-MAX_PER_COMPANY);
  mem[companyName].archetype = archetype || mem[companyName].archetype;
  _save(mem);
}

// Return n diverse examples for this company (spread across categories).
function getExamples(companyName, n) {
  n = n || 3;
  if (!companyName || companyName === 'unknown') return [];
  const mem = _load();
  const entry = mem[companyName];
  if (!entry || !entry.defects || entry.defects.length === 0) return [];
  const byCategory = {};
  entry.defects.forEach(d => {
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

// Build the few-shot hint block to inject into the step3 prompt.
function buildFewShotBlock(companyName, n) {
  const examples = getExamples(companyName, n || 3);
  if (examples.length === 0) return '';
  const lines = examples.map(e =>
    `- "${e.title}"${e.category ? ` [${e.category}]` : ''}${e.severity ? ` [${e.severity}]` : ''}${e.workType ? ` [${e.workType}]` : ''}`
  );
  return `\n[דוגמאות ליקויים אופייניים של החברה הזו]\n${lines.join('\n')}`;
}

module.exports = { saveDefects, getExamples, buildFewShotBlock };
