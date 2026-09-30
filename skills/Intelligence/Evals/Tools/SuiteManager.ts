#!/usr/bin/env bun
/**
 * Eval Suite Manager
 * Manage capability vs regression suites
 */

import type { EvalSuite, EvalType, Task } from '../Types/index.ts';
import { EvalSuiteSchema } from '../Types/schemas.ts';
import { findTaskFile } from './shared/TaskUtils.ts';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseArgs } from 'util';

const EVALS_DIR = join(import.meta.dir, '..');
const SUITES_DIR = join(EVALS_DIR, 'Suites');
const RESULTS_DIR = join(EVALS_DIR, 'Results');

/**
 * Ensure directories exist
 */
function ensureDirs(): void {
  if (!existsSync(SUITES_DIR)) mkdirSync(SUITES_DIR, { recursive: true });
  if (!existsSync(join(SUITES_DIR, 'Capability'))) mkdirSync(join(SUITES_DIR, 'Capability'));
  if (!existsSync(join(SUITES_DIR, 'Regression'))) mkdirSync(join(SUITES_DIR, 'Regression'));
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
}

/**
 * Create a new eval suite
 */
export function createSuite(
  name: string,
  type: EvalType,
  description: string,
  options?: {
    domain?: string;
    pass_threshold?: number;
    tasks?: string[];
  }
): EvalSuite {
  ensureDirs();

  const suite: EvalSuite = {
    name,
    description,
    type,
    domain: options?.domain as any,
    tasks: options?.tasks ?? [],
    pass_threshold: options?.pass_threshold ?? (type === 'regression' ? 0.95 : 0.70),
    created_at: new Date().toISOString(),
  };

  const dir = type === 'capability' ? 'Capability' : 'Regression';
  const filePath = join(SUITES_DIR, dir, `${name}.yaml`);

  writeFileSync(filePath, stringifyYaml(suite));

  return suite;
}

/**
 * Parse and validate suite YAML text against the shared EvalSuiteSchema
 * (Types/schemas.ts) — the single source of truth for EvalSuite shape.
 * Extracted from loadSuite() so it can be exercised directly against
 * arbitrary YAML text (tests, a temp file, the CLI) without needing the
 * caller to place a file under the real Suites/ directory.
 *
 * Previously loadSuite() did a blind `parseYaml(...) as EvalSuite` cast with
 * zero runtime validation — a first-generation suite file with a stale
 * schema (Suites/foundation.yaml, retired in slice A3b) loaded "successfully"
 * this way and then crashed the executor downstream with an uncaught
 * TypeError the first time it dereferenced `.tasks`. See evals-rebuild slice
 * A5 / MEMORY/SkillAudits/evals-infra-audit-2026-07-09/engine.md FINDING #1.
 *
 * On invalid shape (bad YAML, wrong types, missing required fields): throws
 * a single loud `invalid suite <path>: <issues>` Error — never a partially
 * valid object, never a downstream TypeError from a consumer dereferencing a
 * missing field.
 *
 * On a valid suite: also checks that every suite.tasks id resolves to a real
 * UseCases/ file via findTaskFile() (Tools/shared/TaskUtils.ts, backed by a
 * real id->path index built by scanning every UseCases/**\/*.yaml file's
 * `id:` field — evals-rebuild slice A6) and THROWS a loud "unknown task id"
 * error naming both the suite and the id for any that don't resolve. Before
 * A6, findTaskFile() only GUESSED a filename from the id (the raw id, or
 * "task_" + the id's suffix after its first underscore), which could not
 * resolve every real id — e.g. kaya_specsheet_spec_quality_judge's actual
 * file is UseCases/SpecSheet/spec-quality-judge.yaml, a filename that
 * matched neither guess — so this check was a non-fatal console.warn(). The
 * real index resolves every id in the kept corpus, so an unresolvable id is
 * now unambiguously suite-file corruption (a typo, or a task that was
 * deleted/renamed without updating the suite) — never silently tolerated.
 */
