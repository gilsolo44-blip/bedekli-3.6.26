# Universal Engine — Complete Design Spec (v3)
**Date:** 2026-05-12  
**Project:** Bedekli (בדקלי) — Home Inspection AI Analyzer  
**Scope:** Scale-agnostic universal PDF engine — any company, any format, any size. Vercel Pro primary target.  
**Status:** Approved for implementation — supersedes earlier v1/v2 drafts

---

## Current State (Post Sprint 3)

Sprint 3 already shipped format-agnostic STRUCT_PROMPT (R1–R6 in CLAUDE.md). The following remain:

| Problem | Root Cause | Sprint |
|---------|-----------|--------|
| 73-page PDF hang (confirmed: sessionStorage crash) | `bdkl_imgs` base64 thumbnails overflow 5–10MB browser quota | Sprint 4 |
| Vercel 10s timeout on large reports | Single blocking JSON response — pipeline takes 60–120s | Sprint 4 |
| ROOM_PATTERNS still in server.js | `step1_structural()` not yet deleted | Sprint 4 |
| Cost extraction returns 0 on some formats | Page delimiter fragility + narrow keyword set | Sprint 5 |
| Formal-language report intro not stripped | `step2_filter` DEFECT_RE vocab too narrow | Sprint 5 |

This spec covers Sprint 4 (SSE + IndexedDB) and Sprint 5 (cost/filter hardening) as one implementation plan.

---

## Architecture — Approach A: SSE Streaming + Semantic Structure + IndexedDB

Single delivery-layer change: replace blocking JSON response with Server-Sent Events stream. Fix client-side memory via IndexedDB. Complete ROOM_PATTERNS removal. Harden cost/filter extraction.

```
PDF (client)
  → pdf.js Web Worker (text extraction — unchanged)
  → POST /api/analyze { pdfText, propertyType } — same shape

Server (Vercel streaming function):
  step0_extractCosts        ← fault-tolerant delimiter parsing (hardened)
  step0b_extractReportTotal ← expanded to 14 keyword patterns (hardened)
  step2_filter              ← expanded defect vocab — formal language (hardened)
  step1_llm                 ← STRUCT_PROMPT v3 already format-aware (Sprint 3 ✅)
                               step1_structural() DELETED — ROOM_PATTERNS REMOVED
  step2b_byRoom             ← unchanged
  step3_extract             ← unchanged, results SSE-flushed per room
  step3b / step3c / step3d  ← unchanged
  step4_schema + dedup      ← unchanged

SSE stream (text/event-stream):
  event: progress   { step, message }              — pipeline heartbeat
  event: total      { reportTotal, costSource }    — after step0b
  event: room       { room, defects[] }            — per room, incremental
  event: done       { structureType, analysisLog[] } — stream close
  event: error      { message, step }              — on failure

Client (index.html):
  fetch() ReadableStream reader — incremental rendering per room event
  IndexedDB bedekli_db store   — replaces sessionStorage bdkl_imgs
  Partial result banner        — if stream cuts before 'done'
```

**Unchanged:** pipeline step order, LLM providers, CONCURRENCY=4, dedup logic, cost badge logic, report.html, rate limiting, XSS sanitization, CJS/Bun.

---

## Sprint 4 — SSE Streaming + ROOM_PATTERNS Removal + IndexedDB

### S4-1: Delete step1_structural and ROOM_PATTERNS (server.js)

**Remove entirely:**
- `const ROOM_PATTERNS = { ... }` (lines 115–163) — all 35 hardcoded Hebrew room regexes
- `function step1_structural(pdfText)` — the regex pre-pass
- `step2b_byRoom_regex()` — room-boundary expansion by regex
- Any reference to `ROOM_PATTERNS` or `step1_structural` in `pipeline()`

**Replace fallback branch** (when `step1_llm` returns null):
```javascript
// OLD: step1_structural → step2b_byRoom_regex → retry LLM → buildCatchAllChunks
// NEW:
} else {
  fullLog.push('[Step 1] LLM failed → catch-all (format-agnostic)');
  const byRoom = buildCatchAllChunks(cleanPageMap, new Set());
  runPipeline(byRoom);
}
```

`buildCatchAllChunks` already groups all pages into 5-page chunks — degraded area labels but 0 data loss.

---

### S4-2: SSE Response Layer (server.js + api/analyze-simple.js)

