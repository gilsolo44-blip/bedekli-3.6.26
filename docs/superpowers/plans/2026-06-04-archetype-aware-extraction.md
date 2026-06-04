# Archetype-Aware Extraction & Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject per-archetype reading rules into step1_llm and step3_extract, add TOC-page filtering to step2_filter, and add a new step3e_simplify that populates `simplified_explanation` on every defect.

**Architecture:** A new `lib/archetypeRules.js` loader reads `data/archetype_rules.json` (5 archetype entries with structure hints, delimiter patterns, extraction rules, few-shot slots). This rules object is injected into step1_llm's outline prefix and step3_extract's userMsg. After step4_schema, step3e_simplify batches defects (15 at a time) and fills `simplified_explanation` via LLM.

**Tech Stack:** Node.js CJS, existing `tryProviders` / `cacheGet` / `cacheSet` infrastructure, Jest for tests.

---

## File Map

| File | Action | What changes |
|------|--------|--------------|
| `data/archetype_rules.json` | **Create** | 5-archetype rules dictionary |
| `lib/archetypeRules.js` | **Create** | Lazy loader + `getArchetypeRules(archetype)` |
| `tests/archetypeRules.test.js` | **Create** | Unit tests for loader |
| `server.js:~12` | Modify | Lazy-require archetypeRules |
| `server.js:318` | Modify | `step2_filter` — skip TOC pages |
| `server.js:283` | Modify | `step1_llm` — structured archetype context |
| `server.js:~1282` | Modify | Add `SIMPLIFY_PROMPT` constant |
| `server.js:1294` | Modify | `buildStep3Tasks` / `step3_extract` — archetype userMsg |
| `server.js:628` | Modify | `step4_schema` — pass through `simplified_explanation` |
| `server.js:~1450` | Modify | Add `step3e_simplify` function |
| `server.js:~1700` | Modify | Wire `step3e_simplify` into pipeline |

---

## Task 1: Create `data/archetype_rules.json`

**Files:**
- Create: `data/archetype_rules.json`

- [ ] **Step 1: Write the file**

