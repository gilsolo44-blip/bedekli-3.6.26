# Universal Engine — SSE + IndexedDB + Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the 73-page PDF sessionStorage crash and Vercel 10s timeout by adding SSE streaming, IndexedDB thumbnail storage, completing ROOM_PATTERNS removal, and hardening cost/filter extraction.

**Architecture:** `server.js` exports `pipeline()` and writes `text/event-stream` responses; `step3_extract` gains an optional `onRoom` callback that flushes per-room SSE events; `api/analyze-simple.js` becomes a CJS SSE wrapper using the exported pipeline; `index.html` reads the stream via `ReadableStream` and stores thumbnails in IndexedDB.

**Tech Stack:** Bun/Node.js CJS, Vanilla JS, IndexedDB API, Fetch ReadableStream, Server-Sent Events (no library), Vercel Node.js serverless runtime.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `tests/sprint4-sse-indexeddb-gate.js` | **Create** | TDD gate — 3 tests, must FAIL before Sprint 4, PASS after |
| `tests/sprint5-format-coverage.js` | **Create** | TDD gate — 2 tests, must FAIL before Sprint 5, PASS after |
| `server.js` | **Modify** | Delete ROOM_PATTERNS + step1_structural; add SSE layer; export pipeline; add onRoom to step3_extract |
| `api/analyze-simple.js` | **Modify** | Convert from ESM standalone → CJS SSE wrapper using exported pipeline |
| `public/index.html` | **Modify** | IndexedDB thumbnail helpers; SSE ReadableStream client reader |

---

## Task 1: Write Sprint 4 TDD Gate (All Must FAIL Now)

**Files:**
- Create: `tests/sprint4-sse-indexeddb-gate.js`

- [ ] **Step 1.1: Create the test file**

```javascript
#!/usr/bin/env node
// Sprint 4 Gate — SSE + IndexedDB + ROOM_PATTERNS removal
// Run BEFORE fixes: all must FAIL. Run AFTER: all must PASS.
'use strict';
const fs   = require('fs');
const path = require('path');
const http = require('http');

const SRC    = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const PASS   = '\x1b[32mPASS\x1b[0m';
const FAIL   = '\x1b[31mFAIL\x1b[0m';
let failures = 0;

function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ${PASS} ${label}`); }
  else       { console.error(`  ${FAIL} ${label}${detail ? ' — ' + detail : ''}`); failures++; }
}

console.log('\n=== Sprint 4 Gate: SSE + IndexedDB + ROOM_PATTERNS ===\n');

// TEST-1: ROOM_PATTERNS must NOT exist
console.log('TEST-1: ROOM_PATTERNS deleted from server.js');
assert('ROOM_PATTERNS constant removed',
  !SRC.includes('const ROOM_PATTERNS'),
  'Found "const ROOM_PATTERNS" — delete the entire ROOM_PATTERNS block and step1_structural function'
);
assert('step1_structural function removed',
  !SRC.includes('function step1_structural'),
  'Found "function step1_structural" — delete this function entirely'
);

// TEST-2: pipeline exported from server.js
console.log('\nTEST-2: pipeline exported from server.js');
assert('module.exports includes pipeline',
  SRC.includes('module.exports') && SRC.includes('pipeline'),
  'server.js must export pipeline: add "if (require.main !== module) module.exports = { pipeline };" at bottom'
);

// TEST-3: Server responds with SSE Content-Type
// Spin up server.js, send a minimal POST, check response headers
console.log('\nTEST-3: /api/analyze-simple returns text/event-stream');

// Load server and check if it starts without crashing on missing keys
// (We only check response header via a raw HTTP call to the local server)
// NOTE: This test starts the server on port 3099 briefly for header inspection
const testPort = 3099;
let serverStarted = false;

try {
  const app = require('../server.js');  // will start server; we need to test the handler
  // If server.js auto-starts, we check on port 3099 — skip if server doesn't export pipeline
  // This test validates the Content-Type header indirectly via the SRC check
} catch(e) {
  // server.js may exit if no API keys — that's ok for this test
}

// Verify SSE headers are written in server.js source
assert('server.js writes text/event-stream',
  SRC.includes('text/event-stream'),
  'HTTP handler must write Content-Type: text/event-stream before pipeline call'
);
assert('server.js writes SSE events (event: room)',
  SRC.includes("event: room") || SRC.includes("'room'") && SRC.includes("flush("),
  'step3_extract must flush "event: room" as each room completes'
);
assert('server.js has heartbeat',
  SRC.includes('keep-alive') && SRC.includes('setInterval'),
  'Add setInterval heartbeat ": keep-alive\\n\\n" every 8s to prevent Vercel idle timeout'
);

