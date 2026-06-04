'use strict';
const fs   = require('fs');
const path = require('path');

const PROFILES_PATH = path.join(__dirname, '../data/company_profiles.json');

const SIGNATURES = [
  {
    archetype:  'TABLE',
    test:       t => (t.match(/\|.*\|/g) || []).length > 15,
    confidence: 0.95,
  },
  {
    archetype:  'HIERARCHICAL',
    test:       t => (t.match(/^\d+\.\d+\.\d+/mg) || []).length >= 2,
    confidence: 0.9,
  },
  {
    archetype:  'HIERARCHICAL',
    test:       t => (t.match(/^\d+\.\d+/mg) || []).length >= 8,
    confidence: 0.9,
  },
  {
    archetype:  'KW_PARAGRAPH',
    test:       t => (t.match(/ליקוי|ממצא|שרדנ/g) || []).length >= 10,
    confidence: 0.85,
  },
  {
    archetype:  'NUMBERED_FLAT',
    test:       t => (t.match(/^\d+\.\s+\S/mg) || []).length > 10
                  && (t.match(/^\d+\.\d+/mg)   || []).length < 5,
    confidence: 0.8,
  },
];

const ARCHETYPE_HINTS = {
  HIERARCHICAL:  'מבנה מסמך מזוהה: מספור היררכי (X.Y.Z). כל מספר ראשי = חדר/קטגוריה. אל תאחד לסקשן אחד.',
  KW_PARAGRAPH:  'מבנה מסמך מזוהה: בלוקי פסקה. כל "ליקוי" / "ממצא" = ליקוי נפרד. זהה חדרים לפי כותרות בין הבלוקים.',
  TABLE:         'מבנה מסמך מזוהה: טבלה. כל שורה = ליקוי נפרד. הפרד חדרים לפי עמודת המיקום.',
  NUMBERED_FLAT: 'מבנה מסמך מזוהה: מספור סדרתי. כל מספר = ליקוי נפרד.',
  UNKNOWN:       '',
};

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

function extractCompanyName(firstPageText, profiles) {
  for (const name of Object.keys(profiles)) {
    if (firstPageText.includes(name.slice(0, 6))) return name;
  }
  const m = firstPageText.match(/^([א-ת][א-ת\s"']{5,40})$/m);
  return m ? m[1].trim() : 'unknown';
}

function detectArchetypeSync(text, companyName = 'unknown') {
  const profiles = loadProfiles();

  const cached = profiles[companyName];
  if (cached && companyName !== 'unknown' && cached.confidence >= 0.8) {
    return {
      archetype:  cached.archetype,
      confidence: cached.confidence,
      hint:       ARCHETYPE_HINTS[cached.archetype] || '',
      fromCache:  true,
    };
  }

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

function splitByDefectBoundary(text, archetype) {
  let delimiter;
  if      (archetype === 'HIERARCHICAL')  delimiter = /(?=^\d+\.\d+)/m;
  else if (archetype === 'KW_PARAGRAPH')  delimiter = /(?=(?:^|\n)ליקוי|(?:^|\n)ממצא)/m;
  else if (archetype === 'NUMBERED_FLAT') delimiter = /(?=^\d+\.\s)/m;
  else return [text];

  const parts = text.split(delimiter).filter(p => p.trim().length > 30);
  if (parts.length < 2) return [text];
  return parts;
}

async function detectArchetype(rawText, pdfFirstPageText) {
  const profiles = loadProfiles();
  const companyName = extractCompanyName(pdfFirstPageText || rawText.slice(0, 800), profiles);
  return detectArchetypeSync(rawText, companyName);
}

module.exports = { detectArchetypeSync, detectArchetype, splitByDefectBoundary, extractCompanyName, loadProfiles };
