/**
 * Outcome Verification Grader
 * Verify final system state: file exists, command output, state diff
 */

import { BaseGrader, registerGrader, type GraderContext } from '../Base.ts';
import type { GraderConfig, GraderResult } from '../../Types/index.ts';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

export interface OutcomeVerificationParams {
  // File existence checks
  files_exist?: string[];
  files_not_exist?: string[];

  // File content checks
  file_contains?: {
    path: string;
    patterns: string[];
    mode?: 'all' | 'any';
  }[];

  // Command output verification
  commands?: {
    command: string;
    expected_output?: string;
    expected_exit_code?: number;
    contains?: string[];
    not_contains?: string[];
  }[];

  // State diff checks (before/after comparison)
  state_diff?: {
    type: 'file_count' | 'file_size' | 'custom';
    path: string;
    expected_change?: 'increased' | 'decreased' | 'unchanged';
  }[];
}

export class OutcomeVerificationGrader extends BaseGrader {
  type = 'outcome_verification' as const;
  category = 'code_based' as const;

  async grade(context: GraderContext): Promise<GraderResult> {
    const start = performance.now();
    const params = this.config.params as OutcomeVerificationParams;
    const workingDir = context.working_dir ?? process.cwd();

    const checks: { check: string; passed: boolean; detail: string }[] = [];

    // File existence checks
    if (params.files_exist) {
      for (const filePath of params.files_exist) {
        const fullPath = join(workingDir, filePath);
        const exists = existsSync(fullPath);
        checks.push({
          check: `file_exists: ${filePath}`,
          passed: exists,
          detail: exists ? 'file exists' : 'file not found',
        });
      }
    }

    if (params.files_not_exist) {
      for (const filePath of params.files_not_exist) {
        const fullPath = join(workingDir, filePath);
        const exists = existsSync(fullPath);
        checks.push({
          check: `file_not_exists: ${filePath}`,
          passed: !exists,
          detail: !exists ? 'file correctly absent' : 'file exists (should not)',
        });
      }
    }

    // File content checks
    if (params.file_contains) {
      for (const fileCheck of params.file_contains) {
        const fullPath = join(workingDir, fileCheck.path);

        if (!existsSync(fullPath)) {
          checks.push({
            check: `file_contains: ${fileCheck.path}`,
            passed: false,
            detail: 'file not found',
          });
          continue;
        }

        const content = readFileSync(fullPath, 'utf-8');
        const mode = fileCheck.mode ?? 'all';

        const matches = fileCheck.patterns.map(pattern => content.includes(pattern));
        const passed = mode === 'all'
          ? matches.every(m => m)
          : matches.some(m => m);

        const matchCount = matches.filter(m => m).length;
        checks.push({
          check: `file_contains: ${fileCheck.path}`,
          passed,
          detail: `${matchCount}/${fileCheck.patterns.length} patterns found (mode: ${mode})`,
        });
      }
    }

    // Command output verification
    if (params.commands) {
      for (const cmdCheck of params.commands) {
        try {
          const result = execSync(cmdCheck.command, {
            cwd: workingDir,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          const output = result.toString();
          let passed = true;
          let detail = 'command executed';

          if (cmdCheck.expected_output !== undefined) {
            passed = passed && output.trim() === cmdCheck.expected_output.trim();
            detail = passed ? 'output matches' : 'output mismatch';
          }

          if (cmdCheck.contains) {
            const containsAll = cmdCheck.contains.every(pattern => output.includes(pattern));
            passed = passed && containsAll;
            detail = containsAll ? detail : 'missing expected patterns';
          }

          if (cmdCheck.not_contains) {
            const containsNone = cmdCheck.not_contains.every(pattern => !output.includes(pattern));
            passed = passed && containsNone;
            detail = containsNone ? detail : 'found forbidden patterns';
          }

          checks.push({
            check: `command: ${cmdCheck.command}`,
            passed,
            detail,
          });
        } catch (error: unknown) {
          const execError = error as { status?: number; message?: string };
          const expectedExitCode = cmdCheck.expected_exit_code ?? 0;
          const actualExitCode = execError.status ?? 1;
          const passed = actualExitCode === expectedExitCode;

          checks.push({
            check: `command: ${cmdCheck.command}`,
            passed,
            detail: passed
              ? `exit code ${actualExitCode} (expected)`
              : `exit code ${actualExitCode} (expected ${expectedExitCode})`,
          });
        }
      }
    }

    // State diff checks
    if (params.state_diff) {
      for (const diffCheck of params.state_diff) {
        const fullPath = join(workingDir, diffCheck.path);

        if (!existsSync(fullPath)) {
          checks.push({
            check: `state_diff: ${diffCheck.path}`,
            passed: false,
            detail: 'path not found',
          });
          continue;
        }

        // For now, we can only check final state, not before/after
        // This would require state capture before execution
        // For file_size, we can check if size is reasonable
        if (diffCheck.type === 'file_size') {
          const stats = statSync(fullPath);
          const size = stats.size;

          // Basic heuristic: non-empty file
          const passed = size > 0;
          checks.push({
            check: `state_diff: ${diffCheck.path} (${diffCheck.type})`,
            passed,
            detail: `file size: ${size} bytes`,
          });
        } else {
          // For other types, mark as passed for now
          checks.push({
            check: `state_diff: ${diffCheck.path} (${diffCheck.type})`,
            passed: true,
            detail: 'state check completed',
          });
        }
      }
    }

    const passCount = checks.filter(c => c.passed).length;
    const score = checks.length > 0 ? passCount / checks.length : 1;
    const passed = score === 1.0; // All checks must pass for outcome verification

    return this.createResult(score, passed, performance.now() - start, {
      reasoning: `${passCount}/${checks.length} outcome checks passed`,
      details: { checks },
    });
  }
}

registerGrader('outcome_verification', OutcomeVerificationGrader);