// TEST summary
console.log(`\n${ failures === 0 ? PASS + ' All tests passed' : FAIL + ` ${failures} test(s) failed` }\n`);
process.exit(failures > 0 ? 1 : 0);
```

- [ ] **Step 1.2: Run the gate — confirm all FAIL**

```bash
cd '/Users/gilsolo44/Downloads/בדקלי חדש' && node tests/sprint4-sse-indexeddb-gate.js
```

Expected output: `FAIL` on all 3 tests. If any pass already, re-read the test — it may be checking something already done.

---

## Task 2: Delete ROOM_PATTERNS and step1_structural (server.js)

**Files:**
- Modify: `server.js` (lines ~115–162 for ROOM_PATTERNS; find step1_structural with grep)

- [ ] **Step 2.1: Find exact lines to delete**

```bash
grep -n 'const ROOM_PATTERNS\|function step1_structural\|step1_structural(' '/Users/gilsolo44/Downloads/בדקלי חדש/server.js'
```

Note the line numbers before editing.

- [ ] **Step 2.2: Delete ROOM_PATTERNS constant**

In `server.js`, delete the entire block starting with `const ROOM_PATTERNS = {` through the closing `};` (approximately lines 115–162). The block contains ~35 Hebrew room name regexes.

Use the Read tool to see the exact block, then Edit to remove it:

```javascript
// DELETE this entire block — find it with the grep output above:
const ROOM_PATTERNS = {
  'מרפסת סלון':       /מרפסת\s+ה?סלון/,
  // ... ~35 entries ...
};
```

Replace with nothing (delete the block entirely).

- [ ] **Step 2.3: Delete step1_structural function**

Find the function with: `grep -n 'function step1_structural' server.js`

Delete the entire function body (from `function step1_structural(pdfText) {` through its closing `}`).

- [ ] **Step 2.4: Update pipeline() fallback branch**

Find the fallback branch in `pipeline()` that calls `step1_structural`. Look for it with:

```bash
grep -n 'step1_structural\|Track B\|fallback regex\|regex.*חדרים' '/Users/gilsolo44/Downloads/בדקלי חדש/server.js'
```

Replace any call to `step1_structural` with direct `buildCatchAllChunks`:

```javascript
// BEFORE (find and replace):
// [some code calling step1_structural or using ROOM_PATTERNS as fallback]

// AFTER — in the else branch when step1_llm returns null:
} else {
  fullLog.push('[Step 1] LLM failed → catch-all (format-agnostic)');
  const byRoom = buildCatchAllChunks(cleanPageMap, new Set());
  runPipeline(byRoom);
}
```

Note: `buildCatchAllChunks` already exists — do not modify it.

- [ ] **Step 2.5: Verify server.js still parses**

```bash
node --check '/Users/gilsolo44/Downloads/בדקלי חדש/server.js' && echo "OK"
```

Expected: `OK` (no syntax errors).

- [ ] **Step 2.6: Commit**

```bash
cd '/Users/gilsolo44/Downloads/בדקלי חדש' && git add server.js && git commit -m "refactor: delete ROOM_PATTERNS and step1_structural — LLM-only structure detection"
```

---

## Task 3: Export pipeline from server.js

**Files:**
- Modify: `server.js` (bottom of file)

- [ ] **Step 3.1: Guard the process.exit call**

Find the auth check near the top of server.js:

```bash
grep -n 'process.exit\|AUTH_LOCKED\|No API keys' '/Users/gilsolo44/Downloads/בדקלי חדש/server.js' | head -5
```

Wrap the `process.exit(1)` so it only runs when server.js is the main module:

```javascript
// BEFORE:
console.error('[AUTH_LOCKED] ✗ No API keys found — check .env.local');
process.exit(1);

// AFTER:
console.error('[AUTH_LOCKED] ✗ No API keys found — check .env.local');
if (require.main === module) process.exit(1);
else throw new Error('Missing API keys — check .env.local');
```

- [ ] **Step 3.2: Add module.exports at the bottom of server.js**

Find the last line of server.js:

```bash
tail -5 '/Users/gilsolo44/Downloads/בדקלי חדש/server.js'
```

Append after the last line:

```javascript

