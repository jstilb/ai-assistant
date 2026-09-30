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
import { appendEvalSignal } from '../../../../lib/core/EvalSignals';
import { notifySync } from '../../../../lib/core/NotificationService';
import { z } from 'zod';
import { createStateManager } from '../../../../lib/core/StateManager.ts';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getKayaHome } from '../../../../lib/core/KayaHome.ts';
import { inference } from '../../../../lib/core/Inference';

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
  /** If true, process traces with context.source === 'simulation' (for replay/injection). Default: false */
  allowSimulation?: boolean;
  /**
   * Override the repetition assessor used to distinguish infinite loops from
   * legitimate batch operations. Defaults to an LLM-backed assessor
   * (assessRepetitionWithInference). Inject `deterministicRepetitionAssessor`
   * for offline/simulation/replay runs so ingest() never makes a live LLM call.
   */
  repetitionAssessor?: RepetitionAssessor;
  /**
   * When false, ingest() performs NO live side effects: it skips the disk
   * dedup-state seed on construction and skips persisting anomalies to
   * active-anomalies.json, emitting eval signals, and sending notifications.
   * Default: true. Set false for hypothetical/simulation runs (threshold
   * replay, synthetic injection) that must not mutate live monitoring state.
   */
  persistState?: boolean;
}

/** Signature of the infinite-loop repetition assessor (see AnomalyDetectorConfig). */
export type RepetitionAssessor = (
  recent: string[],
  toolName: string,
  recentCalls: string[],
) => Promise<'loop' | 'batch' | 'unclear'>;

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

export type AnomalyHandler = (anomaly: Anomaly) => void;

export interface AnomalyDetector {
  ingest(trace: AgentTrace): Promise<Anomaly[]>;
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
// Inference Schemas
// ============================================================================

const RepetitionAssessmentSchema = z.object({
  assessment: z.enum(['loop', 'batch', 'unclear']),
  reasoning: z.string(),
});

// ============================================================================
// In-memory repetition assessment cache (session-scoped dedup)
// Key: "<toolName>:<last-10-calls-joined>", value: assessment result
// Prevents duplicate LLM calls for identical tool repetition patterns within
// a single monitoring session.
// ============================================================================
const repetitionCache = new Map<string, 'loop' | 'batch' | 'unclear'>();

// ============================================================================
// Disk-backed dedup for cross-process anomaly deduplication
// ============================================================================

const KAYA_HOME = getKayaHome();
const DEDUP_STATE_PATH = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'state', 'active-anomalies.json');

const ActiveAnomalyEntrySchema = z.object({
  id: z.string(),
  type: z.string(),
  workflowId: z.string(),
  detectedAt: z.number(),
  resolved: z.boolean(),
});

const ActiveAnomaliesSchema = z.object({
  entries: z.array(ActiveAnomalyEntrySchema),
  lastUpdated: z.string().optional(),
});

type ActiveAnomaliesState = z.infer<typeof ActiveAnomaliesSchema>;

const dedupStateManager = createStateManager<ActiveAnomaliesState>({
  path: DEDUP_STATE_PATH,
  schema: ActiveAnomaliesSchema,
  defaults: { entries: [] },
});

/** Check if an active anomaly of this type+workflow exists on disk (cross-process dedup) */
async function hasDiskActiveAnomaly(type: string, workflowId: string, windowMs?: number): Promise<boolean> {
  try {
    const state = await dedupStateManager.load();
    const now = Date.now();
    return state.entries.some(e =>
      e.type === type &&
      e.workflowId === workflowId &&
      !e.resolved &&
      (windowMs === undefined || e.detectedAt > now - windowMs)
    );
  } catch {
    return false; // On error, allow the anomaly (don't suppress)
  }
}

/** Register a new anomaly in the disk dedup state */
async function registerDiskAnomaly(anomaly: { id: string; type: string; workflowId: string; detectedAt: number }): Promise<void> {
  try {
    await dedupStateManager.update(s => ({
      ...s,
      entries: [...s.entries, { ...anomaly, resolved: false }],
    }));
  } catch { /* best effort */ }
}

/** Mark an anomaly as resolved in the disk dedup state */
async function resolveDiskAnomaly(workflowId: string, type: string): Promise<void> {
  try {
    await dedupStateManager.update(s => ({
      ...s,
      entries: s.entries.map(e =>
        e.workflowId === workflowId && e.type === type && !e.resolved
          ? { ...e, resolved: true }
          : e
      ),
    }));
  } catch { /* best effort */ }
}

/**
 * Resolve stale anomalies based on age and workflow patterns.
 *
 * Criteria:
 * - Aged-out: anomalies older than 30 days are automatically resolved
 * - Test workflows: anomalies for workflowId matching /^a$/ or /^test-/ older than 7 days
 *
 * Returns count of anomalies resolved.
 */
