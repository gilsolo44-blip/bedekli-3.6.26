export const config = { maxDuration: 60 };

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const DAILY_LIMIT   = 5;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Auth ──
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!userRes.ok) return res.status(401).json({ error: 'Invalid token' });
  const { id: userId } = await userRes.json();

  // ── Rate limit ──
  const today = new Date().toISOString().slice(0, 10);
  const usageRes = await fetch(
    `${SUPABASE_URL}/rest/v1/usage?user_id=eq.${userId}&date=eq.${today}`,
    { headers: sbHeaders() }
  );
  const usage = await usageRes.json();
  const count = usage[0]?.count || 0;
  if (count >= DAILY_LIMIT) {
    return res.status(429).json({ error: `הגעת למגבלת ${DAILY_LIMIT} ניתוחים ליום` });
  }

  // ── Parse body ──
  const { pdfUrl, fileName, propertyType } = req.body;
  if (!pdfUrl) return res.status(400).json({ error: 'Missing PDF URL' });

  // ── Call Anthropic with URL source (no download needed) ──
  const prompt = propertyType === 'yad2' ? PROMPT_YAD2 : PROMPT_NEW;
  const anthRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5-20251101',
      max_tokens: 16000,
      system: prompt,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'url', url: pdfUrl } },
          { type: 'text', text: 'חלץ את כל הליקויות ללא יוצא מהכלל. החזר JSON בלבד.' }
        ]
      }]
    })
  });

  if (!anthRes.ok) {
    const err = await anthRes.text();
    return res.status(502).json({ error: 'Anthropic error: ' + err.slice(0, 200) });
  }

  const anthJson = await anthRes.json();
  const raw = (anthJson.content || []).find(c => c.type === 'text')?.text || '';
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^```json\s*/, '').replace(/```\s*$/, '').trim());
  } catch {
    return res.status(502).json({ error: 'AI לא החזיר JSON תקין' });
  }

  const defects = Array.isArray(parsed) ? parsed : (parsed?.defects || []);
  if (!defects.length) return res.status(422).json({ error: 'לא נמצאו ליקויות בדוח' });

  // ── Save report ──
  const reportRes = await fetch(`${SUPABASE_URL}/rest/v1/reports`, {
    method: 'POST',
    headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ user_id: userId, file_name: fileName, property_type: propertyType, data: defects })
  });
  const [report] = await reportRes.json();

  // ── Increment usage ──
  if (count === 0) {
    await fetch(`${SUPABASE_URL}/rest/v1/usage`, {
      method: 'POST',
      headers: { ...sbHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, date: today, count: 1 })
    });
  } else {
    await fetch(`${SUPABASE_URL}/rest/v1/usage?user_id=eq.${userId}&date=eq.${today}`, {
      method: 'PATCH',
      headers: { ...sbHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: count + 1 })
    });
  }

  return res.status(200).json({ reportId: report.id, defects });
}

const PROMPT_NEW = `אתה מומחה בניתוח דוחות בדק בית בעברית. חלץ כל ליקוי ללא יוצא מהכלל.
החזר JSON בלבד, ללא טקסט נוסף, ללא backticks:
{"defects":[{
  "area":"<ראה הסבר מפורט למטה>",
  "category":"סוג הבעיה הטכנית בלבד: אינסטלציה / חשמל / טיח / ריצוף / צנרת / חלונות / דלתות / כללי",
  "title":"כותרת קצרה של הליקוי",
  "finding":"תיאור מפורט של הממצא",
  "action":"פעולה נדרשת לתיקון",
  "sev":"critical|high|medium|low|cosmetic",
  "pageNums":[מספרי עמודים],
  "quote":"ציטוט מהדוח",
  "cMin":מינימום_שקלים,
  "cMax":מקסימום_שקלים
}]}

הסבר לשדה "area" — קרא בעיון:
שדה area חייב להכיל שם חדר או אזור פיזי בדירה. לדוגמה: סלון, מטבח, חדר הורים, חדר ילדים 1, חדר ילדים 2, שירותים, אמבטיה, מרפסת, פרוזדור, כניסה, ממד, חניה, מחסן.
דוחות בדק בית רבים מאורגנים לפי קטגוריה טכנית (ריצוף, חשמל וכו') ולא לפי חדר. במצב כזה עליך לקרוא את תיאור הממצא עצמו ולחלץ ממנו את שם החדר.
לדוגמה: אם כתוב "ריצוף חדר שינה — מישקים רחבים" אז area="חדר שינה" ו-category="ריצוף".
אם אין ציון חדר ספציפי בתיאור הממצא — תשתמש בשם החדר/האזור הכי קרוב שמופיע בכותרת הסעיף שבו מופיע הממצא בדוח.
אסור לשים בשדה area ערכים כמו: ריצוף, חשמל, אינסטלציה, טיח, צנרת, חלונות, דלתות — אלו שייכים לשדה category בלבד.

critical=בטיחות/נזק חמור|high=ליקוי הנדסי|medium=בינוני|low=קל|cosmetic=אסתטי בלבד`;

const PROMPT_YAD2 = PROMPT_NEW.replace(
  'critical=בטיחות/נזק חמור|high=ליקוי הנדסי|medium=בינוני|low=קל|cosmetic=אסתטי בלבד',
  'critical=בטיחות/נזק חמור|high=ליקוי הנדסי (פוטנציאל מו"מ גבוה)|medium=בינוני|low=קל|cosmetic=אסתטי בלבד'
);

function sbHeaders() {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
}