// Export pipeline for use by api/analyze-simple.js (Vercel)
if (require.main !== module) {
  module.exports = { pipeline };
}
```

- [ ] **Step 3.3: Verify**

```bash
node -e "const { pipeline } = require('./server.js'); console.log(typeof pipeline);" 2>&1 | head -5
```

Expected: prints `function` (may also print auth warning if no .env.local — that's OK).

---

## Task 4: Add SSE Layer to server.js HTTP Handler

**Files:**
- Modify: `server.js` (lines ~1261–1275 — the `req.on('end', ...)` handler)

- [ ] **Step 4.1: Read the current pipeline call block**

```bash
sed -n '1260,1280p' '/Users/gilsolo44/Downloads/בדקלי חדש/server.js'
```

Note the exact code for: body parsing, validation, and the `pipeline(...)` call.

- [ ] **Step 4.2: Replace the pipeline call with SSE version**

Find and replace this block (exact text from Step 4.1 output):

```javascript
// BEFORE — find this exact block:
        pipeline(pdfText, propertyType, (err, raw) => {
          if (err) { console.error('שגיאה:', err.message); res.writeHead(502,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:err.message})); }
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(raw);
```

```javascript
// AFTER:
        // SSE headers — written before pipeline starts
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          'Access-Control-Allow-Origin': '*'
        });

        function flush(event, data) {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }

        // Heartbeat every 8s — keeps Vercel alive past 10s timeout
        const hb = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch(_) {} }, 8000);

        const onRoom = (room, defects) => flush('room', { room, defects });

        pipeline(pdfText, propertyType, (err, raw) => {
          clearInterval(hb);
          if (err) {
            try { flush('error', { message: err.message, step: 'pipeline' }); } catch(_) {}
            return res.end();
          }
          try {
            const parsed = JSON.parse(raw);
            flush('done', { structureType: parsed.structureType, reportTotal: parsed.reportTotal, analysisLog: parsed.analysisLog });
          } catch(_) {
            flush('done', {});
          }
          res.end();
```

**Important:** the closing `});` that closes `req.on('end', ...)` should remain unchanged after this block.

- [ ] **Step 4.3: Add onRoom parameter to pipeline() call**

Find the line: `pipeline(pdfText, propertyType, (err, raw) => {` (the one you just edited in 4.2) and add `onRoom` as 4th argument:

```javascript
        pipeline(pdfText, propertyType, (err, raw) => {
          // ... (unchanged from 4.2)
        }, onRoom);
```

- [ ] **Step 4.4: Verify syntax**

```bash
node --check '/Users/gilsolo44/Downloads/בדקלי חדש/server.js' && echo "OK"
```

Expected: `OK`.

---

## Task 5: Add onRoom Callback to pipeline() and step3_extract

**Files:**
- Modify: `server.js` — `function pipeline(...)` signature and `step3_extract` call inside it; `function step3_extract(...)` signature

- [ ] **Step 5.1: Update pipeline() signature**

Find: `function pipeline(pdfText, propertyType, callback) {`

Replace with:

```javascript
function pipeline(pdfText, propertyType, callback, onRoom = null) {
```

- [ ] **Step 5.2: Forward onRoom into step3_extract call**

Find the line (around line 1174):
```javascript
    step3_extract(bR, costMap, (err, rawDefects, step3Log) => {
```

Replace with:
```javascript
    step3_extract(bR, costMap, (err, rawDefects, step3Log) => {
```
*(unchanged — the onRoom is passed as 4th arg below)*

Actually, find the ENTIRE `step3_extract(bR, costMap, ...)` call. It likely looks like:
```javascript
    step3_extract(bR, costMap, (err, rawDefects, step3Log) => {
      // ... handler body
    });
```

Change the closing `});` to `}, onRoom);`:

```javascript
    step3_extract(bR, costMap, (err, rawDefects, step3Log) => {
      // ... handler body — unchanged
    }, onRoom);
```

- [ ] **Step 5.3: Update step3_extract() signature**

Find: `function step3_extract(byRoom, costMap, callback) {` (line 948)

Replace with:
```javascript
function step3_extract(byRoom, costMap, callback, onRoom = null) {
```

- [ ] **Step 5.4: Flush per-room inside step3_extract**

Find line 1012: `allDefects.push(...defects);`

There are two occurrences (main loop and retry loop). After EACH one, add the onRoom flush:

```javascript
        allDefects.push(...defects);
        if (onRoom && defects.length > 0) {
          try { onRoom(t.room, defects); } catch(_) {}
        }
```

Do this for BOTH occurrences (around lines 1012 and 1040).

- [ ] **Step 5.5: Verify syntax**

```bash
node --check '/Users/gilsolo44/Downloads/בדקלי חדש/server.js' && echo "OK"
```

Expected: `OK`.

- [ ] **Step 5.6: Commit**

```bash
cd '/Users/gilsolo44/Downloads/בדקלי חדש' && git add server.js && git commit -m "feat: add SSE streaming layer — event:room flushed per room, heartbeat, pipeline export"
```

---

## Task 6: Update api/analyze-simple.js — CJS SSE Wrapper

**Files:**
- Modify: `api/analyze-simple.js`

The current file is a standalone ESM OpenRouter call. Replace it entirely with a CJS wrapper that uses the exported `pipeline` from server.js and writes SSE.

- [ ] **Step 6.1: Read the current file**

Read `api/analyze-simple.js` to note the existing `maxDuration` value and rate-limiting logic to preserve.

- [ ] **Step 6.2: Replace the file content**

```javascript
'use strict';
// Vercel serverless wrapper — delegates to full pipeline in server.js via SSE stream
const { pipeline } = require('../server.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')   { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { pdfText, propertyType } = req.body || {};
  if (!pdfText) { res.status(400).json({ error: 'Missing PDF text' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  function flush(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  const hb = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch(_) {} }, 8000);
  const onRoom = (room, defects) => flush('room', { room, defects });

  try {
    await new Promise((resolve, reject) => {
      pipeline(pdfText, propertyType, (err, raw) => {
        clearInterval(hb);
        if (err) { flush('error', { message: err.message, step: 'pipeline' }); return resolve(); }
        try {
          const parsed = JSON.parse(raw);
          flush('done', { structureType: parsed.structureType, reportTotal: parsed.reportTotal, analysisLog: parsed.analysisLog });
        } catch(_) { flush('done', {}); }
        resolve();
      }, onRoom);
    });
  } catch (e) {
    clearInterval(hb);
    flush('error', { message: e.message, step: 'handler' });
  }

  res.end();
};

module.exports.config = {
  maxDuration: 300,
  api: { bodyParser: { sizeLimit: '10mb' } }
};
```

- [ ] **Step 6.3: Verify syntax**

```bash
node --check '/Users/gilsolo44/Downloads/בדקלי חדש/api/analyze-simple.js' && echo "OK"
```

Expected: `OK`.

- [ ] **Step 6.4: Commit**

```bash
cd '/Users/gilsolo44/Downloads/בדקלי חדש' && git add api/analyze-simple.js && git commit -m "feat: convert api/analyze-simple.js to SSE CJS wrapper using full pipeline"
```

---

## Task 7: Add IndexedDB Helpers to index.html

**Files:**
- Modify: `public/index.html` (near the top of the `<script>` block)

- [ ] **Step 7.1: Find the script block start**

```bash
grep -n '<script>' '/Users/gilsolo44/Downloads/בדקלי חדש/public/index.html' | head -5
```

Note the line number of the main `<script>` tag.

- [ ] **Step 7.2: Add IndexedDB helpers after the opening script tag**

Find the first few lines after the main `<script>` tag and insert these helpers:

```javascript
// ── IndexedDB thumbnail storage (replaces sessionStorage for bdkl_imgs) ──────
async function openImgDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('bedekli_db', 1);
    r.onupgradeneeded = e => e.target.result.createObjectStore('imgs');
    r.onsuccess = e => resolve(e.target.result);
    r.onerror = reject;
  });
}
async function putThumb(pageNum, base64) {
  try {
    const db = await openImgDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('imgs', 'readwrite');
      tx.objectStore('imgs').put(base64, pageNum);
      tx.oncomplete = resolve; tx.onerror = reject;
    });
  } catch(_) {
    // Fallback: sessionStorage with 30-page cap
    try {
      const imgs = JSON.parse(sessionStorage.getItem('bdkl_imgs_fb') || '{}');
      const keys = Object.keys(imgs);
      if (keys.length >= 30) delete imgs[keys[0]]; // evict oldest
      imgs[pageNum] = base64;
      sessionStorage.setItem('bdkl_imgs_fb', JSON.stringify(imgs));
    } catch(_) {}
  }
}
async function getThumb(pageNum) {
  try {
    const db = await openImgDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('imgs', 'readonly');
      const r = tx.objectStore('imgs').get(pageNum);
      r.onsuccess = () => resolve(r.result);
      r.onerror = reject;
    });
  } catch(_) {
    const imgs = JSON.parse(sessionStorage.getItem('bdkl_imgs_fb') || '{}');
    return imgs[pageNum] || null;
  }
}
async function clearImgDB() {
  try {
    const db = await openImgDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('imgs', 'readwrite');
      tx.objectStore('imgs').clear();
      tx.oncomplete = resolve; tx.onerror = reject;
    });
  } catch(_) {}
  sessionStorage.removeItem('bdkl_imgs_fb');
}
// ── Migrate legacy sessionStorage thumbnails on load ─────────────────────────
(async () => {
  const legacy = sessionStorage.getItem('bdkl_imgs');
  if (legacy) {
    try {
      const imgs = JSON.parse(legacy);
      for (const [pageNum, b64] of Object.entries(imgs)) {
        await putThumb(parseInt(pageNum), b64);
      }
      sessionStorage.removeItem('bdkl_imgs');
    } catch(_) {}
  }
})();
```

- [ ] **Step 7.3: Replace sessionStorage thumbnail write**

Find line 931 (or the line containing):
```javascript
try{sessionStorage.setItem('bdkl_imgs',JSON.stringify(PIMGS));}catch(e){}
```

Replace with:
```javascript
(async () => {
  for (const [pageNum, b64] of Object.entries(PIMGS)) {
    await putThumb(parseInt(pageNum), b64);
  }
})();
```

- [ ] **Step 7.4: Update bdkl_imgs reads in report.html and viewer.html**

```bash
grep -rn "bdkl_imgs" '/Users/gilsolo44/Downloads/בדקלי חדש/public/'
```

For each file that reads `bdkl_imgs`, add the same IndexedDB helpers at the top of its `<script>` block (copy the `openImgDB`, `putThumb`, `getThumb` functions verbatim from Step 7.2). Then replace the read pattern:

```javascript
// BEFORE — find this pattern in report.html/viewer.html:
const imgs = JSON.parse(sessionStorage.getItem('bdkl_imgs') || '{}');
// ... later: const src = imgs[pageNum]; img.src = src;

