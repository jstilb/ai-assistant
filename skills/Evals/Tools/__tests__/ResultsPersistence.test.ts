/**
 * ResultsPersistence Tests
 * Verify results are persisted to MEMORY/VALIDATION/evals/YYYY-MM-DD/
 */

import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import {
  persistResult,
  persistAggregateResults,
  getResultsPath,
  type EvalResult,
} from "../ResultsPersistence.ts";

const TEST_DATE = new Date("2099-01-01T00:00:00Z");
const CLEANUP_DIR = join(
  process.env.HOME || "",
  ".claude",
  "MEMORY",
  "VALIDATION",
  "evals",
  "2099-01-01"
);

afterAll(() => {
  // Clean up test artifacts
  if (existsSync(CLEANUP_DIR)) {
    rmSync(CLEANUP_DIR, { recursive: true });
  }
});

describe("ResultsPersistence", () => {
  describe("getResultsPath", () => {
    test("returns correct path format with date", () => {
      const path = getResultsPath("foundation", TEST_DATE);
      expect(path).toContain("MEMORY/VALIDATION/evals/2099-01-01/foundation-results.jsonl");
    });
  });

  describe("persistResult", () => {
    test("creates JSONL file with correct schema", () => {
      const result: EvalResult = {
        eval_name: "test-persistence-eval",
        category: "test",
        scores: [1.0, 0.8],
        passed: [true, true],
        grader_details: [
          {
            type: "contains",
            check: "contains",
            score: 1.0,
            pass: true,
            details: "Found expected string",
          },
        ],
      };

      const filePath = persistResult(
        "test-suite",
        result,
        { pass_rate: 1.0, pass_at_k: 1.0, pass_all_k: 1.0 },
        TEST_DATE
      );

      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath, "utf-8").trim();
      const entry = JSON.parse(content);

      expect(entry.suite).toBe("test-suite");
      expect(entry.eval_name).toBe("test-persistence-eval");
      expect(entry.category).toBe("test");
      expect(entry.pass_rate).toBe(1.0);
      expect(entry.pass_at_k).toBe(1.0);
      expect(entry.pass_all_k).toBe(1.0);
      expect(entry.timestamp).toBeTruthy();
      expect(entry.trial_scores).toEqual([1.0, 0.8]);
    });
  });

  describe("persistAggregateResults", () => {
    test("computes per-category statistics", () => {
      const results: EvalResult[] = [
        {
          eval_name: "id-1",
          category: "identity",
          scores: [1.0],
          passed: [true],
          grader_details: [],
        },
        {
          eval_name: "id-2",
          category: "identity",
          scores: [0.5],
          passed: [false],
          grader_details: [],
        },
        {
          eval_name: "fmt-1",
          category: "format",
          scores: [1.0],
          passed: [true],
          grader_details: [],
        },
      ];

      const filePath = persistAggregateResults("test-aggregate", results, TEST_DATE);
      expect(existsSync(filePath)).toBe(true);

      const lines = readFileSync(filePath, "utf-8").trim().split("\n");
      const lastLine = JSON.parse(lines[lines.length - 1]);

      expect(lastLine.type).toBe("aggregate");
      expect(lastLine.total_evals).toBe(3);
      expect(lastLine.passed_evals).toBe(2);
      expect(lastLine.per_category.identity.total).toBe(2);
      expect(lastLine.per_category.identity.passed).toBe(1);
      expect(lastLine.per_category.format.total).toBe(1);
      expect(lastLine.per_category.format.passed).toBe(1);
    });
  });
});
