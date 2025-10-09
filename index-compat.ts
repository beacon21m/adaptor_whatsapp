/*
  Compatibility version of enhanced WhatsApp adapter
  Works with existing gateway while adding reliability improvements
  
  Key changes:
  - Compatible with existing SSE payload format
  - Better error handling for ECONNRESET
  - Enhanced debugging without verbose errors
  - Maintains persistent queue and retry logic
*/

import qrcode from 'qrcode-terminal';
import { Client, LocalAuth } from 'whatsapp-web.js';
import fs from 'fs';
import path from 'path';

// Dynamic import for bun:sqlite
let DatabaseCtor: any;
async function loadSqlite() {
  if (!DatabaseCtor) {
    const mod = await import('bun:sqlite');
    DatabaseCtor = (mod as any).Database;
  }
}

// -------- Types (matching existing gateway) --------
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

// -------- Environment Configuration --------
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
const STATE_DIR = env('STATE_DIR', '.state');
const DB_FILE = path.join(STATE_DIR, 'state.sqlite');

// Settings
const SSE_STALE_MS = Number(env('SSE_STALE_MS', '10000'));
const SSE_CHECK_INTERVAL_MS = Number(env('SSE_CHECK_INTERVAL_MS', '1000'));
const DISPATCH_CONCURRENCY = Number(env('DISPATCH_CONCURRENCY', '3'));
const SEND_TIMEOUT_MS = Number(env('SEND_TIMEOUT_MS', '20000'));
const MAX_RETRIES = Number(env('MAX_RETRIES', '5'));

// -------- WhatsApp Client Setup --------
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

// -------- Database Setup --------
let db: any;

async function initDb() {
  await loadSqlite();
  ensureStateDir();
  db = new DatabaseCtor(DB_FILE);
  
  db.exec(`
    PRAGMA journal_mode=WAL;
    
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eventId INTEGER,
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
    CREATE INDEX IF NOT EXISTS idx_outbox_eventId ON outbox(eventId);
    CREATE INDEX IF NOT EXISTS idx_outbox_state_event ON outbox(state, eventId);
  `);
  
  // Load last processed event ID
  try {
    const row = db.query<any>(`SELECT value FROM meta WHERE key = 'sse_offset_${NETWORK_ID}_${BOT_ID}'`).get();
    if (row?.value) {
      const n = Number(row.value);
      if (Number.isFinite(n)) {
        lastProcessedEventId = n;
        console.log('[adapter] Loaded lastProcessedEventId from DB:', n);
      }
    }
  } catch {}
}

function ensureStateDir() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch {}
}

