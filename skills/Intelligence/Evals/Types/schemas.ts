/**
 * Zod Schemas — Single Source of Truth for Task + EvalSuite shapes
 *
 * evals-rebuild slice A5: consolidates what were THREE independently
 * hand-maintained shapes (Types/index.ts's plain TS interface,
 * EvalExecutor.ts's own loose inline zod schema, TaskValidator.ts's own
 * separate strict zod schema) into ONE zod schema per entity, validated at
 * every load site (EvalExecutor.loadTaskConfig, SuiteManager.loadSuite,
 * TaskValidator.validateTask). See
 * MEMORY/SkillAudits/evals-infra-audit-2026-07-09/engine.md REDESIGN
 * OPPORTUNITIES #1 and FINDINGS #1/#4.
 *
 * Field shapes here are derived from the REAL kept corpus (16 UseCases task
 * yamls + 3 Suites yamls, post evals-rebuild slice A3b corpus retirement)
 * plus what EvalExecutor.ts / TrialRunner.ts / Graders/*.ts actually read
 * off a parsed Task/EvalSuite object — not a re-statement of an old
 * aspirational shape. Notably:
 *   - Task.notes is a real, widely-used field (7+ of the 16 kept task
 *     yamls) that was never typed before (silently dropped by any schema
 *     that didn't use .passthrough()).
 *   - EvalSuite.created_at is OPTIONAL here — kaya-pipeline-nightly.yaml,
 *     the production nightly regression gate, has no created_at field at
 *     all, though the old TS interface incorrectly marked it required.
 *   - EvalSuite gained `version` (present on kaya-pipeline-nightly.yaml)
 *     and `tags` (present on 2 of 3 kept suites) — neither was in the old
 *     interface.
 *
 * Types/index.ts re-exports the TS types below via z.infer so the rest of
 * the codebase keeps importing Task/EvalSuite/GraderConfig/GraderType from
 * Types/index.ts exactly as before — only the definitions moved here.
 */

import { z } from 'zod';

// ============================================================================
// Grader type enum
// ============================================================================

/**
 * The 10 grader types actually registered in Graders/Base.ts's registry as
 * of evals-rebuild slice B2 (6 code-based + 4 model-based — confirmed live
 * via `listGraders()` after importing Graders/CodeBased/index.ts +
 * Graders/ModelBased/index.ts; see the cross-check test in
 * Graders/__tests__/Base.test.ts). Kept as a static literal list here
 * rather than importing listGraders() directly: Types/schemas.ts is a leaf
 * module imported by nearly everything (including Graders/Base.ts itself,
 * via a type-only import that's erased at compile time — so importing
 * listGraders() from here would NOT create a real circular import), but the
 * registry is only populated by a RUNTIME side-effect (importing the 10
 * concrete grader implementation files, several of which pull in
 * lib/core/Inference.ts and friends). Eagerly triggering that from a types
 * module just to build an enum would invert the intended dependency
 * direction (Types depending on the entire Graders implementation tree for
 * a value no more "live" than this literal list, since it would still be a
 * snapshot fixed at whatever moment this module first loads). The live
 * cross-check lives in a test instead: it asserts listGraders() (post
 * grader-index import) matches this exact set, so registry drift in EITHER
 * direction (a type here with no registered class, or a registered class
 * missing from this list) fails a test instead of silently diverging — see
 * findings #3/#7 in the evals audit for the drift class this guards
 * against.
 *
 * evals-rebuild slice B3: `static_analysis` DELETED (13 -> 12 types). Per
 * the audit (graders.md finding #2 + #8 + DETERMINISM AUDIT), it was
 * structurally unpassable (its params never matched any real task's config,
 * same param-schema-mismatch class as state_check) AND classified
 * pass/fail by regex-scanning command output for the words "error"/
 * "warning" instead of reading the process exit code it already captured.
 * Its only real users were retired in slice A3b, and its concept (run a
 * command, check whether it succeeded) is exactly what `binary_tests`
 * already covers correctly via exit code. See
 * Graders/CodeBased/StaticAnalysis.ts in git history if reviving.
 *
 * evals-rebuild slice B2 (Jm's ruling R1 — voice/format grading goes 100%
 * LLM): `response_format_check` and `voice_line_check` DELETED (12 -> 10
 * types). Per the audit (graders.md finding #9 / DETERMINISM AUDIT row
 * 'voice_line_check': word-count ceiling and a ~20-regex filler-phrase
 * blocklist were semantic style judgment dressed as deterministic checks).
 * Both graders' only task usages (kaya_voice_line_word_count,
 * kaya_voice_line_factual) were replaced by ONE natural_language_assert-
 * graded task, kaya_voice_line_quality (UseCases/Kaya/
 * task_voice_line_quality.yaml), proven against a 16-case golden fixture
 * set (Data/golden/voice-line-quality-fixtures.jsonl) BEFORE this deletion
 * per the golden-fixture-before-deletion doctrine — see the B2 build report
 * for the full judge-vs-fixture agreement table. `response_format_check`
 * had zero real task usages left by this point (its only prior consumer,
 * task_full_format_compliance.yaml, was retired in slice A3b) — confirmed
 * via `grep -rn "response_format_check" UseCases/ Suites/` returning no
 * hits before deletion. See Graders/CodeBased/ResponseFormatCheck.ts and
 * VoiceLineCheck.ts in git history if reviving.
 */
