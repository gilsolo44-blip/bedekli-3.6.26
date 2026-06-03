# Multimodal Vision Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a parallel Gemini-vision path to the analyzer so scanned PDFs get OCR and embedded inspection photos are detected, linked to defect cards, and merged with the existing text pipeline — without breaking the working text path — and unify the stale Vercel wrapper onto `server.js`.

**Architecture:** The existing text pipeline (`step0→step4`) runs unchanged. A new `visionPath()` runs in parallel: it inspects per-page metadata from the client, and only if there are scanned/image pages, uploads the raw PDF to the Gemini Files API once and asks `gemini-2.5-flash` to extract defects + a bounding box for each relevant photo. Results merge into the text defects via the existing dedup key, enriching matching text defects with a `bbox`. The client renders the photo by cropping the page thumbnail at the bbox. The Vercel function becomes a thin CJS wrapper around the already-exported `pipeline()`.

**Tech Stack:** Node.js/Bun, plain CJS (no frameworks), `https` module for Gemini REST, Gemini 2.5 Flash (multimodal + Files API), pdf.js (client), vanilla JS frontend. Tests are plain-node scripts run via `node tests/<file>.js` printing `N/M PASS`.

---

## File Structure

| File | Create/Modify | Responsibility |
|------|---------------|----------------|
| `server.js` | Modify | Add `VISION` config, `validateBbox`, `detectVisualPages`, `mergeDefects`, `geminiUploadFile`, `geminiDeleteFile`, `geminiVisionExtract`, `visionPath`; extend `step4_schema` to pass through `bbox`; extend `pipeline()` signature + parallel join; extend HTTP handler body parse |
| `api/analyze-simple.js` | Replace | Thin CJS wrapper that calls `require('../server.js').pipeline` and returns unified schema |
| `public/index.html` | Modify | Compute `pageMeta[]` (hasTextLayer/hasImages) via pdf.js and send `pdfBase64` + `pageMeta` in the POST body |
| `public/report.html` | Modify | `cropPhotoFromThumb(defect)` — crop page thumbnail at bbox, render `<img>` in card; `esc()` all vision fields |
| `tests/sprint8-vision.js` | Create | Gate: pure-function unit tests for the vision additions |

**Defect record shape (post `step4_schema`)** — reference for all tasks:
```
{ id, area, title, desc, action, sev, pageNum, page, cMin, cMax,
  costSource, quote, category, categoryLabel, workType }
```
Raw defect short keys (what `parseDefects` emits, consumed by `step4_schema`):
`t`=title, `ds`=desc, `s`=sev, `p`=page, `c`=cost, `rec`=action, `q`=quote, `area`=room.
Vision raw defects use the same short keys **plus** `bbox:[ymin,xmin,ymax,xmax]` (0–1000).

---

## Task 1: Vision config + `validateBbox` + `detectVisualPages` (pure JS)

**Files:**
- Modify: `server.js` (add after the provider key block, near line 60)
- Create: `tests/sprint8-vision.js`

- [ ] **Step 1: Write failing tests**

Create `tests/sprint8-vision.js`:
```js
const assert = require('assert');
const S = require('../server.js');
let pass = 0, fail = 0;
function t(name, fn){ try{ fn(); pass++; console.log('✓', name);}catch(e){ fail++; console.log('✗', name, '—', e.message);} }

// validateBbox
t('validateBbox accepts valid box', () => {
  assert.deepStrictEqual(S.validateBbox([10, 20, 800, 900]), [10, 20, 800, 900]);
});
t('validateBbox rejects out-of-range', () => {
  assert.strictEqual(S.validateBbox([0, 0, 1001, 500]), null);
});
t('validateBbox rejects inverted (ymin>=ymax)', () => {
  assert.strictEqual(S.validateBbox([900, 0, 100, 500]), null);
});
t('validateBbox rejects non-array / wrong length', () => {
  assert.strictEqual(S.validateBbox([1,2,3]), null);
  assert.strictEqual(S.validateBbox('nope'), null);
  assert.strictEqual(S.validateBbox(null), null);
});

// detectVisualPages
t('detectVisualPages flags scanned (no text layer)', () => {
  const r = S.detectVisualPages([{page:1,hasTextLayer:false,hasImages:false}]);
  assert.deepStrictEqual(r, [1]);
});
t('detectVisualPages flags pages with images', () => {
  const r = S.detectVisualPages([{page:2,hasTextLayer:true,hasImages:true}]);
  assert.deepStrictEqual(r, [2]);
});
t('detectVisualPages skips clean text pages', () => {
  const r = S.detectVisualPages([{page:3,hasTextLayer:true,hasImages:false}]);
  assert.deepStrictEqual(r, []);
});
t('detectVisualPages handles missing/empty meta', () => {
  assert.deepStrictEqual(S.detectVisualPages(null), []);
  assert.deepStrictEqual(S.detectVisualPages([]), []);
});

console.log(`\n${pass}/${pass+fail} PASS`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/sprint8-vision.js`
Expected: FAIL — `S.validateBbox is not a function` (functions not exported yet).