function dbSetOffset(n: number) {
  lastProcessedEventId = n;
  db.query(`INSERT INTO meta(key,value) VALUES($k,$v)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
    .run({ $k: `sse_offset_${NETWORK_ID}_${BOT_ID}`, $v: String(n) });
}

// -------- Message Queue --------
function upsertOutbox(eventId: number, refId: string | undefined, toJid: string, message: string, replyMessageId?: string) {
  const now = Date.now();
  if (refId) {
    // Idempotent on refId
    db.query(`INSERT OR IGNORE INTO outbox(eventId, refId, toJid, message, replyMessageId, state, attempts, createdAt, updatedAt)
              VALUES($eventId, $refId, $toJid, $message, $replyMessageId, 'queued', 0, $now, $now)`)
      .run({ $eventId: eventId ?? null, $refId: refId, $toJid: toJid, $message: message, $replyMessageId: replyMessageId ?? null, $now: now });
  } else {
    db.query(`INSERT INTO outbox(eventId, refId, toJid, message, replyMessageId, state, attempts, createdAt, updatedAt)
              VALUES($eventId, NULL, $toJid, $message, $replyMessageId, 'queued', 0, $now, $now)`)
      .run({ $eventId: eventId ?? null, $toJid: toJid, $message: message, $replyMessageId: replyMessageId ?? null, $now: now });
  }
}

// -------- Dispatcher --------
let dispatcherStarted = false;
let inFlight = 0;

function startDispatcher() {
  if (dispatcherStarted) return;
  dispatcherStarted = true;
  
  setInterval(async () => {
    try {
      if (!waReady) return;
      
      while (inFlight < DISPATCH_CONCURRENCY) {
        const row = db.query<any>(`SELECT * FROM outbox WHERE state IN ('queued','retry') ORDER BY createdAt ASC LIMIT 1`).get();
        if (!row) break;
        
        db.query(`UPDATE outbox SET state='sending', updatedAt=$now WHERE id=$id`)
          .run({ $now: Date.now(), $id: row.id });
        
        inFlight++;
        void sendOne(row).finally(() => { inFlight--; });
      }
    } catch (e) {
      console.error('[adapter] Dispatcher error:', e);
    }
  }, 300);
}

async function sendOne(row: any) {
  const to = row.toJid as string;
  const message = row.message as string;
  const opts: any = {};
  if (row.replyMessageId) opts.quotedMessageId = row.replyMessageId;
  
  try {
    console.log(`[adapter] Sending to WhatsApp: ${to} - ${message.slice(0, 50)}...`);
    const msg = await client.sendMessage(to, message || '', opts);
    const providerMsgId = (msg as any)?.id?._serialized || (msg as any)?.id?.id;
    
    db.query(`UPDATE outbox SET state='sent', providerMsgId=$pmid, updatedAt=$now WHERE id=$id`)
      .run({ $pmid: providerMsgId ?? null, $now: Date.now(), $id: row.id });
    
    console.log(`[adapter] Sent successfully: ${providerMsgId}`);
    
    // Set timeout for retry if no ACK
    setTimeout(() => {
      const stateRow = db.query<any>(`SELECT state, attempts FROM outbox WHERE id=$id`).get({ $id: row.id });
      if (!stateRow || stateRow.state === 'acked') return;
      
      const attempts = (stateRow?.attempts ?? 0) + 1;
      const willRetry = attempts <= MAX_RETRIES;
      
      db.query(`UPDATE outbox SET state=$state, attempts=$att, updatedAt=$now WHERE id=$id`)
        .run({ $state: willRetry ? 'retry' : 'failed', $att: attempts, $now: Date.now(), $id: row.id });
    }, SEND_TIMEOUT_MS);
  } catch (e) {
    console.error('[adapter] Send error:', e);
    const attempts = (row.attempts ?? 0) + 1;
    const willRetry = attempts <= MAX_RETRIES;
    
    db.query(`UPDATE outbox SET state=$state, attempts=$att, updatedAt=$now WHERE id=$id`)
      .run({ $state: willRetry ? 'retry' : 'failed', $att: attempts, $now: Date.now(), $id: row.id });
  }
}

// -------- WhatsApp Event Handlers --------
client.on('qr', (qr) => {
  console.log('[adapter] Scan QR to authenticate:');
  try {
    qrcode.generate(qr, { small: true });
  } catch {
    console.log('QR (raw):', qr);
  }
});

client.on('ready', () => {
  console.log(`[adapter] WhatsApp READY as ${((client as any).info?.wid?._serialized) || 'unknown'}`);
  waReady = true;
  
  // Flush queued messages
  if (outboundQueue.length) {
    console.log(`[adapter] Flushing ${outboundQueue.length} queued messages`);
    for (const item of outboundQueue.splice(0)) {
      client.sendMessage(item.to, item.message, item.opts).catch((e) => {
        console.error('[adapter] Flush send error:', e);
      });
    }
  }
});

client.on('authenticated', () => console.log('[adapter] WhatsApp authenticated'));
client.on('auth_failure', (msg) => console.error('[adapter] WhatsApp auth failed:', msg));
client.on('disconnected', (reason) => {
  console.warn('[adapter] WhatsApp disconnected:', reason);
  waReady = false;
});

client.on('message_ack', (msg, ack) => {
  try {
    const pmid = (msg as any)?.id?._serialized || (msg as any)?.id?.id;
    if (!pmid) return;
    
    if (typeof ack === 'number' && ack >= 1) {
      const row = db.query<any>(`SELECT id, eventId FROM outbox WHERE providerMsgId=$pmid`).get({ $pmid: pmid });
      if (!row) return;
      
      db.query(`UPDATE outbox SET state='acked', updatedAt=$now WHERE id=$id`)
        .run({ $now: Date.now(), $id: row.id });
      
      advanceCheckpoint();
    }
  } catch (e) {
    console.warn('[adapter] Message ACK handler error:', e);
  }
});

function advanceCheckpoint() {
  try {
    let advanced = false;
    let next = (lastProcessedEventId ?? 0) + 1;
    
    while (true) {
      const row = db.query<any>(`SELECT state FROM outbox WHERE eventId=$eid ORDER BY id ASC LIMIT 1`).get({ $eid: next });
      if (!row || row.state !== 'acked') break;
      
      dbSetOffset(next);
      advanced = true;
      next += 1;
    }
    
    if (advanced) {
      const cutoff = (lastProcessedEventId ?? 0) - 100;
      if (cutoff > 0) {
        db.exec(`DELETE FROM outbox WHERE eventId <= ${cutoff} AND state='acked'`);
      }
    }
  } catch (e) {
    console.warn('[adapter] Checkpoint advance error:', e);
  }
}

// Inbound: WhatsApp -> Gateway
client.on('message', async (msg) => {
  try {
    // Ignore self messages
    if ((msg as any)?.fromMe) return;
    
    const isGroup = String(msg.from).endsWith('@g.us');
    const groupId = isGroup ? msg.from : undefined;
    const userId = isGroup ? (msg as any)?.author : msg.from;
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
    
    console.log(`[adapter] Received from WhatsApp: ${userId} - ${msg.body?.slice(0, 50)}...`);
    
    const res = await fetch(`${BASE}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    
    if (!res.ok) {
      console.error('[adapter] Failed to forward to gateway:', res.status);
    } else {
      console.log('[adapter] Forwarded to gateway successfully');
    }
  } catch (e) {
    console.error('[adapter] Inbound error:', e);
  }
});