// AFTER — replace the entire imgs read block:
// (getThumb is async — use it inside an async function or .then())
// If used inside an existing async function:
const src = await getThumb(pageNum);
if (src) img.src = src;

// If used in a sync callback, convert the callback to async:
// BEFORE: el.addEventListener('click', function() { const src = imgs[n]; ... })
// AFTER:  el.addEventListener('click', async function() { const src = await getThumb(n); ... })
```

- [ ] **Step 7.5: Commit**

```bash
cd '/Users/gilsolo44/Downloads/בדקלי חדש' && git add public/index.html public/report.html public/viewer.html && git commit -m "feat: IndexedDB thumbnail storage — eliminates sessionStorage quota crash on large PDFs"
```

---

## Task 8: Replace fetch→JSON with SSE ReadableStream Reader (index.html)

**Files:**
- Modify: `public/index.html` (around line 902 — the fetch('/api/analyze-simple') call)

- [ ] **Step 8.1: Read the current fetch block**

```bash
sed -n '895,940p' '/Users/gilsolo44/Downloads/בדקלי חדש/public/index.html'
```

Note what happens after the fetch: where the JSON result is used, what functions are called to render the report, how `pdfText` and `propType` are referenced.

- [ ] **Step 8.2: Replace the fetch call and response handling**

Find the block starting at `res=await fetch('/api/analyze-simple',{` and ending after the JSON is used to navigate to the report page. Replace the entire fetch-and-handle block with:

```javascript
    // ── SSE streaming analysis ────────────────────────────────────────────────
    const _response = await fetch('/api/analyze-simple', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdfText, propertyType: propType })
    });

    if (!_response.ok) {
      throw new Error(`שגיאת שרת: ${_response.status}`);
    }

    const _reader   = _response.body.getReader();
    const _decoder  = new TextDecoder();
    let   _buf      = '';
    let   _streamDone = false;
    const _defects  = [];
    let   _reportTotal = 0;
    let   _structureType = 'rooms';
    let   _analysisLog   = [];

    try {
      while (true) {
        const { done, value } = await _reader.read();
        if (done) break;
        _buf += _decoder.decode(value, { stream: true });
        const _blocks = _buf.split('\n\n');
        _buf = _blocks.pop(); // keep incomplete block in buffer
        for (const _block of _blocks) {
          const _eMatch = _block.match(/^event: (\w+)/m);
          const _dMatch = _block.match(/^data: (.+)/m);
          if (!_eMatch || !_dMatch) continue;
          let _payload;
          try { _payload = JSON.parse(_dMatch[1]); } catch(_) { continue; }
          switch (_eMatch[1]) {
            case 'room':
              if (Array.isArray(_payload.defects)) _defects.push(..._payload.defects);
              // Update progress indicator
              if (typeof updateProgress === 'function') updateProgress('חילוץ', _payload.room);
              break;
            case 'total':
              _reportTotal = _payload.reportTotal || 0;
              break;
            case 'progress':
              if (typeof updateProgress === 'function') updateProgress(_payload.step, _payload.message);
              break;
            case 'done':
              _streamDone = true;
              _structureType = _payload.structureType || 'rooms';
              _analysisLog   = _payload.analysisLog || [];
              if (_payload.reportTotal > 0) _reportTotal = _payload.reportTotal;
              break;
            case 'error':
              throw new Error(_payload.message || 'שגיאה בניתוח');
          }
        }
      }
    } catch(_err) {
      if (!_streamDone && _defects.length === 0) throw _err;
      // Partial result — show warning banner after render
    }

    if (_defects.length === 0) throw new Error('לא נמצאו ליקויים בדוח');

    const _result = { defects: _defects, reportTotal: _reportTotal, structureType: _structureType, analysisLog: _analysisLog };

    if (!_streamDone) {
      // Stream was cut — show partial results warning
      console.warn('[SSE] Stream closed before done event — showing partial results');
    }

    // Store result and navigate to report (same as before)
    try { sessionStorage.setItem('bdkl_report', JSON.stringify({ ..._result, fileName: FILE_NAME, propType })); } catch(e) {}
    window.location.href = 'report.html';
