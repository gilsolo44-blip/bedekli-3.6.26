# Spec — Multimodal Vision Pipeline (Gemini PDF OCR + Photo Understanding)

> תאריך: 2026-06-03
> סטטוס: מאושר לתכנון (design approved, pending spec review)
> פרויקט: בדקלי (Bedekli) Home Inspection AI Analyzer

---

## 1. מטרה (Problem & Goals)

ה-pipeline הנוכחי הוא **טקסט-בלבד**: הלקוח מחלץ את שכבת הטקסט של ה-PDF (pdf.js) ושולח טקסט לשרת. כתוצאה:

- **PDF סרוקים לא עובדים** — אין שכבת טקסט → `pdfText` ריק → 0 ליקויים.
- **צילומי הליקויים בדוח לא מנוצלים** — תמונות לעולם לא מגיעות למודל.

שתי הבעיות באותה עדיפות. המטרה: להוסיף יכולת multimodal ש:

1. **OCR** — מחלצת טקסט מעמודים סרוקים (ללא שכבת טקסט).
2. **Vision** — מזהה/מאמתת ליקויים מתוך צילומים בדוח.
3. **קישור צילום↔כרטיס** — מצרפת את הצילום הרלוונטי לכרטיס הליקוי (גם לליקויים שזוהו בטקסט).

### עקרונות מנחים (החלטות שהתקבלו ב-brainstorming)

| החלטה | בחירה |
|-------|-------|
| תקציב | מדורג — Gemini **חינם** עכשיו, ניתן להחלפה ל-Pro בתשלום ע"י config (ללא כתיבה מחדש) |
| טריגר | **היברידי** — מסלול הטקסט הקיים תמיד רץ; vision מתווסף רק לעמודים סרוקים/עם תמונות |
| הזנת תמונות | **PDF גולמי ל-Gemini** (OCR+vision native), דרך **Files API** |
| שילוב pipeline | **מסלול מקביל/fallback** — לא שוברים את מסלול הטקסט; merge+dedup בסוף |
| מקרי כשל | degradation חיננית — כשל vision לעולם לא מפיל את הדוח |
| איחוד Vercel | **`api/analyze-simple.js` יקרא ל-`server.js`** — production = לוקאלי (ראה סעיף 4.9) |

---

## 2. בחירת מודל

| תפקיד | מודל | נימוק |
|-------|------|-------|
| **Vision workhorse** (OCR + צילומים) | `gemini-2.5-flash` | המודל החינמי הטוב ביותר ל-multimodal: עברית + OCR + זיהוי תמונות + תמיכה ב-bounding boxes |
| מיפוי מבנה טקסטואלי (step1, קיים) | `gemini-2.5-flash-lite` | מהיר/זול לטקסט; **לא** ל-vision (חלש מדי). מודל שונה = מכסה נפרדת מ-vision |
| יעד שדרוג בתשלום | `gemini-2.5-pro` | החלפת `VISION_MODEL` env בלבד, לסריקות קשות/מטושטשות |

מבין 4 ספקי ה-LLM בפרויקט (Groq, Cerebras, OpenRouter, Gemini), **רק Gemini הוא multimodal**. שאר הספקים נשארים כ-fallback למסלול הטקסט בלבד.

---

## 3. ארכיטקטורה ו-Data Flow

מסלול הטקסט הקיים נשאר ללא שינוי. מתווסף מסלול vision מקביל שמתמזג בסוף.