```json
{
  "HIERARCHICAL": {
    "description": "דוח ממוספר היררכי (1. פרק, 1.1 סעיף, 1.1.1 ליקוי)",
    "toc_skip_signals": ["תוכן עניינים", "תוכן", "עמוד......", "פרק......"],
    "structure_hint": "כל מספר ראשי (1, 2, 3) הוא חדר או אזור. כל תת-סעיף (1.1, 1.2) הוא ליקוי נפרד. עמודים שמכילים רק כותרות ממוספרות עם מספרי עמוד = תוכן עניינים, דלג עליהם.",
    "delimiter_pattern": "מספר סידורי בפורמט X.Y או X.Y.Z ואחריו רווח וטקסט",
    "cost_location": "בסוף כל סעיף ממוספר, לרוב אחרי המילה עלות או סמל ₪",
    "extraction_hints": [
      "כל שורה שמתחילה ב-X.Y = ליקוי חדש, גם אם קצרה",
      "אל תמזג שני ליקויים ממוספרים לאחד",
      "תת-סעיפים (1.1.1, 1.1.2) = ליקויים נפרדים"
    ],
    "few_shot": { "input": "", "output": [] }
  },
  "KW_PARAGRAPH": {
    "description": "דוח פסקאות חופשיות, ליקויים מופרדים במילות טריגר",
    "toc_skip_signals": ["תוכן עניינים", "רשימת נושאים"],
    "structure_hint": "חפש כותרות מודגשות לפני כל קבוצת פסקאות — הן שמות החדרים. פסקה שמתחילה במילת טריגר = ליקוי חדש.",
    "delimiter_pattern": "נמצא כי | נצפו | נדרש | קיים ליקוי | הערה | בדיקה הראתה | נבדק",
    "cost_location": "בסוגריים בסוף הפסקה, או בטבלת מחירים בסוף הדוח",
    "extraction_hints": [
      "פסקה שמתחילה במילת טריגר = ליקוי חדש",
      "פסקה ללא מילת טריגר שממשיכה רעיון = חלק מהליקוי הקודם",
      "מיקום החדר = הכותרת המודגשת האחרונה שהופיעה לפני הפסקה"
    ],
    "few_shot": { "input": "", "output": [] }
  },
  "NUMBERED_FLAT": {
    "description": "רשימה ממוספרת פשוטה — כל מספר הוא ליקוי אחד",
    "toc_skip_signals": ["תוכן עניינים"],
    "structure_hint": "כותרות בין הרשימות (ללא מספר) הן שמות החדרים. כל מספר בתחילת שורה = ליקוי חדש.",
    "delimiter_pattern": "שורה שמתחילה במספר ואחריו נקודה או סוגריים: 1. / 1) / (1)",
    "cost_location": "בסוף כל פריט ממוספר, לעיתים בשורה נפרדת אחריו",
    "extraction_hints": [
      "כל מספר בתחילת שורה = ליקוי חדש",
      "שורות ללא מספר שממשיכות פריט = חלק מאותו ליקוי"
    ],
    "few_shot": { "input": "", "output": [] }
  },
  "TABLE": {
    "description": "דוח בפורמט טבלה — כל שורה = ליקוי אחד",
    "toc_skip_signals": ["תוכן עניינים", "סיכום כספי"],
    "structure_hint": "הטבלה הראשית מכילה ליקויים. שורות כותרת (header) אינן ליקויים. העמודה הראשונה = מיקום, האחרונה = עלות.",
    "delimiter_pattern": "כל שורת טבלה שאינה כותרת — מופרדת ב-| או רווחים גדולים",
    "cost_location": "העמודה האחרונה או הלפני-אחרונה בטבלה",
    "extraction_hints": [
      "העמודה הראשונה = מיקום/חדר",
      "העמודה השנייה או השלישית = תיאור הליקוי",
      "אל תחלץ שורות כותרת (מיקום, ממצא, עלות) כליקויים"
    ],
    "few_shot": { "input": "", "output": [] }
  },
  "UNKNOWN": {
    "description": "מבנה לא מזוהה — גישה כללית",
    "toc_skip_signals": ["תוכן עניינים", "עמוד", "......"],
    "structure_hint": "חפש דפוסים חוזרים: מספרים, כותרות, מילות טריגר — כל דפוס חוזר הוא גבול ליקוי.",
    "delimiter_pattern": "כל אחד מ: מספר בתחילת שורה / מילת טריגר / שורה ריקה לפני טקסט",
    "cost_location": "חפש סמל ₪ או מילה עלות / מחיר בכל מקום בטקסט",
    "extraction_hints": [
      "עדיף לחלץ יותר מדי מאשר פחות מדי",
      "כל ישות שיש לה מיקום + תיאור = ליקוי"
    ],
    "few_shot": { "input": "", "output": [] }
  }
}
```

- [ ] **Step 2: Verify file is valid JSON**

```bash
node -e "require('./data/archetype_rules.json'); console.log('OK')"
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add data/archetype_rules.json
git commit -m "feat: add archetype_rules.json with 5-archetype reading rules"
```

---

## Task 2: Create `lib/archetypeRules.js`

**Files:**
- Create: `lib/archetypeRules.js`
- Create: `tests/archetypeRules.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/archetypeRules.test.js
'use strict';
const { getArchetypeRules } = require('../lib/archetypeRules');

test('returns HIERARCHICAL rules with expected keys', () => {
  const rules = getArchetypeRules('HIERARCHICAL');
  expect(rules).toHaveProperty('description');
  expect(rules).toHaveProperty('toc_skip_signals');
  expect(rules).toHaveProperty('structure_hint');
  expect(rules).toHaveProperty('delimiter_pattern');
  expect(rules).toHaveProperty('extraction_hints');
  expect(Array.isArray(rules.extraction_hints)).toBe(true);
  expect(rules.extraction_hints.length).toBeGreaterThan(0);
});

test('falls back to UNKNOWN for unrecognised archetype', () => {
  const rules = getArchetypeRules('NONEXISTENT');
  expect(rules).toHaveProperty('description');
  expect(rules.description).toContain('לא מזוהה');
});

test('returns object with few_shot slot', () => {
  const rules = getArchetypeRules('KW_PARAGRAPH');
  expect(rules).toHaveProperty('few_shot');
  expect(rules.few_shot).toHaveProperty('input');
  expect(rules.few_shot).toHaveProperty('output');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- --testPathPattern=archetypeRules
```
Expected: FAIL — `Cannot find module '../lib/archetypeRules'`

