#!/usr/bin/env bun
/**
 * RetrievalQualityFixtureRunner — LIVE fixture runner for
 * kaya_retrieval_quality_golden.yaml.
 *
 * Context Integrity Program, Slice D1: THE GAP this closes — grepping the
 * repo before this file was written turned up zero hits for
 * recall@k/recallAtK/MRR/reciprocal-rank/NDCG anywhere in Kaya's own code.
 * `lib/core/MemoryStore.ts`'s `search()` has no relevance ranking and no
 * embeddings: it filters the index to candidates matching type/tier/tags/
 * category/date/fullText-substring, then sorts strictly by `timestamp`
 * descending (see MemoryStore.ts's `search()`, the `entries.sort((a, b) =>
 * ... b.timestamp - a.timestamp)` line) — recency, not relevance. This
 * fixture runner is the first thing in Kaya to measure whether that matters:
 * it calls the REAL, unmodified `memoryStore.search({ fullText })` against
 * the REAL `~/.claude/MEMORY` entry corpus (no mock, no fixture corpus) for
 * each golden query, and scores the real ranked result against a
 * hand-labelled relevant set.
 *
 * H2-STYLE STATIC-INPUT READ, LIVE-PRODUCED INPUT (same pattern as
 * AgentTraceErrorRateFixtureRunner.ts / CaptureRoutingFixtureRunner.ts): no
 * agent is spawned for this task — the live work happens here, in
 * setup_commands, calling MemoryStore.search() directly (deterministic code,
 * not an LLM call). The `fixture_accuracy` grader then only reads the JSON
 * record this script writes.
 *
 * IMPORTANT — what "accuracy" means in the written record vs. the REAL
 * headline metrics: the existing `fixture_accuracy` grader (reused as-is,
 * no new grader was written for this slice) expects a top-level `accuracy`
 * field and grades pass/fail on it. That field here is a coarse HIT RATE —
 * the fraction of queries where at least one relevant document appeared
 * anywhere in the top 10 results — because `fixture_accuracy` needs a single
 * boolean-per-query `correct` signal to build its required `accuracy` field.
 * It is NOT recall@k or MRR. The actual headline numbers this slice exists
 * to produce — `mean_recall_at_5`, `mean_recall_at_10`, `mrr` — are computed
 * separately below and appended to the summary as extra top-level fields.
 * Read those three for the real signal; `accuracy`/`correct` in the record
 * are the grader's pass/fail plumbing, not the metric.
 *
 * Writes a JSON summary (see FixtureRunnerShared.ts, extended with the
 * fields above) to --out for the `fixture_accuracy` grader to read.
 *
 * Usage:
 *   bun RetrievalQualityFixtureRunner.ts \
 *     --fixtures <path/to/retrieval-quality-fixtures.jsonl> \
 *     --out <path/to/result.json>
 */

// cross-skill-allowed: evals-only live exercise of the production
// MemoryStore.search() — the exact function this eval-net exists to measure.
import { memoryStore } from '../../../../lib/core/MemoryStore.ts';
import { recallAtK, reciprocalRank, mean } from './RetrievalMetrics.ts';
import {
  loadFixturesJsonl,
  buildSummary,
  writeSummary,
  parseFixtureRunnerArgs,
  type FixtureResult,
  type FixtureRunSummary,
} from './FixtureRunnerShared.ts';

/** k cutoffs recall is reported at. 10 is the headline (see UseCase YAML for rationale); 5 is reported alongside for context. */
const RECALL_K_VALUES = [5, 10] as const;
/** The k used to derive the per-query `correct` boolean that feeds the reused fixture_accuracy grader's required `accuracy` field (see module header). */
const CORRECT_AT_K = 10;
/** How many retrieved ids to keep in the written record — enough to inspect by hand, not the full unbounded candidate list. */
const RETRIEVED_IDS_RECORD_CAP = 25;

interface Expected {
  relevant_ids: string[];
}

interface Actual {
  retrieved_ids: string[];
  retrieved_count: number;
  recall_at_5: number;
  recall_at_10: number;
  reciprocal_rank: number;
  relevant_total: number;
}

