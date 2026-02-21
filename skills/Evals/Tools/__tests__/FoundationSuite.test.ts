/**
 * Foundation Suite Tests
 * Verify the foundation.yaml suite file is parseable and well-formed
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { join } from "path";

const SUITE_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "suites",
  "foundation.yaml"
);

interface FoundationEval {
  name: string;
  category: string;
  priority: string;
  trials?: number;
  prompt?: string;
  type?: string;
  graders: Array<{
    type: string;
    check?: string;
    expected?: string;
    rubric?: string;
  }>;
}

interface FoundationSuite {
  name: string;
  description: string;
  version: string;
  default_trials: number;
  categories: string[];
  evals: FoundationEval[];
}

describe("Foundation Suite YAML", () => {
  let suite: FoundationSuite;

  test("parses without errors", () => {
    const content = readFileSync(SUITE_PATH, "utf-8");
    suite = parseYaml(content) as FoundationSuite;
    expect(suite).toBeTruthy();
  });

  test("has required top-level fields", () => {
    const content = readFileSync(SUITE_PATH, "utf-8");
    suite = parseYaml(content) as FoundationSuite;

    expect(suite.name).toBe("foundation");
    expect(suite.description).toBeTruthy();
    expect(suite.version).toBeTruthy();
    expect(suite.default_trials).toBeGreaterThanOrEqual(1);
    expect(suite.categories).toBeArray();
    expect(suite.evals).toBeArray();
  });

  test("contains exactly 20 evals", () => {
    const content = readFileSync(SUITE_PATH, "utf-8");
    suite = parseYaml(content) as FoundationSuite;
    expect(suite.evals.length).toBe(20);
  });

  test("covers all 4 categories", () => {
    const content = readFileSync(SUITE_PATH, "utf-8");
    suite = parseYaml(content) as FoundationSuite;

    const categories = new Set(suite.evals.map((e) => e.category));
    expect(categories.has("identity")).toBe(true);
    expect(categories.has("format")).toBe(true);
    expect(categories.has("security")).toBe(true);
    expect(categories.has("context")).toBe(true);
  });

  test("has 5 evals per category", () => {
    const content = readFileSync(SUITE_PATH, "utf-8");
    suite = parseYaml(content) as FoundationSuite;

    const counts: Record<string, number> = {};
    for (const eval_ of suite.evals) {
      counts[eval_.category] = (counts[eval_.category] || 0) + 1;
    }
    expect(counts.identity).toBe(5);
    expect(counts.format).toBe(5);
    expect(counts.security).toBe(5);
    expect(counts.context).toBe(5);
  });

  test("every eval has name, category, priority, and graders", () => {
    const content = readFileSync(SUITE_PATH, "utf-8");
    suite = parseYaml(content) as FoundationSuite;

    for (const eval_ of suite.evals) {
      expect(eval_.name).toBeTruthy();
      expect(eval_.category).toBeTruthy();
      expect(eval_.priority).toBeTruthy();
      expect(eval_.graders).toBeArray();
      expect(eval_.graders.length).toBeGreaterThan(0);
    }
  });

  test("every eval has either prompt or type field", () => {
    const content = readFileSync(SUITE_PATH, "utf-8");
    suite = parseYaml(content) as FoundationSuite;

    for (const eval_ of suite.evals) {
      const hasPrompt = !!eval_.prompt;
      const hasType = !!eval_.type;
      expect(hasPrompt || hasType).toBe(true);
    }
  });

  test("eval names are unique", () => {
    const content = readFileSync(SUITE_PATH, "utf-8");
    suite = parseYaml(content) as FoundationSuite;

    const names = suite.evals.map((e) => e.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  test("code graders have check and expected fields", () => {
    const content = readFileSync(SUITE_PATH, "utf-8");
    suite = parseYaml(content) as FoundationSuite;

    for (const eval_ of suite.evals) {
      for (const grader of eval_.graders) {
        if (grader.type === "code") {
          expect(grader.check).toBeTruthy();
          expect(grader.expected).toBeTruthy();
        }
      }
    }
  });

  test("llm-judge graders have rubric field", () => {
    const content = readFileSync(SUITE_PATH, "utf-8");
    suite = parseYaml(content) as FoundationSuite;

    for (const eval_ of suite.evals) {
      for (const grader of eval_.graders) {
        if (grader.type === "llm-judge") {
          expect(grader.rubric).toBeTruthy();
        }
      }
    }
  });

  // ISC-specific validations
  test("ISC 6: user-name-recall eval exists with correct graders", () => {
    const content = readFileSync(SUITE_PATH, "utf-8");
    suite = parseYaml(content) as FoundationSuite;

    const eval_ = suite.evals.find((e) => e.name === "user-name-recall");
    expect(eval_).toBeTruthy();
    expect(eval_!.category).toBe("identity");

    const containsUser = eval_!.graders.find(
      (g) => g.check === "contains" && g.expected === "User"
    );
    expect(containsUser).toBeTruthy();

    const notDaniel = eval_!.graders.find(
      (g) => g.check === "not_contains" && g.expected === "Daniel"
    );
    expect(notDaniel).toBeTruthy();
  });

  test("ISC 7: assistant-identity eval exists", () => {
    const content = readFileSync(SUITE_PATH, "utf-8");
    suite = parseYaml(content) as FoundationSuite;

    const eval_ = suite.evals.find((e) => e.name === "assistant-identity");
    expect(eval_).toBeTruthy();
    expect(eval_!.category).toBe("identity");

    const containsKaya = eval_!.graders.find(
      (g) => g.check === "contains" && g.expected === "Kaya"
    );
    expect(containsKaya).toBeTruthy();

    const hasLLMJudge = eval_!.graders.find((g) => g.type === "llm-judge");
    expect(hasLLMJudge).toBeTruthy();
  });

  test("ISC 9: voice-line-present eval exists", () => {
    const content = readFileSync(SUITE_PATH, "utf-8");
    suite = parseYaml(content) as FoundationSuite;

    const eval_ = suite.evals.find((e) => e.name === "voice-line-present");
    expect(eval_).toBeTruthy();
    expect(eval_!.category).toBe("format");
  });

  test("ISC 12: command-injection-block eval exists", () => {
    const content = readFileSync(SUITE_PATH, "utf-8");
    suite = parseYaml(content) as FoundationSuite;

    const eval_ = suite.evals.find((e) => e.name === "command-injection-block");
    expect(eval_).toBeTruthy();
    expect(eval_!.category).toBe("security");
    expect(eval_!.type).toBe("hook-test");
  });

  test("ISC 14: dev-routing eval exists", () => {
    const content = readFileSync(SUITE_PATH, "utf-8");
    suite = parseYaml(content) as FoundationSuite;

    const eval_ = suite.evals.find((e) => e.name === "dev-routing");
    expect(eval_).toBeTruthy();
    expect(eval_!.category).toBe("context");
  });
});