**server.js HTTP handler — replace single `res.end(JSON)` with stream:**

```javascript
// Headers
res.writeHead(200, {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no'        // Vercel proxy: disable buffering
});

function flush(event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Heartbeat every 8s — keeps Vercel connection alive past 10s limit
const hb = setInterval(() => res.write(': keep-alive\n\n'), 8000);

// Flush points:
// After step0b:          flush('total', { reportTotal, costSource })
// After each step3 room: flush('room', { room, defects })
// Pipeline steps:        flush('progress', { step, message })
// On completion:         flush('done', { structureType, analysisLog }); clearInterval(hb); res.end()
// On error:              flush('error', { message, step }); clearInterval(hb); res.end()
```

**api/analyze-simple.js — add SSE passthrough headers:**
```javascript
// Add to response header forwarding:
'X-Accel-Buffering': 'no',
'Cache-Control': 'no-cache'
```

---

### S4-3: IndexedDB Thumbnail Storage (index.html)

**Remove:** `sessionStorage.setItem('bdkl_imgs', ...)` / `getItem('bdkl_imgs')`

**Add async helpers:**
```javascript
async function openImgDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('bedekli_db', 1);
    r.onupgradeneeded = e => e.target.result.createObjectStore('imgs');
    r.onsuccess = e => res(e.target.result);
    r.onerror = rej;
  });
}
async function putThumb(pageNum, base64) {
  const db = await openImgDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('imgs', 'readwrite');
    tx.objectStore('imgs').put(base64, pageNum);
    tx.oncomplete = res; tx.onerror = rej;
  });
}
async function getThumb(pageNum) {
  const db = await openImgDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('imgs', 'readonly');
    const r = tx.objectStore('imgs').get(pageNum);
    r.onsuccess = () => res(r.result); r.onerror = rej;
  });
}
```

**Migration:** On load, if `sessionStorage.getItem('bdkl_imgs')` exists → migrate to IndexedDB → `sessionStorage.removeItem('bdkl_imgs')`.

**Fallback (private browsing / storage blocked):** Cap sessionStorage thumbnails at 30 pages (oldest evicted), render placeholder image for evicted pages. Never crash.

---

### S4-4: SSE Client Reader (index.html)

**Replace** current `fetch(...).then(r => r.json())` with:

```javascript
const response = await fetch('/api/analyze', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pdfText, propertyType })
});

if (!response.ok) { showError('שגיאת שרת'); return; }

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let streamClosed = false;

try {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop();
    for (const block of events) {
      const eMatch = block.match(/^event: (\w+)/m);
      const dMatch = block.match(/^data: (.+)/m);
      if (!eMatch || !dMatch) continue;
      const payload = JSON.parse(dMatch[1]);
      switch (eMatch[1]) {
        case 'progress': updateProgress(payload.step, payload.message); break;
        case 'total':    updateTotal(payload.reportTotal, payload.costSource); break;
        case 'room':     appendDefects(payload.room, payload.defects); break;
        case 'done':     streamClosed = true; finalizeReport(payload); break;
        case 'error':    streamClosed = true; showError(payload.message, payload.step); break;
      }
    }
  }
} finally {
  if (!streamClosed) showBanner('ניתוח הופסק — תוצאות חלקיות מוצגות', 'warning');
}
```

---

## Sprint 5 — Cost & Filter Hardening

### S5-1: Fault-Tolerant Cost Extraction (server.js)

**`step0_extractCosts`** — wrap page split in guard:
```javascript
function step0_extractCosts(pdfText) {
  const pages = pdfText.split(/---\s*עמוד\s*(\d+)\s*---/);
  if (pages.length < 3) {
    // Delimiter not found — full-text fallback
    const costMap = {};
    const vals = [];
    let m;
    const moneyRe = /(\d{1,3}(?:,\d{3})+|\d{4,7})\s*(?:ש["״]ח|₪|שקלים?)\b/g;
    while ((m = moneyRe.exec(pdfText)) !== null) {
      const v = parseInt(m[1].replace(/,/g,''));
      if (v >= 200 && v <= 500000) vals.push(v);
    }
    if (vals.length) costMap[0] = vals;
    return costMap;
  }
  // ... existing loop unchanged ...
}
```

