import { describe, test, expect, mock, beforeAll, afterAll } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

import { ALLOWED_TRANSITIONS } from "./PipelineRepository.ts";

import {
  generateFallbackSpec,
} from "./SpecPipelineRunner.ts";

// Stub inference so the judgeSpecQuality tests below don't spawn a live LLM subprocess.
// Tests that need specific judge behavior set inferenceStub before calling.
import type { InferenceResult } from "../../../../lib/core/Inference.ts";
// Real namespaces captured BEFORE mock.module patches the registry — used by
// afterAll to restore them (mock.module is process-global with no unmock; a
// leaked mock poisons every later test file in the same bun run).
import * as RealInference from "../../../../lib/core/Inference.ts";
import * as RealFailureLog from "../../../../lib/core/FailureLog.ts";

let inferenceStub: (opts: unknown) => Promise<InferenceResult> = async () => ({
  success: true,
  output: JSON.stringify({ verdict: "PASS", reasons: [] }),
  parsed: { verdict: "PASS", reasons: [] },
  latencyMs: 10,
  level: "standard" as const,
  estimatedTokens: { input: 0, output: 0, total: 0 },
  estimatedCostUSD: 0,
});

// mock.module is process-global with no unmock, and re-mocking never
// re-patches importers that already bound the mock — so each mock below
// (a) spreads the real exports captured here, BEFORE the mock.module call
// (the RealX namespace bindings themselves get live-patched once the mock
// installs; the eager spread is what preserves the real functions), and
// (b) routes each stubbed function through a mutable impl that afterAll swaps
// back to the real one, so later test files in the same bun run see real
// behavior again.
const realInferenceExports = { ...RealInference };
const realFailureLogExports = { ...RealFailureLog };

let logFailureImpl: typeof realFailureLogExports.logFailure = () => {};

mock.module("../../../../lib/core/Inference.ts", () => ({
  ...realInferenceExports,
  inference: async (opts: unknown) => inferenceStub(opts),
}));
mock.module("../../../../lib/core/FailureLog.ts", () => ({
  ...realFailureLogExports,
  logFailure: (...args: Parameters<typeof realFailureLogExports.logFailure>) => logFailureImpl(...args),
}));

afterAll(() => {
  // Swap the delegating mocks back to the real implementations (the mock
  // objects themselves stay installed — see the capture comment above).
  // The cast widens the real inference's param to this file's unknown-typed
  // test seam.
  inferenceStub = (opts: unknown) =>
    realInferenceExports.inference(opts as Parameters<typeof realInferenceExports.inference>[0]);
  logFailureImpl = realFailureLogExports.logFailure;
});

// ============================================================================
// 1. Canonical Transition Validation (pure, no I/O) — 8 tests
// S2: replaced deleted validateSpecPipelineTransition with canonical table checks.
// spec-pipeline status → Stage mapping: awaiting-context→intake, all others 1:1.
// ============================================================================

describe("canonical spec-pipeline transition validation", () => {
  test("1. awaiting-context -> researching (intake → researching, allowed)", async () => {
    expect(ALLOWED_TRANSITIONS["intake"]).toContain("researching");
  });

  test("2. awaiting-context -> generating-spec (intake → generating-spec, NOT allowed)", async () => {
    expect(ALLOWED_TRANSITIONS["intake"]).not.toContain("generating-spec");
  });

  test("3. researching -> generating-spec (allowed in canonical)", async () => {
    expect(ALLOWED_TRANSITIONS["researching"]).toContain("generating-spec");
  });

  test("4. generating-spec -> revision-needed (allowed in canonical)", async () => {
    expect(ALLOWED_TRANSITIONS["generating-spec"]).toContain("revision-needed");
  });

  test("5. revision-needed -> researching (allowed in canonical)", async () => {
    expect(ALLOWED_TRANSITIONS["revision-needed"]).toContain("researching");
  });

  test("6. revision-needed -> escalated (allowed in canonical)", async () => {
    expect(ALLOWED_TRANSITIONS["revision-needed"]).toContain("escalated");
  });

  test("7. escalated -> researching (terminal — NOT in canonical exits)", async () => {
    // escalated exits: only intake (manual human reset) and archived
    const exits = ALLOWED_TRANSITIONS["escalated"];
    expect(exits).not.toContain("researching");
    expect(exits).not.toContain("generating-spec");
  });

  test("8. spec-pipeline stages all present in canonical (intake covers awaiting-context)", async () => {
    expect(ALLOWED_TRANSITIONS["intake"]).toBeDefined();
    expect(ALLOWED_TRANSITIONS["researching"]).toBeDefined();
    expect(ALLOWED_TRANSITIONS["generating-spec"]).toBeDefined();
    expect(ALLOWED_TRANSITIONS["revision-needed"]).toBeDefined();
    expect(ALLOWED_TRANSITIONS["escalated"]).toBeDefined();
    expect(ALLOWED_TRANSITIONS["needs-grilling"]).toBeDefined();
  });
});

