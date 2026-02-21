/**
 * Kaya Daemon - Unified daemon subsystem
 *
 * Public API exports for the daemon system
 */

// Types
export type {
  WSMessage,
  WSRequest,
  WSResponse,
  WSClientData,
  WSServerConfig,
  DaemonStatus,
  DaemonContext,
  CronJob,
  QueueStatus,
} from './types';

// WebSocket Server
export {
  createWebSocketServer,
  setDaemonContext,
  broadcast,
  sendToClient,
  getConnectedClients,
  getAuthenticatedClients,
  getClientList,
  getHealthStatus,
  shutdown,
  stopHeartbeat,
} from './WebSocketServer';

// Job Executor
export { createJobExecutor } from './JobExecutor';
export type { JobExecutor, JobExecutorConfig } from './JobExecutor';

// Health Monitor
export { createHealthMonitor } from './HealthMonitor';
export type { HealthMonitor, HealthMonitorConfig, HealthCheck, HealthStatus } from './HealthMonitor';
