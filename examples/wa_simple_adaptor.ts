/*
  Simple WhatsApp adaptor (Bun + TypeScript)

  Responsibilities:
  - Receive WhatsApp messages and POST to Gateway API `/api/messages`
  - Subscribe to SSE `/api/messages/:networkId/:botId` and send outbound messages

  Env (from .env):
  - GATEWAY_API_BASE_URL (e.g., http://localhost)
  - PORT (e.g., 3080)
  - BOT_TYPE (e.g., brain)
  - BOT_ID (e.g., wa183)
  - NETWORK_ID (e.g., whatsapp)

  Notes:
  - Uses whatsapp-web.js (QR auth). Requires a Chromium available for Puppeteer.
  - Minimal, no media handling in v1.
*/

import qrcode from 'qrcode-terminal';
import { Client, LocalAuth } from 'whatsapp-web.js';

type InboundPost = {
  networkId: string;
  botId: string;
  botType: string;
  groupId?: string;
  userId?: string;
  messageId?: string;
  message: string;
};

type OutboundSSE = {
  networkId: string;
  botId: string;
  botType: string;
  groupId?: string;
  userId?: string;
  replyMessageId?: string;
  message: string;
};

// -------- Env helpers --------
function env(name: string, fallback?: string): string {
  const v = (globalThis as any)?.Bun?.env?.[name] ?? process.env?.[name];
  if (v === undefined || v === null || v === '') return fallback ?? '';
  return String(v);
}

const BASE = `${env('GATEWAY_API_BASE_URL', 'http://localhost')}:${env('PORT', '3080')}`;
const BOT_TYPE = env('BOT_TYPE', 'brain');
const BOT_ID = env('BOT_ID', 'wa183');
const NETWORK_ID = env('NETWORK_ID', 'whatsapp');
const SESSION_DIR = env('SESSION_DIR', '.wwebjs_auth');
const HEADLESS = env('HEADLESS', 'true').toLowerCase() !== 'false';
const NO_SANDBOX = env('NO_SANDBOX', 'false').toLowerCase() === 'true';
const EXECUTABLE_PATH = env('PUPPETEER_EXECUTABLE_PATH', env('CHROME_BIN')) || undefined;

// -------- WhatsApp bootstrap --------
const pupArgs = [
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=site-per-process,Translate,BackForwardCache',
];
if (NO_SANDBOX) pupArgs.push('--no-sandbox', '--disable-setuid-sandbox');

const client = new Client({
  puppeteer: {
    headless: HEADLESS,
    args: pupArgs,
    executablePath: EXECUTABLE_PATH,
  },
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
});

client.on('qr', (qr) => {
  console.log('[wa] Scan this QR to authenticate:');
  try { qrcode.generate(qr, { small: true }); } catch { console.log('QR (raw):', qr); }
});
client.on('ready', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  console.log(`[wa] READY as ${((client as any).info?.wid?._serialized) || 'unknown'}`);
});
client.on('authenticated', () => console.log('[wa] authenticated'));
client.on('auth_failure', (msg) => console.error('[wa] auth_failure:', msg));
client.on('disconnected', (reason) => console.warn('[wa] disconnected:', reason));

// -------- Inbound: WA -> Gateway POST --------
client.on('message', async (msg) => {
  try {
    // ignore self messages to avoid loops
    if ((msg as any)?.fromMe) return;

    const isGroup = String(msg.from).endsWith('@g.us');
    const groupId = isGroup ? msg.from : undefined;
    const userId = isGroup ? (msg as any)?.author : msg.from; // author is present for group messages
    const messageId = (msg as any)?.id?._serialized || (msg as any)?.id?.id;
    const payload: InboundPost = {
      networkId: NETWORK_ID,
      botId: BOT_ID,
      botType: BOT_TYPE,
      groupId,
      userId,
      messageId,
      message: msg.body || '',
    };

    const res = await fetch(`${BASE}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error('[wa] inbound POST failed', res.status, await safeText(res));
    }
  } catch (e) {
    console.error('[wa] inbound error:', e);
  }
});

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ''; }
}

// -------- Outbound: SSE subscribe -> WA send --------
let sseAbort: AbortController | null = null;
let lastEventId: string | null = null;

async function startSSE() {
  const url = `${BASE}/api/messages/${encodeURIComponent(NETWORK_ID)}/${encodeURIComponent(BOT_ID)}`;
  const ac = new AbortController();
  sseAbort = ac;
  console.log('[wa] SSE connecting to', url);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
      },
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      console.error('[wa] SSE connect failed', res.status);
      throw new Error(`SSE HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleSSEEvent(rawEvent);
      }
    }
  } catch (e) {
    if ((e as any)?.name === 'AbortError') {
      console.log('[wa] SSE aborted');
    } else {
      console.warn('[wa] SSE error:', e);
      await delay(1500);
      startSSE();
    }
  }
}

function handleSSEEvent(chunk: string) {
  let event: string | null = null;
  let data: string[] = [];
  let id: string | null = null;
  const lines = chunk.split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue; // comment/heartbeat
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    else if (line.startsWith('id:')) id = line.slice(3).trim();
  }
  if (id) lastEventId = id;
  if (event !== 'message') return;
  try {
    const payload = JSON.parse(data.join('\n')) as OutboundSSE;
    if (payload.networkId !== NETWORK_ID || payload.botId !== BOT_ID) return;
    const to = payload.groupId || payload.userId;
    if (!to) {
      console.warn('[wa] outbound has no target (userId/groupId)');
      return;
    }
    const opts: any = {};
    if (payload.replyMessageId) opts.quotedMessageId = payload.replyMessageId;
    client.sendMessage(to, payload.message || '', opts).catch((e) => {
      console.error('[wa] sendMessage error:', e);
    });
  } catch (e) {
    console.warn('[wa] SSE parse error:', e);
  }
}

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// -------- Start --------
(async () => {
  console.log('[wa] adaptor starting with', { BASE, BOT_TYPE, BOT_ID, NETWORK_ID });
  client.initialize().catch((err) => console.error('[wa] init failed:', err));
  // start SSE after a small delay to allow login; it will also work before login
  setTimeout(() => { startSSE(); }, 500);
})();

