// Vercel serverless wrapper — delegates to the unified pipeline in server.js.
// CJS (matches project rule). server.js does not start its HTTP server on
// require (guarded by `if (require.main === module)`), so importing is safe.
const { pipeline } = require('../server.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { pdfText, propertyType, pdfBase64, pageMeta } = req.body || {};
  if (!pdfText) return res.status(400).json({ error: 'Missing PDF text' });

  pipeline(pdfText, propertyType, { pdfBase64, pageMeta }, (err, raw) => {
    if (err) return res.status(502).json({ error: err.message });
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(raw); // raw is already a JSON string (unified schema)
  });
};

// Larger body limit for pdfBase64 (vision path); 60s execution cap.
module.exports.config = {
  maxDuration: 60,
  api: { bodyParser: { sizeLimit: '50mb' } },
};
