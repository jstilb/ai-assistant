#!/usr/bin/env bun
/**
 * AnomalyDetector - Real-time anomaly detection for agent workflows
 *
 * Detects resource spikes, error patterns, infinite loops, and other
 * anomalies from streaming trace data. Triggers alerts within 2 seconds
 * of threshold breach.
 *
 * Usage:
 *   import { createAnomalyDetector } from './AnomalyDetector.ts';
 *   const detector = createAnomalyDetector(config);
 *   detector.ingest(trace);
 *   const anomalies = detector.getActiveAnomalies();
 */

import type { AgentTrace } from './TraceCollector.ts';
import type { Finding } from './evaluators/ResourceEfficiencyEvaluator.ts';
import { sendAlert } from './AlertManager.ts';
import { auditLog } from './AuditLogger.ts';
import { emitEvalSignal, emitNotification } from '../../CORE/Tools/SkillIntegrationBridge';

// ============================================================================
// Types
// ============================================================================

export interface AnomalyDetectorConfig {
  /** Max token usage per sliding window before alerting */
  tokenSpikeThreshold: number;
  /** Window size in ms for token spike detection */
  tokenSpikeWindowMs: number;
  /** Max errors in window before alerting */
  errorBurstThreshold: number;
  /** Window size in ms for error burst detection */
  errorBurstWindowMs: number;
  /** Max identical tool calls in sequence (infinite loop detection) */
  infiniteLoopThreshold: number;
  /** Window size for loop detection (number of events) */
  infiniteLoopWindow: number;
  /** Max time without any trace from a workflow before stale alert (ms) */
  staleWorkflowThresholdMs: number;
  /** Minimum events/second sustained for high-load alert */
  highLoadEventsPerSecond: number;
  /** Window for events/second measurement (ms) */
  highLoadWindowMs: number;
  /** Send voice alerts on anomaly detection */
  voiceAlerts: boolean;
  /** Send JSONL alerts on anomaly detection */
  jsonlAlerts: boolean;
  /** Max messages from one agent per minute before flood alert */
  messageFloodThreshold: number;
  /** Window size in ms for message flood detection */
  messageFloodWindowMs: number;
  /** Max time with no send/receive activity before orphaned member alert (ms) */
  orphanedMemberThresholdMs: number;
  /** Max speed ratio between fastest and slowest member before divergence alert */
  teamDivergenceRatio: number;
}

export interface Anomaly {
  id: string;
  type: 'token_spike' | 'error_burst' | 'infinite_loop' | 'stale_workflow' | 'high_load' | 'communication_deadlock' | 'message_flood' | 'orphaned_member' | 'team_divergence';
  severity: 'warning' | 'critical';
  workflowId: string;
  agentId?: string;
  detectedAt: number;
  message: string;
  evidence: Record<string, unknown>;
  resolved: boolean;
  resolvedAt?: number;
}

export interface AnomalyDetector {
  ingest(trace: AgentTrace): Anomaly[];
  getActiveAnomalies(): Anomaly[];
  getAllAnomalies(): Anomaly[];
  getWorkflowHealth(workflowId: string): WorkflowHealth;
  reset(): void;
}

