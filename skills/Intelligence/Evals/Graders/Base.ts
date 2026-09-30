/**
 * Base Grader Interface
 * All graders implement this interface for consistent execution
 */

import type { GraderConfig, GraderResult, Transcript, GraderType } from '../Types/index.ts';

export interface GraderContext {
  task_id: string;
  trial_id: string;
  transcript: Transcript;
  output: string;  // Final output text
  working_dir?: string;
  reference?: string;  // Reference/golden output if available
  /**
   * The task's pass_threshold (Task.pass_threshold, YAML default 0.75 —
   * see Types/index.ts's Task interface doc comment). THE authoritative
   * score bar a trial's weighted-average grader score must clear to be
   * marked `passed` — see runGraders() below. Populated by the caller
   * (Tools/TrialRunner.ts's run()) from `task.pass_threshold`; runGraders()
   * itself falls back to 0.75 when omitted (Task's own documented
   * default), matching what direct callers (tests, one-off scripts) get
   * when they don't thread a task through.
   *
   * evals-rebuild slice B1: this REPLACES a hardcoded `>= 0.5` that
   * silently ignored every task's configured pass_threshold — real tasks
   * in the corpus set 0.80-0.90 and it was never respected (confirmed:
   * EvalExecutor.ts's suite-level "did the task pass" check also read a
   * `run.pass_threshold` property that never existed on EvalRun, always
   * silently falling back to a second, unrelated hardcoded 0.75 — see
   * EvalExecutor.ts's taskPassedInSuite() doc comment for how that
   * double-threshold bug was resolved by making THIS the one authoritative
   * place pass_threshold is applied).
   */
  pass_threshold?: number;
}

export abstract class BaseGrader {
  abstract type: GraderType;
  abstract category: 'code_based' | 'model_based' | 'human';

  /**
   * Whether this grader's grade() reads a live agent execution turn's
   * artifacts — context.output (the agent's final text) or
   * context.transcript (tool_calls / final_outcome) — as opposed to only
   * reading files/records that setup_commands already produced, or running
   * its own independent checks (test commands, static analysis, filesystem
   * state). Declared per grader class, checked against what grade()
   * actually touches — not inferred from grader type name or task id.
   *
   * EvalExecutor.ts's executeTask() uses this (via anyGraderReadsOutput())
   * to skip the live `claude -p` agent spawn entirely when NO grader
   * configured on a task needs it — e.g. the fixture_accuracy/nightly_judge
   * "static input" nets, where the real work already happened in
   * setup_commands and the grader only reads the record it wrote.
   */
  abstract readsOutput: boolean;

  protected config: GraderConfig;

  constructor(config: GraderConfig) {
    this.config = config;
  }

  /**
   * Execute the grader and return results
   */
  abstract grade(context: GraderContext): Promise<GraderResult>;

  /**
   * Get the weight for this grader
   */
  getWeight(): number {
    return this.config.weight ?? 1.0;
  }

  /**
   * Check if this grader is required (task fails if grader fails)
   */
  isRequired(): boolean {
    return this.config.required ?? false;
  }

  /**
   * Create a result object
   */
  protected createResult(
    score: number,
    passed: boolean,
    duration_ms: number,
    options?: {
      reasoning?: string;
      details?: Record<string, unknown>;
    }
  ): GraderResult {
    return {
      grader_type: this.type,
      weight: this.getWeight(),
      score,
      passed,
      duration_ms,
      reasoning: options?.reasoning,
      details: options?.details,
    };
  }
}

/**
 * Grader registry for dynamic instantiation
 */
const graderRegistry = new Map<GraderType, new (config: GraderConfig) => BaseGrader>();

export function registerGrader(type: GraderType, graderClass: new (config: GraderConfig) => BaseGrader): void {
  graderRegistry.set(type, graderClass);
}

export function createGrader(config: GraderConfig): BaseGrader {
  const GraderClass = graderRegistry.get(config.type);
  if (!GraderClass) {
    throw new Error(`Unknown grader type: ${config.type}`);
  }
  return new GraderClass(config);
}

export function listGraders(): GraderType[] {
  return Array.from(graderRegistry.keys());
}

export type GraderCategory = 'code_based' | 'model_based' | 'human';

/**
 * Resolve the registered grader class's declared `.category` for a type.
 * Instantiates a throwaway instance via the SAME createGrader() every other
 * call site uses — config content beyond `type` is irrelevant since
 * `category` is a fixed per-class field, not something grade() computes
 * from its params. Single source of truth for code/model/human bucketing:
 * EvalExecutor.ts's --quick filter, the smoke command's grader-distribution
 * report, and list-graders all derive from this (or listGradersByCategory()
 * below) — never hand-list grader type strings elsewhere to answer this
 * question (see evals-rebuild slice A6 / evals audit: the smoke command's
 * old hand-list only knew 2 of the 4 model-based types and miscategorized
 * nightly_judge as code-based).
 */
export function categoryOf(type: GraderType): GraderCategory {
  return createGrader({ type }).category;
}

/** Every registered grader type, bucketed by its declared .category. */
export function listGradersByCategory(): Record<GraderCategory, GraderType[]> {
  const buckets: Record<GraderCategory, GraderType[]> = {
    code_based: [],
    model_based: [],
    human: [],
  };
  for (const type of listGraders()) {
    buckets[categoryOf(type)].push(type);
  }
  return buckets;
}

/**
 * Whether ANY of the given grader configs need a live agent execution
 * turn's output/transcript to grade meaningfully. Resolves each config to
 * its registered grader class via createGrader() and reads that class's
 * static `readsOutput` declaration — this MUST stay the single source of
 * truth for the skip decision; never hand-maintain a list of grader types
 * or task ids elsewhere to answer this question.
 */
export function anyGraderReadsOutput(graderConfigs: GraderConfig[]): boolean {
  return graderConfigs.some(config => createGrader(config).readsOutput);
}

/**
 * Run multiple graders and aggregate results
 */
export async function runGraders(
  graders: BaseGrader[],
  context: GraderContext
): Promise<{ results: GraderResult[]; aggregate_score: number; passed: boolean }> {
  const results: GraderResult[] = [];
  let totalWeight = 0;
  let weightedSum = 0;
  let allRequiredPassed = true;

  for (const grader of graders) {
    const result = await grader.grade(context);
    results.push(result);

    // Aggregate
    const weight = grader.getWeight();
    totalWeight += weight;
    weightedSum += result.score * weight;

    // Check required
    if (grader.isRequired() && !result.passed) {
      allRequiredPassed = false;
    }
  }

  const aggregate_score = totalWeight > 0 ? weightedSum / totalWeight : 0;
  // THE authoritative pass_threshold application (see GraderContext.pass_threshold
  // doc comment) — falls back to Task's own documented default (0.75) when the
  // caller doesn't supply one, never the old hardcoded 0.5.
  const passThreshold = context.pass_threshold ?? 0.75;
  const passed = allRequiredPassed && aggregate_score >= passThreshold;

  return { results, aggregate_score, passed };
}
