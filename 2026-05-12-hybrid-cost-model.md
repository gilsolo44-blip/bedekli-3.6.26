# Hybrid Cascading Cost Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve per-defect cost accuracy with a 3-tier cascade: inline PDF extraction → section-budget distribution → LLM-calibrated inference.

**Architecture:** Rewrite `step3c_sectionBudget` to run Pass A (inline regex on defect quote/desc) before Pass B (section totals). Add `step3d_llmCostRefine` (one batched LLM call for high-variance defects with no cost). Wire step3d into the pipeline between step3c and step4. Fix `estimateBanner` to fire at ≥70% estimates instead of 100%.

**Tech Stack:** Bun/Node.js CJS, no new dependencies. `server.js` only for logic, `public/report.html` for banner. No git repo exists — skip commit steps.

---

## File Map

| File | Change |
|------|--------|
| `server.js:395-441` | Rewrite `step3c_sectionBudget` — add Pass A inline regex |
| `server.js:442` | Insert `isHighVariance` + `step3d_llmCostRefine` |
| `server.js:1196-1235` | Update pipeline wiring — step3c log + step3d callback wrapping step4+ |
| `public/report.html:831` | Fix estimateBanner condition from `every` to ≥70% |

---

## Task 1: Rewrite `step3c_sectionBudget` with inline extraction

**Files:**
- Modify: `server.js:395-441`

- [ ] **Step 1: Verify current function boundaries**

```bash
sed -n '391,442p' '/Users/gilsolo44/Downloads/בדקלי חדש/server.js'
```

Expected: Line 395 starts `function step3c_sectionBudget(`, line 441 is `}`, line 443 is blank.

- [ ] **Step 2: Replace the entire function**

Find in `server.js`:
```javascript
function step3c_sectionBudget(defects, costTableText, reportTotal) {
  if (!reportTotal || reportTotal <= 0 || !costTableText || !costTableText.trim()) return defects;

  // Parse section totals: "חדר שינה: 24,500 ₪" or "מטבח – 18000"
  const secRe = /([^\n\d:–\-]{2,25})\s*[:–\-]\s*(\d{1,3}(?:,\d{3})+|\d{4,7})\s*(?:ש['"״""]ח|₪)?/gi;
  const sections = {};
  for (const m of costTableText.matchAll(secRe)) {
    const name = m[1].trim().replace(/\s+/g, ' ');
    const amount = parseInt(m[2].replace(/,/g, ''));
    if (amount >= 1000 && amount <= reportTotal && name.length >= 2) {
      sections[name] = Math.max(sections[name] || 0, amount);
    }
  }
  if (Object.keys(sections).length === 0) return defects;

  // Group unmatched defects by area
  const byArea = {};
  defects.forEach((d, i) => {
    if (parseInt((d.c || '').toString().replace(/[^\d]/g, '')) >= 200) return; // already has real cost
    const area = (d.area || 'כללי').trim();
    if (!byArea[area]) byArea[area] = [];
    byArea[area].push(i);
  });

  const result = defects.map(d => ({ ...d }));
  let assigned = 0;

  for (const [area, indices] of Object.entries(byArea)) {
    // Find best matching section (substring either way)
    let budget = 0;
    for (const [sName, amount] of Object.entries(sections)) {
      if (area.includes(sName) || sName.includes(area)) { budget = amount; break; }
    }
    if (!budget) continue;

    const totalWeight = indices.reduce((s, i) => s + (SEV_WEIGHT[defects[i].s] || 1), 0);
    indices.forEach(i => {
      const w = SEV_WEIGHT[defects[i].s] || 1;
      const share = Math.max(200, Math.round((w / totalWeight) * budget));
      result[i].c = share;
      result[i]._cs = 'section';
      assigned++;
    });
  }

  return result;
}
```

