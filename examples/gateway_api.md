# Design Overview

This gateway exposes a minimal HTTP API and an SSE stream for each `(networkId, botId)` channel. It integrates with the wider Beacon stack later via the Context VM; for v1 there is no external dependency and no database.

## Components

- HTTP server (Bun): routes requests, handles CORS and SSE.
- MessageBus: in-memory per-channel ring buffer and a single active SSE subscriber per channel.

## Channels and Buffering

- Channel key: `${networkId}/${botId}`.
- Buffer: fixed-size ring (default 500). When full, purges oldest.
- Each message gets a monotonic integer `id` scoped to the channel, used as the SSE `id:`.
- `Last-Event-ID` is supported; on reconnect, all messages with `id > Last-Event-ID` are replayed.

## Message Flow

1. Client POSTs to `/api/messages` with `{ networkId, botId, botType, groupId?, userId?, messageId?, message }`.
2. Gateway converts to SSE payload `{ networkId, botId, botType, groupId?, userId?, replyMessageId?: messageId, message }` and enqueues.
3. If a subscriber exists for the channel, it receives an immediate `event: message` with the payload.
4. Otherwise, the message remains in the ring buffer for future subscribers/resume.

## SSE Details

- Headers: `content-type: text/event-stream`, `cache-control: no-cache`, `connection: keep-alive`.
- Initial line: `retry: 3000` to hint client auto-retry.
- Heartbeat: `: ping` comment every `HEARTBEAT_MS` (default 15000ms).
- Single subscriber: attaching a new subscriber closes the previous connection.

## Config

Environment variables:
- `PORT` (default `3030`)
- `MAX_MESSAGES_PER_CHANNEL` (default `500`)
- `HEARTBEAT_MS` (default `15000`)
- `CVM_RELAYS` comma-separated (e.g., `wss://cvm.otherstuff.ai,wss://relay.contextvm.org`)
- `GATEWAY_HEX_PRIV_KEY` 64-char hex; used to derive `returnGatewayID`
- `BRAIN_CVM_HEX_PUB` and `ID_CVM_HEX_PUB` for routing when `botType` is `brain` or `id`

## Out of Scope (v1)

- Authentication/authorization.
- Persistent storage (SQLite, etc.).
- Multi-subscriber fanout per channel.
- Structured logging/metrics.

