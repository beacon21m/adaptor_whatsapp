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
import fs from 'fs';
import path from 'path';
// Dynamic import for bun:sqlite to avoid runtime binding issues
let DatabaseCtor: any;
async function loadSqlite() {
  if (!DatabaseCtor) {
    const mod = await import('bun:sqlite');
    // @ts-ignore
    DatabaseCtor = (mod as any).Database;
  }
}

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
  direction?: 'in' | 'out' | string;
  eventId?: number;
  refId?: string;
};

// -------- Env helpers --------
function env(name: string, fallback?: string): string {
  const v = (globalThis as any)?.Bun?.env?.[name] ?? (globalThis as any)?.process?.env?.[name];
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
const DEDUP_TTL_MS = Number(env('DEDUP_TTL_MS', '180000')); // 3 minutes default
const DEDUP_MAX = Number(env('DEDUP_MAX', '500'));
const STATE_DIR = env('STATE_DIR', '.state');
const DB_FILE = path.join(STATE_DIR, 'state.sqlite');

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

let waReady = false;
const outboundQueue: { to: string; message: string; opts: any }[] = [];

client.on('qr', (qr) => {
  console.log('[wa] Scan this QR to authenticate:');
  try { qrcode.generate(qr, { small: true }); } catch { console.log('QR (raw):', qr); }
});
client.on('ready', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  console.log(`[wa] READY as ${((client as any).info?.wid?._serialized) || 'unknown'}`);
  waReady = true;
  // flush any queued outbound sends
  if (outboundQueue.length) {
    console.log(`[wa] flushing ${outboundQueue.length} queued outbound messages`);
    for (const item of outboundQueue.splice(0)) {
      client.sendMessage(item.to, item.message, item.opts).catch((e) => {
        console.error('[wa] sendMessage error (flush):', e);
      });
    }
  }
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
let lastProcessedEventId: number | null = null;
let sseRetryDelay = 1500; // ms, exponential backoff up to 30s
let lastSseActivity = Date.now();
const SSE_CHECK_INTERVAL_MS = Number(env('SSE_CHECK_INTERVAL_MS', '1000'));
const SSE_STALE_MS = Number(env('SSE_STALE_MS', '10000'));
let sseHealthTimer: ReturnType<typeof setInterval> | null = null;

// -------- Dedupe cache (payload-hash) --------
type CachedHit = { t: number };
const dedupeCache = new Map<string, CachedHit>();
const LAST_HASH_FILE = path.join(STATE_DIR, `last_out_${NETWORK_ID}_${BOT_ID}.json`);
const OFFSET_FILE = path.join(STATE_DIR, `sse_offset_${NETWORK_ID}_${BOT_ID}.json`);

function ensureStateDir() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}
}

function fnv1a(str: string): string {
  let h = 0x811c9dc5; // 32-bit FNV-1a
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  // convert to unsigned and hex
  return (h >>> 0).toString(16);
}

function payloadKey(to: string, message: string, replyMessageId?: string) {
  return `${to}|${replyMessageId || ''}|${message}`;
}

function dedupeSeen(hash: string): boolean {
  const now = Date.now();
  const hit = dedupeCache.get(hash);
  if (hit && now - hit.t <= DEDUP_TTL_MS) return true;
  // insert and evict if needed
  dedupeCache.set(hash, { t: now });
  if (dedupeCache.size > DEDUP_MAX) {
    // simple eviction: remove oldest by timestamp
    let oldestKey: string | null = null;
    let oldestT = Infinity;
    for (const [k, v] of dedupeCache) {
      if (v.t < oldestT) { oldestT = v.t; oldestKey = k; }
    }
    if (oldestKey) dedupeCache.delete(oldestKey);
  }
  return false;
}

function persistLastHash(hash: string) {
  try {
    ensureStateDir();
    fs.writeFileSync(LAST_HASH_FILE, JSON.stringify({ hash, ts: Date.now() }));
  } catch (e) {
    console.warn('[wa] persist last hash failed:', e);
  }
}

