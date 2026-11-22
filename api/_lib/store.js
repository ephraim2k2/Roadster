const fs = require('node:fs');
const path = require('node:path');

// Load .env if present (so committed .env works on Vercel without dashboard config)
for (const candidate of [path.join(process.cwd(), '.env'), path.join(__dirname, '..', '..', '.env')]) {
  if (fs.existsSync(candidate)) {
    for (const line of fs.readFileSync(candidate, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!(key in process.env)) process.env[key] = val;
    }
    break;
  }
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// Support Vercel KV / Upstash Redis REST if configured, otherwise /tmp fallback
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const TMP_STORE_PATH = '/tmp/roadster_vercel_store.json';

function defaultStore() {
  return {
    visits: 0,
    reservations: [],
    sessions: {},
    tgMsgToSession: {},
    lastTgUpdateId: 0,
    lastActiveSessionId: '',
  };
}

async function kvCommand(args) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`KV error: ${res.status}`);
  return res.json();
}

async function loadStore() {
  if (KV_URL && KV_TOKEN) {
    try {
      const data = await kvCommand(['GET', 'roadster:store']);
      if (data && data.result) {
        return { ...defaultStore(), ...JSON.parse(data.result) };
      }
      return defaultStore();
    } catch (err) {
      console.error('KV load failed, falling back to /tmp:', err.message);
    }
  }
  try {
    const raw = fs.readFileSync(TMP_STORE_PATH, 'utf8');
    return { ...defaultStore(), ...JSON.parse(raw) };
  } catch {
    return defaultStore();
  }
}

async function saveStore(store) {
  if (KV_URL && KV_TOKEN) {
    try {
      await kvCommand(['SET', 'roadster:store', JSON.stringify(store)]);
      return;
    } catch (err) {
      console.error('KV save failed, falling back to /tmp:', err.message);
    }
  }
  try {
    fs.writeFileSync(TMP_STORE_PATH, JSON.stringify(store));
  } catch (err) {
    console.error('/tmp save failed:', err.message);
  }
}

function getSessionMessages(store, sessionId) {
  if (!Array.isArray(store.sessions[sessionId])) {
    store.sessions[sessionId] = [
      {
        id: 'welcome',
        sender: 'support',
        text: 'Hi! Send a message or image here to chat with Roadster support.',
        time: new Date().toISOString(),
      },
    ];
  }
  return store.sessions[sessionId];
}

async function sendTelegramText(text) {
  if (!BOT_TOKEN || !CHAT_ID) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text }),
    });
    return await res.json();
  } catch (err) {
    console.error('Telegram sendText failed:', err.message);
    return null;
  }
}

async function sendTelegramPhoto(dataUrl, caption) {
  if (!BOT_TOKEN || !CHAT_ID) return null;
  const match = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error('Invalid image format');
  const mime = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  form.append('caption', caption.slice(0, 1024));
  form.append('photo', new Blob([buffer], { type: mime }), 'attachment.' + (mime.split('/')[1] || 'png'));

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      body: form,
    });
    return await res.json();
  } catch (err) {
    console.error('Telegram sendPhoto failed:', err.message);
    return null;
  }
}

async function pollTelegramReplies(store) {
  if (!BOT_TOKEN || !CHAT_ID) return false;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${store.lastTgUpdateId + 1}&timeout=0`
    );
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.result) || data.result.length === 0) return false;

    let changed = false;
    for (const upd of data.result) {
      if (upd.update_id > store.lastTgUpdateId) {
        store.lastTgUpdateId = upd.update_id;
        changed = true;
      }
      const msg = upd.message;
      if (!msg || String(msg.chat?.id) !== String(CHAT_ID) || msg.from?.is_bot) continue;

      let text = (msg.text || msg.caption || '').trim();
      if (!text) continue;

      let targetSession = '';
      const replyMsg = msg.reply_to_message;
      if (replyMsg) {
        const replyId = String(replyMsg.message_id);
        if (store.tgMsgToSession[replyId]) {
          targetSession = store.tgMsgToSession[replyId];
        } else {
          const tagMatch = /\[(S-[A-Z0-9]+)\]/i.exec(replyMsg.text || replyMsg.caption || '');
          if (tagMatch) targetSession = tagMatch[1].toUpperCase();
        }
      }

      const cmdMatch = /^\/(clear|end)(?:\s+\[?(S-[A-Z0-9]+)\]?)?$/i.exec(text);
      if (cmdMatch) {
        const cmd = cmdMatch[1].toLowerCase();
        const explicitSession = cmdMatch[2] ? cmdMatch[2].toUpperCase() : '';
        const cmdSession = explicitSession || targetSession || store.lastActiveSessionId;
        if (cmdSession) {
          if (cmd === 'clear') {
            store.sessions[cmdSession] = [
              {
                id: 'cleared-' + msg.message_id,
                sender: 'support',
                text: 'Chat history cleared.',
                time: new Date().toISOString(),
              },
            ];
            await sendTelegramText(`Cleared chat for ${cmdSession}.`);
          } else if (cmd === 'end') {
            const list = getSessionMessages(store, cmdSession);
            const endId = 'ended-' + msg.message_id;
            if (!list.some((m) => m.id === endId)) {
              list.push({
                id: endId,
                sender: 'support',
                text: 'This chat has been ended by support. Send a new message anytime to start again.',
                time: new Date().toISOString(),
              });
            }
            if (store.lastActiveSessionId === cmdSession) {
              store.lastActiveSessionId = '';
            }
            await sendTelegramText(`Ended chat for ${cmdSession}.`);
          }
          changed = true;
        } else {
          await sendTelegramText('Reply to a visitor message or specify a session ID (e.g. /clear S-XXXX).');
        }
        continue;
      }

      if (!targetSession) {
        const prefixMatch = /^\[?(S-[A-Z0-9]+)\]?:?\s+([\s\S]+)$/i.exec(text);
        if (prefixMatch) {
          targetSession = prefixMatch[1].toUpperCase();
          text = prefixMatch[2].trim();
        } else if (store.lastActiveSessionId) {
          targetSession = store.lastActiveSessionId;
        }
      }

      if (targetSession) {
        const list = getSessionMessages(store, targetSession);
        const msgId = 'tg-' + msg.message_id;
        if (!list.some((m) => m.id === msgId)) {
          list.push({
            id: msgId,
            sender: 'support',
            text,
            time: new Date().toISOString(),
          });
          changed = true;
        }
      }
    }
    return changed;
  } catch (err) {
    console.error('Telegram poll failed:', err.message);
    return false;
  }
}

module.exports = {
  loadStore,
  saveStore,
  getSessionMessages,
  sendTelegramText,
  sendTelegramPhoto,
  pollTelegramReplies,
};
