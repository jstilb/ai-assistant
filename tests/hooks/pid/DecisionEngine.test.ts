/**
 * DecisionEngine Tests
 * =====================
 * Tests for the aggregation and policy logic.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { decide, formatWarning, formatBlockMessage } from "../../../hooks/lib/pid/DecisionEngine";
import { resetCaches, loadConfig } from "../../../hooks/lib/pid/patterns/index";
import type { ScanFinding, InjectionDefenderConfig } from "../../../hooks/lib/pid/types";

let config: InjectionDefenderConfig;

beforeEach(() => {
  resetCaches();
  config = loadConfig();
});

function makeFinding(overrides: Partial<ScanFinding>): ScanFinding {
  return {
    layer: "regex",
    category: "instruction_override",
    severity: "medium",
    confidence: 0.5,
    matched_text: "test match",
    description: "Test finding",
    context: {
      tool: "Read",
      position: 0,
      surrounding: "...test context...",
    },
    ...overrides,
  };
}

describe("DecisionEngine - Clean Content", () => {
  test("returns clean result for no findings", () => {
    const result = decide([], 1.5, ["regex"], config);
    expect(result.clean).toBe(true);
    expect(result.recommended_action).toBe("log");
    expect(result.max_severity).toBe("info");
  });
});

describe("DecisionEngine - Block Decision", () => {
  test("blocks on critical + high confidence", () => {
    const findings = [
      makeFinding({ severity: "critical", confidence: 0.85, category: "instruction_override" }),
    ];
    const result = decide(findings, 3.0, ["regex"], config);
    expect(result.recommended_action).toBe("block");
    expect(result.clean).toBe(false);
    expect(result.max_severity).toBe("critical");
  });

  test("does NOT block on critical + low confidence", () => {
    const findings = [
      makeFinding({ severity: "critical", confidence: 0.5 }),
    ];
    const result = decide(findings, 3.0, ["regex"], config);
    expect(result.recommended_action).not.toBe("block");
  });
});

describe("DecisionEngine - Warn Decision", () => {
  test("warns on high + sufficient confidence", () => {
    const findings = [
      makeFinding({ severity: "high", confidence: 0.75 }),
    ];
    const result = decide(findings, 3.0, ["regex"], config);
    expect(result.recommended_action).toBe("warn");
  });

  test("does NOT warn on high + low confidence", () => {
    const findings = [
      makeFinding({ severity: "high", confidence: 0.5 }),
    ];
    const result = decide(findings, 3.0, ["regex"], config);
    expect(result.recommended_action).toBe("log");
  });
});

describe("DecisionEngine - Log Decision", () => {
  test("logs on medium findings only", () => {
    const findings = [
      makeFinding({ severity: "medium", confidence: 0.6 }),
      makeFinding({ severity: "low", confidence: 0.4 }),
    ];
    const result = decide(findings, 5.0, ["regex", "structural"], config);
    expect(result.recommended_action).toBe("log");
  });
});

describe("DecisionEngine - Category Policy Overrides", () => {
  test("applies category policy override", () => {
    const customConfig: InjectionDefenderConfig = {
      ...config,
      category_policies: {
        instruction_override: {
          action: "block",
          enabled: true,
        },
      },
    };

    const findings = [
      makeFinding({ severity: "high", confidence: 0.75, category: "instruction_override" }),
    ];
    const result = decide(findings, 3.0, ["regex"], customConfig);
    expect(result.recommended_action).toBe("block");
  });
});

describe("DecisionEngine - Multiple Findings", () => {
  test("escalates to highest severity action", () => {
    const findings = [
      makeFinding({ severity: "low", confidence: 0.3 }),
      makeFinding({ severity: "medium", confidence: 0.5 }),
      makeFinding({ severity: "high", confidence: 0.75, category: "data_exfiltration" }),
    ];
    const result = decide(findings, 10.0, ["regex", "encoding", "structural"], config);
    expect(result.recommended_action).toBe("warn");
    expect(result.max_severity).toBe("high");
  });

  test("tracks all layers executed", () => {
    const result = decide([], 5.0, ["regex", "encoding", "structural"], config);
    expect(result.layers_executed).toEqual(["regex", "encoding", "structural"]);
  });
});

describe("DecisionEngine - Warning Formatting", () => {
  test("formats warning message correctly", () => {
    const result = decide(
      [makeFinding({ severity: "high", confidence: 0.80, description: "Fake system message" })],
      3.0, ["regex"], config
    );
    const warning = formatWarning(result, "/tmp/evil.txt", "Read");
    expect(warning).toContain("[SECURITY WARNING]");
    expect(warning).toContain("Read");
    expect(warning).toContain("/tmp/evil.txt");
    expect(warning).toContain("Fake system message");
    expect(warning).toContain("DATA only");
  });

  test("formats block message correctly", () => {
    const result = decide(
      [makeFinding({ severity: "critical", confidence: 0.90 })],
      2.0, ["regex"], config
    );
    const block = formatBlockMessage(result, "/tmp/evil.txt", "Read");
    expect(block).toContain("PROMPT INJECTION BLOCKED");
    expect(block).toContain("Read");
    expect(block).toContain("/tmp/evil.txt");
  });
});
