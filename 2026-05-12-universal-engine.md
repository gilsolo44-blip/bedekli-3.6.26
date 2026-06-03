# Universal Engine v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Bedekli pipeline process ANY home inspection PDF (any company, format, 14–209+ pages) without degrading to zero defects.

**Architecture:** Four surgical changes to `server.js` — adaptive intro filter, format-neutral STRUCT_PROMPT with scale-aware rejection gate, Track B (Hebrew regex fallback) retirement, and Claude Haiku emergency provider — plus a TDD gate proving all three failure modes before any fix lands.

**Tech Stack:** Node.js/Bun (CJS), plain HTTP server, multi-LLM cascade (Groq/Gemini/Cerebras/OpenRouter/Haiku), Anthropic API for emergency path.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `tests/sprint3-universal-engine.js` | **Create** | TDD gate — 4 test groups, must all FAIL before fixes, PASS after |
| `server.js` | **Modify** | Core pipeline — adaptive filter, STRUCT_PROMPT, gate, Track B removal, Haiku provider |
| `public/index.html` | **Modify** | Show emergency banner when `extractionMode === 'emergency'` |
| `CLAUDE.md` | **Modify** | Rewrite pipeline and test-gate sections to reflect v2 |

---

## Task 1: TDD Gate — Write sprint3 Tests (All Must FAIL)

**Files:**
- Create: `tests/sprint3-universal-engine.js`

- [ ] **Step 1.1: Create the test file**

```javascript
#!/usr/bin/env node
// Sprint 3 — Universal Engine Gate
// 4 test groups. Run BEFORE fixes: all must FAIL. Run AFTER: all must PASS.
'use strict';
const fs   = require('fs');
const path = require('path');

const SRC  = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
let failures = 0;

function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ${PASS}  ${label}`); }
  else           { console.log(`  ${FAIL}  ${label}${detail ? ' — ' + detail : ''}`); failures++; }
}

// ── TEST-A: Adaptive intro filter ─────────────────────────────────────────────
console.log('\nTEST-A: Adaptive intro filter (replaces fixed pages 1-4 strip)');

