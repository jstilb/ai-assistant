/**
 * no-inline-secrets-file.ts — Architecture lint rule.
 *
 * Rule: only lib/core/Secrets.ts builds the secrets.json path (ADR-035).
 * Severity: ERROR
 *
 * Banned patterns (per line, *.ts under bin/ lib/ skills/ hooks/):
 *   - a string literal (double or single quotes) whose whole content is
 *     secrets.json, as in join(home, <literal>) or kayaHomePath(<literal>)
 *   - a template string that ends in ${…}/secrets.json or
 *     ${…}/.claude/secrets.json (the closing backtick right after the name)
 * A message that only mentions the file in prose ("add it to secrets.json")
 * does not match. (This header is worded so it does not match either.)
 *
 * Exempt:
 *   - lib/core/Secrets.ts (the one reader and writer)
 *   - test files (*.test.ts, *.spec.ts, __tests__/), plans/, node_modules/
 *   - ScaffoldCLI.ts: its generated-CLI template strings are emitted INTO
 *     self-contained CLIs that cannot import lib/core (same precedent as
 *     no-inline-kaya-home.ts)
 *   - SyncEngine.ts: its PublicSync exclude list must name the file
 *
 * Hand-off list: files another plan migrates. Each entry names its plan. A
 * listed file that no longer matches (or is gone) is an ERROR, so the entry
 * is removed when that plan lands and the list cannot go stale.
 *
 * The core (`lintSecretsFileSources`) is pure over (path, text); the tree
 * walk in `checkNoInlineSecretsFile` is a thin shell.
 *
 * Usage: called by lib/lint/run-all.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { grepTree } from "./StagedDiff.ts";

export interface LintResult {
  errors: string[];
  warnings: string[];
}

export interface SourceFile {
  /** Path relative to the repo root, with "/" separators. */
  path: string;
  text: string;
}

export const SCAN_ROOTS = ["bin", "lib", "skills", "hooks"] as const;

export const BANNED_PATTERNS: readonly RegExp[] = [/["']secrets\.json["']/, /\$\{[^}]*\}\/(\.claude\/)?secrets\.json`/];

/** Files another plan migrates. Remove an entry when its plan lands. */
export const HAND_OFFS: Readonly<Record<string, string>> = {};

const EXEMPT_FILES = new Set([
  "lib/core/Secrets.ts",
  "skills/Development/CreateCLI/Tools/ScaffoldCLI.ts",
  "skills/System/PublicSync/Tools/SyncEngine.ts",
]);
const EXEMPT_PATTERN = /\.(test|spec|e2e)\.(ts|tsx)$|(^|\/)__tests__\/|^plans\/|(^|\/)node_modules\//;

export function isExempt(path: string): boolean {
  return EXEMPT_FILES.has(path) || EXEMPT_PATTERN.test(path);
}

/** 1-based line numbers of `text` that match a banned pattern. */
export function matchingLines(text: string): number[] {
  const lines: number[] = [];
  text.split("\n").forEach((line, i) => {
    if (BANNED_PATTERNS.some((p) => p.test(line))) lines.push(i + 1);
  });
  return lines;
}

/**
 * Pure core. `sources` must include every hand-off file that exists; a
 * hand-off path absent from `sources` counts as gone (stale entry).
 */
export function lintSecretsFileSources(
  sources: Iterable<SourceFile>,
  handOffs: Readonly<Record<string, string>> = HAND_OFFS,
): LintResult {
  const errors: string[] = [];
  const matchedHandOffs = new Set<string>();

  for (const { path, text } of sources) {
    if (isExempt(path)) continue;
    const lines = matchingLines(text);
    if (lines.length === 0) continue;
    if (path in handOffs) {
      matchedHandOffs.add(path);
      continue;
    }
    for (const n of lines) {
      errors.push(
        `${path}:${n}: Inline secrets.json path. ` +
          `Use requireSecret/optionalSecret/requireSecretJson/updateSecrets from lib/core/Secrets.ts.`,
      );
    }
  }

  for (const [path, plan] of Object.entries(handOffs)) {
    if (!matchedHandOffs.has(path)) {
      errors.push(
        `${path}: stale hand-off entry (${plan}): the file no longer builds the secrets.json path. ` +
          `Remove it from HAND_OFFS in lib/lint/no-inline-secrets-file.ts.`,
      );
    }
  }

  return { errors, warnings: [] };
}

/** Tree shell: grep the scan roots for candidate files, read them, run the core. */
export async function checkNoInlineSecretsFile(rootDir: string = process.cwd()): Promise<LintResult> {
  const warnings: string[] = [];
  const paths = new Set<string>(Object.keys(HAND_OFFS).filter((p) => existsSync(join(rootDir, p))));

  for (const root of SCAN_ROOTS) {
    const dir = join(rootDir, root);
    if (!existsSync(dir)) continue;
    try {
      for (const line of grepTree("secrets\\.json", dir).split("\n")) {
        const file = line.split(":")[0];
        if (file) paths.add(file.replace(`${rootDir}/`, ""));
      }
    } catch (err) {
      // grepTree returns "" on no match; anything thrown means the scan did not run.
      warnings.push(
        `no-inline-secrets-file: grep failed in ${root}/, scan skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const sources = [...paths].map((path) => ({ path, text: readFileSync(join(rootDir, path), "utf-8") }));
  const result = lintSecretsFileSources(sources);
  return { errors: result.errors, warnings: [...warnings, ...result.warnings] };
}
