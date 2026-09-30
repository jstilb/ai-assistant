/**
 * EnsembleValidator — Calibration gate for the EnsembleLabelGrader.
 *
 * Runs the grader over known-truth fixtures, computes per-class agreement,
 * writes a calibration report to MEMORY/MONITORING/ensemble-calibration.json,
 * and returns a non-zero exit code if any class drops below 80% agreement.
 *
 * Usage:
 *   bun skills/Intelligence/Evals/Tools/EnsembleValidator.ts [--dry-run]
 *
 * --dry-run: injects a mock that always returns the expected label (proves
 *   the harness at 100% without making real LLM calls).
 *
 * LLM-free test surface: import `runValidation` with a custom `inferenceFn`.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { parse as parseYaml } from 'yaml';
import { EnsembleLabelGrader } from '../Graders/ModelBased/EnsembleLabel.ts';
import type { GraderConfig } from '../Types/index.ts';
import type { GraderContext } from '../Graders/Base.ts';
import type { InferenceResult } from '../../../../lib/core/Inference';
import { getKayaHome } from '../../../../lib/core/KayaHome.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ValidationCase {
  input: string;
  expected: string;
}

export interface BucketDefinition {
  system_prompt: string;
  candidate_field: string;
  cases: ValidationCase[];
}

export interface KnownTruthFixture {
  buckets: Record<string, BucketDefinition>;
}

export interface PerClassResult {
  agreement: number;
  n: number;
  wrong: number;
}

export interface FailedCase {
  decision_type: string;
  input: string;
  expected: string;
  got: string | null;  // null when divergent/abstain
}

export interface CalibrationReport {
  labeled_at: string;
  criteria_version: number;
  per_class: Record<string, PerClassResult>;
  overall_agreement: number;
  cases_failed: FailedCase[];
}

export interface ValidationResult {
  exitCode: number;       // 0 = all classes ≥ 80%; 1 = at least one class below threshold
  report: CalibrationReport;
  summary: string;        // Human-readable per-class summary
}

// ── Constants ─────────────────────────────────────────────────────────────────

const KAYA_HOME = getKayaHome();

// Fixture path: resolve relative to this source file so the validator works
// in both the live ~/.claude checkout and in git worktrees.
// import.meta.dir = .../skills/Intelligence/Evals/Tools
// fixture is at    .../skills/Intelligence/Evals/Data/ensemble-known-truth.yaml
const FIXTURE_PATH = join(import.meta.dir, '../Data/ensemble-known-truth.yaml');

// Calibration report always goes to the live MEMORY directory (shared).
const CALIBRATION_PATH = join(KAYA_HOME, 'MEMORY/MONITORING/ensemble-calibration.json');
const AGREEMENT_THRESHOLD = 0.80;

// ── Core logic (LLM-free testable) ────────────────────────────────────────────

export interface RunValidationOptions {
  /**
   * Injected inference function — use a mock in tests to avoid LLM calls.
   * If omitted, the grader uses the real `inference` from lib/core/Inference.
   */
  inferenceFn?: (opts: Parameters<import('../../../../lib/core/Inference').inference>[0]) => Promise<InferenceResult>;
  /** Path to the YAML fixture (defaults to FIXTURE_PATH) */
  fixturePath?: string;
  /** Where to write the calibration JSON (defaults to CALIBRATION_PATH) */
  reportPath?: string;
}

