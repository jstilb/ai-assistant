/**
 * TaskUtils - Task id -> UseCases/*.yaml path resolution.
 *
 * evals-rebuild slice A6: replaces the old findTaskFile() FILENAME-GUESSING
 * strategy (try the raw task id as a filename, then a "task_" + suffix
 * variant with the domain prefix stripped) with a real id -> path index:
 * scan every UseCases/**\/*.yaml file, parse its `id:` field, and build a
 * Map<id, path>. The guessing strategy could never resolve an id whose
 * filename doesn't match either candidate pattern — e.g.
 * kaya_specsheet_spec_quality_judge's real file is
 * UseCases/SpecSheet/spec-quality-judge.yaml, which matches neither "the
 * raw id" nor "task_" + the id's suffix after its first underscore. See
 * MEMORY/SkillAudits/evals-infra-audit-2026-07-09/engine.md and
 * evals-rebuild slice A5's KNOWN LIMITATION note on the old findTaskFile
 * (removed by this slice).
 *
 * Originally extracted (slice A5) from triplicated findTaskFile/
 * collectSearchDirs implementations in EvalExecutor.ts and TaskValidator.ts
 * (a third, generate-comparison-report.ts, was deleted in slice A3b).
 * EvalExecutor.ts additionally carried its OWN private, un-imported
 * duplicate of findTaskFile/collectSearchDirs (slice A6 deleted it — see
 * EvalExecutor.ts, which now imports findTaskFile from here like
 * SuiteManager.ts always has).
 */

import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

const EVALS_DIR = join(import.meta.dir, '../..');
export const USECASES_DIR = join(EVALS_DIR, 'UseCases');

/**
 * Recursively collect every `.yaml` file under `root`, at any depth.
 * Today's UseCases/ layout is exactly one level deep (UseCases/<Category>/
 * <file>.yaml), but this walks arbitrarily deep so a future nested layout
 * (e.g. a Tasks/ subfolder) is picked up automatically — no hand-maintained
 * list of directories to search.
 */
function collectYamlFiles(root: string): string[] {
  const files: string[] = [];
  if (!existsSync(root)) return files;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = join(root, entry);
    let isDir: boolean;
    try {
      isDir = statSync(fullPath).isDirectory();
    } catch {
      continue; // skip inaccessible entries
    }
    if (isDir) {
      files.push(...collectYamlFiles(fullPath));
    } else if (entry.endsWith('.yaml')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Build the id -> path index for a UseCases/ directory by parsing every
 * yaml file's `id:` field.
 *
 * Files that fail to parse, or that have no string `id:` field, are
 * silently skipped here — TaskSchema validation (Types/schemas.ts, applied
 * by loadTaskConfig/validateTask at the actual load site) is what reports a
 * malformed task file loudly; this index only needs to know where a
 * DECLARED id points.
 *
 * Two files declaring the SAME id is corruption, not something to silently
 * pick a winner for: throws immediately, naming both paths, the moment a
 * duplicate is found.
 */
function buildTaskIndex(useCasesDir: string): Map<string, string> {
  const index = new Map<string, string>();
  for (const filePath of collectYamlFiles(useCasesDir)) {
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(filePath, 'utf-8'));
    } catch {
      continue; // malformed YAML — not this index's concern, skip
    }
    const id = (parsed as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !id) continue;

    const existing = index.get(id);
    if (existing) {
      throw new Error(
        `Duplicate task id "${id}": both ${existing} and ${filePath} declare it. ` +
        `Task ids must be unique across UseCases/ — rename one of the two files' id field.`
      );
    }
    index.set(id, filePath);
  }
  return index;
}

let cachedIndex: Map<string, string> | null = null;
let cachedDir: string | null = null;

/**
 * Get the id -> path index for `useCasesDir`, building + caching it on the
 * first call (per-process cache, keyed by directory). Rebuilds
 * automatically when called with a different directory than what's cached;
 * for the SAME directory whose on-disk contents changed since the last
 * build (only relevant in tests, e.g. a temp UseCases dir a test writes
 * into across multiple calls), use resetTaskIndexCache() to force a
 * rebuild.
 */
export function getTaskIndex(useCasesDir: string = USECASES_DIR): Map<string, string> {
  if (!cachedIndex || cachedDir !== useCasesDir) {
    cachedIndex = buildTaskIndex(useCasesDir);
    cachedDir = useCasesDir;
  }
  return cachedIndex;
}

/**
 * Reset the per-process task index cache. Test-only escape hatch — call
 * between hermetic tests that point getTaskIndex()/findTaskFile() at
 * different (or mutated) temp UseCases/ directories.
 */
export function resetTaskIndexCache(): void {
  cachedIndex = null;
  cachedDir = null;
}

/**
 * Resolve a task id to its UseCases/ file path via the id index. Returns
 * null if no file declares this id — never guesses a filename.
 */
export function findTaskFile(taskId: string, useCasesDir: string = USECASES_DIR): string | null {
  return getTaskIndex(useCasesDir).get(taskId) ?? null;
}
