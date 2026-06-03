'use strict';

const { pipeline } = require('../server');

// In-memory rate limit (partial protection — resets between cold starts)
const rateLimitMap = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const timestamps = (rateLimitMap.get(ip) || []).filter(t => t > now - 3600000);
  if (timestamps.length >= 5) return false;
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  return true;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'הגעת למגבלת הבקשות — נסה שוב בעוד שעה' });

  const { pdfText, propertyType } = req.body;
  if (!pdfText) return res.status(400).json({ error: 'Missing PDF text' });

  pipeline(pdfText, propertyType, (err, raw) => {
    if (err) return res.status(502).json({ error: err.message });
    res.status(200).send(raw);
  });
};

module.exports.config = {
  maxDuration: 300,
  api: { bodyParser: { sizeLimit: '20mb' } }
};