function loadLastHash() {
  try {
    const txt = fs.readFileSync(LAST_HASH_FILE, 'utf8');
    const obj = JSON.parse(txt);
    if (obj?.hash) {
      dedupeCache.set(obj.hash, { t: Date.now() });
      console.log('[wa] loaded last hash to dedupe cache');
    }
  } catch {}
}

function persistOffset(eventId: number) {
  try {
    ensureStateDir();
    fs.writeFileSync(OFFSET_FILE, JSON.stringify({ eventId, ts: Date.now() }));
  } catch (e) {
    console.warn('[wa] persist offset failed:', e);
  }
}

function loadOffset() {
  try {
    const txt = fs.readFileSync(OFFSET_FILE, 'utf8');
    const obj = JSON.parse(txt);
    if (typeof obj?.eventId === 'number' && isFinite(obj.eventId)) {
      lastProcessedEventId = obj.eventId;
      console.log('[wa] loaded lastProcessedEventId:', lastProcessedEventId);
    }
  } catch {}
}

// -------- SQLite durable outbox --------
let db: any;
async function initDb() {
  await loadSqlite();
  ensureStateDir();
  db = new DatabaseCtor(DB_FILE);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS outbox (
      eventId INTEGER PRIMARY KEY,
      refId TEXT,
      toJid TEXT NOT NULL,
      message TEXT NOT NULL,
      replyMessageId TEXT,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      providerMsgId TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_refid_unique ON outbox(refId) WHERE refId IS NOT NULL;
  `);
  try {
    const row = db.query<any>(`SELECT value FROM meta WHERE key = 'sse_offset_${NETWORK_ID}_${BOT_ID}'`).get();
    if (row?.value) {
      const n = Number(row.value);
      if (Number.isFinite(n)) {
        lastProcessedEventId = n;
        console.log('[wa] loaded lastProcessedEventId from db:', n);
      }
    }
  } catch {}
}

function dbSetOffset(n: number) {
  lastProcessedEventId = n;
  db.query(`INSERT INTO meta(key,value) VALUES($k,$v)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value`) 
    .run({ $k: `sse_offset_${NETWORK_ID}_${BOT_ID}`, $v: String(n) });
}

function upsertOutbox(eventId: number, refId: string | undefined, toJid: string, message: string, replyMessageId?: string) {
  const now = Date.now();
  db.query(`INSERT INTO outbox(eventId, refId, toJid, message, replyMessageId, state, attempts, createdAt, updatedAt)
            VALUES($eventId, $refId, $toJid, $message, $replyMessageId, 'queued', 0, $now, $now)
            ON CONFLICT(eventId) DO NOTHING`)
    .run({ $eventId: eventId, $refId: refId ?? null, $toJid: toJid, $message: message, $replyMessageId: replyMessageId ?? null, $now: now });
}

const DISPATCH_CONCURRENCY = Number(env('DISPATCH_CONCURRENCY', '3'));
const SEND_TIMEOUT_MS = Number(env('SEND_TIMEOUT_MS', '20000'));
let inFlight = 0;
let dispatcherStarted = false;

function startDispatcher() {
  if (dispatcherStarted) return;
  dispatcherStarted = true;
  setInterval(async () => {
    try {
      if (!waReady) return;
      while (inFlight < DISPATCH_CONCURRENCY) {
        const row = db.query<any>(`SELECT * FROM outbox WHERE state IN ('queued','retry') ORDER BY eventId ASC LIMIT 1`).get();
        if (!row) break;
        db.query(`UPDATE outbox SET state='sending', updatedAt=$now WHERE eventId=$id`).run({ $now: Date.now(), $id: row.eventId });
        inFlight++;
        void sendOne(row).finally(() => { inFlight--; });
      }
    } catch (e) {
      console.warn('[wa] dispatcher error:', e);
    }
  }, 300);
}

async function sendOne(row: any) {
  const to = row.toJid as string;
  const message = row.message as string;
  const opts: any = {};
  if (row.replyMessageId) opts.quotedMessageId = row.replyMessageId;
  try {
    const msg = await client.sendMessage(to, message || '', opts);
    const providerMsgId = (msg as any)?.id?._serialized || (msg as any)?.id?.id;
    db.query(`UPDATE outbox SET state='sent', providerMsgId=$pmid, updatedAt=$now WHERE eventId=$id`) 
      .run({ $pmid: providerMsgId ?? null, $now: Date.now(), $id: row.eventId });
    // fallback timeout to retry if no ack arrives in time
    setTimeout(() => {
      const stateRow = db.query<any>(`SELECT state, attempts FROM outbox WHERE eventId=$id`).get({ $id: row.eventId });
      if (!stateRow || stateRow.state === 'acked') return;
      const attempts = (stateRow?.attempts ?? 0) + 1;
      const willRetry = attempts <= 5;
      db.query(`UPDATE outbox SET state=$state, attempts=$att, updatedAt=$now WHERE eventId=$id`) 
        .run({ $state: willRetry ? 'retry' : 'failed', $att: attempts, $now: Date.now(), $id: row.eventId });
    }, SEND_TIMEOUT_MS);
  } catch (e) {
    const attempts = (row.attempts ?? 0) + 1;
    const willRetry = attempts <= 5;
    db.query(`UPDATE outbox SET state=$state, attempts=$att, updatedAt=$now WHERE eventId=$id`) 
      .run({ $state: willRetry ? 'retry' : 'failed', $att: attempts, $now: Date.now(), $id: row.eventId });
    console.error('[wa] sendOne error:', e);
  }
}

client.on('message_ack', (msg, ack) => {
  try {
    const pmid = (msg as any)?.id?._serialized || (msg as any)?.id?.id;
    if (!pmid) return;
    if (typeof ack === 'number' && ack >= 1) {
      const row = db.query<any>(`SELECT eventId FROM outbox WHERE providerMsgId=$pmid`).get({ $pmid: pmid });
      if (!row) return;
      db.query(`UPDATE outbox SET state='acked', updatedAt=$now WHERE eventId=$id`).run({ $now: Date.now(), $id: row.eventId });
      advanceCheckpoint();
    }
  } catch (e) {
    console.warn('[wa] message_ack handler error:', e);
  }
});

function advanceCheckpoint() {
  try {
    let next = (lastProcessedEventId ?? 0) + 1;
    while (true) {
      const row = db.query<any>(`SELECT state FROM outbox WHERE eventId=$id`).get({ $id: next });
      if (!row || row.state !== 'acked') break;
      dbSetOffset(next);
      next += 1;
      if (next % 50 === 0) {
        db.exec(`DELETE FROM outbox WHERE eventId < ${next - 100} AND state='acked'`);
      }
    }
  } catch (e) {
    console.warn('[wa] advanceCheckpoint error:', e);
  }
}

async function startSSE() {
  const url = `${BASE}/api/messages/out/${encodeURIComponent(NETWORK_ID)}/${encodeURIComponent(BOT_ID)}`;
  const ac = new AbortController();
  sseAbort = ac;
  console.log('[wa] SSE connecting to', url);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        ...(lastProcessedEventId != null ? { 'Last-Event-ID': String(lastProcessedEventId) } : {}),
      },
      signal: ac.signal,
    }, { verbose: true } as any);
    if (!res.ok || !res.body) {
      console.error('[wa] SSE connect failed', res.status);
      throw new Error(`SSE HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    lastSseActivity = Date.now();
    startSseHealthCheck();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      lastSseActivity = Date.now();
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
      await delay(sseRetryDelay + Math.floor(Math.random() * 300));
      sseRetryDelay = Math.min(sseRetryDelay * 2, 30000);
      startSSE();
    }
  }
}

