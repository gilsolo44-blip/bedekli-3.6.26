# Research: הגדלת token capacity בחינם — ללא משתמשים נוספים

## הבעיה הנוכחית

### Rate limits של הספקים הקיימים (טייר חינמי)
| ספק | Limit | מצב |
|-----|-------|-----|
| Groq | ~14,400 req/day, ~500K tokens/day per key | נגמר אחרי ניתוח אחד-שניים |
| Gemini Flash Lite | 15 RPM, 1M tokens/day | נגמר מהיר בעומס |
| Gemini Flash | 15 RPM, 1M tokens/day | timeout 60s — פועל בקושי |
| OpenRouter (free) | 20 req/day per model | זניח |
| Cerebras | 404 — שם מודל שגוי | לא פועל |

### עלות טוקנים לניתוח אחד
- 10 חדרים × 2 chunks × ~4K tokens per call = **~80K tokens קלט**
- + פלט ~2K tokens per call × 20 = **~40K tokens פלט**
- **סה"כ: ~120K tokens לניתוח אחד** — Groq נגמר אחרי 4 ניתוחים ביום

---

## אפשרויות הגדלת קיבולת ללא חשבונות נוספים

### אפשרות 1: הוספת Sambanova (מומלץ ביותר)
**cloud.sambanova.ai** — ספק חדש עם tier חינמי מאוד גדול:
- **400 RPM** (במקום 15 של Gemini)
- **100K+ tokens/דקה**
- מודל: `Meta-Llama-3.3-70B-Instruct` — זהה לGroq מבחינת איכות
- **API תואם OpenAI** → אינטגרציה פשוטה (זהה לGroq/OpenRouter)
- חשבון אחד בלבד
- Endpoint: `https://api.sambanova.ai/v1/chat/completions`

### אפשרות 2: הוספת GitHub Models
**github.com/marketplace/models** — חינמי דרך GitHub account קיים:
- Llama 3.1 70B, GPT-4o-mini, Phi-4
- ~15 req/min, ~150K tokens/day
- API תואם OpenAI
- Endpoint: `https://models.inference.ai.azure.com`
- Auth: GitHub Personal Access Token

### אפשרות 3: תיקון Cerebras (model name שגוי)
הקוד שולח `llama3.1-70b` אבל ה-API הנוכחי של Cerebras דורש בדיקה:
- `llama3.3-70b` (הדגם החדש)
- endpoint: `https://api.cerebras.ai/v1/models`
- תיקון: עדכון שם המודל בלבד

### אפשרות 4: הקטנת צריכת טוקנים (ללא ספקים חדשים)
**הפחתת 40-50% בצריכה** דרך שיפורי קוד:

#### 4a — קיצור SHORT_PROMPT
הפרומפט הנוכחי: **~700 tokens** (examples, explanations, edge cases)
גרסה מינימלית: **~200 tokens** — חיסכון 10K tokens לניתוח

#### 4b — הקטנת MAX_CHARS_PER_CHUNK: 12K→8K
chunk קטן יותר = פחות tokens input לכל call, פחות timeouts

#### 4c — הורדת max_tokens מ-4096 ל-2048
הפלט הממוצע בפועל הוא ~1,500 tokens. 2048 מספיק.

#### 4d — פילטור טקסט משופר
הסרת שורות לא-רלוונטיות לפני שליחה ל-LLM (~15-20% חיסכון)

---

## השוואה: תועלת vs מאמץ

| אפשרות | רווח | מאמץ | חשבון חדש? |
|--------|------|------|------------|
| Sambanova | ×10 יותר capacity | שעה | כן, אחד |
| GitHub Models | ×2 יותר capacity | שעה | לא (GitHub קיים) |
| תיקון Cerebras | +20% fallback | 5 דקות | לא |
| הקטנת max_tokens | -40K tokens/ניתוח | 5 דקות | לא |
| הקטנת chunks | -25% עומס | 30 דקות | לא |

---

## מסקנה

**ללא שום חשבון חדש (הכי מהיר):**
1. תיקון Cerebras — 5 דקות
2. הורדת max_tokens ל-2048 — 5 דקות
3. הקטנת MAX_CHARS_PER_CHUNK ל-8K — 30 דקות

**עם GitHub קיים (לא "משתמש חדש"):**
1. GitHub Models — מכפיל פי 2 ב-fallback איכותי

**עם חשבון Sambanova אחד:**
1. פי 10 יותר capacity — הפתרון הכי אפקטיבי
