/**
 * SuiteSummarySchema.ts — THE shape of the last-suite-run/<suite>.json file
 * EvalExecutor's `suite` command writes.
 *
 * One shape on both sides of the boundary: the PRODUCER (EvalExecutor's
 * runSuite()/writeSuiteSummaryFile()) compiles against the z.infer types
 * below, and the CONSUMERS (bin/kaya-evals-nightly.ts, EvalHealthDigest.ts)
 * still validate what crossed it at runtime with these schemas — a stale
 * on-disk file from a prior deploy, or a producer-side bug, must fail zod
 * validation loudly instead of being silently trusted.
 */

import { z } from "zod";

export const SuiteSummaryTaskSchema = z.object({
  task_id: z.string(),
  status: z.enum(["passed", "failed", "infra_skipped", "error", "not_found"]),
  mean_score: z.number(),
  pass: z.boolean(),
  pass_rate: z.number(),
  infra_failures: z.number(),
  n_trials: z.number(),
  /** Present for status:'error' (the caught exception's message) and
   *  status:'infra_skipped' (why the task carried no signal — B3 quotes it
   *  in the nightly's red alert). */
  error: z.string().optional(),
});

/**
 * Structured "latest suite run" handoff — evals-rebuild slice A7.
 *
 * Before this, bin/kaya-evals-nightly.ts regexed EvalExecutor's console
 * stdout/stderr (`Tasks: N`, `Running task: <id>`, `Trial N: ✅ (score: X)`,
 * `Error running`) to decide pass/fail and to guard the 2026-06-19 Zod-4
 * "0 useful evals" incident (see MEMORY/SkillAudits/evals-infra-audit-2026-07-09/
 * nightly.md) — brittle free-text sniffing of our own machine output.
 * EvalExecutor and kaya-evals-nightly are both Kaya-owned, so this boundary
 * should carry structured data (framework category B), not console prose.
 *
 * Every `suite` run now overwrites ONE JSON "latest" pointer per suite name
 * at getSuiteSummaryPath(). It is NOT the store of record — the append-only
 * MEMORY/VALIDATION/evals/<date>/<suite>-results.jsonl (ResultsPersistence.ts,
 * written in runSuite()) keeps that role for history/trend. This file exists
 * purely for same-box, same-invocation machine-to-machine handoff: "what did
 * the suite I just shelled out to actually do."
 */
export const SuiteSummaryFileSchema = z.object({
  suite: z.string(),
  tasks: z.array(SuiteSummaryTaskSchema),
  summary: z.object({
    /** Tasks registered to run (post --quick/--sample filtering), BEFORE any
     *  exclusion — matches the old console "Tasks: N" header. */
    total: z.number(),
    /** Tasks that produced real behavioral signal — excludes infra_skipped,
     *  error, and not_found tasks. Same "scored" vocabulary summarizeSuiteRuns
     *  already uses internally. */
    scored: z.number(),
    passed: z.number(),
    failed: z.number(),
    infra_skipped: z.number(),
    mean_score: z.number(),
    started_at: z.string(),
    finished_at: z.string(),
    wall_ms: z.number(),
  }),
});

export type SuiteSummaryTask = z.infer<typeof SuiteSummaryTaskSchema>;
export type SuiteSummaryFile = z.infer<typeof SuiteSummaryFileSchema>;