export async function runValidation(opts: RunValidationOptions = {}): Promise<ValidationResult> {
  const fixturePath = opts.fixturePath ?? FIXTURE_PATH;
  const reportPath = opts.reportPath ?? CALIBRATION_PATH;

  // Load fixture
  const raw = readFileSync(fixturePath, 'utf-8');
  const fixture = parseYaml(raw) as KnownTruthFixture;

  const perClass: Record<string, PerClassResult> = {};
  const failedCases: FailedCase[] = [];
  let totalCorrect = 0;
  let totalCases = 0;

  for (const [decisionType, bucket] of Object.entries(fixture.buckets)) {
    let correct = 0;
    const n = bucket.cases.length;

    for (const kase of bucket.cases) {
      // Build a grader for this case
      const config: GraderConfig = {
        type: 'ensemble_label',
        weight: 1.0,
        params: {
          system_prompt: bucket.system_prompt,
          candidate_field: bucket.candidate_field,
          input: kase.input,
        },
      };

      const grader = new EnsembleLabelGrader(config);

      // Inject custom inferenceFn when provided
      if (opts.inferenceFn) {
        grader.inferenceFn = opts.inferenceFn;
      }

      // Minimal context — the grader reads params.input, not context.output
      const context: GraderContext = {
        task_id: `calibration-${decisionType}`,
        trial_id: `case-${kase.input.slice(0, 20).replace(/\s/g, '-')}`,
        output: kase.input,
        transcript: {
          task_id: `calibration-${decisionType}`,
          trial_id: 'calibration',
          started_at: new Date().toISOString(),
          turns: [],
          tool_calls: [],
          metrics: {
            n_turns: 0,
            n_tool_calls: 0,
            total_tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
            wall_time_ms: 0,
          },
        },
      };

      const result = await grader.grade(context);

      const gotLabel = result.details?.divergent === true ? null : (result.details?.label as string | undefined) ?? null;
      const agreed = gotLabel === kase.expected;

      if (agreed) {
        correct++;
      } else {
        failedCases.push({
          decision_type: decisionType,
          input: kase.input,
          expected: kase.expected,
          got: gotLabel,
        });
      }
    }

    perClass[decisionType] = {
      agreement: n > 0 ? correct / n : 0,
      n,
      wrong: n - correct,
    };

    totalCorrect += correct;
    totalCases += n;
  }

  const overallAgreement = totalCases > 0 ? totalCorrect / totalCases : 0;

  const report: CalibrationReport = {
    labeled_at: new Date().toISOString(),
    criteria_version: 1,
    per_class: perClass,
    overall_agreement: overallAgreement,
    cases_failed: failedCases,
  };

  // Write calibration report
  const dir = dirname(reportPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  // Determine exit code
  const anyClassBelow = Object.values(perClass).some(
    (c) => c.agreement < AGREEMENT_THRESHOLD,
  );
  const exitCode = anyClassBelow ? 1 : 0;

  // Build human-readable summary
  const lines: string[] = ['', 'Ensemble Calibration Report', '='.repeat(40)];
  for (const [cls, stats] of Object.entries(perClass)) {
    const pct = (stats.agreement * 100).toFixed(1);
    const gate = stats.agreement >= AGREEMENT_THRESHOLD ? 'PASS' : 'FAIL';
    lines.push(`  ${cls.padEnd(16)} ${pct}%  (${stats.n - stats.wrong}/${stats.n})  [${gate}]`);
  }
  lines.push('-'.repeat(40));
  lines.push(`  ${'OVERALL'.padEnd(16)} ${(overallAgreement * 100).toFixed(1)}%  (${totalCorrect}/${totalCases})`);
  if (failedCases.length > 0) {
    lines.push('', 'Failed cases:');
    for (const fc of failedCases) {
      const input = fc.input.slice(0, 60).replace(/\n/g, '\\n');
      lines.push(`  [${fc.decision_type}] expected="${fc.expected}" got="${fc.got ?? 'divergent'}"  — "${input}"`);
    }
  }
  lines.push('', `Report written to: ${reportPath}`);
  lines.push(exitCode === 0 ? 'Result: ALL CLASSES PASSED (exit 0)' : 'Result: ONE OR MORE CLASSES BELOW 80% (exit 1)');
  lines.push('');

  const summary = lines.join('\n');

  return { exitCode, report, summary };
}

// ── CLI entry point ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');

  if (isDryRun) {
    console.log('[EnsembleValidator] --dry-run mode: using mock that returns expected labels');
  }

  // Build a dry-run mock that reads the fixture and echoes the expected label
  // for each case. The mock identifies the correct label by matching the
  // userPrompt to the case inputs in the loaded fixture.
  let dryRunMock: RunValidationOptions['inferenceFn'] | undefined;

  if (isDryRun) {
    const raw = readFileSync(FIXTURE_PATH, 'utf-8');
    const fixture = parseYaml(raw) as KnownTruthFixture;

    // Build a lookup: input text → expected label
    const lookup = new Map<string, string>();
    for (const bucket of Object.values(fixture.buckets)) {
      for (const kase of bucket.cases) {
        lookup.set(kase.input.trim(), kase.expected);
      }
    }

    dryRunMock = async (opts) => {
      const userPrompt = (opts.userPrompt ?? '').trim();
      const label = lookup.get(userPrompt) ?? 'unknown';
      // The ensemble grader expects the response parsed with the candidate_field.
      // We don't know which field at this level, but since we're injecting at
      // the grader level and the grader was constructed with a specific candidate_field,
      // we need to return the correct JSON. We'll return all possible fields.
      const parsed: Record<string, string> = {
        disposition: label,
        verdict: label,
        quality: label,
      };
      return {
        success: true,
        output: JSON.stringify(parsed),
        parsed,
        latencyMs: 1,
        level: opts.level ?? 'fast',
        estimatedTokens: { input: 10, output: 5, total: 15 },
        estimatedCostUSD: 0,
      };
    };
  }

  const result = await runValidation({ inferenceFn: dryRunMock });

  console.log(result.summary);

  process.exit(result.exitCode);
}

// Run CLI only when executed directly (not when imported by tests)
if (import.meta.main) {
  main().catch((err) => {
    console.error('[EnsembleValidator] Fatal error:', err);
    process.exit(2);
  });
}
