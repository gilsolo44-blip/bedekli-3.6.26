const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Lazy-require archetypeDetector (avoids load-time errors if data/ doesn't exist yet)
let _archetypeDetector;
function _ensureDetector() {
  if (!_archetypeDetector) {
    _archetypeDetector = require('./lib/archetypeDetector');
  }
}

let _archetypeRules;
function getArchetypeRules(archetype) {
  if (!_archetypeRules) _archetypeRules = require('./lib/archetypeRules');
  return _archetypeRules.getArchetypeRules(archetype);
}

// ── Load env ─────────────────────────────────────────────────────────────────
try {
  fs.readFileSync(path.join(__dirname, '.env.local'), 'utf8').split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq > 0) process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  });
} catch {}

const PORT = process.env.PORT || 339;
const SHARED_DIR = process.env.VERCEL ? '/tmp/shared' : path.join(__dirname, 'shared');
try { if (!fs.existsSync(SHARED_DIR)) fs.mkdirSync(SHARED_DIR); } catch {}

// ── Analysis Cache ────────────────────────────────────────────────────────────
const CACHE_DIR = path.join(SHARED_DIR, 'analysis_cache');
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 ימים
try { if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR); } catch {}

function cacheGet(key) {
  try {
    const file = path.join(CACHE_DIR, `${key}.json`);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - data.ts < CACHE_TTL) return data.value;
    fs.unlinkSync(file);
  } catch {}
  return null;
}

function cacheSet(key, value) {
  try {
    fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify({ ts: Date.now(), value }));
  } catch {}
}

function pdfHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 24);
}

function chunkHash(room, text) {
  return crypto.createHash('md5').update(room + text).digest('hex').slice(0, 16);
}

const GROQ_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY,
].filter(Boolean);
let groqKeyIdx = 0;
const groqKeyExhausted = new Set();

const CEREBRAS_KEY   = process.env.CEREBRAS_API_KEY;
const GEMINI_KEY     = process.env.GEMINI_API_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

// ── Vision (multimodal) config ───────────────────────────────────────────────
const VISION = {
  enabled: process.env.VISION_ENABLED !== '0',
  model: process.env.VISION_MODEL || 'gemini-2.5-flash', // → 'gemini-2.5-pro' for paid tier
  maxVisualPages: parseInt(process.env.VISION_MAX_PAGES) || 30,
};

// Validate a Gemini bounding box [ymin,xmin,ymax,xmax] normalized 0-1000.
function validateBbox(b) {
  if (!Array.isArray(b) || b.length !== 4) return null;
  const nums = b.map(Number);
  if (nums.some(v => !Number.isFinite(v))) return null;
  const [ymin, xmin, ymax, xmax] = nums;
  for (const v of nums) { if (v < 0 || v > 1000) return null; }
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

// ── Auth fail-fast ────────────────────────────────────────────────────────────
if (!GROQ_KEYS.length && !CEREBRAS_KEY && !GEMINI_KEY && !OPENROUTER_KEY) {
  console.error('[AUTH_LOCKED] ✗ No API keys found — check .env.local');
  process.exit(1);
}
console.log(`[AUTH_LOCKED] Provider keys verified — GROQ:${GROQ_KEYS.length} CEREBRAS:${!!CEREBRAS_KEY} GEMINI:${!!GEMINI_KEY} OPENROUTER:${!!OPENROUTER_KEY}`);

// ── Step 0: Cost Pre-extraction (JavaScript only) ────────────────────────────

function step0_extractCosts(pdfText) {
  const BIDI_RE = /[‎‏‪-‮⁦-⁩]/g;
  const pages = pdfText.split(/---\s*עמוד\s*(\d+)\s*---/);
  const costMap = {};
  // Match both "1,500 ₪" and "₪ 1,500" (Israeli reports use both)
  const moneyRe = /(\d{1,3}(?:,\d{3})+|\d{4,7})\s*(?:ש["״]ח|₪|שקלים?)\b|(?:₪|ש["״]ח)\s*(\d{1,3}(?:,\d{3})+|\d{4,7})/g;
  for (let i = 1; i < pages.length; i += 2) {
    const pageNum = parseInt(pages[i]);
    const text = (pages[i + 1] || '').replace(BIDI_RE, '');
    const costs = [];
    let m;
    moneyRe.lastIndex = 0;
    while ((m = moneyRe.exec(text)) !== null) {
      const val = parseInt((m[1] || m[2] || '').replace(/,/g, ''));
      if (val >= 200 && val <= 500000) costs.push(val);
    }
    if (costs.length) costMap[pageNum] = costs;
  }
  return costMap;
}

function step0b_extractReportTotal(pdfText) {
  const BIDI_RE = /[‎‏‪-‮⁦-⁩]/g;
  const clean = pdfText.replace(BIDI_RE, '');
  const TOTAL_KW = '(?:סה[“״””]?כ|סהכ|סך\\s+הכל|עלות\\s+כוללת|סכום\\s+כולל|סיכום\\s+כספי|עלות\\s+מוערכת\\s+כוללת)';
  const NUM     = '(\\d{1,3}(?:,\\d{3})+|\\d{4,7})';
  const SHK     = '(?:\\s*(?:ש[\'”\\u05f4””]ח|₪|שקלים?))?';

  let best = 0;

  // Pass 1a — keyword THEN number (e.g. “סה”כ עלויות: 227,500 ₪”)
  const re1a = new RegExp(TOTAL_KW + '[^\\d]{0,40}' + NUM + SHK, 'gi');
  for (const m of clean.matchAll(re1a)) {
    const val = parseInt(m[1].replace(/,/g, ''));
    if (val >= 1000 && val <= 5000000 && val > best) best = val;
  }

  // Pass 1b — number THEN keyword (e.g. “כ₪ 227,500 - סה”כ עלויות”)
  const re1b = new RegExp('(?:כ)?\\s*(?:₪|ש[\'”\\u05f4””]ח)\\s*' + NUM + '[^\\n]{0,60}' + TOTAL_KW, 'gi');
  for (const m of clean.matchAll(re1b)) {
    const val = parseInt(m[1].replace(/,/g, ''));
    if (val >= 1000 && val <= 5000000 && val > best) best = val;
  }

  if (best > 0) return best;

  // Pass 2 — MAX of any shekel amount ≥ 10,000, both directions
  const re2a = new RegExp(NUM + '\\s*(?:ש[\'”\\u05f4””]ח|₪|שקלים)', 'gi');
  const re2b = new RegExp('(?:₪|ש[\'”\\u05f4””]ח)\\s*' + NUM, 'gi');
  for (const m of clean.matchAll(re2a)) {
    const val = parseInt(m[1].replace(/,/g, ''));
    if (val >= 10000 && val <= 5000000 && val > best) best = val;
  }
  for (const m of clean.matchAll(re2b)) {
    const val = parseInt(m[1].replace(/,/g, ''));
    if (val >= 10000 && val <= 5000000 && val > best) best = val;
  }
  return best;
}

// ── Step 1b: LLM Structural Analysis ─────────────────────────────────────────

const STRUCT_PROMPT = `אתה מנתח מסמך בדק-בית. משימתך: לזהות את כל הסקשנים (חדרים, אזורים, או מערכות) ולהחזיר גבולות עמודים.

החזר JSON בלבד ללא backticks, ללא הסברים:
{"sections":[{"name":"שם הסקשן","startPage":N,"endPage":M}],"costTablePages":[N],"reportTotal":0}

חוקים מחייבים:
1. כל חדר, אזור, או מערכת עם כותרת וממצאים = section נפרד. אסור לאחד בלוקים.
   שם ה-section = שם הפרק/חדר בלבד — אסור לכתוב שמות מרובים עם + או / (לדוגמה: "אינסטלציה + שונות" אסור — פצל לשני sections נפרדים).
2. מינימום sections לפי גודל הדוח:
   ≤15 עמ' → לפחות 2  |  16-40 עמ' → לפחות 4
   41-80 עמ' → לפחות 7  |  81-150 עמ' → לפחות 10  |  151+ עמ' → לפחות 14
3. "ממצאים כלליים" / "ממצאים שונים" / "ליקויים שונים" — מותר רק כ-section אחרון קצר (עד 3 עמ'). **אסור** להשתמש בו כ-section יחיד, עיקרי, או ראשון.
4. כסה כל עמוד מהעמוד הראשון עם ממצאים ועד הסוף. sections רצופות ללא חפיפה.
5. costTablePages = עמודים עם ריבוי סכומי כסף בלבד (ללא ממצאים הנדסיים).
6. reportTotal = הסכום הכולל שמופיע בדוח (0 אם לא נמצא).

התאם את הפלט למה שאתה רואה בפועל — לא לדוגמאות להלן.

דוגמה א׳ — דירה 25 עמ', לפי חדרים:
{"sections":[{"name":"כניסה","startPage":3,"endPage":6},{"name":"סלון","startPage":7,"endPage":12},{"name":"מטבח","startPage":13,"endPage":18},{"name":"חדר שינה","startPage":19,"endPage":25}],"costTablePages":[],"reportTotal":0}

דוגמה ב׳ — בית 40 עמ', לפי מערכות:
{"sections":[{"name":"ריצוף","startPage":4,"endPage":14},{"name":"חשמל","startPage":15,"endPage":24},{"name":"אינסטלציה","startPage":25,"endPage":38}],"costTablePages":[39,40],"reportTotal":85000}

דוגמה ג׳ — בניין מסחרי 15 עמ', לפי קומות:
{"sections":[{"name":"קומת קרקע","startPage":2,"endPage":5},{"name":"קומה ראשונה","startPage":6,"endPage":10},{"name":"גג ותשתיות","startPage":11,"endPage":15}],"costTablePages":[],"reportTotal":42000}

דוגמה ד׳ — דירה 51 עמ', פרקים ממוספרים (.1 עבודות X, .2 עבודות Y):
{"sections":[{"name":"עבודות שלד ובניה","startPage":5,"endPage":11},{"name":"עבודות נגרות","startPage":12,"endPage":18},{"name":"עבודות מסגרות","startPage":19,"endPage":27},{"name":"עבודות חיפוי קרמיקה","startPage":28,"endPage":35},{"name":"עבודות חשמל","startPage":36,"endPage":42},{"name":"עבודות שליכט וצבע","startPage":43,"endPage":47},{"name":"עבודות ריצוף","startPage":48,"endPage":51}],"costTablePages":[],"reportTotal":0}`;

const OUTLINE_MAX = 5000; // chars — keeps step1 prompt below Groq's 6144-token output window

function makeStructureOutline(cleanText) {
  const BIDI_RE = /[‎‏‪-‮⁦-⁩]/g;
  const parts = cleanText.split(/---\s*עמוד\s*(\d+)\s*---/);
  const totalPages = Math.floor((parts.length - 1) / 2);

  // Collect cleaned lines per page
  const pageLines = {};
  const lineFreq = {};
  for (let i = 1; i < parts.length; i += 2) {
    const pn = parseInt(parts[i]);
    const cleaned = (parts[i + 1] || '').replace(BIDI_RE, '').trim();
    const ls = cleaned.split('\n').map(l => l.trim()).filter(l => l.length > 3);
    pageLines[pn] = ls;
    ls.slice(0, 4).forEach(l => { const k = l.slice(0, 60); lineFreq[k] = (lineFreq[k] || 0) + 1; });
  }

  // Lines appearing on >60% of pages are repeated headers — skip them
  const threshold = Math.max(3, Math.floor(totalPages * 0.6));
  const commonLines = new Set(Object.entries(lineFreq).filter(([, f]) => f >= threshold).map(([k]) => k));

  const linesPerPage = Math.min(8, Math.max(2, Math.floor(OUTLINE_MAX / (Math.max(totalPages, 1) * 60))));
  const lines = [];
  for (let i = 1; i < parts.length; i += 2) {
    const pageNum = parts[i];
    const all = pageLines[parseInt(pageNum)] || [];
    const meaningful = all.filter(l => !commonLines.has(l.slice(0, 60))).slice(0, linesPerPage);
    if (meaningful.length > 0) lines.push(`עמוד ${pageNum}: ${meaningful.join(' | ')}`);
  }
  return lines.join('\n').slice(0, OUTLINE_MAX);
}

function parseStep1Json(raw, cleanText) {
  const cleaned = raw.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
  let js;
  try {
    js = JSON.parse(cleaned);
  } catch {
    // Try extracting JSON object from anywhere in the response
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      js = JSON.parse(m[0]);
    } catch {
      // Try to recover truncated JSON — close open arrays/objects
      let partial = m[0];
      const opens = (partial.match(/\[/g)||[]).length - (partial.match(/\]/g)||[]).length;
      const opens2 = (partial.match(/\{/g)||[]).length - (partial.match(/\}/g)||[]).length;
      // Remove trailing incomplete object (last unclosed {)
      const lastGoodBrace = partial.lastIndexOf('},');
      if (lastGoodBrace > 0) partial = partial.slice(0, lastGoodBrace + 1);
      partial += ']}'.repeat(Math.max(0, opens)) + '}'.repeat(Math.max(0, opens2 - opens));
      try { js = JSON.parse(partial); } catch { return null; }
    }
  }
  if (!js.sections || !Array.isArray(js.sections) || js.sections.length === 0) return null;
  const totalPages = Math.max(...(cleanText.match(/---\s*עמוד\s*(\d+)\s*---/g) || ['---עמוד 999---'])
    .map(m => parseInt(m.match(/\d+/)[0])));
  js.sections = js.sections.filter(s =>
    s.name && typeof s.startPage === 'number' && typeof s.endPage === 'number' &&
    s.startPage >= 1 && s.endPage >= s.startPage && s.startPage <= totalPages
  ).map(s => ({ ...s, endPage: Math.min(s.endPage, totalPages) }));
  return js.sections.length > 0 ? js : null;
}