Replace with:
```javascript
function step3c_sectionBudget(defects, costTableText, reportTotal) {
  const result = defects.map(d => ({ ...d }));

  // Pass A: inline cost extraction from defect quote / description
  const inlineRe = /(?:₪|ש['"״""]ח)\s*([\d,]+)|עלות[^:\n]{0,20}:\s*([\d,]+)/i;
  result.forEach(d => {
    if (parseInt((d.c || '').toString().replace(/[^\d]/g, '')) >= 200) return;
    const text = (d.q || '') + ' ' + (d.ds || '');
    const m = inlineRe.exec(text);
    if (!m) return;
    const amount = parseInt((m[1] || m[2] || '').replace(/,/g, ''));
    if (amount >= 200) { d.c = amount; d._cs = 'report'; }
  });

  // Pass B: section-budget distribution for remainder
  if (!reportTotal || reportTotal <= 0 || !costTableText || !costTableText.trim()) return result;

  const secRe = /([^\n\d:–\-]{2,25})\s*[:–\-]\s*(\d{1,3}(?:,\d{3})+|\d{4,7})\s*(?:ש['"״""]ח|₪)?/gi;
  const sections = {};
  for (const m of costTableText.matchAll(secRe)) {
    const name = m[1].trim().replace(/\s+/g, ' ');
    const amount = parseInt(m[2].replace(/,/g, ''));
    if (amount >= 1000 && amount <= reportTotal && name.length >= 2) {
      sections[name] = Math.max(sections[name] || 0, amount);
    }
  }
  if (Object.keys(sections).length === 0) return result;

  const byArea = {};
  result.forEach((d, i) => {
    if (parseInt((d.c || '').toString().replace(/[^\d]/g, '')) >= 200) return;
    const area = (d.area || 'כללי').trim();
    if (!byArea[area]) byArea[area] = [];
    byArea[area].push(i);
  });

  for (const [area, indices] of Object.entries(byArea)) {
    let budget = 0;
    for (const [sName, amount] of Object.entries(sections)) {
      if (area.includes(sName) || sName.includes(area)) { budget = amount; break; }
    }
    if (!budget) continue;
    const totalWeight = indices.reduce((s, i) => s + (SEV_WEIGHT[result[i].s] || 1), 0);
    indices.forEach(i => {
      const w = SEV_WEIGHT[result[i].s] || 1;
      result[i].c = Math.max(200, Math.round((w / totalWeight) * budget));
      result[i]._cs = 'section';
    });
  }

  return result;
}
```

- [ ] **Step 3: Verify syntax with node**

```bash
node -e "
const re = /(?:₪|ש['\"״“]ח)\s*([\d,]+)|עלות[^:\n]{0,20}:\s*([\d,]+)/i;
const t1 = 'עלות תיקון: 3,500 שח';
const t2 = '₪ 4200 לפי הדוח';
const t3 = 'אין עלות';
const m1 = re.exec(t1); console.assert(m1 && parseInt((m1[1]||m1[2]).replace(/,/g,''))===3500, 'pass A1');
const m2 = re.exec(t2); console.assert(m2 && parseInt((m2[1]||m2[2]).replace(/,/g,''))===4200, 'pass A2');
const m3 = re.exec(t3); console.assert(!m3, 'pass A no-match');
console.log('step3c Pass A assertions pass');
"
```

Expected output: `step3c Pass A assertions pass`

---

## Task 2: Add `isHighVariance` + `step3d_llmCostRefine`

**Files:**
- Modify: `server.js` — insert after the closing `}` of `step3c_sectionBudget` (line 441), before `// ── Step 4`

- [ ] **Step 1: Verify insertion point**

```bash
sed -n '440,445p' '/Users/gilsolo44/Downloads/בדקלי חדש/server.js'
```

Expected: line 441 is `}`, line 443 is `// ── Step 4: Schema Enforcement`

- [ ] **Step 2: Insert new functions**

Find in `server.js`:
```javascript
// ── Step 4: Schema Enforcement (JavaScript only) ─────────────────────────────
```

