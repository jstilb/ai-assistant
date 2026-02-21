#!/usr/bin/env npx tsx
/**
 * PTY Backend — Node.js process managing interactive pseudo-terminal sessions.
 *
 * Connects to the Kaya daemon WebSocket at ws://localhost:18000 and handles:
 * - canvas.pty.spawn:  Create a new PTY session (returns sessionId + pid)
 * - canvas.pty.input:  Forward base64-encoded keystrokes to a PTY
 * - canvas.pty.resize: Resize a PTY
 * - canvas.pty.kill:   Terminate a PTY session
 *
 * Emits:
 * - canvas.pty.output: Base64-encoded terminal output (16ms buffered)
 * - canvas.pty.exited: Process exit notification
 *
 * Runtime: Node.js (not Bun) — node-pty is a native C++ addon with reliable Node support.
 */

import { spawn as ptySpawn, type IPty } from 'node-pty';
import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { existsSync } from 'fs';

// ============================================================================
// Types
// ============================================================================

interface PtySession {
  pty: IPty;
  containerId: string;
  sessionId: string;
  outputBuffer: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

interface CanvasRpcPayload {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

// ============================================================================
// Constants
// ============================================================================

const DAEMON_URL = process.env['KAYA_DAEMON_URL'] ?? 'ws://localhost:18000';
const OUTPUT_BUFFER_MS = 16; // ~60fps flush interval
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const PING_INTERVAL_MS = 20_000; // Keep-alive ping every 20s (daemon timeout is 60s)

// ============================================================================
// State
// ============================================================================

const sessions = new Map<string, PtySession>();
let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let isShuttingDown = false;

// ============================================================================
// WebSocket Connection
// ============================================================================

function connect(): void {
  if (isShuttingDown) return;

  console.log(`[PtyBackend] Connecting to ${DAEMON_URL}...`);
  const socket = new WebSocket(DAEMON_URL);

  socket.on('open', () => {
    console.log('[PtyBackend] Connected, awaiting auth...');
  });

  socket.on('message', (data: WebSocket.Data) => {
    const raw = typeof data === 'string' ? data : data.toString();
    handleMessage(socket, raw);
  });

  socket.on('close', (code: number, reason: Buffer) => {
    console.log(`[PtyBackend] Disconnected (code=${code}, reason=${reason.toString()})`);
    ws = null;
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (!isShuttingDown) {
      scheduleReconnect();
    }
  });

  socket.on('error', (err: Error) => {
    console.error('[PtyBackend] WebSocket error:', err.message);
  });
}

function scheduleReconnect(): void {
  if (isShuttingDown || reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt), RECONNECT_MAX_MS);
  reconnectAttempt++;
  console.log(`[PtyBackend] Reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function handleMessage(socket: WebSocket, raw: string): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  // Auth flow
  if (parsed['type'] === 'auth.required') {
    // Daemon expects type: 'ping' with token in payload (matches CanvasClient auth)
    socket.send(JSON.stringify({ type: 'ping', payload: { token: '', timestamp: Date.now() } }));
    return;
  }

  if (parsed['type'] === 'auth.success') {
    console.log('[PtyBackend] Authenticated');
    ws = socket;
    reconnectAttempt = 0;

    // Start keepalive pings to prevent heartbeat timeout
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping', payload: { timestamp: Date.now() } }));
      }
    }, PING_INTERVAL_MS);
    return;
  }

  // Canvas RPC envelope
  if (parsed['type'] === 'canvas.rpc') {
    const payload = parsed['payload'] as CanvasRpcPayload | undefined;
    if (!payload?.method) return;
    handleRpc(payload);
  }
}

// ============================================================================
// RPC Dispatch
// ============================================================================

function handleRpc(payload: CanvasRpcPayload): void {
  const { method, params, id } = payload;

  switch (method) {
    case 'canvas.pty.spawn':
      handleSpawn(params ?? {}, id);
      break;
    case 'canvas.pty.input':
      handleInput(params ?? {});
      break;
    case 'canvas.pty.resize':
      handleResize(params ?? {});
      break;
    case 'canvas.pty.kill':
      handleKill(params ?? {}, id);
      break;
    // Ignore methods not for us (output, exited are sent by us)
  }
}

// ============================================================================
// PTY Handlers
// ============================================================================

/**
 * Resolve a command name to its absolute path.
 * Falls back to the original command if not found (let posix_spawnp try).
 */
function resolveCommand(command: string, pathEnv: string): string {
  // Already absolute
  if (command.startsWith('/')) return command;

  // Check each PATH directory
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    const candidate = `${dir}/${command}`;
    if (existsSync(candidate)) return candidate;
  }

  // Try `which` as fallback via login shell (picks up shell profile)
  try {
    const result = execSync(`/bin/zsh -lc "which ${command}" 2>/dev/null`, { encoding: 'utf8' }).trim();
    if (result && existsSync(result)) return result;
  } catch {
    // ignore
  }

  return command;
}

function handleSpawn(params: Record<string, unknown>, requestId?: string | number): void {
  const containerId = params['containerId'] as string;
  const cols = (params['cols'] as number) || 80;
  const rows = (params['rows'] as number) || 24;
  const command = (params['command'] as string) || 'claude';
  const args = (params['args'] as string[]) || [];
  const cwd = (params['cwd'] as string) || process.env['HOME'] || '/';

  if (!containerId) {
    sendResponse(requestId, undefined, { code: -32602, message: 'Missing containerId' });
    return;
  }

  const sessionId = randomUUID();

  try {
    // Ensure common binary locations are in PATH
    const homedir = process.env['HOME'] ?? '/Users/your-username';
    const existingPath = process.env['PATH'] ?? '';
    const extraPaths = [
      `${homedir}/.local/bin`,
      `${homedir}/.bun/bin`,
      '/usr/local/bin',
      '/opt/homebrew/bin',
    ];
    const augmentedPath = [...extraPaths, existingPath].join(':');

    // Resolve command to absolute path — posix_spawnp may not search augmented PATH
    const resolvedCommand = resolveCommand(command, augmentedPath);
    console.log(`[PtyBackend] Resolved command "${command}" -> "${resolvedCommand}"`);

    // Build env: spread process.env, then delete CLAUDECODE to prevent
    // Claude Code from refusing to start ("nested session" detection)
    const ptyEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      PATH: augmentedPath,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      KAYA_CANVAS_ACTIVE: '1',
      KAYA_CANVAS_CONTAINER_ID: containerId,
      KAYA_DAEMON_URL: DAEMON_URL,
    };
    delete ptyEnv['CLAUDECODE'];

    const pty = ptySpawn(resolvedCommand, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: ptyEnv,
    });

    const session: PtySession = {
      pty,
      containerId,
      sessionId,
      outputBuffer: '',
      flushTimer: null,
    };

    sessions.set(sessionId, session);

    // Buffer PTY output and flush every 16ms
    pty.onData((data: string) => {
      session.outputBuffer += data;
      if (!session.flushTimer) {
        session.flushTimer = setTimeout(() => {
          flushOutput(session);
        }, OUTPUT_BUFFER_MS);
      }
    });

    pty.onExit(({ exitCode }: { exitCode: number }) => {
      // Flush any remaining output
      if (session.outputBuffer.length > 0) {
        flushOutput(session);
      }

      sendNotification('canvas.pty.exited', {
        sessionId,
        exitCode,
      });

      // Clean up
      if (session.flushTimer) {
        clearTimeout(session.flushTimer);
      }
      sessions.delete(sessionId);
      console.log(`[PtyBackend] Session ${sessionId} exited (code ${exitCode})`);
    });

    console.log(`[PtyBackend] Spawned "${command}" (pid=${pty.pid}, session=${sessionId})`);

    sendResponse(requestId, {
      sessionId,
      pid: pty.pid,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[PtyBackend] Failed to spawn: ${message}`);
    sendResponse(requestId, undefined, { code: -32603, message: `Spawn failed: ${message}` });
  }
}

