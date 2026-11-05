#!/usr/bin/env bun
/**
 * TraceCollector - JSONL trace ingestion and parsing
 *
 * Reads and parses agent execution traces from JSONL files.
 * Provides filtering, aggregation, and trace validation.
 *
 * Usage:
 *   import { collectTraces, getTracesForWorkflow } from './TraceCollector.ts';
 *   const traces = await getTracesForWorkflow('workflow-123');
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { auditLog } from "./AuditLogger.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * Known event types written by the legacy trace format
 * ({timestamp, eventType, metadata, context}). Widened (below) with a
 * branded string fallback because ~53% of real trace volume is the newer
 * UnifiedEventSink format ({ts, category, payload}) — normalizeRawTrace()
 * maps `category` straight into `eventType`, and the only category value
 * observed in the live corpus (2026-07-12 sample, 1096 files) is
 * 'phase-transition', which isn't one of the legacy enum members. Keeping
 * the literal union (rather than widening to a bare `string`) preserves
 * autocomplete/typo-checking for every existing `=== 'error'` etc. call
 * site while still accepting real-world category values.
 */
export type KnownTraceEventType =
  | "start"
  | "tool_call"
  | "decision"
  | "completion"
  | "error"
  | "team_spawn"
  | "team_message"
  | "team_task_update"
  | "team_cleanup";
export type TraceEventType = KnownTraceEventType | (string & {});

export interface AgentTrace {
  workflowId: string;
  agentId: string;
  timestamp: number;
  eventType: TraceEventType;
  metadata: {
    tokensUsed?: number;
    latencyMs?: number;
    toolName?: string;
    errorMessage?: string;
    iscCompletionRate?: number;
  };
  context: Record<string, unknown>;
}

/**
 * Raw shape of the newer trace format written by lib/core/UnifiedEventSink.ts
 * ({id, ts, source, category, severity, payload}) — as opposed to the
 * legacy AgentMonitor-native format ({timestamp, eventType, metadata,
 * context}). Both formats are written to the same
 * MEMORY/MONITORING/traces/{workflowId}.jsonl files today.
 */
interface RawNewFormatTraceLine {
  id?: string;
  ts?: number;
  source?: string;
  category?: string;
  severity?: string;
  workflowId?: string;
  agentId?: string;
  payload?: Record<string, unknown>;
}

