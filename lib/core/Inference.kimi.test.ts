/**
 * Inference.kimi.test.ts — the `kimi` level's wiring into Inference.ts.
 *
 * Hermetic: the kimi path is only exercised through `inference()` in the
 * missing-key case, which returns BEFORE any network call — so these tests
 * never spawn `claude -p` and never spend a cent. The success/parse paths are
 * covered against an injected fetch in MoonshotClient.test.ts.
 */

import { describe, it, expect } from "bun:test";
import {
  inference,
  resolveModelPricing,
  estimateCostUSD,
  isExternalApiLevel,
  type InferenceLevel,
} from "./Inference.ts";
import { loadMoonshotApiKey, KIMI_K3_PRICING } from "./MoonshotClient.ts";

describe("isExternalApiLevel", () => {
  it("marks kimi as the non-subprocess level", () => {
    expect(isExternalApiLevel("kimi")).toBe(true);
  });

  it("leaves every Claude level on the claude -p path", () => {
    for (const level of ["fast", "standard", "smart"] as InferenceLevel[]) {
      expect(isExternalApiLevel(level)).toBe(false);
    }
  });
});

describe("kimi pricing", () => {
  it("resolves Kimi's published rates rather than the sonnet default", () => {
    const pricing = resolveModelPricing("kimi-k3");
    expect(pricing.inputPerMillion).toBe(KIMI_K3_PRICING.inputPerMillion);
    expect(pricing.outputPerMillion).toBe(KIMI_K3_PRICING.outputPerMillion);
  });

  it("costs Kimi at $3/M in and $15/M out", () => {
    const cost = estimateCostUSD({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      modelName: "kimi-k3",
    });
    expect(cost).toBeCloseTo(18.0, 6);
  });

  it("sources kimi rates from KIMI_K3_PRICING, not the sonnet default", () => {
    // NOTE: Kimi K3 and Sonnet currently share identical published rates
    // ($3/M in, $15/M out), so equal *values* prove nothing about routing.
    // The invariant that actually matters is that the kimi row tracks
    // MoonshotClient's KIMI_K3_PRICING — if Moonshot repricings land there,
    // this must follow automatically rather than silently keep sonnet's numbers.
    const pricing = resolveModelPricing("kimi-k3");
    expect(pricing).toEqual({
      inputPerMillion: KIMI_K3_PRICING.inputPerMillion,
      outputPerMillion: KIMI_K3_PRICING.outputPerMillion,
    });
  });

  it("routes an unknown model to the sonnet default, unchanged", () => {
    // Regression guard: adding the kimi branch must not disturb the fallback.
    expect(resolveModelPricing("some-unknown-model")).toEqual({
      inputPerMillion: 3.0,
      outputPerMillion: 15.0,
    });
  });
});

describe("inference(level: kimi) — no key provisioned", () => {
  it("fails loud with an actionable error instead of falling back to Claude", async () => {
    if (loadMoonshotApiKey() !== null) {
      // A key has since been provisioned; this assertion no longer applies and a
      // real call would cost money, so skip rather than spend.
      return;
    }

    const result = await inference({
      systemPrompt: "you are a test",
      userPrompt: "this must never reach the network",
      level: "kimi",
    });

    expect(result.success).toBe(false);
    expect(result.level).toBe("kimi");
    expect(result.error).toContain("MOONSHOT_API_KEY");
    expect(result.error).toContain("secrets.json");
    // Critically: it must NOT have silently produced Claude output.
    expect(result.output).toBe("");
    expect(result.estimatedCostUSD).toBe(0);
  });

  it("reports latency and the kimi level even on the failure path", async () => {
    if (loadMoonshotApiKey() !== null) return;

    const result = await inference({
      systemPrompt: "s",
      userPrompt: "u",
      level: "kimi",
    });

    expect(result.level).toBe("kimi");
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.estimatedTokens).toEqual({ input: 0, output: 0, total: 0 });
  });

  it("does not retry a missing key into a spend loop", async () => {
    if (loadMoonshotApiKey() !== null) return;

    // retries>0 must still terminate promptly; a missing key is not transient.
    const started = Date.now();
    const result = await inference({
      systemPrompt: "s",
      userPrompt: "u",
      level: "kimi",
      retries: 1,
      retryDelayMs: 10,
    });
    expect(result.success).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