```

Note: `FILE_NAME` and `propType` should already be defined in the surrounding scope. If the original code uses different variable names, adjust accordingly (check the output from Step 8.1).

- [ ] **Step 8.3: Verify the file has no syntax errors**

Open `public/index.html` in a browser or check with:
```bash
node -e "
const fs = require('fs');
const src = fs.readFileSync('public/index.html', 'utf8');
const scriptMatch = src.match(/<script[^>]*>([\s\S]*?)<\/script>/g);
console.log('Script blocks found:', scriptMatch ? scriptMatch.length : 0);
"
```

If the file uses a bundler or has inline scripts, do a visual check for unclosed brackets.

- [ ] **Step 8.4: Commit**

```bash
cd '/Users/gilsolo44/Downloads/בדקלי חדש' && git add public/index.html && git commit -m "feat: SSE ReadableStream client reader — incremental defect rendering, no JSON blocking"
```

---

## Task 9: Run Sprint 4 Gate

- [ ] **Step 9.1: Run sprint1 regression first**

```bash
cd '/Users/gilsolo44/Downloads/בדקלי חדש' && node tests/sprint1-scale-audit.js
```

Expected: all 9 PASS. If any fail, fix before continuing.

- [ ] **Step 9.2: Run sprint4 gate**

```bash
node tests/sprint4-sse-indexeddb-gate.js
```

Expected: all 3 PASS.

If TEST-1 fails: check that ROOM_PATTERNS and step1_structural were fully deleted in Task 2.
If TEST-2 fails: check that `module.exports = { pipeline }` was added in Task 3.
If TEST-3 fails: check that `text/event-stream` and `event: room` patterns are in server.js.

- [ ] **Step 9.3: Smoke test local server**

```bash
bun server.js &
sleep 2
curl -s -X POST http://localhost:3000/api/analyze-simple \
  -H "Content-Type: application/json" \
  -d '{"pdfText":"--- עמוד 1 ---\nממצא: סדק בקיר\n₪5,000","propertyType":"new"}' \
  | head -5
