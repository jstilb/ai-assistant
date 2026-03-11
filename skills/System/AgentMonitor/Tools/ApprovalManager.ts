#!/usr/bin/env bun
/**
 * ApprovalManager - Human-in-the-loop approval for interventions
 *
 * Sends voice prompts via VoiceServer, handles CLI override approvals,
 * manages timeout logic with safe defaults, and supports snooze.
 * Falls back to JSONL notification when VoiceServer is unavailable.
 *
 * Usage:
 *   import { createApprovalManager } from './ApprovalManager.ts';
 *   const manager = createApprovalManager();
 *   const result = await manager.requestApproval(interventionId, prompt, config);
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { z } from 'zod';
import { auditLog } from './AuditLogger.ts';

// ============================================================================
// Types
// ============================================================================

export type ApprovalDecision = 'approved' | 'denied' | 'snoozed' | 'timeout';

export interface ApprovalRequest {
  interventionId: string;
  workflowId: string;
  agentId?: string;
  interventionType: 'pause' | 'throttle' | 'feedback';
  severity: 'warning' | 'critical';
  description: string;
  evidence: Record<string, unknown>;
  requestedAt: number;
}

export interface ApprovalResponse {
  interventionId: string;
  decision: ApprovalDecision;
  decidedBy: string;
  decidedAt: number;
  snoozeDurationMs?: number;
  reason?: string;
}

// ============================================================================
// Schemas
// ============================================================================

const ApprovalRequestSchema = z.object({
  interventionId: z.string(),
  workflowId: z.string(),
  agentId: z.string().optional(),
  interventionType: z.enum(['pause', 'throttle', 'feedback']),
  severity: z.enum(['warning', 'critical']),
  description: z.string(),
  evidence: z.record(z.unknown()),
  requestedAt: z.number(),
});

const PendingApprovalsSchema = z.object({
  pending: z.array(ApprovalRequestSchema),
  updatedAt: z.number(),
});

export interface ApprovalResult {
  decision: ApprovalDecision;
  interventionId: string;
  decidedBy: string;
  decidedAt: number;
  snoozeDurationMs?: number;
}

export interface ApprovalManagerConfig {
  /** Default timeout for approval requests (ms) */
  defaultTimeoutMs: number;
  /** Default action when approval times out */
  defaultOnTimeout: 'execute' | 'skip' | 'escalate';
  /** VoiceServer URL */
  voiceServerUrl: string;
  /** Max concurrent pending approvals */
  maxPendingApprovals: number;
}

export interface ApprovalManager {
  requestApproval(request: ApprovalRequest, timeoutMs?: number): Promise<ApprovalResult>;
  approveViaCLI(interventionId: string, approvedBy?: string): ApprovalResult | null;
  denyViaCLI(interventionId: string, reason?: string): ApprovalResult | null;
  snoozeViaCLI(interventionId: string, durationMs: number): ApprovalResult | null;
  getPendingApprovals(): ApprovalRequest[];
  getApprovalHistory(limit?: number): ApprovalResponse[];
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = join(homedir(), '.claude');
const STATE_DIR = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'state');
const NOTIFICATIONS_PATH = join(KAYA_HOME, 'MEMORY', 'NOTIFICATIONS', 'notifications.jsonl');
const PENDING_FILE = join(STATE_DIR, 'pending-approvals.json');
const APPROVAL_HISTORY = join(STATE_DIR, 'approval-history.jsonl');

const DEFAULT_CONFIG: ApprovalManagerConfig = {
  defaultTimeoutMs: 120000,
  defaultOnTimeout: 'execute',
  voiceServerUrl: 'http://localhost:8888/notify',
  maxPendingApprovals: 10,
};

// ============================================================================
// Implementation
// ============================================================================

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function atomicWrite(filePath: string, data: unknown): void {
  ensureDir(require('path').dirname(filePath));
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  const { renameSync } = require('fs');
  renameSync(tmpPath, filePath);
}

function loadPending(): ApprovalRequest[] {
  if (!existsSync(PENDING_FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(PENDING_FILE, 'utf-8'));
    const validated = PendingApprovalsSchema.parse(raw);
    return validated.pending;
  } catch {
    return [];
  }
}