export function parseSuiteYaml(rawYamlText: string, sourcePath: string): EvalSuite {
  let raw: unknown;
  try {
    raw = parseYaml(rawYamlText);
  } catch (e) {
    throw new Error(`invalid suite ${sourcePath}: YAML parse error: ${e instanceof Error ? e.message : String(e)}`);
  }

  const result = EvalSuiteSchema.safeParse(raw);
  if (!result.success) {
    const formatted = result.error.issues
      .map(i => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`invalid suite ${sourcePath}:\n${formatted}`);
  }

  const suite = result.data;

  // Every task id must resolve via the real id->path index (see doc comment
  // above) — a suite referencing an unknown id is corruption, not something
  // to load with a warning and move on from.
  for (const taskId of suite.tasks) {
    if (!findTaskFile(taskId)) {
      throw new Error(
        `suite "${suite.name}" (${sourcePath}) references unknown task id "${taskId}" — ` +
        `no UseCases/**/*.yaml file declares id: ${taskId}.`
      );
    }
  }

  return suite;
}

/**
 * Load a suite by name
 */
export function loadSuite(name: string): EvalSuite | null {
  ensureDirs();

  // Check all known suite type directories, then the root Suites directory.
  const candidatePaths = [
    join(SUITES_DIR, 'Capability', `${name}.yaml`),
    join(SUITES_DIR, 'Regression', `${name}.yaml`),
    join(SUITES_DIR, `${name}.yaml`),
  ];
  const filePath = candidatePaths.find(existsSync);
  if (!filePath) return null;

  return parseSuiteYaml(readFileSync(filePath, 'utf-8'), filePath);
}

/**
 * List all suites.
 *
 * evals-rebuild slice A6: the kept suite corpus (post slice A3b corpus
 * retirement — see the 3 files directly under Suites/) lives in the Suites/
 * ROOT, not in Capability/ or Regression/ subdirectories. This previously
 * only scanned those two subdirs, so it silently returned zero suites for
 * the current corpus (evals audit / A5 verify dead-code finding — zero
 * external callers noticed because nothing calls listSuites() in
 * production code today, only the `list` CLI command below). It also did a
 * blind `parseYaml(...) as EvalSuite` cast with zero runtime validation;
 * now uses parseSuiteYaml() (Types/schemas.ts's EvalSuiteSchema + the id
 * index task-resolution check), same as loadSuite().
 *
 * Scans Suites/ root first (primary, where the real corpus lives), then
 * Capability/ and Regression/ (legacy layout — empty today, but harmless to
 * keep scanning in case a suite is ever restored there). A suite name seen
 * in an earlier location wins if the same name somehow appears in both
 * (root takes priority).
 *
 * `type` filters by the suite's own `type:` field (capability vs
 * regression), not by which directory it was found in — the directory no
 * longer reliably implies the type once suites live in the root.
 */
export function listSuites(type?: EvalType): EvalSuite[] {
  ensureDirs();

  const suites: EvalSuite[] = [];
  const seen = new Set<string>();

  const scanDir = (dirPath: string) => {
    if (!existsSync(dirPath)) return;
    for (const file of readdirSync(dirPath)) {
      if (!file.endsWith('.yaml')) continue;
      const filePath = join(dirPath, file);
      if (!statSync(filePath).isFile()) continue;
      const suite = parseSuiteYaml(readFileSync(filePath, 'utf-8'), filePath);
      if (seen.has(suite.name)) continue;
      seen.add(suite.name);
      suites.push(suite);
    }
  };

  scanDir(SUITES_DIR);
  scanDir(join(SUITES_DIR, 'Capability'));
  scanDir(join(SUITES_DIR, 'Regression'));

  return type ? suites.filter(s => s.type === type) : suites;
}

/**
 * Add a task to a suite
 */
