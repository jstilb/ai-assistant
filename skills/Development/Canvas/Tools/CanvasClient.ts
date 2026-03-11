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
} from '../../../../lib/daemon/types.ts';

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

export interface SheetResult {
  id: string;
  name: string;
  color?: string;
  icon?: string;
  pinned: boolean;
  containerIds: string[];
  tabGroupIds: string[];
  createdAt: number;
}

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

export interface LayoutFeedbackDelta {
  containerId: string;
  containerType: string;
  field: 'position' | 'size' | 'removed' | 'added';
  before: { x: number; y: number } | { width: number; height: number } | null;
  after: { x: number; y: number } | { width: number; height: number } | null;
}

export interface LayoutFeedbackEvent {
  method: 'canvas.layout.feedback';
  params: {
    deltas: LayoutFeedbackDelta[];
    timestamp: number;
    intentContext?: string;
  };
}

export type LayoutFeedbackHandler = (event: LayoutFeedbackEvent) => void;

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
  private feedbackHandlers: LayoutFeedbackHandler[] = [];
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

  /** Register a handler for incoming canvas.layout.feedback notifications */
  onLayoutFeedback(handler: LayoutFeedbackHandler): void {
    this.feedbackHandlers.push(handler);
  }

  /** Remove a previously registered layout feedback handler */
  offLayoutFeedback(handler: LayoutFeedbackHandler): void {
    this.feedbackHandlers = this.feedbackHandlers.filter((h) => h !== handler);
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
    /** Optional: auto-add the new container to this tab group after creation */
    tabGroup?: string,
  ): Promise<{ id: string; spec: ContainerSpec }> {
    const params: Record<string, unknown> = { spec };
    if (tabGroup !== undefined) params['tabGroup'] = tabGroup;
    const result = await this.sendRequest('canvas.container.create', params);
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
    // Always append chunks during streaming — `append: true` on every call.
    // `done: true` signals the stream is complete; the final chunk is still appended.
    const result = await this.sendRequest('canvas.container.stream', {
      id,
      chunk,
      append: true,
      done,
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
  // Public: Tab Group RPC Methods (Phase 7)
  // -------------------------------------------------------------------------

  /**
   * Create a tab group from existing containers.
   * Requires at least 2 containerIds. Returns an error if fewer are provided.
   */
  async createTabGroup(
    containerIds: string[],
    activeContainerId?: string,
  ): Promise<{ id: string; containerIds: string[]; activeContainerId: string }> {
    const params: Record<string, unknown> = { containerIds };
    if (activeContainerId !== undefined) params['activeContainerId'] = activeContainerId;
    const result = await this.sendRequest('canvas.tabgroup.create', params);
    return result as { id: string; containerIds: string[]; activeContainerId: string };
  }

  /**
   * Add an existing container to a tab group by ID.
   * Optionally specify the insertion index.
   */
  async addTab(
    groupId: string,
    containerId: string,
    index?: number,
  ): Promise<{ groupId: string; containerIds: string[] }> {
    const params: Record<string, unknown> = { groupId, containerId };
    if (index !== undefined) params['index'] = index;
    const result = await this.sendRequest('canvas.tabgroup.addTab', params);
    return result as { groupId: string; containerIds: string[] };
  }

  /**
   * Remove a container from a tab group.
   * If only 1 container remains, the group is automatically dissolved.
   */
  async removeTab(
    groupId: string,
    containerId: string,
  ): Promise<{ groupId: string; containerIds: string[]; dissolved: boolean }> {
    const result = await this.sendRequest('canvas.tabgroup.removeTab', { groupId, containerId });
    return result as { groupId: string; containerIds: string[]; dissolved: boolean };
  }

  /**
   * Set the active (visible) tab in a tab group.
   */
  async setActiveTab(
    groupId: string,
    containerId: string,
  ): Promise<{ groupId: string; activeContainerId: string }> {
    const result = await this.sendRequest('canvas.tabgroup.setActive', { groupId, containerId });
    return result as { groupId: string; activeContainerId: string };
  }

  // -------------------------------------------------------------------------
  // Public: Sheet RPC Methods (Phase 8)
  // -------------------------------------------------------------------------

  /**
   * Create a new sheet and switch to it.
   */
  async createSheet(params: { name: string; color?: string; icon?: string }): Promise<{ sheet: SheetResult }> {
    const result = await this.sendRequest('canvas.sheet.create', params as unknown as Record<string, unknown>);
    return result as { sheet: SheetResult };
  }

  /**
   * Switch the active sheet by ID.
   */
  async switchSheet(sheetId: string): Promise<{ activeSheetId: string }> {
    const result = await this.sendRequest('canvas.sheet.switch', { sheetId });
    return result as { activeSheetId: string };
  }

  /**
   * Delete a sheet by ID. Cannot delete the last sheet or a pinned sheet.
   */
  async deleteSheet(sheetId: string): Promise<{ deleted: boolean; activeSheetId: string }> {
    const result = await this.sendRequest('canvas.sheet.delete', { sheetId });
    return result as { deleted: boolean; activeSheetId: string };
  }

  /**
   * List all sheets with current active sheet ID.
   */
  async listSheets(): Promise<{ sheets: SheetResult[]; activeSheetId: string }> {
    const result = await this.sendRequest('canvas.sheet.list', {});
    return result as { sheets: SheetResult[]; activeSheetId: string };
  }

  /**
   * Update sheet properties (name, color, icon, pinned).
   */
  async updateSheet(sheetId: string, params: { name?: string; color?: string; icon?: string; pinned?: boolean }): Promise<{ sheet: SheetResult }> {
    const result = await this.sendRequest('canvas.sheet.update', { sheetId, ...params } as unknown as Record<string, unknown>);
    return result as { sheet: SheetResult };
  }

  /**
   * Move a container to a different sheet.
   */
  async moveContainer(containerId: string, targetSheetId: string): Promise<{ containerId: string; targetSheetId: string; moved: boolean }> {
    const result = await this.sendRequest('canvas.sheet.moveContainer', { containerId, targetSheetId });
    return result as { containerId: string; targetSheetId: string; moved: boolean };
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
      const params = payload['params'] as LayoutFeedbackEvent['params'] | undefined;
      if (params) {
        const event: LayoutFeedbackEvent = { method: 'canvas.layout.feedback', params };
        for (const handler of this.feedbackHandlers) {
          try {
            handler(event);
          } catch (err) {
            console.error('[CanvasClient] Feedback handler error:', err);
          }
        }
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

// ============================================================================
// Health Check (used by canvas-ctl health — no active connection needed
// for file-based checks; daemon ping is attempted with 2s timeout)
// ============================================================================

interface ServiceStatus {
  name: string;
  status: 'running' | 'stopped' | 'unknown';
  pid?: number;
  detail?: string;
}

interface HealthReport {
  daemon: ServiceStatus & { latencyMs?: number };
  webapp: ServiceStatus;
  chatListener: ServiceStatus;
  ptyBackend: ServiceStatus;
  connectedSessions: number;
  preferences: {
    total: number;
    active: number;
    decayed: number;
  };
}

async function checkPidFile(pidFilePath: string, label: string): Promise<ServiceStatus> {
  const { existsSync, readFileSync } = await import('fs');
  if (!existsSync(pidFilePath)) {
    return { name: label, status: 'unknown', detail: 'no PID file' };
  }

  let pid: number;
  try {
    pid = parseInt(readFileSync(pidFilePath, 'utf-8').trim(), 10);
    if (isNaN(pid) || pid <= 0) throw new Error('invalid PID');
  } catch {
    return { name: label, status: 'unknown', detail: 'unreadable PID file' };
  }

  // Check if process is running (kill -0 equivalent)
  try {
    process.kill(pid, 0);
    return { name: label, status: 'running', pid };
  } catch {
    return { name: label, status: 'stopped', pid, detail: 'process not found' };
  }
}

async function readSessionCount(sessionsPath: string): Promise<number> {
  const { existsSync, readFileSync } = await import('fs');
  if (!existsSync(sessionsPath)) return 0;
  try {
    const raw = JSON.parse(readFileSync(sessionsPath, 'utf-8')) as { sessions: unknown[] };
    return Array.isArray(raw.sessions) ? raw.sessions.length : 0;
  } catch {
    return 0;
  }
}

async function readPreferenceStats(prefsPath: string): Promise<{ total: number; active: number; decayed: number }> {
  const { existsSync, readFileSync } = await import('fs');
  const empty = { total: 0, active: 0, decayed: 0 };
  if (!existsSync(prefsPath)) return empty;
  try {
    const raw = JSON.parse(readFileSync(prefsPath, 'utf-8')) as {
      preferences: Array<{ confidence: number; lastReinforced: string }>;
    };
    if (!Array.isArray(raw.preferences)) return empty;
    const now = Date.now();
    const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
    let active = 0;
    let decayed = 0;
    for (const pref of raw.preferences) {
      const ageDays = (now - new Date(pref.lastReinforced).getTime()) / (1000 * 60 * 60 * 24);
      const currentConf = pref.confidence * Math.pow(2, -ageDays / 14);
      if (currentConf >= 0.7) {
        active++;
      } else {
        decayed++;
      }
    }
    return { total: raw.preferences.length, active, decayed };
  } catch {
    return empty;
  }
}

async function runHealthCheck(): Promise<void> {
  const { join } = await import('path');
  const stateDir = join(import.meta.dir, '..', 'State');

  // Check PID files in parallel (each has its own 0ms timeout via process.kill)
  const [webapp, chatListener, ptyBackend] = await Promise.all([
    checkPidFile(join(stateDir, 'canvas-webapp.pid'), 'Webapp'),
    checkPidFile(join(stateDir, 'canvas-chat.pid'), 'Chat Listener'),
    checkPidFile(join(stateDir, 'canvas-pty.pid'), 'PTY Backend'),
  ]);

  // Daemon: attempt ping with 2s timeout
  let daemonStatus: HealthReport['daemon'] = { name: 'Daemon', status: 'stopped', detail: 'unreachable' };
  try {
    const daemonClient = new CanvasClient();
    const connectPromise = daemonClient.connect().then(async () => {
      const { latency } = await daemonClient.ping();
      return latency;
    });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 2000)
    );
    const latencyMs = await Promise.race([connectPromise, timeoutPromise]);
    daemonClient.destroy();
    daemonStatus = { name: 'Daemon', status: 'running', latencyMs };
  } catch {
    daemonStatus = { name: 'Daemon', status: 'stopped', detail: 'unreachable (2s timeout)' };
  }

  // Sessions and preferences
  const connectedSessions = await readSessionCount(join(stateDir, 'active-sessions.json'));
  const preferences = await readPreferenceStats(join(stateDir, 'layout-preferences.json'));

  // Format output
  const report: HealthReport = {
    daemon: daemonStatus,
    webapp,
    chatListener,
    ptyBackend,
    connectedSessions,
    preferences,
  };

  function statusIcon(s: 'running' | 'stopped' | 'unknown'): string {
    if (s === 'running') return 'running';
    if (s === 'stopped') return 'stopped';
    return 'unknown';
  }

  console.log('');
  console.log('Canvas Health Report');
  console.log('===================');

  // Services
  const daemonDetail = daemonStatus.status === 'running'
    ? `${daemonStatus.latencyMs}ms latency`
    : (daemonStatus.detail ?? 'stopped');
  console.log(`  Daemon:        ${statusIcon(daemonStatus.status).padEnd(10)} ${daemonDetail}`);

  const webappDetail = webapp.pid ? `PID ${webapp.pid}` : (webapp.detail ?? '');
  console.log(`  Webapp:        ${statusIcon(webapp.status).padEnd(10)} ${webappDetail}`);

  const chatDetail = chatListener.pid ? `PID ${chatListener.pid}` : (chatListener.detail ?? '');
  console.log(`  Chat Listener: ${statusIcon(chatListener.status).padEnd(10)} ${chatDetail}`);

  const ptyDetail = ptyBackend.pid ? `PID ${ptyBackend.pid}` : (ptyBackend.detail ?? '');
  console.log(`  PTY Backend:   ${statusIcon(ptyBackend.status).padEnd(10)} ${ptyDetail}`);

  console.log('');
  console.log(`  Canvas Sessions:  ${connectedSessions} connected`);
  console.log(`  Preferences:      ${preferences.total} stored (${preferences.active} active, ${preferences.decayed} decayed)`);
  console.log('');

  console.log(JSON.stringify(report));
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);

  // Health check runs without a daemon connection
  if (command === 'health') {
    await runHealthCheck();
    process.exit(0);
  }

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
        case 'tabgroup.create': {
          const containerIds = args;
          if (containerIds.length < 2) {
            console.error('Usage: tabgroup.create <id1> <id2> [id3...]');
            process.exit(1);
          }
          const result = await client.createTabGroup(containerIds);
          console.log(JSON.stringify(result));
          break;
        }
        case 'tabgroup.addTab': {
          const [groupId, containerId] = args;
          if (!groupId || !containerId) {
            console.error('Usage: tabgroup.addTab <groupId> <containerId>');
            process.exit(1);
          }
          const result = await client.addTab(groupId, containerId);
          console.log(JSON.stringify(result));
          break;
        }
        case 'tabgroup.removeTab': {
          const [groupId, containerId] = args;
          if (!groupId || !containerId) {
            console.error('Usage: tabgroup.removeTab <groupId> <containerId>');
            process.exit(1);
          }
          const result = await client.removeTab(groupId, containerId);
          console.log(JSON.stringify(result));
          break;
        }
        case 'tabgroup.setActive': {
          const [groupId, containerId] = args;
          if (!groupId || !containerId) {
            console.error('Usage: tabgroup.setActive <groupId> <containerId>');
            process.exit(1);
          }
          const result = await client.setActiveTab(groupId, containerId);
          console.log(JSON.stringify(result));
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
        case 'sheet.create': {
          const name = args[0];
          if (!name) {
            console.error('Usage: sheet.create <name> [color] [icon]');
            process.exit(1);
          }
          const result = await client.createSheet({ name, color: args[1], icon: args[2] });
          console.log(JSON.stringify(result));
          break;
        }
        case 'sheet.switch': {
          const sheetId = args[0];
          if (!sheetId) {
            console.error('Usage: sheet.switch <sheetId>');
            process.exit(1);
          }
          const result = await client.switchSheet(sheetId);
          console.log(JSON.stringify(result));
          break;
        }
        case 'sheet.delete': {
          const sheetId = args[0];
          if (!sheetId) {
            console.error('Usage: sheet.delete <sheetId>');
            process.exit(1);
          }
          const result = await client.deleteSheet(sheetId);
          console.log(JSON.stringify(result));
          break;
        }
        case 'sheet.list': {
          const result = await client.listSheets();
          console.log(JSON.stringify(result, null, 2));
          break;
        }
        case 'sheet.update': {
          const [sheetId, ...updateArgs] = args;
          if (!sheetId) {
            console.error('Usage: sheet.update <sheetId> [--name=<name>] [--color=<color>] [--icon=<icon>] [--pinned=<true|false>]');
            process.exit(1);
          }
          const params: { name?: string; color?: string; icon?: string; pinned?: boolean } = {};
          for (const arg of updateArgs) {
            if (arg.startsWith('--name=')) params.name = arg.slice(7);
            else if (arg.startsWith('--color=')) params.color = arg.slice(8);
            else if (arg.startsWith('--icon=')) params.icon = arg.slice(7);
            else if (arg.startsWith('--pinned=')) params.pinned = arg.slice(9) === 'true';
          }
          const result = await client.updateSheet(sheetId, params);
          console.log(JSON.stringify(result));
          break;
        }
        case 'sheet.moveContainer': {
          const [containerId, targetSheetId] = args;
          if (!containerId || !targetSheetId) {
            console.error('Usage: sheet.moveContainer <containerId> <targetSheetId>');
            process.exit(1);
          }
          const result = await client.moveContainer(containerId, targetSheetId);
          console.log(JSON.stringify(result));
          break;
        }
        default:
          console.error(
            'Usage: CanvasClient.ts <command> [args]\n' +
            'Commands: ping, create [type] [content], stream <id> <text>, delete <id>, snapshot, chat <message>, listen, health\n' +
            'Tab Group Commands: tabgroup.create <id1> <id2> [...], tabgroup.addTab <groupId> <containerId>,\n' +
            '  tabgroup.removeTab <groupId> <containerId>, tabgroup.setActive <groupId> <containerId>\n' +
            'Sheet Commands: sheet.create <name> [color] [icon], sheet.switch <sheetId>, sheet.delete <sheetId>,\n' +
            '  sheet.list, sheet.update <sheetId> [--name=] [--color=] [--icon=] [--pinned=],\n' +
            '  sheet.moveContainer <containerId> <targetSheetId>',
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

