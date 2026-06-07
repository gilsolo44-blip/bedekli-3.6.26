'use strict';
// One-time seeding script: reads 262 cached analysis results and populates
// the archetype-level bucket in company_memory.json.
// Run: node scripts/seed-company-memory.js
const fs   = require('fs');
const path = require('path');
const { saveDefectsByArchetype } = require('../lib/companyMemory');

const CACHE_DIR = path.join(__dirname, '../shared/analysis_cache');

const files = fs.readdirSync(CACHE_DIR)
  .filter(f => f.startsWith('result_') && f.endsWith('.json'));

let processed = 0, skipped = 0;
const stats = {}; // archetype → { files, defects }

for (const file of files) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf8'));
    const data = typeof raw.value === 'string' ? JSON.parse(raw.value) : raw.value;
    if (!data || !data.defects || data.defects.length === 0) { skipped++; continue; }

    const archetypeLine = (data.analysisLog || []).find(l => /\[Step 0c\].*archetype=/.test(l));
    const m = archetypeLine && archetypeLine.match(/archetype=([A-Z_]+)/);
    const archetype = m ? m[1] : null;

    if (!archetype || archetype === 'UNKNOWN') { skipped++; continue; }

    saveDefectsByArchetype(archetype, data.defects);

    if (!stats[archetype]) stats[archetype] = { files: 0, defects: 0 };
    stats[archetype].files++;
    stats[archetype].defects += data.defects.length;
    processed++;
  } catch {
    skipped++;
  }
}

console.log(`\n✅ Seeding complete: ${processed} files processed, ${skipped} skipped\n`);
console.log('Archetype breakdown:');
Object.entries(stats)
  .sort((a, b) => b[1].files - a[1].files)
  .forEach(([k, v]) => console.log(`  ${k.padEnd(20)} ${v.files} files, ${v.defects} defects`));
