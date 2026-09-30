#!/usr/bin/env bun
/**
 * CaptureRoutingFixtureRunner — LIVE fixture runner for task_capture_routing.yaml.
 *
 * Calls the REAL production classifier — Router.classify() (Sonnet-backed,
 * skills/Productivity/LifeOS/Capture/Router.ts) — directly, per fixture,
 * bypassing CaptureGate.ts's NON_CAPTURE_HEURISTICS regex pre-filter on
 * purpose: this is what proves the raw LLM classifier can carry the
 * heuristic layer's job before a later slice deletes/folds it (S6 adds a
 * first-class NOT_A_CAPTURE label; today UNKNOWN is the only non-capture
 * signal classify() can emit).
 *
 * Writes a JSON summary (see FixtureRunnerShared.ts) to --out for the
 * `fixture_accuracy` grader to read.
 *
 * Usage:
 *   bun CaptureRoutingFixtureRunner.ts \
 *     --fixtures <path/to/capture-routing-fixtures.jsonl> \
 *     --out <path/to/result.json>
 */

// This eval-net runner's whole purpose (S0, determinism-remediation) is to
// exercise the REAL production classifier live, per fixture, ahead of a
// later slice deleting the deterministic heuristic gate in front of it — a
// lib/interfaces/ seam would be premature abstraction for this single
// eval-only call site (one adapter = hypothetical seam; see
// skills/Development/ImproveCodebaseArchitecture/LANGUAGE.md).
// cross-skill-allowed: eval-only live exercise of the production classifier
import { classify } from '../../../Productivity/LifeOS/Capture/Router.ts';
import {
  loadFixturesJsonl,
  buildSummary,
  writeSummary,
  parseFixtureRunnerArgs,
  type FixtureResult,
} from './FixtureRunnerShared.ts';

interface Expected {
  acceptableLabels: string[];
}

interface Actual {
  label: string;
  confidence: number;
  rationale: string;
}

export async function runCaptureRoutingFixtures(fixturesPath: string): Promise<FixtureResult<Expected, Actual>[]> {
  const fixtures = loadFixturesJsonl<Expected>(fixturesPath);
  const results: FixtureResult<Expected, Actual>[] = [];

  for (const fx of fixtures) {
    let actual: Actual;
    try {
      const cl = await classify(fx.input);
      actual = { label: cl.label, confidence: cl.confidence, rationale: cl.rationale };
    } catch (e) {
      actual = { label: 'CLASSIFY_ERROR', confidence: 0, rationale: String(e) };
    }
    const correct = fx.expected.acceptableLabels.includes(actual.label);
    results.push({ ...fx, actual, correct });
    console.log(
      `  [${correct ? 'OK  ' : 'FAIL'}] ${fx.id} (${fx.category}): expected ${fx.expected.acceptableLabels.join('|')}, got ${actual.label} (conf ${actual.confidence.toFixed(2)})`,
    );
  }

  return results;
}

if (import.meta.main) {
  const { fixtures, out } = parseFixtureRunnerArgs(process.argv.slice(2));
  console.log(`[CaptureRoutingFixtureRunner] Loading fixtures from ${fixtures}`);
  const results = await runCaptureRoutingFixtures(fixtures);
  const summary = buildSummary('capture_routing_fixtures', results);
  writeSummary(out, summary);
  console.log(`\nAccuracy: ${(summary.accuracy * 100).toFixed(1)}% (${summary.correct}/${summary.total}) — written to ${out}`);
  process.exit(0);
}
