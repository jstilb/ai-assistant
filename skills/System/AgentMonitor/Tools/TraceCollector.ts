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

import { existsSync, readFileSync, readdirSync, watch } from 'fs';
import { join } from 'path';
import { auditLog } from './AuditLogger.ts';
import { getKayaHome } from '../../../../lib/core/KayaHome.ts';

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
  | 'start' | 'tool_call' | 'decision' | 'completion' | 'error'
  | 'team_spawn' | 'team_message' | 'team_task_update' | 'team_cleanup';
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

interface TraceFilter {
  workflowId?: string;
  agentId?: string;
  eventType?: AgentTrace['eventType'];
  startTime?: number;
  endTime?: number;
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
const TRACES_DIR: string = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'traces');

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
  const workflowId = typeof raw.workflowId === 'string' ? raw.workflowId : null;
  if (!workflowId) return null;

  const agentId = typeof raw.agentId === 'string' ? raw.agentId : '';

  // Resolve timestamp — prefer legacy `timestamp`, fall back to new-format `ts`
  const rawTs = raw.timestamp !== undefined ? raw.timestamp : (raw as RawNewFormatTraceLine).ts;
  const timestamp = typeof rawTs === 'number' ? rawTs : NaN;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

  // Resolve eventType — prefer legacy `eventType`, fall back to new-format `category`
  const eventType: TraceEventType | '' = typeof raw.eventType === 'string'
    ? raw.eventType
    : (typeof raw.category === 'string' ? raw.category : '');
  if (!eventType) return null;

  // Resolve metadata — prefer legacy `metadata`, fall back to new-format `payload`
  const metadata = (raw.metadata !== null && typeof raw.metadata === 'object')
    ? raw.metadata as AgentTrace['metadata']
    : (raw.payload !== null && typeof raw.payload === 'object'
      ? raw.payload as AgentTrace['metadata']
      : {});

  const context = (raw.context !== null && typeof raw.context === 'object')
    ? raw.context as Record<string, unknown>
    : {};

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
    if (parsed === null || typeof parsed !== 'object') return null;
    return normalizeRawTrace(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

export function getTracesForWorkflow(workflowId: string): AgentTrace[] {
  const filePath = join(TRACES_DIR, `${workflowId}.jsonl`);

  if (!existsSync(filePath)) {
    auditLog({
      action: 'collect_trace',
      workflowId,
      details: { error: 'trace file not found', path: filePath },
      success: false,
      errorMessage: `Trace file not found: ${filePath}`,
    });
    return [];
  }

  const content = readFileSync(filePath, 'utf-8').trim();
  if (!content) return [];

  const lines = content.split('\n');
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
    action: 'collect_trace',
    workflowId,
    details: { traceCount: traces.length, parseErrors },
    success: true,
  });

  return traces.sort((a, b) => a.timestamp - b.timestamp);
}

export function getAllTraceFiles(): string[] {
  if (!existsSync(TRACES_DIR)) return [];
  return readdirSync(TRACES_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => f.replace('.jsonl', ''));
}

export function getTracesForDate(dateStr: string): Map<string, AgentTrace[]> {
  const result = new Map<string, AgentTrace[]>();
  const targetDate = new Date(dateStr);
  const dayStart = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate()).getTime();
  const dayEnd = dayStart + 86400000; // 24 hours

  const workflowIds = getAllTraceFiles();

  for (const wfId of workflowIds) {
    const traces = getTracesForWorkflow(wfId);
    const filtered = traces.filter(t => t.timestamp >= dayStart && t.timestamp < dayEnd);
    if (filtered.length > 0) {
      result.set(wfId, filtered);
    }
  }

  return result;
}

function filterTraces(traces: AgentTrace[], filter: TraceFilter): AgentTrace[] {
  return traces.filter(t => {
    if (filter.workflowId && t.workflowId !== filter.workflowId) return false;
    if (filter.agentId && t.agentId !== filter.agentId) return false;
    if (filter.eventType && t.eventType !== filter.eventType) return false;
    if (filter.startTime && t.timestamp < filter.startTime) return false;
    if (filter.endTime && t.timestamp > filter.endTime) return false;
    return true;
  });
}

// ============================================================================
// Team Trace Functions
// ============================================================================

const TEAMS_DIR: string = join(KAYA_HOME, 'MEMORY', 'teams');

/**
 * Read team inbox files and convert to AgentTrace format.
 * Scans MEMORY/teams/{teamId}/inboxes/ for message files and converts
 * each message to a team_message trace event.
 */
