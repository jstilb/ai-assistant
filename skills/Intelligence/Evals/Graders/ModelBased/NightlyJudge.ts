/**
 * NightlyJudge Grader
 * Static-input grader: scores a PRE-EXISTING decision record against a golden label.
 * Reads `record_path` directly — never relies on `context.output` (HAZARD H2 guard).
 *
 * evals-rebuild slice B1: migrated from `SCORE:`/`REASONING:` free-text line
 * parsing (the old parseJudgeScore(), which had its own first-vs-last-marker
 * disambiguation logic for multi-criterion rubrics that write intermediate
 * "**Score: X/Y**" subtotals before a final SCORE line) to
 * Graders/JudgeProtocol.ts's structured expectJson+zod contract. See
 * JudgeProtocol.ts's docblock for the full rationale. The DELETED parser
 * (and its frozen pre-migration golden fixtures, including the exact
 * subtotal-vs-final-marker case it was built to handle) live in git history
 * / the B1 report — see Graders/__tests__/fixtures/judge-raw-responses.json.
 */

import { BaseGrader, registerGrader, type GraderContext } from '../Base.ts';
import type { GraderConfig, GraderResult } from '../../Types/index.ts';
import { inference } from '../../../../../lib/core/Inference';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getKayaHome } from '../../../../../lib/core/KayaHome.ts';
import { memPathUnder } from '../../../../../lib/core/MemoryPaths.ts';
import { judgeInference, judgeResponseFormatInstruction, type InferenceFn } from '../JudgeProtocol.ts';

/**
 * Canonical live paths by record_source, resolved LAZILY per call — NOT frozen
 * at import. A module-scope `const KAYA_HOME = getKayaHome()` captured the home
 * at load time, so a test pinning KAYA_HOME afterward still resolved to the
 * LIVE tree (A2/Z1 de-freeze pattern). Returns undefined for an unknown source.
 * Later slices may extend the map.
 */
function sourcePathFor(source: string): string | undefined {
  const kayaHome = getKayaHome();
  const map: Record<string, string> = {
    'autoinfo':           memPathUnder(kayaHome, 'AUTOINFO'),
    'spec-pipeline':      memPathUnder(kayaHome, 'QUEUES'),
    'work-queue':         memPathUnder(kayaHome, 'AutonomousWork'),
    'live-verification':  memPathUnder(kayaHome, 'AutonomousWork'),
  };
  return map[source];
}

export type RecordSource = 'autoinfo' | 'spec-pipeline' | 'work-queue' | 'live-verification';

export interface NightlyJudgeParams {
  /** Path to the JSON/JSONL file holding the decision record */
  record_path?: string;
  /** Named source that maps to a canonical live directory */
  record_source?: RecordSource;
  /** Which record within the file (id field lookup in JSONL) */
  record_id?: string;
  /** Path to the golden-set file (JSONL or JSON array) */
  golden_set_path?: string;
  /** Which golden entry to use (id field lookup) */
  golden_id?: string;
  /** Judging instructions / rubric */
  rubric: string;
  /** Inference level for the judge (only 'standard' supported now) */
  judge_level?: 'standard';
  /**
   * For an append-only JSONL `record_path` (e.g. a live monitoring source), score only
   * the most recent N records instead of the whole file. Bounds the judge prompt size so
   * an unboundedly-growing live source can't eventually blow context. Ignored when
   * `record_id` is set (single-record lookup) or for non-JSONL files. Default: all.
   */
  max_records?: number;
}

export class NightlyJudgeGrader extends BaseGrader {
  type = 'nightly_judge' as const;
  category = 'model_based' as const;
  // Reads only record_path/record_source (files) and context.reference (a
  // static config field, not live agent output) — never context.output or
  // context.transcript. See module docblock (HAZARD H2 guard).
  readsOutput = false;

  /**
   * Dependency-injection point for tests.
   * Defaults to the real `inference` function; override in tests.
   */
  public inferenceFn: InferenceFn = inference;