- [ ] **Step 3: Add config + functions to `server.js`**

Insert after line 60 (`const OPENROUTER_KEY = ...`):
```js
// ── Vision (multimodal) config ───────────────────────────────────────────────
const VISION = {
  enabled: process.env.VISION_ENABLED !== '0',
  model: process.env.VISION_MODEL || 'gemini-2.5-flash', // → 'gemini-2.5-pro' for paid tier
  maxVisualPages: parseInt(process.env.VISION_MAX_PAGES) || 30,
};

// Validate a Gemini bounding box [ymin,xmin,ymax,xmax] normalized 0-1000.
function validateBbox(b) {
  if (!Array.isArray(b) || b.length !== 4) return null;
  const [ymin, xmin, ymax, xmax] = b.map(Number);
  if (b.some(v => typeof v !== 'number' && isNaN(Number(v)))) return null;
  for (const v of [ymin, xmin, ymax, xmax]) {
    if (!Number.isFinite(v) || v < 0 || v > 1000) return null;
  }
  if (ymin >= ymax || xmin >= xmax) return null;
  return [ymin, xmin, ymax, xmax];
}

// From client page metadata, return the page numbers that need vision.
function detectVisualPages(pageMeta) {
  if (!Array.isArray(pageMeta)) return [];
  return pageMeta
    .filter(p => p && (p.hasTextLayer === false || p.hasImages === true))
    .map(p => p.page)
    .filter(n => Number.isFinite(n));
}
```

Update the export at the bottom of `server.js` (line ~1366):
```js
module.exports = { pipeline, validateBbox, detectVisualPages };
```

- [ ] **Step 4: Run to verify pass**

Run: `node tests/sprint8-vision.js`
Expected: `8/8 PASS` (for the tests written so far).

- [ ] **Step 5: Commit**
```bash
git add server.js tests/sprint8-vision.js
git commit -m "feat(vision): add VISION config, validateBbox, detectVisualPages"
```

---

## Task 2: `step4_schema` passes through `bbox`

**Files:**
- Modify: `server.js:528-544` (the returned object in `step4_schema`)
- Modify: `tests/sprint8-vision.js`

- [ ] **Step 1: Add failing test**

Append to `tests/sprint8-vision.js` before the summary line:
```js
t('step4_schema passes through valid bbox', () => {
  const out = S.step4_schema([{ t:'סדק', ds:'סדק בקיר', s:'high', p:'5', bbox:[10,10,500,500], area:'סלון' }]);
  assert.deepStrictEqual(out[0].bbox, [10,10,500,500]);
});
t('step4_schema nullifies invalid bbox', () => {
  const out = S.step4_schema([{ t:'סדק', ds:'x', s:'high', p:'5', bbox:[1,1,2000,2], area:'סלון' }]);
  assert.strictEqual(out[0].bbox, null);
});
t('step4_schema defaults bbox to null when absent', () => {
  const out = S.step4_schema([{ t:'סדק', ds:'x', s:'high', p:'5', area:'סלון' }]);
  assert.strictEqual(out[0].bbox, null);
});
```
Also add `step4_schema` to the export list (Step 3).

- [ ] **Step 2: Run to verify fail**

Run: `node tests/sprint8-vision.js`
Expected: FAIL — `S.step4_schema is not a function` and bbox assertions.

- [ ] **Step 3: Implement**

In `server.js`, in the object returned by `step4_schema` (after `workType:` line 543), add:
```js
      workType:      inferWorkType(d.rec || desc),
      bbox:          validateBbox(d.bbox),
```
Update export:
```js
module.exports = { pipeline, validateBbox, detectVisualPages, step4_schema };
```

- [ ] **Step 4: Run to verify pass**

Run: `node tests/sprint8-vision.js`
Expected: `11/11 PASS`.

- [ ] **Step 5: Commit**
```bash
git add server.js tests/sprint8-vision.js
git commit -m "feat(vision): step4_schema passes through validated bbox"
```

---

## Task 3: `mergeDefects` with photo enrichment

**Files:**
- Modify: `server.js` (add a standalone `mergeDefects` function near the dedup logic, before `pipeline`)
- Modify: `tests/sprint8-vision.js`

