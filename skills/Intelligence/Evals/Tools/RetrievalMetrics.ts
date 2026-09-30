/**
 * RetrievalMetrics — pure recall@k and MRR (Mean Reciprocal Rank) functions.
 *
 * Context Integrity Program, Slice D1: Kaya has no retrieval-quality metric
 * anywhere (confirmed by grep before this file was written — see
 * RetrievalQualityFixtureRunner.ts's module header for the audit). These two
 * functions are the whole of that metric. Both are pure and deterministic —
 * no I/O, no LLM calls — precisely because their correctness must be
 * verifiable by hand-worked fixtures (see __tests__/RetrievalMetrics.test.ts)
 * rather than trusted on faith. An unverified metric implementation is worse
 * than no metric: it produces a number that LOOKS rigorous while silently
 * measuring nothing.
 *
 * Definitions (standard IR):
 *   recall@k = |relevant ∩ top-k(retrieved)| / |relevant|
 *     "Of the documents that are actually relevant, what fraction did the
 *     top k results surface?" Requires at least one relevant document to be
 *     meaningful — a query with zero relevant documents has undefined
 *     recall, not zero (see recallAtK's throw below).
 *   reciprocal rank = 1 / (1-based rank of the FIRST relevant document in
 *     the full retrieved order), or 0 if no relevant document appears
 *     anywhere in the retrieved list.
 *   MRR = mean of reciprocal rank across a set of queries.
 */

/**
 * Fraction of the relevant set that appears within the top `k` of `retrieved`.
 *
 * `retrieved` must already be in ranked order (best-first) — this function
 * does no ranking itself, it only measures whether ranking placed relevant
 * items early enough to survive a top-k cutoff.
 *
 * Throws if `relevant` is empty: recall is undefined (not zero) for a query
 * with no ground-truth relevant documents — such a query carries no
 * retrieval signal and must be excluded from a benchmark, never silently
 * scored as a perfect or zero recall.
 */
export function recallAtK(retrieved: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) {
    throw new Error('recallAtK: relevant set is empty — recall is undefined for a query with no ground truth');
  }
  if (k < 0) {
    throw new Error(`recallAtK: k must be >= 0, got ${k}`);
  }
  const relevantSet = new Set(relevant);
  const topK = retrieved.slice(0, k);
  const found = topK.filter(id => relevantSet.has(id)).length;
  return found / relevant.length;
}

/**
 * Reciprocal rank of the first relevant document in `retrieved`'s full
 * order (not cut off at any k — MRR is conventionally computed over the
 * whole ranked list the system returns). Returns 0 when no relevant
 * document appears anywhere in `retrieved` — never throws on that case
 * (unlike recallAtK, an all-miss retrieval is a valid, scoreable outcome;
 * it is the empty-relevant-SET precondition that's invalid, not an empty
 * intersection).
 */
export function reciprocalRank(retrieved: string[], relevant: string[]): number {
  if (relevant.length === 0) {
    throw new Error('reciprocalRank: relevant set is empty — rank is undefined for a query with no ground truth');
  }
  const relevantSet = new Set(relevant);
  for (let i = 0; i < retrieved.length; i++) {
    if (relevantSet.has(retrieved[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/** Arithmetic mean of a non-empty array of numbers. Throws on empty input — an average over zero queries is undefined, not zero. */
export function mean(values: number[]): number {
  if (values.length === 0) {
    throw new Error('mean: cannot average zero values');
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Mean Reciprocal Rank across a set of per-query reciprocal ranks. Thin, named wrapper around mean() so call sites read as IR terminology, not generic arithmetic. */
export function meanReciprocalRank(reciprocalRanks: number[]): number {
  return mean(reciprocalRanks);
}
