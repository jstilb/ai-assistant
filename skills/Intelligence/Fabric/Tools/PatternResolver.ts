#!/usr/bin/env bun
/**
 * PatternResolver.ts
 *
 * Resolves Fabric pattern names, validates existence, provides fuzzy suggestions,
 * checks sentinel staleness, and validates pattern content for injection signals.
 *
 * Usage as CLI:
 *   bun PatternResolver.ts resolve <pattern_name>
 *   bun PatternResolver.ts validate <pattern_name>
 *
 * Usage as module:
 *   import { resolvePattern, validatePattern } from './PatternResolver';
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PATTERNS_DIR = join(
  process.env.HOME ?? "/Users/[user]",
  ".claude/skills/Intelligence/Fabric/Patterns"
);
const SENTINEL_PATH = join(PATTERNS_DIR, "loaded");
const STALE_THRESHOLD_DAYS = 30;
const STALE_THRESHOLD_MS = STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
const MAX_SUGGESTIONS = 3;

export const MAX_PATTERN_SIZE_BYTES = 50_000; // 50KB max per pattern

export const INJECTION_SIGNALS: RegExp[] = [
  /ignore\s+previous\s+instructions/i,
  /you\s+are\s+now\s+/i,
  /disregard\s+your\s+/i,
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolveResult {
  found: boolean;
  patternPath: string | null;
  content: string | null;
  warnings: string[];
  error: string | null;
  suggestions: string[];
}

export interface ValidateResult {
  warnings: string[];
  isValid: boolean;
}

// ---------------------------------------------------------------------------
// Levenshtein distance (simple iterative implementation)
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

// ---------------------------------------------------------------------------
// List all available pattern names
// ---------------------------------------------------------------------------

export function listPatternNames(): string[] {
  if (!existsSync(PATTERNS_DIR)) return [];
  return readdirSync(PATTERNS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

// ---------------------------------------------------------------------------
// Fuzzy suggestions: top N closest by Levenshtein + substring match
// ---------------------------------------------------------------------------

export function suggestPatterns(name: string, all: string[]): string[] {
  const lower = name.toLowerCase();

  // Prefer substring matches first
  const substringMatches = all.filter((p) =>
    p.toLowerCase().includes(lower) || lower.includes(p.toLowerCase().substring(0, 4))
  );

  // Sort remaining by Levenshtein
  const scored = all.map((p) => ({ p, d: levenshtein(name.toLowerCase(), p.toLowerCase()) }));
  scored.sort((a, b) => a.d - b.d);

  const merged: string[] = [];
  for (const m of substringMatches) {
    if (!merged.includes(m)) merged.push(m);
    if (merged.length >= MAX_SUGGESTIONS) break;
  }
  for (const { p } of scored) {
    if (!merged.includes(p)) merged.push(p);
    if (merged.length >= MAX_SUGGESTIONS) break;
  }
  return merged.slice(0, MAX_SUGGESTIONS);
}

// ---------------------------------------------------------------------------
// Sentinel staleness check
// ---------------------------------------------------------------------------

export function isSentinelStale(): boolean {
  if (!existsSync(SENTINEL_PATH)) return true;
  const stat = statSync(SENTINEL_PATH);
  const ageMs = Date.now() - stat.mtimeMs;
  return ageMs > STALE_THRESHOLD_MS;
}

// ---------------------------------------------------------------------------
// Pattern content validation
// ---------------------------------------------------------------------------

export function validatePattern(content: string, name: string): string[] {
  const warnings: string[] = [];
  const byteLength = Buffer.byteLength(content);
  if (byteLength > MAX_PATTERN_SIZE_BYTES) {
    warnings.push(
      `Pattern "${name}" is unusually large (${byteLength} bytes)`
    );
  }
  for (const signal of INJECTION_SIGNALS) {
    if (signal.test(content)) {
      warnings.push(
        `Pattern "${name}" contains potential injection signal: ${signal}`
      );
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Main resolve function
// ---------------------------------------------------------------------------

export function resolvePattern(name: string): ResolveResult {
  const warnings: string[] = [];

  // Sentinel staleness check
  if (isSentinelStale()) {
    warnings.push(
      "Note: Pattern library may not be synced. Run UpdatePatterns to refresh."
    );
  }

  const systemMdPath = join(PATTERNS_DIR, name, "system.md");

  if (!existsSync(systemMdPath)) {
    // Pattern not found — provide fuzzy suggestions
    const allPatterns = listPatternNames();
    const suggestions = suggestPatterns(name, allPatterns);
    const suggestionStr = suggestions.length > 0
      ? suggestions.join(", ")
      : "none found";
    return {
      found: false,
      patternPath: null,
      content: null,
      warnings,
      error: `Pattern '${name}' not found. Did you mean: ${suggestionStr}? Run 'UpdatePatterns' to refresh the pattern library.`,
      suggestions,
    };
  }

  // Pattern found — read content and validate
  const content = readFileSync(systemMdPath, "utf8");
  const validationWarnings = validatePattern(content, name);
  warnings.push(...validationWarnings);

  return {
    found: true,
    patternPath: systemMdPath,
    content,
    warnings,
    error: null,
    suggestions: [],
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const [command, patternName] = process.argv.slice(2);

  if (!command || !patternName) {
    console.error("Usage: bun PatternResolver.ts resolve|validate <pattern_name>");
    process.exit(1);
  }

  if (command === "resolve") {
    const result = resolvePattern(patternName);

    if (result.warnings.length > 0) {
      for (const w of result.warnings) {
        console.warn(w);
      }
    }

    if (!result.found) {
      console.error(result.error);
      process.exit(1);
    }

    console.log(`Pattern '${patternName}' resolved at: ${result.patternPath}`);
    process.exit(0);
  } else if (command === "validate") {
    const systemMdPath = join(PATTERNS_DIR, patternName, "system.md");
    if (!existsSync(systemMdPath)) {
      console.error(`Pattern '${patternName}' not found at ${systemMdPath}`);
      process.exit(1);
    }
    const content = readFileSync(systemMdPath, "utf8");
    const warnings = validatePattern(content, patternName);
    if (warnings.length === 0) {
      console.log(`Pattern '${patternName}' passed validation.`);
    } else {
      for (const w of warnings) {
        console.warn(w);
      }
    }
    process.exit(0);
  } else {
    console.error(`Unknown command: ${command}. Use 'resolve' or 'validate'.`);
    process.exit(1);
  }
}
