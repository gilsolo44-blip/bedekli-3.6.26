# בדק בית — Archetype Detection & Extraction Pipeline Design

**Date:** 2026-06-04  
**Status:** Approved  
**Scope:** Improve existing `server.js` LLM pipeline to handle all 25 company formats  
**Approach:** Regex-first archetype detection with LLM fallback, cached per company

---

## 1. Problem Statement

The existing pipeline (`step0 → step1_llm → step2b_byRoom → step3_extract → step4_schema`) has two P1 bugs that degrade output for ~80% of reports:

- **Bug #1 (step1_llm):** Returns 1 section for 70+ page documents. Cause: no archetype hint → LLM defaults to treating whole doc as one room.
- **Bug #2 (step3_extract):** Extracts 2 defects from 50+ because it sends the full room text as a single LLM block instead of chunking by defect boundaries.

Root cause for both: the pipeline has no awareness of document structure before it starts extracting.

---

## 2. Solution Architecture

Add `step0b_detectArchetype` between `step0_extractCosts` and `step2_filter`. It produces an **archetype profile** that flows through the rest of the pipeline as a parameter.

```
PDF (client) → pdf.js → raw text
     ↓
step0_extractCosts          ← unchanged
     ↓
► step0b_detectArchetype    ← NEW
     ↓  returns: { archetype, confidence, delimiters, field_patterns }
     ↓  caches result in data/company_profiles.json
step2_filter                ← unchanged
     ↓
step1_llm                   ← MODIFIED: +archetype hint in prompt
     ↓                         +validation: sections < 3 on doc > 10p → retry
step2b_byRoom               ← unchanged
     ↓
step3_extract               ← MODIFIED: archetype drives chunk splitting
     ↓                         (CONCURRENCY=4 now has real chunks to parallelize)
step3b_matchCosts           ← unchanged
     ↓
step4_schema                ← MODIFIED: extended schema + Bug #3 fix
```

**New files:**
```
lib/archetypeDetector.js      — signature scanner + LLM fallback
lib/chunkers/hierarchical.js  — split on ^d+\.d+ boundaries
lib/chunkers/kwParagraph.js   — split on ליקוי|ממצא|שרדנ keywords
lib/chunkers/table.js         — split on pipe-delimited rows
lib/chunkers/numberedFlat.js  — split on ^d+\. boundaries
data/company_profiles.json    — persistent archetype cache
```

No existing files deleted. Only `server.js` modified (step1, step3, step4 call signatures + step0b insertion).

---

## 3. Archetype Classification

Derived from regex signature analysis across all 295 files in 25 company folders.

| Archetype | Companies | ~Files | % Dataset |
|-----------|-----------|--------|-----------|
| HIERARCHICAL | הדס ביקורת מבנים (both), אגם, פלס, גולדאל, דובי מהנדסים, איתן דמארי, אלגן, טרמינל בע"מ, עמנואל אשרוב, שחר, בדק בית דוגמאות 2 | ~162 | 55% |
| KW_PARAGRAPH | בדק בית המקורי (both), הורביץ, חברות שונות, טרמינל, תפארת, פרו, פרץ, ארד, שירותי הנדסה | ~109 | 37% |
| TABLE | HD Eng. Services L.T.D, בדק הבית | ~10 | 3% |
| NUMBERED_FLAT | גלאור מהנדסים ויועצים | ~10 | 3% |
| UNKNOWN | לעד הנדסה | ~4 | 1% |

### 3.1 Archetype DNA

**HIERARCHICAL**
- Key delimiter: `^\d+\.\d+` or `^\d+\.\d+\.\d+` starts each defect
- Room boundary: top-level section header above numbered block (e.g. `10. סלון`)
- Cost pattern: `תולע[:\s]+[\d,]+\s*ח"ש` or `₪\s*[\d,]+`
- Standard ref: `י"ת\s*\d+` or `ת"י\s*\d+`
- What breaks naive regex: 2-level vs 3-level numbering mixed in same doc (e.g. `10.1` and `10.1.3`)
- Confidence signal: `section_count >= expected_rooms AND cost_hits >= 0.6 * section_count`