**`step0b_extractReportTotal`** — expand TOTAL_KW from 6 to 14 patterns:
```javascript
const TOTAL_KW = '(?:סה["״“”]?כ|סהכ|סך\\s+הכל|עלות\\s+כוללת|' +
  'סכום\\s+כולל|סיכום\\s+כספי|עלות\\s+מוערכת\\s+כוללת|תמחור\\s+כולל|' +
  'עלות\\s+תיקון\\s+כוללת|סכום\\s+מוערך|עלות\\s+מוערכת|תקציב\\s+מוערך|' +
  'סה["״]?כ\\s+תיקון|עלות\\s+כוללת\\s+מוערכת)';
```

### S5-2: Expanded Defect Vocabulary in step2_filter (server.js)

```javascript
// Current:
const _DEFECT_RE = /₪|ש"ח|ליקוי|ממצא|פגם|סדק|רטיבות|בעיה\s+ב|נזק\s+ב/;

// New (adds formal inspection language):
const _DEFECT_RE = /₪|ש"ח|ליקוי|ממצא|פגם|סדק|רטיבות|בעיה\s+ב|נזק\s+ב|ממצא\s+הנדסי|אי.התאמ|פגיעה|תיקון\s+נדרש|הצעת\s+תיקון|ליקוי\s+בנייה|אי\s+תקינות/;
```

---

## Error Handling

| Failure | Behaviour |
|---------|-----------|
| SSE stream cut before `done` | Partial results + warning banner |
| Room extraction fails 3× retry | `event: room { defects:[], error:"timeout" }` — warning badge on card |
| `structureType` unrecognised | Default `ROOMS`, log `[STRUCT_WARN]` |
| Cost extraction returns 0 | `costSource='estimate'`, `estimateBanner` fires |
| IndexedDB unavailable | Cap sessionStorage at 30 thumbs, placeholder for rest |
| Vercel 500 | `event: error` flushed, partial defects preserved |

---

## Testing Strategy

### TDD Gate Order

1. Run `sprint1-scale-audit.js` — confirm 9/9 still PASS (baseline)
2. Write and run `tests/sprint4-sse-indexeddb-gate.js` — confirm all FAIL
3. Implement Sprint 4 changes
4. Run both — all must pass
5. Write and run `tests/sprint5-format-coverage.js` — confirm all FAIL
6. Implement Sprint 5 changes
7. Run all gates — all pass

### tests/sprint4-sse-indexeddb-gate.js (3 tests, must FAIL before fix)

```javascript
// TEST-1: ROOM_PATTERNS deleted
// Assert: require('../server.js') exports no ROOM_PATTERNS constant
// FAIL on current: ROOM_PATTERNS exists at line 115

// TEST-2: Server response is SSE
// Assert: POST /api/analyze response Content-Type === 'text/event-stream'
// FAIL on current: Content-Type is 'application/json'

// TEST-3: SSE delivers 'event: room' before stream closes
// Assert: response body contains /^event: room/m before stream end
// FAIL on current: single JSON blob, no SSE events
```

### tests/sprint5-format-coverage.js (2 tests, must FAIL before fix)

```javascript
// TEST-4: reportTotal from formal-language report
// Input: text with 'תמחור כולל: 150,000 ₪' (no 'סה"כ')
// Assert: step0b_extractReportTotal returns 150000
// FAIL on current: TOTAL_KW doesn't include 'תמחור כולל'

// TEST-5: step2_filter strips formal intro
// Input: page 1 with 'ממצא הנדסי' but no 'ליקוי'/'ממצא'
// Assert: page is detected as containing defects, NOT stripped
// FAIL on current: DEFECT_RE misses 'ממצא הנדסי'
```

### E2E Benchmarks (final certification)

| File | Size | Target |
|------|------|--------|
| `דוח-דוגמא-בדיקת-דירה-חדשה_.pdf` | 34.8MB | Zero freeze, ≥10 defects, `reportTotal>0`, SSE stream complete |
| `בדק-בית-בחיפה-דירת-גן-יד-שנייה-לפני-רכישה.pdf` | 1.1MB | `structureType` correct, no timeout |
| `Job_273_דוח לדוגמא _2025_09_12_9_35_38 (2).pdf` | 24.7MB | SSE completes without Vercel timeout |

---

## Sprint Roadmap

| Sprint | Goal | Key Deliverable |
|--------|------|-----------------|
| Sprint 4 | SSE + ROOM_PATTERNS removal + IndexedDB | `sprint4-sse-indexeddb-gate.js` all pass |
| Sprint 5 | Cost/filter hardening | `sprint5-format-coverage.js` all pass |
| Sprint 6 | E2E certification + CLAUDE.md rewrite | All 3 benchmark PDFs pass, CLAUDE.md updated |