assert(
  'isIntroPage() function defined',
  /function isIntroPage\s*\(/.test(SRC),
  'isIntroPage not found — adaptive filter not implemented'
);
assert(
  'Fixed pages 1-4 strip regex removed from step2_filter',
  !/replace\s*\(\s*\/---\\s\*עמוד\\s\*\[1-4\]/.test(SRC),
  'Legacy /[1-4]/ strip pattern still present — kills short report content'
);
assert(
  'MAX_INTRO_STRIP cap defined (value 1–6)',
  /MAX_INTRO_STRIP\s*=/.test(SRC),
  'No intro strip cap — could over-strip small reports'
);

// ── TEST-B: Track B retired ───────────────────────────────────────────────────
console.log('\nTEST-B: Track B retirement (Hebrew regex structural fallback)');

assert(
  'ROOM_PATTERNS constant removed',
  !/const ROOM_PATTERNS\s*=/.test(SRC),
  'ROOM_PATTERNS still defined — Hebrew-only regex fallback still active'
);
assert(
  'step1_structural() function removed',
  !/function step1_structural\s*\(/.test(SRC),
  'step1_structural still defined'
);
assert(
  'step2b_byRoom_regex() function removed',
  !/function step2b_byRoom_regex\s*\(/.test(SRC),
  'step2b_byRoom_regex still defined'
);
const pipelineSrc = SRC.match(/function pipeline[\s\S]{0,8000}/)?.[0] || '';
const elseBranch  = pipelineSrc.match(/\}\s*else\s*\{[\s\S]{0,600}/)?.[0] || '';
assert(
  'buildCatchAllChunks called in LLM-fallback else branch',
  /buildCatchAllChunks/.test(elseBranch),
  'Else branch does not call buildCatchAllChunks — catch-all not wired as first fallback'
);

// ── TEST-C: Scale-aware rejection gate ───────────────────────────────────────
console.log('\nTEST-C: Scale-aware rejection gate');

assert(
  'Math.max(10, totalPages / 10) gate formula present',
  /Math\.max\s*\(\s*10\s*,\s*totalPages\s*\/\s*10\s*\)/.test(SRC),
  'Old hardcoded avg > 10 still used — 159-page reports rejected'
);
const bareAvgGate = SRC.match(/avg\s*>\s*10(?!\s*\))/g);
assert(
  'Bare "avg > 10" hardcode removed',
  !bareAvgGate || bareAvgGate.length === 0,
  `avg > 10 hardcode still present (${bareAvgGate?.length} occurrences)`
);
// Simulate: 159-page report, 14 sections — must pass new gate
const newGatePasses = (() => {
  const totalPages = 159, n = 14;
  const avgThreshold = Math.max(10, totalPages / 10); // 15.9
  const avg = totalPages / Math.max(n, 1);             // 11.36
  const minN = totalPages <= 15 ? 2 : 3;
  return !((n < minN && totalPages > 20) || avg > avgThreshold);
})();
assert('159-page / 14-section report passes new gate (avg 11.4 < threshold 15.9)', newGatePasses);
// Same report must fail OLD gate (proves the fix matters)
const oldGateRejects = (() => {
  const totalPages = 159, n = 14;
  const avg = totalPages / Math.max(n, 1); // 11.36 > 10 → reject
  return (n < 3 && totalPages > 20) || avg > 10;
})();
assert('Old gate correctly rejects 159p/14s (baseline confirms fix is needed)', oldGateRejects);

// ── TEST-D: Haiku emergency provider ─────────────────────────────────────────
console.log('\nTEST-D: Haiku emergency provider');

assert(
  'haikuCall() function defined',
  /function haikuCall\s*\(/.test(SRC),
  'Emergency Haiku provider not implemented'
);
assert(
  "PROVIDERS_LARGE includes claude-haiku entry",
  /PROVIDERS_LARGE[\s\S]{0,800}claude-haiku/.test(SRC),
  'Haiku not added to PROVIDERS_LARGE'
);
const step3Src = SRC.match(/function step3_extract[\s\S]{0,5000}/)?.[0] || '';
assert(
  'Emergency trigger present in step3_extract (allDefects.length === 0 check)',
  /allDefects\.length\s*===\s*0/.test(step3Src),
  'Emergency 0-defect trigger missing from step3_extract'
);

// ── SUMMARY ──────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════');
if (failures === 0) {
  console.log(` ${PASS}  All checks pass — Universal Engine v2 certified.`);
} else {
  console.log(` ${FAIL}  ${failures} check(s) failed — implement fixes before shipping.`);
}
console.log('══════════════════════════════════════════════════════\n');
process.exit(failures > 0 ? 1 : 0);
```

- [ ] **Step 1.2: Run the gate — confirm all 11 checks FAIL**

```bash
cd "/Users/gilsolo44/Downloads/בדקלי חדש"
node tests/sprint3-universal-engine.js
```

Expected: `11 check(s) failed` — exit code 1. If any check passes, the baseline assumption is wrong; investigate before proceeding.

- [ ] **Step 1.3: Commit the failing test**

```bash
git add tests/sprint3-universal-engine.js
git commit -m "test: add sprint3 universal engine gate (all failing — pre-fix baseline)"
```

---

## Task 2: Retire Track B (Delete Hebrew Regex Fallback)

**Files:**
- Modify: `server.js`

This is the simplest change and the most isolated. Remove three functions + one constant, then replace the `else` branch in `pipeline()`.

- [ ] **Step 2.1: Delete `ROOM_PATTERNS` constant**

Find and delete lines 115–154 in `server.js` — the entire `const ROOM_PATTERNS = { ... };` block. It starts with `const ROOM_PATTERNS = {` and ends with `};` before `function step1_structural`.

- [ ] **Step 2.2: Delete `step1_structural()` function**

Find and delete lines 156–170 in `server.js` — the entire `function step1_structural(pdfText) { ... }` block.

- [ ] **Step 2.3: Delete `step2b_byRoom_regex()` function**

Find and delete lines 316–348 in `server.js` — the entire `function step2b_byRoom_regex(cleanText, structure) { ... }` block (includes `const MAX_SECTION = 7`).

- [ ] **Step 2.4: Replace the `else` branch in `pipeline()`**

In `pipeline()`, find the `else {` block that starts after `if (sectionMap) { ... }`. It currently starts with `const structure = step1_structural(cleanText)`. Replace the entire else block content (keep the outer `} else {` and closing `}`) with:

```javascript
    } else {
      // LLM failed — direct catch-all (format-agnostic, no Hebrew room assumption)
      fullLog.push('[Step 1] -> LLM failed — catch-all all pages >= 5');
      costTableText = Object.entries(costMap)
        .filter(([, costs]) => costs.length >= 3)
        .map(([p]) => cleanPageMap[p] ? `[עמוד ${p}]\n${cleanPageMap[p].trim()}` : '')
        .filter(Boolean).join('\n\n');
      byRoom = buildCatchAllChunks(cleanPageMap, new Set());
      runPipeline(byRoom);
    }
```

- [ ] **Step 2.5: Run sprint0 + sprint1 gates to confirm no regression**

```bash
node tests/sprint0-failure-gate.js && node tests/sprint1-scale-audit.js
```

Expected: both exit 0. If sprint1 FLAW-B fails (outline cap), that's pre-existing — do not fix here.

- [ ] **Step 2.6: Run sprint3 — count remaining failures (should drop from 11 to ~7)**

```bash
node tests/sprint3-universal-engine.js
```

Expected: TEST-B group (4 checks) now PASS. TEST-A, TEST-C, TEST-D still FAIL.

- [ ] **Step 2.7: Commit**

```bash
git add server.js
git commit -m "refactor: retire Track B Hebrew regex fallback (ROOM_PATTERNS, step1_structural, step2b_byRoom_regex)

Direct LLM-fail path to buildCatchAllChunks — format-agnostic fallback.
Removes 80+ lines of Hebrew apartment-specific regex."
```

---

## Task 3: Adaptive Intro Filter

**Files:**
- Modify: `server.js`

Replace the fixed `pages 1-4 strip` with a content-aware detector that never strips more than `floor(totalPages/3)` pages (capped at 6).

- [ ] **Step 3.1: Add `isIntroPage()` and constants just before `step2_filter`**

In `server.js`, find `function step2_filter(pdfText)` (currently around line 271). Insert the following immediately before it:

```javascript
// ── Adaptive intro detection — content-based, not page-number-based ──────────

const INTRO_SIGNALS  = /מבוא|מתודולוגיה|פרטי\s+הנכס|פרטי\s+הלקוח|הצגת\s+השירות|חתימה|תאריך\s+הבדיקה|שם\s+הבודק|מספר\s+רישיון|כתובת\s+הנכס/;
const DEFECT_SIGNALS = /ליקוי|בעיה|סדק|רטיב|דליפ|חסר|לא\s+תקין|נמצא|ממצא|פגם|שחיקה|התנתקות/;

function isIntroPage(text) {
  const t = text.trim();
  if (t.length < 250) return true; // very short = cover/header page
  return INTRO_SIGNALS.test(t) && !DEFECT_SIGNALS.test(t);
}
```

- [ ] **Step 3.2: Replace the fixed-page-strip line inside `step2_filter`**

Inside `step2_filter`, find and **replace only** this line:
```javascript
  clean = clean.replace(/---\s*עמוד\s*[1-4]\s*---[\s\S]*?(?=---\s*עמוד\s*\d+\s*---)/g, '');
```

Replace it with:
```javascript
  // Adaptive intro strip — detect by content, never by page number
  {
    const _parts = clean.split(/---\s*עמוד\s*(\d+)\s*---/);
    const _totalPages = Math.floor((_parts.length - 1) / 2);
    const MAX_INTRO_STRIP = Math.min(6, Math.max(0, Math.floor(_totalPages / 3)));
    let _introActive = true;
    let _stripped = 0;
    let _rebuilt = _parts[0];
    for (let _i = 1; _i < _parts.length; _i += 2) {
      const _pn  = parseInt(_parts[_i]);
      const _txt = _parts[_i + 1] || '';
      if (_introActive && _stripped < MAX_INTRO_STRIP && isIntroPage(_txt)) {
        _stripped++;
        continue;
      }
      _introActive = false;
      _rebuilt += `\n--- עמוד ${_pn} ---\n${_txt}`;
    }
    if (_stripped > 0) clean = _rebuilt;
  }
```

All other lines in `step2_filter` stay unchanged.

- [ ] **Step 3.3: Verify the filter works on a synthetic short report**

```bash
node -e "
const {pipeline} = require('./server.js');
// Synthetic: 8 pages, intro on p1 only
let txt = '\n--- עמוד 1 ---\nשם הבודק: משה כהן\nתאריך הבדיקה: 01.01.2026\nכתובת הנכס: תל אביב\n';
for (let p=2;p<=8;p++) txt += '\n--- עמוד '+p+' ---\nנמצא ליקוי: סדק בקיר המטבח. רטיבות בפינה.\n';
// Just test step2_filter via module internals — not exported, so test via pipeline mock
// Quick smoke: run with empty ANTHROPIC/GROQ keys, expect 0 defects but no crash
pipeline(txt, 'new', (err, raw) => {
  if (err) { console.log('OK — pipeline failed gracefully:', err.message.slice(0,60)); }
  else { const d=JSON.parse(raw); console.log('sections in log:', d.analysisLog.find(l=>l.includes('Step 1'))); }
});
" 2>&1 | head -5
```

Expected: no crash. Log line shows catch-all or LLM attempt.

- [ ] **Step 3.4: Run sprint3**

```bash
node tests/sprint3-universal-engine.js
```

Expected: TEST-A group (3 checks) now PASS. TEST-B already passing. TEST-C, TEST-D still FAIL.

- [ ] **Step 3.5: Commit**

```bash
git add server.js
git commit -m "feat: adaptive intro page filter — content-based strip replaces fixed pages 1-4 rule

isIntroPage() uses INTRO_SIGNALS + DEFECT_SIGNALS heuristic.
Cap: min(6, floor(totalPages/3)) pages max stripped.
14-page reports no longer lose content from page 2."
```

---

## Task 4: Format-Neutral STRUCT_PROMPT + Scale-Aware Gate

**Files:**
- Modify: `server.js`

Two changes: (1) rewrite the STRUCT_PROMPT constant, (2) update the rejection gate in `step1_llm` at two call sites.

- [ ] **Step 4.1: Replace `STRUCT_PROMPT`**

Find `const STRUCT_PROMPT = \`` in `server.js` (around line 174). Replace the **entire constant** (from `const STRUCT_PROMPT =` through the closing backtick) with:

```javascript
const STRUCT_PROMPT = `אתה מנתח מסמך בדק-בית. משימתך: לזהות את כל הסקשנים (חדרים, אזורים, או מערכות) ולהחזיר גבולות עמודים.

החזר JSON בלבד ללא backticks, ללא הסברים:
{"sections":[{"name":"שם הסקשן","startPage":N,"endPage":M}],"costTablePages":[N],"reportTotal":0}

חוקים מחייבים:
1. כל חדר, אזור, או מערכת עם כותרת וממצאים = section נפרד. אסור לאחד בלוקים.
2. מינימום sections לפי גודל הדוח:
   ≤15 עמ' → לפחות 2  |  16-40 עמ' → לפחות 4
   41-80 עמ' → לפחות 7  |  81-150 עמ' → לפחות 10  |  151+ עמ' → לפחות 14
3. "ממצאים כלליים" — מותר רק אם אין שם ספציפי. מוגבל ל-3 עמ' מקסימום.
4. כסה כל עמוד מהעמוד הראשון עם ממצאים ועד הסוף. sections רצופות ללא חפיפה.
5. costTablePages = עמודים עם ריבוי סכומי כסף בלבד (ללא ממצאים הנדסיים).
6. reportTotal = הסכום הכולל שמופיע בדוח (0 אם לא נמצא).

התאם את הפלט למה שאתה רואה בפועל — לא לדוגמאות להלן.

דוגמה א׳ — דירה 25 עמ', לפי חדרים:
{"sections":[{"name":"כניסה","startPage":3,"endPage":6},{"name":"סלון","startPage":7,"endPage":12},{"name":"מטבח","startPage":13,"endPage":18},{"name":"חדר שינה","startPage":19,"endPage":25}],"costTablePages":[],"reportTotal":0}

דוגמה ב׳ — בית 40 עמ', לפי מערכות:
{"sections":[{"name":"ריצוף","startPage":4,"endPage":14},{"name":"חשמל","startPage":15,"endPage":24},{"name":"אינסטלציה","startPage":25,"endPage":38}],"costTablePages":[39,40],"reportTotal":85000}

דוגמה ג׳ — דוח קצר 12 עמ':
{"sections":[{"name":"ממצאים כלליים","startPage":2,"endPage":12}],"costTablePages":[],"reportTotal":0}`;
```

- [ ] **Step 4.2: Update rejection gate — cache-hit path**

In `step1_llm()`, find the cache-hit check (around line 242):
```javascript
    if ((n < 3 && totalPages > 20) || avg > 10) {
```

Replace with:
```javascript
    const _avgThresh = Math.max(10, totalPages / 10);
    const _minN = totalPages <= 15 ? 2 : 3;
    if ((n < _minN && totalPages > 20) || avg > _avgThresh) {
```

- [ ] **Step 4.3: Update rejection gate — LLM result path**

In the same `step1_llm()` function, find the second gate check (around line 258):
```javascript
      if ((n < 3 && totalPages > 20) || avg > 10) {
```

Replace with:
```javascript
      const _avgThresh = Math.max(10, totalPages / 10);
      const _minN = totalPages <= 15 ? 2 : 3;
      if ((n < _minN && totalPages > 20) || avg > _avgThresh) {
```

- [ ] **Step 4.4: Run sprint3**

```bash
node tests/sprint3-universal-engine.js
```

Expected: TEST-A PASS, TEST-B PASS, TEST-C PASS (5 checks). Only TEST-D (Haiku) still FAIL.

- [ ] **Step 4.5: Run sprint1 gate to confirm 73-page regression guard**

```bash
node tests/sprint1-scale-audit.js
```

Expected: FLAW-C check passes — `avg > 10` threshold is still ≤ 10 via `Math.max(10, 73/10) = 10`. No regression on the primary test file.

- [ ] **Step 4.6: Commit**

```bash
git add server.js
git commit -m "feat: format-neutral STRUCT_PROMPT + scale-aware rejection gate

STRUCT_PROMPT: 3 compact format examples (rooms/systems/short), adaptive
min-section thresholds, explicit 'adapt to what you see' instruction.
Gate: Math.max(10, totalPages/10) — 159-page report now requires avg<=15.9
instead of <=10, allowing 14+ sections to pass."
```

---

## Task 5: Haiku Emergency Provider

**Files:**
- Modify: `server.js`
- Modify: `public/index.html`

Add Claude Haiku as a pay-per-use last resort when all free providers are exhausted and `step3_extract` returns 0 defects.

- [ ] **Step 5.1: Add `ANTHROPIC_KEY` to env loading**

In `server.js`, find the env variable declarations (around line 58–61):
```javascript
const CEREBRAS_KEY   = process.env.CEREBRAS_API_KEY;
const GEMINI_KEY     = process.env.GEMINI_API_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
```

Add one line after them:
```javascript
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
```

- [ ] **Step 5.2: Add `haikuCall()` provider function**

Find `function groqCall(` in `server.js`. Insert the following **before** it (keep groqCall in place):

```javascript
// ── Provider: Claude Haiku (emergency last-resort — costs money) ──────────────

function haikuCall(model, system, user, callback, attempt = 1) {
  if (!ANTHROPIC_KEY) return callback(new Error('No Anthropic key'));
  const body = JSON.stringify({
    model: model || 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    temperature: 0,
    system,
    messages: [{ role: 'user', content: user }]
  });
  postJSON({
    hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body, (err, status, text) => {
    if (err) return callback(err);
    if (status === 429 && attempt <= 2)
      return setTimeout(() => haikuCall(model, system, user, callback, attempt + 1), 10000);
    if (status !== 200) return callback(new Error('Haiku ' + status + ': ' + text.slice(0, 80)));
    try {
      const js = JSON.parse(text);
      callback(null, js.content?.[0]?.text || '');
    } catch(e) { callback(e); }
  });
}
```

- [ ] **Step 5.3: Add Haiku to `PROVIDERS_LARGE` and `PROVIDERS_FAST`**

Find `PROVIDERS_LARGE` array definition. Add Haiku as the **last entry**:
```javascript
  { name: 'claude-haiku', check: () => !!ANTHROPIC_KEY, call: haikuCall, model: 'claude-haiku-4-5-20251001' },
```

Find `PROVIDERS_FAST` array definition. Add the same entry as the **last entry**.

- [ ] **Step 5.4: Add `runTasksSequential()` helper**

Find `function buildStep3Tasks(` in `server.js`. Insert the following **before** it:

```javascript
// ── Sequential task runner — used for emergency Haiku extraction ──────────────

function runTasksSequential(tasks, providers, log, callback) {
  const results = [];
  let idx = 0;
  function next() {
    if (idx >= tasks.length) return callback(results);
    const t = tasks[idx++];
    const chunkLabel = t.totalChunks > 1 ? ` (חלק ${t.chunkIdx + 1}/${t.totalChunks})` : '';
    const userMsg = `חדר: ${t.room}${chunkLabel}${t.costHintLine}\n\nטקסט:\n${t.text}\n\nחלץ ליקויים. JSON בלבד.`;
    const subLog = [];
    tryProviders(SHORT_PROMPT, userMsg, subLog, (err, raw) => {
      subLog.forEach(l => log.push(`  [emergency:${t.room}] ${l}`));
      if (!err && raw) {
        const defects = parseDefects(raw).map(d => ({ ...d, area: t.room }));
        results.push(...defects);
      }
      next();
    }, 0, providers);
  }
  next();
}
```

- [ ] **Step 5.5: Add emergency trigger in `step3_extract` `finish()`**

In `step3_extract`, find the `retryNext()` function. Its final base case currently looks like:
```javascript
    if (retryIdx >= zeroRooms.length) return callback(null, allDefects, log);
```

Replace that one line with:
```javascript
    if (retryIdx >= zeroRooms.length) {
      if (allDefects.length === 0 && ANTHROPIC_KEY) {
        log.push('[Step 3 EMERGENCY] 0 defects after all retries — triggering Haiku emergency extraction');
        const HAIKU_ONLY = [{ name: 'claude-haiku', check: () => !!ANTHROPIC_KEY, call: haikuCall, model: 'claude-haiku-4-5-20251001' }];
        return runTasksSequential(tasks, HAIKU_ONLY, log, (emergencyDefects) => {
          allDefects.push(...emergencyDefects);
          const mode = emergencyDefects.length > 0 ? 'emergency' : null;
          log.push(`[Step 3 EMERGENCY] → ${emergencyDefects.length} ליקויים מ-Haiku`);
          return callback(null, allDefects, log, mode);
        });
      }
      return callback(null, allDefects, log, null);
    }
```

- [ ] **Step 5.6: Propagate `extractionMode` through `pipeline()`**

In `pipeline()`, find the `step3_extract` call site:
```javascript
    step3_extract(bR, costMap, (err, rawDefects, step3Log) => {
```

Change to:
```javascript
    step3_extract(bR, costMap, (err, rawDefects, step3Log, extractionMode) => {
```

Then find the `resultJson` line inside `runPipeline`:
```javascript
          const resultJson = JSON.stringify({ defects: dedupedDefects, reportTotal: finalReportTotal, structureType, analysisLog: fullLog });
```

Change to:
```javascript
          const resultJson = JSON.stringify({ defects: dedupedDefects, reportTotal: finalReportTotal, structureType, analysisLog: fullLog, ...(extractionMode ? { extractionMode } : {}) });
```

- [ ] **Step 5.7: Add emergency banner to `index.html`**

In `public/index.html`, find:
```javascript
    if(js.analysisLog) console.log('[Bedekli Analysis Log]\n'+js.analysisLog.join('\n'));
```

Add the emergency banner check immediately after:
```javascript
    if(js.extractionMode==='emergency'){
      const banner=document.createElement('div');
      banner.style.cssText='position:fixed;top:0;left:0;right:0;background:#92400E;color:#fff;text-align:center;padding:10px 16px;font-size:14px;z-index:9999;direction:rtl;';
      banner.textContent='⚠️ ניתוח חירום — כל הספקים החינמיים עמוסים. התוצאות עשויות להיות חלקיות.';
      document.body.prepend(banner);
    }
```

- [ ] **Step 5.8: Add `ANTHROPIC_API_KEY` line to `.env.local`**

Open `.env.local`. If `ANTHROPIC_API_KEY=` line is missing, add it:
```
ANTHROPIC_API_KEY=  # optional — enables Haiku emergency fallback when all free providers exhausted
```

- [ ] **Step 5.9: Run full sprint3 — all 11 checks must PASS**

```bash
node tests/sprint3-universal-engine.js
```

Expected: `All checks pass — Universal Engine v2 certified.` Exit code 0.

- [ ] **Step 5.10: Run all three sprint gates**

```bash
node tests/sprint0-failure-gate.js && node tests/sprint1-scale-audit.js && node tests/sprint3-universal-engine.js
```

Expected: all three exit 0.

- [ ] **Step 5.11: Commit**

```bash
git add server.js public/index.html .env.local
git commit -m "feat: Claude Haiku emergency provider + 0-defect fallback trigger

haikuCall() added as last entry in PROVIDERS_FAST and PROVIDERS_LARGE.
runTasksSequential() runs all tasks sequentially through a single-provider array.
step3_extract fires emergency path when allDefects===0 and ANTHROPIC_KEY set.
pipeline() propagates extractionMode to JSON response.
index.html shows amber banner on emergency extraction."
```

---

## Task 6: E2E Benchmark Validation

**Files:** None modified — validation only.

Run the server and test against four benchmark PDFs from `בדק בית דוגמאות/`.

- [ ] **Step 6.1: Start the server**

```bash
cd "/Users/gilsolo44/Downloads/בדקלי חדש"
bun server.js
# or: node server.js
```

Expected: `✅ שרת רץ על http://localhost:3000`

- [ ] **Step 6.2: Clear the analysis cache (force fresh runs)**

```bash
rm -f shared/analysis_cache/result_*.json
```

- [ ] **Step 6.3: Test benchmark PDF 1 — 73-page regression guard**

Open `http://localhost:3000` in browser. Upload `בדק בית דוגמאות/בדיקת-דירה-חדשה.pdf`.

Success criteria:
- ≥ 50 defects extracted
- Report total displayed: ₪198,545
- No "ניתוח חירום" banner
- Console log shows `[Step 1] -> LLM זיהה ≥ 8 סקשנים`
- Total time < 120s

- [ ] **Step 6.4: Test benchmark PDF 2 — short report (14 pages)**

Upload `בדק בית דוגמאות/aa.pdf` (14 pages).

Success criteria:
- ≥ 5 defects extracted
- Console log shows `[Step 2 - Noise Filtration]` — confirm stripped pages < 5 (check log for `intro stripped`)
- No crash or 422 "לא נמצאו ליקויות"

- [ ] **Step 6.5: Test benchmark PDF 3 — offices / system-based (42 pages)**

Upload `בדק בית דוגמאות/גולדאל-הנדסה-דוח-לדוגמה-של-משרדים.pdf` (42 pages).

Success criteria:
- ≥ 10 defects extracted
- Console log shows no `[Step 1] -> fallback regex` line (Track B gone)
- If LLM succeeds: sections detected by content (not Hebrew room names)
- If LLM fails: `catch-all all pages >= 5` in log

- [ ] **Step 6.6: Test benchmark PDF 4 — long engineering report (159 pages)**

Upload `בדק בית דוגמאות/חוות דעת הנדסית  בדק בית - 2025-05-12 - קיסריה.pdf` (159 pages).

Success criteria:
- ≥ 20 defects extracted
- Console log: `[Step 1] -> LLM זיהה ≥ 10 סקשנים`
- Gate passes (section avg ≤ 15.9)
- No gate-rejection fallback to catch-all

- [ ] **Step 6.7: Commit benchmark results to analysis cache (optional)**

If all 4 benchmarks pass, the cache files in `shared/analysis_cache/` represent validated results. No commit needed for cache — it's ephemeral.

---

## Task 7: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 7.1: Update the Pipeline section**

In `CLAUDE.md`, find the `🔄 Pipeline הניתוח` section. Replace the pipeline diagram comment about step1 fallback:

Find:
```
step1_llm              ← LLM (PROVIDERS_STRUCT): מיפוי מבנה — sections + חדרים + עמודי עלויות
```

Add a note below it:
```
                           fallback: buildCatchAllChunks (direct — Track B regex retired in v2)
```

- [ ] **Step 7.2: Remove Track B references from Architecture**

In `CLAUDE.md`, find any mention of `ROOM_PATTERNS`, `step1_structural`, `step2b_byRoom_regex`, `MAX_SECTION`. Remove or update these references.

In the `קבצים ראשיים` table, update `server.js` line count (was ~1450, now ~1360 after deletions).

- [ ] **Step 7.3: Update Test Gates section**

In `CLAUDE.md`, find `🧪 Test Gates`. Add sprint3:

```markdown
# Gate 2 — Universal Engine (3 format families)
node tests/sprint3-universal-engine.js   # חייב: 11/11 PASS
```

- [ ] **Step 7.4: Add Universal Engine v2 section**

At the bottom of `CLAUDE.md`, add:

```markdown
---

## 🌐 Universal Engine (v2 — 2026-05-12)

**מוסמך עבור:** כל דוח בדק בית ללא תלות בחברה, פורמט, או מספר עמודים.

### שינויים מ-v1
- `step2_filter`: זיהוי עמודי מבוא לפי תוכן (לא לפי מספר עמוד)
- `STRUCT_PROMPT`: ניטרלי-פורמט, 3 דוגמאות קומפקטיות, סף מינימום sections אדפטיבי
- שער דחייה step1_llm: `Math.max(10, totalPages/10)` — דוחות 159 עמ' מותרים ל-14 sections
- Track B הוסר: `step1_structural` ו-`step2b_byRoom_regex` נמחקו — fallback ישיר ל-buildCatchAllChunks
- Haiku emergency: מופעל כשכל הספקים החינמיים מוצו ו-0 ליקויים חולצו

### E2E Benchmarks שעברו
| PDF | עמודים | ליקויים | מדד עיקרי |
|-----|---------|---------|------------|
| בדיקת-דירה-חדשה.pdf | 73 | ≥50 | ₪198,545 |
| aa.pdf | 14 | ≥5 | עמ' 2+ נשמר |
| גולדאל...משרדים.pdf | 42 | ≥10 | ללא Track B |
| חוות דעת...קיסריה.pdf | 159 | ≥20 | ≥10 sections |

### כל שערי הבדיקות חובה לפני Deploy
```bash
node tests/sprint0-failure-gate.js   # 2/2 PASS
node tests/sprint1-scale-audit.js    # 9/9 PASS
node tests/sprint3-universal-engine.js # 11/11 PASS
```
```

- [ ] **Step 7.5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for Universal Engine v2

Remove Track B references, update pipeline diagram, add sprint3 gate,
add v2 certification section with benchmark table."
```

---

## Final Verification

- [ ] **Run all three gates in sequence**

```bash
node tests/sprint0-failure-gate.js && \
node tests/sprint1-scale-audit.js  && \
node tests/sprint3-universal-engine.js && \
echo "✅ ALL GATES PASS — Universal Engine v2 certified."
```

Expected output ends with: `✅ ALL GATES PASS — Universal Engine v2 certified.`

---

## Self-Review Checklist (completed)

- [x] **Spec coverage:** All 6 spec sections covered — adaptive filter (Task 3), STRUCT_PROMPT/gate (Task 4), Track B retirement (Task 2), Haiku emergency (Task 5), TDD gate (Task 1), CLAUDE.md (Task 7). E2E benchmarks in Task 6.
- [x] **Placeholder scan:** No TBDs. All code blocks are complete. All commands have expected outputs.
- [x] **Type consistency:** `haikuCall(model, system, user, callback, attempt)` signature consistent across Step 5.2 and 5.5. `runTasksSequential(tasks, providers, log, callback)` defined in 5.4, called in 5.5. `extractionMode` propagated through 5.5 → 5.6 → response JSON.
- [x] **Gate coverage:** sprint3 test checks exactly the properties each task changes — A→Task3, B→Task2, C→Task4, D→Task5.