**Behavior:** Concatenate text + vision defects, dedup with the SAME key the pipeline uses (`area|pageNum|md5(title[:40])`). When a vision defect collides with an existing text defect that has no bbox, copy the vision defect's bbox onto the kept (text) record. Non-colliding vision defects are appended.

- [ ] **Step 1: Add failing tests**
```js
t('mergeDefects appends unique vision defects', () => {
  const text = [{ area:'סלון', pageNum:5, title:'סדק', bbox:null }];
  const vis  = [{ area:'מטבח', pageNum:9, title:'רטיבות', bbox:[1,1,9,9] }];
  const m = S.mergeDefects(text, vis);
  assert.strictEqual(m.length, 2);
});
t('mergeDefects enriches matching text defect with bbox', () => {
  const text = [{ area:'סלון', pageNum:5, title:'סדק בקיר', bbox:null }];
  const vis  = [{ area:'סלון', pageNum:5, title:'סדק בקיר', bbox:[10,10,500,500] }];
  const m = S.mergeDefects(text, vis);
  assert.strictEqual(m.length, 1);
  assert.deepStrictEqual(m[0].bbox, [10,10,500,500]);
});
t('mergeDefects keeps existing bbox over vision', () => {
  const text = [{ area:'סלון', pageNum:5, title:'סדק', bbox:[1,1,2,2] }];
  const vis  = [{ area:'סלון', pageNum:5, title:'סדק', bbox:[9,9,99,99] }];
  const m = S.mergeDefects(text, vis);
  assert.deepStrictEqual(m[0].bbox, [1,1,2,2]);
});
```
Add `mergeDefects` to export list.

- [ ] **Step 2: Run to verify fail**

Run: `node tests/sprint8-vision.js`
Expected: FAIL — `S.mergeDefects is not a function`.

- [ ] **Step 3: Implement**

Add to `server.js` just before `function pipeline(` (line ~1082):
```js
function _dedupKey(d) {
  const norm = (d.title || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
  const h = crypto.createHash('md5').update(norm).digest('hex').slice(0, 8);
  return `${d.area}|${d.pageNum}|${h}`;
}

// Merge text + vision defects. Dedup by the pipeline key; a colliding vision
// defect enriches the kept record with its bbox if the kept record has none.
function mergeDefects(textDefects, visionDefects) {
  const byKey = new Map();
  for (const d of textDefects) byKey.set(_dedupKey(d), d);
  for (const v of (visionDefects || [])) {
    const k = _dedupKey(v);
    if (byKey.has(k)) {
      const kept = byKey.get(k);
      if (!kept.bbox && v.bbox) kept.bbox = v.bbox;
    } else {
      byKey.set(k, v);
    }
  }
  return [...byKey.values()];
}
```
Add to export: `mergeDefects`.

- [ ] **Step 4: Run to verify pass**

Run: `node tests/sprint8-vision.js`
Expected: `14/14 PASS`.

- [ ] **Step 5: Commit**
```bash
git add server.js tests/sprint8-vision.js
git commit -m "feat(vision): add mergeDefects with bbox enrichment"
```

---

## Task 4: `geminiUploadFile` + `geminiDeleteFile` (Files API)

**Files:**
- Modify: `server.js` (add after `geminiCall`, line ~722)

> No unit test (network I/O). Verified structurally here and via E2E in Task 12. Use a smoke test against the live API.

- [ ] **Step 1: Implement upload (resumable) + delete**

Add after `geminiCall` (line ~722):
```js
// ── Gemini Files API ─────────────────────────────────────────────────────────
// Resumable upload of a base64 PDF. Returns { uri, name } via callback.
function geminiUploadFile(pdfBase64, callback) {
  if (!GEMINI_KEY) return callback(new Error('No Gemini key'));
  const buf = Buffer.from(pdfBase64, 'base64');
  const startBody = JSON.stringify({ file: { display_name: 'inspection.pdf' } });
  const startOpts = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/upload/v1beta/files?key=${GEMINI_KEY}`,
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': buf.length,
      'X-Goog-Upload-Header-Content-Type': 'application/pdf',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(startBody),
    },
  };
  const startReq = https.request(startOpts, (resp) => {
    const uploadUrl = resp.headers['x-goog-upload-url'];
    resp.on('data', () => {}); resp.on('end', () => {
      if (!uploadUrl) return callback(new Error('Files API: no upload URL (status ' + resp.statusCode + ')'));
      const u = new URL(uploadUrl);
      const upOpts = {
        hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: {
          'Content-Length': buf.length,
          'X-Goog-Upload-Offset': 0,
          'X-Goog-Upload-Command': 'upload, finalize',
        },
      };
      const upReq = https.request(upOpts, (r2) => {
        let body = ''; r2.on('data', c => body += c); r2.on('end', () => {
          try {
            const js = JSON.parse(body);
            if (!js.file || !js.file.uri) return callback(new Error('Files API finalize failed: ' + body.slice(0, 120)));
            callback(null, { uri: js.file.uri, name: js.file.name });
          } catch (e) { callback(e); }
        });
      });
      upReq.on('error', callback);
      upReq.write(buf); upReq.end();
    });
  });
  startReq.on('error', callback);
  startReq.write(startBody); startReq.end();
}

