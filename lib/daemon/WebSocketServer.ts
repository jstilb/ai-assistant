/**
 * WebSocketServer - Control plane API for Kaya daemon
 *
 * Provides WebSocket-based control plane for daemon management:
 * - Typed message protocol for daemon commands
 * - Client connection management with authentication
 * - Broadcast capabilities for status updates
 * - Heartbeat/ping-pong for connection health
 * - Request-response pattern with message IDs
 * - Real integration with CronManager + MessageQueue via DaemonContext
 */

import type { ServerWebSocket } from 'bun';
import type {
  WSMessage,
  WSRequest,
  WSResponse,
  WSClientData,
  WSServerConfig,
  DaemonContext,
  DaemonStatus,
} from './types';

// Global client tracking
const clients = new Map<ServerWebSocket<WSClientData>, WSClientData>();
let heartbeatInterval: Timer | null = null;
let config: WSServerConfig = {};
let daemonContext: DaemonContext | null = null;

/**
 * Set the daemon context for dependency injection
 * Called by pai-daemon.ts after all subsystems are initialized
 */
export function setDaemonContext(ctx: DaemonContext): void {
  daemonContext = ctx;

  // Subscribe to EventBus and broadcast events to WebSocket clients
  ctx.eventBus.onAny((event) => {
    broadcast({
      type: 'event',
      payload: {
        eventType: event.type,
        data: event as Record<string, any>,
        timestamp: Date.now(),
      },
    });
  });
}

/**
 * WebSocket handler for Bun.serve
 */
export const createWebSocketServer = (serverConfig?: WSServerConfig) => {
  config = {
    heartbeatInterval: 30000,
    heartbeatTimeout: 60000,
    maxClients: 100,
    ...serverConfig,
  };

  if (!heartbeatInterval) {
    startHeartbeat();
  }

  return {
    message: handleMessage,
    open: handleOpen,
    close: handleClose,
    drain: handleDrain,
  };
};

/**
 * Handle new WebSocket connection
 */
function handleOpen(ws: ServerWebSocket<WSClientData>) {
  const clientId = crypto.randomUUID();
  const now = Date.now();

  const clientData: WSClientData = {
    id: clientId,
    connectedAt: now,
    lastPing: now,
    authenticated: !config.authToken,
    remoteAddress: ws.remoteAddress,
  };

  ws.data = clientData;
  clients.set(ws, clientData);

  console.log(`[WebSocket] Client connected: ${clientId} (${clients.size} total)`);

  if (config.authToken && !clientData.authenticated) {
    const authRequired: WSMessage = {
      type: 'auth.required',
      payload: { message: 'Authentication required' },
    };
    ws.send(JSON.stringify(authRequired));
  } else if (clientData.authenticated) {
    // No auth token configured — immediately notify client of auth success
    const authSuccess: WSMessage = {
      type: 'auth.success',
      payload: { message: 'No authentication required' },
    };
    ws.send(JSON.stringify(authSuccess));
  }

  if (config.maxClients && clients.size > config.maxClients) {
    console.warn(`[WebSocket] Max clients exceeded (${clients.size}/${config.maxClients})`);
    const error: WSMessage = {
      type: 'error',
      payload: { message: 'Maximum clients exceeded', code: 'MAX_CLIENTS' },
    };
    ws.send(JSON.stringify(error));
    ws.close(1008, 'Maximum clients exceeded');
  }
}

/**
 * Handle incoming WebSocket message
 */
function handleMessage(ws: ServerWebSocket<WSClientData>, message: string | Buffer) {
  try {
    const data = typeof message === 'string' ? message : message.toString();
    const request: WSRequest = JSON.parse(data);

    if (ws.data) {
      ws.data.lastPing = Date.now();
    }

    if (!ws.data?.authenticated) {
      handleAuthMessage(ws, request);
      return;
    }

    handleAuthenticatedMessage(ws, request);
  } catch (error) {
    console.error('[WebSocket] Failed to parse message:', error);
    const errorMsg: WSMessage = {
      type: 'error',
      payload: { message: 'Invalid message format', code: 'PARSE_ERROR' },
    };
    ws.send(JSON.stringify(errorMsg));
  }
}

/**
 * Handle authentication messages
 */
