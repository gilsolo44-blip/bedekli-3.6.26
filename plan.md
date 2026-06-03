Status:
- Current Phase: IMPLEMENTATION
- Approval: APPROVED

---

# Plan: הגדלת token capacity — ללא משתמשים נוספים

## גישה

שלושה שינויים בקוד קיים בלבד:

1. **תיקון Cerebras** — החלפת שם מודל שגוי → מחזיר ספק חזק (235B) לחיים
2. **הקטנת max_tokens** — 4096→2048 בכל ספק → מפנה quota לבקשות נוספות
3. **הקטנת MAX_CHARS_PER_CHUNK** — 12K→8K → פחות timeout, פחות tokens בקלט

ללא חשבונות חדשים. ללא שינויי ארכיטקטורה.

---

## קבצים שישתנו

- `server.js` בלבד

---

## שינויים מפורטים

### שינוי 1 — תיקון Cerebras model name

**בעיה:** `llama3.1-70b` לא קיים יותר → 404 בכל call.

**מה קיים ב-API של Cerebras כרגע (נבדק):**
```
gpt-oss-120b | llama3.1-8b | qwen-3-235b-a22b-instruct-2507 | zai-glm-4.7
```

**בחירה:** `qwen-3-235b-a22b-instruct-2507` — מודל 235B, הכי חזק זמין, מתאים לעברית.

```js
// PROVIDERS_FAST + PROVIDERS_LARGE — לפני:
{ name: 'cerebras-70b', ..., model: 'llama3.1-70b' }

// אחרי:
{ name: 'cerebras-qwen', ..., model: 'qwen-3-235b-a22b-instruct-2507' }
```

---

### שינוי 2 — הקטנת max_tokens: 4096 → 2048

**בעיה:** מוגדר 4096 אבל הפלט הממוצע הוא ~1,200-1,800 tokens.

```js
// groq, cerebras, openrouter: max_tokens: 4096 → 2048
// gemini: maxOutputTokens: 16384 → 4096
```

---

### שינוי 3 — הקטנת MAX_CHARS_PER_CHUNK: 12000 → 8000

chunk קטן יותר = ~33% פחות tokens קלט, פחות timeouts.

```js
const MAX_CHARS_PER_CHUNK = 8000; // was 12000
```

---

## Trade-offs

| שינוי | יתרון | חיסרון |
|-------|--------|---------|
| Cerebras qwen-235b | מחזיר ספק שלם, מודל 235B | עלול להיות איטי יותר |
| max_tokens 2048 | פחות quota נצרך | פלט ארוך יותר יקוצר (נדיר) |
| chunk 8K | פחות tokens, פחות timeout | יותר chunks לחדר גדול |

**סיכון max_tokens:** `parseDefects` כבר מכיל truncation recovery — בטוח.

---

## Checklist

- [x] **1a** — Cerebras model: `llama3.1-70b` → `qwen-3-235b-a22b-instruct-2507` ב-PROVIDERS_FAST
- [x] **1b** — Cerebras model: אותו שינוי ב-PROVIDERS_LARGE
- [x] **1c** — שם provider: `cerebras-70b` → `cerebras-qwen`
- [x] **2a** — groqCall: `max_tokens: 4096` → `2048`
- [x] **2b** — cerebrasCall: `max_tokens: 4096` → `2048`
- [x] **2c** — geminiCall: `maxOutputTokens: 16384` → `4096`
- [x] **2d** — openrouterCall: `max_tokens: 4096` → `2048`
- [x] **3** — `MAX_CHARS_PER_CHUNK`: `12000` → `8000`
- [x] **verify** — `node --check server.js`

don't implement yet