function handleSSEEvent(chunk: string) {
  lastSseActivity = Date.now();
  let event: string | null = null;
  let data: string[] = [];
  let idHeader: string | null = null;
  const lines = chunk.split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue; // comment/heartbeat
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    else if (line.startsWith('id:')) idHeader = line.slice(3).trim();
  }

  // If server omits 'event', SSE defaults to 'message'
  if (!event) event = 'message';
  if (event !== 'message') return;

  try {
    // Only process frames that actually carry data lines
    if (data.length === 0) return;
    const jsonText = data.join('\n').trim();
    if (!jsonText || jsonText[0] !== '{') return; // ignore non-JSON data frames like "retry: 3000"
    const payload = JSON.parse(jsonText) as OutboundSSE;
    if (payload.networkId !== NETWORK_ID || payload.botId !== BOT_ID) return;
    // Only send gateway-directed outbound messages (avoid echoing our own inbound posts)
    if (payload.direction && payload.direction !== 'out') {
      return;
    }

    // Determine eventId (prefer data.eventId, fallback to numeric SSE id header)
    let eventIdNum: number | null = null;
    if (typeof payload.eventId === 'number' && isFinite(payload.eventId)) {
      eventIdNum = payload.eventId;
    } else if (idHeader != null) {
      const n = Number(idHeader);
      if (Number.isFinite(n)) eventIdNum = n;
    }
    if (eventIdNum != null && lastProcessedEventId != null && eventIdNum <= lastProcessedEventId) {
      // If refId present and unseen, accept despite older eventId (handles gateway epoch reset)
      if (payload.refId) {
        const seen = !!db?.query?.(`SELECT 1 FROM outbox WHERE refId=$r LIMIT 1`).get({ $r: payload.refId });
        if (!seen) {
          console.warn('[wa] eventId older than last, but refId unseen — accepting', { eventIdNum, lastProcessedEventId, refId: payload.refId });
        } else {
          console.log('[wa] dedupe skip (eventId<=last with seen refId)', { eventIdNum, lastProcessedEventId });
          return;
        }
      } else {
        console.log('[wa] dedupe skip (eventId<=last)', { eventIdNum, lastProcessedEventId });
        return;
      }
    }
    const to = payload.groupId || payload.userId;
    if (!to) {
      console.warn('[wa] outbound has no target (userId/groupId)');
      return;
    }
    const opts: any = {};
    if (payload.replyMessageId) opts.quotedMessageId = payload.replyMessageId;

    // Only use payload-hash dedupe when no eventId present
    let hash: string | null = null;
    if (eventIdNum == null) {
      const key = payloadKey(to, payload.message || '', payload.replyMessageId);
      hash = fnv1a(key);
      if (dedupeSeen(hash)) {
        console.log('[wa] dedupe skip (hash)');
        return;
      }
    }

    if (eventIdNum != null) {
      console.log('[wa] enqueue outbound ->', { to, hasReply: !!payload.replyMessageId, preview: payload.message?.slice(0, 80), eventId: eventIdNum });
      upsertOutbox(eventIdNum, payload.refId, to, payload.message || '', payload.replyMessageId);
      startDispatcher();
    } else {
      console.log('[wa] outbound (no eventId) ->', { to, hasReply: !!payload.replyMessageId, preview: payload.message?.slice(0, 80) });
      const send = () => client.sendMessage(to, payload.message || '', opts).catch((e) => {
        console.error('[wa] sendMessage error:', e);
      });
      if (!waReady) {
        outboundQueue.push({ to, message: payload.message || '', opts });
        console.log('[wa] queued outbound (client not ready)');
      } else {
        send();
      }
      if (hash) persistLastHash(hash);
    }
  } catch (e) {
    console.warn('[wa] SSE parse error:', e);
  }
}

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function startSseHealthCheck() {
  if (sseHealthTimer) return;
  sseHealthTimer = setInterval(() => {
    const now = Date.now();
    if (now - lastSseActivity > SSE_STALE_MS) {
      console.warn('[wa] SSE appears stale; restarting connection');
      try { sseAbort?.abort(); } catch {}
      sseAbort = null;
      lastSseActivity = now;
      sseRetryDelay = 1500;
      startSSE();
    }
  }, SSE_CHECK_INTERVAL_MS);
}

// -------- Start --------
(async () => {
  console.log('[wa] adaptor starting with', { BASE, BOT_TYPE, BOT_ID, NETWORK_ID });
  await initDb();
  loadOffset();
  loadLastHash();
  client.initialize().catch((err) => console.error('[wa] init failed:', err));
  // start SSE after a small delay to allow login; it will also work before login
  setTimeout(() => { startSSE(); }, 500);
})();