---

## Files Modified

| File | Change |
|------|--------|
| `server.js` | SSE layer, `step1_structural` deleted, `ROOM_PATTERNS` removed, cost/filter hardening |
| `public/index.html` | IndexedDB thumbnails, SSE client reader |
| `api/analyze-simple.js` | SSE passthrough headers |
| `tests/sprint4-sse-indexeddb-gate.js` | New TDD gate |
| `tests/sprint5-format-coverage.js` | New format coverage tests |
| `CLAUDE.md` | Full rewrite — Universal & Scale-Agnostic, SSE architecture documented |

---

## Operational Constraints

- CJS only — `require()`, no `import`
- No Express — raw Bun HTTP server
- CONCURRENCY=4 — do not raise
- `esc()` on all LLM fields — XSS invariant unchanged
- Token model: Haiku for UI changes, Sonnet for logic
- Before any commit: run `sprint1-scale-audit.js` — all 9 must pass

---

*Note: Sections from the earlier v2 draft (adaptive page filtering, scale-aware STRUCT_PROMPT, Track B retirement, emergency Haiku provider) are superseded by Sprint 3 (already shipped) and this Sprint 4/5 plan. Refer to CLAUDE.md for Sprint 3 implementation record.*
- **Short reports (≤20 pages):** `step2_filter` strips pages 1–4 unconditionally, destroying up to 30% of content
- **Long reports (>100 pages):** The `avg > 10` rejection gate requires more sections than `STRUCT_PROMPT` asks for — LLM result is rejected, falls to regex, finds 0 Hebrew apartment rooms, degrades to generic catch-all
- **Non-room-based reports:** System-organized reports (חשמל/ריצוף/אינסטלציה chapters), commercial properties, duplexes — regex Track B (`ROOM_PATTERNS`) returns 0 matches
- **All-provider-down state:** No emergency extraction path; pipeline returns 0 defects

**Test corpus:** 80+ PDFs in `בדק בית דוגמאות/`, ranging 14–209 pages, 7+ inspection companies, apartments/houses/duplexes/offices/engineering expert opinions.

---

## Architecture — What Changes, What Stays

### Pipeline order: UNCHANGED
```
step0 → step2_filter → step1_llm → step2b_byRoom → step3_extract →
step3b_matchCosts → step3c_sectionBudget → step3d_llmCostRefine → step4_schema → dedup
```

### What changes
| Component | Current | New |
|-----------|---------|-----|
| `step2_filter` intro strip | Fixed pages 1–4 | Content-based adaptive detection |
| `STRUCT_PROMPT` | 73-page apartment example + fixed thresholds | Format-neutral + adaptive thresholds |
| `step1_llm` rejection gate | `avg > 10` | `avg > max(10, totalPages/10)` |
| LLM fallback when Track A fails | Track B (Hebrew regex) | Direct `buildCatchAllChunks` |
| Emergency extraction | None | Claude Haiku last-resort provider |
| Test suite | sprint0 + sprint1 (2 files) | + sprint3-universal-engine.js (3 PDFs) |

### What is removed
- `step1_structural()` — Hebrew `ROOM_PATTERNS` regex structural mapper
- `step2b_byRoom_regex()` — room-boundary expansion by regex
- `MAX_SECTION = 7` constant (only used by the above)

### What is preserved unchanged
- All provider cascade logic (`PROVIDERS_STRUCT`, `PROVIDERS_FAST`, `PROVIDERS_LARGE`)
- `step3_extract` concurrency, chunking, retry logic
- `step3b`, `step3c`, `step3d` cost pipeline
- `step4_schema`, `dedup`, `CAT_RULES`, `inferWorkType`
- All frontend code (index.html, report.html, pdf-worker.js)
- All security: `esc()`, rate limiting, socket timeout
- `buildCatchAllChunks` (promoted, not changed)
- CLAUDE.md (updated at end)

---

## Section 1 — Adaptive Page Filtering

**File:** `server.js` → `step2_filter(pdfText)`

### Current behavior
```javascript
// Strips pages 1–4 unconditionally
clean = clean.replace(/---\s*עמוד\s*[1-4]\s*---[\s\S]*?(?=---\s*עמוד\s*\d+\s*---)/g, '');
```

