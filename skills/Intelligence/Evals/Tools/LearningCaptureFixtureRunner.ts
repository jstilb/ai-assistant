#!/usr/bin/env bun
/**
 * LearningCaptureFixtureRunner — LIVE fixture runner for task_learning_capture.yaml.
 *
 * hooks/lib/learning-utils.ts's isLearningCapture()/getLearningCategory() are
 * a fixed regex-indicator-count classifier — deterministic, and (per the
 * fixtures in Data/golden/learning-capture-fixtures.jsonl) provably wrong in
 * both directions: it MISSES genuine learnings phrased outside its
 * vocabulary, and it FALSE-POSITIVES on frustration-worded venting that
 * happens to hit 2 indicator categories without anything being resolved.
 *
 * This runner does NOT call learning-utils.ts (no production code is
 * exercised here — none is modified either, per the slice's constraints).
 * Instead it calls a live LLM classification prompt directly via
 * lib/core/Inference.ts, asking the SAME semantic question
 * (is this a learning? SYSTEM or ALGORITHM category?) the regex answers
 * today. The point of this eval is to establish whether an LLM CAN do this
 * job at least as well as the regex, ahead of a later slice that would
 * replace the regex with LLM judgment.
 *
 * Usage:
 *   bun LearningCaptureFixtureRunner.ts \
 *     --fixtures <path/to/learning-capture-fixtures.jsonl> \
 *     --out <path/to/result.json>
 */

import { inference } from '../../../../lib/core/Inference.ts';
import {
  loadFixturesJsonl,
  buildSummary,
  writeSummary,
  parseFixtureRunnerArgs,
  type FixtureResult,
} from './FixtureRunnerShared.ts';

interface Expected {
  is_learning: boolean;
  category: 'SYSTEM' | 'ALGORITHM' | null;
}

interface Actual {
  is_learning: boolean;
  category: 'SYSTEM' | 'ALGORITHM' | null;
  rationale: string;
}

const SYSTEM_PROMPT = `You judge whether a piece of text represents a genuine "learning moment" for an AI coding/task assistant reflecting on its own recent work (a session summary, a piece of user feedback, or a self-reflection).

is_learning = true ONLY when the text describes an actual problem/friction that led to a resolution, insight, or a concrete lesson for next time. Venting, frustration, or an unresolved ongoing problem with no insight or fix is NOT a learning (is_learning = false) — something has to have actually been learned or resolved, not just complained about.

is_learning = false for: plain status updates, factual statements, task acknowledgments, or frustration/venting with no resolution or insight.

When is_learning = true, classify category:
- SYSTEM — tooling/infrastructure/hook/build/deploy/config/environment problems
- ALGORITHM — task-execution approach, reasoning, or methodology problems (how the work itself was done, not the tooling)
When is_learning = false, category MUST be null.

Do not rely on keyword matching (e.g. the presence of the word "bug" or "fixed" alone does NOT make something a learning, and the ABSENCE of such words does NOT mean it isn't one) — judge the actual semantic content: was there a real problem, and was something actually resolved or learned from it?

Output exactly one JSON object, nothing else:
{"is_learning": true|false, "category": "SYSTEM"|"ALGORITHM"|null, "rationale": "one sentence, <= 25 words"}`;

function parseActual(output: string): Actual {
  const match = output.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON object found in model output: ${output.slice(0, 200)}`);
  const parsed = JSON.parse(match[0]) as Record<string, unknown>;
  const is_learning = parsed.is_learning === true;
  const rawCategory = parsed.category;
  const category: Actual['category'] =
    rawCategory === 'SYSTEM' || rawCategory === 'ALGORITHM' ? rawCategory : null;
  return {
    is_learning,
    category: is_learning ? category : null,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
  };
}

export async function runLearningCaptureFixtures(fixturesPath: string): Promise<FixtureResult<Expected, Actual>[]> {
  const fixtures = loadFixturesJsonl<Expected>(fixturesPath);
  const results: FixtureResult<Expected, Actual>[] = [];

  for (const fx of fixtures) {
    let actual: Actual;
    let infraError: string | undefined;
    try {
      const result = await inference({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: `Text: ${fx.input}`,
        level: 'standard',
        expectJson: true,
        timeout: 45_000,
        retries: 1,
        retryDelayMs: 2000,
      });
      if (!result.success) throw new Error(result.error ?? 'inference failed');
      actual = parseActual(result.output);
    } catch (e) {
      // Structured marker, not just rationale text: the fallback `actual`
      // below is NOT a judgment, so it must never count `correct` by
      // coinciding with a negative-class expectation (that shape produced
      // the misleading 0.5 on 07-14/07-15) — see
      // FixtureRunnerShared.FixtureResult.infra_error.
      infraError = String(e);
      actual = { is_learning: false, category: null, rationale: `ERROR: ${e}` };
    }
    const correct = infraError === undefined
      && actual.is_learning === fx.expected.is_learning
      && (fx.expected.is_learning ? actual.category === fx.expected.category : true);
    results.push({ ...fx, actual, correct, ...(infraError === undefined ? {} : { infra_error: infraError }) });
    console.log(
      `  [${correct ? 'OK  ' : 'FAIL'}] ${fx.id} (${fx.category}): expected is_learning=${fx.expected.is_learning} category=${fx.expected.category}, got is_learning=${actual.is_learning} category=${actual.category}`,
    );
  }

  return results;
}

if (import.meta.main) {
  const { fixtures, out } = parseFixtureRunnerArgs(process.argv.slice(2));
  console.log(`[LearningCaptureFixtureRunner] Loading fixtures from ${fixtures}`);
  const results = await runLearningCaptureFixtures(fixtures);
  const summary = buildSummary('learning_capture_fixtures', results);
  writeSummary(out, summary);
  console.log(`\nAccuracy: ${(summary.accuracy * 100).toFixed(1)}% (${summary.correct}/${summary.total}) — written to ${out}`);
  process.exit(0);
}