export interface RetrievalQualitySummary extends FixtureRunSummary<Expected, Actual> {
  /** k cutoffs recall was computed at (see RECALL_K_VALUES). */
  k_recall: readonly number[];
  /** k used for the per-query `correct` boolean (see CORRECT_AT_K). */
  k_correct: number;
  /** Mean of recall@5 across all queries. */
  mean_recall_at_5: number;
  /** Mean of recall@10 across all queries — THE headline metric this slice exists to produce. */
  mean_recall_at_10: number;
  /** Mean Reciprocal Rank across all queries — the other headline metric. */
  mrr: number;
}

export async function runRetrievalQualityFixtures(fixturesPath: string): Promise<FixtureResult<Expected, Actual>[]> {
  const fixtures = loadFixturesJsonl<Expected>(fixturesPath);
  const results: FixtureResult<Expected, Actual>[] = [];

  for (const fx of fixtures) {
    // The real, unmodified MemoryStore.search() call — fullText is the only
    // filter, matching how a caller would actually use it to find something
    // by content rather than by known type/tags. No `limit` is passed: we
    // want the FULL ranked (timestamp-sorted) candidate list so recall@k can
    // be computed at multiple k values and MRR can look past k entirely.
    const matches = await memoryStore.search({ fullText: fx.input });
    const retrievedIds = matches.map(m => m.id);
    const relevantIds = fx.expected.relevant_ids;

    const recallAt5 = recallAtK(retrievedIds, relevantIds, 5);
    const recallAt10 = recallAtK(retrievedIds, relevantIds, 10);
    const rr = reciprocalRank(retrievedIds, relevantIds);

    const actual: Actual = {
      retrieved_ids: retrievedIds.slice(0, RETRIEVED_IDS_RECORD_CAP),
      retrieved_count: retrievedIds.length,
      recall_at_5: recallAt5,
      recall_at_10: recallAt10,
      reciprocal_rank: rr,
      relevant_total: relevantIds.length,
    };
    const correct = recallAtK(retrievedIds, relevantIds, CORRECT_AT_K) > 0;

    results.push({ ...fx, actual, correct });
    console.log(
      `  [${correct ? 'HIT ' : 'MISS'}] ${fx.id}: recall@5=${recallAt5.toFixed(2)} recall@10=${recallAt10.toFixed(2)} ` +
      `RR=${rr.toFixed(3)} (${relevantIds.length} relevant, ${retrievedIds.length} retrieved) — "${fx.input.slice(0, 60)}${fx.input.length > 60 ? '...' : ''}"`,
    );
  }

  return results;
}

if (import.meta.main) {
  const { fixtures, out } = parseFixtureRunnerArgs(process.argv.slice(2));
  console.log(`[RetrievalQualityFixtureRunner] Loading fixtures from ${fixtures}`);
  const results = await runRetrievalQualityFixtures(fixtures);
  const baseSummary = buildSummary('retrieval_quality_fixtures', results);

  const recall5s = results.map(r => r.actual.recall_at_5);
  const recall10s = results.map(r => r.actual.recall_at_10);
  const rrs = results.map(r => r.actual.reciprocal_rank);

  const summary: RetrievalQualitySummary = {
    ...baseSummary,
    k_recall: RECALL_K_VALUES,
    k_correct: CORRECT_AT_K,
    mean_recall_at_5: mean(recall5s),
    mean_recall_at_10: mean(recall10s),
    mrr: mean(rrs),
  };

  writeSummary(out, summary);
  console.log(
    `\nHit-rate@${CORRECT_AT_K} (grader accuracy): ${(baseSummary.accuracy * 100).toFixed(1)}% (${baseSummary.correct}/${baseSummary.total})`,
  );
  console.log(`Mean recall@5:  ${summary.mean_recall_at_5.toFixed(4)}`);
  console.log(`Mean recall@10: ${summary.mean_recall_at_10.toFixed(4)}`);
  console.log(`MRR:            ${summary.mrr.toFixed(4)}`);
  console.log(`Written to ${out}`);
  process.exit(0);
}
