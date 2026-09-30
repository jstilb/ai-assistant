/**
 * HookMetrics — Record hook execution metrics to MEMORY/MONITORING/hook-metrics.jsonl
 *
 * Usage:
 *   const done = recordHookStart('PreToolUse', { sessionId: '...' });
 *   // ... do work ...
 *   done(); // writes metric with durationMs
 */

import { createAppendLog } from './AppendLog';
import { join } from 'path';
import { getKayaHome } from './KayaHome.ts';

export interface HookMetricRecord {
  hookName: string;
  ts: number;
  durationMs: number;
  sessionId?: string;
  toolName?: string;
  [key: string]: unknown;
}

function getMemoryRoot(): string {
  return process.env.KAYA_MEMORY_ROOT ?? join(getKayaHome(), 'MEMORY');
}

function getMetricsFile(): string {
  return join(getMemoryRoot(), 'MONITORING/hook-metrics.jsonl');
}

/**
 * Record hook execution start. Returns done() callback to finalize metric with durationMs.
 * Never throws - write failures are swallowed silently.
 */
export function recordHookStart(
  hookName: string,
  meta?: Partial<HookMetricRecord>
): () => void {
  const startMs = Date.now();

  return function done(): void {
    const durationMs = Date.now() - startMs;

    try {
      const log = createAppendLog(getMetricsFile(), {
        maxSizeMB: 50,
        retentionDays: 90,
        maxRotatedFiles: 10,
      });

      const record: HookMetricRecord = {
        hookName,
        ts: startMs,
        durationMs,
        ...meta,
      };

      log.append(record);
    } catch {
      // Swallow write errors - metrics are best-effort
    }
  };
}
