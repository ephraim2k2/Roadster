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
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const email = String(body.email || '').trim().slice(0, 120);
    const phone = String(body.phone || '').trim().slice(0, 40);
    if (!email || !phone) {
      return res.status(400).json({ ok: false, error: 'Email and phone are required' });
    }

    const record = {
      ref: String(body.ref || '').slice(0, 32),
      edition: String(body.edition || 'Performance').slice(0, 32),
      email,
      phone,
      location: formatGeo(req.headers || {}),
      timeZone: String(body.timeZone || 'Unknown').slice(0, 64),
      createdAt: new Date().toISOString(),
    };

    const store = await loadStore();
    store.reservations.push(record);
    await saveStore(store);

    await sendTelegramText([
      'New Roadster Waiting List Entry!',
      `Ref: ${record.ref}`,
      `Edition: ${record.edition}`,
      `Email: ${record.email}`,
      `Phone: ${record.phone}`,
      `Location: ${record.location}`,
      `Time Zone: ${record.timeZone}`,
    ].join('\n'));

    return res.status(200).json({ ok: true, ref: record.ref });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
};