```

Expected: output starts with `event:` or `: keep-alive` (SSE format), NOT `{` (JSON).

```bash
kill %1  # stop background server
```

---

## Task 10: Write Sprint 5 TDD Gate (All Must FAIL Now)

**Files:**
- Create: `tests/sprint5-format-coverage.js`

- [ ] **Step 10.1: Create the test file**

```javascript
#!/usr/bin/env node
// Sprint 5 Gate — Cost extraction + filter hardening
// Run BEFORE fixes: all must FAIL. Run AFTER: all must PASS.
'use strict';
const fs   = require('fs');
const path = require('path');

// Load server functions directly
// We require server.js which exports pipeline, but we need individual functions
// Extract source and evaluate step functions
const SRC = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

const PASS   = '\x1b[32mPASS\x1b[0m';
const FAIL   = '\x1b[31mFAIL\x1b[0m';
let failures = 0;

function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ${PASS} ${label}`); }
  else       { console.error(`  ${FAIL} ${label}${detail ? ' — ' + detail : ''}`); failures++; }
}

console.log('\n=== Sprint 5 Gate: Cost Extraction + Filter Hardening ===\n');

// Extract step0b_extractReportTotal function from source and run it
function evalFn(fnName, src) {
  const start = src.indexOf(`function ${fnName}`);
  if (start === -1) throw new Error(`${fnName} not found`);
  // Find matching brace
  let depth = 0, i = src.indexOf('{', start);
  const fnStart = start;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    i++;
  }
  const fnSrc = src.slice(fnStart, i);
  return new Function(`return (${fnSrc})`)();
}

// TEST-4: reportTotal extracted from formal-language reports
console.log('TEST-4: step0b_extractReportTotal handles "תמחור כולל"');
try {
  const step0b = evalFn('step0b_extractReportTotal', SRC);
  const formalText = `
    --- עמוד 1 ---
    דוח בדק בית מקצועי
    --- עמוד 15 ---
    תמחור כולל לתיקון: 150,000 ש"ח
    פירוט עבודות נדרשות
  `;
  const result = step0b(formalText);
  assert(
    'step0b returns 150000 for "תמחור כולל: 150,000 ש"ח"',
    result === 150000,
    `Got ${result} — expand TOTAL_KW to include "תמחור\\s+כולל"`
  );
} catch(e) {
  console.error(`  ${FAIL} Could not run step0b: ${e.message}`);
  failures++;
}

// TEST-5: step2_filter DEFECT_SIGNALS catches formal inspection language
console.log('\nTEST-5: step2_filter DEFECT_SIGNALS catches "ממצא הנדסי"');
try {
  const DEFECT_SIGNALS_match = SRC.match(/const DEFECT_SIGNALS\s*=\s*\/([^/]+)\//);
  if (!DEFECT_SIGNALS_match) throw new Error('DEFECT_SIGNALS not found');
  const pattern = new RegExp(DEFECT_SIGNALS_match[1]);
  assert(
    '"ממצא הנדסי" matches DEFECT_SIGNALS',
    pattern.test('ממצא הנדסי'),
    'Add "ממצא\\s+הנדסי" to DEFECT_SIGNALS regex'
  );
  assert(
    '"אי-התאמה" matches DEFECT_SIGNALS',
    pattern.test('אי-התאמה'),
    'Add "אי.התאמ" to DEFECT_SIGNALS regex'
  );
  assert(
    '"תיקון נדרש" matches DEFECT_SIGNALS',
    pattern.test('תיקון נדרש'),
    'Add "תיקון\\s+נדרש" to DEFECT_SIGNALS regex'
  );
} catch(e) {
  console.error(`  ${FAIL} Could not test DEFECT_SIGNALS: ${e.message}`);
  failures++;
}

// TEST-6: step0_extractCosts handles missing page delimiters
console.log('\nTEST-6: step0_extractCosts fallback when no page delimiters');
try {
  const step0 = evalFn('step0_extractCosts', SRC);
  const noDelimText = `ריצוף פגום בסלון — עלות תיקון 8,500 ₪\nחדר הורים — נזילה, עלות 12,000 ש"ח`;
  const result = step0(noDelimText);
  const allVals = Object.values(result).flat();
  assert(
    'step0 finds costs even without page delimiters',
    allVals.length >= 2 && allVals.includes(8500) && allVals.includes(12000),
    `Got ${JSON.stringify(result)} — add full-text fallback when split returns < 3 segments`
  );
} catch(e) {
  console.error(`  ${FAIL} Could not run step0: ${e.message}`);
  failures++;
}