function step1_llm(cleanText, log, callback, archetypeHint) {
  const totalPages = (cleanText.match(/---\s*עמוד\s*(\d+)\s*---/g) || []).length;
  if (totalPages === 0) {
    log.push('  [step1] no page markers in text (scanned PDF?) — skip LLM → vision fallback');
    return callback(null);
  }
  const cacheKey = `step1_${pdfHash(cleanText)}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    const n = cached.sections ? cached.sections.length : 0;
    const avg = totalPages / Math.max(n, 1);
    if ((n < (totalPages <= 15 ? 2 : 3) && totalPages > 20) || avg > Math.max(10, totalPages / 10)) {
      log.push(`  [step1] cache hit — rejected (${n} sections / ${totalPages}p avg ${avg.toFixed(1)}) → fallback`);
      return callback(null);
    }
    log.push(`  [step1] cache hit (${n} sections)`);
    return callback(cached);
  }
  const outline = makeStructureOutline(cleanText);
  let _arcCtx = '';
  if (archetypeHint) {
    const _ar = getArchetypeRules(archetypeHint);
    const _parts = [
      `[ארכיטיפ: ${archetypeHint}]`,
      _ar.structure_hint   ? `[מבנה: ${_ar.structure_hint}]`                                                 : '',
      _ar.toc_skip_signals && _ar.toc_skip_signals.length
        ? `[תוכן עניינים — דלג על עמודים עם: ${_ar.toc_skip_signals.join(', ')}]` : '',
    ].filter(Boolean);
    _arcCtx = _parts.join('\n');
  }
  const outlineWithHint = _arcCtx ? `${_arcCtx}\n\n${outline}` : outline;
  log.push(`  [outline] ${outline.split('\n').length} עמודים, ${outline.length} תווים${archetypeHint ? ` [+archetype:${archetypeHint}]` : ''}`);
  tryProviders(STRUCT_PROMPT, outlineWithHint, log, (err, raw) => {
    if (err) return callback(null);
    try {
      const js = parseStep1Json(raw, cleanText);
      if (!js) return callback(null);
      const n = js.sections.length;
      const avg = totalPages / Math.max(n, 1);
      if ((n < (totalPages <= 15 ? 2 : 3) && totalPages > 20) || avg > Math.max(10, totalPages / 10)) {
        log.push(`  [step1] rejected — ${n} sections / ${totalPages} pages (avg ${avg.toFixed(1)}) → fallback`);
        return callback(null);
      }
      cacheSet(cacheKey, js);
      return callback(js);
    } catch {}
    callback(null);
  }, 0, PROVIDERS_STRUCT);
}

// ── Adaptive intro detection — content-based, not page-number-based ──────────

const INTRO_SIGNALS  = /מבוא|מתודולוגיה|פרטי\s+הנכס|פרטי\s+הלקוח|הצגת\s+השירות|חתימה|תאריך\s+הבדיקה|שם\s+הבודק|מספר\s+רישיון|כתובת\s+הנכס/;
const DEFECT_SIGNALS = /ליקוי|בעיה|סדק|רטיב|דליפ|חסר|לא\s+תקין|נמצא|ממצא|פגם|שחיקה|התנתקות/;

function isIntroPage(text) {
  const t = text.trim();
  if (t.length < 250) return true; // very short = cover/header page
  return INTRO_SIGNALS.test(t) && !DEFECT_SIGNALS.test(t);
}

// ── Step 2: Noise Filtration (JavaScript only) ───────────────────────────────

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

function step2_filter(pdfText) {
  let clean = pdfText;
  // Adaptive intro strip — detect by content, not page number
  {
    const _parts = clean.split(/---\s*עמוד\s*(\d+)\s*---/);
    const _totalPages = Math.floor((_parts.length - 1) / 2);
    const MAX_INTRO_STRIP = Math.min(6, Math.max(0, Math.floor(_totalPages / 3)));
    let _introActive = true;
    let _stripped = 0;
    let _rebuilt = _parts[0];
    for (let _i = 1; _i < _parts.length; _i += 2) {
      const _pn  = parseInt(_parts[_i]);
      const _txt = _parts[_i + 1] || '';
      if (_introActive && _stripped < MAX_INTRO_STRIP && isIntroPage(_txt)) {
        _stripped++;
        continue;
      }
      _introActive = false;
      _rebuilt += `\n--- עמוד ${_pn} ---\n${_txt}`;
    }
    if (_stripped > 0) clean = _rebuilt;
  }
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
  // Strip footers
  clean = clean.replace(/יש לקרוא מסמך זה במלואו[^\n]*/g, '');
  clean = clean.replace(/הודפס ביום[^\n]*/g, '');
  clean = clean.replace(/העתק זה הודפס[^\n]*/g, '');
  clean = clean.replace(/מתוך\s+\d+\s+עמוד\s+\d+/g, '');
  // Strip "ציטוט:" blocks (until next ▪ bullet, numbered section, page break, or two newlines)
  clean = clean.replace(/ציטוט\s*:[\s\S]*?(?=▪|\n\s*\d+\.|\n---\s*עמוד|\n\n\n)/g, '');
  // Strip only the citation portion — NOT the whole sentence (preserve defect description)
  clean = clean.replace(/\s*לפי\s+ת["״]?י\s+[\d.]+[\d.\-]*/g, '');
  clean = clean.replace(/\s*בתקן\s+ת["״]?י\s+\d[\d.\/]*/g, '');
  clean = clean.replace(/\s*ת["״]?י\s+ישראלי\s+\d[\d.\/]*/g, '');
  clean = clean.replace(/\s*סעיף\s+[\d.]+\s+ל?תקן[^\n,.]*/g, '');
  // Compress whitespace
  clean = clean.replace(/\n{3,}/g, '\n\n');
  return clean;
}

// ── Step 2b: Split by room — LLM section map (exact boundaries) ─────────────

function step2b_byRoom(cleanText, sectionMap, costTablePages) {
  const pages = cleanText.split(/---\s*עמוד\s*(\d+)\s*---/);
  const pageMap = {};
  for (let i = 1; i < pages.length; i += 2) {
    pageMap[parseInt(pages[i])] = pages[i + 1] || '';
  }
  const costPageSet = new Set((costTablePages || []).map(Number));
  const byRoom = {};
  sectionMap.sections.forEach(({ name, startPage, endPage }) => {
    const sectionPages = [];
    for (let p = startPage; p <= endPage; p++) {
      if (pageMap[p] !== undefined && !costPageSet.has(p)) sectionPages.push(p);
    }
    const texts = sectionPages
      .map(p => `[עמוד ${p}]\n${pageMap[p].trim()}`)
      .filter(t => t.length > 20)
      .join('\n\n');
    if (texts.trim()) byRoom[name] = texts;
  });
  return byRoom;
}

// ── Step 2b fallback: Split by room — regex with section-boundary expansion ──

// ── Step 3b: Cost Matching (single LLM call after all defects extracted) ──────

const COST_MATCH_PROMPT = `קיבלת רשימת ליקויים מדוח בדק-בית וטבלת עלויות.
לכל ליקוי מצא את העלות המתאימה מהטבלה. החזר JSON בלבד ללא backticks:
{"costs":[{"id":0,"c":3500},{"id":1,"c":0}]}

כללים:
- c = מספר שלם בשקלים (ללא פסיקים, ללא סימן ₪)
- אם לא נמצאה התאמה → c: 0
- חפש לפי שילוב: שם החדר + נושא הליקוי + מילות מפתח
- כל ליקוי חייב להופיע ב-costs (גם אם c:0)`;

function step3b_matchCosts(rawDefects, costTableText, log, callback) {
  if (!costTableText || !costTableText.trim() || !rawDefects.length) {
    return callback(rawDefects);
  }
  const defectList = rawDefects
    .map((d, i) => `${i}: ${d.area || ''} — "${d.t || ''}"`)
    .join('\n');
  const userMsg = `ליקויים:\n${defectList}\n\nטבלת עלויות מהדוח:\n${costTableText}`;
  const subLog = [];
  tryProviders(COST_MATCH_PROMPT, userMsg, subLog, (err, raw) => {
    subLog.forEach(l => log.push(l));
    if (err) {
      log.push('  [step3b] נכשל — fallback ל-COST_TABLE');
      return callback(rawDefects);
    }
    try {
      const cleaned = raw.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
      const js = JSON.parse(cleaned);
      const costById = {};
      (js.costs || []).forEach(({ id, c }) => { if (typeof id === 'number') costById[id] = c || 0; });
      const enriched = rawDefects.map((d, i) => ({
        ...d,
        c: costById[i] > 0 ? costById[i] : (d.c || 0)
      }));
      const matched = Object.values(costById).filter(c => c > 0).length;
      log.push(`  [step3b] ${matched}/${rawDefects.length} ליקויים עם עלות מהדוח`);
      callback(enriched);
    } catch {
      log.push('  [step3b] שגיאת parse — fallback ל-COST_TABLE');
      callback(rawDefects);
    }
  }, 0, PROVIDERS_FAST);
}

// ── Step 3c: Section-Budget Cost Allocation (best-effort) ────────────────────

const SEV_WEIGHT = { critical: 8, high: 4, medium: 2, low: 1, cosmetic: 0.5 };

function step3c_sectionBudget(defects, costTableText, reportTotal) {
  const result = defects.map(d => ({ ...d }));

  // Pass A: inline cost extraction from defect quote / description
  const inlineRe = /(?:₪|ש['”״””]ח)\s*([\d,]+)|([\d,]+)\s*(?:₪|ש['”״””]ח)|עלות[^:\n]{0,20}:\s*([\d,]+)/i;
  result.forEach(d => {
    if (parseInt((d.c || '').toString().replace(/[^\d]/g, '')) >= 200) return;
    const text = (d.q || '') + ' ' + (d.ds || '');
    const m = inlineRe.exec(text);
    if (!m) return;
    const amount = parseInt((m[1] || m[2] || m[3] || '').replace(/,/g, ''));
    if (amount >= 200 && (!reportTotal || amount <= reportTotal)) { d.c = amount; d._cs = 'report'; }
  });

  // Pass B: section-budget distribution for remainder (only when cost table text is available)
  if (reportTotal > 0 && costTableText && costTableText.trim()) {
    const secRe = /([^\n\d:–\-|.]{2,35})\s*(?:[:–\-|]|\.{2,})\s*(\d{1,3}(?:,\d{3})+|\d{4,7})\s*(?:ש['”״””]ח|₪)?/gi;
    const sections = {};
    for (const m of costTableText.matchAll(secRe)) {
      const name = m[1].trim().replace(/\s+/g, ' ');
      const amount = parseInt(m[2].replace(/,/g, ''));
      if (amount >= 1000 && amount <= reportTotal * 0.95 && name.length >= 2) {
        sections[name] = Math.max(sections[name] || 0, amount);
      }
    }
    const byArea = {};
    result.forEach((d, i) => {
      if (parseInt((d.c || '').toString().replace(/[^\d]/g, '')) >= 200) return;
      const area = (d.area || 'כללי').trim();
      if (!byArea[area]) byArea[area] = [];
      byArea[area].push(i);
    });

    for (const [area, indices] of Object.entries(byArea)) {
      let budget = 0;
      for (const [sName, amount] of Object.entries(sections)) {
        if (area.includes(sName) || sName.includes(area)) { budget = amount; break; }
      }
      if (!budget) continue;
      const totalWeight = indices.reduce((s, i) => s + (SEV_WEIGHT[result[i].s] || 1), 0);
      indices.forEach(i => {
        const w = SEV_WEIGHT[result[i].s] || 1;
        result[i].c = Math.max(200, Math.round((w / totalWeight) * budget));
        result[i]._cs = 'section';
      });
    }
  }

  // Pass C: distribute reportTotal to any defects still without a cost source
  if (reportTotal > 0) {
    const noCost = result
      .map((d, i) => ({ i, d }))
      .filter(({ d }) => !d._cs && !(parseInt((d.c || '').toString().replace(/[^\d]/g, '')) >= 200));
    if (noCost.length > 0) {
      const allocatedSum = result.filter(d => d._cs).reduce((s, d) => s + (d.c || 0), 0);
      const budget = allocatedSum < reportTotal ? (reportTotal - allocatedSum) : reportTotal;
      const totalWeight = noCost.reduce((s, { d }) => s + (SEV_WEIGHT[d.s] || 1), 0);
      noCost.forEach(({ i, d }) => {
        const w = SEV_WEIGHT[d.s] || 1;
        result[i].c = Math.max(200, Math.round((w / totalWeight) * budget));
        result[i]._cs = 'report';
      });
    }
  }

  return result;
}

// ── Step 3d: LLM Cost Refinement (high-variance defects without a cost) ──────

function isHighVariance(costKey) {
  const e = COST_TABLE[costKey] || COST_TABLE['כללי'];
  return (e.max - e.min) > 4000;
}

const MAX_3D_CANDIDATES = 15;

function step3d_llmCostRefine(defects, log, callback) {
  const candidates = defects
    .map((d, i) => ({ i, d }))
    .filter(({ d }) => {
      if (d._cs) return false;
      if (parseInt((d.c || '').toString().replace(/[^\d]/g, '')) >= 200) return false;
      const catObj = guessCategory(d.t || '', d.ds || '');
      return isHighVariance(catObj.costKey);
    })
    .slice(0, MAX_3D_CANDIDATES);

  if (candidates.length === 0) {
    log.push('[Step 3d] → 0 ליקויים מתאימים לעידון LLM');
    return callback(defects);
  }

  const batch = candidates.map(({ i, d }) => ({
    id: i,
    t: (d.t || '').slice(0, 60),
    s: d.s || 'medium',
    cat: guessCategory(d.t || '', d.ds || '').label
  }));

  const system = `אתה מומחה לעלויות תיקונים בנדל"ן ישראלי. החזר JSON בלבד ללא הסברים.`;
  const user = `להלן רשימת ליקויים בדירה. לכל ליקוי, העריך עלות תיקון ריאלית בשקלים (מספר שלם, לפחות 200).
JSON בלבד: [{"id":מספר,"est":עלות},...]

ליקויים:
${JSON.stringify(batch)}`;

  tryProviders(system, user, log, (err, raw) => {
    if (err) {
      log.push('[Step 3d] ✗ LLM נכשל — fallback ל-COST_TABLE');
      return callback(defects);
    }
    try {
      const cleaned = (raw || '').replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) throw new Error('not array');
      const result = defects.map(d => ({ ...d }));
      let refined = 0;
      parsed.forEach(({ id, est }) => {
        if (typeof id !== 'number' || typeof est !== 'number') return;
        if (id < 0 || id >= result.length) return;
        result[id].c = Math.max(200, Math.round(est));
        refined++;
      });
      log.push(`[Step 3d] → ${refined} ליקויים עודכנו על ידי LLM`);
      callback(result);
    } catch (e) {
      log.push('[Step 3d] ✗ parse error — fallback ל-COST_TABLE');
      callback(defects);
    }
  }, 0, PROVIDERS_FAST);
}