```
לקוח (index.html)
  ├─ pdf.js Web Worker → טקסט גולמי            (קיים, ללא שינוי)
  ├─ pdf.js → thumbnails (bdkl_imgs)            (קיים, ללא שינוי)
  └─ חדש: pageMeta[] + pdfBase64
        pageMeta: [{ page, hasTextLayer:bool, hasImages:bool }, ...]
            ↓ POST /api/analyze-simple
              { pdfText, pdfBase64, pageMeta[], propertyType }
            ↓
שרת (server.js) — pipeline()  [שני מסלולים במקביל]
  ┌─ מסלול טקסט (קיים) ─────────┬─ מסלול vision (חדש) ──────────────┐
  │ step0→step1→step2b→step3→4  │ visionPath():                      │
  │ → defects_text[]            │  1. detectVisualPages(pageMeta)    │
  │                             │  2. אם ריק → cb(null,[]) (0 מכסה)  │
  │                             │  3. geminiUploadFile → fileUri     │
  │                             │  4. geminiVisionExtract            │
  │                             │  5. DELETE file (ניקוי יזום)       │
  │                             │  → defects_vision[] (עם bbox)      │
  └─────────────────────────────┴────────────────────────────────────┘
            ↓
  mergeDefects(defects_text, defects_vision)
    dedup קיים: room|page|md5(title[:40])
    התנגשות → מיזוג + העשרת bbox לרשומת הטקסט
            ↓
  JSON: { defects[], reportTotal, structureType, analysisLog[],
          visionMeta:{ pagesScanned, photosLinked } }
            ↓
לקוח (report.html)
  └─ לכל defect עם bbox → cropPhotoFromThumb() → <img> בכרטיס
```

### נקודות מפתח

- שני המסלולים רצים **במקביל** (callback-style join); ה-vision לא מאט את הטקסט.
- כשל מלא במסלול vision → הדוח חוזר עם תוצאות הטקסט (degradation חיננית).
- `pdfBase64` נכנס ל-payload — body guard הקיים (100MB) מכסה אותו.
- אם אין עמודים ויזואליים — מסלול vision לא מבצע אף קריאת API (שמירת מכסה).

---

## 4. רכיבים ולוגיקה

כל הקוד החדש ב-`server.js` (CJS, ללא frameworks). יחידות ממוקדות עם ממשק ברור.

### 4.1 `detectVisualPages(pageMeta)` — JS טהור
```
קלט:  [{ page, hasTextLayer, hasImages }, ...]
פלט:  [3, 7, 12]  // עמודים שדורשים vision
לוגיקה: page => !hasTextLayer || hasImages
```

### 4.2 צד לקוח — חישוב pageMeta (index.html)
pdf.js כבר זמין בלקוח:
- `page.getTextContent()` ריק → `hasTextLayer=false` (עמוד סרוק)
- `page.getOperatorList()` מכיל `OPS.paintImageXObject` → `hasImages=true`

זה השינוי היחיד בלקוח מעבר לשליחת `pdfBase64`.

### 4.3 `geminiUploadFile(pdfBase64, cb)` — Gemini Files API
```
POST https://generativelanguage.googleapis.com/upload/v1beta/files  (resumable)
→ מחזיר file.uri
TTL אצל Google: 48h (חד-פעמי, לא בעיה)
```
פונקציה חדשה לצד `geminiCall` — לא נוגעת בה.

### 4.4 `geminiVisionExtract(fileUri, visualPages, propertyType, cb)`
```
generateContent, parts:
  [{ fileData:{ fileUri, mimeType:'application/pdf' }},
   { text: VISION_PROMPT }]
VISION_PROMPT (עברית): "התמקד בעמודים {visualPages}. לכל ליקוי החזר:
  title, desc, room, page, severity, category, workType,
  bbox:[ymin,xmin,ymax,xmax] (נרמול 0-1000) של הצילום הרלוונטי, או null"
model: VISION.model  // 'gemini-2.5-flash'
retry/cooldown משלה (כמו geminiCall: 429→retry 8s, 503→backoff). לא משתמש ב-tryProviders
  (Files API ייחודי ל-Gemini).
```

### 4.5 `visionPath(pdfBase64, pageMeta, propertyType, cb)` — אורקסטרציה
```
visualPages = detectVisualPages(pageMeta)
if (!visualPages.length) return cb(null, [])
upload → extract → normalize (reuse step4 schema) → DELETE file → cb(null, defects_vision)
כל שגיאה → cb(null, []) + log   // לעולם לא cb(err)
```

### 4.6 שינוי ב-`pipeline()` — נקודת השילוב היחידה
```
מקביל:
  textPath   → defects_text     (step0..4 הקיים, ללא שינוי)
  visionPath → defects_vision
join →
  merged = dedup([...defects_text, ...defects_vision])
  התנגשות dedup → מיזוג + bbox מועשר לרשומת הטקסט
```

