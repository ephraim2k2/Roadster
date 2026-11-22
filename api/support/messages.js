const {
  loadStore,
  saveStore,
  getSessionMessages,
  pollTelegramReplies,
} = require('../_lib/store');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  const sessionId = String(req.query?.session || 'S-DEFAULT').slice(0, 24) || 'S-DEFAULT';
  const store = await loadStore();
  const changed = await pollTelegramReplies(store);
  const messages = getSessionMessages(store, sessionId);
  if (changed) {
    await saveStore(store);
  }
  return res.status(200).json({ messages });
};
