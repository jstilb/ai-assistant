/**
 * Monitoring.ts — Shared types for the AgentMonitor subsystem.
 *
 * Usage:
 *   import { TraceEvent, AlertEntry } from 'lib/interfaces/Monitoring';
 */

export interface TraceEvent {
  id?: string;
  sessionId: string;
  timestamp: string;
  event: string;
  agentId?: string;
  payload?: Record<string, unknown>;
  durationMs?: number;
}

export interface AnomalyRecord {
  id: string;
  detectedAt: string;
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  sessionId?: string;
  resolved?: boolean;
  resolvedAt?: string;
}

export interface AlertEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warning' | 'error' | 'critical';
  message: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface PipelineLockState {
  locked: boolean;
  lockedAt?: string;
  lockedBy?: string;
  sessionId?: string;
  reason?: string;
}