### 4.7 `VISION` config — מתג tier (ראש server.js)
```javascript
const VISION = {
  enabled: true,
  model: process.env.VISION_MODEL || 'gemini-2.5-flash', // → 'gemini-2.5-pro' בתשלום
  maxVisualPages: 30,   // תקרת מכסה
};
```

### 4.8 לקוח — `cropPhotoFromThumb(defect)` (report.html)
```
יש bbox + thumbnail (bdkl_imgs) של אותו עמוד?
→ canvas crop (נרמול 0-1000 → פיקסלים) → dataURL → <img> בכרטיס
esc() על כל שדה טקסט מה-vision לפני render (חובה — מגיע מ-LLM)
```

### 4.9 איחוד Vercel — `api/analyze-simple.js` → `server.js`
**מצב נוכחי (drift):** ה-wrapper הוא מימוש נפרד וישן — ESM, OpenRouter עם
`gemini-2.0-flash-exp:free`, schema ישן (`sev`/`area`/`cMin/cMax`), ללא pipeline.
כל ה-pipeline של `server.js` (וה-vision שנוסיף) **לא רץ ב-production**.

**הפתרון:**
1. `server.js` יחשוף את הלוגיקה: `module.exports = { pipeline, ... }` (CJS), בנוסף
   ל-`listen()` הקיים (שיעבור ל-`if (require.main === module)` כדי לא לרוץ ב-import).
2. `api/analyze-simple.js` יהפוך ל-wrapper דק ב-**CJS** (לפי כללי הפרויקט) ש:
   - מקבל `{ pdfText, pdfBase64, pageMeta, propertyType }`
   - קורא ל-`pipeline()` המאוחד ומחזיר את אותו JSON schema
   - שומר את ה-headers/CORS/OPTIONS הקיימים
3. **מגבלות Vercel:** `bodyParser.sizeLimit` יוגדל (10mb→`'50mb'`) ו-`maxDuration`
   יישאר 60s (Pro) / יוגדל לפי הצורך. **סיכון:** סריקות כבדות עלולות לעבור את
   מגבלת ה-body של Vercel — אם זה קורה, ה-fallback הוא העלאת PDF ל-Files API
   **ישירות מהלקוח** (ראה סעיף 8). לוקאלית (Bun) — body guard 100MB מכסה.
4. ה-schema הישן ב-wrapper (`sev`/`area`/`cMin`) **נמחק** — מוחלף ב-schema המאוחד.

---

## 5. טיפול בשגיאות, מכסה, ומקרי קצה

### 5.1 ניהול מכסת חינם
| מצב | התנהגות |
|-----|---------|
| אין עמודים ויזואליים | 0 קריאות API |
| `visualPages > 30` | sample: כל הסרוקים (חובה ל-OCR) + עד 30 עמודי-תמונות לפי עדיפות; log אזהרה |
| Files API 429/quota | retry יחיד (8s) → `cb(null,[])`; הדוח חוזר עם טקסט בלבד |
| התנגשות מכסה עם step1 | טקסט=`flash-lite`, vision=`flash` — מודלים שונים, מכסות נפרדות |

### 5.2 Degradation חיננית
- מסלול vision תמיד best-effort. כל כשל → `cb(null, [])`, **אף פעם** לא `cb(err)`.
- `analysisLog` מתעד כל שלב vision: `[Vision] upload ok`, `[Vision] N ליקויים, M bbox`, `[Vision] ✗ 429 — skipped`.

### 5.3 מקרי קצה
| מקרה | פתרון |
|------|-------|
| bbox לא תקין/הזוי | ולידציה `0≤coords≤1000` ו-`ymin<ymax`; לא תקין → `bbox=null`, הליקוי נשמר בלי צילום |
| bbox לעמוד ללא thumbnail | כרטיס בלי תמונה (לא נשבר) |
| PDF base64 ענק (>100MB) | body guard קיים דוחה לפני parse; הודעה בעברית |
| ליקוי vision כפול לטקסט | dedup קיים → מיזוג + bbox מועשר |
| HTML זדוני משדה vision | `esc()` חובה לפני render |