  async grade(context: GraderContext): Promise<GraderResult> {
    const start = performance.now();
    const params = this.config.params as NightlyJudgeParams;

    // ── 1. Resolve record ──────────────────────────────────────────────────────
    const recordResult = this.loadRecord(params);
    if (!recordResult.ok) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: recordResult.error,
        details: { recordId: params.record_id ?? null, goldenId: params.golden_id ?? null },
      });
    }
    const { record, recordId } = recordResult;

    // ── 2. Resolve golden label ────────────────────────────────────────────────
    const golden = this.loadGolden(params, context);
    const goldenId = params.golden_id ?? 'context.reference';

    // ── 3. Build judge prompt ──────────────────────────────────────────────────
    const systemPrompt = this.buildSystemPrompt(params.rubric);
    const userPrompt = this.buildUserPrompt(record, golden);

    // ── 4. Call judge ──────────────────────────────────────────────────────────
    const judged = await judgeInference(
      {
        systemPrompt,
        userPrompt,
        level: 'standard',
        // Judging a full golden set + rubric is a large prompt — 60s was too tight
        // (4/7 evals timed out on the first live run). Generous timeout + one retry
        // per the "determinism must earn its place" backstop (timeout-too-low is our bug).
        timeout: 240000,
        retries: 1,
        retryDelayMs: 4000,
      },
      this.inferenceFn,
    );

    const duration = performance.now() - start;

    // Fail loud: inference failure OR schema-invalid/non-JSON response both
    // surface here as an explicit score-0 grader error, visible in
    // details.judge_error — never a silent score-0-with-empty-reasoning
    // the way an unmatched SCORE: regex used to produce.
    if (!judged.success) {
      return this.createResult(0, false, duration, {
        reasoning: judged.error,
        details: { recordId, goldenId, judge_error: judged.error },
      });
    }

    const passed = judged.score >= 0.5;

    return this.createResult(judged.score, passed, duration, {
      reasoning: judged.reasoning,
      details: {
        recordId,
        goldenId,
        judge_reasoning: judged.reasoning,
      },
    });
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private loadRecord(
    params: NightlyJudgeParams,
  ): { ok: true; record: string; recordId: string } | { ok: false; error: string } {
    // Resolve the file path
    let filePath = params.record_path;

    if (!filePath && params.record_source) {
      const dir = sourcePathFor(params.record_source);
      if (!dir) {
        return { ok: false, error: `unknown record_source: ${params.record_source}` };
      }
      // A record_source maps to a directory; record_id names the .json file in it
      if (!params.record_id) {
        return {
          ok: false,
          error: `record_source "${params.record_source}" requires record_id (names <record_id>.json under ${dir})`,
        };
      }
      filePath = join(dir, `${params.record_id}.json`);
    }

    if (!filePath) {
      return { ok: false, error: 'record not found: no record_path or record_source provided' };
    }

    if (!existsSync(filePath)) {
      return { ok: false, error: `record not found: ${filePath}` };
    }

    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (e) {
      return { ok: false, error: `record not readable: ${e}` };
    }

    // JSONL: find the entry with matching id
    if (params.record_id && filePath.endsWith('.jsonl')) {
      const lines = raw.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj.id === params.record_id) {
            return { ok: true, record: line, recordId: params.record_id };
          }
        } catch {
          // skip malformed lines
        }
      }
      return { ok: false, error: `record_id "${params.record_id}" not found in ${filePath}` };
    }

    // JSONL tail: when max_records is set, score only the most recent N records. An
    // append-only live source grows unboundedly; window to recent extractions so the
    // judge prompt stays bounded and reflects CURRENT health, not ancient records.
    if (params.max_records && params.max_records > 0 && filePath.endsWith('.jsonl')) {
      const lines = raw.split('\n').filter(Boolean);
      const tail = lines.slice(-params.max_records);
      return { ok: true, record: tail.join('\n'), recordId: params.record_id ?? filePath };
    }

    // Single JSON object or raw file
    return { ok: true, record: raw, recordId: params.record_id ?? filePath };
  }

  private loadGolden(params: NightlyJudgeParams, context: GraderContext): string {
    // Prefer context.reference (passed at run time)
    if (context.reference) return context.reference;

    if (!params.golden_set_path || !params.golden_id) return '(no golden label provided)';

    if (!existsSync(params.golden_set_path)) return '(golden set not found)';

    try {
      const raw = readFileSync(params.golden_set_path, 'utf-8');
      // Try JSONL
      const lines = raw.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj.id === params.golden_id) {
            return typeof obj.label === 'string' ? obj.label : JSON.stringify(obj);
          }
        } catch {
          // continue
        }
      }
    } catch {
      // fall through
    }
    return '(golden entry not found)';
  }

  private buildSystemPrompt(rubric: string): string {
    return `You are an expert evaluator scoring a decision record against a golden label.

${rubric}

Scoring scale: 0.0 (completely wrong) to 1.0 (perfect match / correct decision).
A score >= 0.5 is a PASS.

${judgeResponseFormatInstruction()}`;
  }

  private buildUserPrompt(record: string, golden: string): string {
    return `## Decision Record to Evaluate

${record}

## Expected / Golden Label

${golden}

## Your Evaluation

Judge the record against the expected label and provide your reasoning and score.`;
  }
}

registerGrader('nightly_judge', NightlyJudgeGrader);
