/**
 * SuiteSummarySchema.ts — consumer-side zod schema for the
 * last-suite-run/<suite>.json file EvalExecutor's `suite` command writes.
 *
 * Deliberately NOT EvalExecutor's own TS types: this is a machine boundary
 * between Kaya-owned files, so CONSUMERS validate what crossed it at runtime
 * rather than trusting the PRODUCER's compile-time types — a stale on-disk
 * file from a prior deploy, or a producer-side bug, must fail zod validation
 * loudly instead of being silently trusted.
 *
 * Shared by the two consumers, bin/kaya-evals-nightly.ts and
 * EvalHealthDigest.ts (formerly two copies of this schema).
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
  error: z.string().optional(),
});

export const SuiteSummaryFileSchema = z.object({
  suite: z.string(),
  tasks: z.array(SuiteSummaryTaskSchema),
  summary: z.object({
    total: z.number(),
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