export const GRADER_TYPES = [
  // Code-based (fast, deterministic)
  'string_match',
  'regex_match',
  'binary_tests',
  'state_check',
  'tool_calls',
  // Code-based (custom, Kaya-specific)
  'fixture_accuracy',
  // Model-based (flexible, nuanced)
  'llm_rubric',
  'natural_language_assert',
  // Model-based (custom, Kaya-specific)
  'ensemble_label',
  'nightly_judge',
] as const;

export const GraderTypeSchema = z.enum(GRADER_TYPES);
export type GraderType = z.infer<typeof GraderTypeSchema>;

// ============================================================================
// Shared enums
// ============================================================================

export const EvalDomainSchema = z.enum(['coding', 'conversational', 'research', 'computer_use', 'general']);
export type EvalDomain = z.infer<typeof EvalDomainSchema>;

export const EvalTypeSchema = z.enum(['capability', 'regression']);
export type EvalType = z.infer<typeof EvalTypeSchema>;

// ============================================================================
// Grader config
// ============================================================================

export const GraderConfigSchema = z.object({
  type: GraderTypeSchema,
  weight: z.number().min(0).max(10).optional(),
  required: z.boolean().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type GraderConfig = z.infer<typeof GraderConfigSchema>;

// ============================================================================
// Task
// ============================================================================

const TaskSetupSchema = z.object({
  sandbox: z.boolean().optional(),
  git_repo: z.string().optional(),
  checkout: z.string().optional(),
  working_dir: z.string().optional(),
  env_vars: z.record(z.string(), z.string()).optional(),
  timeout_ms: z.number().positive().optional(),
  /** User prompt to send to model (overrides description for comparison tasks) */
  scenario_prompt: z.string().optional(),
  /** Git ref for baseline comparison (e.g., "pre-streamline") */
  baseline_ref: z.string().optional(),
  /** Trial isolation mode */
  isolation: z.enum(['sandbox', 'shared', 'none']).optional(),
  /** Shell commands to run in the working directory before the task executes */
  setup_commands: z.array(z.string()).optional(),
  /**
   * Escape hatch for the destructive-scenario guard (evals-rebuild slice B6
   * — Tools/DestructiveScenarioGuard.ts). A task whose scenario_prompt or
   * setup_commands legitimately need to combine a destructive verb (rm -rf,
   * git reset --hard, DROP TABLE, etc. — see the guard's pattern list) with
   * a REAL absolute path declares that path here, mapped to a
   * materialization mode. Before the guard scans, the executor copies the
   * real path into the trial's sandbox and rewrites every literal
   * occurrence of the real path in scenario_prompt/setup_commands to point
   * at the sandbox copy instead — the agent (and any setup_commands) then
   * only ever touches the copy, never the real path. Keys are real absolute
   * (or `~/`-prefixed) paths exactly as they appear in the prompt text;
   * 'copy' is the only supported mode today (a full recursive copy via
   * fs.cpSync) — deliberately minimal, not a general VFS. See
   * MEMORY/SkillAudits/evals-infra-audit-2026-07-09/liverun.md finding 4 for
   * the incident this guards against.
   */
  sandbox_paths: z.record(z.string(), z.enum(['copy'])).optional(),
}).optional();

const MetricConfigSchema = z.object({
  type: z.enum(['transcript', 'latency', 'custom']),
  metrics: z.array(z.string()),
});
export type MetricConfig = z.infer<typeof MetricConfigSchema>;

export const TaskSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  type: EvalTypeSchema,
  domain: EvalDomainSchema,

  // Environment setup
  setup: TaskSetupSchema,

  // Grader configuration
  graders: z.array(GraderConfigSchema).min(1),

  // Tracked metrics
  tracked_metrics: z.array(MetricConfigSchema).optional(),

  // Trial configuration
  trials: z.number().int().positive().optional(),
  pass_threshold: z.number().min(0).max(1).optional(),

  // Reference solution (proves solvability)
  reference_solution: z.string().optional(),

  // Tags for filtering
  tags: z.array(z.string()).optional(),

  // Metadata
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  source: z.enum(['manual', 'failure_log', 'generated', 'simulation']).optional(),

  /** Free-form authoring notes (red/green evidence, known limitations, live
   *  wiring TODOs). Not consumed by any loader — a real field on most of
   *  the 16 kept task yamls, previously untyped. */
  notes: z.string().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

// ============================================================================
// Eval Suite
// ============================================================================

export const EvalSuiteSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),

  /** Present on kaya-pipeline-nightly.yaml; not on the old TS interface. */
  version: z.string().optional(),

  type: EvalTypeSchema,
  domain: EvalDomainSchema.optional(),

  tasks: z.array(z.string()), // Task IDs

  // Suite-level thresholds
  pass_threshold: z.number().min(0).max(1).optional(),

  /** Present on 2 of 3 kept suite files; not on the old TS interface. */
  tags: z.array(z.string()).optional(),

  /** OPTIONAL, not required: kaya-pipeline-nightly.yaml — the production
   *  nightly regression gate — has no created_at field. The old TS
   *  interface incorrectly marked this required. */
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type EvalSuite = z.infer<typeof EvalSuiteSchema>;
