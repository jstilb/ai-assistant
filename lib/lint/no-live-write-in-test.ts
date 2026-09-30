/**
 * no-live-write-in-test.ts — Architecture lint rule.
 *
 * Rule: A *.test.ts / __tests__/*.ts file that imports a known live-state
 * writer (AlertManager, Remediator, HealthManager, HealthTracker,
 * SessionManager) must show some sign of pinning KAYA_HOME (via
 * pinKayaHome( from lib/test/pinKayaHome.ts, or a manual
 * `KAYA_HOME = ...` env assignment) somewhere in the file. Without a pin,
 * the module's frozen/default write path resolves to the real
 * ~/.claude/MEMORY/* tree under `bun test` — exactly the disease Track C of
 * the alert-storm remediation plan sealed (fake CRITICAL alerts, 237 fake
 * rating rows, 805 junk session files, real push notifications that really
 * fired).
 *
 * Severity: WARNING (non-blocking). This is the mirror image of
 * no-inline-kaya-home.ts, which EXEMPTS test files by design (tests are
 * expected to construct their own scratch KAYA_HOME paths) — this rule
 * instead flags test files that import a live writer but show no sign of
 * ever redirecting it away from the live tree.
 *
 * Known accepted false-positive class: a test that redirects writes via a
 * per-call path override (e.g. AlertManager's `alertsLogPath` /
 * Remediator's `remediationLogPath` constructor/call options) instead of a
 * global KAYA_HOME pin will still trip this rule, since the override
 * pattern leaves no `pinKayaHome(`/`KAYA_HOME =` marker in the file text.
 * That is an accepted cost of a cheap, WARNING-tier heuristic — promotion
 * to hard-fail (which would need a smarter per-writer override check) is a
 * later initiative, matching the inline-KAYA_HOME rollout precedent
 * (grandfathered soft-launch before hard-fail promotion).
 *
 * Two modes, mirroring no-inline-kaya-home.ts / no-inline-kaya-home-staged.ts:
 *   - checkNoLiveWriteInTest(rootDir)   — full-tree scan of every
 *                                         *.test.ts / __tests__/*.ts file.
 *   - checkNoLiveWriteInTestStaged      — staged-diff twin, in the sibling
 *     (no-live-write-in-test-staged.ts)  file, used by pre-commit
 *                                         (bin/lint-live-write-staged.sh).
 *
 * Usage: intended for lib/lint/run-all.ts (full-tree) once wired in by the
 * orchestrator; the staged twin is invoked directly by its bin/ wrapper.
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';

export interface LintResult {
  errors: string[];
  warnings: string[];
}

/** Known live-state writers this rule watches for. */
export const LIVE_WRITER_NAMES = [
  'AlertManager',
  'Remediator',
  'HealthManager',
  'HealthTracker',
  'SessionManager',
] as const;

const TEST_FILE_PATTERN = /(\.test\.ts$)|(__tests__\/.*\.ts$)/;

/**
 * Returns the subset of LIVE_WRITER_NAMES that `content` imports via an ES
 * `from '...'` / `from "..."` specifier ending in that module name (with or
 * without a trailing `.ts`). Exported so the staged twin can reuse it.
 */
export function importsLiveWriter(content: string): string[] {
  const hits: string[] = [];
  for (const name of LIVE_WRITER_NAMES) {
    const re = new RegExp(`from\\s+['"][^'"]*\\b${name}(\\.ts)?['"]`);
    if (re.test(content)) hits.push(name);
  }
  return hits;
}

/**
 * True when `content` shows NO sign of ever pinning KAYA_HOME — neither a
 * `pinKayaHome(` call nor a manual `KAYA_HOME = ...` assignment appears
 * anywhere in the file.
 */
export function hasNoKayaHomePin(content: string): boolean {
  if (content.includes('pinKayaHome(')) return false;
  if (/KAYA_HOME\s*=/.test(content)) return false;
  return true;
}

export function violationMessage(relativePath: string, writers: string[]): string {
  return (
    `${relativePath}: imports live-state writer(s) [${writers.join(', ')}] but never calls ` +
    `pinKayaHome( or assigns KAYA_HOME = anywhere in the file. Without a pin, this suite may ` +
    `write real state to ~/.claude/MEMORY/* under \`bun test\` (see Track C, alert-storm ` +
    `remediation plan). If this file already redirects writes via a per-call path override ` +
    `(e.g. alertsLogPath/remediationLogPath), this is a known accepted false-positive for this ` +
    `WARNING-tier gate.`
  );
}

function isExempt(relativePath: string): boolean {
  if (relativePath.includes('node_modules/') || relativePath.includes('worktrees/')) return true;
  // Exempt this rule's own files (including its test, which legitimately
  // contains the writer names as string literals rather than real imports).
  if (relativePath.includes('lib/lint/')) return true;
  return false;
}

/**
 * Full-tree scan: every *.test.ts / __tests__/*.ts file under rootDir.
 */
export async function checkNoLiveWriteInTest(rootDir: string = process.cwd()): Promise<LintResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // NOTE: deliberately does NOT prune "*/worktrees/*" at the find level —
  // this repo's own convention checks out worktrees under
  // <repo>/.claude/worktrees/<branch>/, so rootDir itself is routinely
  // nested under a path containing "worktrees" (every session that runs
  // this lint from inside its own worktree would otherwise match that
  // absolute-path prune and silently enumerate ZERO files). The relative-path
  // isExempt() check below still excludes a genuinely NESTED worktree
  // checkout living inside the scanned tree.
  let fileListOutput: string;
  try {
    fileListOutput = execSync(
      `find "${rootDir}" \\( -name "*.test.ts" -o -path "*/__tests__/*.ts" \\) ` +
        `-not -path "*/node_modules/*" 2>/dev/null || true`,
      { encoding: 'utf-8', cwd: rootDir, maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (err) {
    warnings.push(`[no-live-write-in-test] Could not enumerate test files: ${err}`);
    return { errors, warnings };
  }

  const files = fileListOutput
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && TEST_FILE_PATTERN.test(f));

  for (const filePath of files) {
    const relativePath = filePath.startsWith(rootDir + '/') ? filePath.slice(rootDir.length + 1) : filePath;
    if (isExempt(relativePath)) continue;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const writers = importsLiveWriter(content);
    if (writers.length === 0) continue;
    if (hasNoKayaHomePin(content)) {
      warnings.push(violationMessage(relativePath, writers));
    }
  }

  return { errors, warnings };
}
