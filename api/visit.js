const { loadStore, saveStore, sendTelegramText } = require('./_lib/store');

function formatGeo(headers) {
  const city = decodeURIComponent(String(headers['x-vercel-ip-city'] || '')).trim();
  const state = String(headers['x-vercel-ip-country-region'] || '').trim();
  const country = String(headers['x-vercel-ip-country'] || '').trim();
  const parts = [city, state, country].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Unknown';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const timeZone = String(body.timeZone || 'Unknown').slice(0, 64);
  const location = formatGeo(req.headers || {});

  const store = await loadStore();
  store.visits = (Number(store.visits) || 0) + 1;
  await saveStore(store);

  await sendTelegramText(
    `New site visit! Total visits: ${store.visits}\nLocation: ${location}\nTime Zone: ${timeZone}`
  );
  return res.status(200).json({ count: store.visits });
};