function handleInput(params: Record<string, unknown>): void {
  const sessionId = params['sessionId'] as string;
  const base64Data = params['data'] as string;

  const session = sessions.get(sessionId);
  if (!session) return;

  // Decode base64 to UTF-8 string
  const decoded = Buffer.from(base64Data, 'base64').toString('utf8');
  session.pty.write(decoded);
}

function handleResize(params: Record<string, unknown>): void {
  const sessionId = params['sessionId'] as string;
  const cols = params['cols'] as number;
  const rows = params['rows'] as number;

  const session = sessions.get(sessionId);
  if (!session) return;

  session.pty.resize(cols, rows);
}

function handleKill(params: Record<string, unknown>, requestId?: string | number): void {
  const sessionId = params['sessionId'] as string;
  const session = sessions.get(sessionId);

  if (!session) {
    sendResponse(requestId, { sessionId, killed: false });
    return;
  }

  session.pty.kill();
  if (session.flushTimer) {
    clearTimeout(session.flushTimer);
  }
  sessions.delete(sessionId);
  console.log(`[PtyBackend] Killed session ${sessionId}`);
  sendResponse(requestId, { sessionId, killed: true });
}

// ============================================================================
// Output Buffering
// ============================================================================

function flushOutput(session: PtySession): void {
  session.flushTimer = null;

  if (session.outputBuffer.length === 0) return;

  // Base64-encode the PTY output (UTF-8 → base64)
  const base64 = Buffer.from(session.outputBuffer, 'utf8').toString('base64');
  session.outputBuffer = '';

  sendNotification('canvas.pty.output', {
    sessionId: session.sessionId,
    data: base64,
  });
}

// ============================================================================
// WebSocket Senders
// ============================================================================

function sendResponse(
  id: string | number | undefined,
  result?: unknown,
  error?: { code: number; message: string },
): void {
  if (!ws || ws.readyState !== WebSocket.OPEN || id === undefined) return;

  const payload: CanvasRpcPayload = error
    ? { jsonrpc: '2.0', id, error }
    : { jsonrpc: '2.0', id, result };

  ws.send(JSON.stringify({ type: 'canvas.rpc', payload }));
}

function sendNotification(method: string, params: Record<string, unknown>): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    type: 'canvas.rpc',
    payload: {
      jsonrpc: '2.0',
      method,
      params,
    },
  }));
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

function shutdown(): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[PtyBackend] Shutting down...');

  // Kill all PTY sessions
  for (const [sessionId, session] of sessions) {
    try {
      session.pty.kill();
    } catch {
      // already dead
    }
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
    }
    console.log(`[PtyBackend] Killed session ${sessionId}`);
  }
  sessions.clear();

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  if (pingTimer) {
    clearInterval(pingTimer);
  }

  if (ws) {
    ws.close(1000, 'PtyBackend shutdown');
  }

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ============================================================================
// Start
// ============================================================================

console.log('[PtyBackend] Starting...');
connect();
