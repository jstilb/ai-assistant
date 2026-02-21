# Kaya Daemon - WebSocket Control Plane

WebSocket-based control plane API for the Kaya daemon system. Based on ClawdBot patterns, implemented with Bun's native WebSocket API.

## Architecture

```
┌─────────────────┐
│  HTTP Server    │  Port 3737
│  (Bun.serve)    │
└────────┬────────┘
         │
         ├─────► HTTP Endpoints
         │       • /health
         │       • /status
         │
         └─────► WebSocket Endpoint
                 • /ws (upgrade)
                 │
                 ├─── Authentication
                 ├─── Message Routing
                 ├─── Heartbeat Monitoring
                 └─── Broadcast System
```

## Features

### 1. WebSocket Control Plane
- **Typed message protocol** for daemon commands
- **Request-response pattern** with message IDs
- **Broadcast capabilities** for status updates
- **Client connection management** with tracking

### 2. Authentication
- Simple token-based auth from `settings.json`
- Auto-auth mode when no token configured
- Per-connection authentication state

### 3. Heartbeat System
- Automatic ping/pong monitoring
- Configurable timeout and interval
- Automatic stale connection cleanup

### 4. Message Protocol

All messages follow this structure:

```typescript
type WSMessage =
  | { type: 'status'; payload: DaemonStatus }
  | { type: 'cron.list'; payload: CronJob[] }
  | { type: 'cron.run'; payload: { jobId: string } }
  | { type: 'cron.result'; payload: { jobId: string; success: boolean; output?: string } }
  | { type: 'queue.status'; payload: QueueStatus }
  | { type: 'notification'; payload: { message: string; channel: string } }
  | { type: 'ping'; payload: { timestamp: number } }
  | { type: 'pong'; payload: { timestamp: number } }
  | { type: 'error'; payload: { message: string; code?: string } }
  | { type: 'auth.required'; payload: { message: string } }
  | { type: 'auth.success'; payload: { message: string } };
```

### 5. Request-Response Pattern

Optional `id` field enables request-response tracking:

```typescript
// Request
{
  type: 'status',
  payload: {},
  id: 'abc123'
}

// Response (matches request ID)
{
  type: 'status',
  payload: { uptime: 12345, ... },
  id: 'abc123'
}
```

## Usage

### Starting the Server

```typescript
import { createServer } from './lib/daemon/Server';

const server = await createServer(3737, {
  authToken: 'your-secret-token',
  heartbeatInterval: 30000,
  heartbeatTimeout: 60000,
  maxClients: 100,
});
```

Or run directly:

```bash
bun run lib/daemon/Server.ts
```

### Client Connection

```typescript
import type { WSMessage, WSRequest } from './lib/daemon/types';

const ws = new WebSocket('ws://localhost:3737/ws');

// Send authenticated ping
ws.onopen = () => {
  const ping: WSRequest = {
    type: 'ping',
    payload: { timestamp: Date.now(), token: 'your-secret-token' } as any,
    id: crypto.randomUUID(),
  };
  ws.send(JSON.stringify(ping));
};

// Handle responses
ws.onmessage = (event) => {
  const message: WSMessage = JSON.parse(event.data);
  console.log('Received:', message.type, message.payload);
};
```

### Broadcasting Messages

```typescript
import { broadcast } from './lib/daemon/WebSocketServer';

// Send to all connected, authenticated clients
broadcast({
  type: 'notification',
  payload: {
    message: 'Cron job completed',
    channel: 'cron',
    timestamp: Date.now(),
  },
});
```

### API Functions

```typescript
// Broadcast to all authenticated clients
broadcast(message: WSMessage): number

// Send to specific client
sendToClient(clientId: string, message: WSMessage): boolean

// Get connection counts
getConnectedClients(): number
getAuthenticatedClients(): number

// Get client list (debugging)
getClientList(): WSClientData[]

// Health check
getHealthStatus(): HealthStatus

// Graceful shutdown
shutdown(): void
```

## Testing

Run the test client:

```bash
# Without authentication
bun run lib/daemon/test-client.ts

# With authentication
DAEMON_AUTH_TOKEN=your-token bun run lib/daemon/test-client.ts
```