function handleAuthMessage(ws: ServerWebSocket<WSClientData>, request: WSRequest) {
  if (request.type === 'ping' && 'token' in request.payload) {
    const { token } = request.payload as { token?: string; timestamp: number };

    if (token === config.authToken) {
      if (ws.data) {
        ws.data.authenticated = true;
      }

      const response: WSResponse = {
        type: 'auth.success',
        payload: { message: 'Authentication successful' },
        id: request.id,
      };
      ws.send(JSON.stringify(response));
      console.log(`[WebSocket] Client authenticated: ${ws.data?.id}`);
    } else {
      const error: WSMessage = {
        type: 'error',
        payload: { message: 'Invalid authentication token', code: 'AUTH_FAILED' },
      };
      ws.send(JSON.stringify(error));
      ws.close(1008, 'Authentication failed');
    }
  } else {
    const error: WSMessage = {
      type: 'auth.required',
      payload: { message: 'Authentication required' },
    };
    ws.send(JSON.stringify(error));
  }
}

/**
 * Handle authenticated messages - routes to real subsystems via DaemonContext
 */
function handleAuthenticatedMessage(ws: ServerWebSocket<WSClientData>, request: WSRequest) {
  switch (request.type) {
    case 'ping':
      handlePing(ws, request);
      break;
    case 'status':
      handleStatusRequest(ws, request);
      break;
    case 'cron.list':
      handleCronListRequest(ws, request);
      break;
    case 'cron.run':
      handleCronRunRequest(ws, request);
      break;
    case 'queue.status':
      handleQueueStatusRequest(ws, request);
      break;
    case 'health':
      handleHealthRequest(ws, request);
      break;
    case 'canvas.rpc':
      handleCanvasRpc(ws, request);
      break;
    default:
      const error: WSMessage = {
        type: 'error',
        payload: { message: `Unknown message type: ${request.type}`, code: 'UNKNOWN_TYPE' },
      };
      ws.send(JSON.stringify(error));
  }
}

/**
 * Handle canvas.rpc messages — broadcast to all other authenticated clients
 */
function handleCanvasRpc(sender: ServerWebSocket<WSClientData>, request: WSRequest) {
  const message = JSON.stringify(request);
  for (const [client, data] of clients) {
    if (client !== sender && data.authenticated) {
      client.send(message);
    }
  }
}

function handlePing(ws: ServerWebSocket<WSClientData>, request: WSRequest) {
  const response: WSResponse = {
    type: 'pong',
    payload: { timestamp: Date.now() },
    id: request.id,
  };
  ws.send(JSON.stringify(response));
}

/**
 * Status request - returns real daemon metrics
 */
async function handleStatusRequest(ws: ServerWebSocket<WSClientData>, request: WSRequest) {
  if (!daemonContext) {
    ws.send(JSON.stringify({
      type: 'error',
      payload: { message: 'Daemon context not initialized', code: 'NOT_READY' },
      id: request.id,
    }));
    return;
  }

  const { cronManager, messageQueue, healthMonitor } = daemonContext;
  const jobs = await cronManager.listJobs();
  const queueStatus = messageQueue.getQueueStatus();
  const health = healthMonitor.getHealth();

  const status: DaemonStatus = {
    uptime: health.uptime,
    connectedClients: clients.size,
    cronJobsRunning: jobs.filter(j => j.enabled).length,
    cronJobsTotal: jobs.length,
    queuedTasks: queueStatus.pending,
    queueProcessed: queueStatus.processed,
    queueFailed: queueStatus.failed,
    lastActivity: Date.now(),
    health: health.status,
    version: '2.0.0',
  };

  const response: WSResponse = {
    type: 'status',
    payload: status,
    id: request.id,
  };
  ws.send(JSON.stringify(response));
}

/**
 * Cron list - returns real job data from CronManager
 */
async function handleCronListRequest(ws: ServerWebSocket<WSClientData>, request: WSRequest) {
  if (!daemonContext) {
    ws.send(JSON.stringify({ type: 'cron.list', payload: [], id: request.id }));
    return;
  }

  const jobs = await daemonContext.cronManager.listJobs();

  // Map to wire format
  const wireJobs = jobs.map(j => ({
    id: j.id,
    name: j.id,
    schedule: j.schedule,
    type: j.type,
    output: j.output,
    enabled: j.enabled,
    lastRun: j.lastRun ? new Date(j.lastRun).getTime() : undefined,
    nextRun: j.nextRun ? new Date(j.nextRun).getTime() : undefined,
    runCount: j.runCount,
    failCount: j.failCount,
  }));

  const response: WSResponse = {
    type: 'cron.list',
    payload: wireJobs,
    id: request.id,
  };
  ws.send(JSON.stringify(response));
}

/**
 * Cron run - triggers a job via CronManager and broadcasts result
 */
