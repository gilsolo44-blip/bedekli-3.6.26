# CLAUDE.md — בדקלי (Bedekli) Home Inspection AI Analyzer

> קובץ זה מכיל את כל ההקשר הקריטי לפרויקט. **קרא אותו במלואו לפני כל פעולה.**
> עודכן לאחרונה: 2026-05-12 (session 7 — universal PDF: format-agnostic for any inspection report)

---

## 🗂️ תיאור הפרויקט

כלי SaaS שמנתח דוחות בדק בית ישראליים (PDF) באמצעות AI ומייצר דוח אינטראקטיבי עם:
- רשימת ליקויים מפורטת עם עלויות
- חלוקה לחדרים וקטגוריות
- ייצוא Excel + שיתוף קישור (token) + ייצוא HTML עצמאי
- מעקב אחר תיקונים (טופל / חלקי / לא טופל)
- שני מצבי עבודה: **דירה חדשה מקבלן** / **יד שנייה (Yad2)**

---

## 🏗️ ארכיטקטורה

### Stack
| שכבה | טכנולוגיה |
|------|-----------|
| Backend | **Bun** (תואם Node.js), HTTP server נקי (ללא Express), **CJS modules** |
| Frontend | Vanilla HTML/CSS/JS — **3 דפי HTML עצמאיים**, ללא frameworks |
| AI | Multi-LLM cascade — 3 נתיבים נפרדים (STRUCT / FAST / LARGE) |
| Deploy | Vercel — serverless function ב-`api/analyze-simple.js` |
| PDF | pdf.js client-side: thumbnails ב-main thread, טקסט ב-Web Worker |
| Storage | sessionStorage + localStorage (ללא DB) |

### קבצים ראשיים
| קובץ | שורות | תפקיד |
|------|--------|--------|
| `server.js` | ~1450 | כל לוגיקת הניתוח, LLM providers, HTTP server |
| `public/report.html` | ~1200 | דשבורד הדוח האינטראקטיבי |
| `public/index.html` | ~950 | דף נחיתה + העלאת PDF + thumbnails (main thread) |
| `public/pdf-worker.js` | ~45 | Web Worker — חילוץ טקסט PDF, לא חוסם UI |
| `public/viewer.html` | ~763 | צפייה בדוח משותף (token-based) |
| `api/analyze-simple.js` | ~38 | Vercel serverless wrapper + rate limiting |
| `tests/sprint0-failure-gate.js` | ~80 | Gate: body limit + cap removal confirmed |
| `tests/sprint1-scale-audit.js` | ~200 | Gate: 5 architectural flaws — must all PASS |

---

## 🔄 Pipeline הניתוח (הלב של הפרויקט)

```
PDF (client) → pdf.js Web Worker → raw text
     ↓
step0_extractCosts        ← JS regex: חילוץ עלויות מפורשות (₪ / ש"ח)
     ↓
step0b_extractReportTotal ← JS: סה"כ עלות דוח (regex, MAX)
     ↓
step2_filter              ← JS: ניקוי רעש (עמודי מבוא, footers, ציטוטי תקנים)
     ↓
step1_llm                 ← LLM (PROVIDERS_STRUCT): מיפוי מבנה — sections + חדרים + עמודי עלויות
     ↓
step2b_byRoom             ← JS: פיצול טקסט נקי לפי sections (fallback: regex)
     ↓
step3_extract             ← LLM (PROVIDERS_FAST/LARGE): חילוץ ליקויים per-room
                             CONCURRENCY=4, stagger 400ms+jitter, chunking 5p/8000c
     ↓
step3b_matchCosts         ← LLM: התאמת עלויות מטבלת הדוח לליקויים
     ↓
step3c_sectionBudget      ← JS: חלוקת תקציב סקשן לליקויים ללא עלות (SEV_WEIGHT)
     ↓
step3d_llmCostRefine      ← LLM: עידון עלויות לליקויים בעלי variance גבוה — מוגבל ל-15 ליקויים
     ↓
step4_schema              ← JS: enforcement — severity, category, workType, cost range
     ↓
dedup                     ← JS: room|page|md5(title[:40]) — מסיר כפילויות
     ↓
JSON: { defects[], reportTotal, structureType, analysisLog[] }
```

**חשוב:** כל שלב תלוי בפלט של הקודם. **אל תשנה את ה-pipeline** אלא אם יש בעיה ספציפית.

---

## 🤖 Multi-LLM Cascade — 3 נתיבים נפרדים

