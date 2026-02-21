#!/usr/bin/env bun
/**
 * Canvas Client — Agent-Side Bun WebSocket Client
 *
 * Connects to the Kaya daemon at ws://localhost:18000 and provides typed
 * methods for all canvas.* JSON-RPC operations.
 *
 * Usage (from another skill/tool):
 *   import { CanvasClient } from './CanvasClient.ts'
 *   const client = new CanvasClient()
 *   await client.connect()
 *   const { id } = await client.createContainer({ type: 'markdown', props: { content: '# Hello' }, position: { x: 100, y: 100 } })
 *   await client.streamToContainer(id, 'World', true)
 *   client.destroy()
 */

import type {
  ContainerSpec,
  PipeSpec,
  LayoutDelta,
  CanvasRpcPayload,
} from '../../lib/daemon/types.ts';

// ============================================================================
// Types
// ============================================================================

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
}

export type ContainerEventType = 'click' | 'input' | 'resize' | 'move' | 'close';

export interface ContainerEvent {
  id: string;
  event: ContainerEventType;
  data: unknown;
}

export type ContainerEventHandler = (event: ContainerEvent) => void;

export interface ChatMessage {
  message: string;
  timestamp: number;
}

export type ChatMessageHandler = (msg: ChatMessage) => void;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

// ============================================================================
// Constants
// ============================================================================

const DAEMON_URL = 'ws://localhost:18000';
const REQUEST_TIMEOUT_MS = 5000;
const AUTH_TIMEOUT_MS = 5000;
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;

// ============================================================================
// CanvasClient
// ============================================================================

export class CanvasClient {
  private ws: WebSocket | null = null;
  private pendingRequests = new Map<number, PendingRequest>();
  private eventHandlers: ContainerEventHandler[] = [];
  private chatHandlers: ChatMessageHandler[] = [];
  private idCounter = 0;
  private reconnectAttempt = 0;
  private reconnectTimerId: ReturnType<typeof setTimeout> | null = null;
  private isAuthenticated = false;
  private isDestroyed = false;
  private authTimerId: ReturnType<typeof setTimeout> | null = null;

  // Resolved when auth.success is received
  private authResolve: (() => void) | null = null;
  private authReject: ((err: Error) => void) | null = null;

