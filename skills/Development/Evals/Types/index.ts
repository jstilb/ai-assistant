/**
 * Evals Type System
 * Based on Anthropic's "Demystifying Evals for AI Agents" (Jan 2026)
 *
 * Task, EvalSuite, GraderConfig, GraderType, EvalDomain, EvalType, and
 * MetricConfig are defined as zod schemas in Types/schemas.ts (the single
 * source of truth, validated at every load site — see evals-rebuild slice
 * A5) and re-exported here via z.infer so existing imports of
 * `from '../Types/index.ts'` keep working unchanged.
 */

export {
  GRADER_TYPES,
  GraderTypeSchema,
  EvalDomainSchema,
  EvalTypeSchema,
  GraderConfigSchema,
  TaskSchema,
  EvalSuiteSchema,
} from './schemas.ts';
// `import type` (not a bare `export type ... from`) so these names are also
// bound locally — GraderResult below references GraderType directly, which
// a re-export-only statement does not make available in this module's own
// scope.
import type {
  GraderType,
  EvalDomain,
  EvalType,
  GraderConfig,
  Task,
  EvalSuite,
  MetricConfig,
} from './schemas.ts';
export type {
  GraderType,
  EvalDomain,
  EvalType,
  GraderConfig,
  Task,
  EvalSuite,
  MetricConfig,
};

// =============================================================================
// TASK DEFINITION
// =============================================================================

export type TaskStatus = 'pending' | 'running' | 'passed' | 'failed' | 'error' | 'infra_failure';

// 'exec_error' = generic bucket for a machine-authored structured error
// signal (non-zero exitCode, or a stream-json result event's is_error:true)
// that doesn't match one of the more specific narrow signatures below.
// 'empty_response' is retained for historical persisted results but is no
// longer assigned by TrialRunner's classifier (see evals-rebuild slice A2 —
// classification is now exitCode/stderr/result-event based only, never a
// check of agent output text/length).
export type InfraFailureType = 'rate_limit' | 'timeout' | 'auth_error' | 'exec_error' | 'empty_response';

// Task, GraderType, and GraderConfig are defined in Types/schemas.ts and
// re-exported at the top of this file.

// =============================================================================
// GRADER CONFIGURATION
// =============================================================================

// Code-based grader params
export interface StringMatchParams {
  patterns: string[];
  mode: 'all' | 'any' | 'none_match';
  case_sensitive?: boolean;
}

export interface RegexMatchParams {
  patterns: string[];
  mode: 'all' | 'any' | 'none_match';
  flags?: string;
}

export interface BinaryTestsParams {
  test_files: string[];
  test_command?: string;  // Default: appropriate for language
  timeout_ms?: number;
}

// StateCheckParams moved to Graders/CodeBased/StateCheck.ts (evals-rebuild
// slice B3) — the per-grader params schema now lives WITH the grader as a
// zod `.strict()` schema (import from there if the type is needed).
// StaticAnalysisParams DELETED in the same slice along with the grader
// itself (see Types/schemas.ts's GRADER_TYPES doc comment).

export interface ToolCallsParams {
  required?: { tool: string; params?: Record<string, unknown> }[];
  forbidden?: string[];
  sequence?: string[];  // Tools must be called in this order
  max_calls?: number;
}

// Model-based grader params
export interface LLMRubricParams {
  rubric: string;  // Path to rubric file or inline content
  assertions?: string[];
  judge_model?: string;
  reasoning_first?: boolean;
  scale?: '1-5' | '1-10' | 'pass-fail';
}

export interface NaturalLanguageAssertParams {
  assertions: string[];
  judge_model?: string;
  require_all?: boolean;
}

// =============================================================================
// TRANSCRIPT / TRAJECTORY
// =============================================================================

export interface Transcript {
  task_id: string;
  trial_id: string;
  started_at: string;
  completed_at?: string;

  // Full conversation
  turns: Turn[];

  // Tool usage
  tool_calls: ToolCall[];

  // Reasoning traces (if agent exposes thinking)
  reasoning_traces?: string[];

  // Final state
  final_outcome?: unknown;

  // Computed metrics
  metrics: TranscriptMetrics;
}

export interface Turn {
  index: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_call?: ToolCall;
  timestamp: string;
  tokens?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
}

export interface TranscriptMetrics {
  n_turns: number;
  n_tool_calls: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  wall_time_ms: number;
  time_to_first_token_ms?: number;
  time_to_last_token_ms?: number;
  tokens_per_second?: number;
}

// =============================================================================
// TRIAL EXECUTION
// =============================================================================

export interface Trial {
  id: string;
  task_id: string;
  trial_number: number;

  status: TaskStatus;
  started_at: string;
  completed_at?: string;

  // Full transcript
  transcript: Transcript;

  // Grader results
  grader_results: GraderResult[];

  // Aggregate score
  score: number;
  passed: boolean;

  // Error info if failed
  error?: string;

  // Infrastructure failure classification
  infra_failure_type?: InfraFailureType;
}

export interface GraderResult {
  grader_type: GraderType;
  weight: number;

  score: number;  // 0-1
  passed: boolean;

  // Detailed output
  reasoning?: string;
  details?: Record<string, unknown>;

  // Timing
  duration_ms: number;
}

// =============================================================================
// EVALUATION RUN
// =============================================================================

export interface EvalRun {
  id: string;
  task_id: string;

  // Configuration
  model?: string;
  prompt_version?: string;

  // Trials
  trials: Trial[];
  n_trials: number;

  // Aggregate metrics
  pass_rate: number;
  mean_score: number;
  std_dev: number;

  // pass@k: P(at least 1 success in k trials) - measures capability
  pass_at_k: number;

  // pass^k: P(all k trials succeed) - measures consistency
  pass_to_k: number;

  // Infrastructure failure tracking
  infra_failures: number;

  // Timing
  started_at: string;
  completed_at?: string;
  total_duration_ms: number;

  // Metadata
  metadata?: Record<string, unknown>;
}

// =============================================================================
// METRIC CONFIGURATION
// =============================================================================

// MetricConfig is defined in Types/schemas.ts and re-exported at the top of
// this file.

// =============================================================================
// EVAL SUITE
// =============================================================================

// EvalSuite is defined in Types/schemas.ts and re-exported at the top of
// this file.

// =============================================================================
// HUMAN REVIEW
// =============================================================================

/** Human review status including queue-specific states */