// Proactive cleanup — best-effort, errors ignored.
function geminiDeleteFile(name, callback) {
  if (!GEMINI_KEY || !name) return callback && callback();
  const opts = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/${name}?key=${GEMINI_KEY}`, method: 'DELETE',
  };
  const req = https.request(opts, (r) => { r.on('data', () => {}); r.on('end', () => callback && callback()); });
  req.on('error', () => callback && callback());
  req.end();
}
```

- [ ] **Step 2: Smoke test against live API**

Create a throwaway check (do NOT commit):
```bash
node -e '
const fs=require("fs"); const S=require("./server.js");
// minimal 1-page PDF base64
const b64=Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>").toString("base64");
S.geminiUploadFile(b64,(e,f)=>{ if(e)return console.log("UPLOAD ERR",e.message); console.log("OK",f.uri); S.geminiDeleteFile(f.name,()=>console.log("deleted")); });
'
```
First add `geminiUploadFile, geminiDeleteFile` to exports. Expected: `OK https://...` then `deleted`. (Requires valid `GEMINI_KEY` in `.env.local`.)

- [ ] **Step 3: Commit**
```bash
git add server.js
git commit -m "feat(vision): add Gemini Files API upload + delete"
```

---

## Task 5: `VISION_PROMPT` + `geminiVisionExtract`

**Files:**
- Modify: `server.js` (add after Task 4 functions)

- [ ] **Step 1: Implement**

Add:
```js
const VISION_PROMPT = `אתה מנתח דוח בדק-בית בעברית מתוך קובץ PDF (כולל עמודים סרוקים וצילומים).
התמקד בעמודים הבאים: {PAGES}.
חלץ כל ליקוי שאתה מזהה — מטקסט סרוק (OCR) ומתוך הצילומים עצמם (סדק, רטיבות, עובש, נזק).
לכל ליקוי, אם יש צילום רלוונטי בעמוד, החזר bounding box שלו בקואורדינטות מנורמלות 0-1000 בפורמט [ymin,xmin,ymax,xmax]; אם אין צילום — bbox=null.
החזר JSON בלבד, ללא backticks, במבנה:
{"defects":[{"t":"כותרת קצרה","ds":"תיאור","s":"critical|high|medium|low|cosmetic","p":מספר_עמוד,"c":"עלות אם מופיעה","rec":"פעולה נדרשת","q":"ציטוט/מהתמונה","area":"שם החדר/אזור","bbox":[ymin,xmin,ymax,xmax]}]}`;

// Extract defects from a PDF already uploaded to Files API. Gemini-only (Files API).
function geminiVisionExtract(fileUri, visualPages, propertyType, callback, attempt = 1) {
  if (!GEMINI_KEY) return callback(new Error('No Gemini key'));
  const prompt = VISION_PROMPT.replace('{PAGES}', visualPages.join(', '));
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [
      { fileData: { fileUri, mimeType: 'application/pdf' } },
      { text: prompt },
    ]}],
    generationConfig: { temperature: 0, maxOutputTokens: 8192 },
  });
  postJSON({
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/${VISION.model}:generateContent?key=${GEMINI_KEY}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, body, (err, status, text) => {
    if (err) return callback(err);
    if (status === 429 && attempt === 1) {
      return setTimeout(() => geminiVisionExtract(fileUri, visualPages, propertyType, callback, 2), 8000);
    }
    if (status === 503 && attempt <= 2) {
      return setTimeout(() => geminiVisionExtract(fileUri, visualPages, propertyType, callback, attempt + 1), 4000 * attempt);
    }
    if (status !== 200) return callback(new Error('Vision ' + status + ': ' + text.slice(0, 100)));
    try {
      const js = JSON.parse(text);
      const out = js.candidates?.[0]?.content?.parts?.[0]?.text || '';
      callback(null, parseDefects(out)); // reuse existing tolerant JSON parser
    } catch (e) { callback(e); }
  });
}
```
Add `geminiVisionExtract` to exports.

- [ ] **Step 2: Verify it loads (no syntax errors)**

Run: `node -e "require('./server.js'); console.log('loads ok')"`
Expected: `loads ok`.

- [ ] **Step 3: Commit**
```bash
git add server.js
git commit -m "feat(vision): add VISION_PROMPT + geminiVisionExtract"
```

---

## Task 6: `visionPath` orchestration (graceful degradation)

**Files:**
- Modify: `server.js` (add after Task 5)
- Modify: `tests/sprint8-vision.js`

**Behavior:** `visionPath(pdfBase64, pageMeta, propertyType, log, callback)`:
1. If `!VISION.enabled` or no `pdfBase64` or `detectVisualPages` empty → `callback(null, [])` (no API call).
2. Cap `visualPages` to `VISION.maxVisualPages` (scanned pages first), log a warning when capped.
3. Upload → extract → normalize via `step4_schema` → delete file → `callback(null, defects)`.
4. ANY error → log + `callback(null, [])` (never `callback(err)`).

The two non-network branches are unit-tested (no key needed when short-circuiting).

- [ ] **Step 1: Add failing tests**
```js
t('visionPath short-circuits with no visual pages', (done) => {});
// callback-style: wrap in a tiny runner
(function(){
  let localPass = 0;
  S.visionPath(null, [{page:1,hasTextLayer:true,hasImages:false}], 'new', [], (err, defs) => {
    try { assert.strictEqual(err, null); assert.deepStrictEqual(defs, []); localPass=1; } catch(e){}
  });
  // synchronous short-circuit expected
  t('visionPath returns [] when no visual pages (sync)', () => assert.strictEqual(localPass, 1));
})();
```
Add `visionPath` to exports.

- [ ] **Step 2: Run to verify fail**

Run: `node tests/sprint8-vision.js`
Expected: FAIL — `S.visionPath is not a function`.

- [ ] **Step 3: Implement**
```js
function visionPath(pdfBase64, pageMeta, propertyType, log, callback) {
  if (!VISION.enabled || !pdfBase64) { log.push('[Vision] disabled or no PDF — skipped'); return callback(null, []); }
  let visualPages = detectVisualPages(pageMeta);
  if (!visualPages.length) { log.push('[Vision] 0 visual pages — skipped (0 quota)'); return callback(null, []); }
  if (visualPages.length > VISION.maxVisualPages) {
    const scanned = (pageMeta || []).filter(p => p.hasTextLayer === false).map(p => p.page);
    const withImg = visualPages.filter(p => !scanned.includes(p));
    visualPages = [...new Set([...scanned, ...withImg])].slice(0, VISION.maxVisualPages);
    log.push(`[Vision] capped to ${VISION.maxVisualPages} pages (had more)`);
  }
  log.push(`[Vision] ${visualPages.length} visual pages — uploading PDF`);
  geminiUploadFile(pdfBase64, (upErr, file) => {
    if (upErr) { log.push('[Vision] ✗ upload: ' + upErr.message); return callback(null, []); }
    log.push('[Vision] upload ok');
    geminiVisionExtract(file.uri, visualPages, propertyType, (exErr, rawDefects) => {
      geminiDeleteFile(file.name, () => {}); // proactive cleanup, fire-and-forget
      if (exErr) { log.push('[Vision] ✗ extract: ' + exErr.message); return callback(null, []); }
      const defects = step4_schema(rawDefects || []);
      const withBox = defects.filter(d => d.bbox).length;
      log.push(`[Vision] ${defects.length} ליקויים, ${withBox} bbox`);
      callback(null, defects);
    });
  });
}
```
Add `visionPath` to exports.

- [ ] **Step 4: Run to verify pass**

Run: `node tests/sprint8-vision.js`
Expected: all PASS (short-circuit test green).

- [ ] **Step 5: Commit**
```bash
git add server.js tests/sprint8-vision.js
git commit -m "feat(vision): add visionPath orchestration with graceful degradation"
```

---

## Task 7: Integrate `visionPath` into `pipeline()` (parallel + merge)

**Files:**
- Modify: `server.js` — `pipeline` signature (line 1082) + the dedup section (1207-1234)

- [ ] **Step 1: Extend `pipeline` signature (backward-compatible)**

Change line 1082 from:
```js
function pipeline(pdfText, propertyType, callback) {
```
to:
```js
function pipeline(pdfText, propertyType, opts, callback) {
  if (typeof opts === 'function') { callback = opts; opts = {}; }
  opts = opts || {};
  const { pdfBase64 = null, pageMeta = null } = opts;
```

- [ ] **Step 2: Kick off vision in parallel at pipeline start**

Immediately after the `fullLog.push('=== ROUTING LOG ===')` line (1086), add:
```js
  // Vision path runs in parallel with the text pipeline.
  let _visionDone = false, _visionDefects = [];
  const _visionLog = [];
  visionPath(pdfBase64, pageMeta, propertyType, _visionLog, (_e, defs) => {
    _visionDefects = defs || []; _visionDone = true;
  });
```

- [ ] **Step 3: Join + merge at the dedup point**

Replace the dedup block (lines 1207-1219) — wrap the existing dedup so it first merges vision defects, then waits for vision to finish if needed. Replace from `// Deduplicate:` through the `}` closing the `if (dedupedDefects.length...` block with:
```js
          // Wait for the parallel vision path, then merge before dedup.
          const _afterVision = () => {
            _visionLog.forEach(l => fullLog.push(l));
            const merged = mergeDefects(finalDefects, _visionDefects);
            const _seen = new Set();
            const dedupedDefects = merged.filter(d => {
              const normalizedTitle = (d.title || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
              const titleKey = crypto.createHash('md5').update(normalizedTitle).digest('hex').slice(0, 8);
              const key = `${d.area}|${d.pageNum}|${titleKey}`;
              if (_seen.has(key)) return false;
              _seen.add(key); return true;
            });
            if (dedupedDefects.length < merged.length) {
              fullLog.push(`[Step 4] -> dedup removed ${merged.length - dedupedDefects.length} duplicates`);
            }
            _finishPipeline(dedupedDefects);
          };
          if (_visionDone) _afterVision();
          else { const _iv = setInterval(() => { if (_visionDone) { clearInterval(_iv); _afterVision(); } }, 200);
                 setTimeout(() => { if (!_visionDone) { _visionDone = true; clearInterval(_iv); fullLog.push('[Vision] ✗ timeout — text only'); _afterVision(); } }, 90000); }
```

- [ ] **Step 4: Wrap the tail (reportTotal → result) into `_finishPipeline`**

Replace the remaining tail (lines 1221-1234, from `// Cost coverage validation` through `callback(null, resultJson);`) with a function that takes the deduped list:
```js
          function _finishPipeline(dedupedDefects) {
          const llmTotal = (sectionMap && sectionMap.reportTotal > 0) ? sectionMap.reportTotal : 0;
          const finalReportTotal = (llmTotal && llmTotal > 0) ? llmTotal : reportTotal;
          fullLog.push(`[reportTotal] llm=₪${llmTotal.toLocaleString()} regex=₪${reportTotal.toLocaleString()} → final=₪${finalReportTotal.toLocaleString()} (source: ${llmTotal?'LLM':'regex'})`);
          const sumExtracted = dedupedDefects.reduce((a,d) => a + (d.cMin||0), 0);
          const coverage = finalReportTotal > 0 ? Math.round(sumExtracted/finalReportTotal*100) : 0;
          fullLog.push(`[Cost Coverage] ${coverage}% — extracted ₪${sumExtracted.toLocaleString()} vs report ₪${finalReportTotal.toLocaleString()}`);
          const photosLinked = dedupedDefects.filter(d => d.bbox).length;
          fullLog.push(`[Vision] photosLinked=${photosLinked}`);
          fullLog.push(`[Total] ${Date.now()-t0}ms`);
          fullLog.push('===================');
          fullLog.forEach(l => console.log(l));
          const resultJson = JSON.stringify({ defects: dedupedDefects, reportTotal: finalReportTotal, structureType, analysisLog: fullLog, visionMeta: { pagesScanned: detectVisualPages(pageMeta).length, photosLinked } });
          cacheSet(finalCacheKey, resultJson);
          callback(null, resultJson);
          }
```
> Note: the cache short-circuit at the top of `pipeline` (line 1090) means a previously-cached text-only result returns without vision. Add `pageMeta` presence to the cache key so vision-enabled runs are distinct: change line 1089 to:
> ```js
> const finalCacheKey = `result_${pdfHash(pdfText)}_${propertyType || 'new'}_${detectVisualPages(pageMeta).length ? 'v' : 't'}`;
> ```

- [ ] **Step 5: Verify load + existing behavior**

Run: `node -e "require('./server.js'); console.log('loads ok')"`
Expected: `loads ok`.
Run the text-only regression via the running server (Task 12 covers full E2E):
```bash
node tests/sprint8-vision.js   # still all PASS
```

- [ ] **Step 6: Commit**
```bash
git add server.js
git commit -m "feat(vision): integrate parallel visionPath + merge into pipeline"
```

---

## Task 8: HTTP handler parses `pdfBase64` + `pageMeta`

**Files:**
- Modify: `server.js:1264-1282` (the `req.on('end')` body parse for `/api/analyze-simple`)

- [ ] **Step 1: Implement**

In the `req.on('end')` handler, change the destructuring + the `pipeline(...)` call. Replace:
```js
        const { pdfText, propertyType } = JSON.parse(Buffer.concat(body).toString('utf8'));
```
with:
```js
        const { pdfText, propertyType, pdfBase64, pageMeta } = JSON.parse(Buffer.concat(body).toString('utf8'));
```
And replace:
```js
        pipeline(pdfText, propertyType, (err, raw) => {
```
with:
```js
        pipeline(pdfText, propertyType, { pdfBase64, pageMeta }, (err, raw) => {
```

- [ ] **Step 2: Verify load**

Run: `node -e "require('./server.js'); console.log('ok')"` → `ok`.

- [ ] **Step 3: Commit**
```bash
git add server.js
git commit -m "feat(vision): pass pdfBase64 + pageMeta from HTTP handler to pipeline"
```

---

## Task 9: Unify Vercel wrapper onto `server.js`

**Files:**
- Replace: `api/analyze-simple.js`

- [ ] **Step 1: Replace file contents (CJS, thin wrapper)**
```js
// Vercel serverless wrapper — delegates to the unified pipeline in server.js.
const { pipeline } = require('../server.js');

module.exports.config = {
  maxDuration: 60,
  api: { bodyParser: { sizeLimit: '50mb' } },
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { pdfText, propertyType, pdfBase64, pageMeta } = req.body || {};
  if (!pdfText) return res.status(400).json({ error: 'Missing PDF text' });

  pipeline(pdfText, propertyType, { pdfBase64, pageMeta }, (err, raw) => {
    if (err) return res.status(502).json({ error: err.message });
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(raw); // raw is already a JSON string with the unified schema
  });
};
```
> Note: `config` must be exported. Because we reassign `module.exports` to the handler, attach `config` to the handler object instead:
> after the `module.exports = async function handler...` block, add:
> ```js
> module.exports.config = { maxDuration: 60, api: { bodyParser: { sizeLimit: '50mb' } } };
> ```
> and remove the earlier `module.exports.config` assignment so there is exactly one.

- [ ] **Step 2: Verify the wrapper requires server.js without starting the server**

Run: `node -e "const h=require('./api/analyze-simple.js'); console.log(typeof h, typeof h.config)"`
Expected: `function object` and NO `✅ שרת רץ` line (the `require.main` guard prevents `startServer`).

- [ ] **Step 3: Commit**
```bash
git add api/analyze-simple.js
git commit -m "refactor(vercel): unify analyze-simple wrapper onto server.js pipeline"
```

---

## Task 10: Client — compute `pageMeta` + send `pdfBase64` (index.html)

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Locate the PDF processing + POST**

Find where pdf.js extracts text and where the `fetch('/api/analyze-simple', ...)` POST body is built (search for `analyze-simple` and `getTextContent`).

- [ ] **Step 2: Compute per-page metadata during extraction**

Where each page is processed (inside the loop that calls `page.getTextContent()`), add image detection and accumulate `pageMeta`:
```js
// after: const tc = await page.getTextContent();
const hasTextLayer = (tc.items || []).some(it => (it.str || '').trim().length > 0);
let hasImages = false;
try {
  const ops = await page.getOperatorList();
  const IMG = pdfjsLib.OPS.paintImageXObject;
  const INLINE = pdfjsLib.OPS.paintInlineImageXObject;
  hasImages = ops.fnArray.some(fn => fn === IMG || fn === INLINE);
} catch (e) { /* ignore — default false */ }
pageMeta.push({ page: pageNum, hasTextLayer, hasImages });
```
Declare `const pageMeta = [];` before the page loop. (If extraction runs in `pdf-worker.js`, compute there and post `pageMeta` back with the text; otherwise compute in the main-thread loop that already renders thumbnails.)

- [ ] **Step 3: Read the PDF bytes as base64**

Where the uploaded `File`/`ArrayBuffer` is available, add:
```js
function arrayBufferToBase64(buf) {
  let binary = ''; const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
const pdfBase64 = arrayBufferToBase64(arrayBuffer); // arrayBuffer = the loaded PDF bytes
```

- [ ] **Step 4: Add both to the POST body**

In the `fetch('/api/analyze-simple', { ... body: JSON.stringify({...}) })`, extend the payload:
```js
body: JSON.stringify({ pdfText, propertyType, pdfBase64, pageMeta })
```

- [ ] **Step 5: Manual verify in browser**

Start server (`bun server.js`), open `http://localhost:339`, upload the test PDF, and confirm in the Network tab the request body contains `pdfBase64` and `pageMeta`. Server `analysisLog` should show a `[Vision]` line.

- [ ] **Step 6: Commit**
```bash
git add public/index.html
git commit -m "feat(vision): client sends pdfBase64 + per-page metadata"
```

---

## Task 11: Client — render cropped photo on defect card (report.html)

**Files:**
- Modify: `public/report.html`

- [ ] **Step 1: Add `cropPhotoFromThumb` helper**

Near the defect-card rendering code, add:
```js
// Crop the page thumbnail (bdkl_imgs) at the bbox [ymin,xmin,ymax,xmax] (0-1000).
function cropPhotoFromThumb(defect) {
  if (!defect.bbox) return null;
  const imgs = JSON.parse(sessionStorage.getItem('bdkl_imgs') || '{}');
  const dataUrl = imgs[defect.pageNum];
  if (!dataUrl) return null;
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const [ymin, xmin, ymax, xmax] = defect.bbox;
      const sx = (xmin/1000)*img.width,  sy = (ymin/1000)*img.height;
      const sw = ((xmax-xmin)/1000)*img.width, sh = ((ymax-ymin)/1000)*img.height;
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(sw)); cv.height = Math.max(1, Math.round(sh));
      cv.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
      resolve(cv.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}
```

- [ ] **Step 2: Render the photo in the card (with esc on text fields)**

Where a defect card is built, after the card element exists, add:
```js
if (defect.bbox) {
  cropPhotoFromThumb(defect).then(src => {
    if (!src) return;
    const im = document.createElement('img');
    im.src = src; im.alt = esc(defect.title || ''); im.className = 'defect-photo';
    im.loading = 'lazy';
    cardEl.appendChild(im); // cardEl = the card's DOM node
  });
}
```
Verify every vision-originated text field rendered into innerHTML (title, desc, action, quote, area, categoryLabel) is wrapped in the existing `esc()` — they already pass through `step4_schema`, but confirm the card template uses `esc(...)` for each.

- [ ] **Step 3: Add minimal styling**

In the page `<style>`:
```css
.defect-photo { max-width: 100%; border-radius: 8px; margin-top: 8px; display: block; }
```

- [ ] **Step 4: Manual verify**

With a PDF that has embedded photos, confirm a cropped image appears on cards that received a bbox, and that cards without bbox render normally.

- [ ] **Step 5: Commit**
```bash
git add public/report.html
git commit -m "feat(vision): render cropped defect photo on report cards"
```

---

## Task 12: Verification — unit gate + E2E

**Files:** none (verification only)

- [ ] **Step 1: Unit gate**

Run: `node tests/sprint8-vision.js`
Expected: all PASS (`N/N PASS`), exit 0.

- [ ] **Step 2: Regression E2E (text-only PDF)**

Start `bun server.js`. Upload the digital test PDF. Confirm:
- defects count unchanged vs. baseline (text path intact)
- `analysisLog` shows `[Vision] 0 visual pages — skipped (0 quota)` (no vision call when no images)
- latency comparable to before

- [ ] **Step 3: OCR E2E (scanned PDF)**

Upload a scanned PDF (no text layer). Confirm defects are now extracted (baseline was 0) and `analysisLog` shows `[Vision] upload ok` + `[Vision] N ליקויים`.

- [ ] **Step 4: Vision E2E (PDF with photos)**

Upload a PDF with embedded defect photos. Confirm at least one card shows a cropped photo and `visionMeta.photosLinked > 0`.

- [ ] **Step 5: Quota check**

Confirm a pure-text PDF triggers zero Gemini vision calls (grep `analysisLog` for absence of `[Vision] upload ok`).

- [ ] **Step 6: Final commit (if any cleanup)**
```bash
git add -A
git commit -m "test(vision): verify multimodal pipeline E2E"
```

---

## Self-Review Notes

- **Spec coverage:** OCR (Tasks 4-7), photo detection + bbox (Tasks 1,5), attach photo to card (Task 11), merge+enrich (Task 3), hybrid trigger (Task 6 short-circuit), config tier switch (Task 1 `VISION.model`), graceful degradation (Task 6), maxVisualPages cap (Task 6), proactive file delete (Task 6), Vercel unification (Task 9), client pageMeta+base64 (Task 10), esc on vision fields (Task 11), tests (Task 1-3,6,12). All spec sections mapped.
- **Cache caveat handled:** Task 7 Step 4 note adds a vision marker to the cache key so cached text-only results don't suppress vision.
- **Backward compatibility:** `pipeline` keeps the 3-arg call working (Task 7 Step 1 arg-shift guard); the only internal caller is updated in Task 8.
- **No Groq key:** documented risk; text path uses `flash-lite`, vision uses `flash` (separate quotas) to mitigate.