  // -------------------------------------------------------------------------
  // Public: Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Connect to the daemon and authenticate.
   * Resolves when auth.success is received.
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.authResolve = resolve;
      this.authReject = reject;
      this.openSocket();
    });
  }

  /**
   * Tear down the connection permanently (no reconnect).
   */
  destroy(): void {
    this.isDestroyed = true;
    this.clearReconnectTimer();
    this.clearAuthTimer();
    this.rejectAllPending(new Error('CanvasClient destroyed'));
    this.ws = null;
  }

  /** Register a handler for incoming canvas.container.event notifications */
  onContainerEvent(handler: ContainerEventHandler): void {
    this.eventHandlers.push(handler);
  }

  /** Remove a previously registered event handler */
  offContainerEvent(handler: ContainerEventHandler): void {
    this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
  }

  /** Register a handler for incoming canvas.chat.send notifications */
  onChatMessage(handler: ChatMessageHandler): void {
    this.chatHandlers.push(handler);
  }

  /** Remove a previously registered chat handler */
  offChatMessage(handler: ChatMessageHandler): void {
    this.chatHandlers = this.chatHandlers.filter((h) => h !== handler);
  }

  /** Send a chat response to Canvas (agent -> user) */
  sendChatResponse(message: string, streaming = false): void {
    if (!this.isAuthenticated || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[CanvasClient] Cannot send chat response — not connected');
      return;
    }
    const envelope = JSON.stringify({
      type: 'canvas.rpc',
      payload: {
        jsonrpc: '2.0',
        method: 'canvas.chat.receive',
        params: { message, timestamp: Date.now(), streaming },
      },
    });
    this.ws.send(envelope);
  }

  get connected(): boolean {
    return this.isAuthenticated;
  }

  // -------------------------------------------------------------------------
  // Public: Canvas RPC Methods
  // -------------------------------------------------------------------------

  async createContainer(
    spec: Omit<ContainerSpec, 'id'> & { id?: string },
  ): Promise<{ id: string; spec: ContainerSpec }> {
    const result = await this.sendRequest('canvas.container.create', { spec });
    return result as { id: string; spec: ContainerSpec };
  }

  async updateContainer(
    id: string,
    partial: Partial<ContainerSpec>,
  ): Promise<{ id: string; spec: ContainerSpec }> {
    const result = await this.sendRequest('canvas.container.update', { id, partial });
    return result as { id: string; spec: ContainerSpec };
  }

  async deleteContainer(id: string): Promise<{ id: string; deleted: true }> {
    const result = await this.sendRequest('canvas.container.delete', { id });
    return result as { id: string; deleted: true };
  }

  async streamToContainer(
    id: string,
    chunk: string,
    done = false,
  ): Promise<{ id: string; length: number }> {
    // `done` is informational for the agent side — the stream param is `append`
    // append=true means add to existing content, append=false means replace
    const result = await this.sendRequest('canvas.container.stream', {
      id,
      chunk,
      append: !done, // When done=true, this is the final chunk (still appended)
    });
    return result as { id: string; length: number };
  }

  async readContainer(id: string): Promise<{ id: string; spec: ContainerSpec; content: string }> {
    const result = await this.sendRequest('canvas.container.read', { id });
    return result as { id: string; spec: ContainerSpec; content: string };
  }

  async snapshotLayout(): Promise<{ containers: ContainerSpec[]; pipes?: PipeSpec[] }> {
    const result = await this.sendRequest('canvas.layout.snapshot', {});
    return result as { containers: ContainerSpec[]; pipes?: PipeSpec[] };
  }

  async applyLayout(
    containers: ContainerSpec[],
    pipes?: PipeSpec[],
  ): Promise<{ applied: number; removed: number }> {
    const result = await this.sendRequest('canvas.layout.apply', {
      containers,
      pipes: pipes ?? [],
    });
    return result as { applied: number; removed: number };
  }

  async ping(): Promise<{ pong: true; latency: number }> {
    const start = Date.now();
    const result = await this.sendRequest('canvas.ping', {});
    const latency = Date.now() - start;
    return { pong: true, latency };
  }

  // -------------------------------------------------------------------------
  // Private: JSON-RPC Request/Response
  // -------------------------------------------------------------------------

  private async sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.isAuthenticated) {
      throw new Error('CanvasClient: not authenticated — call connect() first');
    }

    const id = ++this.idCounter;
    const payload: CanvasRpcPayload = {
      jsonrpc: '2.0',
      id,
      method: method as CanvasRpcPayload['method'],
      params,
    };
    const envelope = JSON.stringify({ type: 'canvas.rpc', payload });

    return new Promise<unknown>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`CanvasClient: request timeout for "${method}" (id=${id})`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timeoutId });

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(envelope);
      } else {
        clearTimeout(timeoutId);
        this.pendingRequests.delete(id);
        reject(new Error('CanvasClient: no active WebSocket connection'));
      }
    });
  }

  // -------------------------------------------------------------------------
  // Private: Socket Management (WebSocket client)
  // -------------------------------------------------------------------------

  private openSocket(): void {
    if (this.isDestroyed) return;

    try {
      const socket = new WebSocket(DAEMON_URL);

      socket.onopen = () => {
        this.ws = socket;
        // Start auth timeout — daemon sends auth.required or auth.success on connect
        this.authTimerId = setTimeout(() => {
          const reject = this.authReject;
          this.authReject = null;
          this.authResolve = null;
          reject?.(new Error('CanvasClient: auth timeout'));
          this.scheduleReconnect();
        }, AUTH_TIMEOUT_MS);
      };

      socket.onmessage = (event: MessageEvent) => {
        const data = typeof event.data === 'string' ? event.data : String(event.data);
        this.handleData(data);
      };

      socket.onclose = () => {
        this.clearAuthTimer();
        this.isAuthenticated = false;
        this.ws = null;
        this.rejectAllPending(new Error('WebSocket closed'));
        if (!this.isDestroyed) {
          this.scheduleReconnect();
        }
      };

      socket.onerror = (event) => {
        console.error('[CanvasClient] Socket error:', event);
        this.clearAuthTimer();
        this.isAuthenticated = false;
        if (!this.isDestroyed) {
          this.scheduleReconnect();
        }
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[CanvasClient] Connect error:', message);
      if (!this.isDestroyed) {
        this.scheduleReconnect();
      } else {
        this.authReject?.(new Error(`Connection failed: ${message}`));
      }
    }
  }

  private handleData(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      console.error('[CanvasClient] Failed to parse message:', data);
      return;
    }

    if (!parsed || typeof parsed !== 'object') return;

    const msg = parsed as Record<string, unknown>;

    // Auth flow
    if (msg['type'] === 'auth.required') {
      this.sendAuthToken();
      return;
    }

    if (msg['type'] === 'auth.success') {
      this.clearAuthTimer();
      this.isAuthenticated = true;
      this.reconnectAttempt = 0;
      const resolve = this.authResolve;
      this.authResolve = null;
      this.authReject = null;
      resolve?.();
      return;
    }

    // canvas.rpc envelope
    if (msg['type'] === 'canvas.rpc') {
      const payload = msg['payload'];
      if (!payload || typeof payload !== 'object') return;
      this.handleCanvasRpc(payload as Record<string, unknown>);
      return;
    }
  }

  private handleCanvasRpc(payload: Record<string, unknown>): void {
    const id = payload['id'] as number | undefined;
    const method = payload['method'] as string | undefined;
    const hasResult = 'result' in payload;
    const hasError = 'error' in payload;

    // Response to our request
    if (id !== undefined && (hasResult || hasError)) {
      const pending = this.pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(id);
        if (hasError) {
          const error = payload['error'] as { code: number; message: string } | undefined;
          pending.reject(
            new Error(
              error ? `RPC error ${error.code}: ${error.message}` : 'Unknown RPC error',
            ),
          );
        } else {
          pending.resolve((payload as JsonRpcResponse)['result']);
        }
      }
      return;
    }

    // Notification (Canvas → Agent)
    if (method === 'canvas.container.event') {
      const params = payload['params'] as ContainerEvent | undefined;
      if (params) {
        for (const handler of this.eventHandlers) {
          try {
            handler(params);
          } catch (err) {
            console.error('[CanvasClient] Event handler error:', err);
          }
        }
      }
      return;
    }

    if (method === 'canvas.chat.send') {
      const params = payload['params'] as ChatMessage | undefined;
      if (params) {
        for (const handler of this.chatHandlers) {
          try {
            handler(params);
          } catch (err) {
            console.error('[CanvasClient] Chat handler error:', err);
          }
        }
      }
      return;
    }

    if (method === 'canvas.layout.feedback') {
      const params = payload['params'] as { deltas: LayoutDelta[] } | undefined;
      if (params) {
        console.log('[CanvasClient] Layout feedback received:', params.deltas);
      }
      return;
    }
  }

  private sendAuthToken(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const authMessage = JSON.stringify({ type: 'ping', payload: { token: '', timestamp: Date.now() } });
    this.ws.send(authMessage);
  }

  // -------------------------------------------------------------------------
  // Private: Reconnect
  // -------------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (this.isDestroyed) return;
    this.clearReconnectTimer();
    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempt),
      MAX_RECONNECT_DELAY_MS,
    );
    console.log(`[CanvasClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt + 1})`);
    this.reconnectAttempt++;
    this.reconnectTimerId = setTimeout(() => {
      if (!this.isDestroyed) {
        this.openSocket();
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimerId !== null) {
      clearTimeout(this.reconnectTimerId);
      this.reconnectTimerId = null;
    }
  }

  private clearAuthTimer(): void {
    if (this.authTimerId !== null) {
      clearTimeout(this.authTimerId);
      this.authTimerId = null;
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }
}

// ============================================================================
// CLI Interface (Article II compliance)
// ============================================================================

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);

  async function main() {
    const client = new CanvasClient();

    try {
      console.log('[CanvasClient] Connecting to daemon...');
      await client.connect();
      console.log('[CanvasClient] Connected and authenticated.');

      switch (command) {
        case 'ping': {
          const result = await client.ping();
          console.log(JSON.stringify(result));
          break;
        }
        case 'create': {
          const type = (args[0] ?? 'markdown') as ContainerSpec['type'];
          const content = args[1] ?? '# Hello from CanvasClient';
          const result = await client.createContainer({
            type,
            position: { x: 100, y: 100 },
            props: { content },
          });
          console.log(JSON.stringify(result));
          break;
        }
        case 'stream': {
          const id = args[0];
          const text = args[1] ?? 'Hello, streaming world!';
          if (!id) {
            console.error('Usage: stream <container-id> <text>');
            process.exit(1);
          }
          const result = await client.streamToContainer(id, text, true);
          console.log(JSON.stringify(result));
          break;
        }
        case 'delete': {
          const id = args[0];
          if (!id) {
            console.error('Usage: delete <container-id>');
            process.exit(1);
          }
          const result = await client.deleteContainer(id);
          console.log(JSON.stringify(result));
          break;
        }
        case 'snapshot': {
          const result = await client.snapshotLayout();
          console.log(JSON.stringify(result, null, 2));
          break;
        }
        case 'chat': {
          const text = args[0];
          if (!text) {
            console.error('Usage: chat <message>');
            process.exit(1);
          }
          client.sendChatResponse(text);
          console.log(`[CanvasClient] Sent chat message: "${text}"`);
          // Small delay to let the message flush
          await new Promise((r) => setTimeout(r, 200));
          break;
        }
        case 'listen': {
          // Spawn ChatListener as a subprocess (convenience alias)
          client.destroy();
          const listenerPath = new URL('./ChatListener.ts', import.meta.url).pathname;
          const proc = Bun.spawn(['bun', listenerPath], {
            stdout: 'inherit',
            stderr: 'inherit',
            stdin: 'inherit',
          });
          process.on('SIGINT', () => proc.kill());
          await proc.exited;
          process.exit(proc.exitCode ?? 0);
          break;
        }
        default:
          console.error(
            'Usage: CanvasClient.ts <command> [args]\n' +
            'Commands: ping, create [type] [content], stream <id> <text>, delete <id>, snapshot, chat <message>, listen',
          );
          process.exit(1);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[CanvasClient] Error:', message);
      process.exit(1);
    } finally {
      client.destroy();
    }
  }

  main();
}
