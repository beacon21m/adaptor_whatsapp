# WhatsApp Adapter Reliability Improvements - Migration Guide

## Overview

The enhanced WhatsApp adapter (`index-improved.ts`) implements the reliability specification with:
- **Zero message loss** through persistent queueing and status tracking
- **No duplicates** via idempotency tracking
- **Fast recovery** with proper SSE reconnection
- **Enhanced observability** through detailed logging

## Key Improvements

### 1. Message Status Tracking (ACK/Confirm/Fail)

The adapter now implements a 3-phase confirmation protocol:
- **ACK**: Confirms receipt of message from gateway
- **Confirm**: Reports successful send to WhatsApp
- **Fail**: Reports permanent failures with reason

**Impact**: Gateway can track exact message state and retry/alert as needed.

### 2. Heartbeat Monitoring

- Monitors SSE heartbeats from gateway
- Automatically reconnects if no heartbeat for 45 seconds
- Configurable via `HEARTBEAT_TIMEOUT_MS`

**Impact**: Faster detection of connection issues (45s vs previous 10s stale check).

### 3. Proper SSE Reconnection

- Sends `Last-Event-ID` header on reconnection
- Gateway replays missed messages
- Persists last event ID to database

**Impact**: No message loss during network interruptions.

### 4. Idempotency Tracking

- Tracks processed message IDs in persistent database
- Prevents duplicate sends even after restart
- Auto-cleanup of old entries (>7 days)

**Impact**: Guarantees exactly-once delivery semantics.

### 5. Retry with Exponential Backoff

- Configurable retry attempts (default: 3)
- Exponential backoff: 1s → 2s → 4s → ... (max 30s)
- Distinguishes retriable vs permanent failures

**Impact**: Better handling of transient failures.

### 6. Persistent Message Queue

All messages stored in SQLite with states:
- `pending`: Newly received
- `delivered`: ACKed to gateway
- `sending`: Currently being sent
- `sent`: Successfully sent
- `failed`: Permanently failed
- `retry`: Scheduled for retry

**Impact**: Messages survive adapter restarts.

### 7. Enhanced Logging

Structured logging with clear prefixes:
```
[adapter] Connected to gateway (last_event_id: 5678)
[adapter] Received message msg_123 (event_id: 5679)
[adapter] Sending message msg_123 to WhatsApp (attempt 1)
[adapter] Successfully sent message msg_123 (external: whatsapp_abc)
```

## Migration Steps

### 1. Review Configuration

New environment variables:
```bash
# Reliability settings (with defaults)
HEARTBEAT_TIMEOUT_MS=45000        # 45 seconds
HEARTBEAT_CHECK_INTERVAL_MS=10000 # 10 seconds
MAX_RETRY_ATTEMPTS=3               # Max send retries
INITIAL_RETRY_DELAY_MS=1000        # Initial retry delay
MAX_RETRY_DELAY_MS=30000          # Max retry delay
```

### 2. Database Migration

The enhanced adapter uses a new database schema. On first run, it will:
1. Create new tables (`messages`, `processed_messages`)
2. Import last event ID from existing metadata
3. Preserve WhatsApp session data

**Note**: The old `outbox` table is not migrated. Any pending messages will be lost during migration.

### 3. Gateway Requirements

The gateway MUST implement:
- [ ] `POST /messages/:messageId/ack` endpoint
- [ ] `POST /messages/:messageId/confirm` endpoint
- [ ] `POST /messages/:messageId/fail` endpoint
- [ ] SSE heartbeat events every 15 seconds
- [ ] Include `messageId` in SSE message payloads
- [ ] Support `Last-Event-ID` header for replay

### 4. Testing Plan

1. **Start with existing adapter** to ensure clean state
2. **Stop existing adapter** gracefully
3. **Deploy enhanced adapter** with same configuration
4. **Monitor logs** for successful connection and message flow
5. **Test scenarios**:
   - Send test message through gateway
   - Verify ACK/Confirm flow in logs
   - Disconnect network briefly and reconnect
   - Restart adapter mid-message
   - Send duplicate message (should be skipped)

### 5. Rollback Plan

If issues occur:
1. Stop enhanced adapter
2. Start original adapter (`index.ts`)
3. Messages in new database won't be processed by old adapter
4. Manual intervention may be needed for stuck messages

## Monitoring Checklist

After deployment, monitor:

- **Connection stability**: Check for frequent reconnections
- **Message latency**: Time from receipt to confirmation
- **Retry rate**: High retry rate indicates issues
- **Duplicate detection**: Should be minimal (<1%)
- **Error logs**: Look for patterns in failures

## Performance Impact

- **Database writes**: ~3-4 per message (queue, ACK, confirm)
- **Memory**: Minimal increase for tracking
- **Network**: Additional ACK/Confirm requests to gateway
- **CPU**: Negligible impact from improved logic

## Compatibility Notes

### Breaking Changes
- Requires gateway to implement new endpoints
- Different database schema (not backward compatible)
- Messages now require `messageId` field from gateway

### Non-Breaking Changes
- Still uses same WhatsApp session data
- Same core message format
- Same environment variables (with additions)

## Troubleshooting

### Issue: "ACK failed" warnings
**Cause**: Gateway doesn't implement ACK endpoint
**Solution**: Gateway must implement `/messages/:messageId/ack`

### Issue: Messages stuck in "pending"
**Cause**: WhatsApp client not ready
**Solution**: Check WhatsApp authentication and QR code

### Issue: High retry rate
**Cause**: WhatsApp rate limiting or network issues
**Solution**: Reduce `DISPATCH_CONCURRENCY` or increase retry delays

### Issue: Duplicate messages sent
**Cause**: Idempotency tracking not working
**Solution**: Check database permissions and `processed_messages` table

## Next Steps

1. **Gateway Implementation**: Ensure gateway implements required endpoints
2. **Staging Test**: Deploy to staging environment first
3. **Load Testing**: Verify performance under load
4. **Monitoring Setup**: Configure alerts for key metrics
5. **Documentation**: Update runbooks with new operational procedures

## Support

For issues or questions:
- Review logs with `[adapter]` prefix
- Check database state: `sqlite3 .state/state.sqlite`
- Verify SSE connection: `curl -N ${GATEWAY_API_BASE_URL}:${PORT}/messages/stream`