function getTeamTraces(teamId: string): AgentTrace[] {
  const teamDir = join(TEAMS_DIR, teamId);
  const inboxesDir = join(teamDir, 'inboxes');
  const traces: AgentTrace[] = [];

  if (!existsSync(inboxesDir)) {
    auditLog({
      action: 'collect_trace',
      workflowId: teamId,
      details: { error: 'team inboxes not found', path: inboxesDir },
      success: false,
      errorMessage: `Team inboxes not found: ${inboxesDir}`,
    });
    return [];
  }

  // Read manifest for team metadata
  const manifestPath = join(teamDir, 'manifest.json');
  let teamName = teamId;
  if (existsSync(manifestPath)) {
    try {
      const content = readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(content);
      teamName = manifest.teamName || teamId;
    } catch { /* use teamId as fallback */ }
  }

  // Scan each member's inbox
  const memberDirs = readdirSync(inboxesDir);
  for (const memberId of memberDirs) {
    const messagesPath = join(inboxesDir, memberId, 'messages.json');
    if (!existsSync(messagesPath)) continue;

    try {
      const content = readFileSync(messagesPath, 'utf-8');
      const messages = JSON.parse(content);
      if (!Array.isArray(messages)) continue;

      for (const msg of messages) {
        if (!msg.from || !msg.timestamp) continue;

        const eventType: AgentTrace['eventType'] = msg.content === 'SHUTDOWN_REQUESTED'
          ? 'team_cleanup'
          : 'team_message';

        traces.push({
          workflowId: teamId,
          agentId: msg.from,
          timestamp: new Date(msg.timestamp).getTime(),
          eventType,
          metadata: {
            toolName: `inbox:${memberId}`,
          },
          context: {
            teamName,
            to: msg.to,
            from: msg.from,
            contentLength: msg.content?.length || 0,
            isBroadcast: msg.to === 'all',
          },
        });
      }
    } catch { /* skip malformed inbox files */ }
  }

  // Also check results directory for spawn/completion traces
  const resultsDir = join(teamDir, 'results');
  if (existsSync(resultsDir)) {
    const resultFiles = readdirSync(resultsDir).filter(f => f.endsWith('.json'));
    for (const file of resultFiles) {
      try {
        const content = readFileSync(join(resultsDir, file), 'utf-8');
        const result = JSON.parse(content);
        traces.push({
          workflowId: teamId,
          agentId: result.role || file.replace('.json', ''),
          timestamp: Date.now(),
          eventType: result.status === 'completed' ? 'completion' : 'team_spawn',
          metadata: {
            latencyMs: result.durationMs,
          },
          context: {
            teamName,
            status: result.status,
            model: result.model,
            hasOutput: !!result.output,
          },
        });
      } catch { /* skip malformed result files */ }
    }
  }

  auditLog({
    action: 'collect_trace',
    workflowId: teamId,
    details: { traceCount: traces.length, source: 'team_inboxes' },
    success: true,
  });

  return traces.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Watch team inboxes for real-time monitoring.
 * Uses fs.watch on each member's messages.json file and invokes
 * callback with new traces as messages arrive.
 *
 * Returns a cleanup function to stop watching.
 */
function watchTeamInboxes(
  teamId: string,
  callback: (trace: AgentTrace) => void
): () => void {
  const inboxesDir = join(TEAMS_DIR, teamId, 'inboxes');
  const watchers: ReturnType<typeof watch>[] = [];
  const lastCounts = new Map<string, number>();

  if (!existsSync(inboxesDir)) {
    return () => {};
  }

  const memberDirs = readdirSync(inboxesDir);

  for (const memberId of memberDirs) {
    const messagesPath = join(inboxesDir, memberId, 'messages.json');
    if (!existsSync(messagesPath)) continue;

    // Track initial message count
    try {
      const initContent = readFileSync(messagesPath, 'utf-8');
      const initial = JSON.parse(initContent);
      lastCounts.set(memberId, Array.isArray(initial) ? initial.length : 0);
    } catch {
      lastCounts.set(memberId, 0);
    }

    const watcher = watch(messagesPath, (eventType) => {
      if (eventType !== 'change') return;

      try {
        const msgContent = readFileSync(messagesPath, 'utf-8');
        const messages = JSON.parse(msgContent);
        if (!Array.isArray(messages)) return;

        const lastCount = lastCounts.get(memberId) || 0;
        if (messages.length <= lastCount) return;

        // Process new messages only
        const newMessages = messages.slice(lastCount);
        lastCounts.set(memberId, messages.length);

        for (const msg of newMessages) {
          if (!msg.from || !msg.timestamp) continue;

          callback({
            workflowId: teamId,
            agentId: msg.from,
            timestamp: new Date(msg.timestamp).getTime(),
            eventType: msg.content === 'SHUTDOWN_REQUESTED' ? 'team_cleanup' : 'team_message',
            metadata: {
              toolName: `inbox:${memberId}`,
            },
            context: {
              to: msg.to,
              from: msg.from,
              contentLength: msg.content?.length || 0,
              isBroadcast: msg.to === 'all',
            },
          });
        }
      } catch { /* ignore read errors during rapid writes */ }
    });

    watchers.push(watcher);
  }

  // Return cleanup function
  return () => {
    for (const watcher of watchers) {
      watcher.close();
    }
    watchers.length = 0;
  };
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
