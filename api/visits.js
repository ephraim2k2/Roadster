const { loadStore } = require('./_lib/store');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  const store = await loadStore();
  return res.status(200).json({ count: Number(store.visits) || 0 });
};
