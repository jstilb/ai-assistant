/**
 * Daemon Types
 * Core type definitions for the Kaya daemon system
 */

import type { CronManager, CronJob as CronManagerJob } from '../cron/CronManager';
import type { MessageQueue, QueueStatus as MQQueueStatus } from '../messaging/MessageQueue';
import type { EventBus } from '../messaging/EventBus';
import type { MessageRouter } from '../messaging/MessageRouter';
import type { JobExecutor } from './JobExecutor';
import type { HealthMonitor, HealthCheck } from './HealthMonitor';

// ============================================================================
// Daemon Context - dependency injection for all subsystems
// ============================================================================

export interface DaemonContext {
  cronManager: CronManager;
  messageQueue: MessageQueue;
  messageRouter: MessageRouter;
  eventBus: EventBus;
  jobExecutor: JobExecutor;
  healthMonitor: HealthMonitor;
}

// ============================================================================
// WebSocket Message Protocol
// ============================================================================

// ============================================================================
// Canvas Protocol Types (Phase 2)
// ============================================================================

/** All canvas.* RPC method names */
export type CanvasMethod =
  | 'canvas.container.create'
  | 'canvas.container.update'
  | 'canvas.container.delete'
  | 'canvas.container.stream'
  | 'canvas.container.read'
  | 'canvas.container.event'
  | 'canvas.layout.snapshot'
  | 'canvas.layout.apply'
  | 'canvas.layout.feedback'
  | 'canvas.ping'
  | 'canvas.chat.send'
  | 'canvas.chat.receive'
  | 'canvas.pty.spawn'
  | 'canvas.pty.input'
  | 'canvas.pty.output'
  | 'canvas.pty.resize'
  | 'canvas.pty.kill'
  | 'canvas.pty.exited';

/** Registered container types */
export type ContainerType =
  | 'markdown'
  | 'code'
  | 'terminal'
  | 'image'
  | 'chart'
  | 'form'
  | 'list'
  | 'table'
  | 'pty'
  | 'custom';

/** Container specification — shared between agent and frontend */
export interface ContainerSpec {
  id?: string;
  type: ContainerType;
  title?: string;
  position: { x: number; y: number };
  size?: { width: number; height: number };
  props: Record<string, unknown>;
  zIndex?: number;
  visible?: boolean;
  locked?: boolean;
}

/** Pipe specification (future — for layout schema completeness) */
export interface PipeSpec {
  id: string;
  from: { containerId: string; port: string };
  to: { containerId: string; port: string };
  label?: string;
}

/** Layout delta — single field change for feedback notifications */
export interface LayoutDelta {
  containerId: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

/** JSON-RPC 2.0 payload wrapped in canvas.rpc WSMessage */
export interface CanvasRpcPayload {
  jsonrpc: '2.0';
  id?: string | number;
  method?: CanvasMethod;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type WSMessage =
  | { type: 'status'; payload: DaemonStatus }
  | { type: 'cron.list'; payload: CronJob[] }
  | { type: 'cron.run'; payload: { jobId: string } }
  | { type: 'cron.result'; payload: { jobId: string; success: boolean; output?: string; error?: string } }
  | { type: 'queue.status'; payload: QueueStatus }
  | { type: 'notification'; payload: { message: string; channel: string; timestamp: number } }
  | { type: 'event'; payload: { eventType: string; data: Record<string, unknown>; timestamp: number } }
  | { type: 'health'; payload: HealthCheck }
  | { type: 'ping'; payload: { timestamp: number } }
  | { type: 'pong'; payload: { timestamp: number } }
  | { type: 'error'; payload: { message: string; code?: string } }
  | { type: 'auth.required'; payload: { message: string } }
  | { type: 'auth.success'; payload: { message: string } }
  | { type: 'canvas.rpc'; payload: CanvasRpcPayload };

// Request/Response wrapper for message ID tracking
export interface WSRequest extends WSMessage {
  id?: string;
}

export interface WSResponse extends WSMessage {
  id?: string;
}

// ============================================================================
// Daemon Status
// ============================================================================

export interface DaemonStatus {
  uptime: number;
  connectedClients: number;
  cronJobsRunning: number;
  cronJobsTotal: number;
  queuedTasks: number;
  queueProcessed: number;
  queueFailed: number;
  lastActivity: number;
  health: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
}

// ============================================================================
// Cron Job (wire format for WebSocket/HTTP)
// ============================================================================

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  type: string;
  output: string;
  enabled: boolean;
  lastRun?: number;
  nextRun?: number;
  runCount: number;
  failCount: number;
  lastResult?: {
    success: boolean;
    output?: string;
    error?: string;
    duration: number;
  };
}

// ============================================================================
// Queue Status
// ============================================================================

export interface QueueStatus {
  pending: number;
  active: number;
  completed: number;
  failed: number;
}

// ============================================================================
// WebSocket Client Data
// ============================================================================

export interface WSClientData {
  id: string;
  connectedAt: number;
  lastPing: number;
  authenticated: boolean;
  remoteAddress?: string;
}

// ============================================================================
// WebSocket Server Configuration
// ============================================================================

export interface WSServerConfig {
  port?: number;
  authToken?: string;
  heartbeatInterval?: number;
  heartbeatTimeout?: number;
  maxClients?: number;
}