// ── Step 4: Schema Enforcement (JavaScript only) ─────────────────────────────

const COST_TABLE = {
  'ריצוף':       { min: 800,  max: 9000 },
  'חיפוי קרמי':  { min: 800,  max: 5500 },
  'שפכטל':      { min: 1000, max: 9000 },
  'צבע':         { min: 1000, max: 9000 },
  'חלונות':      { min: 500,  max: 8700 },
  'דלתות':       { min: 500,  max: 4000 },
  'חשמל':        { min: 500,  max: 3500 },
  'מיזוג':       { min: 500,  max: 3500 },
  'אינסטלציה':   { min: 500,  max: 9500 },
  'קירות חוץ':  { min: 1000, max: 4500 },
  'כללי':        { min: 500,  max: 2000 }
};

// ── CAT-01..16 classification ────────────────────────────────────────────────

const CAT_RULES = [
  { code:'CAT-01', label:'שלד ומבנה',                   costKey:'כללי',       re:/שלד|קונסטרוקציה|יסוד|סדק.{0,12}קונסטרוקטי|שקיעה|עמוד\s+בטון/ },
  { code:'CAT-02', label:'טיח וצבע',                     costKey:'שפכטל',      re:/שפכטל|טיח|צבע|חיט|מישוריות|גמר\s+(?:פנים|טיח)|מלבן.*צבע/ },
  { code:'CAT-03', label:'ריצוף',                         costKey:'ריצוף',      re:/אריח.*רצפ|ריצוף|פרקט|גרניט|פורצלן|רובה.*רצפ|פנל.*רצפ/ },
  { code:'CAT-04', label:'חיפוי קרמיקה קירות',           costKey:'חיפוי קרמי', re:/חיפוי\s*(?:קרמיקה|קיר)|פסיפס|אריח\s+קיר|רובה.*קיר/ },
  { code:'CAT-05', label:'אבן ואלמנטים חיצוניים',        costKey:'קירות חוץ',  re:/קופינג|אבן\s+(?:טבעית|חוץ|נוי)|חזית\s+(?:אבן|בניין)|מעקה\s+בנוי/ },
  { code:'CAT-06', label:'אלומיניום וחלונות',             costKey:'חלונות',     re:/חלון|תריס|אלומיניום|זגוגית|זכוכית|מסגרת\s+חלון|כנף\s+(?:חלון|דלת)/ },
  { code:'CAT-07', label:'דלתות ומסגרות',                 costKey:'דלתות',      re:/דלת|מנעול|פרזול|אינטרקום|ידית\s+דלת|מלבן\s+דלת/ },
  { code:'CAT-08', label:'רטיבות ואיטום',                 costKey:'אינסטלציה',  re:/רטיב|נזיל|דליפ|ספיג|מים\s+(?:חודר|מצטבר)|הצטברות\s+מים|כתם\s+(?:לחות|מים)/ },
  { code:'CAT-09', label:'חשמל ותקשורת',                  costKey:'חשמל',       re:/חשמל|מתג|תקע|שקע|לוח|מנורה|נקודת\s+אור|כבל\s+חשמל|ארמטורה/ },
  { code:'CAT-10', label:'אינסטלציה ותברואה',             costKey:'אינסטלציה',  re:/ברז|כיור|אמבטיה|צנרת|ניקוז|אינסטלציה|ספרינקלר|מקלחון|ביוב|זוקין/ },
  { code:'CAT-11', label:'נגרות ומטבח',                   costKey:'כללי',       re:/ארון\s+(?:מטבח|בגדים)|משטח\s+עבודה|דלפק\s+מטבח|מגירה|ציפוי\s+(?:ארון|משטח)/ },
  { code:'CAT-12', label:'בטיחות',                        costKey:'כללי',       re:/מעקה(?!\s+בנוי)|מסעד|בטיחות|סורג(?!\s+קבוע)|גדר\s+בטיח|סכנת/ },
  { code:'CAT-13', label:'מערכות (אוורור / כיבוי / גז)', costKey:'מיזוג',       re:/מזגן|מיזוג|אוורור|כיבוי\s+אש|גז(?!\s+(?:חדר|גינה))|מפוח|צנרת\s+גז/ },
  { code:'CAT-14', label:'גבס ומחיצות קלות',              costKey:'שפכטל',      re:/גבס|פלסבורד|מחיצה\s+קלה|תקרה\s+גבס|לוח\s+גבס/ },
  { code:'CAT-15', label:'פיתוח וחוץ',                    costKey:'קירות חוץ',  re:/חצר|גינה|שביל|גדר(?!\s+בטיח)|שער\s+כניסה|ריצוף\s+(?:חוץ|חצר)|פיתוח\s+סביבתי/ },
];

function guessCategory(title, desc) {
  const text = (title || '') + ' ' + (desc || '');
  for (const { code, label, costKey, re } of CAT_RULES) {
    if (re.test(text)) return { code, label, costKey };
  }
  return { code: 'CAT-16', label: 'כללי ושונות', costKey: 'כללי' };
}

// ── Room rescue: when area is a work-type section name, extract physical room ─

const WORK_TYPE_AREA_RE = /^(ריצוף|טיח|צבע|איטום|חשמל|תקשורת|אינסטלציה|נגרות|אלומיניום|חיפוי|גבס|מחיצה|שלד|מבנה|בטיחות|פיתוח|גינה|גג|רטיבות|עבודות|תקנות|ממצאים|כללי|שונות|ריצוף\s+ח|ניקוז|ביוב|מיזוג|אוורור|כיבוי|גז\b)/i;

