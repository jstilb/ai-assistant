/**
 * JobSpec.ts — the ONE canonical job-definition schema for Kaya's scheduler.
 *
 * Before S2 there were three divergent, hand-written copies of this shape:
 *   - bin/run-cron-job.ts        local `interface JobSpec` (id, task, schedule,
 *     output, enabled, type, timeout?, execute?)
 *   - bin/migrate-crons-to-launchd.ts  local `interface JobSpec` (same, minus
 *     execute)
 *   - the in-process daemon's `CronJobSchema` (deleted outright in slice D1)
 *     (adds wakeMode, lastRun, nextRun, runCount, failCount, and a wider
 *     6-way output enum)
 *
 * This module unions all three (the superset of every field any of them
 * used) into a single Zod schema + inferred type, so every consumer parses
 * and types job specs identically. All 38 existing
 * MEMORY/daemon/cron/manifests/*.yaml files must continue to parse
 * unchanged — see lib/cron/__tests__/JobSpec.test.ts.
 *
 * S2 also adds five NEW optional fields for later slices (S3/S5) to wire up
 * behavior against — this schema only declares + defaults them, it does not
 * yet implement wake-locking, retry, catch-up, artifact-freshness checks, or
 * network preconditions:
 *   - wakeLock          — hold a caffeinate-style wake lock while running
 *   - retry             — { max, backoffMs } retry policy on failure
 *   - catchUp           — run once on next wake if a scheduled fire was missed
 *   - desiredArtifact    — { path, maxAgeHrs } skip-if-fresh guard
 *   - precondition       — { network } gate requiring connectivity before running
 *
 * remediation-s1s5 A2 ([S2] expectedExitCodes) adds `expectedExitCodes`: some
 * detector-style jobs (scheduler-watchdog, token-health-sentinel) exit 1 BY
 * DESIGN when they detect a problem — they self-page via AlertGate rather
 * than relying on the cron layer's failure path. Without this field, every
 * detection was misclassified as a 'bug'-class cron failure by
 * JobSpawner.ts's success check, bumping FailStreak and polluting the
 * digest for a job that was working exactly as intended. Defaults to [0] so
 * every other job's exit-code semantics are unchanged.
 *
 * S2 also adds `intervalSeconds`, for jobs whose live plist uses launchd's
 * StartInterval trigger (fire every N seconds since load) instead of
 * StartCalendarInterval (fire at specific wall-clock slots) — e.g.
 * com.pai.voicenotes (every 1800s). `schedule` is still REQUIRED and must
 * hold a best-effort cron-equivalent expression (e.g. "*\/30 * * * *" for a
 * 1800s interval), because run-cron-job.ts's defensive matchesCron()
 * re-check reads job.schedule unconditionally regardless of trigger type.
 * `intervalSeconds`, when present, documents the *original* StartInterval
 * value so a future generator can round-trip the plist faithfully.
 *
 * KNOWN GAP (S2, not yet fixed): migrate-crons-to-launchd.ts's
 * generatePlist() only emits StartCalendarInterval — it does not yet read
 * intervalSeconds or emit StartInterval. Regenerating a plist for an
 * interval-based job from its manifest YAML today would silently swap its
 * trigger mechanism from StartInterval to a calendar-slot approximation.
 * Until the generator is extended, interval-based YAMLs are manifest-only
 * (validate-jobs.ts coverage) and must NOT be fed through --apply/--regen.
 */

import { z } from "zod";

/**
 * Job execution type.
 *   - isolated: spawns a dedicated agent turn / process (launchd-schedulable).
 *   - main: enqueues a system event processed in the always-on daemon session
 *     (no launchd analog — see migrate-crons-to-launchd.ts shouldMigrate()).
 */
export const JobTypeSchema = z.enum(["isolated", "main"]);
export type JobType = z.infer<typeof JobTypeSchema>;

/**
 * Job output mode. Union of run-cron-job.ts's narrower 5-way enum and the
 * deleted daemon's 6-way enum (adds discord, telegram) — this is the superset.
 */
export const OutputModeSchema = z.enum([
  "silent",
  "voice",
  "text",
  "push",
  "both",
  "discord",
  "telegram",
]);
export type OutputMode = z.infer<typeof OutputModeSchema>;

/**
 * When present, the runner spawns this command directly instead of wrapping
 * `task` in a `claude -p` agent invocation. See run-cron-job.ts's directMode
 * branch — the spawned process's exit code becomes the job's exit code.
 */
export const ExecuteSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
});
export type Execute = z.infer<typeof ExecuteSchema>;

/** Retry policy on job failure. New in S2 — schema only, no behavior yet. */
export const RetrySchema = z.object({
  max: z.number(),
  backoffMs: z.number(),
});
export type Retry = z.infer<typeof RetrySchema>;

/**
 * Skip-if-fresh guard: if `path` exists and was modified within `maxAgeHrs`,
 * a future runner MAY skip re-running the job. New in S2 — schema only.
 */
