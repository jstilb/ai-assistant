/**
 * Tests for AnkiAnswerAssessor — LLM grading with an injected inference fn.
 * Verifies verdict→ease reconciliation, empty-answer short-circuit, JSON
 * parsing tolerance, and the fail-loud-then-safe degraded path.
 */

import { describe, it, expect } from "bun:test";
import { assessAnswer, type InferenceFn } from "./AnkiAnswerAssessor.ts";
import type { InferenceResult } from "../../../../lib/core/Inference.ts";

function fakeInference(output: string, opts: { success?: boolean; error?: string } = {}): InferenceFn {
  return async () =>
    ({
      success: opts.success ?? true,
      output,
      parsed: safeParse(output),
      error: opts.error,
      latencyMs: 1,
      level: "standard",
      estimatedTokens: { input: 0, output: 0, total: 0 },
      estimatedCostUSD: 0,
    }) as InferenceResult;
}

function throwingInference(): InferenceFn {
  return async () => {
    throw new Error("network down");
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

const CARD = {
  question: "What is the powerhouse of the cell?",
  referenceAnswer: "The mitochondria",
};

describe("assessAnswer — empty answer", () => {
  it("marks Again without calling inference", async () => {
    let called = false;
    const infer: InferenceFn = async () => {
      called = true;
      throw new Error("should not be called");
    };
    const a = await assessAnswer({ ...CARD, spokenAnswer: "   " }, infer);
    expect(called).toBe(false);
    expect(a.verdict).toBe("incorrect");
    expect(a.ease).toBe(1);
    expect(a.feedback).toContain("The mitochondria");
    expect(a.degraded).toBe(false);
  });
});

describe("assessAnswer — verdict/ease mapping", () => {
  it("correct + ease 4 stays Easy", async () => {
    const a = await assessAnswer(
      { ...CARD, spokenAnswer: "the mitochondria" },
      fakeInference('{"verdict":"correct","ease":4,"feedback":"Exactly right."}'),
    );
    expect(a.verdict).toBe("correct");
    expect(a.ease).toBe(4);
  });

  it("correct + ease 3 stays Good", async () => {
    const a = await assessAnswer(
      { ...CARD, spokenAnswer: "mitochondria i think" },
      fakeInference('{"verdict":"correct","ease":3,"feedback":"Yes."}'),
    );
    expect(a.ease).toBe(3);
  });

  it("partial is reconciled to Hard (ease 2) even if model says 4", async () => {
    const a = await assessAnswer(
      { ...CARD, spokenAnswer: "some cell organelle" },
      fakeInference('{"verdict":"partial","ease":4,"feedback":"Close."}'),
    );
    expect(a.verdict).toBe("partial");
    expect(a.ease).toBe(2);
  });

  it("incorrect is reconciled to Again (ease 1) even if model says 3", async () => {
    const a = await assessAnswer(
      { ...CARD, spokenAnswer: "the nucleus" },
      fakeInference('{"verdict":"incorrect","ease":3,"feedback":"Not quite — it is the mitochondria."}'),
    );
    expect(a.ease).toBe(1);
  });

  it("correct with a nonsense ease defaults to Good (3)", async () => {
    const a = await assessAnswer(
      { ...CARD, spokenAnswer: "mitochondria" },
      fakeInference('{"verdict":"correct","ease":9,"feedback":"Right."}'),
    );
    expect(a.ease).toBe(3);
  });
});

describe("assessAnswer — parsing tolerance", () => {
  it("extracts JSON embedded in surrounding prose", async () => {
    const a = await assessAnswer(
      { ...CARD, spokenAnswer: "mitochondria" },
      fakeInference('Sure! {"verdict":"correct","ease":4,"feedback":"Yep."} done'),
    );
    expect(a.verdict).toBe("correct");
    expect(a.degraded).toBe(false);
  });

  it("degrades safely on unparseable output", async () => {
    const a = await assessAnswer(
      { ...CARD, spokenAnswer: "mitochondria" },
      fakeInference("not json at all"),
    );
    expect(a.degraded).toBe(true);
    expect(a.ease).toBe(1);
  });

  it("degrades safely when a verdict value is invalid", async () => {
    const a = await assessAnswer(
      { ...CARD, spokenAnswer: "mitochondria" },
      fakeInference('{"verdict":"maybe","ease":3,"feedback":"?"}'),
    );
    expect(a.degraded).toBe(true);
  });
});

describe("assessAnswer — failure paths", () => {
  it("degrades safely when inference throws", async () => {
    const a = await assessAnswer({ ...CARD, spokenAnswer: "mitochondria" }, throwingInference());
    expect(a.degraded).toBe(true);
    expect(a.verdict).toBe("incorrect");
    expect(a.ease).toBe(1);
    expect(a.feedback).toContain("The mitochondria");
  });

  it("degrades safely when inference returns success:false", async () => {
    const a = await assessAnswer(
      { ...CARD, spokenAnswer: "mitochondria" },
      fakeInference("", { success: false, error: "timeout" }),
    );
    expect(a.degraded).toBe(true);
    expect(a.ease).toBe(1);
  });
});