const ROOM_RESCUE_PATTERNS = [
  { re: /סלון\s+אורחים/,                  label: 'סלון אורחים' },
  { re: /פינת\s+אוכל|חדר\s+אוכל/,        label: 'פינת אוכל' },
  { re: /סלון|מגורים/,                    label: 'סלון' },
  { re: /מטבח/,                           label: 'מטבח' },
  { re: /חדר\s*הורים|חדר\s*שינה\s*ראשי/, label: 'חדר הורים' },
  { re: /חד"ש|חדר\s*שינה/,               label: 'חדר שינה' },
  { re: /חדר\s*ילד/,                      label: 'חדר ילדים' },
  { re: /אמבטיה/,                         label: 'אמבטיה' },
  { re: /שירותי\s*אורחים/,               label: 'שירותי אורחים' },
  { re: /שירותים?/,                       label: 'שירותים' },
  { re: /מסדרון|פרוזדור/,                label: 'מסדרון' },
  { re: /כניסה\s+(?:ראשית|לדירה)/,       label: 'כניסה' },
  { re: /מרפסת\s*(?:שירות|כביסה)/,       label: 'מרפסת שירות' },
  { re: /מרפסת/,                          label: 'מרפסת' },
  { re: /מסתור\s*כביסה|חדר\s*כביסה/,    label: 'חדר כביסה' },
  { re: /ממ"ד|מרחב\s*מוגן/,             label: 'ממ"ד' },
  { re: /מחסן/,                           label: 'מחסן' },
  { re: /חניה|חנייה|חנות/,              label: 'חניה' },
  { re: /מרתף/,                           label: 'מרתף' },
  { re: /גג\b/,                           label: 'גג' },
  { re: /חצר|גינה/,                      label: 'חצר' },
];

function tryRescueRoom(text) {
  for (const { re, label } of ROOM_RESCUE_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

// ── Work Type inference ──────────────────────────────────────────────────────

function inferWorkType(rec) {
  const r = rec || '';
  if (/לפרק.*מחדש|פירוק\s+ו|לפרק.*ולרצף|לפרק.*ולחפות/.test(r)) return 'demolish_redo';
  if (/להחליף|החלפה|לרכוש\s+(?:חדש|תחליף)/.test(r))              return 'replacement';
  if (/להשלים|השלמה|לסיים\s+(?:את\s+)?(?:ה)?עבודה/.test(r))       return 'completion';
  if (/לאטום|מילוי\s+גמיש|חומר\s+איטום|לבצע\s+איטום/.test(r))     return 'sealing';
  if (/לצבוע|צביעה\s+חוזרת|לסייד|לצבוע\s+מחדש/.test(r))           return 'painting';
  if (/להתקין|התקנה|להרכיב|לחבר\s+(?:את\s+)?ה/.test(r))            return 'installation';
  if (/לנקות|ניקוי\s+יסודי|לנגב|להסיר\s+(?:לכלוך|כתם)/.test(r))   return 'cleaning';
  if (/ליישר|יישור|לכוונן|כוונון|להגביה|להשפיל/.test(r))           return 'alignment';
  if (/הזרקה|להזריק|פוליאוריתן/.test(r))                            return 'injection';
  return 'repair';
}

const VALID_SEV = ['critical','high','medium','low','cosmetic'];

function step4_schema(rawDefects) {
  return rawDefects.map((d, i) => {
    const sev = VALID_SEV.includes(d.s) ? d.s : 'medium';
    const pageNum = parseInt(d.p) || 1;
    const rawArea = (d.area || 'כללי').trim();
    // If area looks like a work-type section name, try to rescue the physical room from defect text
    const area = WORK_TYPE_AREA_RE.test(rawArea)
      ? (tryRescueRoom((d.t || '') + ' ' + (d.ds || '') + ' ' + (d.rec || '')) || rawArea)
      : rawArea;
    // Guard: if LLM mistakenly put the room name as the title, use desc instead
    const rawTitle = (d.t || '').trim();
    const title = rawTitle === area || rawTitle === '' ? (d.ds || d.t || '') : rawTitle;
    const desc = d.ds || rawTitle || '';
    const catObj = guessCategory(title, desc);
    const costs = COST_TABLE[catObj.costKey] || COST_TABLE['כללי'];
    const reportCost = parseInt((d.c || '').toString().replace(/[^\d]/g, '')) || 0;
    const cMin = reportCost >= 200 ? Math.round(reportCost * 0.9) : costs.min;
    const cMax = reportCost >= 200 ? Math.round(reportCost * 1.1) : costs.max;
    const costSource = d._cs || (reportCost >= 200 ? 'report' : 'estimate');
    return {
      id: i,
      area,
      title,
      desc,
      action: (d.rec && d.rec.trim() !== desc.trim()) ? d.rec : '',
      sev,
      pageNum,
      page: `עמוד ${pageNum}`,
      cMin,
      cMax,
      costSource,
      quote: d.q || '',
      category:      catObj.code,
      categoryLabel: catObj.label,
      workType:      inferWorkType(d.rec || desc),
      standardRef:     d.std  || '',
      archetypeSource: d._arch || '',
      bbox:          validateBbox(d.bbox),
      simplified_explanation: d.simplified_explanation || '',
    };
  });
}

// ── parseDefects ─────────────────────────────────────────────────────────────

function parseDefects(raw) {
  const tryParse = (s) => {
    try {
      const pr = JSON.parse(s);
      if (Array.isArray(pr)) return pr;
      return pr?.d || pr?.defects || [];
    } catch { return null; }
  };
  let cleaned = (raw || '')
    .replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();

  let result = tryParse(cleaned);
  if (result) return result;

  // Try to find a bare JSON array first
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    result = tryParse(arrMatch[0]);
    if (result) return result;
  }

  // Try to find JSON object
  const objMatch = cleaned.match(/\{[\s\S]*/);
  if (objMatch) {
    result = tryParse(objMatch[0]);
    if (result) return result;

    // Fix truncated JSON using brace counting to find last complete object
    const str = objMatch[0];
    const arrStart = str.indexOf('[');
    if (arrStart >= 0) {
      let depth = 0, lastCompleteEnd = -1;
      for (let i = arrStart; i < str.length; i++) {
        if (str[i] === '{') depth++;
        else if (str[i] === '}') {
          depth--;
          if (depth === 0) lastCompleteEnd = i;
        }
      }
      if (lastCompleteEnd > arrStart) {
        // Reconstruct: take everything up to last complete object, close array+wrapper
        const prefix = str.slice(0, arrStart + 1);
        const inner = str.slice(arrStart + 1, lastCompleteEnd + 1).replace(/,\s*$/, '');
        const fixed = prefix + inner + ']}';
        result = tryParse(fixed);
        if (result) return result;
      }
    }
  }
  return [];
}

function parseRetryMs(text) {
  const m = text.match(/try again in (?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
  if (!m) return null;
  return ((parseInt(m[1] || 0) * 60) + parseFloat(m[2])) * 1000 + 2000;
}

// ── Generic HTTP helper ──────────────────────────────────────────────────────

function postJSON(opts, body, callback) {
  const req = https.request(opts, res => {
    const parts = [];
    res.on('data', c => parts.push(c));
    res.on('end', () => callback(null, res.statusCode, Buffer.concat(parts).toString('utf8')));
  });
  req.setTimeout(90000, () => {
    req.destroy(new Error('provider timeout after 90s'));
  });
  req.on('error', callback);
  req.write(body);
  req.end();
}

// ── Provider: Groq ───────────────────────────────────────────────────────────

function groqCall(_, system, user, callback, attempt = 1) {
  let key = null;
  for (let i = 0; i < GROQ_KEYS.length; i++) {
    const idx = (groqKeyIdx + i) % GROQ_KEYS.length;
    if (!groqKeyExhausted.has(idx)) { groqKeyIdx = idx; key = GROQ_KEYS[idx]; break; }
  }
  if (!key) return callback(new Error('Groq exhausted'));

  const body = JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role:'system', content:system }, { role:'user', content:user }],
    max_tokens: 6144,
    temperature: 0
  });
  postJSON({
    hostname: 'api.groq.com', path: '/openai/v1/chat/completions', method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${key}`, 'Content-Length':Buffer.byteLength(body) }
  }, body, (err, status, text) => {
    if (err) return callback(err);
    if (status === 429) {
      if (text.includes('TPD') || text.includes('per day')) {
        groqKeyExhausted.add(GROQ_KEYS.indexOf(key));
        return groqCall(_, system, user, callback, attempt);
      }
      if (attempt <= 3) {
        const wait = parseRetryMs(text) || 65000;
        return setTimeout(() => groqCall(_, system, user, callback, attempt + 1), wait);
      }
      return callback(new Error('Groq rate limited'));
    }
    if (status !== 200) return callback(new Error('Groq ' + status));
    try {
      const js = JSON.parse(text);
      callback(null, js.choices?.[0]?.message?.content || '');
    } catch(e) { callback(e); }
  });
}

// ── Provider: Cerebras ───────────────────────────────────────────────────────

function cerebrasCall(model, system, user, callback, attempt = 1) {
  if (!CEREBRAS_KEY) return callback(new Error('No Cerebras key'));
  const body = JSON.stringify({
    model: model || 'llama3.1-8b',
    messages: [{ role:'system', content:system }, { role:'user', content:user }],
    max_tokens: 8192,
    temperature: 0
  });
  postJSON({
    hostname: 'api.cerebras.ai', path: '/v1/chat/completions', method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${CEREBRAS_KEY}`, 'Content-Length':Buffer.byteLength(body) }
  }, body, (err, status, text) => {
    if (err) return callback(err);
    if ((status === 429 || status === 503) && attempt <= 3) {
      return setTimeout(() => cerebrasCall(model, system, user, callback, attempt + 1), 5000 * attempt);
    }
    if (status !== 200) return callback(new Error('Cerebras ' + status));
    try {
      const js = JSON.parse(text);
      callback(null, js.choices?.[0]?.message?.content || '');
    } catch(e) { callback(e); }
  });
}

// ── Provider: Gemini (Google AI Studio) ──────────────────────────────────────

function geminiCall(model, system, user, callback, attempt = 1) {
  if (!GEMINI_KEY) return callback(new Error('No Gemini key'));
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 8192 }
  });
  postJSON({
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body) }
  }, body, (err, status, text) => {
    if (err) return callback(err);
    if (status === 429) {
      // Single retry with 8s — fail fast so tryProviders can move to next model
      // (providerCooldown in tryProviders prevents re-trying this model for 65s)
      if (attempt === 1) return setTimeout(() => geminiCall(model, system, user, callback, 2), 8000);
      return callback(new Error('Gemini 429 rate-limited'));
    }
    if (status === 503 && attempt <= 2) {
      return setTimeout(() => geminiCall(model, system, user, callback, attempt + 1), 4000 * attempt);
    }
    if (status !== 200) return callback(new Error('Gemini ' + status + ': ' + text.slice(0, 100)));
    try {
      const js = JSON.parse(text);
      const out = js.candidates?.[0]?.content?.parts?.[0]?.text || '';
      callback(null, out);
    } catch(e) { callback(e); }
  });
}

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
      callback(null, parseDefects(out));
    } catch (e) { callback(e); }
  });
}

// Per-section vision extraction prompt — includes section name for room attribution
const SCAN_SECTION_PROMPT = `אתה מנתח דוח בדק-בית סרוק. חלץ את כל הליקויים מהעמודים: {PAGES}.
שם החדר/האזור הנוכחי: "{ROOM}". השתמש בשם זה בשדה area לכל הליקויים.
לכל ליקוי: אם יש צילום רלוונטי — החזר bbox [ymin,xmin,ymax,xmax] בקואורדינטות 0-1000; אחרת bbox=null.
החזר JSON בלבד, ללא backticks:
{"defects":[{"t":"כותרת קצרה","ds":"תיאור מלא","s":"critical|high|medium|low|cosmetic","p":מספר_עמוד,"c":"עלות אם מופיעה","rec":"פעולה נדרשת","area":"{ROOM}","bbox":[...] or null}]}`;

// Extract defects from a single section of a scanned PDF (reuses uploaded fileUri).
function geminiVisionExtractSection(fileUri, sectionName, pages, callback, attempt = 1) {
  if (!GEMINI_KEY) return callback(new Error('No Gemini key'));
  const prompt = SCAN_SECTION_PROMPT
    .replace(/{PAGES}/g, pages.join(', '))
    .replace(/{ROOM}/g, sectionName);
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [
      { fileData: { fileUri, mimeType: 'application/pdf' } },
      { text: prompt },
    ]}],
    generationConfig: { temperature: 0, maxOutputTokens: 16384 },
  });
  postJSON({
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/${VISION.model}:generateContent?key=${GEMINI_KEY}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, body, (err, status, text) => {
    if (err) return callback(err);
    if ((status === 429 || status === 503) && attempt <= 2) {
      return setTimeout(() => geminiVisionExtractSection(fileUri, sectionName, pages, callback, attempt + 1), 8000 * attempt);
    }
    if (status !== 200) return callback(new Error('ScanSection ' + status + ': ' + text.slice(0, 120)));
    try {
      const js = JSON.parse(text);
      const out = js.candidates?.[0]?.content?.parts?.[0]?.text || '';
      callback(null, parseDefects(out).map(d => ({ ...d, area: sectionName })));
    } catch (e) { callback(e); }
  });
}

