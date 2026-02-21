# MessageQueue

Multi-channel message queue for proactive notifications in the Kaya system.

## Overview

MessageQueue provides a robust, production-ready queue for outbound notifications across multiple channels (voice, push, email, Discord). Inspired by ClawdBot patterns, it includes priority routing, rate limiting, retry logic with exponential backoff, and user preference handling.

## Features

- **Multi-Channel Support**: Voice, push (ntfy), email, Discord
- **Priority-Based Routing**: Critical, high, normal, low priority levels
- **Rate Limiting**: Prevent spam with per-channel limits
- **Retry Logic**: Exponential backoff with configurable max retries
- **Deduplication**: Prevent duplicate messages within time window
- **User Preferences**: Quiet hours, disabled channels
- **Persistence**: Queue state survives restarts
- **Integration**: Seamless integration with NotificationService

## Installation

```bash
# Already installed as part of Kaya
# Location: ~/.claude/lib/messaging/MessageQueue.ts
```

## Usage

### Singleton API (Most Common)

```typescript
import { enqueue, process, getQueueStatus } from '~/.claude/lib/messaging/MessageQueue';

// Enqueue a message
const messageId = enqueue({
  content: "Workflow completed successfully",
  channel: "voice",
  priority: "high"
});

// Process pending messages
await process();

// Check queue status
const status = getQueueStatus();
console.log(`Pending: ${status.pending}, Processed: ${status.processed}`);
```

### Custom Instance

```typescript
import { createMessageQueue } from '~/.claude/lib/messaging/MessageQueue';

const queue = createMessageQueue({
  queuePath: "/custom/path/queue.json",
  maxRetries: 5,
  deduplicationWindowMs: 30000, // 30 seconds
  rateLimits: {
    voice: { maxPerMinute: 10 },
    push: { maxPerHour: 100 }
  },
  userPreferences: {
    quietHours: {
      enabled: true,
      start: 22, // 10 PM
      end: 8    // 8 AM
    },
    disabledChannels: ['email']
  }
});

queue.enqueue({
  content: "Test message",
  channel: "voice",
  priority: "normal",
  scheduledFor: new Date(Date.now() + 60000) // Send in 1 minute
});

await queue.process();
```

## CLI Usage

```bash
# Enqueue a message
bun run ~/.claude/lib/messaging/MessageQueue.ts \
  --enqueue "Message content" \
  --channel voice \
  --priority high

# Schedule a message for later
bun run ~/.claude/lib/messaging/MessageQueue.ts \
  --enqueue "Reminder" \
  --schedule 30  # Send in 30 minutes

# Process pending messages
bun run ~/.claude/lib/messaging/MessageQueue.ts --process

# Check queue status
bun run ~/.claude/lib/messaging/MessageQueue.ts --status
```

## API Reference

### `enqueue(params)`

Add a message to the queue.

**Parameters:**
- `content` (string): Message content
- `channel` (MessageChannel): Target channel ('voice' | 'push' | 'email' | 'discord')
- `priority` (MessagePriority): Priority level ('low' | 'normal' | 'high' | 'critical')
- `scheduledFor` (Date, optional): Scheduled delivery time

**Returns:** `string` - Unique message ID

### `process()`

Process all pending messages that are ready to send.

**Returns:** `Promise<void>`

### `getQueueStatus()`

Get current queue statistics.

**Returns:** `QueueStatus`
- `pending`: Number of messages waiting to be sent
- `failed`: Number of messages that failed after max retries
- `processed`: Number of successfully sent messages

## Configuration Options

### `MessageQueueConfig`

```typescript
interface MessageQueueConfig {
  /** Path to queue persistence file */
  queuePath?: string;

  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;

  /** Deduplication time window in milliseconds (default: 60000) */
  deduplicationWindowMs?: number;

  /** Rate limits per channel */
  rateLimits?: {
    [channel]: {
      maxPerMinute?: number;
      maxPerHour?: number;
    };
  };

  /** User preferences */
  userPreferences?: {
    quietHours?: {
      enabled: boolean;
      start: number; // Hour 0-23
      end: number;   // Hour 0-23
    };
    disabledChannels?: MessageChannel[];
  };
}
```

## Integration with NotificationService

MessageQueue uses the NotificationService for actual message delivery:

```typescript
// MessageQueue handles:
// - Queuing and priority ordering
// - Rate limiting
// - Retry logic
// - User preferences (quiet hours, etc.)

// NotificationService handles:
// - Actual delivery to channels
// - Channel-specific formatting
// - Health checks
// - Fallback logic
```

## Testing

```bash
# Run test suite
bun test ~/.claude/lib/messaging/MessageQueue.test.ts

# Test coverage:
# - Enqueue operations
# - Priority ordering
# - Retry logic with exponential backoff
# - Rate limiting
# - Deduplication
# - User preferences (quiet hours, disabled channels)
# - Persistence and recovery
# - Singleton exports
```

## Architecture

### Queue Processing Flow

```
1. Messages enqueued with priority and schedule
2. process() called (manually or on interval)
3. Messages sorted by priority
4. Each message checked for:
   - Scheduled time reached?
   - Rate limit OK?
   - Within quiet hours? (unless critical)
5. Attempt delivery via NotificationService
6. On failure: retry with exponential backoff
7. After max retries: move to failed queue
8. Persist state to disk
```

### Persistence

Queue state is stored at `~/.claude/MEMORY/daemon/message-queue.json`:

```json
{
  "messages": [/* pending messages */],
  "processed": [/* successfully sent */],
  "failed": [/* failed after retries */]
}
```

## Use Cases

### Daemon Background Notifications

```typescript
// Daemon can enqueue messages for async delivery
enqueue({
  content: "Weekly report generated",
  channel: "push",
  priority: "normal"
});

// Separate process/cron job processes queue
setInterval(async () => {
  await process();
}, 60000); // Every minute
```

### Critical Alerts

```typescript
// Critical messages bypass quiet hours
enqueue({
  content: "Security alert: unusual activity detected",
  channel: "voice",
  priority: "critical"  // Will deliver even at 3 AM
});
```

### Scheduled Reminders

```typescript
// Schedule message for future delivery
enqueue({
  content: "Meeting in 15 minutes",
  channel: "push",
  priority: "high",
  scheduledFor: new Date(Date.now() + 15 * 60000)
});
```

## Error Handling

- **Queue Corruption**: Auto-recovers by starting fresh
- **Delivery Failures**: Retries with exponential backoff
- **Rate Limiting**: Messages wait until limit window passes
- **Disabled Channels**: Throws error on enqueue (fail fast)

## Future Enhancements

- [ ] Web UI for queue management
- [ ] Metrics and analytics (message volume, delivery rates)
- [ ] Channel failover (if voice fails, try push)
- [ ] Template support for common message patterns
- [ ] Batch sending for efficiency
- [ ] Priority escalation (low → normal after time threshold)

## Related Modules

- **NotificationService**: Actual message delivery
- **StateManager**: Generic state persistence
- **ConfigLoader**: Configuration management

## Contributing

This module follows TDD principles:
1. Write tests first (RED phase)
2. Implement to make tests pass (GREEN phase)
3. Refactor for clarity (REFACTOR phase)

All changes must maintain 100% test pass rate.