export async function resolveStaleAnomalies(): Promise<number> {
  try {
    const state = await dedupStateManager.load();
    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    let resolvedCount = 0;

    const updatedEntries = state.entries.map(e => {
      // Skip already resolved
      if (e.resolved) return e;

      const age = now - e.detectedAt;

      // Aged-out (>30 days)
      if (age > thirtyDaysMs) {
        resolvedCount++;
        return { ...e, resolved: true };
      }

      // Test workflows (>7 days)
      const isTestWorkflow = /^a$|^test-/.test(e.workflowId);
      if (isTestWorkflow && age > sevenDaysMs) {
        resolvedCount++;
        return { ...e, resolved: true };
      }

      return e;
    });

    if (resolvedCount > 0) {
      await dedupStateManager.update(() => ({
        ...state,
        entries: updatedEntries,
        lastUpdated: new Date().toISOString(),
      }));
    }

    return resolvedCount;
  } catch (err) {
    console.error('[AnomalyDetector] Failed to resolve stale anomalies:', err);
    return 0;
  }
}

// ============================================================================
// Implementation
// ============================================================================

let anomalyCounter = 0;

function generateAnomalyId(): string {
  return `anomaly_${Date.now()}_${++anomalyCounter}`;
}

// Maximum number of concurrent workflow state entries before evicting oldest (ISC 603)
const MAX_WORKFLOW_ENTRIES = 1000;

/**
 * Fallback: assess same-tool repetition using the original boolean logic.
 * Returns true if all recent calls are the same tool (defaults to flagging).
 */
export function _assessRepetitionFallback(recent: string[]): boolean {
  return recent.every(t => t === recent[0]);
}

/**
 * Deterministic repetition assessor (no LLM). Flags an all-same-tool run as a
 * 'loop' and anything else as 'unclear'. Inject via config.repetitionAssessor
 * for offline/simulation/replay runs that must be hermetic and fast.
 */
export const deterministicRepetitionAssessor: RepetitionAssessor = async (recent) =>
  _assessRepetitionFallback(recent) ? 'loop' : 'unclear';

/**
 * Use LLM inference to distinguish genuine infinite loops from legitimate
 * batch operations that happen to call the same tool repeatedly.
 * Returns 'loop' only when the LLM is confident it is a loop.
 * Falls back to the original logic on inference failure.
 */
async function assessRepetitionWithInference(
  recent: string[],
  toolName: string,
  recentCalls: string[]
): Promise<'loop' | 'batch' | 'unclear'> {
  // Cache key: tool name + last-10 calls — deduplicates identical patterns within a session
  const cacheKey = `${toolName}:${recentCalls.slice(-10).join(',')}`;
  const cached = repetitionCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const result = await inference({
      level: 'fast',
      systemPrompt: 'You are an AI agent behavior analyst. Determine if a sequence of repeated tool calls represents an infinite loop or legitimate batch processing. Respond ONLY with JSON (no markdown): {"assessment": "loop"|"batch"|"unclear", "reasoning": "<one sentence>"}',
      userPrompt: `Tool "${toolName}" was called ${recent.length} consecutive times.\nFull recent call sequence: ${recentCalls.join(' -> ')}\n\nIs this a loop (agent stuck repeating), batch (legitimate parallel/sequential work), or unclear?`,
      expectJson: true,
    });

    if (!result.success || result.parsed === undefined) {
      // Fallback: treat allSame as a loop (conservative)
      const assessment = _assessRepetitionFallback(recent) ? 'loop' : 'unclear';
      repetitionCache.set(cacheKey, assessment);
      return assessment;
    }

    const parsed = RepetitionAssessmentSchema.safeParse(result.parsed);
    if (!parsed.success) {
      const assessment = _assessRepetitionFallback(recent) ? 'loop' : 'unclear';
      repetitionCache.set(cacheKey, assessment);
      return assessment;
    }

    repetitionCache.set(cacheKey, parsed.data.assessment);
    return parsed.data.assessment;
  } catch {
    const assessment = _assessRepetitionFallback(recent) ? 'loop' : 'unclear';
    repetitionCache.set(cacheKey, assessment);
    return assessment;
  }
}