- [ ] **Step 3: Write the module**

```javascript
// lib/archetypeRules.js
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

function getArchetypeRules(archetype) {
  if (!_rules) {
    try {
      _rules = require(path.join(__dirname, '../data/archetype_rules.json'));
    } catch (e) {
      _rules = {};
    }
  }
  return _rules[archetype] || _rules['UNKNOWN'] || FALLBACK;
}

module.exports = { getArchetypeRules };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- --testPathPattern=archetypeRules
```
Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add lib/archetypeRules.js tests/archetypeRules.test.js
git commit -m "feat: add archetypeRules loader module with tests"
```

---

## Task 3: Upgrade `step2_filter` — TOC Page Detection

**Files:**
- Modify: `server.js:318` (`step2_filter` function)

- [ ] **Step 1: Read the current step2_filter function** (lines 318–355 — already read above)

- [ ] **Step 2: Add TOC-skip helper and integrate it**

In `server.js`, find the comment `// ── Step 2: Noise Filtration (JavaScript only) ───────────────────────────────` just above `function step2_filter(pdfText)`.

Add this helper function BEFORE `step2_filter`:

```javascript
// Returns true if a page is a table-of-contents page (titles + page numbers, no defect content)
const TOC_LINE_RE = /^.{1,50}\.{3,}\s*\d+\s*$|^.{1,50}\s{3,}\d+\s*$/;
const DEFECT_LINE_RE = /נמצא|ליקוי|בעיה|סדק|רטיב|דליפ|חסר|לא\s*תקין|ממצא|פגם|נצפ|נדרש/;

function isTocPage(pageText, extraSignals) {
  const text = pageText.trim();
  if (text.length < 20) return false;
  // Explicit TOC header
  const signals = ['תוכן עניינים', 'תוכן\nעניינים', ...(extraSignals || [])];
  if (signals.some(s => text.includes(s))) return true;
  // Heuristic: >60% of non-empty lines look like "label .... N" and no defect keywords
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 3) return false;
  const tocLines = lines.filter(l => TOC_LINE_RE.test(l.trim())).length;
  const hasDefect = DEFECT_LINE_RE.test(text);
  return (tocLines / lines.length) > 0.6 && !hasDefect;
}
```

Then inside `step2_filter`, AFTER the existing `_rebuilt` loop (after the `if (_stripped > 0) clean = _rebuilt;` line), add a second pass:

```javascript
  // TOC-page pass — remove table-of-contents pages found anywhere in the document
  {
    const _parts2 = clean.split(/---\s*עמוד\s*(\d+)\s*---/);
    let _rebuilt2 = _parts2[0];
    let _tocStripped = 0;
    for (let _i = 1; _i < _parts2.length; _i += 2) {
      const _pn  = _parts2[_i];
      const _txt = _parts2[_i + 1] || '';
      if (isTocPage(_txt)) {
        _tocStripped++;
        continue;
      }
      _rebuilt2 += `\n--- עמוד ${_pn} ---\n${_txt}`;
    }
    if (_tocStripped > 0) clean = _rebuilt2;
  }
```

- [ ] **Step 3: Write unit test for `isTocPage` in a new test file**