interface TraceStats {
  totalTraces: number;
  uniqueWorkflows: number;
  uniqueAgents: number;
  eventTypeCounts: Record<string, number>;
  timeRange: { start: number; end: number } | null;
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME: string = getKayaHome();
const TRACES_DIR: string = join(KAYA_HOME, "MEMORY", "MONITORING", "traces");

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Normalize a raw parsed trace-line object into a canonical AgentTrace.
 * Handles both the legacy format ({timestamp, eventType, metadata, context})
 * and the newer UnifiedEventSink format ({ts, category, payload}) — ported
 * from Graph/Tools/Ingesters/TraceIngester.ts's normalizeTraceEvent(), the
 * one place this dual-format handling already existed correctly. Returns
 * null (not a thrown error) for a record that isn't a usable trace at all
 * (missing workflowId, or no valid positive-epoch-ms timestamp in either
 * `timestamp` or `ts`).
 */
function normalizeRawTrace(raw: Record<string, unknown>): AgentTrace | null {
  const workflowId = typeof raw.workflowId === "string" ? raw.workflowId : null;
  if (!workflowId) return null;

  const agentId = typeof raw.agentId === "string" ? raw.agentId : "";

  // Resolve timestamp — prefer legacy `timestamp`, fall back to new-format `ts`
  const rawTs = raw.timestamp !== undefined ? raw.timestamp : (raw as RawNewFormatTraceLine).ts;
  const timestamp = typeof rawTs === "number" ? rawTs : NaN;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

  // Resolve eventType — prefer legacy `eventType`, fall back to new-format `category`
  const eventType: TraceEventType | "" =
    typeof raw.eventType === "string" ? raw.eventType : typeof raw.category === "string" ? raw.category : "";
  if (!eventType) return null;

  // Resolve metadata — prefer legacy `metadata`, fall back to new-format `payload`
  const metadata =
    raw.metadata !== null && typeof raw.metadata === "object"
      ? (raw.metadata as AgentTrace["metadata"])
      : raw.payload !== null && typeof raw.payload === "object"
        ? (raw.payload as AgentTrace["metadata"])
        : {};

  const context =
    raw.context !== null && typeof raw.context === "object" ? (raw.context as Record<string, unknown>) : {};

  return { workflowId, agentId, timestamp, eventType, metadata, context };
}

/**
 * Parse one JSONL trace line, accepting either the legacy or the new
 * (UnifiedEventSink) trace format. Exported so other H2-pattern static-input
 * consumers (e.g. Evals UseCases that protocol-parse trace JSONL directly)
 * reuse this exact parse — see evals-rebuild slice C2.
 */
export function parseTraceLine(line: string): AgentTrace | null {
  try {
    const parsed = JSON.parse(line);
    if (parsed === null || typeof parsed !== "object") return null;
    return normalizeRawTrace(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

export function getTracesForWorkflow(workflowId: string): AgentTrace[] {
  const filePath = join(TRACES_DIR, `${workflowId}.jsonl`);

  if (!existsSync(filePath)) {
    auditLog({
      action: "collect_trace",
      workflowId,
      details: { error: "trace file not found", path: filePath },
      success: false,
      errorMessage: `Trace file not found: ${filePath}`,
    });
    return [];
  }

  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) return [];

  const lines = content.split("\n");
  const traces: AgentTrace[] = [];
  let parseErrors = 0;

  for (const line of lines) {
    const trace = parseTraceLine(line);
    if (trace) {
      traces.push(trace);
    } else {
      parseErrors++;
    }
  }

  if (parseErrors > 0) {
    // Surface loudly — a silent drop here previously hid ~53% of real trace
    // volume (the new-format lines) before the dual-format fix; now this
    // only fires for genuinely unparseable/malformed lines.
    console.warn(`[TraceCollector] ${workflowId}: ${parseErrors} unparseable line(s) (of ${lines.length}) skipped`);
  }

  auditLog({
    action: "collect_trace",
    workflowId,
    details: { traceCount: traces.length, parseErrors },
    success: true,
  });

  return traces.sort((a, b) => a.timestamp - b.timestamp);
}

export function getAllTraceFiles(): string[] {
  if (!existsSync(TRACES_DIR)) return [];
  return readdirSync(TRACES_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(".jsonl", ""));
}

export function getTracesForDate(dateStr: string): Map<string, AgentTrace[]> {
  const result = new Map<string, AgentTrace[]>();
  const targetDate = new Date(dateStr);
  const dayStart = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate()).getTime();
  const dayEnd = dayStart + 86400000; // 24 hours

  const workflowIds = getAllTraceFiles();

  for (const wfId of workflowIds) {
    const traces = getTracesForWorkflow(wfId);
    const filtered = traces.filter((t) => t.timestamp >= dayStart && t.timestamp < dayEnd);
    if (filtered.length > 0) {
      result.set(wfId, filtered);
    }
  }

  return result;
}

export function computeTraceStats(traces: AgentTrace[]): TraceStats {
  if (traces.length === 0) {
    return {
      totalTraces: 0,
      uniqueWorkflows: 0,
      uniqueAgents: 0,
      eventTypeCounts: {},
      timeRange: null,
    };
  }

  const workflows = new Set<string>();
  const agents = new Set<string>();
  const eventCounts: Record<string, number> = {};
  let minTime = Infinity;
  let maxTime = -Infinity;

  for (const trace of traces) {
    workflows.add(trace.workflowId);
    agents.add(trace.agentId);
    eventCounts[trace.eventType] = (eventCounts[trace.eventType] || 0) + 1;
    if (trace.timestamp < minTime) minTime = trace.timestamp;
    if (trace.timestamp > maxTime) maxTime = trace.timestamp;
  }

  return {
    totalTraces: traces.length,
    uniqueWorkflows: workflows.size,
    uniqueAgents: agents.size,
    eventTypeCounts: eventCounts,
    timeRange: { start: minTime, end: maxTime },
  };
}
