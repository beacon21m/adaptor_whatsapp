**Overview**
- Minimal WhatsApp adaptor built with Bun + TypeScript that bridges WhatsApp to a generic Beacon Gateway API (https://github.com/beacon21m/beacon-gateway) via HTTP POST (inbound) and Server‑Sent Events (SSE) (outbound).
- Supports readiness gating, SSE reconnect with backoff, and message de‑duplication using a lightweight payload‑hash cache with a persisted anchor.
- Designed to be copied and adapted for other chat networks with small, well‑isolated changes.

**Features**
- Inbound: Receives WhatsApp messages and POSTs them to the Gateway API.
- Outbound: Subscribes to SSE and sends messages to WhatsApp (DM or group), replying to a message when requested.
- Dedupe: Prevents duplicate sends on reconnects or replay using a payload‑hash LRU, plus persisting the last sent hash.
- Robustness: Handles QR auth, headless Chromium, SSE heartbeats/control frames, and exponential backoff on disconnect.

**Setup**
- Requirements:
  - `bun` installed.
  - A Chromium available for `whatsapp-web.js` (set `PUPPETEER_EXECUTABLE_PATH` or `CHROME_BIN` if needed).
  - The Gateway server running and exposing the endpoints described below.
- Install dependencies:
  - `bun install`
- Environment variables (create `.env`):
  - `GATEWAY_API_BASE_URL` (e.g., `http://localhost`)
  - `PORT` (e.g., `3080`)
  - `BOT_TYPE` (e.g., `brain`)
  - `BOT_ID` (e.g., `wa183`)
  - `NETWORK_ID` (e.g., `whatsapp`)
  - Optional runtime:
    - `SESSION_DIR` (default `.wwebjs_auth`)
    - `HEADLESS` (`true` by default; set `false` for visible browser)
    - `NO_SANDBOX` (`true` when required by your container)
    - `PUPPETEER_EXECUTABLE_PATH` or `CHROME_BIN` to force a Chromium path
    - Dedupe tuning: `DEDUP_TTL_MS` (default `180000`), `DEDUP_MAX` (default `500`), `STATE_DIR` (default `.state`)
- Start:
  - `bun start`
  - Scan the QR code printed in the terminal to authenticate the WhatsApp session.

**Runtime Files**
- WhatsApp session data: `.wwebjs_auth/` (ignored by git)
- Dedupe state: `.state/last_out_${NETWORK_ID}_${BOT_ID}.json`

**Gateway Contract**
- Inbound POST (WhatsApp → Gateway):
  - URL: `${GATEWAY_API_BASE_URL}:${PORT}/api/messages`
  - Body JSON:
    - `networkId`: `NETWORK_ID`
    - `botId`: `BOT_ID`
    - `botType`: `BOT_TYPE`
    - `groupId?`: WhatsApp group JID (e.g., `xxxx@g.us`) when applicable
    - `userId?`: WhatsApp user JID (e.g., `xxxx@c.us`)
    - `messageId?`: provider message id (string)
    - `message`: text content
- Outbound SSE (Gateway → WhatsApp):
  - URL: `${GATEWAY_API_BASE_URL}:${PORT}/api/messages/out/${NETWORK_ID}/${BOT_ID}`
  - SSE semantics: single subscriber per channel, heartbeats and optional `retry:` control lines.
  - Payload (data: lines contain JSON):
    - `networkId`, `botId`, `botType`
    - `groupId?`, `userId?` (target JIDs)
    - `replyMessageId?` (quoted message id)
    - `message` (text to send)
    - `direction?`: when present, adaptor only sends if `direction === "out"` (avoids echoing inbound posts)

**Message Flow**
- Inbound (WA → Gateway):
  - The adaptor listens to WhatsApp messages and constructs a POST payload using:
    - `groupId = msg.from` when `@g.us`, otherwise undefined
    - `userId = msg.author` for groups, otherwise `msg.from` for DMs
    - `messageId = msg.id._serialized`
    - `message = msg.body`
  - Sends to `POST /api/messages`.
- Outbound (Gateway → WA):
  - Adaptor connects to SSE `.../api/messages/out/:networkId/:botId` and reads `event: message` data frames with JSON.
  - For each payload:
    - Optional filter: if `direction` exists and is not `out`, skip.
    - Target `to = groupId || userId`.
    - Reply if `replyMessageId` set.
    - Send via `client.sendMessage(to, message, { quotedMessageId })`.

**De‑Duplication**
- Rationale: SSE reconnects, server replays, or at‑least‑once delivery may cause duplicates.
- Strategy:
  - Payload‑hash cache (in memory):
    - Key = `${to}|${replyMessageId||''}|${message}`
    - Hash with FNV‑1a (fast 32‑bit), store in `Map` with timestamp.
    - On new outbound payload: if hash present and fresh (within `DEDUP_TTL_MS`), skip.
    - Evict oldest when size exceeds `DEDUP_MAX`.
  - Persistent anchor (across restarts):
    - After scheduling a send, write the last hash to `.state/last_out_${NETWORK_ID}_${BOT_ID}.json`.
    - On startup, pre‑seed the dedupe cache with this hash to avoid re‑sending the very last message seen before shutdown.
- Optional extension (not enabled here but easy to add): track SSE `id` and skip events with `id <= lastSeenId`.

**Resilience**
- WhatsApp readiness:
  - Outbound sends are queued until the client emits `ready`, then flushed.
- SSE robustness:
  - Ignores heartbeats and control frames like `retry: 3000`.
  - Reconnects with exponential backoff and minor jitter after disconnects (e.g., `ECONNRESET`).

**Adapting For Other Networks**
- Keep the project skeleton and replace only the transport‑specific parts:
  - WhatsApp client bootstrapping and message extraction in `index.ts`:
    - Replace `whatsapp-web.js` client with the respective SDK/client.
    - Normalize inbound fields: `groupId`, `userId`, `messageId`, `message`.
    - Implement outbound send with reply threading equivalent (if supported).
  - Keep the gateway interface (POST and SSE) and the dedupe logic intact.
- Suggested steps:
  - Factor transport into a small adapter module (`src/adaptors/<network>.ts`) if multiple networks are supported.
  - Reuse SSE subscription, dedupe, and readiness queue unchanged.

**Run & Test**
- Start adaptor: `bun start`
- Verify SSE connectivity:
  - `curl -N ${GATEWAY_API_BASE_URL}:${PORT}/api/messages/out/${NETWORK_ID}/${BOT_ID}`
- Send a test outbound (Gateway → WA):
  - `curl -X POST ${GATEWAY_API_BASE_URL}:${PORT}/api/messages -H 'content-type: application/json' -d '{"networkId":"whatsapp","botId":"wa183","botType":"brain","userId":"<jid@c.us>","message":"hello"}'`
- Watch the adaptor logs for outbound sends and dedupe skips.

**Project Files**
- Entry: `index.ts` (end‑to‑end adaptor logic)
- Config: `tsconfig.json`, `package.json` (`bun start`), `.gitignore`
- State: `.state/` (dedupe), `.wwebjs_auth/` (WhatsApp session)

**Limitations**
- v1 only handles text messages (no media). Media can be added using `MessageMedia` and detecting `mediaBase64`/`mediaMime` fields from SSE payloads.
- Single SSE subscriber per channel (per gateway design). Attaching a new subscriber closes the previous one.

**Troubleshooting**
- ECONNRESET on SSE: typically the server rotated or a second subscriber attached. The adaptor auto‑reconnects with backoff.
- Not sending immediately after start: expected until WhatsApp client emits `ready`; outbound messages queue and then flush.
- Invalid target: ensure JIDs end with `@c.us` (DM) or `@g.us` (group) and match your WhatsApp number format.

