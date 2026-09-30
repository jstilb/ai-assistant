/**
 * HookHealth — Record hook failure events to MEMORY/MONITORING/hook-health.jsonl
 *
 * Usage:
 *   import { recordHookFailure } from './HookHealth.ts';
 *   recordHookFailure('PreToolUse', new Error('validation failed'), 1);
 */

import { createAppendLog } from './AppendLog';
import { join } from 'path';
import { getKayaHome } from './KayaHome.ts';

export interface HookHealthRecord {
  hookName: string;
  ts: number;
  error: string;
  exitCode?: number;
  [key: string]: unknown;
}

function getMemoryRoot(): string {
  return process.env.KAYA_MEMORY_ROOT ?? join(getKayaHome(), 'MEMORY');
}

function getHookHealthFile(): string {
  return join(getMemoryRoot(), 'MONITORING/hook-health.jsonl');
}

/**
 * Record a hook failure event.
 * Never throws - write failures are swallowed silently.
 */
export function recordHookFailure(hookName: string, error: Error | string, exitCode?: number): void {
  try {
    const log = createAppendLog(getHookHealthFile(), {
      maxSizeMB: 50,
      retentionDays: 90,
      maxRotatedFiles: 10,
    });

    const record: HookHealthRecord = {
      hookName,
      ts: Date.now(),
      error: error instanceof Error ? error.message : String(error),
      exitCode,
    };

    log.append(record);
  } catch {
    // Swallow write errors - health tracking is best-effort
  }
}
