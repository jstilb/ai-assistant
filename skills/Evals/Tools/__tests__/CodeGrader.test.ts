/**
 * CodeGrader Tests
 * TDD RED phase: Tests for all 6 check types
 * Each check type gets 1 passing and 1 failing example
 */

import { describe, test, expect } from "bun:test";
import {
  stringMatch,
  regexMatch,
  contains,
  notContains,
  fileExists,
  jsonPath,
  type CheckResult,
} from "../CodeGrader.ts";

describe("CodeGrader", () => {
  describe("string_match", () => {
    test("returns pass when actual equals expected", () => {
      const result = stringMatch("Hello World", "Hello World");
      expect(result.pass).toBe(true);
      expect(result.score).toBe(1);
    });

    test("returns fail when actual does not equal expected", () => {
      const result = stringMatch("Hello World", "Goodbye World");
      expect(result.pass).toBe(false);
      expect(result.score).toBe(0);
    });

    test("is case-insensitive by default", () => {
      const result = stringMatch("hello world", "Hello World");
      expect(result.pass).toBe(true);
      expect(result.score).toBe(1);
    });
  });

  describe("regex_match", () => {
    test("returns pass when actual matches regex pattern", () => {
      const result = regexMatch("Kaya is here to help", "Kaya.*help");
      expect(result.pass).toBe(true);
      expect(result.score).toBe(1);
    });

    test("returns fail when actual does not match regex pattern", () => {
      const result = regexMatch("ChatGPT is here", "Kaya.*help");
      expect(result.pass).toBe(false);
      expect(result.score).toBe(0);
    });

    test("supports flags like case-insensitive", () => {
      const result = regexMatch("KAYA is here", "kaya.*here", "i");
      expect(result.pass).toBe(true);
    });
  });

  describe("contains", () => {
    test("returns pass when actual contains expected substring", () => {
      const result = contains("Hello User, how are you?", "User");
      expect(result.pass).toBe(true);
      expect(result.score).toBe(1);
    });

    test("returns fail when actual does not contain expected substring", () => {
      const result = contains("Hello user, how are you?", "User");
      expect(result.pass).toBe(false);
      expect(result.score).toBe(0);
    });
  });

  describe("not_contains", () => {
    test("returns pass when actual does not contain forbidden string", () => {
      const result = notContains("Hello User, how are you?", "Daniel");
      expect(result.pass).toBe(true);
      expect(result.score).toBe(1);
    });

    test("returns fail when actual contains forbidden string", () => {
      const result = notContains("Hello Daniel, how are you?", "Daniel");
      expect(result.pass).toBe(false);
      expect(result.score).toBe(0);
    });
  });

  describe("file_exists", () => {
    test("returns pass when file exists", () => {
      // Use a file we know exists
      const result = fileExists("~/.claude/skills/Evals/SKILL.md", "true");
      expect(result.pass).toBe(true);
      expect(result.score).toBe(1);
    });

    test("returns fail when file does not exist", () => {
      const result = fileExists("~/.claude/nonexistent-file-xyz.txt", "true");
      expect(result.pass).toBe(false);
      expect(result.score).toBe(0);
    });
  });

  describe("json_path", () => {
    test("returns pass when JSON path value matches expected", () => {
      const jsonStr = JSON.stringify({ user: { name: "User", age: 30 } });
      const result = jsonPath(jsonStr, "user.name=User");
      expect(result.pass).toBe(true);
      expect(result.score).toBe(1);
    });

    test("returns fail when JSON path value does not match expected", () => {
      const jsonStr = JSON.stringify({ user: { name: "Daniel", age: 30 } });
      const result = jsonPath(jsonStr, "user.name=User");
      expect(result.pass).toBe(false);
      expect(result.score).toBe(0);
    });

    test("returns fail for invalid JSON", () => {
      const result = jsonPath("not json", "user.name=User");
      expect(result.pass).toBe(false);
      expect(result.score).toBe(0);
    });

    test("handles nested paths", () => {
      const jsonStr = JSON.stringify({ a: { b: { c: "deep" } } });
      const result = jsonPath(jsonStr, "a.b.c=deep");
      expect(result.pass).toBe(true);
    });
  });

  describe("CheckResult structure", () => {
    test("every check returns pass, score, and details", () => {
      const result = contains("test", "test");
      expect(result).toHaveProperty("pass");
      expect(result).toHaveProperty("score");
      expect(result).toHaveProperty("details");
      expect(typeof result.pass).toBe("boolean");
      expect(typeof result.score).toBe("number");
      expect(typeof result.details).toBe("string");
    });
  });
});
