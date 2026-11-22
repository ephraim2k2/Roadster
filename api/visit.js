const { loadStore, saveStore, sendTelegramText } = require('./_lib/store');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  const store = await loadStore();
  store.visits = (Number(store.visits) || 0) + 1;
  await saveStore(store);
  await sendTelegramText(`New site visit! Total visits: ${store.visits}`);
  return res.status(200).json({ count: store.visits });
};
