# Archetype Detection & Extraction Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add archetype-aware document structure detection to fix Bug #1 (step1_llm returns 1 section) and Bug #2 (step3 extracts 2 of 50+ defects), plus Bug #3 (action === desc), by inserting `step0c_detectArchetype` before the LLM pipeline and using the archetype to drive chunking in `buildStep3Tasks`.

**Architecture:** `step0c_detectArchetype` reads the first ~6000 chars, runs regex signatures, and returns an archetype profile (HIERARCHICAL / KW_PARAGRAPH / TABLE / NUMBERED_FLAT / UNKNOWN). This profile flows to: (1) `step1_llm` as a prompt hint fixing Bug #1, and (2) `buildStep3Tasks` as a sub-splitter that splits page-level chunks further by defect boundary, fixing Bug #2.

**Tech Stack:** Node.js CJS (`require`), built-in `node:test` + `node:assert` for testing, no new npm packages. Project at `/Users/gilsolo44/Downloads/bedekli-best-version-31.5.26/`.

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `lib/archetypeDetector.js` | Regex signatures, company name extraction, profiles cache R/W, LLM fallback stub |
| Create | `data/company_profiles.json` | Pre-seeded archetype cache for all 25 known companies |
| Create | `tests/archetypeDetector.test.js` | Unit tests for detection + sub-splitting |
| Create | `tests/buildStep3Tasks.test.js` | Unit tests for archetype-aware chunking |
| Modify | `server.js:1219` (`buildStep3Tasks`) | Accept `archetype` param, call `splitByDefectBoundary` |
| Modify | `server.js:218` (`step1_llm`) | Accept optional `archetypeHint` 4th param, prepend to outline |
| Modify | `server.js:1451` (pipeline) | Insert `step0c_detectArchetype` call, thread profile downstream |
| Modify | `server.js:564` (`step4_schema`) | Bug #3 fix, add `standardRef` + `archetypeSource` fields |
| Modify | `package.json` | Add `"test": "node --test tests/"` script |

---

## Task 1: Test infrastructure

**Files:**
- Modify: `package.json`
- Create: `tests/` directory

- [ ] **Step 1.1: Add test script to package.json**

Open `/Users/gilsolo44/Downloads/bedekli-best-version-31.5.26/package.json`. Replace its contents with:

```json
{
  "name": "bedekli",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "node server.js",
    "test": "node --test tests/"
  }
}
```

- [ ] **Step 1.2: Create tests directory**

```bash
mkdir -p /Users/gilsolo44/Downloads/bedekli-best-version-31.5.26/tests
```

- [ ] **Step 1.3: Verify test runner works**

```bash
cd /Users/gilsolo44/Downloads/bedekli-best-version-31.5.26
node --version
```

Expected: `v18.x` or higher. If lower, tests will fail — upgrade Node before continuing.

---

## Task 2: `lib/archetypeDetector.js`

**Files:**
- Create: `lib/archetypeDetector.js`
- Create: `tests/archetypeDetector.test.js`

### Step 2.1: Write failing tests

Create `/Users/gilsolo44/Downloads/bedekli-best-version-31.5.26/tests/archetypeDetector.test.js`:

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectArchetypeSync, splitByDefectBoundary, extractCompanyName } = require('../lib/archetypeDetector');

// ── detectArchetypeSync ───────────────────────────────────────────────────────

test('detects HIERARCHICAL from 3-level numbering', () => {
  const text = [
    '10.1.1 ריצוף סלון',
    'נמצא סדק בין אריחים',
    '10.1.2 ריצוף מטבח',
    'אריח שבור ליד הכיור',
    '10.2.1 חשמל — שקע לא מהודק',
  ].join('\n');
  const r = detectArchetypeSync(text);
  assert.equal(r.archetype, 'HIERARCHICAL');
  assert.ok(r.confidence >= 0.9);
});

test('detects HIERARCHICAL from 2-level numbering', () => {
  const text = [
    '5.1 ריצוף', 'יש סדק', '5.2 חלונות', 'חלון לא נסגר',
    '5.3 אינסטלציה', 'ברז מטפטף', '5.4 חשמל', 'שקע שבור',
    '5.5 טיח', 'קילוף על הקיר', '5.6 שערים', 'דלת לא נסגרת',
    '5.7 גג', 'נזילה', '5.8 מרפסת', 'ריצוף מבוקע',
    '5.9 מסגרות',
  ].join('\n');
  const r = detectArchetypeSync(text);
  assert.equal(r.archetype, 'HIERARCHICAL');
});

test('detects KW_PARAGRAPH from ליקוי keyword', () => {
  const text = [
    'ליקוי 1: סדק בטיח',
    'נמצא סדק אנכי ברוחב 2 מ"מ',
    'ליקוי 2: ריצוף לא אחיד',
    'אריח שבור בפינה',
    'ליקוי 3: חלון לא נסגר',
    'ליקוי 4: דלת שרוטה',
    'ליקוי 5: שקע חשמל פגום',
    'ליקוי 6: ברז מטפטף',
    'ליקוי 7: צבע קולף',
    'ליקוי 8: רטיבות בפינה',
    'ליקוי 9: נזילה בתקרה',
    'ליקוי 10: גדר לא הושלמה',
  ].join('\n');
  const r = detectArchetypeSync(text);
  assert.equal(r.archetype, 'KW_PARAGRAPH');
  assert.ok(r.confidence >= 0.85);
});