export function addTaskToSuite(suiteName: string, taskId: string): boolean {
  const suite = loadSuite(suiteName);
  if (!suite) return false;

  if (!suite.tasks.includes(taskId)) {
    suite.tasks.push(taskId);
    suite.updated_at = new Date().toISOString();

    const dir = suite.type === 'capability' ? 'Capability' : 'Regression';
    const filePath = join(SUITES_DIR, dir, `${suiteName}.yaml`);
    writeFileSync(filePath, stringifyYaml(suite));
  }

  return true;
}

/**
 * Format suite summary for display
 */
export function formatSuiteSummary(suite: EvalSuite): string {
  const lines: string[] = [];

  const typeIcon = suite.type === 'capability' ? '🎯' : '🔒';
  lines.push(`## ${typeIcon} ${suite.name}`);
  lines.push('');
  lines.push(`**Type:** ${suite.type}`);
  lines.push(`**Description:** ${suite.description}`);
  if (suite.domain) lines.push(`**Domain:** ${suite.domain}`);
  lines.push(`**Tasks:** ${suite.tasks.length}`);
  lines.push(`**Pass Threshold:** ${(suite.pass_threshold ?? 0.75) * 100}%`);
  lines.push('');

  if (suite.tasks.length > 0) {
    lines.push('');
    lines.push('### Tasks');
    lines.push('');
    for (const task of suite.tasks) {
      lines.push(`- ${task}`);
    }
  }

  return lines.join('\n');
}

// CLI interface
if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      type: { type: 'string', short: 't', default: 'capability' },
      description: { type: 'string', short: 'd' },
      domain: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  const [command, ...args] = positionals;

  if (values.help || !command) {
    console.log(`
SuiteManager - Manage evaluation suites

Commands:
  create <name>       Create a new suite
  list [type]         List all suites (optionally filter by type)
  show <name>         Show suite details
  add-task <suite> <task>  Add a task to a suite

Options:
  -t, --type          Suite type: capability or regression (default: capability)
  -d, --description   Suite description
  --domain            Suite domain (coding, conversational, research, computer_use)
  -h, --help          Show this help

Examples:
  bun run SuiteManager.ts create auth-security -t capability -d "Authentication security tests"
  bun run SuiteManager.ts list regression
  bun run SuiteManager.ts show auth-security
  bun run SuiteManager.ts add-task auth-security fix-auth-bypass
`);
    process.exit(0);
  }

  switch (command) {
    case 'create': {
      if (!args[0] || !values.description) {
        console.error('Usage: create <name> -d "description"');
        process.exit(1);
      }
      const suite = createSuite(
        args[0],
        values.type as EvalType,
        values.description,
        { domain: values.domain }
      );
      console.log(`Created suite: ${suite.name} (${suite.type})`);
      break;
    }

    case 'list': {
      const type = args[0] as EvalType | undefined;
      const suites = listSuites(type);
      console.log(`\n${type ? type.charAt(0).toUpperCase() + type.slice(1) : 'All'} Suites:\n`);
      for (const suite of suites) {
        const icon = suite.type === 'capability' ? '🎯' : '🔒';
        console.log(`  ${icon} ${suite.name} (${suite.tasks.length} tasks)`);
      }
      break;
    }

    case 'show': {
      if (!args[0]) {
        console.error('Usage: show <name>');
        process.exit(1);
      }
      const suite = loadSuite(args[0]);
      if (!suite) {
        console.error(`Suite not found: ${args[0]}`);
        process.exit(1);
      }
      console.log('\n' + formatSuiteSummary(suite));
      break;
    }

    case 'add-task': {
      if (!args[0] || !args[1]) {
        console.error('Usage: add-task <suite> <task>');
        process.exit(1);
      }
      if (addTaskToSuite(args[0], args[1])) {
        console.log(`Added task ${args[1]} to suite ${args[0]}`);
      } else {
        console.error(`Failed to add task to suite`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}