Replace with:
```javascript
// ── Step 3d: LLM Cost Refinement (high-variance defects without a cost) ──────

function isHighVariance(costKey) {
  const e = COST_TABLE[costKey] || COST_TABLE['כללי'];
  return (e.max - e.min) > 4000;
}

function step3d_llmCostRefine(defects, log, callback) {
  const candidates = defects
    .map((d, i) => ({ i, d }))
    .filter(({ d }) => {
      if (d._cs) return false;
      if (parseInt((d.c || '').toString().replace(/[^\d]/g, '')) >= 200) return false;
      const catObj = guessCategory(d.t || '', d.ds || '');
      return isHighVariance(catObj.costKey);
    });

  if (candidates.length === 0) {
    log.push('[Step 3d] → 0 ליקויים מתאימים לעידון LLM');
    return callback(defects);
  }

  const batch = candidates.map(({ i, d }) => ({
    id: i,
    t: (d.t || '').slice(0, 60),
    s: d.s || 'medium',
    cat: guessCategory(d.t || '', d.ds || '').label
  }));

  const system = `אתה מומחה לעלויות תיקונים בנדל"ן ישראלי. החזר JSON בלבד ללא הסברים.`;
  const user = `להלן רשימת ליקויים בדירה. לכל ליקוי, העריך עלות תיקון ריאלית בשקלים (מספר שלם, לפחות 200).
JSON בלבד: [{"id":מספר,"est":עלות},...]

ליקויים:
${JSON.stringify(batch)}`;

  tryProviders(system, user, log, (err, raw) => {
    if (err) {
      log.push('[Step 3d] ✗ LLM נכשל — fallback ל-COST_TABLE');
      return callback(defects);
    }
    try {
      const cleaned = (raw || '').replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) throw new Error('not array');
      const result = defects.map(d => ({ ...d }));
      let refined = 0;
      parsed.forEach(({ id, est }) => {
        if (typeof id !== 'number' || typeof est !== 'number') return;
        if (id < 0 || id >= result.length) return;
        result[id].c = Math.max(200, Math.round(est));
        refined++;
      });
      log.push(`[Step 3d] → ${refined} ליקויים עודכנו על ידי LLM`);
      callback(result);
    } catch (e) {
      log.push('[Step 3d] ✗ parse error — fallback ל-COST_TABLE');
      callback(defects);
    }
  }, 0, PROVIDERS_FAST);
}

// ── Step 4: Schema Enforcement (JavaScript only) ─────────────────────────────
```

- [ ] **Step 3: Verify isHighVariance logic with node**

```bash
node -e "
const COST_TABLE = {
  'ריצוף': { min: 800, max: 9000 },
  'כללי':  { min: 500, max: 2000 },
  'חלונות':{ min: 500, max: 8700 },
};
function isHighVariance(k) { const e = COST_TABLE[k] || COST_TABLE['כללי']; return (e.max - e.min) > 4000; }
console.assert(isHighVariance('ריצוף'), 'ריצוף high variance');
console.assert(isHighVariance('חלונות'), 'חלונות high variance');
console.assert(!isHighVariance('כללי'), 'כללי low variance');
console.log('isHighVariance assertions pass');
"
```

Expected: `isHighVariance assertions pass`

---

## Task 3: Wire `step3d` into the pipeline

**Files:**
- Modify: `server.js:1196-1235`

- [ ] **Step 1: Verify the block to replace**

```bash
sed -n '1196,1236p' '/Users/gilsolo44/Downloads/בדקלי חדש/server.js'
```

Expected: starts with `        // Step 3c — section-budget allocation`, ends with `        callback(null, resultJson);`

- [ ] **Step 2: Replace the step3c block + step4-onwards with step3d-wrapped version**

Find in `server.js`:
```javascript
        // Step 3c — section-budget allocation (best-effort, no network)
        const _llmTot = (sectionMap && sectionMap.reportTotal > 0) ? sectionMap.reportTotal : 0;
        const _repTot = (_llmTot > 0) ? _llmTot : reportTotal;
        const sectionEnriched = step3c_sectionBudget(enrichedDefects, costTableText, _repTot);
        const secAssigned = sectionEnriched.filter(d => d._cs === 'section').length;
        if (secAssigned > 0) fullLog.push(`[Step 3c] -> ${secAssigned} ליקויים קיבלו עלות מסקשן`);

        // Step 4 — schema enforcement
        const t4 = Date.now();
        const finalDefects = step4_schema(sectionEnriched);
        fullLog.push(`[Step 4] -> ${finalDefects.length} ליקויים, ${Date.now()-t4}ms`);

        // Deduplicate: same room + page + hash of first 40 chars of title (normalized)
        const _seen = new Set();
        const dedupedDefects = finalDefects.filter(d => {
          const normalizedTitle = (d.title || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
          const titleKey = crypto.createHash('md5').update(normalizedTitle).digest('hex').slice(0, 8);
          const key = `${d.area}|${d.pageNum}|${titleKey}`;
          if (_seen.has(key)) return false;
          _seen.add(key);
          return true;
        });
        if (dedupedDefects.length < finalDefects.length) {
          fullLog.push(`[Step 4] -> dedup removed ${finalDefects.length - dedupedDefects.length} duplicates`);
        }

        // Cost coverage validation — LLM total takes precedence; regex is fallback
        const llmTotal = (sectionMap && sectionMap.reportTotal > 0) ? sectionMap.reportTotal : 0;
        const finalReportTotal = (llmTotal && llmTotal > 0) ? llmTotal : reportTotal;
        fullLog.push(`[reportTotal] llm=₪${llmTotal.toLocaleString()} regex=₪${reportTotal.toLocaleString()} → final=₪${finalReportTotal.toLocaleString()} (source: ${llmTotal?'LLM':'regex'})`);
        const sumExtracted = dedupedDefects.reduce((a,d) => a + (d.cMin||0), 0);
        const coverage = finalReportTotal > 0 ? Math.round(sumExtracted/finalReportTotal*100) : 0;
        fullLog.push(`[Cost Coverage] ${coverage}% — extracted ₪${sumExtracted.toLocaleString()} vs report ₪${finalReportTotal.toLocaleString()}`);
        fullLog.push(`[Total] ${Date.now()-t0}ms`);
        fullLog.push('===================');
        fullLog.forEach(l => console.log(l));

        const resultJson = JSON.stringify({ defects: dedupedDefects, reportTotal: finalReportTotal, structureType, analysisLog: fullLog });
        cacheSet(finalCacheKey, resultJson);
        callback(null, resultJson);
```