```javascript
// STRUCT: step1_llm בלבד — Gemini-first, מבודד מ-step3 כדי למנוע rate-limit collision
const PROVIDERS_STRUCT = [
  { name: 'gemini-flash',      model: 'gemini-2.5-flash' },
  { name: 'gemini-flash-lite', model: 'gemini-2.5-flash-lite' },
  { name: 'groq-70b',          model: 'llama-3.3-70b-versatile' },
  { name: 'openrouter-llm',    model: 'meta-llama/llama-3.3-70b-instruct:free' },
  { name: 'cerebras-qwen',     model: 'qwen-3-235b-a22b-instruct-2507' },
];

// FAST: step3_extract (חדרים רגילים) + step3b + step3d — Groq-first, מהיר
const PROVIDERS_FAST = [
  { name: 'groq-70b',          model: 'llama-3.3-70b-versatile' },
  { name: 'gemini-flash-lite', model: 'gemini-2.5-flash-lite' },
  { name: 'gemini-flash',      model: 'gemini-2.5-flash' },
  { name: 'openrouter-llm',    model: 'meta-llama/llama-3.3-70b-instruct:free' },
  { name: 'cerebras-qwen',     model: 'qwen-3-235b-a22b-instruct-2507' },
];

// LARGE: step3_extract (סקשנים גדולים: >3p, multi-chunk, כלל/שונות)
const PROVIDERS_LARGE = [ /* same as FAST — context-heavy tasks */ ];
```

**למה 3 נתיבים?** STRUCT ו-FAST מפצלים את עומס ה-LLM: step1 רץ על Gemini בזמן ש-step3 מחלץ ב-Groq. ללא הפרדה, שניהם פוגעים ב-Groq בו-זמנית → 429 cascade → timeout spiral.

### Cooldown, Fallback, ו-Race Protection
- **Cooldown:** 65 שניות לאותו ספק על שגיאת 429 בלבד
- **Transient retry:** ENOTFOUND/ETIMEDOUT/ECONNRESET → retry × 2 עם 2s delay, ללא cooldown
- **Fallback אוטומטי:** cascade לספק הבא
- **In-flight limit:** `providerInFlight[name] >= 2` → דילוג (מונע pile-up)
- **Groq rotation:** GROQ_API_KEY_1..4 + GROQ_API_KEY
- **Stagger:** 400ms + jitter ±100ms בין chunks (מונע thundering herd)

### שימוש בנתיבים
| שלב | Provider |
|-----|---------|
| `step1_llm` | **PROVIDERS_STRUCT** (Gemini-first) |
| `step3_extract` | **PROVIDERS_FAST** (רגיל) / **PROVIDERS_LARGE** (גדול) |
| `step3b_matchCosts` | **PROVIDERS_FAST** |
| `step3d_llmCostRefine` | **PROVIDERS_FAST** (מוגבל ל-MAX_3D_CANDIDATES=15) |

---

## 📊 לוגיקה עסקית קריטית

### step1_llm — ולידציה וfallback
```javascript
// שער דחייה מוחמר (תוקן מ-avg>15 ל-avg>10):
if ((n < 3 && totalPages > 20) || avg > 10) → fallback לregex
// avg>10 אומר: 73 עמ' דורשים לפחות 8 sections (73/8 = 9.1 < 10) ✓
// אם regex מצא 0 חדרים → retry LLM שני עם PROVIDERS_FAST
```

### makeStructureOutline
שולח ל-LLM את N שורות הראשונות של כל עמוד — N מחושב אדפטיבית כך שהפלט יהיה ≤ OUTLINE_MAX תווים.

### STRUCT_PROMPT — עקרונות universality (Sprint 3)
```
- כל כותרת עם ממצאים = section נפרד (חדר / מערכת / קומה / אזור / נושא)
- אין bias לפורמט דירה — תומך: חדרים, מערכות, קומות, נושאים
- 3 דוגמאות בפרומפט: דירה (rooms) + בית (systems) + מסחרי (floors)
- כסה עמודי ממצאים — מהעמוד הראשון שמכיל ממצאים (לא hardcoded "מעמוד 5")
```

### STRUCT_PROMPT — מינימום sections לפי גודל
```
20-40 עמ' → לפחות 5 sections
40-80 עמ' → לפחות 8 sections
80+ עמ'  → לפחות 12 sections
```

### step3d_llmCostRefine — cap חדש
```javascript
const MAX_3D_CANDIDATES = 15;
// רק ליקויים ללא עלות + קטגוריית variance גבוה + מוגבל ל-15
// מונע: LLM call לא מוגבל בסוף pipeline שמוסיף 30+ שניות
```

