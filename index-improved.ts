/*
  Enhanced WhatsApp Adapter with Reliability Improvements
  
  Key enhancements:
  - ACK/Confirm/Fail message status tracking
  - Heartbeat monitoring with 45-second timeout
  - Proper SSE reconnection with Last-Event-ID
  - Idempotency tracking for processed messages
  - Retry logic with exponential backoff
  - Persistent message queue
  - Enhanced logging for observability
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

// -------- Types --------
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
  messageId?: string; // Gateway-assigned message ID
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

type MessageState = 'pending' | 'delivered' | 'sending' | 'sent' | 'failed' | 'retry';

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

// Reliability settings
const HEARTBEAT_TIMEOUT_MS = Number(env('HEARTBEAT_TIMEOUT_MS', '45000')); // 45 seconds
const HEARTBEAT_CHECK_INTERVAL_MS = Number(env('HEARTBEAT_CHECK_INTERVAL_MS', '10000')); // 10 seconds
const DISPATCH_CONCURRENCY = Number(env('DISPATCH_CONCURRENCY', '3'));
const MAX_RETRY_ATTEMPTS = Number(env('MAX_RETRY_ATTEMPTS', '3'));
const INITIAL_RETRY_DELAY_MS = Number(env('INITIAL_RETRY_DELAY_MS', '1000'));
const MAX_RETRY_DELAY_MS = Number(env('MAX_RETRY_DELAY_MS', '30000'));

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

// -------- Database Setup --------
let db: any;

async function initDb() {
  await loadSqlite();
  ensureStateDir();
  db = new DatabaseCtor(DB_FILE);
  
  // Initialize tables
  db.exec(`
    PRAGMA journal_mode=WAL;
    
    -- Messages table for tracking all messages
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      messageId TEXT UNIQUE NOT NULL,
      eventId INTEGER,
      refId TEXT,
      recipient TEXT NOT NULL,
      content TEXT NOT NULL,
      replyMessageId TEXT,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      externalId TEXT,
      error TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      ackedAt INTEGER,
      sentAt INTEGER,
      failedAt INTEGER
    );
    
    -- Processed messages for idempotency
    CREATE TABLE IF NOT EXISTS processed_messages (
      messageId TEXT PRIMARY KEY,
      processedAt INTEGER NOT NULL
    );
    
    -- Metadata storage
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    
    -- Create indexes
    CREATE INDEX IF NOT EXISTS idx_messages_state ON messages(state);
    CREATE INDEX IF NOT EXISTS idx_messages_eventId ON messages(eventId);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_refId ON messages(refId) WHERE refId IS NOT NULL;
  `);
  
  // Load last processed event ID
  try {
    const row = db.query<any>(`SELECT value FROM meta WHERE key = 'last_event_id'`).get();
    if (row?.value) {
      lastEventId = Number(row.value);
      console.log('[adapter] Loaded last event ID from DB:', lastEventId);
    }
  } catch (e) {
    console.error('[adapter] Failed to load last event ID:', e);
  }
  
  // Cleanup old processed messages (older than 7 days)
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  db.exec(`DELETE FROM processed_messages WHERE processedAt < ${sevenDaysAgo}`);
}

function ensureStateDir() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch {}
}

// -------- Message Queue Management --------
function queueMessage(message: OutboundSSE): void {
  const now = Date.now();
  const recipient = message.groupId || message.userId || '';
  
  try {
    // Check if already processed (idempotency)
    if (message.messageId && isMessageProcessed(message.messageId)) {
      console.log(`[adapter] Skipping duplicate message ${message.messageId}`);
      return;
    }
    
    // Insert into messages table
    db.query(`
      INSERT INTO messages (
        messageId, eventId, refId, recipient, content, replyMessageId, 
        state, attempts, createdAt, updatedAt
      ) VALUES (
        $messageId, $eventId, $refId, $recipient, $content, $replyMessageId,
        'pending', 0, $now, $now
      )
    `).run({
      $messageId: message.messageId || `local_${Date.now()}_${Math.random()}`,
      $eventId: message.eventId ?? null,
      $refId: message.refId ?? null,
      $recipient: recipient,
      $content: message.message || '',
      $replyMessageId: message.replyMessageId ?? null,
      $now: now
    });
    
    console.log(`[adapter] Queued message ${message.messageId} for ${recipient}`);
  } catch (e) {
    console.error('[adapter] Failed to queue message:', e);
  }
}

function isMessageProcessed(messageId: string): boolean {
  const row = db.query<any>(`SELECT 1 FROM processed_messages WHERE messageId = $id`).get({ $id: messageId });
  return !!row;
}

function markMessageProcessed(messageId: string): void {
  db.query(`INSERT OR REPLACE INTO processed_messages (messageId, processedAt) VALUES ($id, $now)`)
    .run({ $id: messageId, $now: Date.now() });
}

// -------- ACK/Confirm/Fail Endpoints --------
async function ackMessage(messageId: string): Promise<void> {
  try {
    // Note: These endpoints may not exist in the current gateway
    // Wrapping in try-catch to handle gracefully
    const response = await fetch(`${BASE}/api/messages/${messageId}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    
    if (!response.ok) {
      throw new Error(`ACK failed: ${response.status}`);
    }
    
    // Update local state
    db.query(`UPDATE messages SET state = 'delivered', ackedAt = $now, updatedAt = $now WHERE messageId = $id`)
      .run({ $id: messageId, $now: Date.now() });
    
    console.log(`[adapter] ACKed message ${messageId}`);
  } catch (e) {
    console.error(`[adapter] Failed to ACK message ${messageId}:`, e);
    throw e;
  }
}

async function confirmMessage(messageId: string, externalId: string): Promise<void> {
  try {
    const response = await fetch(`${BASE}/api/messages/${messageId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        externalId,
        sentAt: new Date().toISOString()
      })
    });
    
    if (!response.ok) {
      throw new Error(`Confirm failed: ${response.status}`);
    }
    
    // Update local state
    db.query(`UPDATE messages SET state = 'sent', externalId = $extId, sentAt = $now, updatedAt = $now WHERE messageId = $id`)
      .run({ $id: messageId, $extId: externalId, $now: Date.now() });
    
    console.log(`[adapter] Confirmed message ${messageId} (external: ${externalId})`);
  } catch (e) {
    console.error(`[adapter] Failed to confirm message ${messageId}:`, e);
    throw e;
  }
}

async function failMessage(messageId: string, reason: string, error: string, retriable: boolean = false): Promise<void> {
  try {
    const response = await fetch(`${BASE}/api/messages/${messageId}/fail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason, error, retriable })
    });
    
    if (!response.ok) {
      throw new Error(`Fail report failed: ${response.status}`);
    }
    
    // Update local state
    db.query(`UPDATE messages SET state = 'failed', error = $error, failedAt = $now, updatedAt = $now WHERE messageId = $id`)
      .run({ $id: messageId, $error: `${reason}: ${error}`, $now: Date.now() });
    
    console.log(`[adapter] Reported failure for message ${messageId}: ${reason}`);
  } catch (e) {
    console.error(`[adapter] Failed to report failure for message ${messageId}:`, e);
  }
}

// -------- Message Dispatcher --------
let dispatcherRunning = false;

function startDispatcher() {
  if (dispatcherRunning) return;
  dispatcherRunning = true;
  
  setInterval(async () => {
    if (!waReady) return;
    
    try {
      // Get pending messages
      const pending = db.query<any>(`
        SELECT * FROM messages 
        WHERE state IN ('pending', 'delivered', 'retry') 
        ORDER BY createdAt ASC 
        LIMIT ${DISPATCH_CONCURRENCY}
      `).all();
      
      for (const msg of pending) {
        // Don't retry if we've exceeded max attempts
        if (msg.attempts >= MAX_RETRY_ATTEMPTS && msg.state === 'retry') {
          await failMessage(msg.messageId, 'max_retries_exceeded', `Failed after ${msg.attempts} attempts`, false);
          continue;
        }
        
        // Update state to sending
        db.query(`UPDATE messages SET state = 'sending', attempts = attempts + 1, updatedAt = $now WHERE id = $id`)
          .run({ $id: msg.id, $now: Date.now() });
        
        // Process message asynchronously
        processMessage(msg);
      }
    } catch (e) {
      console.error('[adapter] Dispatcher error:', e);
    }
  }, 1000); // Check every second
}

async function processMessage(msg: any) {
  const retryDelay = Math.min(
    INITIAL_RETRY_DELAY_MS * Math.pow(2, msg.attempts - 1),
    MAX_RETRY_DELAY_MS
  );
  
  try {
    // ACK if not already done
    if (msg.state === 'pending' && msg.messageId) {
      try {
        await ackMessage(msg.messageId);
      } catch (e) {
        // Continue processing even if ACK fails
        console.warn(`[adapter] ACK failed for ${msg.messageId}, continuing...`);
      }
    }
    
    // Send to WhatsApp
    const opts: any = {};
    if (msg.replyMessageId) {
      opts.quotedMessageId = msg.replyMessageId;
    }
    
    console.log(`[adapter] Sending message ${msg.messageId} to ${msg.recipient} (attempt ${msg.attempts})`);
    const sentMsg = await client.sendMessage(msg.recipient, msg.content, opts);
    const externalId = (sentMsg as any)?.id?._serialized || (sentMsg as any)?.id?.id;
    
    // Confirm send
    if (msg.messageId && externalId) {
      await confirmMessage(msg.messageId, externalId);
    } else {
      // Just update local state if no messageId
      db.query(`UPDATE messages SET state = 'sent', externalId = $extId, sentAt = $now, updatedAt = $now WHERE id = $id`)
        .run({ $id: msg.id, $extId: externalId, $now: Date.now() });
    }
    
    // Mark as processed for idempotency
    if (msg.messageId) {
      markMessageProcessed(msg.messageId);
    }
    
    console.log(`[adapter] Successfully sent message ${msg.messageId} (external: ${externalId})`);
  } catch (e: any) {
    console.error(`[adapter] Failed to send message ${msg.messageId}:`, e);
    
    // Determine if we should retry
    const shouldRetry = msg.attempts < MAX_RETRY_ATTEMPTS && e.retriable !== false;
    
    if (shouldRetry) {
      // Schedule retry with exponential backoff
      db.query(`UPDATE messages SET state = 'retry', updatedAt = $now WHERE id = $id`)
        .run({ $id: msg.id, $now: Date.now() });
      
      console.log(`[adapter] Will retry message ${msg.messageId} in ${retryDelay}ms (attempt ${msg.attempts}/${MAX_RETRY_ATTEMPTS})`);
      
      setTimeout(() => {
        // Re-queue for processing
        db.query(`UPDATE messages SET state = 'pending', updatedAt = $now WHERE id = $id AND state = 'retry'`)
          .run({ $id: msg.id, $now: Date.now() });
      }, retryDelay);
    } else {
      // Report permanent failure
      if (msg.messageId) {
        await failMessage(msg.messageId, e.code || 'send_failed', e.message || 'Unknown error', false);
      } else {
        db.query(`UPDATE messages SET state = 'failed', error = $error, failedAt = $now, updatedAt = $now WHERE id = $id`)
          .run({ $id: msg.id, $error: e.message, $now: Date.now() });
      }
    }
  }
}

// -------- WhatsApp Event Handlers --------
client.on('qr', (qr) => {
  console.log('[adapter] Scan this QR to authenticate:');
  try {
    qrcode.generate(qr, { small: true });
  } catch {
    console.log('QR (raw):', qr);
  }
});

client.on('ready', () => {
  console.log(`[adapter] WhatsApp READY as ${((client as any).info?.wid?._serialized) || 'unknown'}`);
  waReady = true;
  startDispatcher();
});

client.on('authenticated', () => console.log('[adapter] WhatsApp authenticated'));
client.on('auth_failure', (msg) => console.error('[adapter] WhatsApp auth_failure:', msg));
client.on('disconnected', (reason) => {
  console.warn('[adapter] WhatsApp disconnected:', reason);
  waReady = false;
});

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
    
    console.log(`[adapter] Received WhatsApp message from ${userId}: ${msg.body?.slice(0, 50)}...`);
    
    const res = await fetch(`${BASE}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    
    if (!res.ok) {
      console.error('[adapter] Failed to forward message to gateway:', res.status, await safeText(res));
    } else {
      console.log('[adapter] Forwarded message to gateway');
    }
  } catch (e) {
    console.error('[adapter] Error handling inbound message:', e);
  }
});

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

// -------- SSE Connection Management --------
let sseAbort: AbortController | null = null;
let lastEventId: number = 0;
let lastHeartbeat: number = Date.now();
let reconnectDelay = 1000;
let heartbeatMonitor: NodeJS.Timeout | null = null;

async function connectSSE() {
  // Using the existing gateway endpoint format
  const url = `${BASE}/api/messages/out/${encodeURIComponent(NETWORK_ID)}/${encodeURIComponent(BOT_ID)}`;
  const ac = new AbortController();
  sseAbort = ac;
  
  console.log(`[adapter] Connecting to SSE at ${url} (lastEventId: ${lastEventId})`);
  
  try {
    const headers: Record<string, string> = {
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
    };
    
    // Include Last-Event-ID for resumption
    if (lastEventId > 0) {
      headers['Last-Event-ID'] = String(lastEventId);
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
    
    console.log('[adapter] SSE connected successfully');
    reconnectDelay = 1000; // Reset delay on successful connection
    lastHeartbeat = Date.now();
    startHeartbeatMonitor();
    
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      
      // Process complete SSE events (separated by double newline)
      let idx;
      while ((idx = buffer.indexOf('\\n\\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleSSEEvent(rawEvent);
      }
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      console.log('[adapter] SSE connection aborted');
    } else {
      console.error('[adapter] SSE error:', e);
      scheduleReconnect();
    }
  } finally {
    stopHeartbeatMonitor();
  }
}

function handleSSEEvent(chunk: string) {
  let event: string | null = null;
  let data: string[] = [];
  let id: string | null = null;
  
  const lines = chunk.split(/\\r?\\n/);
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue; // Skip comments/empty lines
    
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).trim());
    } else if (line.startsWith('id:')) {
      id = line.slice(3).trim();
    }
  }
  
  // Update event ID if present
  if (id) {
    const newId = parseInt(id);
    if (!isNaN(newId) && newId > lastEventId) {
      lastEventId = newId;
      saveLastEventId(newId);
    }
  }
  
  // Handle different event types
  if (!event) event = 'message'; // Default event type
  
  switch (event) {
    case 'heartbeat':
      lastHeartbeat = Date.now();
      console.log('[adapter] Received heartbeat');
      break;
      
    case 'message':
      if (data.length > 0) {
        try {
          const jsonText = data.join('\\n').trim();
          if (jsonText && jsonText[0] === '{') {
            const payload = JSON.parse(jsonText) as OutboundSSE;
            handleOutboundMessage(payload);
          }
        } catch (e) {
          console.error('[adapter] Failed to parse SSE message:', e);
        }
      }
      break;
      
    case 'cancel':
      if (data.length > 0) {
        try {
          const jsonText = data.join('\\n').trim();
          const { messageId } = JSON.parse(jsonText);
          handleCancellation(messageId);
        } catch (e) {
          console.error('[adapter] Failed to parse cancel event:', e);
        }
      }
      break;
      
    default:
      console.log(`[adapter] Received unknown event type: ${event}`);
  }
}

function handleOutboundMessage(payload: OutboundSSE) {
  // Filter by network and bot ID
  if (payload.networkId !== NETWORK_ID || payload.botId !== BOT_ID) return;
  
  // Only process outbound messages
  if (payload.direction && payload.direction !== 'out') return;
  
  // Check for duplicate using event ID
  if (payload.eventId && payload.eventId <= lastEventId) {
    console.log(`[adapter] Skipping old message (eventId ${payload.eventId} <= ${lastEventId})`);
    return;
  }
  
  console.log(`[adapter] Received outbound message ${payload.messageId || 'unknown'} for ${payload.groupId || payload.userId}`);
  
  // Queue message for processing
  queueMessage(payload);
}

function handleCancellation(messageId: string) {
  console.log(`[adapter] Received cancellation for message ${messageId}`);
  
  // Update message state to cancelled
  db.query(`UPDATE messages SET state = 'cancelled', updatedAt = $now WHERE messageId = $id AND state IN ('pending', 'delivered')`)
    .run({ $id: messageId, $now: Date.now() });
}

function startHeartbeatMonitor() {
  stopHeartbeatMonitor();
  
  heartbeatMonitor = setInterval(() => {
    const timeSinceHeartbeat = Date.now() - lastHeartbeat;
    if (timeSinceHeartbeat > HEARTBEAT_TIMEOUT_MS) {
      console.warn(`[adapter] No heartbeat for ${timeSinceHeartbeat}ms, forcing reconnect`);
      reconnect();
    }
  }, HEARTBEAT_CHECK_INTERVAL_MS);
}

function stopHeartbeatMonitor() {
  if (heartbeatMonitor) {
    clearInterval(heartbeatMonitor);
    heartbeatMonitor = null;
  }
}

function reconnect() {
  if (sseAbort) {
    sseAbort.abort();
    sseAbort = null;
  }
  scheduleReconnect();
}

function scheduleReconnect() {
  const delay = Math.min(reconnectDelay, MAX_RETRY_DELAY_MS);
  console.log(`[adapter] Scheduling SSE reconnect in ${delay}ms`);
  
  setTimeout(() => {
    connectSSE();
  }, delay);
  
  // Exponential backoff with jitter
  reconnectDelay = Math.min(reconnectDelay * 2 + Math.random() * 1000, MAX_RETRY_DELAY_MS);
}

function saveLastEventId(eventId: number) {
  try {
    db.query(`INSERT INTO meta (key, value) VALUES ($k, $v) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run({ $k: 'last_event_id', $v: String(eventId) });
  } catch (e) {
    console.error('[adapter] Failed to save last event ID:', e);
  }
}

// -------- Initialization --------
async function init() {
  console.log('[adapter] Starting WhatsApp adapter...');
  console.log(`[adapter] Gateway: ${BASE}`);
  console.log(`[adapter] Network: ${NETWORK_ID}, Bot: ${BOT_ID}`);
  
  // Initialize database
  await initDb();
  
  // Initialize WhatsApp client
  await client.initialize();
  
  // Start SSE connection after a short delay
  setTimeout(() => {
    connectSSE();
  }, 1000);
}

// Start the adapter
init().catch(console.error);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('[adapter] Shutting down...');
  
  // Stop SSE connection
  if (sseAbort) {
    sseAbort.abort();
  }
  
  // Stop heartbeat monitor
  stopHeartbeatMonitor();
  
  // Close WhatsApp client
  await client.destroy();
  
  // Close database
  if (db) {
    db.close();
  }
  
  process.exit(0);
});