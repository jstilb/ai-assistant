#!/usr/bin/env bun
/**
 * OutputPathResolver - Standardized skill output path generation
 *
 * Provides consistent output paths following Kaya conventions:
 * - MEMORY/[SkillName]/YYYY-MM-DD/ for permanent outputs
 * - MEMORY/WORK/{current_work}/scratch/ for work artifacts
 * - ~/Downloads/ for user preview
 * - Custom paths for special needs
 */

import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { parseArgs } from 'util';

const KAYA_HOME = process.env.HOME + '/.claude';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type OutputType = 'memory' | 'work' | 'downloads' | 'custom';

export interface OutputPathOptions {
  /** Skill name (TitleCase) */
  skill: string;
  /** Output title (will be slug-ified) */
  title: string;
  /** Output type - determines base directory */
  type?: OutputType;
  /** Custom base path (required when type is 'custom') */
  customPath?: string;
  /** File extension (default: 'md') */
  extension?: string;
  /** Include timestamp prefix (default: true) */
  includeTimestamp?: boolean;
  /** Current work session ID (auto-detected if not provided, for type: 'work') */
  workSessionId?: string;
}

export interface ResolvedPath {
  /** Full absolute path to the output file */
  path: string;
  /** Directory containing the file */
  directory: string;
  /** Filename only */
  filename: string;
  /** Whether the directory already existed */
  directoryExisted: boolean;
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

/**
 * Convert a title to a filename-safe slug
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 64);
}

/**
 * Get current date in YYYY-MM-DD format
 */
function getDateString(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Get timestamp prefix in YYYYMMDD-HHMMSS format
 */
function getTimestampPrefix(): string {
  const now = new Date();
  const date = now.toISOString().split('T')[0].replace(/-/g, '');
  const time = now.toTimeString().split(' ')[0].replace(/:/g, '');
  return `${date}-${time}`;
}

/**
 * Find current work session ID from MEMORY/WORK/
 */
async function findCurrentWorkSession(): Promise<string | null> {
  const workDir = join(KAYA_HOME, 'MEMORY/WORK');

  if (!existsSync(workDir)) {
    return null;
  }

  const { readdir, stat } = await import('fs/promises');
  const entries = await readdir(workDir);

  // Find most recent work directory
  let latestDir: string | null = null;
  let latestTime = 0;

  for (const entry of entries) {
    const entryPath = join(workDir, entry);
    const stats = await stat(entryPath);
    if (stats.isDirectory() && stats.mtimeMs > latestTime) {
      latestTime = stats.mtimeMs;
      latestDir = entry;
    }
  }

  return latestDir;
}

// -----------------------------------------------------------------------------
// Core Functions
// -----------------------------------------------------------------------------

/**
 * Resolve output path based on options
 *
 * @example
 * // Memory output (default)
 * const path = await resolveOutputPath({
 *   skill: 'Research',
 *   title: 'findings-summary'
 * });
 * // → ~/.claude/MEMORY/Research/2026-02-01/20260201-143052_findings-summary.md
 *
 * @example
 * // Work artifact
 * const path = await resolveOutputPath({
 *   skill: 'Research',
 *   title: 'intermediate-data',
 *   type: 'work',
 *   extension: 'json'
 * });
 * // → ~/.claude/MEMORY/WORK/{session}/scratch/20260201-143052_intermediate-data.json
 */
export async function resolveOutputPath(
  options: OutputPathOptions
): Promise<ResolvedPath> {
  const {
    skill,
    title,
    type = 'memory',
    customPath,
    extension = 'md',
    includeTimestamp = true,
    workSessionId,
  } = options;

  const slug = slugify(title);
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  const prefix = includeTimestamp ? `${getTimestampPrefix()}_` : '';
  const filename = `${prefix}${slug}${ext}`;

  let directory: string;

  switch (type) {
    case 'memory':
      directory = join(KAYA_HOME, 'MEMORY', skill, getDateString());
      break;

    case 'work': {
      const sessionId = workSessionId || (await findCurrentWorkSession());
      if (!sessionId) {
        // Fall back to memory if no work session
        directory = join(KAYA_HOME, 'MEMORY', skill, getDateString());
      } else {
        directory = join(KAYA_HOME, 'MEMORY/WORK', sessionId, 'scratch');
      }
      break;
    }

    case 'downloads':
      directory = join(process.env.HOME!, 'Downloads');
      break;

    case 'custom':
      if (!customPath) {
        throw new Error("customPath is required when type is 'custom'");
      }
      directory = customPath.startsWith('~')
        ? customPath.replace('~', process.env.HOME!)
        : customPath;
      break;

    default:
      throw new Error(`Unknown output type: ${type}`);
  }

  const directoryExisted = existsSync(directory);
  const path = join(directory, filename);

  return {
    path,
    directory,
    filename,
    directoryExisted,
  };
}

/**
 * Ensure output directory exists
 */
export function ensureOutputDir(path: string): void {
  const dir = path.endsWith('/') ? path : dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Convenience function: resolve path and ensure directory exists
 */
export async function prepareOutputPath(
  options: OutputPathOptions
): Promise<ResolvedPath> {
  const resolved = await resolveOutputPath(options);
  ensureOutputDir(resolved.path);
  return resolved;
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      skill: { type: 'string', short: 's' },
      title: { type: 'string', short: 't' },
      type: { type: 'string', default: 'memory' },
      'custom-path': { type: 'string' },
      extension: { type: 'string', short: 'e', default: 'md' },
      'no-timestamp': { type: 'boolean', default: false },
      'create-dir': { type: 'boolean', short: 'c', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
OutputPathResolver - Generate standardized skill output paths

USAGE:
  bun OutputPathResolver.ts --skill <name> --title <title> [options]
  bun OutputPathResolver.ts -s <name> -t <title> [options]

OPTIONS:
  -s, --skill <name>      Skill name (TitleCase)
  -t, --title <title>     Output title (will be slug-ified)
  --type <type>           Output type: memory (default), work, downloads, custom
  --custom-path <path>    Custom base path (required for --type custom)
  -e, --extension <ext>   File extension (default: md)
  --no-timestamp          Omit timestamp prefix from filename
  -c, --create-dir        Create the output directory if it doesn't exist
  -j, --json              Output as JSON
  -h, --help              Show this help

OUTPUT TYPES:
  memory     MEMORY/[SkillName]/YYYY-MM-DD/     Permanent skill outputs
  work       MEMORY/WORK/{session}/scratch/     Work-session artifacts
  downloads  ~/Downloads/                        User preview
  custom     <custom-path>/                      Special needs

EXAMPLES:
  # Generate memory path for research findings
  bun OutputPathResolver.ts -s Research -t "ai-safety-findings"
  # → ~/.claude/MEMORY/Research/2026-02-01/20260201-143052_ai-safety-findings.md

  # Generate work artifact path
  bun OutputPathResolver.ts -s Analysis -t "intermediate" --type work -e json
  # → ~/.claude/MEMORY/WORK/{session}/scratch/20260201-143052_intermediate.json

  # Generate downloads path without timestamp
  bun OutputPathResolver.ts -s Report -t "summary" --type downloads --no-timestamp
  # → ~/Downloads/summary.md

  # Create directory and output JSON
  bun OutputPathResolver.ts -s Research -t "output" -c -j
`);
    process.exit(0);
  }

  const skill = values.skill || positionals[0];
  const title = values.title || positionals[1];

  if (!skill || !title) {
    console.error('Error: --skill and --title are required');
    console.error('Run with --help for usage');
    process.exit(1);
  }

  try {
    const resolved = await resolveOutputPath({
      skill,
      title,
      type: values.type as OutputType,
      customPath: values['custom-path'],
      extension: values.extension,
      includeTimestamp: !values['no-timestamp'],
    });

    if (values['create-dir']) {
      ensureOutputDir(resolved.path);
    }

    if (values.json) {
      console.log(JSON.stringify(resolved, null, 2));
    } else {
      console.log(resolved.path);
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

// Run CLI if executed directly
if (import.meta.main) {
  main();
}
