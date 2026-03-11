/**
 * Evals Type System
 * Based on Anthropic's "Demystifying Evals for AI Agents" (Jan 2026)
 */

// =============================================================================
// TASK DEFINITION
// =============================================================================

export type EvalDomain = 'coding' | 'conversational' | 'research' | 'computer_use' | 'general';
export type EvalType = 'capability' | 'regression';
export type TaskStatus = 'pending' | 'running' | 'passed' | 'failed' | 'error' | 'infra_failure';

export type InfraFailureType = 'rate_limit' | 'timeout' | 'auth_error' | 'empty_response';

export interface Task {
  id: string;
  description: string;
  type: EvalType;
  domain: EvalDomain;

  // Environment setup
  setup?: {
    sandbox?: boolean;
    git_repo?: string;
    checkout?: string;
    working_dir?: string;
    env_vars?: Record<string, string>;
    timeout_ms?: number;
    /** User prompt to send to model (overrides description for comparison tasks) */
    scenario_prompt?: string;
    /** Git ref for baseline comparison (e.g., "pre-streamline") */
    baseline_ref?: string;
    /** Trial isolation mode */
    isolation?: 'sandbox' | 'shared' | 'none';
    /** Shell commands to run in the working directory before the task executes */
    setup_commands?: string[];
  };

  // Grader configuration
  graders: GraderConfig[];

  // Tracked metrics
  tracked_metrics?: MetricConfig[];

  // Trial configuration
  trials?: number;  // Default: 1
  pass_threshold?: number;  // Default: 0.75

  // Reference solution (proves solvability)
  reference_solution?: string;

  // Tags for filtering
  tags?: string[];

  // Metadata
  created_at?: string;
  updated_at?: string;
  source?: 'manual' | 'failure_log' | 'generated';
}

// =============================================================================
// GRADER CONFIGURATION
// =============================================================================

export type GraderType =
  // Code-based (fast, deterministic)
  | 'string_match'
  | 'regex_match'
  | 'binary_tests'
  | 'static_analysis'
  | 'state_check'
  | 'tool_calls'
  | 'json_schema'
  | 'outcome_verification'
  // Code-based (custom, Kaya-specific)
  | 'response_format_check'
  | 'voice_line_check'
  | 'team_coordination'
  | 'context_efficiency_check'
  // Model-based (flexible, nuanced)
  | 'llm_rubric'
  | 'natural_language_assert'
  | 'pairwise_comparison'
  | 'reference_comparison'
  // Model-based (custom, Kaya-specific)
  | 'identity_consistency';

export interface GraderConfig {
  type: GraderType;
  weight?: number;  // Default: 1.0
  required?: boolean;  // If true, task fails if this grader fails

  // Type-specific params
  params?: Record<string, unknown>;
}

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

export interface StaticAnalysisParams {
  commands: string[];  // e.g., ['ruff', 'mypy', 'bandit']
  fail_on_warning?: boolean;
}

export interface StateCheckParams {
  expect: Record<string, unknown>;
  check_files?: { path: string; contains?: string[]; not_contains?: string[] }[];
  check_env?: Record<string, string>;
}

export interface ContextEfficiencyCheckParams {
  expected_profile?: string;
  expected_profiles?: string[];
  require_budget_compliance?: boolean;
  max_tokens?: number;
  required_files?: string[];
  excluded_files?: string[];
  max_classification_stage?: string;
  min_confidence?: number;
}

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

export interface PairwiseComparisonParams {
  reference: string;  // Path to reference output
  judge_model?: string;
  position_swap?: boolean;
  criteria?: string[];
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

export interface MetricConfig {
  type: 'transcript' | 'latency' | 'custom';
  metrics: string[];
}

// =============================================================================
// EVAL SUITE
// =============================================================================

export interface EvalSuite {
  name: string;
  description: string;
  type: EvalType;
  domain?: EvalDomain;

  tasks: string[];  // Task IDs

  // Suite-level thresholds
  pass_threshold?: number;
  saturation_threshold?: number;  // When to graduate to regression

  // Metadata
  created_at: string;
  updated_at?: string;
}

// =============================================================================
// SATURATION MONITORING
// =============================================================================

export interface SaturationStatus {
  suite_id: string;
  pass_rate_history: { date: string; rate: number }[];
  saturated: boolean;
  consecutive_above_threshold: number;
  recommended_action: 'graduate_to_regression' | 'add_harder_cases' | 'keep';
  trend_direction?: 'improving' | 'plateaued' | 'declining';
  confidence_interval?: { lower: number; upper: number };
  regression_stats?: { slope: number; r_squared: number };
}

// =============================================================================
// HUMAN REVIEW
// =============================================================================

/** Human review status including queue-specific states */

// =============================================================================
// FAILURE LOG (for converting failures to tasks)
// =============================================================================

export interface FailureLog {
  id: string;
  timestamp: string;

  description: string;
  category: string;
  severity: 'low' | 'medium' | 'high' | 'critical';

  // Context
  task_context?: string;
  expected_behavior?: string;
  actual_behavior?: string;

  // Transcript if available
  transcript?: Transcript;

  // Conversion status
  converted_to_task?: string;  // Task ID if converted
}