```javascript
// tests/step2Filter.test.js
'use strict';

// isTocPage is not exported — test via behavior of step2_filter text filtering.
// We test the regex logic directly by recreating the helper inline.
const TOC_LINE_RE = /^.{1,50}\.{3,}\s*\d+\s*$|^.{1,50}\s{3,}\d+\s*$/;
const DEFECT_LINE_RE = /נמצא|ליקוי|בעיה|סדק|רטיב|דליפ|חסר|לא\s*תקין|ממצא|פגם|נצפ|נדרש/;
function isTocPage(pageText, extraSignals) {
  const text = pageText.trim();
  if (text.length < 20) return false;
  const signals = ['תוכן עניינים', ...(extraSignals || [])];
  if (signals.some(s => text.includes(s))) return true;
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 3) return false;
  const tocLines = lines.filter(l => TOC_LINE_RE.test(l.trim())).length;
  const hasDefect = DEFECT_LINE_RE.test(text);
  return (tocLines / lines.length) > 0.6 && !hasDefect;
}

test('detects explicit תוכן עניינים header', () => {
  expect(isTocPage('תוכן עניינים\nסלון ... 3\nמטבח ... 5')).toBe(true);
});

test('detects heuristic TOC page (>60% dotted lines, no defects)', () => {
  const page = 'כניסה ................. 3\nסלון .................. 5\nמטבח .................. 8\nשירותים ............... 11';
  expect(isTocPage(page)).toBe(true);
});

test('does NOT flag content page with defect keywords', () => {
  const page = 'ליקוי ריצוף ............. 3\nנמצא כי הרצפה אינה ישרה.\nנדרש תיקון מיידי.';
  expect(isTocPage(page)).toBe(false);
});

test('does NOT flag short page', () => {
  expect(isTocPage('קצר')).toBe(false);
});
```

- [ ] **Step 4: Run the new test**

```bash
npm test -- --testPathPattern=step2Filter
```
Expected: PASS — 4 tests

- [ ] **Step 5: Run existing tests to make sure nothing broke**

```bash
npm test
```
Expected: all existing tests PASS

- [ ] **Step 6: Commit**

```bash
git add server.js tests/step2Filter.test.js
git commit -m "feat: step2_filter skips TOC pages to prevent empty-section extraction"
```

---

## Task 4: Upgrade `step1_llm` — Structured Archetype Context

**Files:**
- Modify: `server.js:8-12` (lazy-require block)
- Modify: `server.js:283-286` (`step1_llm` hint injection)

- [ ] **Step 1: Add lazy-require for archetypeRules**

In `server.js`, find the existing lazy-require block (lines 7–12):

```javascript
// Lazy-require archetypeDetector (avoids load-time errors if data/ doesn't exist yet)
let _archetypeDetector;
```

Add immediately after it:

```javascript
let _archetypeRules;
function getArchetypeRules(archetype) {
  if (!_archetypeRules) _archetypeRules = require('./lib/archetypeRules');
  return _archetypeRules.getArchetypeRules(archetype);
}
```

- [ ] **Step 2: Replace the thin hint with structured context**

Find these lines in `step1_llm` (around line 283):

```javascript
  const outlineWithHint = archetypeHint
    ? `[${archetypeHint}]\n\n${outline}`
    : outline;
  log.push(`  [outline] ${outline.split('\n').length} עמודים, ${outline.length} תווים${archetypeHint ? ' [+archetype hint]' : ''}`);
```

Replace with:

```javascript
  let _arcCtx = '';
  if (archetypeHint) {
    const _ar = getArchetypeRules(archetypeHint);
    const _parts = [
      `[ארכיטיפ: ${archetypeHint}]`,
      _ar.structure_hint   ? `[מבנה: ${_ar.structure_hint}]`                              : '',
      _ar.toc_skip_signals.length ? `[תוכן עניינים — דלג על עמודים עם: ${_ar.toc_skip_signals.join(', ')}]` : '',
    ].filter(Boolean);
    _arcCtx = _parts.join('\n');
  }
  const outlineWithHint = _arcCtx ? `${_arcCtx}\n\n${outline}` : outline;
  log.push(`  [outline] ${outline.split('\n').length} עמודים, ${outline.length} תווים${archetypeHint ? ` [+archetype:${archetypeHint}]` : ''}`);
```

