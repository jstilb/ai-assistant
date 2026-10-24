/**
 * EnsembleLabel Grader
 * Label an input by calling N inference levels independently and returning
 * the consensus label. Divergence is spooled to MEMORY/MONITORING for human review.
 */

import { BaseGrader, registerGrader, type GraderContext } from '../Base.ts';
import type { GraderConfig, GraderResult } from '../../Types/index.ts';
import { inference, type InferenceLevel, type InferenceResult } from '../../../../../lib/core/Inference';
import { mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { createAppendLog } from '../../../../../lib/core/AppendLog.ts';
import { getKayaHome } from '../../../../../lib/core/KayaHome.ts';

/**
 * Resolved LAZILY per call — NOT frozen at import. A module-scope
 * `const KAYA_HOME = getKayaHome()` (the previous shape of this code)
 * captured the home at load time, so a test file that pins KAYA_HOME via
 * pinKayaHome() AFTER this module's static imports run (which is the only
 * time a test file legally can — see lib/test/pinKayaHome.ts's doc
 * comment) still resolved to the LIVE tree. That's the exact bug class
 * already fixed once in NightlyJudge.ts (the "A2/Z1 de-freeze pattern")
 * and again in ResultsPersistence.ts (FU1b) — this was its 3rd live
 * instance, confirmed via EnsembleLabel.test.ts polluting the real
 * MEMORY/MONITORING/ensemble-divergence.jsonl with `my-custom-key` test
 * entries on every `bun test` run (73+ stray lines found live). `join`
 * and `createAppendLog` are both cheap pure calls (no I/O at construction
 * time — see AppendLog.ts), so resolving them fresh per grade() call costs
 * nothing.
 */
function ensembleDivergencePath(): string {
  return join(getKayaHome(), 'MEMORY', 'MONITORING', 'ensemble-divergence.jsonl');
}

export interface EnsembleLabelParams {
  /** The labeling rubric / instructions passed as the system prompt */
  system_prompt: string;
  /** The JSON key in each model's parsed response holding the label */
  candidate_field: string;
  /** Minimum vote share required for consensus (default: simple majority) */
  consensus_threshold?: number;
  /** Inference levels to call (default: ['fast', 'standard', 'smart']) */
  levels?: InferenceLevel[];
  /** Key used when spooling divergence records (default: 'ensemble-divergence') */
  diverge_key?: string;
  /** Explicit input to label — falls back to context.output when absent */
  input?: string;
}

export class EnsembleLabelGrader extends BaseGrader {
  type = 'ensemble_label' as const;
  category = 'model_based' as const;
  // `input = params.input ?? context.output` — falls back to context.output
  // whenever a task doesn't supply an explicit static `input`.
  readsOutput = true;

  /**
   * Dependency-injection point for tests.
   * Defaults to the real `inference` function; override in tests.
   */
  public inferenceFn: (opts: Parameters<typeof inference>[0]) => Promise<InferenceResult> = inference;

  async grade(context: GraderContext): Promise<GraderResult> {
    const start = performance.now();
    const params = this.config.params as EnsembleLabelParams;

    const levels: InferenceLevel[] = params.levels ?? ['fast', 'standard', 'smart'];
    const candidateField = params.candidate_field;
    const divergeKey = params.diverge_key ?? 'ensemble-divergence';
    const input = params.input ?? context.output;

    // ── Call all levels in parallel ──────────────────────────────────────────
    const rawResults = await Promise.all(
      levels.map((level) =>
        this.inferenceFn({
          systemPrompt: params.system_prompt,
          userPrompt: input,
          level,
          expectJson: true,
          retries: 2,
        }),
      ),
    );

    // ── Tally votes ──────────────────────────────────────────────────────────
    const votes: Record<string, number> = {};
    const abstentions: number[] = [];

    for (let i = 0; i < rawResults.length; i++) {
      const r = rawResults[i];
      const label =
        r.success && r.parsed != null
          ? (r.parsed as Record<string, unknown>)[candidateField]
          : undefined;

      if (typeof label === 'string' || typeof label === 'number') {
        const key = String(label);
        votes[key] = (votes[key] ?? 0) + 1;
      } else {
        abstentions.push(i);
      }
    }

    const duration_ms = performance.now() - start;
    const votersCount = levels.length - abstentions.length;

    // ── All failed / abstained ────────────────────────────────────────────────
    if (votersCount === 0) {
      return this.createResult(0, false, duration_ms, {
        reasoning: 'all ensemble members failed',
        details: {
          divergent: false,
          votes,
          abstentions,
          voters_count: 0,
        },
      });
    }

    // ── Determine consensus ───────────────────────────────────────────────────
    // Default threshold: simple majority (count * 2 > voters)
    let topLabel: string | undefined;
    let topCount = 0;
    for (const [label, count] of Object.entries(votes)) {
      if (count > topCount) {
        topCount = count;
        topLabel = label;
      }
    }

    const threshold = params.consensus_threshold ?? undefined;
    const hasMajority =
      threshold !== undefined
        ? topCount >= threshold
        : topCount * 2 > votersCount; // simple majority

    if (hasMajority && topLabel !== undefined) {
      // CONSENSUS
      return this.createResult(1.0, true, duration_ms, {
        details: {
          label: topLabel,
          divergent: false,
          votes,
          abstentions,
          voters_count: votersCount,
        },
      });
    }

    // DIVERGENCE — spool to MEMORY/MONITORING
    this.appendDivergenceRecord({
      divergeKey,
      input,
      votes,
    });

    return this.createResult(0.5, false, duration_ms, {
      details: {
        divergent: true,
        votes,
        abstentions,
        voters_count: votersCount,
      },
    });
  }

  private appendDivergenceRecord(opts: {
    divergeKey: string;
    input: string;
    votes: Record<string, number>;
  }): void {
    const { divergeKey, input, votes } = opts;
    // Resolved lazily, per call — see ensembleDivergencePath()'s doc
    // comment (evals-rebuild slice B1 hermeticity fix).
    const spoolPath = ensembleDivergencePath();

    try {
      const dir = dirname(spoolPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const record = {
        ts: new Date().toISOString(),
        diverge_key: divergeKey,
        input: input.slice(0, 200),
        votes,
      };

      createAppendLog(spoolPath).append(record);
    } catch (e) {
      // Never crash the grader over a monitoring write failure — surface via reasoning
      console.error(`[EnsembleLabelGrader] failed to spool divergence record: ${e}`);
    }
  }
}

registerGrader('ensemble_label', EnsembleLabelGrader);