// Full-document scan for scanned PDFs: upload once, extract per section in parallel.
// Best-effort — never errors, always returns array (possibly empty).
function scanExtractPerSection(pdfBase64, sections, log, callback) {
  if (!VISION.enabled || !pdfBase64 || !sections.length) return callback([]);
  log.push(`[ScanExtract] uploading PDF for per-section extraction (${sections.length} sections)...`);
  geminiUploadFile(pdfBase64, (upErr, file) => {
    if (upErr) { log.push('[ScanExtract] ✗ upload: ' + upErr.message); return callback([]); }
    log.push('[ScanExtract] upload ok');
    const allDefects = [];
    let nextIdx = 0, pending = 0, finished = false;
    const SCAN_CONC = 2;
    function finish() {
      if (finished) return; finished = true;
      geminiDeleteFile(file.name, () => {});
      log.push(`[ScanExtract] ✓ ${allDefects.length} ליקויים מ-${sections.length} סקשנים`);
      callback(allDefects);
    }
    function runNext() {
      while (pending < SCAN_CONC && nextIdx < sections.length) {
        const sec = sections[nextIdx++];
        const pages = [];
        for (let p = sec.startPage; p <= sec.endPage; p++) pages.push(p);
        pending++;
        geminiVisionExtractSection(file.uri, sec.name, pages, (err, defs) => {
          pending--;
          if (err) log.push(`[ScanExtract] ✗ ${sec.name}: ${err.message}`);
          else { log.push(`[ScanExtract] ${sec.name}: ${(defs||[]).length} ליקויים`); allDefects.push(...(defs||[])); }
          if (nextIdx < sections.length) runNext();
          else if (pending === 0) finish();
        });
      }
      if (nextIdx >= sections.length && pending === 0) finish();
    }
    runNext();
  });
}

// Parallel vision path. Best-effort: NEVER calls callback(err) — always (null, defects).
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
      geminiDeleteFile(file.name, () => {});
      if (exErr) { log.push('[Vision] ✗ extract: ' + exErr.message); return callback(null, []); }
      const defects = step4_schema(rawDefects || []);
      const withBox = defects.filter(d => d.bbox).length;
      log.push(`[Vision] ${defects.length} ליקויים, ${withBox} bbox`);
      callback(null, defects);
    });
  });
}

// Vision-based STRUCTURE pass — used when text-based step1_llm fails on a
// scanned PDF (sparse/empty text layer). Gemini reads the scanned pages and
// returns a section map (room/area → page range), reusing parseStep1Json.
const VISION_STRUCT_PROMPT = `אתה מנתח דוח בדק-בית סרוק (PDF). קרא את העמודים וזהה את מבנה המסמך — חלק אותו לסקשנים לפי חדר / אזור / מערכת.
לכל סקשן החזר שם וטווח עמודים. כסה רק עמודים עם ממצאים.
החזר JSON בלבד, ללא backticks:
{"sections":[{"name":"שם החדר/אזור","startPage":מספר,"endPage":מספר}]}`;

function geminiVisionStructure(fileUri, cleanText, callback, attempt = 1) {
  if (!GEMINI_KEY) return callback(new Error('No Gemini key'));
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [
      { fileData: { fileUri, mimeType: 'application/pdf' } },
      { text: VISION_STRUCT_PROMPT },
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
    if (status === 429 && attempt === 1) return setTimeout(() => geminiVisionStructure(fileUri, cleanText, callback, 2), 8000);
    if (status === 503 && attempt <= 2) return setTimeout(() => geminiVisionStructure(fileUri, cleanText, callback, attempt + 1), 4000 * attempt);
    if (status !== 200) return callback(new Error('VisionStruct ' + status + ': ' + text.slice(0, 100)));
    try {
      const js = JSON.parse(text);
      const out = js.candidates?.[0]?.content?.parts?.[0]?.text || '';
      callback(null, parseStep1Json(out, cleanText));
    } catch (e) { callback(e); }
  });
}

// Best-effort: returns a sectionMap or null (never errors). Own upload+cleanup.
function visionStructurePath(pdfBase64, pageMeta, cleanText, log, callback) {
  if (!VISION.enabled || !pdfBase64) return callback(null);
  if (!detectVisualPages(pageMeta).length) return callback(null);
  log.push('[VisionStruct] text-step1 failed — deriving structure from scanned pages');
  geminiUploadFile(pdfBase64, (upErr, file) => {
    if (upErr) { log.push('[VisionStruct] ✗ upload: ' + upErr.message); return callback(null); }
    geminiVisionStructure(file.uri, cleanText, (exErr, sectionMap) => {
      geminiDeleteFile(file.name, () => {});
      if (exErr || !sectionMap || !sectionMap.sections || !sectionMap.sections.length) {
        log.push('[VisionStruct] ✗ ' + (exErr ? exErr.message : 'no sections'));
        return callback(null);
      }
      log.push(`[VisionStruct] ✓ ${sectionMap.sections.length} סקשנים`);
      callback(sectionMap);
    });
  });
}

// ── Provider: OpenRouter ─────────────────────────────────────────────────────

function openrouterCall(_, system, user, callback, attempt = 1) {
  if (!OPENROUTER_KEY) return callback(new Error('No OpenRouter key'));
  const body = JSON.stringify({
    model: _ || 'deepseek/deepseek-r1:free',
    messages: [{ role:'system', content:system }, { role:'user', content:user }],
    max_tokens: 4096,
    temperature: 0
  });
  postJSON({
    hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
    headers: {
      'Content-Type':'application/json',
      'Authorization':`Bearer ${OPENROUTER_KEY}`,
      'Content-Length':Buffer.byteLength(body),
      'HTTP-Referer':'http://localhost:339',
      'X-Title':'Bedekli'
    }
  }, body, (err, status, text) => {
    if (err) return callback(err);
    if ((status === 429 || status === 503) && attempt <= 2) {
      return setTimeout(() => openrouterCall(_, system, user, callback, attempt + 1), 5000 * attempt);
    }
    if (status !== 200) return callback(new Error('OpenRouter ' + status));
    try {
      const js = JSON.parse(text);
      callback(null, js.choices?.[0]?.message?.content || '');
    } catch(e) { callback(e); }
  });
}

// ── Provider Cooldown (rate-limited providers skipped for 65s) ───────────────

const providerCooldowns = {}; // { providerName: cooldownUntilMs }
const providerInFlight  = {}; // { providerName: count } — prevents race-condition pile-up

// ── Provider Cascade ─────────────────────────────────────────────────────────

// FAST: חדרים רגילים — Groq אם קיים, אחרת Gemini
const PROVIDERS_FAST = [
  { name: 'groq-70b',          check: () => GROQ_KEYS.length > 0 && GROQ_KEYS.length > groqKeyExhausted.size, call: groqCall,       model: 'llama-3.3-70b-versatile' },
  { name: 'gemini-flash',      check: () => !!GEMINI_KEY,                                                     call: geminiCall,     model: 'gemini-2.5-flash' },
  { name: 'gemini-flash-lite', check: () => !!GEMINI_KEY,                                                     call: geminiCall,     model: 'gemini-2.5-flash-lite' },
  { name: 'openrouter-llm',    check: () => !!OPENROUTER_KEY,                                                 call: openrouterCall, model: 'meta-llama/llama-3.3-70b-instruct:free' },
  { name: 'cerebras-qwen',     check: () => !!CEREBRAS_KEY,                                                   call: cerebrasCall,   model: 'qwen-3-235b-a22b-instruct-2507' },
];

// LARGE: catch-all ועמודים ארוכים — context גדול + output 65K
const PROVIDERS_LARGE = [
  { name: 'groq-70b',          check: () => GROQ_KEYS.length > 0 && GROQ_KEYS.length > groqKeyExhausted.size, call: groqCall,       model: 'llama-3.3-70b-versatile' },
  { name: 'gemini-flash',      check: () => !!GEMINI_KEY,                                                     call: geminiCall,     model: 'gemini-2.5-flash' },
  { name: 'gemini-flash-lite', check: () => !!GEMINI_KEY,                                                     call: geminiCall,     model: 'gemini-2.5-flash-lite' },
  { name: 'openrouter-llm',    check: () => !!OPENROUTER_KEY,                                                 call: openrouterCall, model: 'meta-llama/llama-3.3-70b-instruct:free' },
  { name: 'cerebras-qwen',     check: () => !!CEREBRAS_KEY,                                                   call: cerebrasCall,   model: 'qwen-3-235b-a22b-instruct-2507' },
];

// STRUCT: step1_llm only — Gemini-first for superior JSON section detection
// Intentionally different from PROVIDERS_FAST to avoid rate-limit collision during step3
const PROVIDERS_STRUCT = [
  { name: 'gemini-flash',      check: () => !!GEMINI_KEY,                                                     call: geminiCall,     model: 'gemini-2.5-flash' },
  { name: 'gemini-flash-lite', check: () => !!GEMINI_KEY,                                                     call: geminiCall,     model: 'gemini-2.5-flash-lite' },
  { name: 'groq-70b',          check: () => GROQ_KEYS.length > 0 && GROQ_KEYS.length > groqKeyExhausted.size, call: groqCall,       model: 'llama-3.3-70b-versatile' },
  { name: 'openrouter-llm',    check: () => !!OPENROUTER_KEY,                                                 call: openrouterCall, model: 'meta-llama/llama-3.3-70b-instruct:free' },
  { name: 'cerebras-qwen',     check: () => !!CEREBRAS_KEY,                                                   call: cerebrasCall,   model: 'qwen-3-235b-a22b-instruct-2507' },
];

// תאימות אחורה
const PROVIDERS = PROVIDERS_FAST;

function tryProviders(system, user, log, callback, idx = 0, providers = PROVIDERS_FAST, _tr = {}) {
  const now = Date.now();
  let shortestCooldown = Infinity;
  let scanIdx = idx;
  while (scanIdx < providers.length) {
    const p = providers[scanIdx];
    if (!p.check()) { scanIdx++; continue; }
    const cd = (providerCooldowns[p.name] || 0) - now;
    if (cd <= 0) break; // this provider is available
    shortestCooldown = Math.min(shortestCooldown, cd);
    scanIdx++;
  }

  while (idx < providers.length) {
    const p = providers[idx];
    const onCooldown = (providerCooldowns[p.name] || 0) > now;
    const busy = (providerInFlight[p.name] || 0) >= 2;
    if (!p.check() || onCooldown || busy) {
      if (onCooldown) log.push(`  [${p.name}] ⏭ cooldown`);
      else if (busy) log.push(`  [${p.name}] ⏭ busy`);
      idx++;
      continue;
    }
    break;
  }
  if (idx >= providers.length) {
    if (shortestCooldown < Infinity && shortestCooldown < 120000) {
      const wait = shortestCooldown + 1000;
      log.push(`  [wait] כל הספקים בcooldown — ממתין ${Math.round(wait/1000)}ש`);
      return setTimeout(() => tryProviders(system, user, log, callback, 0, providers, _tr), wait);
    }
    return callback(new Error('All providers exhausted'));
  }
  const p = providers[idx];
  providerInFlight[p.name] = (providerInFlight[p.name] || 0) + 1;
  p.call(p.model, system, user, (err, result) => {
    providerInFlight[p.name] = Math.max(0, (providerInFlight[p.name] || 1) - 1);
    if (err) {
      log.push(`  [${p.name}] ✗ ${err.message.slice(0, 60)}`);
      if (/429|rate.limit|cooldown/i.test(err.message)) {
        providerCooldowns[p.name] = Date.now() + 65000;
        log.push(`  [${p.name}] → cooldown 65s`);
        return tryProviders(system, user, log, callback, idx + 1, providers, _tr);
      }
      if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(err.message)) {
        const r = (_tr[p.name] = (_tr[p.name] || 0) + 1);
        if (r <= 2) {
          log.push(`  [${p.name}] ↻ רשת — ניסיון ${r}/2`);
          return setTimeout(() => tryProviders(system, user, log, callback, idx, providers, _tr), 2000);
        }
        log.push(`  [${p.name}] ✗ רשת — עבר לבא בתור`);
        return tryProviders(system, user, log, callback, idx + 1, providers, _tr);
      }
      return tryProviders(system, user, log, callback, idx + 1, providers, _tr);
    }
    if (!result || !result.trim()) {
      log.push(`  [${p.name}] ✗ empty response → cascade`);
      return tryProviders(system, user, log, callback, idx + 1, providers, _tr);
    }
    if (!result.includes('{') && !result.includes('[')) {
      log.push(`  [${p.name}] ✗ no JSON in response → cascade`);
      return tryProviders(system, user, log, callback, idx + 1, providers, _tr);
    }
    log.push(`  [${p.name}] ✓`);
    callback(null, result, p.name);
  });
}