- [ ] **Step 3: Run tests**

```bash
npm test
```
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: step1_llm injects structured archetype rules into structure-map prompt"
```

---

## Task 5: Upgrade `step3_extract` — Archetype Rules in User Message

**Files:**
- Modify: `server.js:1294` (`buildStep3Tasks` / `step3_extract`)

- [ ] **Step 1: Add `buildArchetypeBlock` helper above `buildStep3Tasks`**

Find the line `function buildStep3Tasks(byRoom, costMap, archetype) {` (line ~1294) and add this helper ABOVE it:

```javascript
function buildArchetypeBlock(rules) {
  const parts = [];
  if (rules.delimiter_pattern) parts.push(`[סימן גבול ליקוי: ${rules.delimiter_pattern}]`);
  if (rules.extraction_hints && rules.extraction_hints.length)
    parts.push(`[כללי חילוץ: ${rules.extraction_hints.join(' | ')}]`);
  if (rules.cost_location) parts.push(`[מיקום מחיר: ${rules.cost_location}]`);
  if (rules.few_shot && rules.few_shot.input) {
    parts.push(`\nדוגמה:\n--- קלט ---\n${rules.few_shot.input}\n--- פלט ---\n${JSON.stringify(rules.few_shot.output)}\n---`);
  }
  return parts.join('\n');
}
```

- [ ] **Step 2: Inject archetype block into `step3_extract` userMsg**

Find `function step3_extract(byRoom, costMap, callback, archetype) {` (line ~1348).

After the line `const tasks = buildStep3Tasks(byRoom, costMap, archetype);`, add:

```javascript
  const _arcRules = getArchetypeRules(archetype || 'UNKNOWN');
  const _arcBlock = buildArchetypeBlock(_arcRules);
```

Then find the `userMsg` at line ~1364:

```javascript
      const userMsg = `חדר: ${t.room}${chunkLabel}${t.costHintLine}\n\nטקסט:\n${t.text}\n\nחלץ ליקויים. JSON בלבד.`;
```

Replace with:

```javascript
      const userMsg = `חדר: ${t.room}${chunkLabel}${t.costHintLine}${_arcBlock ? '\n' + _arcBlock : ''}\n\nטקסט:\n${t.text}\n\nחלץ ליקויים. JSON בלבד.`;
```

Also fix the **retry userMsg** at line ~1434:

```javascript
      const userMsg = `חדר: ${room}\n\nטקסט:\n${roomText}\n\nחלץ ליקויים. JSON בלבד.`;
```

Replace with:

```javascript
      const userMsg = `חדר: ${room}${_arcBlock ? '\n' + _arcBlock : ''}\n\nטקסט:\n${roomText}\n\nחלץ ליקויים. JSON בלבד.`;
```

- [ ] **Step 3: Run tests**

```bash
npm test
```
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: step3_extract injects archetype delimiter+hints into every chunk message"
```

---

## Task 6: Update `step4_schema` to Pass Through `simplified_explanation`

**Files:**
- Modify: `server.js:628` (`step4_schema` function)

- [ ] **Step 1: Read the current step4_schema output object**

Find `function step4_schema(rawDefects)` at line 628. Locate the object returned per defect (it maps `d.t`→`title`, `d.ds`→`description`, etc.).

- [ ] **Step 2: Add `simplified_explanation` to the mapped object**

Find the property block inside `step4_schema` that builds the final defect object. It will look like:

```javascript
      title:       esc(d.title || d.t || ''),
```

Add one line after the last property in that object:

```javascript
      simplified_explanation: d.simplified_explanation || '',
```

- [ ] **Step 3: Run tests**

```bash
npm test
```
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: step4_schema passes through simplified_explanation field"
```

---

## Task 7: Add `step3e_simplify` Function

**Files:**
- Modify: `server.js` — add `SIMPLIFY_PROMPT` constant and `step3e_simplify` function

- [ ] **Step 1: Write failing test**

```javascript
// tests/step3e.test.js
'use strict';

// Minimal mock of tryProviders to avoid real network calls
jest.mock('../server', () => ({}), { virtual: true });

// We'll test the pure logic: JSON parse + batch structure
// (Full LLM integration is manual/E2E)

test('simplified_explanation defaults to empty string on parse error', () => {
  // Simulates what step3e_simplify does when LLM returns garbage
  const defects = [{ title: 'ריצוף צף', description: 'אריח מתנדנד', action: 'החלף' }];
  const raw = 'NOT JSON AT ALL';
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    parsed = null;
  }
  const result = defects.map((d, i) => ({
    ...d,
    simplified_explanation: (parsed && parsed[i] && parsed[i].simplified_explanation) || ''
  }));
  expect(result[0].simplified_explanation).toBe('');
  expect(result[0].title).toBe('ריצוף צף');
});

test('simplified_explanation is populated when LLM returns valid JSON', () => {
  const defects = [{ title: 'ריצוף צף', description: 'אריח מתנדנד', action: 'החלף' }];
  const raw = JSON.stringify([{ simplified_explanation: 'ריצוף לא מחובר לתשתית.' }]);
  const parsed = JSON.parse(raw);
  const result = defects.map((d, i) => ({
    ...d,
    simplified_explanation: (parsed && parsed[i] && parsed[i].simplified_explanation) || ''
  }));
  expect(result[0].simplified_explanation).toBe('ריצוף לא מחובר לתשתית.');
});
```

- [ ] **Step 2: Run test to verify it passes (pure logic, no mocks needed)**

```bash
npm test -- --testPathPattern=step3e
```
Expected: PASS — 2 tests (no LLM calls)

- [ ] **Step 3: Add `SIMPLIFY_PROMPT` constant to server.js**

Find the line `const CONCURRENCY = 4;` (line ~1280) and add BEFORE it:

```javascript
const SIMPLIFY_PROMPT = `אתה מומחה להנגשת מידע טכני לקהל הרחב בישראל.
קיבלת מערך JSON של ליקויי בדק בית. עבור כל ליקוי, מלא את שדה simplified_explanation.

כללי כתיבה:
1. עד 2 משפטים. ענה על: מה הבעיה? למה חשוב? מה קורה אם לא מטפלים?
2. מינוח: אשפרה→איטום, מישקים→פרזול, קפילריות→ספיגת לחות, קונסטרוקציה→מבנה נושא, ריצוף צף→ריצוף לא מחובר, מיסב→תושבת, כשל קפילרי→חדירת לחות
3. אל תמציא פרטים שלא מופיעים ב-title/description/action.
4. גוף שלישי, לא פנייה ישירה.

החזר JSON בלבד, ללא backticks: [{...אותם שדות..., "simplified_explanation":"..."}]`;
```

- [ ] **Step 4: Add `step3e_simplify` function to server.js**

Find `function step3_extract(byRoom, costMap, callback, archetype)` (line ~1348) and add this new function BEFORE it:

```javascript
function step3e_simplify(defects, log, callback) {
  if (!defects || defects.length === 0) return callback(defects);

  const BATCH_SIZE = 15;
  const batches = [];
  for (let i = 0; i < defects.length; i += BATCH_SIZE) {
    batches.push(defects.slice(i, i + BATCH_SIZE));
  }

  const result = new Array(defects.length);
  let batchIdx = 0;

  function nextBatch() {
    if (batchIdx >= batches.length) return callback(result);
    const batch = batches[batchIdx];
    const startIdx = batchIdx * BATCH_SIZE;
    batchIdx++;

    const userMsg = JSON.stringify(
      batch.map(d => ({
        title:       d.title || '',
        description: d.description || '',
        action:      d.action || ''
      }))
    );

    tryProviders(SIMPLIFY_PROMPT, userMsg, log, (err, raw) => {
      if (err || !raw) {
        batch.forEach((d, i) => { result[startIdx + i] = { ...d, simplified_explanation: '' }; });
        return nextBatch();
      }
      let parsed = null;
      try { parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch {}
      batch.forEach((d, i) => {
        result[startIdx + i] = {
          ...d,
          simplified_explanation:
            (parsed && parsed[i] && typeof parsed[i].simplified_explanation === 'string')
              ? parsed[i].simplified_explanation
              : ''
        };
      });
      nextBatch();
    }, 0, PROVIDERS_FAST);
  }

  nextBatch();
}
```

- [ ] **Step 5: Run all tests**

```bash
npm test
```
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add server.js tests/step3e.test.js
git commit -m "feat: add SIMPLIFY_PROMPT and step3e_simplify for plain-language defect explanations"
```

---

## Task 8: Wire `step3e_simplify` into the Pipeline

**Files:**
- Modify: `server.js:~1700` (pipeline after mergeDefects/dedup)

- [ ] **Step 1: Read pipeline lines 1700–1730**

Find the `_afterVision` inner function in the pipeline. It currently looks like:

```javascript
        const _afterVision = () => {
          _visionLog.forEach(l => fullLog.push(l));
          const merged = mergeDefects(finalDefects, _visionDefects);
          const _seen = new Set();
          const dedupedDefects = merged.filter(d => {
            ...
          });
          // ... returns dedupedDefects to client
```

- [ ] **Step 2: Add step3e_simplify call after dedup, before returning to client**

Find where `dedupedDefects` is passed to the final callback/response (look for something like `callback(null, dedupedDefects, fullLog)` or a `res.json(...)` call inside `_afterVision`).

Wrap it in `step3e_simplify`:

```javascript
          // Step 3e — simplify (adds simplified_explanation to all defects)
          const t3e = Date.now();
          step3e_simplify(dedupedDefects, fullLog, (simplifiedDefects) => {
            fullLog.push(`[Step 3e] -> ${simplifiedDefects.length} ליקויים הונגשו, ${Date.now()-t3e}ms`);
            // REPLACE every reference to dedupedDefects below this line with simplifiedDefects
            callback(null, simplifiedDefects, fullLog);
          });
```

> **Note:** Replace `dedupedDefects` with `simplifiedDefects` in the callback call only. Do not change any code above step3e.

- [ ] **Step 3: Run all tests**

```bash
npm test
```
Expected: all PASS

- [ ] **Step 4: Manual E2E smoke test**

Start the server and send a real PDF through the pipeline:

```bash
node server.js &
curl -s -X POST http://localhost:339/api/analyze-simple \
  -H "Content-Type: application/json" \
  -d '{"text":"...paste 3 pages of real PDF text...","filename":"test.pdf"}' \
  | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const r=JSON.parse(d); console.log('defects:', r.defects?.length, 'sample simplified:', r.defects?.[0]?.simplified_explanation?.slice(0,80))"
```

Expected output includes `simplified_explanation` with Hebrew text for each defect.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: wire step3e_simplify into pipeline after dedup — all defects get simplified_explanation"
```

---

## Post-Implementation: Fill Few-Shot Examples

After all tasks pass, improve accuracy by adding one real example per archetype to `data/archetype_rules.json`. For each archetype:

1. Find a good PDF in the corpus (see spec Table 5.1)
2. Extract one section's raw text (~500 words)
3. Run the system and manually correct the JSON output
4. Paste corrected input+output into `few_shot.input` / `few_shot.output`
5. `git commit -m "data: add few-shot example for HIERARCHICAL archetype"`

---

## Success Criteria Checklist

- [ ] All 5 archetypes have rules in `archetype_rules.json`
- [ ] `getArchetypeRules('NONEXISTENT')` returns UNKNOWN fallback (not crash)
- [ ] TOC pages are stripped from filtered text
- [ ] `step1_llm` log shows `[+archetype:HIERARCHICAL]` when archetype detected
- [ ] `step3_extract` userMsg includes delimiter_pattern for HIERARCHICAL docs
- [ ] Every defect in final output has `simplified_explanation` key
- [ ] `simplified_explanation` is never identical to `description`
- [ ] All existing tests pass: `npm test`