## Configuration

Add to `settings.json`:

```json
{
  "daemon": {
    "authToken": "your-secret-token",
    "port": 3737,
    "heartbeatInterval": 30000,
    "heartbeatTimeout": 60000,
    "maxClients": 100
  }
}
```

## Message Types

### Status Messages

**Request:**
```json
{ "type": "status", "id": "abc123" }
```

**Response:**
```json
{
  "type": "status",
  "id": "abc123",
  "payload": {
    "uptime": 123456,
    "connectedClients": 3,
    "cronJobsRunning": 2,
    "queuedTasks": 5,
    "lastActivity": 1234567890,
    "version": "1.0.0"
  }
}
```

### Cron Messages

**List Jobs:**
```json
{ "type": "cron.list", "id": "abc123" }
```

**Run Job:**
```json
{
  "type": "cron.run",
  "id": "abc123",
  "payload": { "jobId": "daily-backup" }
}
```

**Job Result (broadcast):**
```json
{
  "type": "cron.result",
  "payload": {
    "jobId": "daily-backup",
    "success": true,
    "output": "Backup completed successfully"
  }
}
```

### Queue Messages

**Status:**
```json
{ "type": "queue.status", "id": "abc123" }
```

**Response:**
```json
{
  "type": "queue.status",
  "id": "abc123",
  "payload": {
    "pending": 5,
    "active": 2,
    "completed": 100,
    "failed": 3
  }
}
```

### Notifications (Server → Client)

```json
{
  "type": "notification",
  "payload": {
    "message": "System update available",
    "channel": "system",
    "timestamp": 1234567890
  }
}
```

## Integration Points

### Future Integration

The WebSocketServer is designed to integrate with:

1. **CronManager** - Scheduled job execution
2. **QueueManager** - Task queue processing
3. **NotificationSystem** - Push notifications
4. **SessionManager** - Active session tracking

### Example Integration

```typescript
import { broadcast } from './lib/daemon/WebSocketServer';
import { CronManager } from './lib/daemon/CronManager'; // TODO

// When cron job completes
cronManager.on('job:complete', (job) => {
  broadcast({
    type: 'cron.result',
    payload: {
      jobId: job.id,
      success: true,
      output: job.output,
    },
  });
});
```

## Security Considerations

1. **Authentication** - Token-based auth prevents unauthorized access
2. **Connection Limits** - maxClients prevents resource exhaustion
3. **Heartbeat Timeout** - Automatic cleanup of stale connections
4. **Message Validation** - JSON parsing with error handling
5. **Graceful Shutdown** - Clean connection termination

## Error Handling

All errors are reported via error messages:

```json
{
  "type": "error",
  "payload": {
    "message": "Invalid message format",
    "code": "PARSE_ERROR"
  }
}
```

Error codes:
- `PARSE_ERROR` - Invalid JSON
- `UNKNOWN_TYPE` - Unknown message type
- `AUTH_FAILED` - Authentication failed
- `MAX_CLIENTS` - Client limit exceeded

## Development

### File Structure

```
lib/daemon/
├── types.ts              # Type definitions
├── WebSocketServer.ts    # WebSocket server implementation
├── Server.ts             # HTTP/WebSocket server
├── test-client.ts        # Test client
└── README.md             # This file
```

### Adding New Message Types

1. Add type to `WSMessage` union in `types.ts`
2. Add handler in `handleAuthenticatedMessage()`
3. Update this README with message format
4. Add test case to `test-client.ts`

## ClawdBot Patterns Used

- ✅ WebSocket control plane API
- ✅ Typed message protocol
- ✅ Client connection management
- ✅ Broadcast capabilities
- ✅ Authentication via local token
- ✅ Request-response pattern with message IDs
- ✅ Heartbeat monitoring
- ✅ Graceful shutdown

## Next Steps

- [ ] Integrate CronManager
- [ ] Integrate QueueManager
- [ ] Add session tracking
- [ ] Add metrics collection
- [ ] Add WebSocket compression
- [ ] Add rate limiting
- [ ] Add message replay on reconnect