### 5.4 אבטחה (לפי CLAUDE.md)
- כל שדה מ-`geminiVisionExtract` עובר `esc()` ב-report.html.
- `pdfBase64` לא נשמר בשרת מעבר לזמן הניתוח.
- **ניקוי יזום:** `DELETE /v1beta/files/{name}` מיד אחרי החילוץ (לא ממתינים ל-48h).
- Rate limiting קיים (5/שעה/IP) חל גם על הבקשות המוגדלות.

---

## 6. בדיקות

### 6.1 Test gates קיימים — חייבים להישאר עוברים
```bash
node tests/sprint0-failure-gate.js   # 2/2 PASS
node tests/sprint1-scale-audit.js    # 9/9 PASS
```
נשבר → אין commit.

### 6.2 בדיקות יחידה חדשות (`tests/sprint8-vision.js`)
| בדיקה | מאמת |
|------|------|
| `detectVisualPages` | סרוק→נכלל; תמונה→נכלל; טקסט נקי→מסונן |
| `validateBbox` | מחוץ ל-0-1000 / הפוך → null |
| `mergeDefects` enrich | ליקוי טקסט + vision תואם → רשומה אחת עם bbox |
| degradation | Gemini מדמה 429 → מחזיר `[]`, לא זורק |
| quota cap | 40 עמודים → ≤30 נשלחים, log אזהרה |

### 6.3 E2E ידני (דפדפן)
| תרחיש | PDF | יעד |
|------|-----|-----|
| רגרסיה | `בדיקת-דירה-חדשה.pdf` (73 עמ' טקסט) | עדיין 50+ ליקויים, ₪198,545, **0 קריאות vision** |
| OCR | PDF סרוק (ללא שכבת טקסט) | ליקויים נחלצים (כיום: 0) |
| Vision | דוח עם תמונות מוטמעות | ליקויים עם צילום מצורף + bbox תקין |

### 6.4 בדיקת מכסה ידנית
ספירת קריאות Gemini ב-`analysisLog` — דוח טקסטואלי טהור = 0 קריאות vision.

---

## 7. מה לא בכלל הזה (Out of Scope / YAGNI)

- **לא** מחליפים את מסלול הטקסט (נפסל — סיכון regression).
- **לא** קריאות per-page (גישה B נפסלה לטובת PDF מלא דרך Files API).
- **לא** provider אחר ל-vision (Gemini בלבד; שאר הספקים נשארים למסלול הטקסט).
- **לא** מימוש tier בתשלום עכשיו — רק ה-config שיתמוך בו (`VISION_MODEL` env).
- **כן בכלל (נוסף):** איחוד `api/analyze-simple.js` ל-`server.js` (סעיף 4.9).
- **לא** הוספת מפתח Groq כרגע (המשתמש בחר להישאר Gemini-only — ראה סיכון בסעיף 8).

---

## 8. סיכון ידוע

- **תלות ב-Gemini Files API** — נועלת את מסלול ה-vision ל-Gemini. מקובל: גם tier בתשלום (Pro) תומך ב-PDF, וההפשטה נשמרת ברמת "מסמך→ממצאים".
- **מכסת חינם** — vision כבד יותר מטקסט. ה-cap (30) וה-trigger ההיברידי ממתנים, אך דוחות סרוקים גדולים עלולים להתקרב לתקרה. נמדד ב-E2E.
- **Gemini-only ללא Groq** — המשתמש בחר לא להוסיף מפתח Groq. מסלול הטקסט (`flash-lite`)
  ו-vision (`flash`) משתמשים במודלים שונים = מכסות נפרדות, מה שממתן חלקית, אך כל העומס
  עדיין על חשבון Gemini אחד. אם יופיעו 429 בלחץ — הוספת מפתח Groq היא ההקלה.
- **מגבלת body של Vercel** — סריקות כבדות (pdfBase64) עלולות לעבור את `sizeLimit`.
  Fallback: העלאת PDF ל-Files API ישירות מהלקוח (מחזיר `fileUri` שנשלח לשרת במקום
  ה-base64). לא ממומש בגרסה זו — מתועד כמסלול שדרוג אם ה-E2E ב-production ייכשל.