async function handleCronRunRequest(ws: ServerWebSocket<WSClientData>, request: WSRequest) {
  const { jobId } = request.payload as { jobId: string };

  if (!daemonContext) {
    ws.send(JSON.stringify({
      type: 'cron.result',
      payload: { jobId, success: false, error: 'Daemon context not initialized' },
      id: request.id,
    }));
    return;
  }

  // Send immediate acknowledgment
  ws.send(JSON.stringify({
    type: 'cron.result',
    payload: { jobId, success: true, output: 'Job triggered' },
    id: request.id,
  }));

  // Run the job asynchronously - result will come via EventBus broadcast
  try {
    await daemonContext.cronManager.runJobNow(jobId);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    broadcast({
      type: 'cron.result',
      payload: { jobId, success: false, error },
    });
  }
}

/**
 * Queue status - returns real MessageQueue metrics
 */
function handleQueueStatusRequest(ws: ServerWebSocket<WSClientData>, request: WSRequest) {
  if (!daemonContext) {
    ws.send(JSON.stringify({
      type: 'queue.status',
      payload: { pending: 0, active: 0, completed: 0, failed: 0 },
      id: request.id,
    }));
    return;
  }

  const status = daemonContext.messageQueue.getQueueStatus();
  const response: WSResponse = {
    type: 'queue.status',
    payload: {
      pending: status.pending,
      active: 0,
      completed: status.processed,
      failed: status.failed,
    },
    id: request.id,
  };
  ws.send(JSON.stringify(response));
}

/**
 * Health request - returns HealthMonitor data
 */
function handleHealthRequest(ws: ServerWebSocket<WSClientData>, request: WSRequest) {
  if (!daemonContext) {
    ws.send(JSON.stringify({
      type: 'error',
      payload: { message: 'Daemon context not initialized', code: 'NOT_READY' },
      id: request.id,
    }));
    return;
  }

  const health = daemonContext.healthMonitor.getHealth();
  const response: WSResponse = {
    type: 'health',
    payload: health,
    id: request.id,
  };
  ws.send(JSON.stringify(response));
}

/**
 * Handle WebSocket connection close
 */
function handleClose(ws: ServerWebSocket<WSClientData>, code: number, reason: string) {
  const clientId = ws.data?.id || 'unknown';
  clients.delete(ws);
  console.log(`[WebSocket] Client disconnected: ${clientId} (${clients.size} remaining)`);
}

function handleDrain(ws: ServerWebSocket<WSClientData>) {
  // Backpressure relief - no action needed
}

/**
 * Broadcast message to all connected, authenticated clients
 */
export function broadcast(message: WSMessage): number {
  let sent = 0;
  const payload = JSON.stringify(message);

  for (const [ws, data] of clients.entries()) {
    if (data.authenticated) {
      try {
        ws.send(payload);
        sent++;
      } catch (error) {
        console.error(`[WebSocket] Failed to send to client ${data.id}:`, error);
      }
    }
  }

  return sent;
}

export function sendToClient(clientId: string, message: WSMessage): boolean {
  for (const [ws, data] of clients.entries()) {
    if (data.id === clientId && data.authenticated) {
      try {
        ws.send(JSON.stringify(message));
        return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function getConnectedClients(): number {
  return clients.size;
}

export function getAuthenticatedClients(): number {
  let count = 0;
  for (const data of clients.values()) {
    if (data.authenticated) count++;
  }
  return count;
}

export function getClientList(): WSClientData[] {
  return Array.from(clients.values());
}

function startHeartbeat() {
  if (heartbeatInterval) return;

  heartbeatInterval = setInterval(() => {
    const now = Date.now();
    const timeout = config.heartbeatTimeout || 60000;

    for (const [ws, data] of clients.entries()) {
      if (now - data.lastPing > timeout) {
        console.warn(`[WebSocket] Client timeout: ${data.id}`);
        ws.close(1000, 'Heartbeat timeout');
        clients.delete(ws);
      }
    }
  }, config.heartbeatInterval || 30000);
}

export function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

export function shutdown() {
  console.log('[WebSocket] Shutting down...');
  stopHeartbeat();

  broadcast({
    type: 'notification',
    payload: { message: 'Server shutting down', channel: 'system', timestamp: Date.now() },
  });

  for (const [ws] of clients.entries()) {
    ws.close(1001, 'Server shutdown');
  }
  clients.clear();
}

export function getHealthStatus() {
  return {
    healthy: true,
    connectedClients: clients.size,
    authenticatedClients: getAuthenticatedClients(),
    heartbeatActive: heartbeatInterval !== null,
  };
}