**KW_PARAGRAPH**
- Key delimiter: line starting with `יוקיל|ממצא` marks defect start; cost line marks end
- Action block: text after `שרדנ:` until next keyword or cost
- Cost pattern: `₪\s*[\d,]+` or `כ[:\s]*[\d,]+\s*₪`
- What breaks naive regex: multiple `שרדנ:` sub-items within one defect cause false splits
- Confidence signal: `defect_count >= 3 AND every defect has desc + cost`

**TABLE**
- Key delimiter: `\|` pipe character; each non-header row = one defect
- Column headers contain room/category/cost labels
- What breaks naive regex: pdfminer collapses columns; pipe positions shift across pages
- Confidence signal: `column_headers_found AND row_count >= 3`

**NUMBERED_FLAT**
- Key delimiter: `^\d+\.\s` — each flat number block is one defect
- What breaks naive regex: numbered sub-notes (1a, 1b) parsed as new defects
- Confidence signal: `sequential_gap <= 2` (no missing numbers)

**UNKNOWN** (לעד הנדסה)
- Uses `[1.1]` bracket numbering + `הצלמה` keyword
- No reliable regex signal → always uses LLM fallback
- Confidence signal: LLM returns valid JSON with ≥ 3 fields per defect

---

## 4. Archetype Detector Implementation

```javascript
// lib/archetypeDetector.js  (CJS)
const fs = require('fs');
const path = require('path');

const PROFILES_PATH = path.join(__dirname, '../data/company_profiles.json');

const SIGNATURES = [
  {
    archetype: 'TABLE',
    test: t => (t.match(/\|.*\|/g) || []).length > 15,
    confidence: 0.95,
    delimiters: { defect: /\|[^\|]+\|[^\|]+\|/g },
    field_patterns: { cost: /[\d,]{3,}\s*₪/, room: /^[א-ת\s]{2,15}\s*\|/ }
  },
  {
    archetype: 'HIERARCHICAL',
    test: t => (t.match(/^\d+\.\d+/mg) || []).length > 8,
    confidence: 0.9,
    delimiters: {
      defect: /^(\d+\.\d+(?:\.\d+)?)\s/m,
      room:   /^(\d+)\.\s*([א-ת][^\n]{2,30})$/m
    },
    field_patterns: {
      cost:         /תולע[:\s]+[\d,]+\s*ח"ש|₪\s*[\d,]+/,
      standard_ref: /י"ת\s*\d+|ת"י\s*\d+/
    }
  },
  {
    archetype: 'KW_PARAGRAPH',
    test: t => (t.match(/יוקיל|ממצא|שרדנ/g) || []).length > 10,
    confidence: 0.85,
    delimiters: {
      defect:   /(?:^|\n)(?:יוקיל|ממצא)\s*[:\d]/,
      cost_end: /תולע[:\s]*[\d,]+|₪[\s\d,]+/
    },
    field_patterns: {
      cost:   /₪\s*[\d,]+|[\d,]+\s*₪/,
      action: /שרדנ[:\s]+(.+?)(?=תולע|יוקיל|ממצא|$)/s
    }
  },
  {
    archetype: 'NUMBERED_FLAT',
    test: t => (t.match(/^\d+\.\s+\S/mg) || []).length > 10
            && (t.match(/^\d+\.\d+/mg)   || []).length < 5,
    confidence: 0.8,
    delimiters: { defect: /^\d+\.\s/m },
    field_patterns: { cost: /₪\s*[\d,]+|[\d,]+\s*₪/ }
  },
];

function loadProfiles() {
  try { return JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8')); }
  catch { return {}; }
}

function saveProfile(companyName, result) {
  const profiles = loadProfiles();
  profiles[companyName] = {
    archetype:  result.archetype,
    confidence: result.confidence,
    first_seen: new Date().toISOString().slice(0, 10),
    file_count: (profiles[companyName]?.file_count || 0) + 1
  };
  fs.writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2));
}

async function detectArchetype(rawText, companyName) {
  // 1. Check cache (only trust high-confidence cached results)
  const cached = loadProfiles()[companyName];
  if (cached && cached.confidence >= 0.8) {
    const sig = SIGNATURES.find(s => s.archetype === cached.archetype);
    return { ...cached, ...sig };
  }

  // 2. Run regex signatures on first ~6000 chars (≈ first 3 pages)
  const sample = rawText.slice(0, 6000);
  for (const sig of SIGNATURES) {
    if (sig.test(sample)) {
      const result = { archetype: sig.archetype, confidence: sig.confidence,
                       delimiters: sig.delimiters, field_patterns: sig.field_patterns };
      saveProfile(companyName, result);
      return result;
    }
  }

  // 3. LLM fallback for UNKNOWN archetype
  return await classifyWithLLM(rawText.slice(0, 2000), companyName);
}

module.exports = { detectArchetype };
```

