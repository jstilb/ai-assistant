#!/usr/bin/env bun
/**
 * ApprovalManager - Human-in-the-loop approval for interventions
 *
 * Records approval requests to the JSONL notification log, handles CLI
 * override approvals, manages timeout logic with safe defaults, and
 * supports snooze.
 *
 * Usage:
 *   import { createApprovalManager } from './ApprovalManager.ts';
 *   const manager = createApprovalManager();
 *   const result = await manager.requestApproval(interventionId, prompt, config);
 */

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { getKayaHome } from '../../../../lib/core/KayaHome.ts';
import { createStateManager } from '../../../../lib/core/StateManager.ts';
import { createAppendLog } from '../../../../lib/core/AppendLog.ts';
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
  evidence: z.record(z.string(), z.unknown()),
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
  /** Max concurrent pending approvals */
  maxPendingApprovals: number;
}

export interface ApprovalManager {
  requestApproval(request: ApprovalRequest, timeoutMs?: number): Promise<ApprovalResult>;
  approveViaCLI(interventionId: string, approvedBy?: string): Promise<ApprovalResult | null>;
  denyViaCLI(interventionId: string, reason?: string): Promise<ApprovalResult | null>;
  snoozeViaCLI(interventionId: string, durationMs: number): Promise<ApprovalResult | null>;
  getPendingApprovals(): Promise<ApprovalRequest[]>;
  getApprovalHistory(limit?: number): ApprovalResponse[];
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = getKayaHome();
const STATE_DIR = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'state');
const NOTIFICATIONS_PATH = join(KAYA_HOME, 'MEMORY', 'NOTIFICATIONS', 'notifications.jsonl');
const PENDING_FILE = join(STATE_DIR, 'pending-approvals.json');
const APPROVAL_HISTORY = join(STATE_DIR, 'approval-history.jsonl');

const DEFAULT_CONFIG: ApprovalManagerConfig = {
  defaultTimeoutMs: 120000,
  defaultOnTimeout: 'execute',
  maxPendingApprovals: 10,
};

// ============================================================================
// State Manager
// ============================================================================

const pendingApprovalsStateManager = createStateManager({
  path: PENDING_FILE,
  schema: PendingApprovalsSchema,
  defaults: { pending: [], updatedAt: 0 },
});

// ISC AppendLog seam: route JSONL writes through the shared append-only log
// abstraction instead of raw appendFileSync. One instance per path, reused.
const approvalHistoryLog = createAppendLog(APPROVAL_HISTORY);
const notificationsLog = createAppendLog(NOTIFICATIONS_PATH);

// ============================================================================
// Implementation
// ============================================================================

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

async function loadPending(): Promise<ApprovalRequest[]> {
  try {
    const state = await pendingApprovalsStateManager.load();
    return state.pending;
  } catch {
    return [];
  }
}

async function savePending(pending: ApprovalRequest[]): Promise<void> {
  await pendingApprovalsStateManager.save({ pending, updatedAt: Date.now() });
}

function recordResponse(response: ApprovalResponse): void {
  ensureDir(STATE_DIR);
  approvalHistoryLog.append(response);
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
  notificationsLog.append(notification);
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
      const pending = await loadPending();
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
      await savePending(pending);

      sendJSONLNotification(request);

      auditLog({
        action: 'approval_requested',
        workflowId: request.workflowId,
        details: {
          interventionId: request.interventionId,
          type: request.interventionType,
          timeout,
        },
        success: true,
      });

      // Poll for CLI-based response
      const startTime = Date.now();
      while (Date.now() - startTime < timeout) {
        // Check if response was filed via CLI
        const currentPending = await loadPending();
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
      const currentList = await loadPending();
      const updated = currentList.filter(p => p.interventionId !== request.interventionId);
      await savePending(updated);

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

    async approveViaCLI(interventionId: string, approvedBy?: string): Promise<ApprovalResult | null> {
      const pending = await loadPending();
      const idx = pending.findIndex(p => p.interventionId === interventionId);
      if (idx < 0) return null;

      const request = pending[idx];
      pending.splice(idx, 1);
      await savePending(pending);

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

    async denyViaCLI(interventionId: string, reason?: string): Promise<ApprovalResult | null> {
      const pending = await loadPending();
      const idx = pending.findIndex(p => p.interventionId === interventionId);
      if (idx < 0) return null;

      const request = pending[idx];
      pending.splice(idx, 1);
      await savePending(pending);

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

    async snoozeViaCLI(interventionId: string, durationMs: number): Promise<ApprovalResult | null> {
      const pending = await loadPending();
      const idx = pending.findIndex(p => p.interventionId === interventionId);
      if (idx < 0) return null;

      const request = pending[idx];
      pending.splice(idx, 1);
      await savePending(pending);

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

    async getPendingApprovals(): Promise<ApprovalRequest[]> {
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
