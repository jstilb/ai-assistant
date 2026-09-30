#!/usr/bin/env bun
/**
 * AlertManager - NotificationService notifications and JSONL alerts
 *
 * Sends critical/warning alerts through NotificationService (default channel:
 * log — the local voice server was removed 2026-09-29) and logs alerts to an
 * append-only JSONL file for audit and review.
 *
 * Usage:
 *   import { sendAlert, checkAlerts } from './AlertManager.ts';
 *   sendAlert({ severity: 'critical', message: 'Agent failed', workflowId: 'wf1' });
 */

import { join } from 'path';
import { auditLog } from './AuditLogger.ts';
import { notifySync } from '../../../../lib/core/NotificationService';
import { createAppendLog } from '../../../../lib/core/AppendLog.ts';
import { getKayaHome } from '../../../../lib/core/KayaHome.ts';

// ============================================================================
// Types
// ============================================================================

export interface Alert {
  timestamp: number;
  severity: 'info' | 'warning' | 'critical';
  workflowId: string;
  message: string;
  score?: number;
  evaluator?: string;
  acknowledged: boolean;
}

export interface AlertConfig {
  voiceNotifications: boolean;
  jsonlLogging: boolean;
  criticalThreshold: number;
  warningThreshold: number;
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME: string = getKayaHome();
const ALERTS_PATH: string = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'audit', 'alerts.jsonl');

// ISC 601: route through the AppendLog seam (the former standalone JSONL
// append/read helper module was folded in here — S6).
// maxSizeBytes disabled — the prior helper never rotated alerts.jsonl, so
// this preserves the unbounded-growth on-disk behavior byte-for-byte.
const alertsLog = createAppendLog(ALERTS_PATH, { maxSizeBytes: Number.MAX_SAFE_INTEGER });

const DEFAULT_CONFIG: AlertConfig = {
  voiceNotifications: true,
  jsonlLogging: true,
  criticalThreshold: 30,
  warningThreshold: 50,
};

// ============================================================================
// Core Functions
// ============================================================================

function logAlert(alert: Alert): void {
  // ISC 601: use the AppendLog seam (handles dir creation atomically)
  alertsLog.append(alert);
}

function sendVoiceNotification(message: string, severity: 'critical' | 'warning'): void {
  try {
    notifySync(message, {
      agentName: 'AgentMonitor Alert',
      priority: severity === 'critical' ? 'critical' : 'high',
      fallback: true,
    });
  } catch (err: unknown) {
    // Voice notification is fire-and-forget, never block on failure
    // Log fallback for audit
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[AlertManager] Voice server unavailable, using JSONL fallback:', errMsg);
  }
}

export function sendAlert(
  severity: Alert['severity'],
  workflowId: string,
  message: string,
  options?: { score?: number; evaluator?: string },
  config?: Partial<AlertConfig>
): void {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const alert: Alert = {
    timestamp: Date.now(),
    severity,
    workflowId,
    message,
    score: options?.score,
    evaluator: options?.evaluator,
    acknowledged: false,
  };

  // Log to JSONL
  if (cfg.jsonlLogging) {
    logAlert(alert);
  }

  // Send voice notification for critical/warning alerts
  if (cfg.voiceNotifications && (severity === 'critical' || severity === 'warning')) {
    const voiceMsg = severity === 'critical'
      ? `Critical alert. Agent monitor detected issue. ${message.slice(0, 80)}`
      : `Warning. Agent monitor. ${message.slice(0, 80)}`;
    sendVoiceNotification(voiceMsg, severity);
  }

  auditLog({
    action: 'alert',
    workflowId,
    details: { severity, message, score: options?.score },
    success: true,
  });
}

export function getRecentAlerts(limit: number = 20): Alert[] {
  // ISC 601: use the AppendLog seam to tail the alert log
  return alertsLog.readLastN<Alert>(limit);
}


export function ackAll(): number {
  const alerts = alertsLog.readLastN<Alert>(1000);
  const unacked = alerts.filter(a => !a.acknowledged);
  if (unacked.length === 0) return 0;
  const { writeFileSync: wfs } = require('fs');
  const lines = alerts.map(a => JSON.stringify({ ...a, acknowledged: true })).join('\n') + '\n';
  wfs(ALERTS_PATH, lines);
  return unacked.length;
}
