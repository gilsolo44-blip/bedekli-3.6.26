export const config = {
  maxDuration: 60,
  api: { bodyParser: { sizeLimit: '10mb' } }
};

const OR_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = 'google/gemini-2.0-flash-exp:free';

const PROMPT_NEW = `אתה מומחה בניתוח דוחות בדק בית בעברית. חלץ כל ליקוי ללא יוצא מהכלל — גם קלים וגם קוסמטיים.
החזר JSON בלבד, ללא טקסט נוסף, ללא backticks:
{"defects":[{"area":"שם האזור","title":"שם קצר","sub":"פירוט קצר","desc":"תיאור מפורט","sev":"critical|important|medium|cosmetic","quote":"ציטוט מהדוח","page":"מיקום בדוח","pageNum":מספר,"cMin":מספר_שקלים,"cMax":מספר_שקלים}]}
critical=בטיחות/נזק חמור|important=ליקוי הנדסי|medium=בינוני|cosmetic=אסתטי
pageNum=מספר שלם. cMin/cMax=שקלים ישראלים. כלול הכל — אל תדלג.`;

const PROMPT_YAD2 = PROMPT_NEW.replace(
  'critical=בטיחות/נזק חמור|important=ליקוי הנדסי|medium=בינוני|cosmetic=אסתטי',
  'critical=בטיחות/נזק חמור|important=ליקוי הנדסי (פוטנציאל מו"מ גבוה)|medium=בינוני|cosmetic=אסתטי'
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { pdfText, propertyType } = req.body;
  if (!pdfText) return res.status(400).json({ error: 'Missing PDF text' });

  const system = propertyType === 'yad2' ? PROMPT_YAD2 : PROMPT_NEW;

  const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OR_KEY}`,
      'HTTP-Referer': 'https://bedekli.vercel.app',
      'X-Title': 'Bedekli'
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `הנה תוכן דוח הבדק בית:\n\n${pdfText}\n\nחלץ את כל הליקויות ללא יוצא מהכלל. החזר JSON בלבד.` }
      ],
      max_tokens: 16000,
      temperature: 0.1
    })
  });

  if (!orRes.ok) {
    const err = await orRes.text();
    return res.status(502).json({ error: 'שגיאת OpenRouter: ' + err.slice(0, 200) });
  }

  const js = await orRes.json();
  const raw = js.choices?.[0]?.message?.content || '';
  return res.status(200).json({ raw });
}
