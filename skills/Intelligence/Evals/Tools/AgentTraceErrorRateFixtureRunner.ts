#!/usr/bin/env bun
/**
 * AgentTraceErrorRateFixtureRunner — LIVE fixture runner for
 * kaya_agent_trace_error_rate_golden.yaml.
 *
 * evals-rebuild slice C2: migrates AgentMonitor's deleted
 * ErrorRateEvaluator (skills/System/AgentMonitor/Tools/evaluators/
 * ErrorRateEvaluator.ts, EvaluatorPipeline.ts's Phase-1 batch pipeline) into
 * an H2-pattern Evals static-input task. This is the "protocol-parse, no
 * agent spawn" half of the C1-verified migration — deterministic code, no
 * LLM. (The DecisionQuality LLM-half migrated separately to a nightly_judge
 * task — see kaya_agent_trace_decision_quality_golden.yaml.)
 *
 * Each fixture's `input` field is the RAW jsonl content of one real
 * historical AgentMonitor trace file (MEMORY/MONITORING/traces/*.jsonl),
 * copied verbatim — a mix of the legacy format ({timestamp, eventType,
 * metadata, context}) and the newer UnifiedEventSink format ({ts, category,
 * payload}); real trace files mix both. This script re-parses that raw
 * content through TraceCollector.parseTraceLine (the SAME dual-format
 * parser AgentMonitor's live trace readers use, fixed in this slice to stop
 * silently dropping the new-format ~53% of real trace volume) and computes
 * the same error-rate metric ErrorRateEvaluator used to
 * (errorEvents/totalEvents > 15% maxErrorRatePercent). `correct` requires
 * an EXACT match on totalEvents/errorEvents/withinThreshold against the
 * fixture's hand-verified `expected` — not just the pass/fail boolean — so
 * a future regression that reintroduces the single-format-only parse bug
 * (silently undercounting totalEvents) fails this eval loudly instead of
 * being masked by a threshold that happens not to flip.
 *
 * Writes a JSON summary (see FixtureRunnerShared.ts) to --out for the
 * `fixture_accuracy` grader to read.
 *
 * Usage:
 *   bun AgentTraceErrorRateFixtureRunner.ts \
 *     --fixtures <path/to/agent-trace-error-rate-fixtures.jsonl> \
 *     --out <path/to/result.json>
 */

// cross-skill-allowed: evals-rebuild C2 consolidation — this migrated ErrorRate eval net deliberately reuses AgentMonitor's canonical dual-format trace parser (single source of truth) rather than forking a second parser; seam candidate: lift parseTraceLine to lib/core if a third consumer appears
import { parseTraceLine } from '../../../System/AgentMonitor/Tools/TraceCollector.ts';
import {
  loadFixturesJsonl,
  buildSummary,
  writeSummary,
  parseFixtureRunnerArgs,
  type FixtureResult,
} from './FixtureRunnerShared.ts';

const MAX_ERROR_RATE_PERCENT = 15; // matches the deleted ErrorRateEvaluator's DEFAULT_CONFIG.maxErrorRatePercent

interface Expected {
  totalEvents: number;
  errorEvents: number;
  withinThreshold: boolean;
}

interface Actual {
  totalEvents: number;
  errorEvents: number;
  errorRatePercent: number;
  withinThreshold: boolean;
}

export function computeErrorRateActual(rawJsonl: string): Actual {
  const lines = rawJsonl.trim().split('\n');
  const traces = lines
    .map(l => parseTraceLine(l))
    .filter((t): t is NonNullable<typeof t> => t !== null);
  const totalEvents = traces.length;
  const errorEvents = traces.filter(t => t.eventType === 'error').length;
  const errorRatePercent = totalEvents > 0 ? Math.round((errorEvents / totalEvents) * 1000) / 10 : 0;
  const withinThreshold = errorRatePercent <= MAX_ERROR_RATE_PERCENT;
  return { totalEvents, errorEvents, errorRatePercent, withinThreshold };
}

export function runAgentTraceErrorRateFixtures(fixturesPath: string): FixtureResult<Expected, Actual>[] {
  const fixtures = loadFixturesJsonl<Expected>(fixturesPath);
  const results: FixtureResult<Expected, Actual>[] = [];

  for (const fx of fixtures) {
    const actual = computeErrorRateActual(fx.input);
    const correct = actual.totalEvents === fx.expected.totalEvents
      && actual.errorEvents === fx.expected.errorEvents
      && actual.withinThreshold === fx.expected.withinThreshold;
    results.push({ ...fx, actual, correct });
    console.log(
      `  [${correct ? 'OK  ' : 'FAIL'}] ${fx.id}: expected totalEvents=${fx.expected.totalEvents} errorEvents=${fx.expected.errorEvents} withinThreshold=${fx.expected.withinThreshold}, got totalEvents=${actual.totalEvents} errorEvents=${actual.errorEvents} errorRate=${actual.errorRatePercent}% withinThreshold=${actual.withinThreshold}`,
    );
  }

  return results;
}

if (import.meta.main) {
  const { fixtures, out } = parseFixtureRunnerArgs(process.argv.slice(2));
  console.log(`[AgentTraceErrorRateFixtureRunner] Loading fixtures from ${fixtures}`);
  const results = runAgentTraceErrorRateFixtures(fixtures);
  const summary = buildSummary('agent_trace_error_rate_fixtures', results);
  writeSummary(out, summary);
  console.log(`\nAccuracy: ${(summary.accuracy * 100).toFixed(1)}% (${summary.correct}/${summary.total}) — written to ${out}`);
  process.exit(0);
}