### New behavior

Replace with `isIntroPage(pageText)` heuristic applied per-page:

```javascript
function isIntroPage(text) {
  const t = text.trim();
  if (t.length < 250) return true; // very short = header/cover
  const INTRO_SIGNALS = /מבוא|מתודולוגיה|פרטי\s+הנכס|פרטי\s+הלקוח|הצגת\s+השירות|חתימה|תאריך\s+הבדיקה|שם\s+הבודק|מספר\s+רישיון|כתובת\s+הנכס/;
  const DEFECT_SIGNALS = /ליקוי|בעיה|סדק|רטיב|דליפ|חסר|לא\s+תקין|נמצא|ממצא|פגם|שחיקה|התנתקות/;
  return INTRO_SIGNALS.test(t) && !DEFECT_SIGNALS.test(t);
}
```

Strip logic: scan pages in order, strip consecutive intro pages from the start. Stop at first non-intro page. **Hard cap: never strip more than 6 pages.**

```javascript
// In step2_filter — replace the fixed-page-strip block:
const parts = clean.split(/(---\s*עמוד\s*\d+\s*---)/);
let introCount = 0;
const MAX_INTRO_STRIP = 6;
// Find first page index, strip intro pages up to cap
// (implementation detail: rebuild clean from non-intro pages onward)
```

### Why this works
- 14-page report with content from page 2: intro detection finds page 1 as intro (short/header), keeps page 2 onward
- 73-page report: pages 1–4 still detected as intro (they have boilerplate signals, no defect signals) — behavior unchanged
- Report with immediate defects on page 1: `DEFECT_SIGNALS` match → page 1 NOT stripped → no data loss

---

## Section 2 — Scale-Aware STRUCT_PROMPT

**File:** `server.js` → `STRUCT_PROMPT` constant + `step1_llm()` rejection gate

### STRUCT_PROMPT changes

**Remove:** The 73-page apartment example (lines 190–203 in current code). It biases the LLM toward that specific structure.

**Replace with:** Three compact format-neutral examples + explicit adaptation instruction:

```
דוגמה א׳ — דירה 25 עמ', לפי חדרים:
{"sections":[{"name":"כניסה","startPage":3,"endPage":6},
  {"name":"סלון","startPage":7,"endPage":12},{"name":"מטבח","startPage":13,"endPage":18},
  {"name":"חדר שינה","startPage":19,"endPage":25}],"costTablePages":[],"reportTotal":0}

דוגמה ב׳ — בית 40 עמ', לפי מערכות:
{"sections":[{"name":"ריצוף","startPage":4,"endPage":14},
  {"name":"חשמל","startPage":15,"endPage":24},{"name":"אינסטלציה","startPage":25,"endPage":38}],
  "costTablePages":[39,40],"reportTotal":85000}

דוגמה ג׳ — דוח קצר 12 עמ':
{"sections":[{"name":"ממצאים כלליים","startPage":2,"endPage":12}],
  "costTablePages":[],"reportTotal":0}

התאם את הפלט למה שאתה רואה בפועל — לא לדוגמאות.
```

**Replace fixed minimum-sections rule** with adaptive formula embedded in the prompt:
```
מינימום sections נדרש:
≤15 עמ' → לפחות 2   |   16-40 עמ' → לפחות 4
41-80 עמ' → לפחות 7  |   81-150 עמ' → לפחות 10
151+ עמ' → לפחות 14
```

### Rejection gate change

**File:** `step1_llm()` function, two locations (LLM result + cache result)

```javascript
// Current:
if ((n < 3 && totalPages > 20) || avg > 10) → fallback

// New:
const avgThreshold = Math.max(10, totalPages / 10);
const minSections = totalPages <= 15 ? 2 : 3;
if ((n < minSections && totalPages > 20) || avg > avgThreshold) → fallback
```

**Effect on 209-page report:** threshold = max(10, 20.9) = 20.9 → requires 10+ sections (209/20.9). LLM returns 14 sections → avg = 14.9 → passes. Previously rejected.

**Effect on 73-page report:** threshold = max(10, 7.3) = 10 → unchanged. Backward compatible.

**Effect on 14-page report:** `n < minSections` → minSections = 2. Gate passes with 2 sections.

---

## Section 3 — Retire Track B

**File:** `server.js` → `pipeline()` fallback branch