// -------- SSE Connection --------
let sseAbort: AbortController | null = null;
let lastProcessedEventId: number | null = null;
let sseRetryDelay = 1500;
let lastSseActivity = Date.now();
let sseHealthTimer: ReturnType<typeof setInterval> | null = null;

async function startSSE() {
  const url = `${BASE}/api/messages/out/${encodeURIComponent(NETWORK_ID)}/${encodeURIComponent(BOT_ID)}`;
  const ac = new AbortController();
  sseAbort = ac;
  
  console.log('[adapter] Connecting to SSE:', url, 'lastEventId:', lastProcessedEventId);
  
  try {
    const headers: Record<string, string> = {
      'accept': 'text/event-stream',
    };
    
    if (lastProcessedEventId != null) {
      headers['Last-Event-ID'] = String(lastProcessedEventId);
    }
    
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: ac.signal,
    });
    
    if (!res.ok || !res.body) {
      console.error('[adapter] SSE connection failed:', res.status);
      throw new Error(`SSE HTTP ${res.status}`);
    }
    
    console.log('[adapter] SSE connected');
    sseRetryDelay = 1500; // Reset on successful connection
    
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
      
      // Process complete SSE events
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleSSEEvent(rawEvent);
      }
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      // Intentional abort, don't log as error
    } else if (e?.code === 'ECONNRESET') {
      // Connection reset - this is expected when gateway closes after sending
      console.log('[adapter] SSE connection closed by gateway (likely after message send)');
    } else {
      console.warn('[adapter] SSE error:', e.message || e);
    }
    
    // Reconnect with backoff
    await delay(sseRetryDelay + Math.floor(Math.random() * 300));
    sseRetryDelay = Math.min(sseRetryDelay * 2, 30000);
    startSSE();
  }
}