Replace with:
```javascript
        // Step 3c — section-budget allocation (best-effort, no network)
        const _llmTot = (sectionMap && sectionMap.reportTotal > 0) ? sectionMap.reportTotal : 0;
        const _repTot = (_llmTot > 0) ? _llmTot : reportTotal;
        const sectionEnriched = step3c_sectionBudget(enrichedDefects, costTableText, _repTot);
        const secReport = sectionEnriched.filter(d => d._cs === 'report').length;
        const secSection = sectionEnriched.filter(d => d._cs === 'section').length;
        if (secReport > 0) fullLog.push(`[Step 3c] -> ${secReport} ליקויים קיבלו עלות מהטקסט (report)`);
        if (secSection > 0) fullLog.push(`[Step 3c] -> ${secSection} ליקויים קיבלו עלות מסקשן (section)`);

        // Step 3d — LLM cost refinement for high-variance remainder
        const t3d = Date.now();
        step3d_llmCostRefine(sectionEnriched, fullLog, (refinedDefects) => {
          fullLog.push(`[Step 3d] -> ${Date.now()-t3d}ms`);

          // Step 4 — schema enforcement
          const t4 = Date.now();
          const finalDefects = step4_schema(refinedDefects);
          fullLog.push(`[Step 4] -> ${finalDefects.length} ליקויים, ${Date.now()-t4}ms`);

          // Deduplicate: same room + page + hash of first 40 chars of title (normalized)
          const _seen = new Set();
          const dedupedDefects = finalDefects.filter(d => {
            const normalizedTitle = (d.title || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
            const titleKey = crypto.createHash('md5').update(normalizedTitle).digest('hex').slice(0, 8);
            const key = `${d.area}|${d.pageNum}|${titleKey}`;
            if (_seen.has(key)) return false;
            _seen.add(key);
            return true;
          });
          if (dedupedDefects.length < finalDefects.length) {
            fullLog.push(`[Step 4] -> dedup removed ${finalDefects.length - dedupedDefects.length} duplicates`);
          }

          // Cost coverage validation — LLM total takes precedence; regex is fallback
          const llmTotal = (sectionMap && sectionMap.reportTotal > 0) ? sectionMap.reportTotal : 0;
          const finalReportTotal = (llmTotal && llmTotal > 0) ? llmTotal : reportTotal;
          fullLog.push(`[reportTotal] llm=₪${llmTotal.toLocaleString()} regex=₪${reportTotal.toLocaleString()} → final=₪${finalReportTotal.toLocaleString()} (source: ${llmTotal?'LLM':'regex'})`);
          const sumExtracted = dedupedDefects.reduce((a,d) => a + (d.cMin||0), 0);
          const coverage = finalReportTotal > 0 ? Math.round(sumExtracted/finalReportTotal*100) : 0;
          fullLog.push(`[Cost Coverage] ${coverage}% — extracted ₪${sumExtracted.toLocaleString()} vs report ₪${finalReportTotal.toLocaleString()}`);
          fullLog.push(`[Total] ${Date.now()-t0}ms`);
          fullLog.push('===================');
          fullLog.forEach(l => console.log(l));

          const resultJson = JSON.stringify({ defects: dedupedDefects, reportTotal: finalReportTotal, structureType, analysisLog: fullLog });
          cacheSet(finalCacheKey, resultJson);
          callback(null, resultJson);
        }); // end step3d
```

