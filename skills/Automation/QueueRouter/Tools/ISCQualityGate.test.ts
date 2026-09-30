/**
 * ISCQualityGate.test.ts
 *
 * Tests for the LLM spec-quality judge (judgeSpecQuality).
 * Inference is stubbed via module mock so these tests run without a live Claude
 * subprocess — the unit under test is the judge's control flow, JSON parsing,
 * and error handling, not the LLM's content judgment.
 *
 * The two real grilled specs that previously false-failed the deterministic gate
 * (mq5vmjmh LifeOS, mq647gx0 Cooking) are tested against the STUBBED judge to
 * confirm they would PASS when the judge returns PASS — proving that the
 * false-positive was entirely in the old regex gate, not in the spec content.
 *
 * Live eval (running the actual LLM against those full spec fixtures) is in:
 *   skills/Intelligence/Evals/UseCases/SpecSheet/spec-quality-judge.yaml
 * and requires an authorized run context.
 */

import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import type { InferenceResult } from "../../../../lib/core/Inference.ts";
// Real namespaces captured BEFORE mock.module patches the registry — used by
// afterAll to restore them (mock.module is process-global with no unmock; a
// leaked mock poisons every later test file in the same bun run).
import * as RealInference from "../../../../lib/core/Inference.ts";
import * as RealFailureLog from "../../../../lib/core/FailureLog.ts";

// ============================================================================
// Stub helpers
// ============================================================================

/**
 * Build a minimal InferenceResult that looks like a successful judge response.
 */
function successResult(verdict: "PASS" | "FAIL" | "NEEDS_REVIEW", reasons: string[] = []): InferenceResult {
  const parsed = { verdict, reasons };
  return {
    success: true,
    output: JSON.stringify(parsed),
    parsed,
    latencyMs: 100,
    level: "standard",
    estimatedTokens: { input: 100, output: 50, total: 150 },
    estimatedCostUSD: 0.001,
  };
}

function failureResult(error: string): InferenceResult {
  return {
    success: false,
    output: "",
    error,
    latencyMs: 100,
    level: "standard",
    estimatedTokens: { input: 0, output: 0, total: 0 },
    estimatedCostUSD: 0,
  };
}

// ============================================================================
// Module-level mock for inference
// ============================================================================

// We mock the Inference module by reassigning the import-time reference.
// judgeSpecQuality is imported AFTER the mock is installed via dynamic import.

let inferenceMock: (opts: unknown) => Promise<InferenceResult>;

// judgeSpecQuality's transitive import chain now runs through
// lib/core/AgentSpawner.ts (B3: migrated onto AgentSpawner for the research
// spawn), which statically imports CLAUDE_PATH, buildHardenedClaudeEnv, and
// stripDangerousClaudeEnvKeys from this same Inference.ts module. Since this
// mock.module() call is what SpecPipelineRunner.ts's dynamic import (below)
// first resolves against, those names must exist on the mock facade or bun
// throws a SyntaxError at import time ("Export named ... not found"). These
// tests never call spawnAgentSync's env-building path, so minimal
// behavior-equivalent stubs are sufficient (mirrors the idiom already used
// in ResearchInfraDefer.test.ts, which mocks AgentSpawner.ts wholesale).
// mock.module is process-global with no unmock, and re-mocking never
// re-patches importers that already bound the mock — so each mock below
// (a) spreads the real exports captured here, BEFORE the mock.module call
// (the RealX namespace bindings themselves get live-patched once the mock
// installs; the eager spread is what preserves the real functions), and
// (b) routes each stubbed function through a mutable impl that afterAll swaps
// back to the real one, so later test files in the same bun run see real
// behavior again. The spread also keeps CLAUDE_PATH /
// buildHardenedClaudeEnv / stripDangerousClaudeEnvKeys as the real values,
// which satisfies AgentSpawner.ts's static imports (see note above).
const realInferenceExports = { ...RealInference };
const realFailureLogExports = { ...RealFailureLog };

let logFailureImpl: typeof realFailureLogExports.logFailure = () => {};
let recordFailureImpl: typeof realFailureLogExports.recordFailure = () => {};

mock.module("../../../../lib/core/Inference.ts", () => ({
  ...realInferenceExports,
  inference: async (opts: unknown) => inferenceMock(opts),
}));

// Silence FailureLog writes in tests. recordFailure is also stubbed: this file's
// judgeSpecQuality import is dynamic (see below), so it resolves AFTER this
// mock.module() call — PipelineRepository.ts (a transitive dependency, slice A2)
// statically imports { recordFailure }, and bun throws a SyntaxError at import
// time if a mocked module is missing a named export a dependent statically imports.
mock.module("../../../../lib/core/FailureLog.ts", () => ({
  ...realFailureLogExports,
  logFailure: (...args: Parameters<typeof realFailureLogExports.logFailure>) => logFailureImpl(...args),
  recordFailure: (...args: Parameters<typeof realFailureLogExports.recordFailure>) =>
    recordFailureImpl(...args),
}));