### Current fallback (when `step1_llm` returns null)
```
step1_structural (ROOM_PATTERNS regex) → step2b_byRoom_regex →
if 0 rooms → retry LLM → if fails → buildCatchAllChunks
```

### New fallback
```
buildCatchAllChunks directly
```

### Implementation

In `pipeline()`, replace the `else` branch (LLM fallback):

```javascript
} else {
  // LLM failed — direct to catch-all (format-agnostic)
  // buildCatchAllChunks already skips pages < 5; pass empty excluded set
  fullLog.push('[Step 1] -> LLM failed — catch-all all pages >= 5');
  const byRoom = buildCatchAllChunks(cleanPageMap, new Set());
  runPipeline(byRoom);
}
```

### Functions deleted
- `step1_structural(pdfText)` — entire function removed
- `step2b_byRoom_regex(cleanText, structure)` — entire function removed  
- `ROOM_PATTERNS` constant — removed
- `MAX_SECTION` constant — removed

### Why catch-all is sufficient as fallback
`buildCatchAllChunks` already groups all unassigned pages into `PAGES_PER_CHUNK=5` chunks, labels them semantically (עמ' X-Y), and feeds them into `step3_extract`. Defects are extracted regardless of document structure. The LLM in step3 finds defects by content meaning, not section name.

The cost: slightly less precise area labeling (ממצאים כלליים instead of room name). Acceptable degradation vs. 0 defects from a failed regex pass.

---

## Section 4 — Emergency Haiku Provider

**File:** `server.js` → provider arrays + `step3_extract` finish logic

### Trigger condition
`step3_extract` produces 0 total defects AND `ANTHROPIC_API_KEY` is set in `.env.local`.

### Provider addition

Add Claude Haiku at the **end** of `PROVIDERS_LARGE` and `PROVIDERS_FAST`:
```javascript
{ 
  name: 'claude-haiku', 
  check: () => !!ANTHROPIC_KEY,
  call: haikuCall,
  model: 'claude-haiku-4-5-20251001'
}
```

### `haikuCall` implementation

Standard Anthropic Messages API call. Uses same `SHORT_PROMPT` as step3. Max tokens: 4096. Temperature: 0.

```javascript
function haikuCall(model, system, user, callback, attempt = 1) {
  if (!ANTHROPIC_KEY) return callback(new Error('No Anthropic key'));
  const body = JSON.stringify({
    model,
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
    if (status !== 200) return callback(new Error('Haiku ' + status));
    try {
      const js = JSON.parse(text);
      callback(null, js.content?.[0]?.text || '');
    } catch(e) { callback(e); }
  });
}
```

### Emergency trigger in `step3_extract` finish()

After the retry pass completes, if `allDefects.length === 0` and `ANTHROPIC_KEY` is set:

```javascript
if (allDefects.length === 0 && ANTHROPIC_KEY) {
  log.push('[Step 3 EMERGENCY] 0 defects — triggering Haiku emergency extraction');
  // Force all tasks through Haiku only (single-provider array)
  const HAIKU_ONLY = [{ name: 'claude-haiku', check: () => !!ANTHROPIC_KEY, call: haikuCall, model: 'claude-haiku-4-5-20251001' }];
  // Re-run original tasks sequentially (no concurrency — emergency, not performance)
  return runTasksSequential(tasks, HAIKU_ONLY, (emergencyDefects) => {
    allDefects.push(...emergencyDefects);
    callback(null, allDefects, log, 'emergency');
  });
}
```

`runTasksSequential` is a new helper: iterates tasks one-by-one, calls `tryProviders(SHORT_PROMPT, userMsg, subLog, cb, 0, providers)`, collects results. Existing `parseDefects` / `area` assignment logic reused.

`callback` signature gains an optional 4th arg `extractionMode` propagated to the pipeline result.

### Result flag

Add `extractionMode: 'emergency'` to the JSON result when emergency path fires. Frontend shows a yellow banner: *"ניתוח חירום — כל הספקים החינמיים עמוסים. תוצאות עשויות להיות חלקיות."*

### `.env.local` addition
```env
ANTHROPIC_API_KEY=  # optional — enables emergency Haiku fallback
```

---

## Section 5 — TDD Test Gate

**File:** `tests/sprint3-universal-engine.js`

### Test A — Short report (14 pages)

Synthetic 14-page PDF text. Content starts on page 2 (page 1 = short header). No defects on page 1.

**Assertions:**
1. `step2_filter` does NOT remove page 2 content
2. `step1_llm` (mocked) returns ≥ 2 sections
3. Rejection gate passes with `avg ≤ max(10, 14/10)` = 10
4. `step3_extract` produces ≥ 5 defects

**Must FAIL on current code:** current `step2_filter` strips pages 1–4 → page 2 content gone.

### Test B — System-based report (42 pages, chapters)

Synthetic 42-page text. Section headings: `ריצוף`, `חשמל`, `אינסטלציה`. No Hebrew apartment room names.

**Assertions:**
1. `ROOM_PATTERNS` is no longer defined in `server.js` (Track B retired)
2. `step1_llm` detects ≥ 3 system-based sections
3. Fallback (if LLM called with null) goes directly to `buildCatchAllChunks`, NOT `step1_structural`
4. ≥ 10 defects extracted

**Must FAIL on current code:** `step1_structural` + `ROOM_PATTERNS` exists and is invoked; 0 rooms found.

### Test C — Long-form engineering report (159 pages)

Synthetic 159-page text distributed across 15 chapters.

**Assertions:**
1. Rejection gate threshold = `Math.max(10, 159/10)` = 15.9
2. LLM result with 14 sections: avg = 159/14 = 11.4 → passes gate (11.4 < 15.9)
3. Same result on current code: avg = 11.4 > 10 → REJECTED → fallback

**Must FAIL on current code:** gate rejects 14 sections on 159-page report.

### Running the gate
```bash
node tests/sprint3-universal-engine.js
# Expected before fix: 3+ FAIL
# Expected after fix:  0 FAIL
```

---

## Section 6 — E2E Benchmarks

| PDF | Pages | Min Defects | Key Metric | Guard |
|-----|-------|-------------|-----------|-------|
| `בדיקת-דירה-חדשה.pdf` | 73 | 50 | ₪198,545 total | Regression |
| `aa.pdf` | 14 | 5 | ≥ 2 sections | Short report |
| `גולדאל...משרדים.pdf` | 42 | 10 | 0 ROOM_PATTERNS references in log | Format agnostic |
| `חוות דעת...קיסריה.pdf` | 159 | 20 | ≥ 10 sections detected | Scale |

---

## Section 7 — CLAUDE.md Update

After all phases pass, rewrite the relevant sections of CLAUDE.md (Pipeline, Architecture, Test Gates) to reflect v2. Add a new section:

```markdown
## 🌐 Universal Engine (v2 — 2026-05-12)

**Certified for:** Any home inspection PDF regardless of company, format, or page count.

### What changed from v1
- `step2_filter`: content-based adaptive intro detection (replaces fixed pages 1–4 strip)
- `STRUCT_PROMPT`: format-neutral, 3 compact examples, adaptive min-section thresholds
- `step1_llm` rejection gate: `avg > max(10, totalPages/10)` (was hardcoded avg > 10)
- Track B retired: `step1_structural` and `step2b_byRoom_regex` removed
- Emergency provider: Claude Haiku fires when 0 defects and all free providers exhausted

### Certified test suite
- Sprint 3 gate: 3 structurally distinct PDFs (14p short / 42p system-based / 159p long-form)
- All sprint gates must pass before any deployment: sprint0 + sprint1 + sprint3
```

---

## Implementation Order

1. Write and run `sprint3-universal-engine.js` — confirm all 3 tests FAIL
2. Implement Section 3 (retire Track B) — simplest, most isolated change
3. Implement Section 1 (adaptive filter) — fix short reports
4. Implement Section 2 (STRUCT_PROMPT + gate) — fix long reports
5. Implement Section 4 (Haiku emergency) — additive, no regressions possible
6. Run all 3 sprint gates
7. E2E with 4 benchmark PDFs
8. Update CLAUDE.md

---

## Risk Register

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Adaptive intro detection strips real content | Low | DEFECT_SIGNALS guard + 6-page cap |
| Catch-all fallback produces generic area labels | Medium | Acceptable — "ממצאים כלליים" beats 0 defects |
| Haiku costs money in emergency | Low | Only fires when all free providers exhausted; add cost warning in log |
| 73-page regression on gate change | Low | max(10, 73/10) = 10 → identical threshold |
| Very short PDF (5p) has no intro pages | Low | Cap handles it; 0 pages stripped if no intro signals |