### step3c_sectionBudget
```javascript
const SEV_WEIGHT = { critical:8, high:4, medium:2, low:1, cosmetic:0.5 };
// מחלק תקציב סקשן לליקויים ללא עלות (d.c < 200) לפי SEV_WEIGHT
// d._cs = 'section' → costSource badge כחול ב-report.html
```

### buildStep3Tasks — chunking
- `PAGES_PER_CHUNK = 5`, `MAX_CHARS_PER_CHUNK = 8000`
- `isLarge = pageCount > 3 || /כלל|שונות|ממצא/.test(room) || totalChunks > 1`
- **אין cap על גודל roomText** — הטקסט המלא מגיע ל-LLM

### reportTotal
```javascript
const finalReportTotal = (llmTotal > 0) ? llmTotal : reportTotal; // LLM גובר על regex
```

### 16 קטגוריות ליקויים (CAT-01 עד CAT-16)
```
CAT-01: שלד ומבנה              CAT-09: חשמל ותקשורת
CAT-02: טיח וצבע               CAT-10: אינסטלציה ותברואה
CAT-03: ריצוף                  CAT-11: נגרות ומטבח
CAT-04: חיפוי קרמיקה קירות    CAT-12: בטיחות
CAT-05: אבן ואלמנטים חיצוניים CAT-13: מערכות (אוורור/כיבוי/גז)
CAT-06: אלומיניום וחלונות      CAT-14: גבס ומחיצות קלות
CAT-07: דלתות ומסגרות          CAT-15: פיתוח וחוץ
CAT-08: רטיבות ואיטום          CAT-16: כללי ושונות
```

### 5 רמות חומרה
`critical | high | medium | low | cosmetic`

### 10 סוגי עבודה (workType)
`demolish_redo | replacement | completion | sealing | painting | installation | cleaning | alignment | injection | repair`

---

## 🔒 אבטחה (תקין — אל תשבור!)

```javascript
// XSS sanitization — חובה על כל שדה מה-LLM שמוצג ב-innerHTML
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')... }

// Rate limiting (api/analyze-simple.js): 5 בקשות לשעה לכל IP
// Body guard: 100MB raw limit לפני JSON.parse
// Socket timeout: 720s (12 דקות) — מונע חיבורים מתים שמבזבזים API quota
// Shared reports cleanup: TTL 7 ימים
```

**שדות שחייבים `esc()`:** title, desc, action, area, page, quote, categoryLabel, room name, note.

---

## 💾 Storage בצד הלקוח

| Key | תוכן | מיקום |
|-----|------|--------|
| `bdkl_report` | `{ defects[], reportTotal, structureType, fileName, propType }` | sessionStorage |
| `bdkl_imgs` | `{ pageNum: base64JPEG }` — thumbnails (dimScale≤1000px, quality 0.60) | sessionStorage |
| `bdkl_st_*` | סטטוסים והערות per-defect | localStorage |

**זיכרון thumbnails:** scale 1.0 עם cap של 1000px + quality 0.60 + `cv.width=0` לאחר כל דף + `pdf.destroy()` — מונע overflow של sessionStorage.

---

## ✅ פיצ'רים עובדים (אל תשבור!)

- ✅ העלאת PDF + חילוץ טקסט (pdf.js — Web Worker, לא חוסם UI)
- ✅ Thumbnails ב-main thread במקביל (pg.cleanup() + canvas release)
- ✅ ניתוח AI end-to-end (כל ה-pipeline)
- ✅ תצוגת דוח עם view modes (rooms, severity, categories, worktype, all)
- ✅ סינון לפי חומרה / סטטוס / חיפוש טקסטואלי
- ✅ שיתוף דוח — token (`/r/:token`) + ייצוא HTML עצמאי
- ✅ ייצוא Excel
- ✅ Two modes: דירה מקבלן / יד שנייה
- ✅ Rate limiting + XSS sanitization
- ✅ costSource badge (מדוח / לפי סקשן / הערכה)
- ✅ estimateBanner — באנר אזהרה צהוב כשכל הליקויים הם הערכה
- ✅ structureType badge — 4 variants: **rooms / floors / systems / chapters**
- ✅ Dedup: room+page+title hash

---

## 🐛 מצב באגים

**אין באגים P1 או P2 פתוחים.**

