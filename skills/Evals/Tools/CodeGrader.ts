#!/usr/bin/env bun
/**
 * CodeGrader - Deterministic code-based grading for eval suites
 *
 * Supports 6 check types:
 *   string_match  - Exact string comparison (case-insensitive by default)
 *   regex_match   - Regex pattern matching
 *   contains      - Substring presence check
 *   not_contains  - Substring absence check
 *   file_exists   - File existence verification
 *   json_path     - JSON path value extraction and comparison
 *
 * Each check returns { pass: boolean, score: number, details: string }
 *
 * Usage (CLI):
 *   bun CodeGrader.ts <check_type> <actual> <expected>
 *
 * Usage (Library):
 *   import { contains, notContains } from './CodeGrader.ts';
 *   const result = contains("Hello User", "User");
 */

import { existsSync } from "fs";

// ============================================================================
// Types
// ============================================================================

export interface CheckResult {
  pass: boolean;
  score: number;
  details: string;
}

// ============================================================================
// Check Type Implementations
// ============================================================================

/**
 * string_match: Exact string comparison (case-insensitive by default)
 */
export function stringMatch(actual: string, expected: string): CheckResult {
  const normalizedActual = actual.toLowerCase();
  const normalizedExpected = expected.toLowerCase();
  const pass = normalizedActual === normalizedExpected;
  return {
    pass,
    score: pass ? 1 : 0,
    details: pass
      ? `String match: "${expected}" matched`
      : `String match failed: expected "${expected}", got "${actual.slice(0, 100)}"`,
  };
}

/**
 * regex_match: Pattern matching against actual output
 */
export function regexMatch(
  actual: string,
  pattern: string,
  flags?: string
): CheckResult {
  try {
    const regex = new RegExp(pattern, flags);
    const pass = regex.test(actual);
    return {
      pass,
      score: pass ? 1 : 0,
      details: pass
        ? `Regex match: /${pattern}/${flags || ""} matched`
        : `Regex match failed: /${pattern}/${flags || ""} did not match output`,
    };
  } catch (e) {
    return {
      pass: false,
      score: 0,
      details: `Regex error: ${e}`,
    };
  }
}

/**
 * contains: Check if actual output contains expected substring
 */
export function contains(actual: string, expected: string): CheckResult {
  const pass = actual.includes(expected);
  return {
    pass,
    score: pass ? 1 : 0,
    details: pass
      ? `Contains: found "${expected}" in output`
      : `Contains failed: "${expected}" not found in output`,
  };
}

/**
 * not_contains: Check if actual output does NOT contain forbidden string
 */
export function notContains(actual: string, forbidden: string): CheckResult {
  const pass = !actual.includes(forbidden);
  return {
    pass,
    score: pass ? 1 : 0,
    details: pass
      ? `Not contains: "${forbidden}" correctly absent from output`
      : `Not contains failed: "${forbidden}" was found in output`,
  };
}

/**
 * file_exists: Check if a file exists at the given path
 * actual = file path, expected = "true" or "false" (whether it should exist)
 */
export function fileExists(actual: string, expected: string): CheckResult {
  const exists = existsSync(actual);
  const shouldExist = expected.toLowerCase() !== "false";
  const pass = exists === shouldExist;
  return {
    pass,
    score: pass ? 1 : 0,
    details: pass
      ? `File exists check: ${actual} ${exists ? "exists" : "does not exist"} as expected`
      : `File exists check failed: ${actual} ${exists ? "exists" : "does not exist"}, expected ${shouldExist ? "exists" : "does not exist"}`,
  };
}

/**
 * json_path: Extract a value from JSON using dot-notation path and compare
 * expected format: "path.to.value=expectedValue"
 */
export function jsonPath(actual: string, expected: string): CheckResult {
  // Parse expected format: "path.to.value=expectedValue"
  const eqIndex = expected.indexOf("=");
  if (eqIndex === -1) {
    return {
      pass: false,
      score: 0,
      details: `JSON path error: expected format "path.to.value=expectedValue", got "${expected}"`,
    };
  }

  const path = expected.slice(0, eqIndex);
  const expectedValue = expected.slice(eqIndex + 1);

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(actual);
  } catch (e) {
    return {
      pass: false,
      score: 0,
      details: `JSON parse error: ${e}`,
    };
  }

  // Navigate path
  const parts = path.split(".");
  let current: unknown = parsed;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return {
        pass: false,
        score: 0,
        details: `JSON path "${path}" not found: "${part}" is not an object`,
      };
    }
    current = (current as Record<string, unknown>)[part];
  }

  // Compare
  const actualValue = String(current);
  const pass = actualValue === expectedValue;
  return {
    pass,
    score: pass ? 1 : 0,
    details: pass
      ? `JSON path "${path}" = "${expectedValue}" matched`
      : `JSON path "${path}" mismatch: expected "${expectedValue}", got "${actualValue}"`,
  };
}

// ============================================================================
// Check Type Registry
// ============================================================================

const CHECK_TYPES: Record<
  string,
  (actual: string, expected: string, flags?: string) => CheckResult
> = {
  string_match: stringMatch,
  regex_match: regexMatch,
  contains,
  not_contains: notContains,
  file_exists: fileExists,
  json_path: jsonPath,
};

/**
 * Run a check by type name
 */
export function runCheck(
  checkType: string,
  actual: string,
  expected: string,
  flags?: string
): CheckResult {
  const checkFn = CHECK_TYPES[checkType];
  if (!checkFn) {
    return {
      pass: false,
      score: 0,
      details: `Unknown check type: ${checkType}. Available: ${Object.keys(CHECK_TYPES).join(", ")}`,
    };
  }
  return checkFn(actual, expected, flags);
}

/**
 * Run multiple checks and aggregate results
 */
export function runChecks(
  checks: Array<{ type: string; actual: string; expected: string; flags?: string }>
): {
  results: CheckResult[];
  allPassed: boolean;
  aggregateScore: number;
} {
  const results = checks.map((c) => runCheck(c.type, c.actual, c.expected, c.flags));
  const allPassed = results.every((r) => r.pass);
  const aggregateScore =
    results.length > 0
      ? results.reduce((sum, r) => sum + r.score, 0) / results.length
      : 0;
  return { results, allPassed, aggregateScore };
}

// ============================================================================
// CLI Interface
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length < 3 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
CodeGrader - Deterministic code-based grading

Usage:
  bun CodeGrader.ts <check_type> <actual> <expected> [flags]

Check Types:
  string_match   Exact string comparison (case-insensitive)
  regex_match    Regex pattern matching
  contains       Substring presence check
  not_contains   Substring absence check
  file_exists    File existence verification
  json_path      JSON path value comparison (format: "path.to.value=expected")

Examples:
  bun CodeGrader.ts contains "Hello User" "User"
  bun CodeGrader.ts regex_match "Kaya is here" "Kaya.*here"
  bun CodeGrader.ts not_contains "Hello User" "Daniel"
  bun CodeGrader.ts json_path '{"user":{"name":"User"}}' "user.name=User"
  bun CodeGrader.ts file_exists "/path/to/file" "true"
`);
    process.exit(0);
  }

  const [checkType, actual, expected, flags] = args;
  const result = runCheck(checkType, actual, expected, flags);

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
}
