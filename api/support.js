const {
  loadStore,
  saveStore,
  getSessionMessages,
  sendTelegramText,
  sendTelegramPhoto,
} = require('./_lib/store');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const sessionId = String(body.sessionId || 'S-DEFAULT').trim().slice(0, 24) || 'S-DEFAULT';
    const message = String(body.message || '').trim().slice(0, 1500);
    const imageDataUrl = typeof body.imageDataUrl === 'string' ? body.imageDataUrl : '';

    if (!message && !imageDataUrl) {
      return res.status(400).json({ ok: false, error: 'Message or image is required' });
    }

    const store = await loadStore();
    store.lastActiveSessionId = sessionId;
    const list = getSessionMessages(store, sessionId);
    list.push({
      id: 'v-' + Date.now(),
      sender: 'visitor',
      text: message,
      imageDataUrl: imageDataUrl || undefined,
      time: new Date().toISOString(),
    });

    const tgText = `[${sessionId}] ${message || '(image attached)'}`;
    const tgRes = imageDataUrl
      ? await sendTelegramPhoto(imageDataUrl, tgText)
      : await sendTelegramText(tgText);

    if (tgRes?.ok && tgRes.result?.message_id) {
      store.tgMsgToSession[String(tgRes.result.message_id)] = sessionId;
    }
    await saveStore(store);

    return res.status(200).json({ ok: true, messages: list });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
};
