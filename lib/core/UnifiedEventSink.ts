/**
 * UnifiedEventSink — Single source of truth for all Kaya events
 *
 * Fan-out strategy:
 * 1. Canonical: append to MEMORY/MONITORING/events/YYYY-MM-DD.jsonl (never fails silently)
 * 2. Dashboard: POST localhost:4000/events (fire and forget, best-effort)
 * 3. Trace file: if workflowId && source === 'trace', append to MEMORY/MONITORING/traces/<workflowId>.jsonl
 *
 * Auto-reads process.env.KAYA_CORRELATION_ID if correlationId not provided.
 */

import { createAppendLog } from './AppendLog';
import { join } from 'path';
import { nanoid } from 'nanoid';
import { getKayaHome } from './KayaHome.ts';

export interface KayaEvent {
  id: string; // nanoid(10)
  ts: number; // Date.now()
  correlationId?: string;
  sessionId?: string;
  source: 'hook' | 'trace' | 'security' | 'routing' | 'cost' | 'pipeline';
  category: string;
  severity: 'debug' | 'info' | 'warn' | 'error' | 'critical';
  workflowId?: string;
  agentId?: string;
  payload: Record<string, unknown>;
}

export interface EmitInput {
  source: KayaEvent['source'];
  category: string;
  severity: KayaEvent['severity'];
  correlationId?: string;
  sessionId?: string;
  workflowId?: string;
  agentId?: string;
  payload: Record<string, unknown>;
}

const DASHBOARD_URL = 'http://localhost:4000/events';

function getMemoryRoot(): string {
  return process.env.KAYA_MEMORY_ROOT ?? join(getKayaHome(), 'MEMORY');
}

function getEventsDir(): string {
  return join(getMemoryRoot(), 'MONITORING/events');
}

function getTracesDir(): string {
  return join(getMemoryRoot(), 'MONITORING/traces');
}

/**
 * Emit a Kaya event with fan-out to canonical storage, dashboard, and trace files.
 */
export function emit(input: EmitInput): void {
  const event: KayaEvent = {
    id: nanoid(10),
    ts: Date.now(),
    correlationId: input.correlationId ?? process.env.KAYA_CORRELATION_ID,
    sessionId: input.sessionId,
    source: input.source,
    category: input.category,
    severity: input.severity,
    workflowId: input.workflowId,
    agentId: input.agentId,
    payload: input.payload,
  };

  // 1. Canonical write — MUST succeed, never swallow errors
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const canonicalPath = join(getEventsDir(), `${today}.jsonl`);
  const canonicalLog = createAppendLog(canonicalPath, {
    maxSizeMB: 50,
    retentionDays: 90,
    maxRotatedFiles: 10,
  });

  canonicalLog.append(event);

  // 2. Dashboard POST — fire and forget, best-effort
  try {
    fetch(DASHBOARD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    }).catch(() => {
      // Swallow fetch errors — dashboard is optional
    });
  } catch {
    // Swallow any errors from fetch setup
  }

  // 3. Trace file write — if workflowId && source === 'trace'
  if (event.workflowId && event.source === 'trace') {
    try {
      const traceFile = join(getTracesDir(), `${event.workflowId}.jsonl`);
      const traceLog = createAppendLog(traceFile, {
        maxSizeMB: 10,
        retentionDays: 30,
        maxRotatedFiles: 5,
      });
      traceLog.append(event);
    } catch (err) {
      // Trace write is best-effort — log to stderr but don't fail
      console.error('[UnifiedEventSink] Trace write failed:', err);
    }
  }
}