// ── Step 3: Targeted Extraction (per room) ───────────────────────────────────

const SHORT_PROMPT = `חלץ ליקויים מטקסט בדק בית בעברית. JSON בלבד ללא backticks.
פורמט: {"d":[{"t":"כותרת ספציפית","ds":"תיאור מלא ומעמיק","rec":"פעולה נדרשת לתיקון (5-12 מילים)","s":"sev","p":מספר_עמוד,"q":"ציטוט מורחב מהדוח","c":עלות_בשקלים,"area":"שם חדר/מיקום"}]}

sev:
- critical = מסוכן (בטיחות: מעקה רופף, זכוכיות לא מוצמדות, סדק קונסטרוקטיבי, סכנת התחשמלות, דליפת גז)
- high = ליקוי הנדסי/תפקודי (דליפה, שיפוע ניקוז כושל, חלון לא נסגר)
- medium = ליקוי בינוני (אריחים לא ישרים, חורים בקיר, חיתוכי יתר)
- low = ליקוי קל (שריטה, פגם קל)
- cosmetic = פגם אסתטי בלבד

חשוב:
- t = 5-10 מילים שמתארות בדיוק מה שגוי — לא שם החדר!
  ✓ "גדר חיצונית לא הושלמה — חסרה רשת מתיחה"
  ✓ "חיתוך לקוי של אריח בפינת הקיר הצפוני"
  ✓ "חלון ממ\"ד לא נסגר עד הסוף"
  ✗ "לא הושלמה גדר" (קצר מדי, לא מסביר)
  ✗ "ליקוי בריצוף" (כללי מדי)

- ds = 30-60 מילים: תאר מה הבעיה, היכן בדיוק, ומה ההשלכה המעשית.
  חייב לכלול: (א) מה הבעיה הספציפית, (ב) היכן היא מופיעה, (ג) מה המשמעות/הסכנה
  ✓ "גדר הגבול בצד המזרחי של הנכס הותקנה חלקית — עמודי הברזל נעוצים אך הרשת טרם נמתחה. עד להשלמה הגבול פתוח ואין הפרדה מהשכנים."
  ✗ "גדר לא הושלמה" (קצר מדי)

- q = ציטוט מהדוח עד 50 מילים — חייב להיות שונה מ-t!
  העדף משפטי הסבר שמופיעים בדוח אחרי הכותרת, לא את הכותרת עצמה.
  אם יש כמה משפטי תיאור — כלול את כולם עד 50 מילים.
  אם בדוח יש רק את שם הליקוי ללא הסבר נוסף — צטט בדיוק מה שכתוב גם אם קצר.

- rec = פעולה קצרה וספציפית: "להחליף את האריח הסדוק" / "לאטום הסדק עם חומר גמיש" / "לכוונן את הדלת מחדש"
  חייב להיות שונה מ-ds!

- c = עלות בשקלים כפי שמצוין בדוח ליד ליקוי זה — מספר שלם בלבד, ללא סימנים (0 אם לא מצוין)
  אם בטקסט כתוב "עלות משוערת: 3,500 ₪" → c: 3500
  אם מצוין hint עלויות בשורת [עלויות שנמצאו בעמודים] — השתמש בו לסיוע בזיהוי
  אם לא מצוין עלות ← c: 0

- שפת אדם פשוטה: "יש סדקים על הקיר" ולא "נסדקות ממשקי חיפוי"
- דלג על תקנים, ציטוטי סעיפים, פסקאות מבוא
- כל פריט בולט (▪ או מספור) הוא ליקוי נפרד
- p = מספר עמוד שמופיע ב"[עמוד N]" הקרוב

- area = החדר/המיקום הפיזי בנכס בלבד.
  ✓ מותר: סלון, מטבח, חדר שינה, ממ"ד, מרפסת, מסדרון, כביסה, גג, חצר, שירותים, אמבטיה, כניסה, חדר הורים
  ✗ אסור: ריצוף, אלומיניום, קרמיקה, חשמל, איטום, נגרות, אינסטלציה, רטיבות (אלה קטגוריות — לא מיקום!)
  אם הטקסט מציין מיקום פיזי — חלץ אותו. אם לא — החזר ""`;

const SIMPLIFY_PROMPT = `אתה מומחה להנגשת מידע טכני לקהל הרחב בישראל.
קיבלת מערך JSON של ליקויי בדק בית. עבור כל ליקוי, מלא את שדה simplified_explanation.

כללי כתיבה:
1. עד 2 משפטים. ענה על: מה הבעיה? למה חשוב? מה קורה אם לא מטפלים?
2. מינוח: אשפרה→איטום, מישקים→פרזול, קפילריות→ספיגת לחות, קונסטרוקציה→מבנה נושא, ריצוף צף→ריצוף לא מחובר, מיסב→תושבת, כשל קפילרי→חדירת לחות
3. אל תמציא פרטים שלא מופיעים ב-title/description/action.
4. גוף שלישי, לא פנייה ישירה.

החזר JSON בלבד, ללא backticks: [{...אותם שדות..., "simplified_explanation":"..."}]`;

const CONCURRENCY = 4;
const BATCH_SIZE = 15;
const MIN_STAGGER = 400; // ms between consecutive slot launches
const PAGES_PER_CHUNK = 5;
const MAX_CHARS_PER_CHUNK = 8000;

// ── Step 0c: Archetype Detection ─────────────────────────────────────────────

function step0c_detectArchetype(cleanText) {
  _ensureDetector();
  const profiles = _archetypeDetector.loadProfiles();
  const companyName = _archetypeDetector.extractCompanyName(cleanText.slice(0, 800), profiles);
  return _archetypeDetector.detectArchetypeSync(cleanText, companyName);
}

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

function buildStep3Tasks(byRoom, costMap, archetype) {
  archetype = archetype || 'UNKNOWN';
  _ensureDetector();
  const tasks = [];
  const rooms = Object.keys(byRoom).filter(r => byRoom[r].length >= 30);
  for (const room of rooms) {
    const text = byRoom[room];
    const pageMatches = [...text.matchAll(/\[עמוד (\d+)\]([\s\S]*?)(?=\[עמוד \d+\]|$)/g)];
    const pages = pageMatches.map(m => ({ num: parseInt(m[1]), block: m[0] }));
    const pageCount = pages.length;

    const chunks = [];
    if (pages.length === 0) {
      chunks.push({ pageNums: [], text });
    } else {
      let cur = [];
      let curLen = 0;
      for (const p of pages) {
        if (cur.length && (cur.length >= PAGES_PER_CHUNK || curLen + p.block.length > MAX_CHARS_PER_CHUNK)) {
          chunks.push({ pageNums: cur.map(x => x.num), text: cur.map(x => x.block).join('').trim() });
          cur = [];
          curLen = 0;
        }
        cur.push(p);
        curLen += p.block.length;
      }
      if (cur.length) chunks.push({ pageNums: cur.map(x => x.num), text: cur.map(x => x.block).join('').trim() });
    }

    // Sub-split each page-level chunk by defect boundary using the detected archetype.
    // This fixes Bug #2: large blocks that contain 50+ defects were sent as one LLM call,
    // causing only 2-3 defects to be returned (context window overflow).
    const allSubChunks = [];
    for (const c of chunks) {
      const subParts = _archetypeDetector.splitByDefectBoundary(c.text, archetype);
      for (const part of subParts) {
        allSubChunks.push({ pageNums: c.pageNums, text: part });
      }
    }

    const totalChunks = allSubChunks.length;
    allSubChunks.forEach((c, idx) => {
      const costHints = c.pageNums
        .filter(p => costMap[p] && costMap[p].length)
        .map(p => `עמוד ${p}: ${costMap[p].map(v => '₪' + v.toLocaleString()).join(', ')}`)
        .join(' | ');
      const costHintLine = costHints ? `\n[עלויות שנמצאו בעמודים אלו: ${costHints}]\n` : '';
      const isLarge = pageCount > 3 || /כלל|שונות|ממצא/.test(room) || totalChunks > 1;
      tasks.push({ room, chunkIdx: idx, totalChunks, text: c.text, isLarge, costHintLine });
    });
  }
  return tasks;
}