// ============================================================================
// 2. Spec Quality Judge Edge Cases — 6 tests
// validateISCQuality + validateSliceShape were deleted in Slice 2a
// (feat/dedeterminize-queue-specsheet). They are replaced by judgeSpecQuality.
// These tests stub inference to test the judge's control flow.
// ============================================================================

describe("judgeSpecQuality edge cases", () => {
  let judgeSpecQuality: (spec: string, itemId?: string) => Promise<import("./SpecPipelineRunner.ts").SpecQualityJudgment>;

  // Import after mock.module() is installed
  beforeAll(async () => {
    const mod = await import("./SpecPipelineRunner.ts");
    judgeSpecQuality = mod.judgeSpecQuality;
  });

  test("9. judge returns FAIL for empty/no-ISC spec", async () => {
    inferenceStub = async () => ({
      success: true,
      output: JSON.stringify({ verdict: "FAIL", reasons: ["No ISC table present"] }),
      parsed: { verdict: "FAIL", reasons: ["No ISC table present"] },
      latencyMs: 10,
      level: "standard" as const,
      estimatedTokens: { input: 0, output: 0, total: 0 },
      estimatedCostUSD: 0,
    });
    const result = await judgeSpecQuality("# Empty Spec\n\nNo ISC table here.");
    expect(result.pass).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  test("10. judge returns FAIL for a 2-row skeleton spec", async () => {
    inferenceStub = async () => ({
      success: true,
      output: JSON.stringify({ verdict: "FAIL", reasons: ["Only 2 generic ISC rows"] }),
      parsed: { verdict: "FAIL", reasons: ["Only 2 generic ISC rows"] },
      latencyMs: 10,
      level: "standard" as const,
      estimatedTokens: { input: 0, output: 0, total: 0 },
      estimatedCostUSD: 0,
    });
    const spec = `## 5. ISC\n| 1 | Feature A works | Unit test |\n| 2 | Feature B works | Unit test |`;
    const result = await judgeSpecQuality(spec);
    expect(result.pass).toBe(false);
  });

  test("11. judge returns PASS for a spec with 4 specific rows", async () => {
    inferenceStub = async () => ({
      success: true,
      output: JSON.stringify({ verdict: "PASS", reasons: [] }),
      parsed: { verdict: "PASS", reasons: [] },
      latencyMs: 10,
      level: "standard" as const,
      estimatedTokens: { input: 0, output: 0, total: 0 },
      estimatedCostUSD: 0,
    });
    const spec = `## ISC\n| 1 | API returns 200 | curl check |\n| 2 | Rate limit triggers | benchmark |\n| 3 | DB index <50ms | EXPLAIN ANALYZE |\n| 4 | RFC 7807 errors | JSON schema |`;
    const result = await judgeSpecQuality(spec);
    expect(result.pass).toBe(true);
  });

  test("12. judge returns FAIL for skeleton-phrase spec", async () => {
    inferenceStub = async () => ({
      success: true,
      output: JSON.stringify({ verdict: "FAIL", reasons: ["ISC contains generic boilerplate"] }),
      parsed: { verdict: "FAIL", reasons: ["ISC contains generic boilerplate"] },
      latencyMs: 10,
      level: "standard" as const,
      estimatedTokens: { input: 0, output: 0, total: 0 },
      estimatedCostUSD: 0,
    });
    const spec = `## ISC\n| 1 | Implementation matches problem context | Manual review |`;
    const result = await judgeSpecQuality(spec);
    expect(result.pass).toBe(false);
    expect(result.reasons[0]).toMatch(/boilerplate|generic/i);
  });

  test("13. judge returns FAIL for fallback spec sentinel", async () => {
    inferenceStub = async () => ({
      success: true,
      output: JSON.stringify({ verdict: "FAIL", reasons: ["FALLBACK_SPEC sentinel present"] }),
      parsed: { verdict: "FAIL", reasons: ["FALLBACK_SPEC sentinel present"] },
      latencyMs: 10,
      level: "standard" as const,
      estimatedTokens: { input: 0, output: 0, total: 0 },
      estimatedCostUSD: 0,
    });
    const spec = `## ISC\n| 1 | FALLBACK_SPEC: Inference unavailable | Manual review |`;
    const result = await judgeSpecQuality(spec);
    expect(result.pass).toBe(false);
  });

  test("14. judge PASS on real queue spec (stubbed) — file read confirms rich content", async () => {
    const KAYA_HOME = process.env.KAYA_HOME || join(homedir(), ".claude");
    const specPath = join(KAYA_HOME, "plans/Specs/Queue/mlzhpwzj-jgdswl-spec.md");
    if (!existsSync(specPath)) {
      console.log("Skipping: spec file not found (CI environment)");
      return;
    }
    // Stub returns PASS — confirms the gate passes when the judge approves
    inferenceStub = async () => ({
      success: true,
      output: JSON.stringify({ verdict: "PASS", reasons: [] }),
      parsed: { verdict: "PASS", reasons: [] },
      latencyMs: 10,
      level: "standard" as const,
      estimatedTokens: { input: 0, output: 0, total: 0 },
      estimatedCostUSD: 0,
    });
    const content = readFileSync(specPath, "utf-8");
    const result = await judgeSpecQuality(content);
    expect(result.pass).toBe(true);
  });
});

// ============================================================================
// 3. Verdict-Driven Routing — tests moved to VerdictDrivenRouting.test.ts
// ============================================================================
//
// hassufficientContext / canDeriveISCDirectly were deleted in Slice 1a
// (feat/dedeterminize-queue-specsheet). The routing logic they tested
// has been replaced by verdict-driven routing in addSpecPipelineItem.
// See: skills/Automation/QueueRouter/Tools/__tests__/VerdictDrivenRouting.test.ts

// ============================================================================
// 4. Fallback Spec -> Quality Gate Integration — 3 tests
// ============================================================================

describe("Fallback Spec -> Quality Gate", () => {
  const mockItem = {
    id: "test-fallback-001",
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    source: "test" as const,
    priority: 2 as const,
    status: "generating-spec" as const,
    type: "task" as const,
    queue: "spec-pipeline",
    payload: {
      title: "Test Fallback Item",
      description: "Build a monitoring dashboard for microservices.",
    },
    routing: { targetQueue: "spec-pipeline" },
  };

  const mockCtx = {
    notes: "Build a monitoring dashboard for microservices.",
    researchGuidance: "Research Prometheus + Grafana integration patterns.",
    scopeHints: undefined as string | undefined,
    lucidTaskId: undefined as string | undefined,
    revisionCount: 0,
    lastRejectionReason: undefined as string | undefined,
    previousResearchPath: undefined as string | undefined,
    previousSpecPath: undefined as string | undefined,
  };

  test("20. Fallback spec output has [FALLBACK] markers", async () => {
    const content = generateFallbackSpec(mockItem as any, mockCtx, "medium", "");
    expect(content).toContain("[FALLBACK]");
    expect(content).toContain("FALLBACK_SPEC:");
  });

  test("21. Fallback spec is judged as FAIL (stubbed judge rejects sentinel)", async () => {
    // The judge is expected to reject fallback specs because their ISC sentinel
    // ("FALLBACK_SPEC: Inference unavailable") is clearly not a substantive criterion.
    // We stub to FAIL here; the live eval validates the real LLM agrees.
    inferenceStub = async () => ({
      success: true,
      output: JSON.stringify({ verdict: "FAIL", reasons: ["FALLBACK_SPEC sentinel: spec requires re-generation"] }),
      parsed: { verdict: "FAIL", reasons: ["FALLBACK_SPEC sentinel: spec requires re-generation"] },
      latencyMs: 10,
      level: "standard" as const,
      estimatedTokens: { input: 0, output: 0, total: 0 },
      estimatedCostUSD: 0,
    });
    const { judgeSpecQuality } = await import("./SpecPipelineRunner.ts");
    const content = generateFallbackSpec(mockItem as any, mockCtx, "medium", "");
    const result = await judgeSpecQuality(content);
    expect(result.pass).toBe(false);
  });

  test("22. Fallback spec ISC contains FALLBACK_SPEC: sentinel", async () => {
    const content = generateFallbackSpec(mockItem as any, mockCtx, "medium", "");
    const iscLine = content.split("\n").find((l) => l.includes("FALLBACK_SPEC:"));
    expect(iscLine).toBeDefined();
    expect(iscLine!).toContain("Inference unavailable");
  });
});

// ============================================================================
// 5. autoRouted flag behavior — tested in GrillStamp.test.ts (stateful,
//    requires QueueManager isolation). Tests 12–15 live there.
// ============================================================================

// ============================================================================
// 6. Real Spec Quality Gate Sweep — 1 test
// Stubbed judge always returns PASS — confirms no structural error reading specs.
// The live eval (spec-quality-judge.yaml) runs the real LLM against these files.
// ============================================================================

describe("Real Spec Quality Gate Sweep", () => {
  test("27. All mlzh* queue specs are readable and pass the stubbed judge", async () => {
    // Stub: always PASS. This test verifies we can read the files and the judge
    // processes them without throwing. Live quality judgment = spec-quality-judge.yaml.
    inferenceStub = async () => ({
      success: true,
      output: JSON.stringify({ verdict: "PASS", reasons: [] }),
      parsed: { verdict: "PASS", reasons: [] },
      latencyMs: 10,
      level: "standard" as const,
      estimatedTokens: { input: 0, output: 0, total: 0 },
      estimatedCostUSD: 0,
    });

    const { judgeSpecQuality } = await import("./SpecPipelineRunner.ts");
    // Real-spec sweep: pin to the live home directly.
    const specsDir = join(homedir(), ".claude", "plans/Specs/Queue");

    const mlzhSpecs = [
      "mlzhpwzj-jgdswl-spec.md",
      "mlzhq70o-vyvhxa-spec.md",
      "mlzhqd9w-0dar19-spec.md",
      "mlzhqk41-g5qbyz-spec.md",
      "mlzhqtdo-kylj4r-spec.md",
      "mlzhr0i4-q5p2ir-spec.md",
      "mlzhr6ve-8zpdob-spec.md",
      "mlzhrg3i-pvwqds-spec.md",
      "mlzhrnb3-cpuk2x-spec.md",
      "mlzhrv9a-0ubyae-spec.md",
      "mlzhs5up-ypvqtq-spec.md",
      "mlzhsdw8-g0p8il-spec.md",
      "mlzhsk2c-u09v5l-spec.md",
    ];

    const results: { file: string; pass: boolean; reasons?: string[] }[] = [];

    for (const file of mlzhSpecs) {
      const path = join(specsDir, file);
      if (!existsSync(path)) {
        // Skip files not present (expected in worktree/CI); don't fail the sweep.
        continue;
      }
      const content = readFileSync(path, "utf-8");
      const check = await judgeSpecQuality(content, file);
      results.push({ file, pass: check.pass, reasons: check.reasons });
    }

    const failures = results.filter((r) => !r.pass);
    if (failures.length > 0) {
      console.log("Judge returned non-pass (unexpected with stubbed PASS):");
      for (const f of failures) {
        console.log(`  x ${f.file}: ${JSON.stringify(f.reasons)}`);
      }
    }

    expect(failures.length).toBe(0);
  });
});
