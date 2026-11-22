const { loadStore, saveStore, sendTelegramText } = require('./_lib/store');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const record = {
      ref: String(body.ref || '').slice(0, 32),
      edition: String(body.edition || '').slice(0, 32),
      paymentMethod: String(body.paymentMethod || '').slice(0, 64),
      amount: Number(body.amount) || 0,
      txid: body.txid ? String(body.txid).slice(0, 128) : undefined,
      createdAt: new Date().toISOString(),
    };

    const store = await loadStore();
    store.reservations.push(record);
    await saveStore(store);

    const lines = [
      'New Roadster reservation!',
      `Ref: ${record.ref}`,
      `Edition: ${record.edition}`,
      `Method: ${record.paymentMethod}`,
      `Amount: $${record.amount.toLocaleString('en-US')}`,
    ];
    if (record.txid) lines.push(`TXID: ${record.txid}`);
    await sendTelegramText(lines.join('\n'));

    return res.status(200).json({ ok: true, ref: record.ref });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
};