function step3e_simplify(defects, log, callback) {
  if (!defects || defects.length === 0) return callback([]);

  const _t3e = Date.now();
  const batches = [];
  for (let i = 0; i < defects.length; i += BATCH_SIZE) {
    batches.push(defects.slice(i, i + BATCH_SIZE));
  }

  const result = new Array(defects.length);
  let batchIdx = 0;

  function nextBatch() {
    if (batchIdx >= batches.length) {
      log.push(`[Step 3e] -> ${result.length} ליקויים הונגשו, ${Date.now() - _t3e}ms`);
      return callback(result);
    }
    const batch = batches[batchIdx];
    const startIdx = batchIdx * BATCH_SIZE;
    batchIdx++;

    const userMsg = JSON.stringify(
      batch.map(d => ({
        title:       d.title || '',
        description: d.desc || '',
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

function step3_extract(byRoom, costMap, callback, archetype) {
  const log = [];
  const allDefects = [];
  const tasks = buildStep3Tasks(byRoom, costMap, archetype);
  const _arcRules = getArchetypeRules(archetype || 'UNKNOWN');
  const _arcBlock = buildArchetypeBlock(_arcRules);
  let nextIdx = 0;
  let pending = 0;
  const results = new Array(tasks.length);

  function dispatch() {
    let slotLaunch = 0;
    while (pending < CONCURRENCY && nextIdx < tasks.length) {
      const i = nextIdx++;
      pending++;
      const t = tasks[i];
      const providers = t.isLarge ? PROVIDERS_LARGE : PROVIDERS_FAST;
      const chunkLabel = t.totalChunks > 1 ? ` (חלק ${t.chunkIdx + 1}/${t.totalChunks})` : '';
      const userMsg = `חדר: ${t.room}${chunkLabel}${t.costHintLine}${_arcBlock ? '\n' + _arcBlock : ''}\n\nטקסט:\n${t.text}\n\nחלץ ליקויים. JSON בלבד.`;
      const subLog = [];
      const delay = slotLaunch++ * MIN_STAGGER + Math.floor(Math.random() * 200);

      setTimeout(() => {
        const ck = `step3_${chunkHash(t.room + t.chunkIdx, t.text)}`;
        const cachedChunk = cacheGet(ck);
        if (cachedChunk) {
          subLog.push(`  cache hit`);
          results[i] = { task: t, subLog, err: null, raw: cachedChunk, fromCache: true };
          pending--;
          dispatch();
          if (pending === 0 && nextIdx >= tasks.length) finish();
          return;
        }
        tryProviders(SHORT_PROMPT, userMsg, subLog, (err, raw) => {
          if (!err && raw) cacheSet(ck, raw);
          results[i] = { task: t, subLog, err, raw };
          pending--;
          dispatch();
          if (pending === 0 && nextIdx >= tasks.length) finish();
        }, 0, providers);
      }, delay);
    }
  }

  function finish() {
    const byRoomResults = {};
    results.forEach(r => {
      if (!r) return;
      const key = r.task.room;
      if (!byRoomResults[key]) byRoomResults[key] = [];
      byRoomResults[key].push(r);
    });

    let stepIdx = 0;
    for (const [room, rs] of Object.entries(byRoomResults)) {
      stepIdx++;
      const isLarge = rs.some(r => r.task.isLarge);
      const chunkSuffix = rs.length > 1 ? ` (${rs.length} chunks)` : '';
      log.push(`[Step 3.${stepIdx} - ${room}]${isLarge ? ' [LARGE]' : ''}${chunkSuffix}`);
      let total = 0;
      let failed = 0;
      rs.sort((a, b) => a.task.chunkIdx - b.task.chunkIdx).forEach(r => {
        const prefix = r.task.totalChunks > 1 ? `  [chunk ${r.task.chunkIdx + 1}/${r.task.totalChunks}]` : '';
        r.subLog.forEach(l => log.push(prefix ? `${prefix} ${l}` : l));
        if (r.err) { failed++; return; }
        const defects = parseDefects(r.raw).map(d => ({ ...d, area: (d.area && d.area.trim()) ? d.area.trim() : room }));
        allDefects.push(...defects);
        total += defects.length;
      });
      if (failed === rs.length) log.push(`  → 0 ליקויים (כל הספקים נפלו)`);
      else log.push(`  → ${total} ליקויים${failed ? ` (${failed} chunks נכשלו)` : ''}`);
    }

    // Retry pass — rooms with 0 defects get one sequential retry
    const zeroRooms = Object.entries(byRoomResults)
      .filter(([, rs]) => rs.every(r => r.err || parseDefects(r.raw || '').length === 0))
      .map(([room]) => room);

    if (zeroRooms.length === 0) return callback(null, allDefects, log);

    log.push(`[Step 3 retry] ${zeroRooms.length} חדרים עם 0 ליקויים — retry סדרתי`);
    let retryIdx = 0;
    function retryNext() {
      if (retryIdx >= zeroRooms.length) return callback(null, allDefects, log);
      const room = zeroRooms[retryIdx++];
      const roomText = byRoom[room] || '';
      if (!roomText.trim()) return retryNext();
      const retryLog = [];
      const userMsg = `חדר: ${room}${_arcBlock ? '\n' + _arcBlock : ''}\n\nטקסט:\n${roomText}\n\nחלץ ליקויים. JSON בלבד.`;
      tryProviders(SHORT_PROMPT, userMsg, retryLog, (err, raw) => {
        retryLog.forEach(l => log.push(`  [retry:${room}] ${l}`));
        if (!err && raw) {
          const defects = parseDefects(raw).map(d => ({ ...d, area: (d.area && d.area.trim()) ? d.area.trim() : room }));
          if (defects.length > 0) {
            allDefects.push(...defects);
            log.push(`  [retry:${room}] → ${defects.length} ליקויים`);
          }
        }
        retryNext();
      }, 0, PROVIDERS_LARGE);
    }
    retryNext();
  }

  if (tasks.length === 0) return callback(null, [], log);
  dispatch();
}

function buildCatchAllChunks(cleanPageMap, excludedPages, chunkSize = 5) {
  const unassigned = Object.keys(cleanPageMap).map(Number)
    .filter(p => !excludedPages.has(p)).sort((a, b) => a - b);
  const result = {};
  for (let ci = 0; ci < unassigned.length; ci += chunkSize) {
    const chunk = unassigned.slice(ci, ci + chunkSize);
    const included = chunk.filter(p => {
      const t = `[עמוד ${p}]\n${(cleanPageMap[p] || '').trim()}`;
      return t.length > 20;
    });
    if (included.length > 0) {
      const texts = included
        .map(p => `[עמוד ${p}]\n${(cleanPageMap[p] || '').trim()}`)
        .join('\n\n');
      // Try to detect a section header — strip BiDi marks first
      const BIDI_RE = /[​-‏‪-‮⁦-⁩﻿]/g;
      const SECTION_HEADER_RE = /(?:^|\n)\s*(?:\.?\d+\.?\s*|[א-ת]\.\s*)?(עבודות\s+[א-ת"'\s,]{2,40}|[א-ת"'\s,]{4,40}(?:ריצוף|חשמל|אינסטל|רטיב|נגרות|מסגר|איטום|חיפוי|גבס|מרפסת|גג|שלד|צנרת|מיזוג|צביעה|טיח|פיתוח))/m;
      let detectedLabel = null;
      for (const p of included) {
        const t = (cleanPageMap[p] || '').replace(BIDI_RE, '');
        const m = t.match(SECTION_HEADER_RE);
        if (m) { detectedLabel = m[1].trim().replace(/\s+/g,' ').slice(0, 50); break; }
      }
      const label = detectedLabel
        ? detectedLabel
        : (included.length > 1
          ? `ממצאים כלליים (עמ' ${included[0]}-${included[included.length - 1]})`
          : `ממצאים כלליים (עמ' ${included[0]})`);
      result[label] = texts;
    }
  }
  return result;
}

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

// ── Pipeline Orchestrator ────────────────────────────────────────────────────

function pipeline(pdfText, propertyType, opts, callback) {
  if (typeof opts === 'function') { callback = opts; opts = {}; }
  opts = opts || {};
  const { pdfBase64 = null, pageMeta = null, nocache = false } = opts;
  groqKeyExhausted.clear();
  const t0 = Date.now();
  const fullLog = [];
  fullLog.push('=== ROUTING LOG ===');

  // Final result cache — same PDF always returns same result (vision-aware key)
  const finalCacheKey = `result_${pdfHash(pdfText)}_${propertyType || 'new'}_${detectVisualPages(pageMeta).length ? 'v' : 't'}`;
  const cachedResult = nocache ? null : cacheGet(finalCacheKey);
  if (cachedResult) {
    fullLog.push('[Cache] hit — returning cached analysis');
    fullLog.forEach(l => console.log(l));
    return callback(null, cachedResult);
  }

  // Vision path runs in parallel with the text pipeline (best-effort, post-cache).
  let _visionDone = false, _visionDefects = [];
  const _visionLog = [];
  visionPath(pdfBase64, pageMeta, propertyType, _visionLog, (_e, defs) => {
    _visionDefects = defs || []; _visionDone = true;
  });

  // Step 0 — cost pre-extraction (JS)
  const costMap = step0_extractCosts(pdfText);
  const reportTotal = step0b_extractReportTotal(pdfText);
  fullLog.push(`[Step 0] -> ${Object.keys(costMap).length} עמודים עם עלויות, reportTotal=₪${reportTotal.toLocaleString()}`);

  // Step 2 — filter (לפני step1 כי ה-LLM צריך טקסט נקי)
  const t2 = Date.now();
  const cleanText = step2_filter(pdfText);
  fullLog.push(`[Step 2 - Noise Filtration] -> ${pdfText.length}→${cleanText.length} chars, ${Date.now()-t2}ms`);

  // Step 0c — archetype detection
  const archetypeProfile = step0c_detectArchetype(cleanText);
  fullLog.push(`[Step 0c] archetype=${archetypeProfile.archetype} confidence=${archetypeProfile.confidence}${archetypeProfile.fromCache ? ' (cache)' : ''}`);

  // Build cleanPageMap (shared by step2b and cost-context)
  const cleanPages = cleanText.split(/---\s*עמוד\s*(\d+)\s*---/);
  const cleanPageMap = {};
  for (let i = 1; i < cleanPages.length; i += 2) {
    cleanPageMap[parseInt(cleanPages[i])] = cleanPages[i + 1] || '';
  }

  // Step 1 — LLM structural analysis
  const step1Log = [];
  fullLog.push(`[Step 1 - LLM Structural Analysis] -> starting...`);
  step1_llm(cleanText, step1Log, (sectionMap) => {
    step1Log.forEach(l => fullLog.push('  ' + l));

    let byRoom;
    let costTableText = '';

    if (sectionMap) {
      // LLM success — use exact section boundaries
      const costTablePages = sectionMap.costTablePages || [];
      byRoom = step2b_byRoom(cleanText, sectionMap, costTablePages);
      // Build cost table text for step3b
      costTableText = costTablePages
        .filter(p => cleanPageMap[p])
        .map(p => `[עמוד ${p}]\n${cleanPageMap[p].trim()}`)
        .join('\n\n');
      fullLog.push(`[Step 1] -> LLM זיהה ${sectionMap.sections.length} סקשנים, ${costTablePages.length} עמודי עלויות`);

      // Auto-supplement: if LLM found no cost table pages, fall back to step0 high-density pages
      if (!costTableText.trim()) {
        const sectionPageSet = new Set();
        sectionMap.sections.forEach(({ startPage, endPage }) => {
          for (let p = startPage; p <= endPage; p++) sectionPageSet.add(p);
        });
        const autoPages = Object.entries(costMap)
          .filter(([p, costs]) => costs.length >= 3 && !sectionPageSet.has(Number(p)) && cleanPageMap[Number(p)])
          .map(([p]) => `[עמוד ${p}]\n${cleanPageMap[Number(p)].trim()}`);
        if (autoPages.length) {
          costTableText = autoPages.join('\n\n');
          fullLog.push(`[Step 0] -> auto-detected ${autoPages.length} עמודי עלויות מ-regex`);
        }
      }

      // Catch-all: pages not covered by any section (LLM may leave gaps)
      const coveredPages = new Set();
      sectionMap.sections.forEach(({ startPage, endPage }) => {
        for (let p = startPage; p <= endPage; p++) coveredPages.add(p);
      });
      (costTablePages || []).forEach(p => coveredPages.add(p));
      const unassigned = Object.keys(cleanPageMap).map(Number)
        .filter(p => !coveredPages.has(p)).sort((a, b) => a - b);
      Object.assign(byRoom, buildCatchAllChunks(cleanPageMap, coveredPages));
      if (unassigned.length > 0) fullLog.push(`[Step 1] -> catch-all: ${unassigned.length} עמודים לא משויכים`);
    } else {
      // Text-step1 failed. For scanned PDFs, derive structure via vision before
      // falling back to the generic page-chunk catch-all.
      return visionStructurePath(pdfBase64, pageMeta, cleanText, fullLog, (visionMap) => {
        if (visionMap && visionMap.sections && visionMap.sections.length) {
          sectionMap = visionMap;
          fullLog.push(`[Step 1] -> vision structure: ${sectionMap.sections.length} סקשנים`);
          // Scanned PDF: text is empty — run per-section vision extraction for defects
          if (!cleanText.trim()) {
            return scanExtractPerSection(pdfBase64, sectionMap.sections, fullLog, (scanDefects) => {
              // Inject scan results as vision defects so _afterVision picks them up
              _visionDefects = step4_schema(scanDefects);
              _visionDone = true;
              // Run pipeline with empty byRoom; step3→0 defects; _afterVision fires with scan results
              return runPipeline({});
            });
          }
          byRoom = step2b_byRoom(cleanText, sectionMap, []);
          const coveredPages = new Set();
          sectionMap.sections.forEach(({ startPage, endPage }) => {
            for (let p = startPage; p <= endPage; p++) coveredPages.add(p);
          });
          Object.assign(byRoom, buildCatchAllChunks(cleanPageMap, coveredPages));
          return runPipeline(byRoom);
        }
        // No vision structure available — original direct catch-all.
        fullLog.push('[Step 1] -> LLM failed — catch-all all pages >= 5');
        costTableText = Object.entries(costMap)
          .filter(([, costs]) => costs.length >= 3)
          .map(([p]) => cleanPageMap[p] ? `[עמוד ${p}]\n${cleanPageMap[p].trim()}` : '')
          .filter(Boolean).join('\n\n');
        byRoom = buildCatchAllChunks(cleanPageMap, new Set());
        return runPipeline(byRoom);
      });
    }

    runPipeline(byRoom);

    function runPipeline(bR) {
    // Detect structureType: rooms / floors / systems / chapters
    const FLOOR_RE   = /קומ[הות]|קומת?\s*קרקע|מרתף/;
    const SYSTEMS_RE = /עבודות|חשמל|אינסטלציה|תברואה|ריצוף|איטום|צנרת|מערכת|נגרות|מסגרות|חיפוי|שליכט|רטיבות|שלד/;
    const roomNames  = ['סלון','מטבח','חדר שינה','חדר ילדים','חדר רחצה','אמבטיה','שירותים','מרפסת','פרוזדור','כניסה','מחסן','חניה','לובי','ממ"ד','מרחב מוגן'];
    const allSections = sectionMap ? sectionMap.sections.map(s => s.name) : Object.keys(bR);
    const floorCount   = allSections.filter(n => FLOOR_RE.test(n)).length;
    const systemsCount = allSections.filter(n => SYSTEMS_RE.test(n)).length;
    const matchingCount = allSections.filter(name => roomNames.some(r => name.includes(r))).length;
    let structureType;
    if (allSections.length > 0 && (floorCount / allSections.length) >= 0.4)        structureType = 'floors';
    else if (allSections.length > 0 && (systemsCount / allSections.length) >= 0.4) structureType = 'systems';
    else if (allSections.length > 0 && (matchingCount / allSections.length) >= 0.5) structureType = 'rooms';
    else structureType = 'chapters';
    fullLog.push(`[Structure] type=${structureType} (floors=${floorCount} systems=${systemsCount} rooms=${matchingCount}/${allSections.length})`);

    fullLog.push(`[Step 2b] -> ${Object.keys(bR).length} סקשנים לעיבוד`);

    // Step 3 — extract defects per section
    const t3 = Date.now();
    step3_extract(bR, costMap, (err, rawDefects, step3Log) => {
      if (err) return callback(err);
      step3Log.forEach(l => fullLog.push(l));
      fullLog.push(`[Step 3] -> ${rawDefects.length} ליקויים, ${Date.now()-t3}ms`);

      // Step 3b — cost matching
      const t3b = Date.now();
      fullLog.push(`[Step 3b - Cost Matching] -> starting...`);
      step3b_matchCosts(rawDefects, costTableText, fullLog, (enrichedDefects) => {
        fullLog.push(`[Step 3b] -> ${Date.now()-t3b}ms`);

        // Step 3c — section-budget allocation (best-effort, no network)
        const _llmTot = (sectionMap && sectionMap.reportTotal > 0) ? sectionMap.reportTotal : 0;
        const _repTot = (_llmTot > 0) ? _llmTot : reportTotal;
        const sectionEnriched = step3c_sectionBudget(enrichedDefects, costTableText, _repTot);
        const secReport = sectionEnriched.filter(d => d._cs === 'report').length;
        const secSection = sectionEnriched.filter(d => d._cs === 'section').length;
        if (secReport > 0) fullLog.push(`[Step 3c] -> ${secReport} ליקויים קיבלו עלות מהטקסט (report)`);
        if (secSection > 0) fullLog.push(`[Step 3c] -> ${secSection} ליקויים קיבלו עלות מסקשן (section)`);

        // Step 3d — LLM cost refinement for high-variance remainder
        const t3d = Date.now();
        step3d_llmCostRefine(sectionEnriched, fullLog, (refinedDefects) => {
          fullLog.push(`[Step 3d] -> ${Date.now()-t3d}ms`);

          // Step 4 — schema enforcement
          const t4 = Date.now();
          const finalDefects = step4_schema(refinedDefects);
          fullLog.push(`[Step 4] -> ${finalDefects.length} ליקויים, ${Date.now()-t4}ms`);

          // Wait for the parallel vision path, then merge before dedup.
          const _afterVision = () => {
            _visionLog.forEach(l => fullLog.push(l));
            const merged = mergeDefects(finalDefects, _visionDefects);
            // Deduplicate: same room + page + hash of first 40 chars of title (normalized)
            const _seen = new Set();
            const dedupedDefects = merged.filter(d => {
              const normalizedTitle = (d.title || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
              const titleKey = crypto.createHash('md5').update(normalizedTitle).digest('hex').slice(0, 8);
              const key = `${d.area}|${d.pageNum}|${titleKey}`;
              if (_seen.has(key)) return false;
              _seen.add(key);
              return true;
            });
            if (dedupedDefects.length < merged.length) {
              fullLog.push(`[Step 4] -> dedup removed ${merged.length - dedupedDefects.length} duplicates`);
            }
            _finishPipeline(dedupedDefects);
          };

          function _finishPipeline(dedupedDefects) {
            // Cost coverage validation — LLM total takes precedence; regex is fallback
            const llmTotal = (sectionMap && sectionMap.reportTotal > 0) ? sectionMap.reportTotal : 0;
            const finalReportTotal = (llmTotal && llmTotal > 0) ? llmTotal : reportTotal;
            fullLog.push(`[reportTotal] llm=₪${llmTotal.toLocaleString()} regex=₪${reportTotal.toLocaleString()} → final=₪${finalReportTotal.toLocaleString()} (source: ${llmTotal?'LLM':'regex'})`);
            const sumExtracted = dedupedDefects.reduce((a,d) => a + (d.cMin||0), 0);
            const coverage = finalReportTotal > 0 ? Math.round(sumExtracted/finalReportTotal*100) : 0;
            fullLog.push(`[Cost Coverage] ${coverage}% — extracted ₪${sumExtracted.toLocaleString()} vs report ₪${finalReportTotal.toLocaleString()}`);
            const photosLinked = dedupedDefects.filter(d => d.bbox).length;
            fullLog.push(`[Vision] photosLinked=${photosLinked}`);

            // Step 3e — plain-language simplification
            const t3e = Date.now();
            step3e_simplify(dedupedDefects, fullLog, (simplifiedDefects) => {
              fullLog.push(`[Step 3e] -> ${Date.now()-t3e}ms`);
              fullLog.push(`[Total] ${Date.now()-t0}ms`);
              fullLog.push('===================');
              fullLog.forEach(l => console.log(l));
              const resultJson = JSON.stringify({ defects: simplifiedDefects, reportTotal: finalReportTotal, structureType, analysisLog: fullLog, visionMeta: { pagesScanned: detectVisualPages(pageMeta).length, photosLinked } });
              // אל תשמור cache כשstep3e נכשל לגמרי — מונע הגשת תוצאות ישנות ללא simplified_explanation
              const _simplifyOk = simplifiedDefects.length === 0 ||
                simplifiedDefects.some(d => d.simplified_explanation && d.simplified_explanation.trim());
              if (_simplifyOk) cacheSet(finalCacheKey, resultJson);
              callback(null, resultJson);
            });
          }

          // Join: merge+finish once vision is done (or after a 90s safety cap).
          if (_visionDone) _afterVision();
          else {
            const _iv = setInterval(() => { if (_visionDone) { clearInterval(_iv); _afterVision(); } }, 200);
            setTimeout(() => { if (!_visionDone) { _visionDone = true; clearInterval(_iv); fullLog.push('[Vision] ✗ timeout — text only'); _afterVision(); } }, 90000);
          }
        }); // end step3d
      });
    }, archetypeProfile.archetype);
    } // end runPipeline
  }, archetypeProfile.hint);
}

// ── HTTP server ──────────────────────────────────────────────────────────────

function startServer() {
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'POST' && (req.url === '/api/analyze-simple' || req.url.startsWith('/api/analyze-simple?'))) {
    const body = [];
    let bodyBytes = 0;
    const MAX_BODY = 100 * 1024 * 1024; // 100 MB raw guard
    req.on('data', c => {
      bodyBytes += c.length;
      if (bodyBytes > MAX_BODY) {
        req.destroy();
        res.writeHead(413, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ error: 'Payload too large (>100 MB)' }));
      }
      body.push(c);
    });
    req.on('end', () => {
      try {
        const { pdfText, propertyType, pdfBase64, pageMeta, nocache } = JSON.parse(Buffer.concat(body).toString('utf8'));
        if (!pdfText && !pdfBase64) { res.writeHead(400,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'Missing PDF text or base64'})); }
        if (pdfText.length > 2000000) {
          res.writeHead(413, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({ error: 'הדוח גדול מדי — נסה PDF של עד 800 עמודים' }));
        }
        const hasAnyKey = GROQ_KEYS.length || CEREBRAS_KEY || GEMINI_KEY || OPENROUTER_KEY;
        if (!hasAnyKey) { res.writeHead(500,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'חסרים API keys ב-.env.local'})); }

        pipeline(pdfText, propertyType, { pdfBase64, pageMeta, nocache: !!nocache }, (err, raw) => {
          if (err) { console.error('שגיאה:', err.message); res.writeHead(502,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:err.message})); }
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(raw);
        });
      } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    });
    return;
  }

  // ── POST /api/share — שמור דוח, החזר token ──────────────────────────────
  if (req.method === 'POST' && req.url === '/api/share') {
    const body = [];
    req.on('data', c => body.push(c));
    req.on('end', () => {
      try {
        const data = JSON.parse(Buffer.concat(body).toString('utf8'));
        const token = crypto.randomBytes(5).toString('hex');
        fs.writeFileSync(path.join(SHARED_DIR, token + '.json'), JSON.stringify(data), 'utf8');
        const baseUrl = `http://${req.headers.host}`;
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ token, url: `${baseUrl}/r/${token}` }));
      } catch(e) {
        res.writeHead(500, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── GET /api/report/:token — החזר נתוני דוח שמור ─────────────────────────
  const reportMatch = req.url.match(/^\/api\/report\/([a-f0-9]{10})$/);
  if (req.method === 'GET' && reportMatch) {
    const filePath = path.join(SHARED_DIR, reportMatch[1] + '.json');
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({ error: 'דוח לא נמצא' }));
    }
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(fs.readFileSync(filePath, 'utf8'));
  }

  // ── GET /r/:token — הגש viewer.html ──────────────────────────────────────
  const viewerMatch = req.url.match(/^\/r\/([a-f0-9]{10})$/);
  if (req.method === 'GET' && viewerMatch) {
    const viewerPath = path.join(__dirname, 'public', 'viewer.html');
    fs.readFile(viewerPath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(data);
    });
    return;
  }

  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, 'public', filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    const mime = {'.html':'text/html','.js':'application/javascript','.css':'text/css'}[ext] || 'application/octet-stream';
    res.writeHead(200, {'Content-Type': mime + (mime.startsWith('text') ? '; charset=utf-8' : '')});
    res.end(data);
  });

}).on('connection', socket => {
  socket.setTimeout(720000); // 12 min — kills dead sockets before API quota burns
}).listen(PORT, () => {
  console.log(`\n✅ שרת רץ על http://localhost:${PORT}`);
  console.log(`   Providers זמינים:`);
  console.log(`     Groq: ${GROQ_KEYS.length} מפתחות`);
  console.log(`     Cerebras: ${CEREBRAS_KEY ? '✓' : '✗'}`);
  console.log(`     Gemini: ${GEMINI_KEY ? '✓' : '✗'}`);
  console.log(`     OpenRouter: ${OPENROUTER_KEY ? '✓' : '✗'}`);

  // Cleanup shared reports older than 7 days — runs every hour
  setInterval(() => {
    try {
      const maxAge = 7 * 24 * 3600 * 1000;
      fs.readdirSync(SHARED_DIR).forEach(f => {
        const fp = path.join(SHARED_DIR, f);
        try {
          if (Date.now() - fs.statSync(fp).mtimeMs > maxAge) fs.unlinkSync(fp);
        } catch {}
      });
    } catch {}
  }, 3600000);
});
}

if (require.main === module) startServer();

module.exports = { pipeline, validateBbox, detectVisualPages, step4_schema, mergeDefects, geminiUploadFile, geminiDeleteFile, geminiVisionExtract, visionPath, visionStructurePath, step3c_sectionBudget, SEV_WEIGHT, buildCatchAllChunks, step3e_simplify };