test('detects TABLE from pipe characters', () => {
  const text = Array.from({ length: 20 }, (_, i) =>
    `| חדר ${i} | ליקוי ${i} | ${i * 100} ₪ |`
  ).join('\n');
  const r = detectArchetypeSync(text);
  assert.equal(r.archetype, 'TABLE');
});

test('detects NUMBERED_FLAT from sequential flat numbering', () => {
  const text = [
    '1. ריצוף סלון — אריח שבור',
    '2. חלון מטבח — לא נסגר',
    '3. שקע חשמל — לא מהודק',
    '4. ברז שירותים — מטפטף',
    '5. דלת כניסה — שרוטה',
    '6. טיח קיר — קולף',
    '7. גדר — לא הושלמה',
    '8. מרזב — סתום',
    '9. ווילון — פגום',
    '10. ריסוק אריח — בפינה',
    '11. שפשוף על קיר',
  ].join('\n');
  const r = detectArchetypeSync(text);
  assert.equal(r.archetype, 'NUMBERED_FLAT');
});

test('returns UNKNOWN for unrecognized format', () => {
  const text = 'קצת טקסט עברי ללא מבנה מיוחד. אין מספרים. אין מילות מפתח.';
  const r = detectArchetypeSync(text);
  assert.equal(r.archetype, 'UNKNOWN');
  assert.ok(r.confidence < 0.8);
});

// ── splitByDefectBoundary ─────────────────────────────────────────────────────

test('splits HIERARCHICAL text into defect chunks', () => {
  const text = [
    '10.1 ריצוף — אריח שבור',
    'תיאור מפורט של הליקוי הזה כולל מיקום ומשמעות.',
    '10.2 חשמל — שקע פגום',
    'תיאור מפורט של שקע חשמל שבור.',
    '10.3 טיח — קילוף על הקיר',
    'תיאור מפורט של קילוף הטיח.',
  ].join('\n');
  const chunks = splitByDefectBoundary(text, 'HIERARCHICAL');
  assert.ok(chunks.length >= 2, `expected ≥2 chunks, got ${chunks.length}`);
  assert.ok(chunks[0].includes('10.1'));
  assert.ok(chunks[1].includes('10.2'));
});

test('splits KW_PARAGRAPH text into defect chunks', () => {
  const text = [
    'ליקוי: ריצוף שבור',
    'תיאור: אריח שבור בפינה המזרחית של הסלון.',
    'ליקוי: חלון לא נסגר',
    'תיאור: חלון המטבח אינו נסגר עד הסוף.',
    'ליקוי: טיח קולף',
    'תיאור: קילוף טיח בפינה הצפונית.',
  ].join('\n');
  const chunks = splitByDefectBoundary(text, 'KW_PARAGRAPH');
  assert.ok(chunks.length >= 2, `expected ≥2 chunks, got ${chunks.length}`);
});

test('returns single chunk for TABLE archetype', () => {
  const text = '| חדר | ליקוי | עלות |\n| סלון | סדק | 500 |';
  const chunks = splitByDefectBoundary(text, 'TABLE');
  assert.equal(chunks.length, 1);
});

test('does not produce empty chunks', () => {
  const text = '10.1 ריצוף\nסדק\n10.2 חשמל\nשקע\n10.3 טיח\nקילוף';
  const chunks = splitByDefectBoundary(text, 'HIERARCHICAL');
  assert.ok(chunks.every(c => c.trim().length > 0));
});

// ── extractCompanyName ────────────────────────────────────────────────────────

test('extracts known company name from first page', () => {
  const text = 'גולדאל הנדסה\nInspection and Engineering Services\nדוח בדיקה';
  const name = extractCompanyName(text, { 'גולדאל הנדסה': { archetype: 'HIERARCHICAL' } });
  assert.equal(name, 'גולדאל הנדסה');
});

test('returns unknown for unrecognized first page', () => {
  const text = 'some unrecognized company xyz 123';
  const name = extractCompanyName(text, {});
  assert.equal(name, 'unknown');
});
```

- [ ] **Step 2.2: Run tests — verify all fail**

```bash
cd /Users/gilsolo44/Downloads/bedekli-best-version-31.5.26
node --test tests/archetypeDetector.test.js 2>&1 | head -20
```

Expected: `Error: Cannot find module '../lib/archetypeDetector'`

- [ ] **Step 2.3: Create `lib/` directory and implement `lib/archetypeDetector.js`**

```bash
mkdir -p /Users/gilsolo44/Downloads/bedekli-best-version-31.5.26/lib
```

Create `/Users/gilsolo44/Downloads/bedekli-best-version-31.5.26/lib/archetypeDetector.js`:

```javascript
'use strict';
const fs   = require('fs');
const path = require('path');

const PROFILES_PATH = path.join(__dirname, '../data/company_profiles.json');

// ── Signature definitions (checked in priority order) ────────────────────────

