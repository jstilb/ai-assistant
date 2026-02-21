#!/usr/bin/env bun
/**
 * InterventionManager - Intervention orchestrator and policy engine
 *
 * Receives anomaly events from AnomalyDetector, evaluates intervention
 * policies, requests human approval, dispatches intervention signals,
 * and manages the full intervention lifecycle.
 *
 * Usage:
 *   import { createInterventionManager } from './InterventionManager.ts';
 *   const manager = createInterventionManager();
 *   const result = await manager.handleAnomaly(anomaly);
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Anomaly } from './AnomalyDetector.ts';
import { createPauseController } from './PauseController.ts';
import { createThrottleManager } from './ThrottleManager.ts';
import { createFeedbackManager } from './FeedbackManager.ts';
import { createApprovalManager } from './ApprovalManager.ts';
import { createInterventionAuditor, type InterventionAuditEntry } from './InterventionAuditor.ts';
import { auditLog } from './AuditLogger.ts';

// ============================================================================
// Types
// ============================================================================

export interface InterventionPolicy {
  id: string;
  name: string;
  enabled: boolean;
  trigger: {
    anomalyRules: string[];
    severity: ('warning' | 'critical')[];
    minOccurrences: number;
  };
  action: {
    type: 'pause' | 'throttle' | 'feedback';
    parameters: Record<string, unknown>;
  };
  approval: {
    required: boolean;
    timeoutMs: number;
    defaultAction: 'execute' | 'skip' | 'escalate';
  };
  escalation?: {
    afterMs: number;
    toPolicy: string;
  };
}

export interface InterventionConfig {
  intervention: {
    enabled: boolean;
    dryRun: boolean;
    rateLimiting: {
      maxPausesPerWindow: number;
      windowMs: number;
      maxThrottlesPerAgent: number;
    };
    policies: InterventionPolicy[];
    workflowOverrides: {
      allowByDefault: boolean;
      optOutWorkflows: string[];
    };
    safetyLimits: {
      maxConcurrentInterventions: number;
      pauseTimeout: number;
      throttleMaxReduction: number;
    };
  };
}

export interface InterventionResult {
  interventionId: string;
  type: 'pause' | 'throttle' | 'feedback';
  workflowId: string;
  success: boolean;
  message: string;
  approval?: {
    required: boolean;
    status: string;
  };
  dryRun: boolean;
}

export interface InterventionManager {
  handleAnomaly(anomaly: Anomaly): Promise<InterventionResult | null>;
  emergencyStop(): void;
  isEnabled(): boolean;
  isDryRun(): boolean;
  setDryRun(enabled: boolean): void;
  getActiveInterventions(): InterventionAuditEntry[];
  getConfig(): InterventionConfig;
  reloadConfig(): void;
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = join(homedir(), '.claude');
const POLICIES_DIR = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'policies');
const CONFIG_PATH = join(POLICIES_DIR, 'intervention-config.json');
const STATE_DIR = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'state');

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: InterventionConfig = {
  intervention: {
    enabled: true,
    dryRun: false,
    rateLimiting: {
      maxPausesPerWindow: 3,
      windowMs: 300000,
      maxThrottlesPerAgent: 2,
    },
    policies: [
      {
        id: 'critical-pause',
        name: 'Pause on Critical Error Storm',
        enabled: true,
        trigger: {
          anomalyRules: ['error_burst', 'infinite_loop'],
          severity: ['critical'],
          minOccurrences: 1,
        },
        action: { type: 'pause', parameters: {} },
        approval: { required: true, timeoutMs: 120000, defaultAction: 'execute' },
      },
      {
        id: 'token-throttle',
        name: 'Throttle on Token Spike',
        enabled: true,
        trigger: {
          anomalyRules: ['token_spike'],
          severity: ['warning', 'critical'],
          minOccurrences: 2,
        },
        action: {
          type: 'throttle',
          parameters: { metric: 'tokensPerMinute', limitMultiplier: 1.5, baselineSource: 'p95' },
        },
        approval: { required: false, timeoutMs: 0, defaultAction: 'execute' },
        escalation: { afterMs: 600000, toPolicy: 'critical-pause' },
      },
      {
        id: 'error-feedback',
        name: 'Feedback on Error Patterns',
        enabled: true,
        trigger: {
          anomalyRules: ['error_burst'],
          severity: ['warning'],
          minOccurrences: 3,
        },
        action: {
          type: 'feedback',
          parameters: { category: 'error_recovery', cooldownMs: 300000 },
        },
        approval: { required: false, timeoutMs: 0, defaultAction: 'execute' },
      },
    ],
    workflowOverrides: {
      allowByDefault: true,
      optOutWorkflows: [],
    },
    safetyLimits: {
      maxConcurrentInterventions: 5,
      pauseTimeout: 30000,
      throttleMaxReduction: 0.5,
    },
  },
};

// ============================================================================
// Implementation
// ============================================================================

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadConfig(): InterventionConfig {
  if (existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    } catch {
      return DEFAULT_CONFIG;
    }
  }
  return DEFAULT_CONFIG;
}

function loadWorkflowPolicy(workflowId: string): Partial<InterventionPolicy> | null {
  const path = join(POLICIES_DIR, `${workflowId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

let interventionCounter = 0;
function generateInterventionId(): string {
  return `int_${Date.now()}_${++interventionCounter}`;
}

// Rate limiting state
const recentPauses: number[] = [];
const recentThrottlesPerAgent = new Map<string, number>();

// Anomaly occurrence tracking
const anomalyOccurrences = new Map<string, number>();

export function createInterventionManager(): InterventionManager {
  let config = loadConfig();
  let emergencyStopped = false;

  const pauseController = createPauseController();
  const throttleManager = createThrottleManager();
  const feedbackManager = createFeedbackManager();
  const approvalManager = createApprovalManager();
  const auditor = createInterventionAuditor();

  function matchPolicy(anomaly: Anomaly): InterventionPolicy | null {
    for (const policy of config.intervention.policies) {
      if (!policy.enabled) continue;
      if (!policy.trigger.anomalyRules.includes(anomaly.type)) continue;
      if (!policy.trigger.severity.includes(anomaly.severity)) continue;

      // Check occurrence count
      const key = `${anomaly.workflowId}:${anomaly.type}`;
      const occurrences = (anomalyOccurrences.get(key) || 0) + 1;
      anomalyOccurrences.set(key, occurrences);

      if (occurrences < policy.trigger.minOccurrences) continue;

      return policy;
    }
    return null;
  }

  function checkRateLimit(type: string, agentId?: string): boolean {
    const now = Date.now();

    if (type === 'pause') {
      // Clean old entries
      while (recentPauses.length > 0 && recentPauses[0] < now - config.intervention.rateLimiting.windowMs) {
        recentPauses.shift();
      }
      return recentPauses.length < config.intervention.rateLimiting.maxPausesPerWindow;
    }

    if (type === 'throttle' && agentId) {
      const count = recentThrottlesPerAgent.get(agentId) || 0;
      return count < config.intervention.rateLimiting.maxThrottlesPerAgent;
    }

    return true;
  }

  function checkWorkflowOptOut(workflowId: string, type: string): boolean {
    // Check global opt-out
    if (config.intervention.workflowOverrides.optOutWorkflows.includes(workflowId)) {
      if (type === 'pause') return false;
    }

    // Check per-workflow policy
    const wfPolicy = loadWorkflowPolicy(workflowId);
    if (wfPolicy && (wfPolicy as Record<string, unknown>).interventionPolicy) {
      const ip = (wfPolicy as Record<string, unknown>).interventionPolicy as Record<string, boolean>;
      if (type === 'pause' && ip.allowPause === false) return false;
      if (type === 'throttle' && ip.allowThrottle === false) return false;
      if (type === 'feedback' && ip.allowFeedback === false) return false;
    }

    return true;
  }

  return {
    async handleAnomaly(anomaly: Anomaly): Promise<InterventionResult | null> {
      if (emergencyStopped || !config.intervention.enabled) return null;

      const policy = matchPolicy(anomaly);
      if (!policy) return null;

      const interventionId = generateInterventionId();
      const { type } = policy.action;

      // Check workflow opt-out
      if (!checkWorkflowOptOut(anomaly.workflowId, type)) {
        auditLog({
          action: 'intervention_skipped',
          workflowId: anomaly.workflowId,
          details: { reason: 'workflow_opted_out', type, policy: policy.id },
          success: true,
        });
        return null;
      }

      // Check rate limit
      if (!checkRateLimit(type, anomaly.agentId)) {
        auditLog({
          action: 'intervention_rate_limited',
          workflowId: anomaly.workflowId,
          details: { type, policy: policy.id },
          success: true,
        });
        return null;
      }

      // Build audit entry
      const auditEntry: InterventionAuditEntry = {
        interventionId,
        timestamp: Date.now(),
        workflowId: anomaly.workflowId,
        agentId: anomaly.agentId,
        type,
        trigger: {
          anomaly: anomaly.type,
          severity: anomaly.severity,
          evidence: anomaly.evidence,
        },
        policy: policy.id,
        approval: {
          required: policy.approval.required,
          status: 'pending',
        },
        execution: { status: 'pending' },
        outcome: { success: false, message: 'pending' },
      };

      // Request approval if required
      let approved = !policy.approval.required;
      if (policy.approval.required && !config.intervention.dryRun) {
        const approvalResult = await approvalManager.requestApproval({
          interventionId,
          workflowId: anomaly.workflowId,
          agentId: anomaly.agentId,
          interventionType: type,
          severity: anomaly.severity,
          description: anomaly.message,
          evidence: anomaly.evidence,
          requestedAt: Date.now(),
        }, policy.approval.timeoutMs);

        auditEntry.approval = {
          required: true,
          status: approvalResult.decision === 'approved' ? 'approved' :
            approvalResult.decision === 'denied' ? 'denied' :
              approvalResult.decision === 'snoozed' ? 'snoozed' : 'timeout',
          approvedBy: approvalResult.decidedBy,
          approvedAt: approvalResult.decidedAt,
        };

        if (approvalResult.decision === 'approved') {
          approved = true;
        } else if (approvalResult.decision === 'timeout') {
          approved = policy.approval.defaultAction === 'execute';
        } else {
          approved = false;
        }
      }

      if (!approved) {
        auditEntry.execution = { status: 'completed', completedAt: Date.now() };
        auditEntry.outcome = { success: false, message: 'Not approved' };
        auditor.logIntervention(auditEntry);
        return {
          interventionId,
          type,
          workflowId: anomaly.workflowId,
          success: false,
          message: 'Intervention not approved',
          approval: { required: true, status: auditEntry.approval!.status },
          dryRun: false,
        };
      }

      // Dry run mode — log but don't execute
      if (config.intervention.dryRun) {
        auditEntry.execution = { status: 'dry_run', completedAt: Date.now() };
        auditEntry.outcome = { success: true, message: 'Dry run — no action taken' };
        auditor.logIntervention(auditEntry);
        return {
          interventionId,
          type,
          workflowId: anomaly.workflowId,
          success: true,
          message: 'Dry run — no action taken',
          dryRun: true,
        };
      }

      // Execute intervention
      auditEntry.execution.status = 'executing';
      auditEntry.execution.startedAt = Date.now();

      try {
        let message = '';

        switch (type) {
          case 'pause': {
            const result = await pauseController.pause(anomaly.workflowId, anomaly.message, interventionId);
            if (result.success) {
              recentPauses.push(Date.now());
              message = `Workflow ${anomaly.workflowId} paused successfully`;
            } else {
              message = result.error || 'Pause failed';
              throw new Error(message);
            }
            break;
          }

          case 'throttle': {
            const params = policy.action.parameters;
            const result = throttleManager.applyThrottle({
              agentId: anomaly.agentId || anomaly.workflowId,
              metric: (params.metric as 'tokensPerMinute') || 'tokensPerMinute',
              limit: (params.limitValue as number) || 15000,
              interventionId,
            });
            if (result.success) {
              const agentId = anomaly.agentId || anomaly.workflowId;
              recentThrottlesPerAgent.set(agentId, (recentThrottlesPerAgent.get(agentId) || 0) + 1);
              message = `Throttle applied to ${agentId}: ${result.appliedLimit}`;
            } else {
              message = result.error || 'Throttle failed';
              throw new Error(message);
            }
            break;
          }

          case 'feedback': {
            // Feedback doesn't need full trace analysis — generate targeted feedback from anomaly
            const fbMessage = {
              timestamp: Date.now(),
              feedbackId: `fb_${interventionId}`,
              category: (policy.action.parameters.category as string) || 'error_recovery',
              severity: 'warning' as const,
              agentId: anomaly.agentId || anomaly.workflowId,
              pattern: anomaly.type,
              suggestion: `Anomaly detected: ${anomaly.message}. Review recent actions and adjust approach.`,
              evidence: anomaly.evidence,
            };
            feedbackManager.deliverFeedback(fbMessage);
            message = `Feedback delivered to ${fbMessage.agentId}`;
            break;
          }
        }

        auditEntry.execution = {
          status: 'completed',
          startedAt: auditEntry.execution.startedAt,
          completedAt: Date.now(),
        };
        auditEntry.outcome = { success: true, message };
        auditor.logIntervention(auditEntry);

        return {
          interventionId,
          type,
          workflowId: anomaly.workflowId,
          success: true,
          message,
          approval: policy.approval.required
            ? { required: true, status: 'approved' }
            : undefined,
          dryRun: false,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        auditEntry.execution = {
          status: 'failed',
          startedAt: auditEntry.execution.startedAt,
          completedAt: Date.now(),
          error: errMsg,
        };
        auditEntry.outcome = { success: false, message: errMsg };
        auditor.logIntervention(auditEntry);

        return {
          interventionId,
          type,
          workflowId: anomaly.workflowId,
          success: false,
          message: errMsg,
          dryRun: false,
        };
      }
    },

    emergencyStop(): void {
      emergencyStopped = true;

      // Cancel all pending approvals
      const pending = approvalManager.getPendingApprovals();
      for (const p of pending) {
        approvalManager.denyViaCLI(p.interventionId, 'Emergency stop');
      }

      // Log emergency stop
      const auditEntry: InterventionAuditEntry = {
        interventionId: generateInterventionId(),
        timestamp: Date.now(),
        workflowId: 'system',
        type: 'emergency_stop',
        trigger: { anomaly: 'manual', severity: 'critical' },
        execution: { status: 'completed', completedAt: Date.now() },
        outcome: {
          success: true,
          message: `Emergency stop: cancelled ${pending.length} pending approvals, disabled all interventions`,
        },
      };
      auditor.logIntervention(auditEntry);

      auditLog({
        action: 'emergency_stop',
        details: { cancelledApprovals: pending.length },
        success: true,
      });
    },

    isEnabled(): boolean {
      return config.intervention.enabled && !emergencyStopped;
    },

    isDryRun(): boolean {
      return config.intervention.dryRun;
    },

    setDryRun(enabled: boolean): void {
      config.intervention.dryRun = enabled;

      // Persist to config
      ensureDir(POLICIES_DIR);
      const current = loadConfig();
      current.intervention.dryRun = enabled;
      writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2));
    },

    getActiveInterventions(): InterventionAuditEntry[] {
      return auditor.query({}).filter(e =>
        e.execution.status === 'executing' ||
        (e.type === 'pause' && e.outcome.success && !e.outcome.rollback) ||
        (e.type === 'throttle' && e.outcome.success && !e.outcome.rollback)
      );
    },

    getConfig(): InterventionConfig {
      return config;
    },

    reloadConfig(): void {
      config = loadConfig();
    },
  };
}