### Sprint 3 — Universal PDF Fixes (session 7)
| Flaw | תיאור | תיקון |
|------|--------|--------|
| R1 | STRUCT_PROMPT: רשימת "חדרים נפוצים" הטה LLM לדירות בלבד | הוחלף בעקרון generic: כל כותרת = section |
| R2 | STRUCT_PROMPT: "מעמוד 5" hardcoded | הוחלף ב-"מהעמוד הראשון עם ממצאים" |
| R3 | STRUCT_PROMPT: דוגמה דירה 73 עמ' בלבד | הוחלף ב-3 דוגמאות (rooms/systems/floors) |
| R4 | step2_filter: strip pages [1-4] hardcoded | adaptive detection: DEFECT_RE scan עד עמוד 10 |
| R5 | buildCatchAllChunks: `.filter(p >= 5)` | הוסר — step2_filter מסיר intro אדפטיבית |
| R6 | structureType: רק rooms/chapters | מורחב: floors (קומ[הות]) + systems (מערכות) |

### Recovery-Audit — 5 Flaws שתוקנו (session 6)
| Flaw | תיאור | תיקון |
|------|--------|--------|
| A | PROVIDERS_STRUCT לא היה קיים — step1 ו-step3 חלקו את Groq | הוספת PROVIDERS_STRUCT (Gemini-first) |
| B | makeStructureOutline ללא cap (בפועל: 8 שורות/עמוד מספיק) | ✅ בסדר, אין צורך בcap גלובלי |
| C | שער דחייה step1: avg>15 — אפשר 5 sections ל-73 עמ' | מוחמר ל-avg>10 |
| D | step3d: LLM call לא מוגבל בסוף pipeline | הוספת MAX_3D_CANDIDATES=15 cap |
| E | אין socket timeout — מתים שורפים API quota | `.on('connection', s => s.setTimeout(720000))` |

### E2E Benchmarks
| PDF | עמודים | סה"כ | ליקויים | חלוקה | סטטוס |
|-----|---------|------|---------|--------|--------|
| `בדיקת-דירה-חדשה.pdf` | 73 | ₪198,545 | 50+ | rooms, 10 sections | ✅ |
| Synthetic 100p | 100 | — | 75 | 11 sections | ✅ (מ-cache) |

**הערות:**
- `step0b` regex לא מוצא `₪`/`ש"ח` בחלק מה-PDFs — LLM step1 מכסה
- `step3b` מתאים 0/66 עלויות מהדוח — הטבלה per-section, לא per-ליקוי. step3c מכסה

**P3 — שיפורים עתידיים:**
- הוספת GROQ_API_KEY_2..4 להגברת throughput
- Dynamic CONCURRENCY: אם sections > 15 → CONCURRENCY=6

---

## 🧪 Test Gates

```bash
# Gate 0 — Body limit + cap removal (prior sprints)
node tests/sprint0-failure-gate.js   # חייב: 2/2 PASS

# Gate 1 — Scale audit (5 architectural flaws)
node tests/sprint1-scale-audit.js    # חייב: 9/9 PASS

# E2E — 73 עמוד real PDF (browser)
# http://localhost:3000 → upload בדיקת-דירה-חדשה.pdf
# יעד: sections≥8, defects≥50, reportTotal=₪198,545, latency<120s
```

---

## 🚀 הפעלה

```bash
bun server.js       # → http://localhost:3000  (Bun מהיר פי 4)
node server.js      # אם Bun לא מותקן
vercel dev          # Vercel local
vercel --prod       # Deploy
```

---

## ⚙️ הגדרות סביבה נדרשות

`.env.local`:
```env
GROQ_API_KEY_1=          # חובה — מפתח ראשי
GROQ_API_KEY_2=          # optional — rotation
GROQ_API_KEY_3=          # optional
GROQ_API_KEY_4=          # optional
GEMINI_API_KEY=           # חובה — PROVIDERS_STRUCT (step1)
CEREBRAS_API_KEY=
OPENROUTER_API_KEY=
```

כולם חינמיים. **GEMINI_API_KEY חובה** — step1_llm (PROVIDERS_STRUCT) מתחיל ב-Gemini.

---

## 📐 כללי קוד

- **CJS בלבד** — `require()` ולא `import`. Vercel + Bun תואמים זאת
- **ללא frameworks** — לא Express, לא React. Vanilla JS בלבד
- **עברית ב-prompts** — prompts בעברית מניבים תוצאות טובות יותר
- **`esc()` חובה** — כל שדה מ-LLM לפני render ל-innerHTML
- **CONCURRENCY=4** — אל תעלה — חונק rate limits של providers חינמיים
- **אל תשנה את ה-pipeline** — הסדר קריטי; כל שלב תלוי בקודם
- **לפני כל שינוי ב-server.js:** הרץ את שני ה-test gates. אם נכשל — אל תעשה commit