export interface WorkflowHealth {
  workflowId: string;
  status: 'healthy' | 'warning' | 'critical' | 'unknown';
  activeAnomalies: number;
  totalTokens: number;
  errorCount: number;
  toolCallCount: number;
  lastTraceAt: number | null;
  agentIds: string[];
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: AnomalyDetectorConfig = {
  tokenSpikeThreshold: 100000,
  tokenSpikeWindowMs: 60000,
  errorBurstThreshold: 5,
  errorBurstWindowMs: 30000,
  infiniteLoopThreshold: 10,
  infiniteLoopWindow: 20,
  staleWorkflowThresholdMs: 300000,
  highLoadEventsPerSecond: 100,
  highLoadWindowMs: 5000,
  voiceAlerts: true,
  jsonlAlerts: true,
  messageFloodThreshold: 50,
  messageFloodWindowMs: 60000,
  orphanedMemberThresholdMs: 120000,
  teamDivergenceRatio: 5,
};

// ============================================================================
// Implementation
// ============================================================================

let anomalyCounter = 0;

function generateAnomalyId(): string {
  return `anomaly_${Date.now()}_${++anomalyCounter}`;
}

export function createAnomalyDetector(config?: Partial<AnomalyDetectorConfig>): AnomalyDetector {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Per-workflow state for tracking
  const workflowState = new Map<string, {
    traces: AgentTrace[];
    recentTokens: { timestamp: number; tokens: number }[];
    recentErrors: { timestamp: number; message: string }[];
    recentToolCalls: string[];
    lastTraceAt: number;
    totalTokens: number;
    errorCount: number;
    toolCallCount: number;
    agentIds: Set<string>;
    // Team-specific tracking
    agentMessageCounts: Map<string, { timestamps: number[] }>;
    agentLastActivity: Map<string, number>;
    agentProgressCounts: Map<string, number>;
    pendingMessages: Map<string, Set<string>>; // agentId -> set of agents waiting for response
  }>();

  const anomalies: Anomaly[] = [];
  const eventTimestamps: number[] = [];

  function getOrCreateWorkflowState(workflowId: string) {
    if (!workflowState.has(workflowId)) {
      workflowState.set(workflowId, {
        traces: [],
        recentTokens: [],
        recentErrors: [],
        recentToolCalls: [],
        lastTraceAt: Date.now(),
        totalTokens: 0,
        errorCount: 0,
        toolCallCount: 0,
        agentIds: new Set(),
        agentMessageCounts: new Map(),
        agentLastActivity: new Map(),
        agentProgressCounts: new Map(),
        pendingMessages: new Map(),
      });
    }
    return workflowState.get(workflowId)!;
  }

  function emitAnomaly(anomaly: Anomaly): void {
    anomalies.push(anomaly);

    // Send alert
    if (cfg.voiceAlerts || cfg.jsonlAlerts) {
      sendAlert(anomaly.severity, anomaly.workflowId, anomaly.message, {
        score: 0,
        evaluator: `anomaly_${anomaly.type}`,
      }, {
        voiceNotifications: cfg.voiceAlerts,
        jsonlLogging: cfg.jsonlAlerts,
      });
    }

    // Emit eval signal for anomalies
    emitEvalSignal({
      source: 'AnomalyDetector',
      signalType: anomaly.severity === 'critical' ? 'failure' : 'regression',
      description: anomaly.message,
      category: anomaly.type,
      severity: anomaly.severity === 'critical' ? 'critical' : 'high',
      suite: 'AnomalyDetector',
      rawData: anomaly.evidence,
    });

    // Emit notification for critical anomalies
    if (anomaly.severity === 'critical') {
      emitNotification(`Critical anomaly detected: ${anomaly.type}`, {
        priority: 'critical',
        agentName: 'AnomalyDetector',
      });
    }

    auditLog({
      action: 'alert',
      workflowId: anomaly.workflowId,
      details: {
        anomalyType: anomaly.type,
        severity: anomaly.severity,
        message: anomaly.message,
      },
      success: true,
    });
  }

  function checkTokenSpike(state: ReturnType<typeof getOrCreateWorkflowState>, trace: AgentTrace): Anomaly | null {
    const now = Date.now();
    const tokens = trace.metadata.tokensUsed || 0;
    if (tokens === 0) return null;

    state.recentTokens.push({ timestamp: now, tokens });
    state.totalTokens += tokens;

    // Clean expired entries
    state.recentTokens = state.recentTokens.filter(t => t.timestamp > now - cfg.tokenSpikeWindowMs);

    const windowTotal = state.recentTokens.reduce((s, t) => s + t.tokens, 0);
    if (windowTotal >= cfg.tokenSpikeThreshold) {
      // Check if we already have an active anomaly for this
      const hasActive = anomalies.some(a =>
        a.type === 'token_spike' &&
        a.workflowId === trace.workflowId &&
        !a.resolved &&
        a.detectedAt > now - cfg.tokenSpikeWindowMs
      );
      if (hasActive) return null;

      const anomaly: Anomaly = {
        id: generateAnomalyId(),
        type: 'token_spike',
        severity: windowTotal >= cfg.tokenSpikeThreshold * 2 ? 'critical' : 'warning',
        workflowId: trace.workflowId,
        agentId: trace.agentId,
        detectedAt: now,
        message: `Token spike: ${windowTotal} tokens in ${cfg.tokenSpikeWindowMs / 1000}s window (threshold: ${cfg.tokenSpikeThreshold})`,
        evidence: { windowTotal, threshold: cfg.tokenSpikeThreshold, windowMs: cfg.tokenSpikeWindowMs },
        resolved: false,
      };
      return anomaly;
    }
    return null;
  }

  function checkErrorBurst(state: ReturnType<typeof getOrCreateWorkflowState>, trace: AgentTrace): Anomaly | null {
    if (trace.eventType !== 'error') return null;

    const now = Date.now();
    state.recentErrors.push({ timestamp: now, message: trace.metadata.errorMessage || '' });
    state.errorCount++;

    // Clean expired entries
    state.recentErrors = state.recentErrors.filter(e => e.timestamp > now - cfg.errorBurstWindowMs);

    if (state.recentErrors.length >= cfg.errorBurstThreshold) {
      const hasActive = anomalies.some(a =>
        a.type === 'error_burst' &&
        a.workflowId === trace.workflowId &&
        !a.resolved &&
        a.detectedAt > now - cfg.errorBurstWindowMs
      );
      if (hasActive) return null;

      const anomaly: Anomaly = {
        id: generateAnomalyId(),
        type: 'error_burst',
        severity: state.recentErrors.length >= cfg.errorBurstThreshold * 2 ? 'critical' : 'warning',
        workflowId: trace.workflowId,
        agentId: trace.agentId,
        detectedAt: now,
        message: `Error burst: ${state.recentErrors.length} errors in ${cfg.errorBurstWindowMs / 1000}s window`,
        evidence: {
          errorCount: state.recentErrors.length,
          threshold: cfg.errorBurstThreshold,
          recentMessages: state.recentErrors.slice(-5).map(e => e.message),
        },
        resolved: false,
      };
      return anomaly;
    }
    return null;
  }

  function checkInfiniteLoop(state: ReturnType<typeof getOrCreateWorkflowState>, trace: AgentTrace): Anomaly | null {
    if (trace.eventType !== 'tool_call') return null;

    const toolName = trace.metadata.toolName || 'unknown';
    state.recentToolCalls.push(toolName);
    state.toolCallCount++;

    // Keep only the window
    if (state.recentToolCalls.length > cfg.infiniteLoopWindow) {
      state.recentToolCalls = state.recentToolCalls.slice(-cfg.infiniteLoopWindow);
    }

    if (state.recentToolCalls.length < cfg.infiniteLoopThreshold) return null;

    // Check for repeated pattern
    const recent = state.recentToolCalls.slice(-cfg.infiniteLoopThreshold);
    const allSame = recent.every(t => t === recent[0]);

    if (allSame) {
      const now = Date.now();
      const hasActive = anomalies.some(a =>
        a.type === 'infinite_loop' &&
        a.workflowId === trace.workflowId &&
        !a.resolved
      );
      if (hasActive) return null;

      const anomaly: Anomaly = {
        id: generateAnomalyId(),
        type: 'infinite_loop',
        severity: 'critical',
        workflowId: trace.workflowId,
        agentId: trace.agentId,
        detectedAt: now,
        message: `Infinite loop suspected: "${recent[0]}" called ${cfg.infiniteLoopThreshold} times consecutively`,
        evidence: {
          toolName: recent[0],
          consecutiveCount: cfg.infiniteLoopThreshold,
          recentCalls: state.recentToolCalls.slice(-cfg.infiniteLoopWindow),
        },
        resolved: false,
      };
      return anomaly;
    }

    // Check for repeating 2-element cycle
    if (state.recentToolCalls.length >= cfg.infiniteLoopThreshold) {
      const last = state.recentToolCalls.slice(-cfg.infiniteLoopThreshold);
      let isCycle = true;
      for (let i = 2; i < last.length; i++) {
        if (last[i] !== last[i % 2]) {
          isCycle = false;
          break;
        }
      }
      if (isCycle && last[0] !== last[1]) {
        const now = Date.now();
        const hasActive = anomalies.some(a =>
          a.type === 'infinite_loop' &&
          a.workflowId === trace.workflowId &&
          !a.resolved
        );
        if (hasActive) return null;

        const anomaly: Anomaly = {
          id: generateAnomalyId(),
          type: 'infinite_loop',
          severity: 'critical',
          workflowId: trace.workflowId,
          agentId: trace.agentId,
          detectedAt: now,
          message: `Infinite loop suspected: alternating "${last[0]}" / "${last[1]}" cycle detected`,
          evidence: {
            pattern: [last[0], last[1]],
            cycleLength: cfg.infiniteLoopThreshold,
            recentCalls: state.recentToolCalls.slice(-cfg.infiniteLoopWindow),
          },
          resolved: false,
        };
        return anomaly;
      }
    }

    return null;
  }

  function checkMessageFlood(state: ReturnType<typeof getOrCreateWorkflowState>, trace: AgentTrace): Anomaly | null {
    if (trace.eventType !== 'team_message') return null;

    const now = Date.now();
    const agentId = trace.agentId;

    if (!state.agentMessageCounts.has(agentId)) {
      state.agentMessageCounts.set(agentId, { timestamps: [] });
    }
    const agentMsgs = state.agentMessageCounts.get(agentId)!;
    agentMsgs.timestamps.push(now);

    // Clean expired timestamps
    agentMsgs.timestamps = agentMsgs.timestamps.filter(t => t > now - cfg.messageFloodWindowMs);

    if (agentMsgs.timestamps.length >= cfg.messageFloodThreshold) {
      const hasActive = anomalies.some(a =>
        a.type === 'message_flood' &&
        a.workflowId === trace.workflowId &&
        a.agentId === agentId &&
        !a.resolved &&
        a.detectedAt > now - cfg.messageFloodWindowMs
      );
      if (hasActive) return null;

      return {
        id: generateAnomalyId(),
        type: 'message_flood',
        severity: agentMsgs.timestamps.length >= cfg.messageFloodThreshold * 2 ? 'critical' : 'warning',
        workflowId: trace.workflowId,
        agentId,
        detectedAt: now,
        message: `Message flood: agent "${agentId}" sent ${agentMsgs.timestamps.length} messages in ${cfg.messageFloodWindowMs / 1000}s (threshold: ${cfg.messageFloodThreshold})`,
        evidence: {
          messageCount: agentMsgs.timestamps.length,
          threshold: cfg.messageFloodThreshold,
          windowMs: cfg.messageFloodWindowMs,
        },
        resolved: false,
      };
    }
    return null;
  }

  function checkOrphanedMember(state: ReturnType<typeof getOrCreateWorkflowState>, trace: AgentTrace): Anomaly | null {
    const now = Date.now();

    // Update activity for current agent
    state.agentLastActivity.set(trace.agentId, now);

    // Only check for orphans if we have multiple agents (team scenario)
    if (state.agentIds.size < 2) return null;

    // Check all known agents for inactivity
    for (const agentId of state.agentIds) {
      const lastActivity = state.agentLastActivity.get(agentId);
      if (!lastActivity) continue;

      const inactiveDuration = now - lastActivity;
      if (inactiveDuration >= cfg.orphanedMemberThresholdMs && agentId !== trace.agentId) {
        const hasActive = anomalies.some(a =>
          a.type === 'orphaned_member' &&
          a.agentId === agentId &&
          a.workflowId === trace.workflowId &&
          !a.resolved
        );
        if (hasActive) continue;

        const anomaly: Anomaly = {
          id: generateAnomalyId(),
          type: 'orphaned_member',
          severity: 'warning',
          workflowId: trace.workflowId,
          agentId,
          detectedAt: now,
          message: `Orphaned member: agent "${agentId}" has had no activity for ${Math.round(inactiveDuration / 1000)}s (threshold: ${cfg.orphanedMemberThresholdMs / 1000}s)`,
          evidence: {
            inactiveDurationMs: inactiveDuration,
            threshold: cfg.orphanedMemberThresholdMs,
            lastActivity,
          },
          resolved: false,
        };
        return anomaly; // Return first orphan found
      }
    }
    return null;
  }

  function checkCommunicationDeadlock(state: ReturnType<typeof getOrCreateWorkflowState>, trace: AgentTrace): Anomaly | null {
    if (trace.eventType !== 'team_message') return null;

    const now = Date.now();
    const from = trace.agentId;
    const to = (trace.context?.to as string) || '';

    if (!to || to === 'all') return null;

    // Track who is waiting for whom
    if (!state.pendingMessages.has(from)) {
      state.pendingMessages.set(from, new Set());
    }
    state.pendingMessages.get(from)!.add(to);

    // Check for circular dependencies: A waits for B, B waits for A
    const fromWaitsFor = state.pendingMessages.get(from);
    const toWaitsFor = state.pendingMessages.get(to);

    if (fromWaitsFor?.has(to) && toWaitsFor?.has(from)) {
      const hasActive = anomalies.some(a =>
        a.type === 'communication_deadlock' &&
        a.workflowId === trace.workflowId &&
        !a.resolved
      );
      if (hasActive) return null;

      return {
        id: generateAnomalyId(),
        type: 'communication_deadlock',
        severity: 'critical',
        workflowId: trace.workflowId,
        agentId: from,
        detectedAt: now,
        message: `Communication deadlock: agents "${from}" and "${to}" are waiting on each other`,
        evidence: {
          agents: [from, to],
          fromPending: Array.from(fromWaitsFor || []),
          toPending: Array.from(toWaitsFor || []),
        },
        resolved: false,
      };
    }

    return null;
  }

  function checkTeamDivergence(state: ReturnType<typeof getOrCreateWorkflowState>, trace: AgentTrace): Anomaly | null {
    if (trace.eventType !== 'team_task_update' && trace.eventType !== 'completion') return null;

    const now = Date.now();

    // Update progress count for this agent
    const current = state.agentProgressCounts.get(trace.agentId) || 0;
    state.agentProgressCounts.set(trace.agentId, current + 1);

    // Need at least 2 agents with progress data to compare
    if (state.agentProgressCounts.size < 2) return null;

    const progressValues = Array.from(state.agentProgressCounts.values());
    const maxProgress = Math.max(...progressValues);
    const minProgress = Math.min(...progressValues);

    if (minProgress > 0 && maxProgress / minProgress >= cfg.teamDivergenceRatio) {
      const hasActive = anomalies.some(a =>
        a.type === 'team_divergence' &&
        a.workflowId === trace.workflowId &&
        !a.resolved
      );
      if (hasActive) return null;

      const fastest = Array.from(state.agentProgressCounts.entries())
        .find(([, v]) => v === maxProgress)?.[0] || 'unknown';
      const slowest = Array.from(state.agentProgressCounts.entries())
        .find(([, v]) => v === minProgress)?.[0] || 'unknown';

      return {
        id: generateAnomalyId(),
        type: 'team_divergence',
        severity: 'warning',
        workflowId: trace.workflowId,
        detectedAt: now,
        message: `Team divergence: "${fastest}" has ${maxProgress} completions vs "${slowest}" with ${minProgress} (${(maxProgress / minProgress).toFixed(1)}x ratio, threshold: ${cfg.teamDivergenceRatio}x)`,
        evidence: {
          ratio: maxProgress / minProgress,
          threshold: cfg.teamDivergenceRatio,
          fastest: { agentId: fastest, progress: maxProgress },
          slowest: { agentId: slowest, progress: minProgress },
          allProgress: Object.fromEntries(state.agentProgressCounts),
        },
        resolved: false,
      };
    }

    return null;
  }

  function checkHighLoad(): Anomaly | null {
    const now = Date.now();
    // Clean old timestamps
    while (eventTimestamps.length > 0 && eventTimestamps[0] < now - cfg.highLoadWindowMs) {
      eventTimestamps.shift();
    }

    const eventsPerSecond = eventTimestamps.length / (cfg.highLoadWindowMs / 1000);
    if (eventsPerSecond >= cfg.highLoadEventsPerSecond) {
      const hasActive = anomalies.some(a =>
        a.type === 'high_load' &&
        !a.resolved &&
        a.detectedAt > now - cfg.highLoadWindowMs
      );
      if (hasActive) return null;

      const anomaly: Anomaly = {
        id: generateAnomalyId(),
        type: 'high_load',
        severity: 'warning',
        workflowId: 'system',
        detectedAt: now,
        message: `High event load: ${eventsPerSecond.toFixed(1)} events/sec (threshold: ${cfg.highLoadEventsPerSecond})`,
        evidence: { eventsPerSecond, threshold: cfg.highLoadEventsPerSecond },
        resolved: false,
      };
      return anomaly;
    }
    return null;
  }

  return {
    ingest(trace: AgentTrace): Anomaly[] {
      const state = getOrCreateWorkflowState(trace.workflowId);
      state.traces.push(trace);
      state.lastTraceAt = Date.now();
      state.agentIds.add(trace.agentId);
      eventTimestamps.push(Date.now());

      const detected: Anomaly[] = [];

      // Run all detectors
      const tokenAnomaly = checkTokenSpike(state, trace);
      if (tokenAnomaly) {
        emitAnomaly(tokenAnomaly);
        detected.push(tokenAnomaly);
      }

      const errorAnomaly = checkErrorBurst(state, trace);
      if (errorAnomaly) {
        emitAnomaly(errorAnomaly);
        detected.push(errorAnomaly);
      }

      const loopAnomaly = checkInfiniteLoop(state, trace);
      if (loopAnomaly) {
        emitAnomaly(loopAnomaly);
        detected.push(loopAnomaly);
      }

      const loadAnomaly = checkHighLoad();
      if (loadAnomaly) {
        emitAnomaly(loadAnomaly);
        detected.push(loadAnomaly);
      }

      // Team-specific detectors (run for team event types)
      const floodAnomaly = checkMessageFlood(state, trace);
      if (floodAnomaly) {
        emitAnomaly(floodAnomaly);
        detected.push(floodAnomaly);
      }

      const orphanAnomaly = checkOrphanedMember(state, trace);
      if (orphanAnomaly) {
        emitAnomaly(orphanAnomaly);
        detected.push(orphanAnomaly);
      }

      const deadlockAnomaly = checkCommunicationDeadlock(state, trace);
      if (deadlockAnomaly) {
        emitAnomaly(deadlockAnomaly);
        detected.push(deadlockAnomaly);
      }

      const divergeAnomaly = checkTeamDivergence(state, trace);
      if (divergeAnomaly) {
        emitAnomaly(divergeAnomaly);
        detected.push(divergeAnomaly);
      }

      // Auto-resolve stale workflow anomalies when we get new traces
      for (const a of anomalies) {
        if (a.type === 'stale_workflow' && a.workflowId === trace.workflowId && !a.resolved) {
          a.resolved = true;
          a.resolvedAt = Date.now();
        }
      }

      return detected;
    },

    getActiveAnomalies(): Anomaly[] {
      return anomalies.filter(a => !a.resolved);
    },

    getAllAnomalies(): Anomaly[] {
      return [...anomalies];
    },

    getWorkflowHealth(workflowId: string): WorkflowHealth {
      const state = workflowState.get(workflowId);
      if (!state) {
        return {
          workflowId,
          status: 'unknown',
          activeAnomalies: 0,
          totalTokens: 0,
          errorCount: 0,
          toolCallCount: 0,
          lastTraceAt: null,
          agentIds: [],
        };
      }

      const activeForWorkflow = anomalies.filter(a => a.workflowId === workflowId && !a.resolved);
      const hasCritical = activeForWorkflow.some(a => a.severity === 'critical');
      const hasWarning = activeForWorkflow.some(a => a.severity === 'warning');

      return {
        workflowId,
        status: hasCritical ? 'critical' : hasWarning ? 'warning' : 'healthy',
        activeAnomalies: activeForWorkflow.length,
        totalTokens: state.totalTokens,
        errorCount: state.errorCount,
        toolCallCount: state.toolCallCount,
        lastTraceAt: state.lastTraceAt,
        agentIds: Array.from(state.agentIds),
      };
    },

    reset(): void {
      workflowState.clear();
      anomalies.length = 0;
      eventTimestamps.length = 0;
    },
  };
}