function handleSSEEvent(chunk: string) {
  lastSseActivity = Date.now();
  
  // Log every SSE event with detailed breakdown
  console.log('=== SSE EVENT START ===');
  console.log('[adapter] Raw SSE chunk:', chunk.replace(/\n/g, '\\n'));
  
  let event: string | null = null;
  let data: string[] = [];
  let idHeader: string | null = null;
  
  const lines = chunk.split(/\r?\n/);
  console.log('[adapter] SSE lines breakdown:');
  for (const line of lines) {
    console.log(`  Line: "${line}"`);
    
    if (!line || line.startsWith(':')) {
      console.log('    -> Skipped: empty or comment');
      continue;
    }
    
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      console.log(`    -> Event type: "${event}"`);
    } else if (line.startsWith('data:')) {
      const dataContent = line.slice(5).trim();
      data.push(dataContent);
      console.log(`    -> Data line: "${dataContent.slice(0, 100)}${dataContent.length > 100 ? '...' : ''}"`);
    } else if (line.startsWith('id:')) {
      idHeader = line.slice(3).trim();
      console.log(`    -> ID header: "${idHeader}"`);
    } else if (line.startsWith('retry:')) {
      console.log(`    -> Retry directive: "${line.slice(6).trim()}"`);
    } else {
      console.log(`    -> Unknown line format`);
    }
  }
  
  // Default event type is 'message'
  if (!event) {
    event = 'message';
    console.log('[adapter] No event type specified, defaulting to "message"');
  }
  
  console.log(`[adapter] Final event type: "${event}"`);
  
  if (event !== 'message') {
    console.log(`[adapter] REJECTED: Event type "${event}" is not "message"`);
    console.log('=== SSE EVENT END (REJECTED) ===\n');
    return;
  }
  
  try {
    // Process data lines
    if (data.length === 0) {
      console.log('[adapter] REJECTED: No data lines found');
      console.log('=== SSE EVENT END (REJECTED) ===\n');
      return;
    }
    
    const jsonText = data.join('\n').trim();
    console.log(`[adapter] Combined data text: "${jsonText.slice(0, 200)}${jsonText.length > 200 ? '...' : ''}"`);
    
    if (!jsonText || jsonText[0] !== '{') {
      if (jsonText.startsWith('retry:')) {
        console.log('[adapter] REJECTED: Retry directive in data (not JSON)');
      } else {
        console.log('[adapter] REJECTED: Data is not JSON format');
      }
      console.log('=== SSE EVENT END (REJECTED) ===\n');
      return;
    }
    
    const payload = JSON.parse(jsonText) as OutboundSSE;
    console.log('[adapter] PARSED JSON successfully:');
    console.log(`  networkId: "${payload.networkId}"`);
    console.log(`  botId: "${payload.botId}"`);
    console.log(`  direction: "${payload.direction}"`);
    console.log(`  eventId: ${payload.eventId}`);
    console.log(`  refId: "${payload.refId}"`);
    console.log(`  target: "${payload.groupId || payload.userId}"`);
    console.log(`  message: "${payload.message?.slice(0, 100)}${(payload.message?.length || 0) > 100 ? '...' : ''}"`);
    console.log(`  replyMessageId: "${payload.replyMessageId}"`);
    
    // Filter by network and bot
    if (payload.networkId !== NETWORK_ID) {
      console.log(`[adapter] REJECTED: Wrong networkId. Expected "${NETWORK_ID}", got "${payload.networkId}"`);
      console.log('=== SSE EVENT END (REJECTED) ===\n');
      return;
    }
    
    if (payload.botId !== BOT_ID) {
      console.log(`[adapter] REJECTED: Wrong botId. Expected "${BOT_ID}", got "${payload.botId}"`);
      console.log('=== SSE EVENT END (REJECTED) ===\n');
      return;
    }
    
    console.log('[adapter] ✓ Network and Bot ID match');
    
    // Only process outbound messages
    if (payload.direction && payload.direction !== 'out') {
      console.log(`[adapter] REJECTED: Direction is "${payload.direction}", not "out"`);
      console.log('=== SSE EVENT END (REJECTED) ===\n');
      return;
    }
    
    console.log('[adapter] ✓ Direction check passed (outbound or no direction specified)');
    
    // Determine eventId
    let eventIdNum: number | null = null;
    if (typeof payload.eventId === 'number' && isFinite(payload.eventId)) {
      eventIdNum = payload.eventId;
      console.log(`[adapter] ✓ EventId from payload: ${eventIdNum}`);
    } else if (idHeader != null) {
      const n = Number(idHeader);
      if (Number.isFinite(n)) {
        eventIdNum = n;
        console.log(`[adapter] ✓ EventId from SSE header: ${eventIdNum}`);
      } else {
        console.log(`[adapter] ⚠ EventId header "${idHeader}" is not a valid number`);
      }
    } else {
      console.log('[adapter] ⚠ No eventId found in payload or header');
    }
    
    // Check for duplicate
    if (eventIdNum != null && lastProcessedEventId != null && eventIdNum <= lastProcessedEventId) {
      console.log(`[adapter] DUPLICATE CHECK: EventId ${eventIdNum} <= lastProcessed ${lastProcessedEventId}`);
      
      // Check refId exception
      if (payload.refId) {
        const seen = db.query<any>(`SELECT 1 FROM outbox WHERE refId=$r LIMIT 1`).get({ $r: payload.refId });
        if (!seen) {
          console.log(`[adapter] ✓ RefId "${payload.refId}" not seen before, accepting despite old eventId`);
        } else {
          console.log(`[adapter] REJECTED: Duplicate eventId ${eventIdNum} and refId "${payload.refId}" already seen`);
          console.log('=== SSE EVENT END (REJECTED) ===\n');
          return;
        }
      } else {
        console.log(`[adapter] REJECTED: Duplicate eventId ${eventIdNum} (no refId to check)`);
        console.log('=== SSE EVENT END (REJECTED) ===\n');
        return;
      }
    } else {
      console.log(`[adapter] ✓ Duplicate check passed. EventId: ${eventIdNum}, lastProcessed: ${lastProcessedEventId}`);
    }
    
    const to = payload.groupId || payload.userId;
    if (!to) {
      console.log('[adapter] REJECTED: No target (groupId or userId) specified');
      console.log('=== SSE EVENT END (REJECTED) ===\n');
      return;
    }
    
    console.log(`[adapter] ✓ Target recipient: "${to}"`);
    
    // Queue for sending
    if (eventIdNum != null) {
      console.log(`[adapter] ACCEPTED: Queueing message with eventId ${eventIdNum} for "${to}"`);
      console.log(`[adapter] Message preview: "${payload.message?.slice(0, 100)}${(payload.message?.length || 0) > 100 ? '...' : ''}"`);
      
      upsertOutbox(eventIdNum, payload.refId, to, payload.message || '', payload.replyMessageId);
      startDispatcher();
      
      console.log('[adapter] ✓ Message added to outbox and dispatcher started');
    } else {
      // Direct send without eventId
      console.log(`[adapter] ACCEPTED: Direct sending message (no eventId) to "${to}"`);
      const opts: any = {};
      if (payload.replyMessageId) {
        opts.quotedMessageId = payload.replyMessageId;
        console.log(`[adapter] ✓ Will quote message: "${payload.replyMessageId}"`);
      }
      
      if (!waReady) {
        outboundQueue.push({ to, message: payload.message || '', opts });
        console.log('[adapter] ✓ Queued for later (WhatsApp not ready)');
      } else {
        console.log('[adapter] ✓ Sending immediately to WhatsApp');
        client.sendMessage(to, payload.message || '', opts).catch((e) => {
          console.error('[adapter] Direct send error:', e);
        });
      }
    }
    
    console.log('=== SSE EVENT END (ACCEPTED) ===\n');
  } catch (e) {
    console.error('[adapter] REJECTED: JSON parse error:', e);
    console.log('=== SSE EVENT END (ERROR) ===\n');
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function startSseHealthCheck() {
  if (sseHealthTimer) return;
  
  sseHealthTimer = setInterval(() => {
    const now = Date.now();
    if (now - lastSseActivity > SSE_STALE_MS) {
      console.log('[adapter] SSE appears stale, reconnecting');
      
      try {
        sseAbort?.abort();
      } catch {}
      
      sseAbort = null;
      lastSseActivity = now;
      sseRetryDelay = 1500;
      startSSE();
    }
  }, SSE_CHECK_INTERVAL_MS);
}

// -------- Initialization --------
async function init() {
  console.log('[adapter] Starting WhatsApp adapter (compatibility mode)');
  console.log('[adapter] Gateway:', BASE);
  console.log('[adapter] Network:', NETWORK_ID, 'Bot:', BOT_ID);
  
  // Initialize database
  await initDb();
  
  // Initialize WhatsApp client
  await client.initialize();
  
  // Start SSE after a short delay
  setTimeout(() => {
    startSSE();
  }, 500);
  
  // Start dispatcher
  startDispatcher();
}

// Start the adapter
init().catch(console.error);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('[adapter] Shutting down...');
  
  if (sseAbort) {
    sseAbort.abort();
  }
  
  if (sseHealthTimer) {
    clearInterval(sseHealthTimer);
  }
  
  await client.destroy();
  
  if (db) {
    db.close();
  }
  
  process.exit(0);
});