**LLM fallback prompt (classifyWithLLM):**
```
זהו קטע מדוח בדק בית ישראלי. זהה את מבנה המסמך:
- האם יש מספור היררכי (1.1.2)?
- האם יש מילות מפתח כמו "ליקוי" / "ממצא" / "שרדנ"?
- האם יש טבלה עם עמודות?
החזר JSON: { "archetype": "HIERARCHICAL|KW_PARAGRAPH|TABLE|NUMBERED_FLAT", "delimiter": "התבנית שמפרידה בין ליקויים", "confidence": 0.0-1.0 }
```

---

## 5. Chunking Strategies

Each archetype gets a dedicated chunker in `lib/chunkers/`. All return `string[]`.

| Archetype | Split strategy | Max chunk | Overlap |
|-----------|---------------|-----------|---------|
| HIERARCHICAL | `^\d+\.\d+` boundary | 800 tokens | 0 |
| KW_PARAGRAPH | `יוקיל\|ממצא` keyword boundary | 600 tokens | 50 tokens |
| TABLE | `\n` within table block | 200 tokens | 0 |
| NUMBERED_FLAT | `^\d+\.` boundary | 600 tokens | 0 |
| UNKNOWN | Page boundaries | 1500 tokens | 150 tokens |

**Integration in step3_extract (the Bug #2 fix):**
```javascript
// BEFORE:
const chunks = [roomText];

// AFTER:
const { chunkByArchetype } = require('./lib/chunkers');
const chunks = chunkByArchetype(roomText, profile.archetype, profile.delimiters);
// CONCURRENCY=4 now has real chunks to parallelize over
```

---

## 6. Step1_LLM Hint Injection (Bug #1 Fix)

One archetype-specific sentence is prepended to the existing step1_llm prompt:

| Archetype | Hint added to prompt |
|-----------|---------------------|
| HIERARCHICAL | `"המסמך ממוספר היררכית (X.Y.Z). כל מספר ראשי הוא חדר/קטגוריה. צפה ל-{N} חדרים. אל תאחד לסקשן אחד."` |
| KW_PARAGRAPH | `"כל בלוק שמתחיל ב'ליקוי' או 'ממצא' הוא ליקוי נפרד. זהה חדרים לפי כותרות בין הבלוקים."` |
| TABLE | `"המסמך מכיל טבלה. כל שורה היא ליקוי נפרד. הפרד חדרים לפי עמודת המיקום."` |
| NUMBERED_FLAT | `"המסמך ממוספר סדרתי. כל מספר הוא ליקוי נפרד."` |

**Validation added to step1_llm:**
```javascript
if (sections.length < 3 && totalPages > 10) {
  // retry once with stronger prompt: "חובה לזהות לפחות {totalPages/8} סקשנים נפרדים"
  return await step1_llm(text, { ...profile, forceMinSections: Math.ceil(totalPages / 8) });
}
```

---

## 7. Extended Defect Schema

Max 15 fields. `confidence` is an object, not per-field metadata (keeps schema flat).

```json
{
  "title":            "סדק בטיח בקיר הסלון",
  "desc":             "נמצא סדק אנכי ברוחב 2מ\"מ בקיר הצפוני של הסלון",
  "action":           "יש להזמין מהנדס קונסטרוקציה לבדיקה ואיטום הסדק",
  "room":             "סלון",
  "severity":         "high",
  "cost_min":         800,
  "cost_max":         1500,
  "standard_ref":     "י\"ת 1555",
  "category":         "CAT-15",
  "page":             12,
  "work_type":        "inspection",
  "archetype_source": "HIERARCHICAL",
  "confidence": {
    "room":         0.95,
    "severity":     0.6,
    "cost_min":     0.9,
    "standard_ref": 0.0
  }
}
```

**Bug #3 fix in step4_schema:**
```javascript
// If action is identical to desc, the LLM repeated itself — clear action
if (defect.action?.trim() === defect.desc?.trim()) defect.action = '';
```

**Updated step3 prompt to prevent Bug #3:**
```
"desc" = תצפית: מה הבודק ראה (עובדה אובייקטיבית).
"action" = תיקון: מה צריך לעשות (פועל, עתיד). אם לא צוין פירוש — השאר ריק.
```

---

## 8. Company Name Resolution

`detectArchetype` needs a company name to key the cache. The name comes from **step0b itself**, extracted from the first page before running signatures:

```javascript
// Inside step0b_detectArchetype, before signature scan:
function extractCompanyName(firstPageText) {
  // Match against known names in company_profiles.json (fast path)
  const profiles = loadProfiles();
  for (const name of Object.keys(profiles)) {
    if (firstPageText.includes(name.slice(0, 6))) return name; // partial match
  }
  // Fallback: grab first Hebrew line that looks like a company name (2–5 words, no numbers)
  const match = firstPageText.match(/^([א-ת][א-ת\s"']{5,40})$/m);
  return match ? match[1].trim() : 'unknown';
}
```

If `companyName === 'unknown'`, the cache is skipped and detection runs fresh. The resolved name is also stored on the defect as `archetype_source` already includes the archetype — company identity isn't needed downstream.

---

## 9. Company Profiles Cache Schema

`data/company_profiles.json` — grows automatically on first encounter with each company:

```json
{
  "גולדאל הנדסה": {
    "archetype":   "HIERARCHICAL",
    "confidence":  0.9,
    "first_seen":  "2026-06-04",
    "file_count":  19
  },
  "בדק בית המקורי": {
    "archetype":   "KW_PARAGRAPH",
    "confidence":  0.85,
    "first_seen":  "2026-06-04",
    "file_count":  11
  },
  "לעד הנדסה": {
    "archetype":   "UNKNOWN",
    "confidence":  0.65,
    "first_seen":  "2026-06-04",
    "file_count":  4
  }
}
```

Cache is bypassed if `confidence < 0.8` — re-detection runs and may update the entry.

---

## 10. What to Implement Next (Ordered)

1. **`data/company_profiles.json`** — seed with the 25 known companies from the classification table above. Zero runtime cost for all known companies from day one.

2. **`lib/archetypeDetector.js`** — implement exactly as specified in Section 4. Unit-testable with raw text strings.

3. **`lib/chunkers/hierarchical.js`** — highest priority (55% of dataset). Split on `^\d+\.\d+`, return array of defect-text chunks.

4. **`lib/chunkers/kwParagraph.js`** — second priority (37% of dataset). Split on `יוקיל|ממצא` keyword.

5. **Wire into `server.js`** — insert `step0b_detectArchetype()` call, pass profile to `step1_llm` and `step3_extract`.

6. **`lib/chunkers/table.js`** — implement last (3% of dataset, hardest).

7. **Validate on real PDFs** — run against one PDF per archetype, confirm defect count improves vs. baseline.

---

## 11. Deliverable: What to Feed the LLM Next

To design extraction prompts per archetype, send:
- **HIERARCHICAL:** first 3 pages + pages 10–15 of one Goldal PDF (`גולדאל הנדסה`)
- **KW_PARAGRAPH:** first 3 pages + pages 8–14 of one `בדק בית המקורי` PDF
- **TABLE:** full text of one `HD Eng. Services` PDF (only 3 files, all short)
- **NUMBERED_FLAT:** full text of one `גלאור מהנדסים` PDF
- **UNKNOWN:** full text of one `לעד הנדסה` PDF

For each: paste raw pdfminer output, not the PDF itself.