const SIGNATURES = [
  {
    archetype:  'TABLE',
    test:       t => (t.match(/\|.*\|/g) || []).length > 15,
    confidence: 0.95,
  },
  {
    archetype:  'HIERARCHICAL',
    test:       t => (t.match(/^\d+\.\d+/mg) || []).length > 8,
    confidence: 0.9,
  },
  {
    archetype:  'KW_PARAGRAPH',
    test:       t => (t.match(/ליקוי|ממצא|שרדנ/g) || []).length > 10,
    confidence: 0.85,
  },
  {
    archetype:  'NUMBERED_FLAT',
    test:       t => (t.match(/^\d+\.\s+\S/mg) || []).length > 10
                  && (t.match(/^\d+\.\d+/mg)   || []).length < 5,
    confidence: 0.8,
  },
];

// Archetype hint lines injected into step1_llm outline (Bug #1 fix)
const ARCHETYPE_HINTS = {
  HIERARCHICAL:  'מבנה מסמך מזוהה: מספור היררכי (X.Y.Z). כל מספר ראשי = חדר/קטגוריה. אל תאחד לסקשן אחד.',
  KW_PARAGRAPH:  'מבנה מסמך מזוהה: בלוקי פסקה. כל "ליקוי" / "ממצא" = ליקוי נפרד. זהה חדרים לפי כותרות בין הבלוקים.',
  TABLE:         'מבנה מסמך מזוהה: טבלה. כל שורה = ליקוי נפרד. הפרד חדרים לפי עמודת המיקום.',
  NUMBERED_FLAT: 'מבנה מסמך מזוהה: מספור סדרתי. כל מספר = ליקוי נפרד.',
  UNKNOWN:       '',
};

// ── Profile cache ─────────────────────────────────────────────────────────────

function loadProfiles() {
  try { return JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8')); }
  catch { return {}; }
}

function saveProfile(companyName, archetype, confidence) {
  if (companyName === 'unknown') return;
  const profiles = loadProfiles();
  profiles[companyName] = {
    archetype,
    confidence,
    first_seen: profiles[companyName]?.first_seen || new Date().toISOString().slice(0, 10),
    file_count: (profiles[companyName]?.file_count || 0) + 1,
  };
  try { fs.writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2)); } catch {}
}

// ── Company name extraction from first-page text ──────────────────────────────

