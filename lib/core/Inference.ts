#!/usr/bin/env bun
/**
 * ============================================================================
 * INFERENCE - Unified inference tool with three run levels
 * ============================================================================
 *
 * PURPOSE:
 * Single inference tool with configurable speed/capability trade-offs:
 * - Fast: Haiku - quick tasks, simple generation, basic classification
 * - Standard: Sonnet - balanced reasoning, typical analysis
 * - Smart: Opus - deep reasoning, strategic decisions, complex analysis
 *
 * USAGE:
 *   bun Inference.ts --level fast <system_prompt> <user_prompt>
 *   bun Inference.ts --level standard <system_prompt> <user_prompt>
 *   bun Inference.ts --level smart <system_prompt> <user_prompt>
 *   bun Inference.ts --json --level fast <system_prompt> <user_prompt>
 *
 * OPTIONS:
 *   --level <fast|standard|smart>  Run level (default: standard)
 *   --json                         Expect and parse JSON response
 *   --timeout <ms>                 Custom timeout (default varies by level)
 *
 * DEFAULTS BY LEVEL:
 *   fast:     model=haiku,   timeout=60s
 *   standard: model=sonnet,  timeout=90s
 *   smart:    model=opus,    timeout=240s
 *
 * BILLING: Uses Claude CLI with subscription (not API key)
 *
 * ============================================================================
 */

import { spawn, execSync } from "child_process";
import { existsSync, openSync, closeSync, readFileSync, unlinkSync } from "fs";
import { loadTieredConfig } from "./ConfigLoader.ts";
import { z } from "zod";

/**
 * Resolve the full path to the `claude` CLI binary.
 * In interactive shells, `claude` is on $PATH via ~/.local/bin.
 * In background/automated contexts (launchd, cron), $PATH may be minimal,
 * so we check known locations as fallback.
 */
function resolveClaudePath(): string {
  // Known install locations (ordered by likelihood)
  const knownPaths = [
    `${process.env.HOME}/.local/bin/claude`,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];

  // First, try the known paths directly (fastest, no shell needed)
  for (const p of knownPaths) {
    if (existsSync(p)) return p;
  }

  // Fallback: try `which` in case it's somewhere else on PATH
  try {
    return execSync('which claude', { encoding: 'utf-8' }).trim();
  } catch {
    // Last resort — return bare name and let spawn fail with a clear error
    return 'claude';
  }
}

export const CLAUDE_PATH = resolveClaudePath();

export type InferenceLevel = 'fast' | 'standard' | 'smart';

export interface InferenceOptions {
  systemPrompt: string;
  userPrompt: string;
  level?: InferenceLevel;
  expectJson?: boolean;
  timeout?: number;
  /** When true, detect JSON arrays in userPrompt and TOON-encode them before sending.
   *  Only applies when settings.json toon.enableInInference is also true. */
  toonEncodeInput?: boolean;
}

export interface InferenceResult {
  success: boolean;
  output: string;
  parsed?: unknown;
  error?: string;
  latencyMs: number;
  level: InferenceLevel;
}

// Level configuration schema
const LevelConfigSchema = z.object({
  fast: z.object({
    model: z.string().default('haiku'),
    defaultTimeout: z.number().default(60000),
  }),
  standard: z.object({
    model: z.string().default('sonnet'),
    defaultTimeout: z.number().default(90000),
  }),
  smart: z.object({
    model: z.string().default('opus'),
    defaultTimeout: z.number().default(240000),
  }),
});

// Default level configurations
const DEFAULT_LEVEL_CONFIG = {
  fast: { model: 'haiku', defaultTimeout: 60000 },
  standard: { model: 'sonnet', defaultTimeout: 90000 },
  smart: { model: 'opus', defaultTimeout: 240000 },
};

/**
 * Get level configurations (with optional USER/SYSTEM overrides)
 *
 * Allows customization via:
 * - USER:   ~/.claude/USER/config/inference.json
 * - SYSTEM: ~/.claude/docs/system/config/inference.json
 * - ENV:    KAYA_INFERENCE_FAST_MODEL, KAYA_INFERENCE_FAST_TIMEOUT, etc.
 */
function getLevelConfig(): Record<InferenceLevel, { model: string; defaultTimeout: number }> {
  try {
    return loadTieredConfig('inference', LevelConfigSchema, DEFAULT_LEVEL_CONFIG, {
      envPrefix: 'KAYA_INFERENCE',
    });
  } catch {
    // If config loading fails, use defaults
    return DEFAULT_LEVEL_CONFIG;
  }
}

