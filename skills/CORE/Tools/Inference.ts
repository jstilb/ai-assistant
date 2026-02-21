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
 *   fast:     model=haiku,   timeout=15s
 *   standard: model=sonnet,  timeout=30s
 *   smart:    model=opus,    timeout=90s
 *
 * BILLING: Uses Claude CLI with subscription (not API key)
 *
 * ============================================================================
 */

import { spawn } from "child_process";
import { loadTieredConfig } from "./ConfigLoader.ts";
import { z } from "zod";

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
    defaultTimeout: z.number().default(15000),
  }),
  standard: z.object({
    model: z.string().default('sonnet'),
    defaultTimeout: z.number().default(30000),
  }),
  smart: z.object({
    model: z.string().default('opus'),
    defaultTimeout: z.number().default(90000),
  }),
});

// Default level configurations
const DEFAULT_LEVEL_CONFIG = {
  fast: { model: 'haiku', defaultTimeout: 15000 },
  standard: { model: 'sonnet', defaultTimeout: 30000 },
  smart: { model: 'opus', defaultTimeout: 90000 },
};

/**
 * Get level configurations (with optional USER/SYSTEM overrides)
 *
 * Allows customization via:
 * - USER:   ~/.claude/skills/CORE/USER/config/inference.json
 * - SYSTEM: ~/.claude/skills/CORE/SYSTEM/config/inference.json
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

  return new Promise((resolve) => {
    // Build environment WITHOUT ANTHROPIC_API_KEY to force subscription auth
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

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

    let stdout = '';
    let stderr = '';

    const proc = spawn('claude', args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Pipe user prompt via stdin to avoid CLI argument parsing issues
    proc.stdin.write(userPrompt);
    proc.stdin.end();

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Handle timeout
    const timeoutId = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({
        success: false,
        output: '',
        error: `Timeout after ${timeout}ms`,
        latencyMs: Date.now() - startTime,
        level,
      });
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      const latencyMs = Date.now() - startTime;

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
        const jsonMatch = output.match(/\[[\s\S]*\]/) ?? output.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            resolve({
              success: true,
              output,
              parsed,
              latencyMs,
              level,
            });
            return;
          } catch {
            resolve({
              success: false,
              output,
              error: 'Failed to parse JSON response',
              latencyMs,
              level,
            });
            return;
          }
        }
        resolve({
          success: false,
          output,
          error: 'No JSON found in response',
          latencyMs,
          level,
        });
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