function extractCompanyName(firstPageText, profiles) {
  for (const name of Object.keys(profiles)) {
    // Partial match on first 6 chars to handle "גולדאל הנדסה" vs "גולדאל הנדסה בע\"מ"
    if (firstPageText.includes(name.slice(0, 6))) return name;
  }
  // Fallback: first Hebrew line that looks like a company name (2–5 Hebrew words)
  const m = firstPageText.match(/^([א-ת][א-ת\s"']{5,40})$/m);
  return m ? m[1].trim() : 'unknown';
}

// ── Synchronous detection (regex only, no I/O except profile read) ────────────

function detectArchetypeSync(text, companyName = 'unknown') {
  const profiles = loadProfiles();

  // Cache hit — only trust confidence >= 0.8
  const cached = profiles[companyName];
  if (cached && companyName !== 'unknown' && cached.confidence >= 0.8) {
    return {
      archetype:  cached.archetype,
      confidence: cached.confidence,
      hint:       ARCHETYPE_HINTS[cached.archetype] || '',
      fromCache:  true,
    };
  }

  // Regex signatures on first ~6000 chars
  const sample = text.slice(0, 6000);
  for (const sig of SIGNATURES) {
    if (sig.test(sample)) {
      saveProfile(companyName, sig.archetype, sig.confidence);
      return {
        archetype:  sig.archetype,
        confidence: sig.confidence,
        hint:       ARCHETYPE_HINTS[sig.archetype],
        fromCache:  false,
      };
    }
  }

  return { archetype: 'UNKNOWN', confidence: 0.3, hint: '', fromCache: false };
}

// ── Defect boundary sub-splitter (used inside buildStep3Tasks) ────────────────

function splitByDefectBoundary(text, archetype) {
  let delimiter;
  if      (archetype === 'HIERARCHICAL')  delimiter = /(?=^\d+\.\d+)/m;
  else if (archetype === 'KW_PARAGRAPH')  delimiter = /(?=(?:^|\n)ליקוי|(?:^|\n)ממצא)/m;
  else if (archetype === 'NUMBERED_FLAT') delimiter = /(?=^\d+\.\s)/m;
  else return [text]; // TABLE or UNKNOWN: no sub-splitting

  const parts = text.split(delimiter).filter(p => p.trim().length > 30);
  // Safety: if split yields < 2 meaningful parts, don't sub-split
  if (parts.length < 2) return [text];
  return parts;
}

// ── Full async detection (regex first, LLM fallback for UNKNOWN) ──────────────

async function detectArchetype(rawText, pdfFirstPageText) {
  const profiles = loadProfiles();
  const companyName = extractCompanyName(pdfFirstPageText || rawText.slice(0, 800), profiles);
  return detectArchetypeSync(rawText, companyName);
  // Note: LLM fallback for UNKNOWN is intentionally deferred to a future task.
  // UNKNOWN currently falls back to page-level chunking (existing behavior).
}

module.exports = { detectArchetypeSync, detectArchetype, splitByDefectBoundary, extractCompanyName };
```

- [ ] **Step 2.4: Run tests — verify all pass**

```bash
cd /Users/gilsolo44/Downloads/bedekli-best-version-31.5.26
node --test tests/archetypeDetector.test.js
```

Expected output: all tests `✔ pass`, zero failures.

- [ ] **Step 2.5: Commit**

```bash
cd /Users/gilsolo44/Downloads/bedekli-best-version-31.5.26
git init 2>/dev/null || true
git add lib/archetypeDetector.js tests/archetypeDetector.test.js package.json
git commit -m "feat: add archetypeDetector with regex signatures and defect boundary splitter"
```

---

## Task 3: Seed `data/company_profiles.json`

**Files:**
- Create: `data/company_profiles.json`

- [ ] **Step 3.1: Create data directory**

```bash
mkdir -p /Users/gilsolo44/Downloads/bedekli-best-version-31.5.26/data
```

- [ ] **Step 3.2: Create pre-seeded profiles file**

Create `/Users/gilsolo44/Downloads/bedekli-best-version-31.5.26/data/company_profiles.json`:

```json
{
  "הדס ביקורת מבנים בע\"מ": { "archetype": "HIERARCHICAL", "confidence": 0.9, "first_seen": "2026-06-04", "file_count": 44 },
  "הדס ביקורת מבנים": { "archetype": "HIERARCHICAL", "confidence": 0.9, "first_seen": "2026-06-04", "file_count": 7 },
  "אגם שירותי בדק בית": { "archetype": "HIERARCHICAL", "confidence": 0.9, "first_seen": "2026-06-04", "file_count": 35 },
  "פלס": { "archetype": "HIERARCHICAL", "confidence": 0.9, "first_seen": "2026-06-04", "file_count": 23 },
  "גולדאל הנדסה": { "archetype": "HIERARCHICAL", "confidence": 0.9, "first_seen": "2026-06-04", "file_count": 19 },
  "דובי מהנדסים בע\"מ": { "archetype": "HIERARCHICAL", "confidence": 0.9, "first_seen": "2026-06-04", "file_count": 12 },
  "איתן דמארי": { "archetype": "HIERARCHICAL", "confidence": 0.9, "first_seen": "2026-06-04", "file_count": 6 },
  "אלגן הנדסה": { "archetype": "HIERARCHICAL", "confidence": 0.9, "first_seen": "2026-06-04", "file_count": 5 },
  "טרמינל שירותי הנדסה ובדק בית בע\"מ": { "archetype": "HIERARCHICAL", "confidence": 0.9, "first_seen": "2026-06-04", "file_count": 4 },
  "עמנואל אשרוב": { "archetype": "HIERARCHICAL", "confidence": 0.9, "first_seen": "2026-06-04", "file_count": 4 },
  "שחר בדק בית": { "archetype": "HIERARCHICAL", "confidence": 0.9, "first_seen": "2026-06-04", "file_count": 3 },
  "בדק בית המקורי": { "archetype": "KW_PARAGRAPH", "confidence": 0.85, "first_seen": "2026-06-04", "file_count": 11 },
  "בדק בית המקורי בע\"מ": { "archetype": "KW_PARAGRAPH", "confidence": 0.85, "first_seen": "2026-06-04", "file_count": 6 },
  "הורביץ מהנדסים": { "archetype": "KW_PARAGRAPH", "confidence": 0.85, "first_seen": "2026-06-04", "file_count": 6 },
  "חברות שונות": { "archetype": "KW_PARAGRAPH", "confidence": 0.85, "first_seen": "2026-06-04", "file_count": 35 },
  "טרמינל שירותי הנדסה ובדק בית": { "archetype": "KW_PARAGRAPH", "confidence": 0.85, "first_seen": "2026-06-04", "file_count": 16 },
  "תפארת ביקורת מבנים": { "archetype": "KW_PARAGRAPH", "confidence": 0.85, "first_seen": "2026-06-04", "file_count": 12 },
  "פרו הנדסה": { "archetype": "KW_PARAGRAPH", "confidence": 0.85, "first_seen": "2026-06-04", "file_count": 4 },
  "פרץ מהנדסים": { "archetype": "KW_PARAGRAPH", "confidence": 0.85, "first_seen": "2026-06-04", "file_count": 7 },
  "ארד בדק בית": { "archetype": "KW_PARAGRAPH", "confidence": 0.85, "first_seen": "2026-06-04", "file_count": 8 },
  "שירותי הנדסה": { "archetype": "KW_PARAGRAPH", "confidence": 0.85, "first_seen": "2026-06-04", "file_count": 4 },
  "גלאור מהנדסים ויועצים": { "archetype": "NUMBERED_FLAT", "confidence": 0.8, "first_seen": "2026-06-04", "file_count": 10 },
  "HD Eng. Services L.T.D": { "archetype": "TABLE", "confidence": 0.95, "first_seen": "2026-06-04", "file_count": 3 },
  "בדק הבית": { "archetype": "TABLE", "confidence": 0.95, "first_seen": "2026-06-04", "file_count": 7 },
  "לעד הנדסה": { "archetype": "UNKNOWN", "confidence": 0.3, "first_seen": "2026-06-04", "file_count": 4 }
}
```

- [ ] **Step 3.3: Verify JSON is valid**

```bash
node -e "require('./data/company_profiles.json'); console.log('valid')" \
  --prefix /Users/gilsolo44/Downloads/bedekli-best-version-31.5.26
```

Wait — use this form instead:

```bash
cd /Users/gilsolo44/Downloads/bedekli-best-version-31.5.26
node -e "JSON.parse(require('fs').readFileSync('data/company_profiles.json','utf8')); console.log('valid JSON')"
```

Expected: `valid JSON`

- [ ] **Step 3.4: Commit**

```bash
cd /Users/gilsolo44/Downloads/bedekli-best-version-31.5.26
git add data/company_profiles.json
git commit -m "feat: seed company_profiles.json with 25 known company archetypes"
```

---

## Task 4: Fix Bug #2 — archetype sub-splitting in `buildStep3Tasks`

**Files:**
- Modify: `server.js:1219` (`buildStep3Tasks`)
- Create: `tests/buildStep3Tasks.test.js`

### Step 4.1: Write failing test

Create `/Users/gilsolo44/Downloads/bedekli-best-version-31.5.26/tests/buildStep3Tasks.test.js`:

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { splitByDefectBoundary } = require('../lib/archetypeDetector');

// This tests the sub-splitting logic that buildStep3Tasks will use.
// Once buildStep3Tasks is modified, add integration tests below.

test('HIERARCHICAL text with 4 defects produces 4 chunks', () => {
  const text = [
    '[עמוד 5]',
    '10.1 ריצוף סלון — אריח שבור ליד הדלת',
    'תיאור מלא: נמצא אריח שבור בפינה הדרומית. יש להחליף.',
    '10.2 חשמל — שקע לא מהודק',
    'תיאור מלא: שקע בקיר המזרחי נמצא רופף. מסוכן.',
    '10.3 טיח — קילוף על קיר הסלון',
    'תיאור מלא: קילוף טיח שטח 0.5 מ"ר בגובה 1.5 מ.',
    '10.4 גדר — לא הושלמה',
    'תיאור מלא: גדר הגבול הותקנה חלקית. חסרה רשת.',
  ].join('\n');

  const chunks = splitByDefectBoundary(text, 'HIERARCHICAL');
  assert.ok(chunks.length >= 3, `expected ≥3 chunks, got ${chunks.length}: ${JSON.stringify(chunks)}`);
  assert.ok(chunks.every(c => c.trim().length > 20), 'no empty chunks');
});

test('KW_PARAGRAPH with 3 defects produces 3 chunks', () => {
  const text = [
    '[עמוד 8]',
    'ליקוי: ריצוף לא אחיד',
    'נמצא הבדל גובה בין אריחים גדול מ-2 מ"מ.',
    'ממצא: חלון לא נסגר',
    'חלון המטבח אינו נסגר לגמרי. יש ליישר.',
    'ליקוי: ברז מטפטף',
    'ברז שירותי האורחים מטפטף כל הזמן.',
  ].join('\n');

  const chunks = splitByDefectBoundary(text, 'KW_PARAGRAPH');
  assert.ok(chunks.length >= 2, `expected ≥2 chunks, got ${chunks.length}`);
});

test('UNKNOWN archetype returns single chunk (no sub-split)', () => {
  const text = 'טקסט ללא מבנה ברור. יש כל מיני ליקויים. 10.1. ליקוי:\nמשהו.';
  const chunks = splitByDefectBoundary(text, 'UNKNOWN');
  assert.equal(chunks.length, 1);
});

test('empty text returns single empty chunk', () => {
  const chunks = splitByDefectBoundary('', 'HIERARCHICAL');
  assert.equal(chunks.length, 1);
});
```

- [ ] **Step 4.2: Run test — verify it passes (splitByDefectBoundary already exists)**

```bash
cd /Users/gilsolo44/Downloads/bedekli-best-version-31.5.26
node --test tests/buildStep3Tasks.test.js
```

Expected: all pass (the function is already implemented in Task 2).

- [ ] **Step 4.3: Modify `buildStep3Tasks` in server.js**

Open `/Users/gilsolo44/Downloads/bedekli-best-version-31.5.26/server.js`.

Find line 1222 (the function signature):
```javascript
function buildStep3Tasks(byRoom, costMap) {
```

Replace with:
```javascript
function buildStep3Tasks(byRoom, costMap, archetype) {
  archetype = archetype || 'UNKNOWN';
```

Find the section inside `buildStep3Tasks` that builds the final task list. It currently looks like this (around line 1244):

```javascript
    const totalChunks = chunks.length;
    chunks.forEach((c, idx) => {
```

Replace that block with:

```javascript
    // Sub-split each page-chunk by defect boundary (Bug #2 fix)
    const allSubChunks = [];
    for (const pc of chunks) {
      const subs = _splitByDefectBoundary(pc.text, archetype);
      subs.forEach(sub => allSubChunks.push({ pageNums: pc.pageNums, text: sub }));
    }

    const totalChunks = allSubChunks.length;
    allSubChunks.forEach((c, idx) => {
```

Add this helper near the top of the file (after the `require` statements, around line 15):

```javascript
// Lazy-require archetypeDetector to avoid circular deps at startup
let _splitByDefectBoundary;
function _ensureDetector() {
  if (!_splitByDefectBoundary) {
    _splitByDefectBoundary = require('./lib/archetypeDetector').splitByDefectBoundary;
  }
}
```

Then at the top of `buildStep3Tasks`, add:
```javascript
function buildStep3Tasks(byRoom, costMap, archetype) {
  archetype = archetype || 'UNKNOWN';
  _ensureDetector();
```

- [ ] **Step 4.4: Verify server.js still parses**

```bash
cd /Users/gilsolo44/Downloads/bedekli-best-version-31.5.26
node -e "require('./server.js')" 2>&1 | head -5
```

Expected: server starts (or shows port-in-use error) — no `SyntaxError`.

- [ ] **Step 4.5: Commit**

```bash
cd /Users/gilsolo44/Downloads/bedekli-best-version-31.5.26
git add server.js tests/buildStep3Tasks.test.js
git commit -m "fix: Bug #2 — buildStep3Tasks sub-splits page chunks by defect boundary using archetype"
```

---

## Task 5: Fix Bug #1 — archetype hint in `step1_llm`

**Files:**
- Modify: `server.js:218` (`step1_llm`)

- [ ] **Step 5.1: Modify `step1_llm` signature to accept optional hint**

Open `server.js`. Find line 218:
```javascript
function step1_llm(cleanText, log, callback) {
```

Replace with:
```javascript
function step1_llm(cleanText, log, callback, archetypeHint) {
```

Find the line inside `step1_llm` that builds the outline (around line 248):
```javascript
  const outline = makeStructureOutline(cleanText);
  log.push(`  [outline] ${outline.split('\n').length} עמודים, ${outline.length} תווים`);
  tryProviders(STRUCT_PROMPT, outline, log, (err, raw) => {
```

Replace with:
```javascript
  const outline = makeStructureOutline(cleanText);
  const outlineWithHint = archetypeHint
    ? `[${archetypeHint}]\n\n${outline}`
    : outline;
  log.push(`  [outline] ${outline.split('\n').length} עמודים, ${outline.length} תווים${archetypeHint ? ' [+archetype hint]' : ''}`);
  tryProviders(STRUCT_PROMPT, outlineWithHint, log, (err, raw) => {
```

- [ ] **Step 5.2: Verify no syntax errors**

```bash
cd /Users/gilsolo44/Downloads/bedekli-best-version-31.5.26
node -c server.js && echo "syntax OK"
```

Expected: `server.js syntax OK`

- [ ] **Step 5.3: Commit**

```bash
cd /Users/gilsolo44/Downloads/bedekli-best-version-31.5.26
git add server.js
git commit -m "fix: Bug #1 — step1_llm accepts archetypeHint to prevent 1-section outputs"
```

---

## Task 6: Wire `step0c_detectArchetype` into the pipeline

**Files:**
- Modify: `server.js:1450` (pipeline main function)

- [ ] **Step 6.1: Add `step0c_detectArchetype` wrapper function**

In `server.js`, just above the `buildStep3Tasks` function (around line 1215), add:

```javascript
// ── Step 0c: Archetype Detection ─────────────────────────────────────────────

function step0c_detectArchetype(cleanText) {
  _ensureDetector();
  const { detectArchetypeSync, extractCompanyName, loadProfiles } = require('./lib/archetypeDetector');
  const profiles = (() => { try { return JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'data/company_profiles.json'), 'utf8')); } catch { return {}; } })();
  const companyName = extractCompanyName(cleanText.slice(0, 800), profiles);
  return detectArchetypeSync(cleanText, companyName);
}
```

Wait — `loadProfiles` is already inside `archetypeDetector.js`. Simplify this. Instead, just call through the module:

```javascript
// ── Step 0c: Archetype Detection ─────────────────────────────────────────────

let _archetypeDetector;
function step0c_detectArchetype(cleanText) {
  if (!_archetypeDetector) _archetypeDetector = require('./lib/archetypeDetector');
  const profiles = _archetypeDetector.loadProfiles ? _archetypeDetector.loadProfiles() : {};
  const companyName = _archetypeDetector.extractCompanyName(cleanText.slice(0, 800), profiles);
  return _archetypeDetector.detectArchetypeSync(cleanText, companyName);
}
```

Also add `loadProfiles` to the exports of `lib/archetypeDetector.js`. Open that file and change the final line from:
```javascript
module.exports = { detectArchetypeSync, detectArchetype, splitByDefectBoundary, extractCompanyName };
```
to:
```javascript
module.exports = { detectArchetypeSync, detectArchetype, splitByDefectBoundary, extractCompanyName, loadProfiles };
```

- [ ] **Step 6.2: Insert detection call into pipeline**

In `server.js`, find the pipeline section (around line 1450):
```javascript
  const costMap = step0_extractCosts(pdfText);
  const reportTotal = step0b_extractReportTotal(pdfText);
```

Add immediately after those two lines:
```javascript
  const archetypeProfile = step0c_detectArchetype(cleanText || step2_filter(pdfText));
  fullLog.push(`[Step 0c] archetype=${archetypeProfile.archetype} confidence=${archetypeProfile.confidence}${archetypeProfile.fromCache ? ' (cache)' : ''}`);
```

Note: `cleanText` is defined a few lines below at `step2_filter`. To avoid calling `step2_filter` twice, move the insertion to just after `cleanText` is defined (around line 1456):

```javascript
  const cleanText = step2_filter(pdfText);
  // ← INSERT HERE:
  const archetypeProfile = step0c_detectArchetype(cleanText);
  fullLog.push(`[Step 0c] archetype=${archetypeProfile.archetype} confidence=${archetypeProfile.confidence}${archetypeProfile.fromCache ? ' (cache)' : ''}`);
```

- [ ] **Step 6.3: Thread archetype into step1_llm call**

Find the existing `step1_llm` call in the pipeline (around line 1469):
```javascript
  step1_llm(cleanText, step1Log, (sectionMap) => {
```

Replace with:
```javascript
  step1_llm(cleanText, step1Log, (sectionMap) => {
```
→ No change to the call signature here. The `archetypeHint` is passed via `archetypeProfile.hint` at the end of the argument list. But `step1_llm` is called as a callback so adding a 4th argument is straightforward:

```javascript
  step1_llm(cleanText, step1Log, (sectionMap) => {
```

Find the exact call. It starts with `step1_llm(cleanText, step1Log, (sectionMap) => {`. The callback runs for many lines. The 4th argument goes at the END of the `step1_llm()` call, after the callback closing `)`. Find where this call ends and add `, archetypeProfile.hint`:

The call site looks like:
```javascript
  step1_llm(cleanText, step1Log, (sectionMap) => {
    step1Log.forEach(l => fullLog.push('  ' + l));
    ...
  });
```

Change to:
```javascript
  step1_llm(cleanText, step1Log, (sectionMap) => {
    step1Log.forEach(l => fullLog.push('  ' + l));
    ...
  }, archetypeProfile.hint);
```

The closing `});` of the step1_llm callback is around line 1554. Find it and add `, archetypeProfile.hint` before the final `;`.

- [ ] **Step 6.4: Thread archetype into buildStep3Tasks call**

Find inside `step3_extract` (line 1263):
```javascript
  const tasks = buildStep3Tasks(byRoom, costMap);
```

This call is inside `step3_extract(byRoom, costMap, callback)`. The archetype needs to be passed in here. Since `step3_extract` is called from the pipeline with access to `archetypeProfile`, add it as a 4th parameter:

Find `step3_extract` signature (line 1260):
```javascript
function step3_extract(byRoom, costMap, callback) {
```
Change to:
```javascript
function step3_extract(byRoom, costMap, callback, archetype) {
```

Find inside its body (line 1263):
```javascript
  const tasks = buildStep3Tasks(byRoom, costMap);
```
Change to:
```javascript
  const tasks = buildStep3Tasks(byRoom, costMap, archetype);
```

Find the call to `step3_extract` in the pipeline (around line 1554):
```javascript
    step3_extract(bR, costMap, (err, rawDefects, step3Log) => {
```
Change to:
```javascript
    step3_extract(bR, costMap, (err, rawDefects, step3Log) => {
```

Add `, archetypeProfile.archetype` as the 4th argument (before the closing `)`):
```javascript
    step3_extract(bR, costMap, (err, rawDefects, step3Log) => {
      ...
    }, archetypeProfile.archetype);
```

- [ ] **Step 6.5: Verify syntax**

```bash
cd /Users/gilsolo44/Downloads/bedekli-best-version-31.5.26
node -c server.js && echo "syntax OK"
```

Expected: `server.js syntax OK`

- [ ] **Step 6.6: Commit**

```bash
cd /Users/gilsolo44/Downloads/bedekli-best-version-31.5.26
git add server.js lib/archetypeDetector.js
git commit -m "feat: wire step0c_detectArchetype into pipeline — threads archetype to step1_llm and step3_extract"
```

---

## Task 7: Fix Bug #3 + extend schema in `step4_schema`

**Files:**
- Modify: `server.js:564` (`step4_schema`)

- [ ] **Step 7.1: Write failing test**

Add to `/Users/gilsolo44/Downloads/bedekli-best-version-31.5.26/tests/archetypeDetector.test.js`:

```javascript
// ── step4_schema Bug #3 regression guard ─────────────────────────────────────

test('Bug #3: action must differ from desc', () => {
  // Simulate what step4_schema does with action: d.rec || desc
  const desc = 'נמצא אריח שבור בפינה הדרומית של הסלון.';
  const rec = desc; // LLM repeated desc in rec field
  // Expected: action should be empty when rec === desc
  const action = rec && rec.trim() !== desc.trim() ? rec : '';
  assert.equal(action, '', 'action should be empty when identical to desc');
});

test('Bug #3: action kept when different from desc', () => {
  const desc = 'נמצא אריח שבור בפינה הדרומית של הסלון.';
  const rec = 'להחליף את האריח השבור.';
  const action = rec && rec.trim() !== desc.trim() ? rec : '';
  assert.equal(action, 'להחליף את האריח השבור.');
});
```

- [ ] **Step 7.2: Run test — verify it passes (logic is correct)**

```bash
cd /Users/gilsolo44/Downloads/bedekli-best-version-31.5.26
node --test tests/archetypeDetector.test.js
```

Expected: all pass.

- [ ] **Step 7.3: Apply the fix in `step4_schema`**

Open `server.js`. Find `step4_schema` (line 564). Inside the `.map()`, find:
```javascript
    return {
      id: i,
      area,
      title,
      desc,
      action: d.rec || desc,
```

Replace `action: d.rec || desc,` with:
```javascript
      action: (d.rec && d.rec.trim() !== desc.trim()) ? d.rec : '',
```

- [ ] **Step 7.4: Add `standardRef` and `archetypeSource` fields**

In the same `return { ... }` block in `step4_schema`, after `workType: inferWorkType(d.rec || desc),`, add:

```javascript
      standardRef:    d.std || '',
      archetypeSource: d._arch || '',
```

Note: `d.std` and `d._arch` are not yet extracted by the LLM. They'll be empty for now — this just future-proofs the schema. The LLM prompt update (SHORT_PROMPT) to extract these fields is a follow-up task outside this plan's scope.

- [ ] **Step 7.5: Verify syntax + run all tests**

```bash
cd /Users/gilsolo44/Downloads/bedekli-best-version-31.5.26
node -c server.js && echo "syntax OK"
node --test tests/
```

Expected: `syntax OK` + all tests pass.

- [ ] **Step 7.6: Commit**

```bash
cd /Users/gilsolo44/Downloads/bedekli-best-version-31.5.26
git add server.js
git commit -m "fix: Bug #3 — action no longer copies desc; add standardRef/archetypeSource to schema"
```

---

## Task 8: E2E smoke test

**Files:**
- Read-only: one PDF from `גולדאל הנדסה` (HIERARCHICAL) and one from `בדק בית המקורי` (KW_PARAGRAPH)

- [ ] **Step 8.1: Start the server**

```bash
cd /Users/gilsolo44/Downloads/bedekli-best-version-31.5.26
node server.js &
```

Note the port from the output (typically 3000 or 3001).

- [ ] **Step 8.2: Baseline — record current defect count before changes**

This step was already done (bugs #1 and #2 mean the baseline is ~2 defects from large PDFs). After the changes, re-run with a real PDF and confirm defect count increases.

Upload a PDF via the web UI at `http://localhost:PORT` and check the server log for:
- `[Step 0c] archetype=HIERARCHICAL confidence=0.9` (or appropriate archetype)
- `[Step 3.X - <room>] (N chunks)` — N should now be > 1 for docs with multiple defects per room
- `[Step 3] -> M ליקויים` — M should be significantly higher than before for HIERARCHICAL docs

- [ ] **Step 8.3: Confirm log output**

Expected server log pattern for a Goldal (HIERARCHICAL) PDF:
```
[Step 0c] archetype=HIERARCHICAL confidence=0.9 (cache)
[Step 1 - LLM Structural Analysis] -> starting...
  [outline] 45 עמודים, 4821 תווים [+archetype hint]
[Step 1] -> LLM זיהה N סקשנים, 0 עמודי עלויות
[Step 2b] -> N סקשנים לעיבוד
[Step 3.1 - סלון] (4 chunks)
  → 8 ליקויים
[Step 3.2 - מטבח] (3 chunks)
  → 6 ליקויים
...
[Step 3] -> 40+ ליקויים
```

If defect count is still low (<5 total), check that:
1. `archetypeProfile.archetype` is correctly set (not UNKNOWN)
2. `splitByDefectBoundary` is actually splitting (add a `console.log` temporarily)
3. The outline sent to step1_llm includes the `[מבנה מסמך מזוהה: ...]` line

- [ ] **Step 8.4: Kill server and final commit**

```bash
kill %1 2>/dev/null || true
cd /Users/gilsolo44/Downloads/bedekli-best-version-31.5.26
git add -A
git commit -m "chore: E2E validation complete — archetype pipeline working"
```

---

## Self-Review Checklist

- [x] **Spec coverage:** All 3 bugs addressed (Bug #1: step1_llm hint, Bug #2: buildStep3Tasks sub-split, Bug #3: action≠desc). Schema extended with `standardRef`, `archetypeSource`. Archetype detection wired into pipeline with cache.
- [x] **No placeholders:** Every step has actual code. No TBDs.
- [x] **Type consistency:** `detectArchetypeSync` returns `{archetype, confidence, hint, fromCache}` — used consistently in step0c. `splitByDefectBoundary(text, archetype)` — called with same signature in tests and buildStep3Tasks.
- [x] **Function name conflict:** `step0b` already exists → using `step0c_detectArchetype`.
- [x] **Lazy require:** `_archetypeDetector` cached to avoid repeated `require()` on every request.