// ============================================================================
// TOON ENCODING HELPERS (Phase 3a)
// ============================================================================

interface JsonArrayMatch {
  /** The original JSON string that was matched */
  original: string;
  /** The parsed array */
  parsed: unknown[];
  /** Start index in the source text */
  startIndex: number;
  /** End index in the source text */
  endIndex: number;
}

/**
 * Detect JSON arrays embedded in text.
 * Scans for [...] patterns, attempts JSON.parse, and returns matches
 * that are valid arrays of objects (suitable for TOON encoding).
 *
 * @param text - The text to scan for JSON arrays
 * @returns Array of matched JSON arrays with their positions
 */
export function detectJsonArraysInText(text: string): JsonArrayMatch[] {
  const matches: JsonArrayMatch[] = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const openIdx = text.indexOf('[', searchFrom);
    if (openIdx === -1) break;

    // Find the matching close bracket using a bracket depth counter
    let depth = 0;
    let inString = false;
    let escape = false;
    let closeIdx = -1;

    for (let i = openIdx; i < text.length; i++) {
      const ch = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          closeIdx = i;
          break;
        }
      }
    }

    if (closeIdx === -1) {
      searchFrom = openIdx + 1;
      continue;
    }

    const candidate = text.slice(openIdx, closeIdx + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null) {
        matches.push({
          original: candidate,
          parsed,
          startIndex: openIdx,
          endIndex: closeIdx + 1,
        });
        searchFrom = closeIdx + 1;
      } else {
        searchFrom = openIdx + 1;
      }
    } catch {
      searchFrom = openIdx + 1;
    }
  }

  return matches;
}

/**
 * Replace JSON arrays in a prompt with TOON-encoded versions when savings are significant.
 * Uses lazy import of ToonHelper to avoid circular dependencies.
 *
 * @param text - The prompt text potentially containing JSON arrays
 * @returns The text with JSON arrays replaced by TOON format where savings justify it
 */
export function toonEncodePrompt(text: string): string {
  const matches = detectJsonArraysInText(text);
  if (matches.length === 0) return text;

  // Lazy import ToonHelper
  const { maybeEncode } = require("./ToonHelper") as typeof import("./ToonHelper");

  // Process matches in reverse order to preserve indices
  let result = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const encoded = maybeEncode(match.parsed);
    if (encoded.format === 'toon') {
      result = result.slice(0, match.startIndex) +
        `<toon-data>\n${encoded.data}\n</toon-data>` +
        result.slice(match.endIndex);
    }
  }

  return result;
}

/**
 * Check if TOON inference encoding is enabled in settings.json
 */
function isToonInferenceEnabled(): boolean {
  try {
    const { loadSettings } = require("./ConfigLoader") as typeof import("./ConfigLoader");
    const settings = loadSettings() as Record<string, unknown>;
    const toon = settings.toon as Record<string, boolean> | undefined;
    return toon?.enableInInference === true;
  } catch {
    return false;
  }
}

/**
 * Extract JSON from LLM output using 3 strategies:
 * 1. Direct parse (clean JSON response)
 * 2. Strip markdown code fences (most common LLM pattern)
 * 3. Greedy regex (find first JSON object or array)
 */
export function extractJson(output: string): unknown | undefined {
  const trimmed = output.trim();

  // Strategy 1: Direct parse (clean JSON response)
  try { return JSON.parse(trimmed); } catch {}

  // Strategy 2: Strip markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }

  // Strategy 3: Greedy regex (try both object and array patterns)
  for (const pattern of [/\{[\s\S]*\}/, /\[[\s\S]*\]/]) {
    const jsonMatch = trimmed.match(pattern);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[0]); } catch {}
    }
  }

  return undefined;
}

