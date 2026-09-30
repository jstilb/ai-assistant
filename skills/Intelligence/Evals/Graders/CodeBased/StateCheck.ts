/**
 * State Check Grader
 * Verify system state after agent execution
 *
 * evals-rebuild slice B3: `params` is now zod-validated (`.strict()`) at
 * grade time instead of being blindly cast. The live bug this fixes (see
 * MEMORY/SkillAudits/evals-infra-audit-2026-07-09/graders.md finding #2):
 * every real historical task that configured this grader used a
 * `conditions: [...]` key — a key StateCheckParams never declared — which
 * the old `params as StateCheckParams` cast silently ignored. `checks`
 * stayed empty and the grader fell through to
 * `checks.length > 0 ? passCount/checks.length : 1` → score 1, passed
 * true, `"0/0 state checks passed"`. A task authored to actually verify
 * post-execution state therefore trivially, silently PASSED on every run.
 *
 * Now: an unrecognized param key throws loud, naming the offending key(s)
 * and the valid key set — never a silent ignore of a misconfigured task.
 * Zero configured checks (whether from an empty params object, or from
 * expect/check_files/check_env each resolving to zero real sub-checks,
 * e.g. `expect: {}`) is a hard FAIL with an explanatory reasoning string,
 * never a green "0/0 passed".
 */

import { BaseGrader, registerGrader, type GraderContext } from '../Base.ts';
import type { GraderResult } from '../../Types/index.ts';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';

// The per-grader params schema lives WITH the grader (not centralized in
// Types/index.ts) so the runtime-validated shape and the code that reads it
// can never drift apart — see the StaticAnalysisGrader/StateCheckGrader
// param-schema-mismatch finding above. `.strict()` is load-bearing: it's
// what turns an unrecognized key like the historical `conditions:` into a
// loud validation failure instead of a silently-ignored extra property.
const StateCheckParamsSchema = z
  .object({
    expect: z.record(z.string(), z.unknown()).optional(),
    check_files: z
      .array(
        z.object({
          path: z.string(),
          contains: z.array(z.string()).optional(),
          not_contains: z.array(z.string()).optional(),
        })
      )
      .optional(),
    check_env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type StateCheckParams = z.infer<typeof StateCheckParamsSchema>;

/**
 * Validate raw `params` against the strict schema. Throws a single loud
 * Error naming the offending key(s)/issue(s) and the full valid key set on
 * any unrecognized key or wrong-shaped value.
 */
function validateParams(raw: unknown): StateCheckParams {
  const result = StateCheckParamsSchema.safeParse(raw ?? {});
  if (result.success) return result.data;

  const validKeys = Object.keys(StateCheckParamsSchema.shape).join(', ');
  const issues = result.error.issues
    .map(issue =>
      issue.code === 'unrecognized_keys'
        ? `unknown param key(s): ${issue.keys.join(', ')}`
        : `${issue.path.join('.') || '(root)'}: ${issue.message}`
    )
    .join('; ');
  throw new Error(`StateCheckGrader: invalid params — ${issues}. Valid params: ${validKeys}.`);
}

export class StateCheckGrader extends BaseGrader {
  type = 'state_check' as const;
  category = 'code_based' as const;
  // checkState() reads context.transcript.final_outcome and, as a fallback
  // for the `expect` param, parses JSON out of context.output directly.
  readsOutput = true;

  async grade(context: GraderContext): Promise<GraderResult> {
    const start = performance.now();
    const params = validateParams(this.config.params);

    const checks: { check: string; passed: boolean; expected?: unknown; actual?: unknown }[] = [];
    const workingDir = context.working_dir ?? process.cwd();

    // Check expected state object (e.g., security_logs: {event_type: "auth_blocked"})
    if (params.expect) {
      for (const [key, expected] of Object.entries(params.expect)) {
        const checkResult = await this.checkState(key, expected, context);
        checks.push({
          check: `state.${key}`,
          passed: checkResult.passed,
          expected,
          actual: checkResult.actual,
        });
      }
    }

    // Check file contents
    if (params.check_files) {
      for (const fileCheck of params.check_files) {
        const filePath = join(workingDir, fileCheck.path);

        if (!existsSync(filePath)) {
          checks.push({
            check: `file.${fileCheck.path}`,
            passed: false,
            expected: 'file exists',
            actual: 'file not found',
          });
          continue;
        }

        const content = readFileSync(filePath, 'utf-8');

        // Check contains
        if (fileCheck.contains) {
          for (const pattern of fileCheck.contains) {
            const found = content.includes(pattern);
            checks.push({
              check: `file.${fileCheck.path}.contains`,
              passed: found,
              expected: pattern,
              actual: found ? 'found' : 'not found',
            });
          }
        }

        // Check not_contains
        if (fileCheck.not_contains) {
          for (const pattern of fileCheck.not_contains) {
            const found = content.includes(pattern);
            checks.push({
              check: `file.${fileCheck.path}.not_contains`,
              passed: !found,
              expected: `NOT: ${pattern}`,
              actual: found ? 'found (should not exist)' : 'not found (correct)',
            });
          }
        }
      }
    }

    // Check environment variables
    if (params.check_env) {
      for (const [key, expected] of Object.entries(params.check_env)) {
        const actual = process.env[key];
        checks.push({
          check: `env.${key}`,
          passed: actual === expected,
          expected,
          actual,
        });
      }
    }

    // Never a trivial "0/0 passed" green — zero configured/resolved checks
    // is a hard, explained failure (see module docblock).
    if (checks.length === 0) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning:
          'state_check grader has zero configured checks (expect/check_files/check_env were absent or resolved to zero real checks) — refusing to report a trivial pass. Configure at least one check.',
      });
    }

    const passCount = checks.filter(c => c.passed).length;
    const score = passCount / checks.length;
    const passed = passCount === checks.length;

    return this.createResult(score, passed, performance.now() - start, {
      reasoning: `${passCount}/${checks.length} state checks passed`,
      details: { checks },
    });
  }

  private async checkState(
    key: string,
    expected: unknown,
    context: GraderContext
  ): Promise<{ passed: boolean; actual?: unknown }> {
    // Check if expected state exists in the transcript's final outcome
    if (context.transcript.final_outcome) {
      const outcome = context.transcript.final_outcome as Record<string, unknown>;
      if (key in outcome) {
        const actual = outcome[key];
        const passed = this.deepEqual(actual, expected);
        return { passed, actual };
      }
    }

    // Also check in the output text for JSON-like patterns
    try {
      const jsonMatch = context.output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (key in parsed) {
          const actual = parsed[key];
          const passed = this.deepEqual(actual, expected);
          return { passed, actual };
        }
      }
    } catch {
      // Not valid JSON, continue
    }

    return { passed: false, actual: undefined };
  }

  private deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object' || a === null || b === null) return false;

    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;

    // For expected, check if all expected keys match (subset matching)
    for (const key of Object.keys(bObj)) {
      if (!(key in aObj)) return false;
      if (!this.deepEqual(aObj[key], bObj[key])) return false;
    }

    return true;
  }
}

registerGrader('state_check', StateCheckGrader);