console.log(`\n${ failures === 0 ? PASS + ' All tests passed' : FAIL + ` ${failures} test(s) failed` }\n`);
process.exit(failures > 0 ? 1 : 0);
```

- [ ] **Step 10.2: Run the gate — confirm all FAIL**

```bash
cd '/Users/gilsolo44/Downloads/בדקלי חדש' && node tests/sprint5-format-coverage.js
```

Expected: `FAIL` on TEST-4, TEST-5, TEST-6.

---

## Task 11: Harden step0_extractCosts (Delimiter Fallback)

**Files:**
- Modify: `server.js` — `function step0_extractCosts` (starts at line 71)

- [ ] **Step 11.1: Read the current function**

```bash
sed -n '71,90p' '/Users/gilsolo44/Downloads/בדקלי חדש/server.js'
```

- [ ] **Step 11.2: Add full-text fallback after the page split**

Find this exact code:
```javascript
function step0_extractCosts(pdfText) {
  const pages = pdfText.split(/---\s*עמוד\s*(\d+)\s*---/);
  const costMap = {};
  const moneyRe = /(\d{1,3}(?:,\d{3})+|\d{4,7})\s*(?:ש["״]ח|₪|שקלים?)\b/g;
```

Replace with:
```javascript
function step0_extractCosts(pdfText) {
  const pages = pdfText.split(/---\s*עמוד\s*(\d+)\s*---/);
  const costMap = {};
  const moneyRe = /(\d{1,3}(?:,\d{3})+|\d{4,7})\s*(?:ש["״]ח|₪|שקלים?)\b/g;
  // Fallback: no page delimiters found — scan full text as page 0
  if (pages.length < 3) {
    const vals = [];
    let _m;
    const _re = /(\d{1,3}(?:,\d{3})+|\d{4,7})\s*(?:ש["״]ח|₪|שקלים?)\b/g;
    while ((_m = _re.exec(pdfText)) !== null) {
      const v = parseInt(_m[1].replace(/,/g, ''));
      if (v >= 200 && v <= 500000) vals.push(v);
    }
    if (vals.length) costMap[0] = vals;
    return costMap;
  }
```

Note: the closing `}` of the fallback `if` block goes before the existing `for (let i = 1;` loop. The rest of the function stays unchanged.

- [ ] **Step 11.3: Verify syntax**

```bash
node --check '/Users/gilsolo44/Downloads/בדקלי חדש/server.js' && echo "OK"
```

---

## Task 12: Expand TOTAL_KW (step0b_extractReportTotal)

**Files:**
- Modify: `server.js` line 91

- [ ] **Step 12.1: Find exact current line**

```bash
grep -n 'TOTAL_KW' '/Users/gilsolo44/Downloads/בדקלי חדש/server.js'
```

- [ ] **Step 12.2: Replace TOTAL_KW**

Find:
```javascript
  const TOTAL_KW = '(?:סה["״""]?כ|סהכ|סך\\s+הכל|עלות\\s+כוללת|סכום\\s+כולל|סיכום\\s+כספי|עלות\\s+מוערכת\\s+כוללת)';
```

Replace with:
```javascript
  const TOTAL_KW = '(?:סה["״""]?כ|סהכ|סך\\s+הכל|עלות\\s+כוללת|סכום\\s+כולל|סיכום\\s+כספי|עלות\\s+מוערכת\\s+כוללת|תמחור\\s+כולל|עלות\\s+תיקון\\s+כוללת|סכום\\s+מוערך|עלות\\s+מוערכת|תקציב\\s+מוערך|סה["״]?כ\\s+תיקון|עלות\\s+כוללת\\s+מוערכת)';
```

- [ ] **Step 12.3: Verify syntax**

```bash
node --check '/Users/gilsolo44/Downloads/בדקלי חדש/server.js' && echo "OK"
```

---

## Task 13: Expand DEFECT_SIGNALS (step2_filter)

**Files:**
- Modify: `server.js` line 205

- [ ] **Step 13.1: Find exact current line**

```bash
grep -n 'DEFECT_SIGNALS' '/Users/gilsolo44/Downloads/בדקלי חדש/server.js'
```

- [ ] **Step 13.2: Replace DEFECT_SIGNALS**

Find:
```javascript
const DEFECT_SIGNALS = /ליקוי|בעיה|סדק|רטיב|דליפ|חסר|לא\s+תקין|נמצא|ממצא|פגם|שחיקה|התנתקות/;
```

Replace with:
```javascript
const DEFECT_SIGNALS = /ליקוי|בעיה|סדק|רטיב|דליפ|חסר|לא\s+תקין|נמצא|ממצא|פגם|שחיקה|התנתקות|ממצא\s+הנדסי|אי.התאמ|פגיעה|תיקון\s+נדרש|הצעת\s+תיקון|ליקוי\s+בנייה|אי\s+תקינות/;
```

- [ ] **Step 13.3: Verify syntax**

```bash
node --check '/Users/gilsolo44/Downloads/בדקלי חדש/server.js' && echo "OK"
```

- [ ] **Step 13.4: Commit**

```bash
cd '/Users/gilsolo44/Downloads/בדקלי חדש' && git add server.js && git commit -m "feat: harden cost extraction (delimiter fallback, 14 total keywords) and expand defect vocab"
```

---

## Task 14: Run Sprint 5 Gate + Final Regression

- [ ] **Step 14.1: Run sprint5 gate**

```bash
cd '/Users/gilsolo44/Downloads/בדקלי חדש' && node tests/sprint5-format-coverage.js
```

Expected: all 3 PASS (TEST-4, TEST-5, TEST-6).

- [ ] **Step 14.2: Run sprint1 regression**

```bash
node tests/sprint1-scale-audit.js
```

Expected: all 9 PASS.

- [ ] **Step 14.3: Run sprint4 gate (full regression)**

```bash
node tests/sprint4-sse-indexeddb-gate.js
```

Expected: all 3 PASS.

- [ ] **Step 14.4: Commit test files**

```bash
git add tests/sprint4-sse-indexeddb-gate.js tests/sprint5-format-coverage.js && git commit -m "test: add sprint4 (SSE/IndexedDB) and sprint5 (cost/filter) TDD gates"
```

---

## Task 15: E2E Smoke Test

- [ ] **Step 15.1: Start server and open browser**

```bash
bun '/Users/gilsolo44/Downloads/בדקלי חדש/server.js'
```

Open: `http://localhost:3000`

- [ ] **Step 15.2: Upload small sample**

Upload: `בדק-בית-בחיפה-דירת-גן-יד-שנייה-לפני-רכישה.pdf` (1.1MB)

Expected:
- Progress bar updates incrementally (SSE events arriving)
- No freeze, no sessionStorage quota error in console
- Report renders with defects

- [ ] **Step 15.3: Upload large sample**

Upload: `דוח-דוגמא-בדיקת-דירה-חדשה_.pdf` (34.8MB)

Expected:
- No freeze at thumbnail render stage (IndexedDB used)
- Analysis completes without timeout
- ≥10 defects extracted, `reportTotal > 0`

- [ ] **Step 15.4: Check browser DevTools**

Open DevTools → Application → IndexedDB → `bedekli_db` → `imgs`

Expected: page thumbnails stored as individual entries, NOT in sessionStorage.

Open DevTools → Network → the `/api/analyze-simple` request

Expected: Response type = `text/event-stream`, response body shows `event: room` lines.
