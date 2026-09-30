#!/usr/bin/env bun
/**
 * ArgumentMapperBridge.ts — Bridge to the external ArgumentMapper project
 *
 * Reads project path from ARGUMENTMAPPER_PATH env var (no hardcoded paths).
 * Uses execFileSync with array args to prevent CLI injection.
 * Provides structured output with audit logging.
 *
 * Usage:
 *   ARGUMENTMAPPER_PATH=/path/to/argumentmapper bun ArgumentMapperBridge.ts map "Person" "Topic"
 *   ARGUMENTMAPPER_PATH=/path/to/argumentmapper bun ArgumentMapperBridge.ts list
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'util';
import { createAppendLog, type AppendLog } from '../../../../lib/core/AppendLog.ts';
import { getKayaHome as resolveKayaHome } from '../../../../lib/core/KayaHome.ts';

// ============================================================================
// Path Resolution
// ============================================================================

function getKayaHome(): string {
  return resolveKayaHome();
}

function getProjectPath(): string {
  const path = process.env.ARGUMENTMAPPER_PATH;
  if (!path) {
    throw new Error(
      'ARGUMENTMAPPER_PATH env var not set. Set it to the argumentmapper project root.\n' +
      'Add to secrets.json: { "argumentmapper_path": "/path/to/argumentmapper" }'
    );
  }
  return path;
}

// ============================================================================
// Types
// ============================================================================

type BridgeResult =
  | { success: true; data: unknown }
  | { success: false; exitCode?: number; stderr?: string; error: string };

// ============================================================================
// Audit Logging
// ============================================================================

// AppendLog instances, reused per resolved path (kayaHome varies by env var).
const auditLogs = new Map<string, AppendLog>();
function getAuditLog(filePath: string): AppendLog {
  let log = auditLogs.get(filePath);
  if (!log) {
    log = createAppendLog(filePath);
    auditLogs.set(filePath, log);
  }
  return log;
}

function auditLog(kayaHome: string, entry: Record<string, unknown>): void {
  const dir = join(kayaHome, 'MEMORY', 'Intelligence');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  getAuditLog(join(dir, 'argumentmapper-runs.jsonl')).append(entry);
}

// ============================================================================
// Bridge Execution
// ============================================================================

function runBridge(projectPath: string, args: string[]): BridgeResult {
  const cliPath = join(projectPath, 'src', 'cli.ts');

  if (!existsSync(cliPath)) {
    return {
      success: false,
      error: `ArgumentMapper not found at ${projectPath}. Check ARGUMENTMAPPER_PATH. Expected: ${cliPath}`,
    };
  }

  try {
    // Use execFileSync with array args — no shell interpolation, no injection risk
    const output = execFileSync('bun', [cliPath, ...args], {
      encoding: 'utf-8',
      timeout: 60_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Parse output
    try {
      return { success: true, data: JSON.parse(output) };
    } catch {
      return { success: true, data: { type: 'text', content: output } };
    }
  } catch (e: unknown) {
    const err = e as { status?: number; stderr?: string | Buffer; message?: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString() ?? '';

    if (err.message?.includes('ETIMEDOUT') || err.message?.includes('timeout')) {
      return { success: false, error: 'ArgumentMapper timed out after 60s', stderr };
    }

    return {
      success: false,
      exitCode: err.status,
      stderr,
      error: err.message ?? String(e),
    };
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help || positionals.length === 0) {
    console.log(`ArgumentMapperBridge — Bridge to the external ArgumentMapper project

Usage:
  ARGUMENTMAPPER_PATH=/path/to/argumentmapper bun ArgumentMapperBridge.ts <command> [args...]

Commands (forwarded to ArgumentMapper CLI):
  map <person> <topic>         Map argument positions
  verify --input profile.json  Verify positions
  track <person> <topic>       Track positions over time
  search <person> <topic>      Search positions
  list                         List all tracked entities

  ownership resolve <name>     Resolve a brand/org to ranked entity candidates.
                               Ambiguity is SURFACED, never guessed — exits
                               non-zero and picks nothing when ambiguous.
  ownership <name>             Combined ownership lineage (parents + subsidiaries
                               + sister companies), every edge carrying a source URL.
    --up | --down | --siblings   One direction only
    --pick <id>                  cik:0000021344 | lei:... | wd:Q...
    --max-depth N --max-nodes N  Traversal caps (default 3 / 250); truncation disclosed
    --no-enrich                  Skip Wikidata notability enrichment
    --money                      FEC / ProPublica 990 / CourtListener findings (opt-in).
                                 Each finding states its attribution basis; a name
                                 match is NEVER presented as confirmed attribution.

Environment:
  ARGUMENTMAPPER_PATH   Path to argumentmapper project root (REQUIRED)
  KAYA_HOME             Kaya root for audit logs (default: ~/.claude)
`);
    process.exit(0);
  }

  const kayaHome = getKayaHome();
  const startMs = Date.now();

  let projectPath: string;
  try {
    projectPath = getProjectPath();
  } catch (err) {
    console.error(String(err));
    process.exit(1);
  }

  const result = runBridge(projectPath, positionals);
  const durationMs = Date.now() - startMs;

  // Audit
  auditLog(kayaHome, {
    timestamp: new Date().toISOString(),
    operation: positionals[0] ?? 'unknown',
    args: positionals.slice(1),
    durationMs,
    success: result.success,
    error: result.success ? undefined : result.error,
  });

  if (!result.success) {
    console.error('[ArgumentMapperBridge] Error:', result.error);
    if (result.stderr) console.error(result.stderr);
    process.exit(result.exitCode ?? 1);
  }

  if (values.json) {
    console.log(JSON.stringify(result.data, null, 2));
  } else if (typeof result.data === 'object' && result.data !== null && 'content' in result.data) {
    console.log((result.data as { content: string }).content);
  } else {
    console.log(JSON.stringify(result.data, null, 2));
  }
}

main().catch(err => {
  console.error('[ArgumentMapperBridge] Fatal:', err);
  process.exit(1);
});