- [ ] **Step 3: Verify server boots cleanly**

```bash
pkill -f 'bun server.js' 2>/dev/null; pkill -f 'node server.js' 2>/dev/null
sleep 1
cd '/Users/gilsolo44/Downloads/בדקלי חדש' && bun server.js &
sleep 2 && curl -s http://localhost:3000/ | head -c 80
```

Expected: first 80 chars of index.html HTML. No crash, no syntax error.

---

## Task 4: Fix `estimateBanner` condition + final verification

**Files:**
- Modify: `public/report.html:831`

- [ ] **Step 1: Verify current banner condition**

```bash
grep -n "every\|estCount\|estimateBanner" '/Users/gilsolo44/Downloads/בדקלי חדש/public/report.html'
```

Expected: line ~831 contains `D.every(d=>d.costSource==='estimate')`

- [ ] **Step 2: Replace banner condition**

Find in `public/report.html`:
```javascript
  if(RT>0&&D.length>0&&D.every(d=>d.costSource==='estimate')){
    const b=document.getElementById('estimateBanner');
    if(b){b.style.display='block';const t=b.querySelector('#bannerTotal');if(t)t.textContent='₪'+RT.toLocaleString('he-IL');}
  }
```

Replace with:
```javascript
  const _estCount=D.filter(d=>d.costSource==='estimate').length;
  if(RT>0&&D.length>0&&_estCount/D.length>=0.7){
    const b=document.getElementById('estimateBanner');
    if(b){b.style.display='block';const t=b.querySelector('#bannerTotal');if(t)t.textContent='₪'+RT.toLocaleString('he-IL');}
  }
```

- [ ] **Step 3: Verify banner logic with node**

```bash
node -e "
const D = Array(10).fill(null).map((_,i) => ({ costSource: i < 8 ? 'estimate' : 'section' }));
const _estCount = D.filter(d => d.costSource === 'estimate').length;
const RT = 198545;
const fires = RT > 0 && D.length > 0 && _estCount / D.length >= 0.7;
console.assert(fires === true, '80% estimate should fire banner');
const D2 = Array(10).fill(null).map(() => ({ costSource: 'section' }));
const _ec2 = D2.filter(d => d.costSource === 'estimate').length;
const fires2 = RT > 0 && D2.length > 0 && _ec2 / D2.length >= 0.7;
console.assert(fires2 === false, '0% estimate should not fire');
console.log('banner condition assertions pass');
"
```

Expected: `banner condition assertions pass`

- [ ] **Step 4: Final boot + smoke test**

```bash
pkill -f 'bun server.js' 2>/dev/null; pkill -f 'node server.js' 2>/dev/null
sleep 1
cd '/Users/gilsolo44/Downloads/בדקלי חדש' && bun server.js &
sleep 2 && curl -s http://localhost:3000/ | grep -c '<html'
```

Expected: `1`

---

## Self-Review Against Spec

| Spec requirement | Task |
|-----------------|------|
| Pass A: inline regex on d.q / d.ds → costSource='report' | Task 1 |
| Pass B: section-budget distribution → costSource='section' | Task 1 (unchanged logic, new structure) |
| step3d: isHighVariance threshold (max-min > 4000) | Task 2 |
| step3d: one batched LLM call via tryProviders PROVIDERS_FAST | Task 2 |
| step3d: silent fallback on any error | Task 2 (both err and parse catch return callback(defects)) |
| Pipeline: step3d between step3c and step4 | Task 3 |
| step3c log split into report/section counts | Task 3 |
| estimateBanner: ≥70% estimate threshold | Task 4 |
| costSource labels unchanged (report/section/estimate) | Tasks 1-3 (no label changes) |
| GATEKEEPER: defect count 50+, reportTotal ₪198,545 | Boot test in Task 3 Step 3 (regression check via server boot; full GATEKEEPER run is a manual PDF upload) |