export function createAnomalyDetector(
  config?: Partial<AnomalyDetectorConfig>,
  onAnomaly?: AnomalyHandler
): AnomalyDetector {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Per-workflow state for tracking (ISC 603: traces array removed — unbounded growth)
  const workflowState = new Map<string, {
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

  // ISC 603: LRU eviction — evict oldest entry when map exceeds max size
  function getOrCreateWorkflowState(workflowId: string) {
    if (!workflowState.has(workflowId)) {
      if (workflowState.size >= MAX_WORKFLOW_ENTRIES) {
        // Evict the oldest entry (first inserted in Map iteration order)
        const firstKey = workflowState.keys().next().value;
        if (firstKey !== undefined) {
          workflowState.delete(firstKey);
        }
      }
      workflowState.set(workflowId, {
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

  // ISC 605: Synchronous seed — avoids race with first ingest() call.
  // Skipped when persistState === false (hypothetical/simulation runs stay
  // isolated from live dedup state).
  if (cfg.persistState !== false) try {
    const raw = readFileSync(DEDUP_STATE_PATH, 'utf-8');
    const diskState = ActiveAnomaliesSchema.parse(JSON.parse(raw));
    for (const entry of diskState.entries) {
      if (!entry.resolved) {
        const exists = anomalies.some(a => a.id === entry.id);
        if (!exists) {
          anomalies.push({
            id: entry.id,
            type: entry.type as Anomaly['type'],
            severity: 'warning', // Disk entries don't track severity; conservative default
            workflowId: entry.workflowId,
            detectedAt: entry.detectedAt,
            message: `[restored from disk] ${entry.type} on ${entry.workflowId}`,
            evidence: {},
            resolved: false,
          });
        }
      }
    }
  } catch { /* best effort — disk unavailable or no prior state is acceptable */ }

  function emitAnomaly(anomaly: Anomaly): void {
    anomalies.push(anomaly);

    // ISC 600: Delegate alert delivery to caller via onAnomaly handler (decoupled
    // delivery). This is always invoked — the caller owns whatever it does.
    if (onAnomaly !== undefined) {
      try {
        onAnomaly(anomaly);
      } catch (err) {
        // Handler errors must not break ingest() — log to stderr and continue
        console.error('[AnomalyDetector] onAnomaly handler threw:', err);
      }
    }

    // Live side effects — suppressed entirely when persistState === false so
    // hypothetical/simulation runs (replay, injection) never mutate the disk
    // dedup state, emit eval signals, or fire notifications.
    if (cfg.persistState === false) return;

    // Persist to disk for cross-process dedup (fire and forget)
    registerDiskAnomaly({
      id: anomaly.id,
      type: anomaly.type,
      workflowId: anomaly.workflowId,
      detectedAt: anomaly.detectedAt,
    }).catch(() => { /* best effort */ });

    // Emit eval signal for anomalies
    appendEvalSignal({
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
      notifySync(`Critical anomaly detected: ${anomaly.type}`, {
        priority: 'critical',
        agentName: 'AnomalyDetector',
      });
    }
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

  async function checkInfiniteLoop(state: ReturnType<typeof getOrCreateWorkflowState>, trace: AgentTrace): Promise<Anomaly | null> {
    if (trace.eventType !== 'tool_call') return null;

    const toolName = trace.metadata.toolName || 'unknown';
    state.recentToolCalls.push(toolName);
    state.toolCallCount++;

    // Keep only the window
    if (state.recentToolCalls.length > cfg.infiniteLoopWindow) {
      state.recentToolCalls = state.recentToolCalls.slice(-cfg.infiniteLoopWindow);
    }

    if (state.recentToolCalls.length < cfg.infiniteLoopThreshold) return null;

    const recent = state.recentToolCalls.slice(-cfg.infiniteLoopThreshold);

    // Same-tool repetition: use inference to distinguish loop from batch processing
    const allSame = recent.every(t => t === recent[0]);
    if (allSame) {
      const assess = cfg.repetitionAssessor ?? assessRepetitionWithInference;
      const assessment = await assess(
        recent,
        recent[0],
        state.recentToolCalls.slice(-cfg.infiniteLoopWindow)
      );

      if (assessment === 'loop') {
        const now = Date.now();
        const hasActive = anomalies.some(a =>
          a.type === 'infinite_loop' &&
          a.workflowId === trace.workflowId &&
          !a.resolved
        );
        if (hasActive) return null;

        return {
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
      }
      // assessment === 'batch' or 'unclear' — do not flag
      return null;
    }

    // Check for repeating 2-element cycle (kept as reliable deterministic check)
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

        return {
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
    // ISC 604: splice-based drain — O(n) findIndex + one splice, no repeated shift() in a loop
    const threshold = now - cfg.highLoadWindowMs;
    const cutoff = eventTimestamps.findIndex(ts => ts > threshold);
    if (cutoff > 0) {
      eventTimestamps.splice(0, cutoff);
    } else if (cutoff === -1) {
      // All timestamps are expired
      eventTimestamps.length = 0;
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
    async ingest(trace: AgentTrace): Promise<Anomaly[]> {
      // Skip simulation traces — they're synthetic and shouldn't trigger real alerts
      if (trace.context?.source === 'simulation' && !cfg.allowSimulation) return [];

      const state = getOrCreateWorkflowState(trace.workflowId);
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

      const loopAnomaly = await checkInfiniteLoop(state, trace);
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
          // Persist resolution to disk for cross-process consistency
          resolveDiskAnomaly(trace.workflowId, 'stale_workflow').catch(() => { /* best effort */ });
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
