#!/usr/bin/env bun
/**
 * AlertManager - Voice notifications and JSONL alerts
 *
 * Sends voice notifications via the Kaya voice server and logs alerts
 * to an append-only JSONL file for audit and review.
 *
 * Usage:
 *   import { sendAlert, checkAlerts } from './AlertManager.ts';
 *   sendAlert({ severity: 'critical', message: 'Agent failed', workflowId: 'wf1' });
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { PipelineResult } from './EvaluatorPipeline.ts';
import { auditLog } from './AuditLogger.ts';
import { emitNotification } from '../../../../lib/core/SkillIntegrationBridge';

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

const KAYA_HOME: string = join(homedir(), '.claude');
const ALERTS_PATH: string = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'audit', 'alerts.jsonl');
const VOICE_SERVER_URL = 'http://localhost:8888/notify';

const DEFAULT_CONFIG: AlertConfig = {
  voiceNotifications: true,
  jsonlLogging: true,
  criticalThreshold: 30,
  warningThreshold: 50,
};

// ============================================================================
// Core Functions
// ============================================================================

function ensureAlertDir(): void {
  const dir = dirname(ALERTS_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function logAlert(alert: Alert): void {
  ensureAlertDir();
  const line = JSON.stringify(alert) + '\n';
  appendFileSync(ALERTS_PATH, line, 'utf-8');
}

function sendVoiceNotification(message: string, severity: 'critical' | 'warning'): void {
  try {
    emitNotification(message, {
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

export function processAlerts(result: PipelineResult, config?: Partial<AlertConfig>): Alert[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const alerts: Alert[] = [];

  // Overall score alerts
  if (result.overallScore <= cfg.criticalThreshold) {
    sendAlert('critical', result.workflowId, `Workflow score critically low: ${result.overallScore}/100`, { score: result.overallScore }, cfg);
    alerts.push({
      timestamp: Date.now(),
      severity: 'critical',
      workflowId: result.workflowId,
      message: `Workflow score critically low: ${result.overallScore}/100`,
      score: result.overallScore,
      acknowledged: false,
    });
  } else if (result.overallScore <= cfg.warningThreshold) {
    sendAlert('warning', result.workflowId, `Workflow score below threshold: ${result.overallScore}/100`, { score: result.overallScore }, cfg);
    alerts.push({
      timestamp: Date.now(),
      severity: 'warning',
      workflowId: result.workflowId,
      message: `Workflow score below threshold: ${result.overallScore}/100`,
      score: result.overallScore,
      acknowledged: false,
    });
  }

  // Per-evaluator critical findings
  for (const evalResult of result.evaluatorResults) {
    const criticalFindings = evalResult.findings.filter(f => f.severity === 'critical');
    for (const finding of criticalFindings) {
      sendAlert('critical', result.workflowId, `[${evalResult.name}] ${finding.message}`, {
        score: evalResult.score,
        evaluator: evalResult.name,
      }, cfg);
      alerts.push({
        timestamp: Date.now(),
        severity: 'critical',
        workflowId: result.workflowId,
        message: `[${evalResult.name}] ${finding.message}`,
        score: evalResult.score,
        evaluator: evalResult.name,
        acknowledged: false,
      });
    }
  }

  return alerts;
}

export function getRecentAlerts(limit: number = 20): Alert[] {
  if (!existsSync(ALERTS_PATH)) return [];

  const content = readFileSync(ALERTS_PATH, 'utf-8').trim();
  if (!content) return [];

  const lines = content.split('\n');
  const alerts: Alert[] = [];

  const start = Math.max(0, lines.length - limit);
  for (let i = start; i < lines.length; i++) {
    try {
      alerts.push(JSON.parse(lines[i]));
    } catch {
      // Skip malformed lines
    }
  }

  return alerts;
}