export const DesiredArtifactSchema = z.object({
  path: z.string(),
  maxAgeHrs: z.number(),
  // NEW (sleep-cascade remediation, Slice A) — optional substring marker.
  // When set, JobReconciler.ts's decideCatchUp treats the artifact as stale
  // whenever its first line (a bounded read — see bin/job-reconciler.ts's
  // checkStaleMarker) contains this substring, REGARDLESS of mtime-based
  // freshness. This closes the gap where a deterministic-fallback-authored
  // artifact (e.g. daily-briefing's 07:45 sentinel) satisfies the plain
  // maxAgeHrs check trivially — it was just written — so the reconciler
  // never re-ran the real agent for the rest of the day. See
  // skills/Productivity/DailyBriefing/Tools/BriefingFallback.ts's
  // FALLBACK_MARKER. YAML manifests can't import a TS const, so the string
  // set here is duplicated by hand (see daily-briefing.yaml) — keep both
  // sides in sync if the marker text ever changes.
  staleIfFirstLineContains: z.string().optional(),
  pendingSuffix: z.string().regex(/^\.[a-zA-Z0-9._-]+$/).optional(),
});
export type DesiredArtifact = z.infer<typeof DesiredArtifactSchema>;

/** Preconditions gating whether a job should run. New in S2 — schema only. */
export const PreconditionSchema = z.object({
  network: z.boolean(),
});
export type Precondition = z.infer<typeof PreconditionSchema>;

/**
 * JobSpecSchema — canonical, superset schema for a scheduled Kaya job.
 *
 * Field provenance:
 *   id, task, schedule, output, enabled, type   — all three legacy shapes
 *   timeout, execute                             — run-cron-job.ts
 *   lastRun, nextRun, runCount, failCount       — the deleted daemon's
 *                                                    CronJobSchema
 *                                                    (its wakeMode was deleted:
 *                                                    zero consumers ever wired
 *                                                    it up; legacy YAML keys
 *                                                    are stripped as unknown)
 *   description, tags                            — present in some existing
 *                                                    manifests/*.yaml
 *                                                    files (informal, now
 *                                                    formalized)
 *   wakeLock, retry, catchUp, desiredArtifact,
 *     precondition                               — NEW in S2, for S3/S5
 *   expectedExitCodes                             — NEW in remediation-s1s5
 *                                                    A2 ([S2] expectedExitCodes)
 */
export const JobSpecSchema = z.object({
  id: z.string(),
  // Optional: absent on `execute`-only jobs (e.g. evals-nightly.yaml) — task
  // is only read when building the `claude -p` prompt in the non-execute
  // path (see run-cron-job.ts's directMode branch).
  task: z.string().optional(),
  schedule: z.string(),
  output: OutputModeSchema.default("voice"),
  enabled: z.boolean().default(true),
  type: JobTypeSchema,
  timeout: z.number().default(300000), // 5 min default, matched the deleted daemon
  execute: ExecuteSchema.optional(),

  // Fields specific to the deleted in-process daemon
  lastRun: z.string().optional(),
  nextRun: z.string().optional(),
  runCount: z.number().default(0),
  failCount: z.number().default(0),

  // Informal fields already present in some manifest YAMLs
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),

  // NEW in S2 — schema + defaults only, no behavior wiring until S3/S5
  wakeLock: z.boolean().default(true),
  retry: RetrySchema.default({ max: 2, backoffMs: 4000 }),
  catchUp: z.boolean().default(false),
  desiredArtifact: DesiredArtifactSchema.optional(),
  precondition: PreconditionSchema.default({ network: false }),

  // NEW in S2 — documents a live StartInterval plist's original interval
  // (seconds). See module doc: generator does not yet emit StartInterval.
  intervalSeconds: z.number().optional(),

  // NEW (dailybriefing markdown-first, ADR-022) — agent-mode spawn overrides.
  // agentTools replaces the default --allowedTools list (comma-separated,
  // passed through verbatim); agentModel adds --model to the claude -p spawn.
  // Both ignored in execute (direct) mode. See lib/cron/AgentSpawnArgs.ts.
  agentTools: z.string().optional(),
  agentModel: z.string().optional(),
  // agentEffort sets --effort on the claude -p spawn (Fable 5.1 tuning,
  // 2026-09-05). Omitted = DEFAULT_AGENT_EFFORT (medium) in AgentSpawnArgs.ts —
  // scheduled upkeep/ingest work does not need the CLI default (high).
  agentEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),

  // NEW (remediation-s1s5 A2, [S2] expectedExitCodes) — the set of exit
  // codes JobSpawner.ts treats as success for THIS job. Defaults to [0] so
  // every job's behavior is unchanged unless it opts in. Detector-style jobs
  // that self-page via AlertGate on exit 1 (scheduler-watchdog,
  // token-health-sentinel) set [0, 1] here. See lib/cron/JobSpawner.ts's
  // success computation.
  expectedExitCodes: z.array(z.number()).default([0]),
}).superRefine((job, ctx) => {
  // B2 (lib/cron/JobReconciler.ts remediation): the catch-up reconciler
  // deleted its run-ledger fallback signal and now reconciles desired
  // artifacts ONLY — a catchUp:true job with no desiredArtifact would have
  // no signal at all to decide "did this job reach its desired state?", so
  // that combination is now a schema error rather than a silent no-op.
  if (job.catchUp && !job.desiredArtifact) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "catchUp:true requires desiredArtifact to be set (the reconciler has no ledger fallback — see lib/cron/JobReconciler.ts)",
      path: ["desiredArtifact"],
    });
  }
});

export type JobSpec = z.infer<typeof JobSpecSchema>;
