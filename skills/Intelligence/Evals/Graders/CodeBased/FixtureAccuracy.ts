/**
 * FixtureAccuracy Grader
 *
 * Grades a JSON summary file written by a LIVE fixture-runner script
 * (e.g. CaptureRoutingFixtureRunner.ts, LearningCaptureFixtureRunner.ts,
 * PromptClassificationFixtureRunner.ts) that ran a real classifier
 * (a live `classify()` call or a live `inference()` call) against a set
 * of fixtures and recorded per-fixture correctness.
 *
 * H2-STYLE STATIC-INPUT READ, LIVE-PRODUCED INPUT: the grader itself makes
 * no model calls and never reads `context.output` — the live classification
 * work happens in `setup_commands` (see TrialRunner's executeTask), which
 * writes `record_path` BEFORE this grader runs. This keeps the (expensive,
 * per-fixture) live calls out of the graded transcript turn while still
 * requiring a live run on every eval invocation — unlike NightlyJudge's
 * fully-static golden-set read, `record_path` here is regenerated per run.
 *
 * Expected record_path JSON shape:
 *   {
 *     accuracy: number,   // 0-1, correct/total
 *     total: number,
 *     correct: number,
 *     results: Array<{ id: string; correct: boolean; [k: string]: unknown }>
 *   }
 *
 * Deliberately NOT trivially satisfiable: a missing file, malformed JSON,
 * a missing/non-numeric `accuracy` field, or `total === 0` (no fixtures
 * actually ran) all score 0 / fail — there is no code path that lets an
 * absent or empty run pass.
 */

import { BaseGrader, registerGrader, type GraderContext } from '../Base.ts';
import type { GraderConfig, GraderResult } from '../../Types/index.ts';
import { existsSync, readFileSync } from 'fs';

export interface FixtureAccuracyParams {
  /** Path to the JSON summary written by a live fixture-runner script. */
  record_path?: string;
  /** Minimum accuracy required to pass. Default 0.8. */
  min_accuracy?: number;
}

interface FixtureRunRecord {
  accuracy: number;
  total: number;
  correct: number;
  results: unknown[];
}

function isFixtureRunRecord(v: unknown): v is FixtureRunRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.accuracy === 'number'
    && typeof r.total === 'number'
    && typeof r.correct === 'number'
    && Array.isArray(r.results);
}

/**
 * A fixture whose runner set the structured `infra_error` marker: its live
 * classify()/inference() call failed and `actual` is an error-fallback
 * default, not a judgment (see FixtureRunnerShared.FixtureResult.infra_error).
 * Machine-authored by the runner's catch block only — never present on a
 * genuinely-judged fixture, so this is a structured-field check, not
 * output-text sniffing.
 */
function isInfraErroredFixture(r: unknown): boolean {
  if (!r || typeof r !== 'object') return false;
  const err = (r as Record<string, unknown>).infra_error;
  return typeof err === 'string' && err.length > 0;
}

export class FixtureAccuracyGrader extends BaseGrader {
  type = 'fixture_accuracy' as const;
  category = 'code_based' as const;
  // Reads only params.record_path (a file setup_commands already wrote) —
  // never context.output or context.transcript. See module docblock (H2 guard).
  readsOutput = false;

  async grade(context: GraderContext): Promise<GraderResult> {
    const start = performance.now();
    const params = (this.config.params ?? {}) as FixtureAccuracyParams;
    const minAccuracy = params.min_accuracy ?? 0.8;

    if (!params.record_path) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: 'fixture_accuracy grader: no record_path configured',
      });
    }

    if (!existsSync(params.record_path)) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: `record not found: ${params.record_path} — the live fixture-runner setup_command did not produce output (check setup_commands ran and its exit status)`,
        details: { record_path: params.record_path },
      });
    }

    let raw: string;
    try {
      raw = readFileSync(params.record_path, 'utf-8');
    } catch (e) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: `record not readable: ${e}`,
        details: { record_path: params.record_path },
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: `record is not valid JSON: ${e}`,
        details: { record_path: params.record_path },
      });
    }

    if (!isFixtureRunRecord(parsed)) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: 'record missing required fields (accuracy: number, total: number, correct: number, results: array)',
        details: { record_path: params.record_path, record: parsed },
      });
    }

    if (parsed.total === 0) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: 'record has 0 fixtures — no behavioral signal, cannot pass on an empty run',
        details: { record_path: params.record_path },
      });
    }

    // Error-fallback infra guard (S5 residual, 401-storm 2026-07-16): when a
    // MAJORITY of fixtures carry the runner's structured `infra_error` marker,
    // the record's accuracy is mostly error-fallback noise — the fallback
    // `actual` can coincidentally match negative-class expectations and
    // produce a misleading NON-zero partial score with ~0% genuine judgment
    // (kaya_prompt_classification scored 0.353 on 07-14/07-15 this way,
    // slipping past the auth-shaped-ZERO guard). Emit the structured
    // `fixture_infra_error` detail so EvalExecutor's
    // isErrorFallbackFixtureRun() excludes the run from the results store and
    // regression detection, exactly like details.judge_error does for
    // judge-based graders. A minority of errored fixtures stays absorbed into
    // the accuracy (each already counts incorrect — a real, if depressed,
    // behavioral signal), so single-fixture flakes never mask a whole run.
    const errored = parsed.results.filter(isInfraErroredFixture).length;
    if (errored * 2 > parsed.total) {
      const sample = (parsed.results.find(isInfraErroredFixture) as Record<string, unknown>).infra_error;
      return this.createResult(0, false, performance.now() - start, {
        reasoning: `${errored}/${parsed.total} fixtures carry infra_error (the runner's live per-fixture call failed; their results are error-fallback defaults, not judgments) — majority errored, no behavioral signal`,
        details: {
          record_path: params.record_path,
          fixture_infra_error: { errored, total: parsed.total, sample },
          total: parsed.total,
          correct: parsed.correct,
          results: parsed.results,
        },
      });
    }

    const accuracy = Math.max(0, Math.min(1, parsed.accuracy));
    const passed = accuracy >= minAccuracy;

    return this.createResult(accuracy, passed, performance.now() - start, {
      reasoning: `${parsed.correct}/${parsed.total} fixtures correct (${(accuracy * 100).toFixed(1)}%), threshold ${(minAccuracy * 100).toFixed(0)}%`,
      details: {
        record_path: params.record_path,
        total: parsed.total,
        correct: parsed.correct,
        min_accuracy: minAccuracy,
        results: parsed.results,
      },
    });
  }
}

registerGrader('fixture_accuracy', FixtureAccuracyGrader);
