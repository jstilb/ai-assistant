import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

interface InjectionCase {
  attack_payload: string;
  expected_detection_result: "DETECTED" | "ALLOWED";
  actual_result: "DETECTED" | "ALLOWED";
  pattern_id: string;
  category: string;
}

// Load JSONL test cases from the same directory
const casesPath = join(import.meta.dir, "prompt-injection-cases.jsonl");
const cases: InjectionCase[] = readFileSync(casesPath, "utf-8")
  .trim()
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as InjectionCase);

describe("Prompt Injection Detection Cases", () => {
  it("should load between 20 and 30 test cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(cases.length).toBeLessThanOrEqual(30);
  });

  it("should have all required fields in each case", () => {
    for (const c of cases) {
      expect(c.attack_payload.length).toBeGreaterThan(0);
      expect(["DETECTED", "ALLOWED"]).toContain(c.expected_detection_result);
      expect(["DETECTED", "ALLOWED"]).toContain(c.actual_result);
      expect(c.pattern_id.length).toBeGreaterThan(0);
      expect(c.category.length).toBeGreaterThan(0);
    }
  });

  it("should cover all major attack categories", () => {
    const categories = new Set(cases.map((c) => c.category));
    expect(categories.has("instruction_override")).toBe(true);
    expect(categories.has("data_exfiltration")).toBe(true);
    expect(categories.has("dangerous_tool_use")).toBe(true);
    expect(categories.has("social_engineering")).toBe(true);
    expect(categories.has("prompt_leaking")).toBe(true);
    expect(categories.has("payload_delivery")).toBe(true);
  });

  it("should include at least one benign (ALLOWED) case", () => {
    const allowedCases = cases.filter(
      (c) => c.expected_detection_result === "ALLOWED"
    );
    expect(allowedCases.length).toBeGreaterThanOrEqual(1);
  });

  it("should have majority attack cases detected", () => {
    const detectedCases = cases.filter(
      (c) => c.expected_detection_result === "DETECTED"
    );
    expect(detectedCases.length).toBeGreaterThanOrEqual(20);
  });

  // Run per-case pass/fail: actual_result must match expected_detection_result
  for (const c of cases) {
    it(`[${c.pattern_id}] ${c.category}: "${c.attack_payload.slice(0, 60)}..." should be ${c.expected_detection_result}`, () => {
      expect(c.actual_result).toBe(c.expected_detection_result);
    });
  }
});
