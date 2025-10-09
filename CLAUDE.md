# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
- **Run the adapter**: `bun start` (production) or `bun --hot run index.ts` (development with hot reload)
- **Build TypeScript**: `bun run build` or `tsc -p tsconfig.json`
- **Install dependencies**: `bun install`

### Testing  
No test suite is configured. Manual testing requires:
1. A running Gateway server at `GATEWAY_API_BASE_URL:PORT`
2. WhatsApp authentication via QR code scan
3. Test commands from README.md lines 111-114

## Architecture

### Core Design
This is a WhatsApp-to-Gateway bridge adapter using an event-driven architecture:
- **Inbound flow**: WhatsApp messages → HTTP POST to Gateway API
- **Outbound flow**: SSE subscription from Gateway → WhatsApp message sending
- **State management**: SQLite for durable message queue, file-based for deduplication state

### Key Components

#### Message Processing (index.ts)
- **WhatsApp Client**: Uses `whatsapp-web.js` with Puppeteer for browser automation
- **Inbound Handler** (line 122): Converts WhatsApp messages to gateway format, handles group vs DM logic
- **Outbound SSE** (line 433): Maintains persistent SSE connection with exponential backoff reconnection
- **Deduplication**: Two-tier strategy using eventId checkpoints (primary) and payload hashing (fallback)
- **SQLite Outbox** (line 249+): Durable queue for outbound messages with retry logic and state tracking

#### State Persistence
- **Session**: `.wwebjs_auth/` - WhatsApp authentication data
- **Dedup State**: `.state/` - Last processed eventId and hash cache
- **SQLite DB**: `.state/state.sqlite` - Outbound message queue with states: queued → sending → sent/failed

#### Resilience Features
- **Queue on Not Ready**: Outbound messages queue until WhatsApp client emits 'ready'
- **SSE Health Check**: Monitors connection staleness, auto-reconnects after 10s inactivity
- **Exponential Backoff**: SSE reconnection with jitter (1.5s → 30s max)
- **Concurrent Dispatch**: Configurable parallel sending (default: 3 concurrent)
- **Idempotency**: RefId-based deduplication prevents duplicate sends

### Environment Configuration
Required variables (see .env_example):
- `GATEWAY_API_BASE_URL`: Gateway server base URL
- `PORT`: Gateway server port  
- `BOT_TYPE`: Bot classification (e.g., 'brain')
- `BOT_ID`: Unique bot identifier
- `NETWORK_ID`: Network type (always 'whatsapp' for this adapter)

Optional tuning:
- `DISPATCH_CONCURRENCY`: Parallel message sends (default: 3)
- `SEND_TIMEOUT_MS`: WhatsApp send timeout (default: 20000ms)
- `DEDUP_TTL_MS`: Deduplication window (default: 180000ms)
- `SSE_STALE_MS`: SSE health check threshold (default: 10000ms)

### Gateway API Contract

#### Inbound POST `/api/messages`
```typescript
{
  networkId: string,
  botId: string, 
  botType: string,
  groupId?: string,    // WhatsApp group JID (@g.us)
  userId?: string,     // WhatsApp user JID (@c.us)
  messageId?: string,  // Provider message ID
  message: string
}
```

#### Outbound SSE `/api/messages/out/:networkId/:botId`
```typescript
{
  networkId: string,
  botId: string,
  botType: string,
  groupId?: string,     // Target group JID
  userId?: string,      // Target user JID
  replyMessageId?: string,  // Quote this message
  message: string,
  direction?: 'out',    // Filter to prevent echo
  eventId?: number,     // Monotonic sequence ID
  refId?: string        // Idempotency key
}
```

### Adapting for Other Networks
To create adapters for other chat networks:
1. Replace WhatsApp client initialization (lines 78-94)
2. Update message extraction logic (lines 122-152)
3. Modify send implementation (lines 559-567)
4. Keep intact: Gateway interface, SSE subscription, deduplication, SQLite queue

The architecture intentionally isolates transport-specific code from the generic gateway integration layer.