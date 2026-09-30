#!/usr/bin/env bun
/**
 * EvalSignals — append-only signal log for AgentMonitor / Simulation feedback.
 *
 * Writes one JSON line per signal to MEMORY/EVAL_SIGNALS/signals.jsonl under
 * KAYA_HOME. Path is resolved lazily via memPath() so KAYA_HOME overrides are
 * honored at call time (not import time).
 *
 * Fail-silent contract: errors are logged to stderr; the function never throws.
 * Inherited from the SkillIntegrationBridge.emitEvalSignal that this replaces.
 */

import { memPath } from './MemoryPaths.ts';
import { createAppendLog } from './AppendLog.ts';

export interface EvalSignalPayload {
  source: string;
  signalType: 'failure' | 'success' | 'regression' | 'capability_result';
  description: string;
  category: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  suite?: string;
  score?: number;
  rawData?: Record<string, unknown>;
}

/** Absolute path to the eval-signals JSONL — resolved lazily under KAYA_HOME. */
export function evalSignalsPath(): string {
  return memPath('EVAL_SIGNALS', 'signals.jsonl');
}

/**
 * Append an eval signal record to MEMORY/EVAL_SIGNALS/signals.jsonl.
 * Fail-silent: errors log to stderr, do not throw.
 */
export async function appendEvalSignal(payload: EvalSignalPayload): Promise<void> {
  try {
    const path = evalSignalsPath();

    const record = {
      timestamp: new Date().toISOString(),
      source: payload.source,
      signalType: payload.signalType,
      description: payload.description,
      category: payload.category,
      severity: payload.severity || 'medium',
      suite: payload.suite,
      score: payload.score,
      rawData: payload.rawData,
    };

    // path is resolved via evalSignalsPath()/memPath() at call time (KAYA_HOME
    // overrides honored per call, per this module's doc comment), so the
    // AppendLog handle is constructed per call too — createAppendLog is cheap.
    createAppendLog(path).append(record);
  } catch (error) {
    console.error('[EvalSignals] appendEvalSignal failed:', error instanceof Error ? error.message : error);
  }
}