/** Read a file's contents, returning empty string if missing or unreadable. */
function readFileSafe(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Run inference with configurable level
 */
export async function inference(options: InferenceOptions): Promise<InferenceResult> {
  const level = options.level || 'standard';
  const levelConfig = getLevelConfig();
  const config = levelConfig[level];
  const startTime = Date.now();
  const timeout = options.timeout || config.defaultTimeout;

  // Optionally TOON-encode JSON arrays in the user prompt (Phase 3a)
  let userPrompt = options.userPrompt;
  if (options.toonEncodeInput && isToonInferenceEnabled()) {
    userPrompt = toonEncodePrompt(userPrompt);
  }

  // Build environment WITHOUT ANTHROPIC_API_KEY to force subscription auth
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDECODE;
  // Remove all nesting-detection and override vars (keep OAUTH_TOKEN for auth)
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE_') && key !== 'CLAUDE_CODE_OAUTH_TOKEN') {
      delete env[key];
    }
  }

  // Use -p flag with stdin for user prompt (avoids CLI flag parsing issues
  // when content starts with special characters like ---)
  const args = [
    '-p',
    '--model', config.model,
    '--tools', '',  // Disable tools for faster response
    '--output-format', 'text',
    '--setting-sources', '',  // Disable hooks to prevent recursion
    '--system-prompt', options.systemPrompt,
  ];

  // Redirect claude's stdout/stderr to temp files via file descriptors.
  // The claude binary's IPC with the parent Claude Code process suppresses
  // pipe-based output capture. File-descriptor redirection avoids this.
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpOut = `/tmp/kaya-inf-${uid}.out`;
  const tmpErr = `/tmp/kaya-inf-${uid}.err`;
  const outFd = openSync(tmpOut, 'w');
  const errFd = openSync(tmpErr, 'w');

  return new Promise((resolve) => {
    const cleanup = () => {
      try { closeSync(outFd); } catch {}
      try { closeSync(errFd); } catch {}
      try { unlinkSync(tmpOut); } catch {}
      try { unlinkSync(tmpErr); } catch {}
    };

    const proc = spawn(CLAUDE_PATH, args, {
      env,
      stdio: ['pipe', outFd, errFd],
    });

    // Pipe user prompt via stdin to avoid CLI argument parsing issues
    proc.stdin.write(userPrompt);
    proc.stdin.end();

    // Handle timeout
    const timeoutId = setTimeout(() => {
      proc.kill('SIGTERM');
      // Force kill if SIGTERM doesn't work after 2s
      const killId = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
      }, 2000);
      proc.on('close', () => clearTimeout(killId));
      const stdout = readFileSafe(tmpOut);
      const stderr = readFileSafe(tmpErr);
      cleanup();
      resolve({
        success: false,
        output: stdout,
        error: `Timeout after ${timeout}ms${stderr ? ` (stderr: ${stderr.slice(0, 500)})` : ''}`,
        latencyMs: Date.now() - startTime,
        level,
      });
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      const latencyMs = Date.now() - startTime;
      const stdout = readFileSafe(tmpOut);
      const stderr = readFileSafe(tmpErr);
      cleanup();

      if (code !== 0) {
        resolve({
          success: false,
          output: stdout,
          error: stderr || `Process exited with code ${code}`,
          latencyMs,
          level,
        });
        return;
      }

      const output = stdout.trim();

      // Parse JSON if requested
      if (options.expectJson) {
        const parsed = extractJson(output);
        if (parsed !== undefined) {
          resolve({ success: true, output, parsed, latencyMs, level });
        } else {
          resolve({ success: false, output, error: 'No JSON found in response', latencyMs, level });
        }
        return;
      }

      resolve({
        success: true,
        output,
        latencyMs,
        level,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      cleanup();
      resolve({
        success: false,
        output: '',
        error: err.message,
        latencyMs: Date.now() - startTime,
        level,
      });
    });
  });
}

/**
 * CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);

  // Parse flags
  let expectJson = false;
  let timeout: number | undefined;
  let level: InferenceLevel = 'standard';
  const positionalArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') {
      expectJson = true;
    } else if (args[i] === '--level' && args[i + 1]) {
      const requestedLevel = args[i + 1].toLowerCase();
      if (['fast', 'standard', 'smart'].includes(requestedLevel)) {
        level = requestedLevel as InferenceLevel;
      } else {
        console.error(`Invalid level: ${args[i + 1]}. Use fast, standard, or smart.`);
        process.exit(1);
      }
      i++;
    } else if (args[i] === '--timeout' && args[i + 1]) {
      timeout = parseInt(args[i + 1], 10);
      i++;
    } else {
      positionalArgs.push(args[i]);
    }
  }

  if (positionalArgs.length < 2) {
    console.error('Usage: bun Inference.ts [--level fast|standard|smart] [--json] [--timeout <ms>] <system_prompt> <user_prompt>');
    process.exit(1);
  }

  const [systemPrompt, userPrompt] = positionalArgs;

  const result = await inference({
    systemPrompt,
    userPrompt,
    level,
    expectJson,
    timeout,
  });

  if (result.success) {
    if (expectJson && result.parsed) {
      console.log(JSON.stringify(result.parsed));
    } else {
      console.log(result.output);
    }
  } else {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}