afterAll(() => {
  // Swap the delegating mocks back to the real implementations (the mock
  // objects themselves stay installed — see the capture comment above).
  // The cast widens the real inference's param to this file's unknown-typed
  // test seam.
  inferenceMock = (opts: unknown) =>
    realInferenceExports.inference(opts as Parameters<typeof realInferenceExports.inference>[0]);
  logFailureImpl = realFailureLogExports.logFailure;
  recordFailureImpl = realFailureLogExports.recordFailure;
});

// ============================================================================
// judgeSpecQuality unit tests
// ============================================================================

describe("judgeSpecQuality", () => {
  // Dynamic import so the mock is installed before the module initialises
  let judgeSpecQuality: (spec: string, itemId?: string) => Promise<import("./SpecPipelineRunner.ts").SpecQualityJudgment>;

  beforeEach(async () => {
    const mod = await import("./SpecPipelineRunner.ts");
    judgeSpecQuality = mod.judgeSpecQuality;
  });

  // --------------------------------------------------------------------------
  // PASS cases
  // --------------------------------------------------------------------------

  test("J1. judge returns PASS → judgment.pass is true, reasons empty", async () => {
    inferenceMock = async () => successResult("PASS");
    const result = await judgeSpecQuality("# Some substantive spec\n\n## ISC\n| 1 | ...", "test-id");
    expect(result.pass).toBe(true);
    expect(result.verdict).toBe("PASS");
    expect(result.reasons).toEqual([]);
  });

  test("J2. LifeOS grilled spec (mq5vmjmh) — stubbed PASS → passes the gate", async () => {
    // This test documents: if the LLM judge correctly judges the rich LifeOS spec
    // as PASS (which the live eval verifies), the gate passes. The false-positive
    // was entirely in the old deterministic regex gate, not in the spec content.
    inferenceMock = async () => successResult("PASS");
    const lifeosFakeSpec = `
## 5. Ideal State Criteria (ISC)

| # | What Ideal Looks Like | Verify Method |
|---|---|---|
| 1 | lifeos.db exists and row counts match Workbook within ±1 | bun tests/lifeos-migration-verify.test.ts |
| 2 | Dual-write is live: test Capture lands in both SQLite and Workbook | Submit test habit; confirm both stores |
| 3 | LifeOSQuery acceptance harness passes | bun tests/lifeos-query-acceptance.test.ts |
| 4 | All seven external consumers produce identical output | Run each consumer, diff outputs |
| 5 | Dashboard accessible at localhost:31337 with real data | Browser: open URL, verify panels |
| 6 | Module restructure complete; all 13 launchd paths valid | bun --check; launchctl list |
| 7 | finance_transactions=0 diagnosed and documented | Written diagnosis present |
| 8 | Jm can Audit any Log domain in ≤5 min | Jm live-demos cold |
`;
    const result = await judgeSpecQuality(lifeosFakeSpec, "mq5vmjmh");
    expect(result.pass).toBe(true);
    expect(result.verdict).toBe("PASS");
  });

  test("J3. Cooking grilled spec (mq647gx0) — stubbed PASS → passes the gate", async () => {
    inferenceMock = async () => successResult("PASS");
    const cookingFakeSpec = `
## 5. Ideal State Criteria (ISC)

| # | What Ideal Looks Like | Verify Method |
|---|---|---|
| 1 | Suggestion command sends Telegram message with cuisine, seasonal rationale, recency note | bun .../WeeklyMealPlanner.ts suggest; confirm Telegram message |
| 2 | On confirm, Mastery doc exists or is scaffolded with all 9 section headers within 30s | For cuisine with no doc: confirm; grep -c '^## ' returns ≥9 |
| 3 | Generated 5-dinner plan has sharedIngredients field with ≥3 dishes sharing an ingredient | Inspect current-meal-plan.json; assert sharedIngredients |
| 4 | Each dominant ingredient has leftoverTechniques including elevatedTechnique with source | Inspect plan output for elevatedTechnique and source fields |
| 5 | Grocery list added to Instacart cart; no order placed; Telegram "Cart ready" notification | Inspect cart; confirm no order; check Telegram |
| 6 | Anki cards created covering flavor triad, aromatic base, ≥1 ratio, ≥2 techniques | Run Anki deck inspection; confirm ≥4 cards with cuisine tag |
| 7 | Plan saved to ~/Desktop/obsidian/Cooking/WeeklyPlan-<date>.md and pushed to Telegram | File exists; wc -l > 20; Telegram message received |
| 8 | launchd job fires Sunday 8am via StartCalendarInterval | launchctl print shows StartCalendarInterval; kickstart produces log |
`;
    const result = await judgeSpecQuality(cookingFakeSpec, "mq647gx0");
    expect(result.pass).toBe(true);
    expect(result.verdict).toBe("PASS");
  });

  // --------------------------------------------------------------------------
  // FAIL cases
  // --------------------------------------------------------------------------

  test("J4. judge returns FAIL → judgment.pass is false, reasons forwarded", async () => {
    const reasons = ["ISC rows contain generic boilerplate like 'no regressions'", "Only 2 ISC rows — insufficient for a real spec"];
    inferenceMock = async () => successResult("FAIL", reasons);
    const result = await judgeSpecQuality("# Skeleton spec\n\n| 1 | implementation matches problem context | Manual |", "test-id");
    expect(result.pass).toBe(false);
    expect(result.verdict).toBe("FAIL");
    expect(result.reasons).toEqual(reasons);
  });

  test("J5. genuinely barren spec — stubbed FAIL → gate rejects with reasons", async () => {
    const barrenSpec = `
## 5. Ideal State Criteria (ISC)

| # | What Ideal Looks Like | Verify Method |
|---|---|---|
| 1 | Implementation matches problem context | Manual review |
| 2 | No regressions in existing functionality | Test suite |
`;
    const reasons = ["ISC rows are generic skeleton phrases with no specific artifacts or commands"];
    inferenceMock = async () => successResult("FAIL", reasons);
    const result = await judgeSpecQuality(barrenSpec, "barren-test");
    expect(result.pass).toBe(false);
    expect(result.verdict).toBe("FAIL");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // NEEDS_REVIEW (ambiguous spec)
  // --------------------------------------------------------------------------

  test("J6. judge returns NEEDS_REVIEW → judgment.pass is false (safe-side)", async () => {
    const reasons = ["Mixed signals: some ISC rows are specific but Phase 1 is ambiguous"];
    inferenceMock = async () => successResult("NEEDS_REVIEW", reasons);
    const result = await judgeSpecQuality("# Ambiguous spec", "test-id");
    expect(result.pass).toBe(false);
    expect(result.verdict).toBe("NEEDS_REVIEW");
    expect(result.reasons).toEqual(reasons);
  });

  // --------------------------------------------------------------------------
  // Inference failure handling (JUDGE_UNAVAILABLE)
  // --------------------------------------------------------------------------

  test("J7. inference returns success:false → JUDGE_UNAVAILABLE, pass:false (loud failure)", async () => {
    inferenceMock = async () => failureResult("inference timeout");
    const result = await judgeSpecQuality("# Some spec", "test-id");
    expect(result.pass).toBe(false);
    expect(result.verdict).toBe("JUDGE_UNAVAILABLE");
    expect(result.reasons[0]).toMatch(/unavailable/i);
  });

  test("J8. inference throws → JUDGE_UNAVAILABLE, pass:false (loud failure)", async () => {
    inferenceMock = async () => { throw new Error("connection refused"); };
    const result = await judgeSpecQuality("# Some spec", "test-id");
    expect(result.pass).toBe(false);
    expect(result.verdict).toBe("JUDGE_UNAVAILABLE");
    expect(result.reasons[0]).toMatch(/unavailable/i);
  });

  test("J9. inference returns malformed verdict → JUDGE_UNAVAILABLE, pass:false", async () => {
    inferenceMock = async () => ({
      success: true,
      output: JSON.stringify({ verdict: "UNKNOWN_VALUE", reasons: [] }),
      parsed: { verdict: "UNKNOWN_VALUE", reasons: [] },
      latencyMs: 100,
      level: "standard" as const,
      estimatedTokens: { input: 0, output: 0, total: 0 },
      estimatedCostUSD: 0,
    });
    const result = await judgeSpecQuality("# Some spec", "test-id");
    expect(result.pass).toBe(false);
    expect(result.verdict).toBe("JUDGE_UNAVAILABLE");
  });

  test("J10. inference returns null parsed → JUDGE_UNAVAILABLE, pass:false", async () => {
    inferenceMock = async () => ({
      success: true,
      output: "not json",
      parsed: null,
      latencyMs: 100,
      level: "standard" as const,
      estimatedTokens: { input: 0, output: 0, total: 0 },
      estimatedCostUSD: 0,
    });
    const result = await judgeSpecQuality("# Some spec", "test-id");
    expect(result.pass).toBe(false);
    expect(result.verdict).toBe("JUDGE_UNAVAILABLE");
  });
});

// NOTE: validateISCQuality and validateSliceShape were deleted in Slice 2a
// (feat/dedeterminize-queue-specsheet). Their test coverage has been replaced
// by the judgeSpecQuality tests above and the live eval at:
//   skills/Intelligence/Evals/UseCases/SpecSheet/spec-quality-judge.yaml