function savePending(pending: ApprovalRequest[]): void {
  atomicWrite(PENDING_FILE, { pending, updatedAt: Date.now() });
}

function recordResponse(response: ApprovalResponse): void {
  ensureDir(STATE_DIR);
  appendFileSync(APPROVAL_HISTORY, JSON.stringify(response) + '\n', 'utf-8');
}

function sendVoicePrompt(message: string, url: string): boolean {
  try {
    const payload = JSON.stringify({
      message,
      title: 'Intervention Approval',
    });
    execSync(
      `curl -s -X POST ${url} -H "Content-Type: application/json" -d '${payload.replace(/'/g, "\\'")}' > /dev/null 2>&1`,
      { timeout: 5000 }
    );
    return true;
  } catch {
    return false;
  }
}

function sendJSONLNotification(request: ApprovalRequest): void {
  ensureDir(require('path').dirname(NOTIFICATIONS_PATH));
  const notification = {
    timestamp: Date.now(),
    type: 'intervention_approval',
    severity: request.severity,
    message: `Intervention approval needed: ${request.interventionType} on workflow ${request.workflowId}`,
    details: {
      interventionId: request.interventionId,
      description: request.description,
    },
  };
  appendFileSync(NOTIFICATIONS_PATH, JSON.stringify(notification) + '\n', 'utf-8');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createApprovalManager(config?: Partial<ApprovalManagerConfig>): ApprovalManager {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return {
    async requestApproval(request: ApprovalRequest, timeoutMs?: number): Promise<ApprovalResult> {
      const timeout = timeoutMs || cfg.defaultTimeoutMs;

      // Add to pending
      const pending = loadPending();
      if (pending.length >= cfg.maxPendingApprovals) {
        // Auto-deny oldest to make room
        const oldest = pending.shift()!;
        const denyResponse: ApprovalResponse = {
          interventionId: oldest.interventionId,
          decision: 'denied',
          decidedBy: 'system:overflow',
          decidedAt: Date.now(),
          reason: 'Approval queue overflow',
        };
        recordResponse(denyResponse);
      }

      pending.push(request);
      savePending(pending);

      // Build voice prompt
      const voiceText = buildVoicePrompt(request);

      // Try voice notification first
      const voiceSent = sendVoicePrompt(voiceText, cfg.voiceServerUrl);

      // If voice failed, fall back to JSONL
      if (!voiceSent) {
        sendJSONLNotification(request);
      }

      auditLog({
        action: 'approval_requested',
        workflowId: request.workflowId,
        details: {
          interventionId: request.interventionId,
          type: request.interventionType,
          voiceSent,
          timeout,
        },
        success: true,
      });

      // Poll for CLI-based response
      const startTime = Date.now();
      while (Date.now() - startTime < timeout) {
        // Check if response was filed via CLI
        const currentPending = loadPending();
        const stillPending = currentPending.find(p => p.interventionId === request.interventionId);

        if (!stillPending) {
          // Response was filed — read from history
          const history = this.getApprovalHistory(5);
          const response = history.find(h => h.interventionId === request.interventionId);
          if (response) {
            return {
              decision: response.decision,
              interventionId: response.interventionId,
              decidedBy: response.decidedBy,
              decidedAt: response.decidedAt,
              snoozeDurationMs: response.snoozeDurationMs,
            };
          }
        }

        await sleep(2000);
      }

      // Timeout — apply default action
      const timeoutResult: ApprovalResult = {
        decision: 'timeout',
        interventionId: request.interventionId,
        decidedBy: 'system:timeout',
        decidedAt: Date.now(),
      };

      // Remove from pending
      const updated = loadPending().filter(p => p.interventionId !== request.interventionId);
      savePending(updated);

      const response: ApprovalResponse = {
        interventionId: request.interventionId,
        decision: 'timeout',
        decidedBy: 'system:timeout',
        decidedAt: Date.now(),
      };
      recordResponse(response);

      auditLog({
        action: 'approval_timeout',
        workflowId: request.workflowId,
        details: {
          interventionId: request.interventionId,
          defaultAction: cfg.defaultOnTimeout,
          timeoutMs: timeout,
        },
        success: true,
      });

      return timeoutResult;
    },

    approveViaCLI(interventionId: string, approvedBy?: string): ApprovalResult | null {
      const pending = loadPending();
      const idx = pending.findIndex(p => p.interventionId === interventionId);
      if (idx < 0) return null;

      const request = pending[idx];
      pending.splice(idx, 1);
      savePending(pending);

      const response: ApprovalResponse = {
        interventionId,
        decision: 'approved',
        decidedBy: approvedBy || 'cli:manual',
        decidedAt: Date.now(),
      };
      recordResponse(response);

      auditLog({
        action: 'approval_granted',
        workflowId: request.workflowId,
        details: { interventionId, approvedBy: response.decidedBy },
        success: true,
      });

      return {
        decision: 'approved',
        interventionId,
        decidedBy: response.decidedBy,
        decidedAt: response.decidedAt,
      };
    },

    denyViaCLI(interventionId: string, reason?: string): ApprovalResult | null {
      const pending = loadPending();
      const idx = pending.findIndex(p => p.interventionId === interventionId);
      if (idx < 0) return null;

      const request = pending[idx];
      pending.splice(idx, 1);
      savePending(pending);

      const response: ApprovalResponse = {
        interventionId,
        decision: 'denied',
        decidedBy: 'cli:manual',
        decidedAt: Date.now(),
        reason,
      };
      recordResponse(response);

      auditLog({
        action: 'approval_denied',
        workflowId: request.workflowId,
        details: { interventionId, reason },
        success: true,
      });

      return {
        decision: 'denied',
        interventionId,
        decidedBy: 'cli:manual',
        decidedAt: response.decidedAt,
      };
    },

    snoozeViaCLI(interventionId: string, durationMs: number): ApprovalResult | null {
      const pending = loadPending();
      const idx = pending.findIndex(p => p.interventionId === interventionId);
      if (idx < 0) return null;

      const request = pending[idx];
      pending.splice(idx, 1);
      savePending(pending);

      const response: ApprovalResponse = {
        interventionId,
        decision: 'snoozed',
        decidedBy: 'cli:manual',
        decidedAt: Date.now(),
        snoozeDurationMs: durationMs,
      };
      recordResponse(response);

      auditLog({
        action: 'approval_snoozed',
        workflowId: request.workflowId,
        details: { interventionId, snoozeDurationMs: durationMs },
        success: true,
      });

      return {
        decision: 'snoozed',
        interventionId,
        decidedBy: 'cli:manual',
        decidedAt: response.decidedAt,
        snoozeDurationMs: durationMs,
      };
    },

    getPendingApprovals(): ApprovalRequest[] {
      return loadPending();
    },

    getApprovalHistory(limit: number = 50): ApprovalResponse[] {
      if (!existsSync(APPROVAL_HISTORY)) return [];

      const content = readFileSync(APPROVAL_HISTORY, 'utf-8').trim();
      if (!content) return [];

      const lines = content.split('\n');
      const responses: ApprovalResponse[] = [];
      const start = Math.max(0, lines.length - limit);

      for (let i = start; i < lines.length; i++) {
        try {
          responses.push(JSON.parse(lines[i]));
        } catch {
          // Skip malformed
        }
      }

      return responses;
    },
  };
}

// ============================================================================
// Voice Prompt Builder
// ============================================================================

function buildVoicePrompt(request: ApprovalRequest): string {
  const typeLabel = request.interventionType === 'pause' ? 'pause workflow' :
    request.interventionType === 'throttle' ? 'throttle resources' : 'send feedback';

  return `Agent monitoring alert: Workflow "${request.workflowId}" requires intervention. ` +
    `Severity: ${request.severity}. Recommended action: ${typeLabel}. ` +
    `${request.description.slice(0, 100)}. ` +
    `Say "approve" to proceed, "deny" to skip, or "snooze 5 minutes" to delay.`;
}
