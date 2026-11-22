const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Load .env if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

const PORT = Number(process.env.PORT) || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const ROOT = __dirname;
const HTML_FILE = path.join(ROOT, 'index.html');
const VISITS_FILE = path.join(ROOT, 'visits.json');
const RESERVATIONS_FILE = path.join(ROOT, 'reservations.json');
const SUPPORT_FILE = path.join(ROOT, 'support_chats.json');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

function readVisits() {
  try {
    const data = JSON.parse(fs.readFileSync(VISITS_FILE, 'utf8'));
    return Number(data.count) || 0;
  } catch {
    return 0;
  }
}

function writeVisits(count) {
  fs.writeFileSync(VISITS_FILE, JSON.stringify({ count }, null, 2));
}

function saveReservation(record) {
  let list = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(RESERVATIONS_FILE, 'utf8'));
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    list = [];
  }
  list.push(record);
  fs.writeFileSync(RESERVATIONS_FILE, JSON.stringify(list, null, 2));
}

// Persistent Support DM store
let supportStore = {
  sessions: {},
  tgMsgToSession: {},
  lastTgUpdateId: 0,
  lastActiveSessionId: '',
};

try {
  const saved = JSON.parse(fs.readFileSync(SUPPORT_FILE, 'utf8'));
  if (saved && typeof saved === 'object') {
    supportStore.sessions = saved.sessions || {};
    supportStore.tgMsgToSession = saved.tgMsgToSession || {};
    supportStore.lastTgUpdateId = Number(saved.lastTgUpdateId) || 0;
    supportStore.lastActiveSessionId = String(saved.lastActiveSessionId || '');
  }
} catch {
  // Fresh store
}

function saveSupportStore() {
  try {
    fs.writeFileSync(SUPPORT_FILE, JSON.stringify(supportStore, null, 2));
  } catch (err) {
    console.error('Failed to save support store:', err.message);
  }
}

function getSessionMessages(sessionId) {
  if (!Array.isArray(supportStore.sessions[sessionId])) {
    supportStore.sessions[sessionId] = [
      {
        id: 'welcome',
        sender: 'support',
        text: 'Hi! Send a message or image here to chat with Roadster support.',
        time: new Date().toISOString(),
      },
    ];
    saveSupportStore();
  }
  return supportStore.sessions[sessionId];
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
    console.error('Telegram notification failed:', err.message);
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
    console.error('Telegram photo failed:', err.message);
    return null;
  }
}

let isPolling = false;
async function pollTelegramReplies() {
  if (!BOT_TOKEN || !CHAT_ID || isPolling) return;
  isPolling = true;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${supportStore.lastTgUpdateId + 1}&timeout=0`
    );
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.result) || data.result.length === 0) return;

    let changed = false;
    for (const upd of data.result) {
      if (upd.update_id > supportStore.lastTgUpdateId) {
        supportStore.lastTgUpdateId = upd.update_id;
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
        if (supportStore.tgMsgToSession[replyId]) {
          targetSession = supportStore.tgMsgToSession[replyId];
        } else {
          const tagMatch = /\[(S-[A-Z0-9]+)\]/i.exec(replyMsg.text || replyMsg.caption || '');
          if (tagMatch) targetSession = tagMatch[1].toUpperCase();
        }
      }

      const cmdMatch = /^\/(clear|end)(?:\s+\[?(S-[A-Z0-9]+)\]?)?$/i.exec(text);
      if (cmdMatch) {
        const cmd = cmdMatch[1].toLowerCase();
        const explicitSession = cmdMatch[2] ? cmdMatch[2].toUpperCase() : '';
        const cmdSession = explicitSession || targetSession || supportStore.lastActiveSessionId;
        if (cmdSession) {
          if (cmd === 'clear') {
            supportStore.sessions[cmdSession] = [
              {
                id: 'cleared-' + msg.message_id,
                sender: 'support',
                text: 'Chat history cleared.',
                time: new Date().toISOString(),
              },
            ];
            await sendTelegramText(`Cleared chat for ${cmdSession}.`);
          } else if (cmd === 'end') {
            const list = getSessionMessages(cmdSession);
            const endId = 'ended-' + msg.message_id;
            if (!list.some((m) => m.id === endId)) {
              list.push({
                id: endId,
                sender: 'support',
                text: 'This chat has been ended by support. Send a new message anytime to start again.',
                time: new Date().toISOString(),
              });
            }
            if (supportStore.lastActiveSessionId === cmdSession) {
              supportStore.lastActiveSessionId = '';
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
        } else if (supportStore.lastActiveSessionId) {
          targetSession = supportStore.lastActiveSessionId;
        }
      }

      if (targetSession) {
        const list = getSessionMessages(targetSession);
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
    if (changed) saveSupportStore();
  } catch (err) {
    console.error('Telegram poll failed:', err.message);
  } finally {
    isPolling = false;
  }
}

function readJsonBody(req, maxBytes = 16384) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  if (req.method === 'POST' && urlPath === '/api/visit') {
    const count = readVisits() + 1;
    writeVisits(count);
    sendTelegramText(`New site visit! Total visits: ${count}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count }));
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/reserve') {
    try {
      const body = await readJsonBody(req);
      const record = {
        ref: String(body.ref || '').slice(0, 32),
        edition: String(body.edition || '').slice(0, 32),
        paymentMethod: String(body.paymentMethod || '').slice(0, 64),
        amount: Number(body.amount) || 0,
        txid: body.txid ? String(body.txid).slice(0, 128) : undefined,
        createdAt: new Date().toISOString(),
      };
      saveReservation(record);
      const lines = [
        'New Roadster reservation!',
        `Ref: ${record.ref}`,
        `Edition: ${record.edition}`,
        `Method: ${record.paymentMethod}`,
        `Amount: $${record.amount.toLocaleString('en-US')}`,
      ];
      if (record.txid) lines.push(`TXID: ${record.txid}`);
      sendTelegramText(lines.join('\n'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ref: record.ref }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/support/messages') {
    const fullUrl = new URL(req.url, `http://localhost:${PORT}`);
    const sessionId = String(fullUrl.searchParams.get('session') || 'S-DEFAULT').slice(0, 24);
    await pollTelegramReplies();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages: getSessionMessages(sessionId) }));
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/support') {
    try {
      const body = await readJsonBody(req, 10 * 1024 * 1024);
      const sessionId = String(body.sessionId || 'S-DEFAULT').trim().slice(0, 24) || 'S-DEFAULT';
      const message = String(body.message || '').trim().slice(0, 1500);
      const imageDataUrl = typeof body.imageDataUrl === 'string' ? body.imageDataUrl : '';
      if (!message && !imageDataUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Message or image is required' }));
        return;
      }

      supportStore.lastActiveSessionId = sessionId;
      const list = getSessionMessages(sessionId);
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
        supportStore.tgMsgToSession[String(tgRes.result.message_id)] = sessionId;
      }
      saveSupportStore();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, messages: list }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/visits') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: readVisits() }));
    return;
  }

  const targetPath =
    urlPath === '/'
      ? HTML_FILE
      : path.normalize(path.join(ROOT, decodeURIComponent(urlPath)));

  if (!targetPath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(targetPath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(targetPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  setInterval(pollTelegramReplies, 3000);
});
