#!/usr/bin/env bun
/**
 * AuditLogger - Self-monitoring audit log for AgentMonitor
 *
 * Records all monitoring operations to an append-only JSONL audit trail.
 * Ensures the monitor itself is observable and accountable.
 *
 * Usage:
 *   import { auditLog, AuditEvent } from './AuditLogger.ts';
 *   auditLog({ action: 'evaluate', workflowId: 'abc', details: { ... } });
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

// ============================================================================
// Types
// ============================================================================

export interface AuditEvent {
  timestamp: number;
  action: 'evaluate' | 'collect_trace' | 'emit_trace' | 'generate_report' | 'update_baseline' | 'alert' | 'retro' | 'config_change' | 'error';
  workflowId?: string;
  agentId?: string;
  details: Record<string, unknown>;
  durationMs?: number;
  success: boolean;
  errorMessage?: string;
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME: string = join(homedir(), '.claude');
const AUDIT_PATH: string = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'audit', 'monitor-audit.jsonl');

// ============================================================================
// Core Functions
// ============================================================================

function ensureAuditDir(): void {
  const dir = dirname(AUDIT_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function auditLog(event: Omit<AuditEvent, 'timestamp'>): void {
  ensureAuditDir();

  const fullEvent: AuditEvent = {
    timestamp: Date.now(),
    ...event,
  };

  const line = JSON.stringify(fullEvent) + '\n';
  appendFileSync(AUDIT_PATH, line, 'utf-8');
}

export function readAuditLog(limit: number = 50): AuditEvent[] {
  if (!existsSync(AUDIT_PATH)) {
    return [];
  }

  const content = readFileSync(AUDIT_PATH, 'utf-8').trim();
  if (!content) return [];

  const lines = content.split('\n');
  const events: AuditEvent[] = [];

  // Read from end for most recent
  const start = Math.max(0, lines.length - limit);
  for (let i = start; i < lines.length; i++) {
    try {
      events.push(JSON.parse(lines[i]));
    } catch {
      // Skip malformed lines
    }
  }

  return events;
}

export function getAuditStats(): { totalEvents: number; errorCount: number; lastEvent: AuditEvent | null } {
  const events = readAuditLog(1000);
  const errorCount = events.filter(e => !e.success).length;
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;

  return { totalEvents: events.length, errorCount, lastEvent };
}
