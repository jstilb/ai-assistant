/**
 * no-inline-kaya-home.ts — Architecture lint rule.
 *
 * Rule: Ban inline Kaya home path construction
 * Severity: ERROR
 * Exempt file: lib/core/KayaHome.ts
 *
 * Status: HARD-FAIL (no longer grandfathered). The full-tree burn-down
 * completed 2026-07-07 (plans/inline-kaya-home-burndown-2026-07.md) — every
 * Kaya-owned site now routes through getKayaHome()/defaultKayaHome(), so this
 * full-tree scan returns zero errors and run-all.ts enforces it. The only
 * exemptions are (1) vendored third-party plugin caches and (2) ScaffoldCLI's
 * generated-CLI template strings (self-contained generated code that cannot
 * import lib/core) — see the exemption block below. Any new inline site is a
 * genuine error; the staged gate (no-inline-kaya-home-staged.ts) blocks new
 * sites at commit time.
 *
 * Banned patterns:
 *   - process.env.HOME + "/.claude"
 *   - join(homedir(), '.claude')
 *   - join(process.env.HOME, ...)
 *   - process.env.KAYA_DIR || (followed by path join)
 *   - process.env.KAYA_HOME || (followed by path join)
 *
 * Usage: called by lib/lint/run-all.ts
 */

import { execSync } from 'child_process';

export interface LintResult {
  errors: string[];
  warnings: string[];
}

const EXEMPT_FILE = 'lib/core/KayaHome.ts';
const TEST_PATTERN = /\.(test|spec)\.(ts|tsx)$|__tests__\//;

/** Patterns that indicate inline Kaya home construction */
export const BANNED_PATTERNS = [
  `process\\.env\\.HOME.*\\/\\.claude`,
  `join\\(homedir\\(\\).*\\.claude`,
  `join\\(process\\.env\\.HOME.*\\.claude`,
  `process\\.env\\.KAYA_DIR\\s*\\|\\|`,
  `process\\.env\\.KAYA_HOME\\s*\\|\\|`,
  `"\\/Users\\/[^"]*\\/\\.claude"`,  // hardcoded absolute paths
];

export async function checkNoInlineKayaHome(rootDir: string = process.cwd()): Promise<LintResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const pattern of BANNED_PATTERNS) {
    try {
      const output = execSync(
        `grep -rn -E "${pattern}" "${rootDir}" --include="*.ts" --include="*.tsx" 2>/dev/null || true`,
        { encoding: 'utf-8', cwd: rootDir }
      );

      const lines = output.split('\n').filter(l => l.trim());

      for (const line of lines) {
        const [filePart] = line.split(':');
        if (!filePart) continue;

        const relativePath = filePart.replace(rootDir + '/', '');

        // Exempt: KayaHome.ts itself
        if (relativePath === EXEMPT_FILE || relativePath.endsWith(EXEMPT_FILE)) {
          continue;
        }

        // Exempt: test files
        if (TEST_PATTERN.test(relativePath)) {
          continue;
        }

        // Exempt: node_modules, worktrees (other branches)
        if (relativePath.includes('node_modules/') || relativePath.includes('worktrees/')) {
          continue;
        }

        // Exempt: this lint file itself
        if (relativePath.includes('lib/lint/')) {
          continue;
        }

        // Exempt: vendored third-party plugin caches (Claude Code plugin
        // cache + marketplace — gitignored, updated out-of-band, not Kaya
        // source; present on disk in the main checkout but never committed and
        // absent from worktrees). Like node_modules, they are not ours to fix.
        if (relativePath.includes('plugins/cache/') || relativePath.includes('plugins/marketplaces/')) {
          continue;
        }

        // Exempt: ScaffoldCLI's generated-CLI template strings. The two flagged
        // lines are SOURCE CODE emitted INTO standalone scaffolded CLIs, which
        // are self-contained and cannot import lib/core/KayaHome.ts — a
        // self-contained generated CLI has no way to construct its kaya-home
        // path without matching a banned pattern. Same rationale as the file's
        // existing appendFileSync exemption. Anchored on the generated-audit
        // path signature ("cli-audit.jsonl") so it survives line-number drift
        // and never exempts real code in the generator itself.
        if (relativePath.endsWith('CreateCLI/Tools/ScaffoldCLI.ts') && line.includes('cli-audit.jsonl')) {
          continue;
        }

        errors.push(
          `${line}: Inline Kaya home path construction. ` +
          `Use getKayaHome() from lib/core/KayaHome.ts instead.`
        );
      }
    } catch {
      // grep exits non-zero when no matches — that's fine
    }
  }

  // Deduplicate errors (a file might match multiple patterns)
  const seen = new Set<string>();
  const deduped = errors.filter(e => {
    const key = e.split(':')[0] + ':' + e.split(':')[1];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { errors: deduped, warnings };
}
