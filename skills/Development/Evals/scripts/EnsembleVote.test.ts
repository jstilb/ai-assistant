import { describe, expect, test } from "bun:test";
import type { InferenceResult } from "../../../../lib/core/Inference.ts";
import { ENSEMBLE_LEVELS, ensembleVote, tallyMajority } from "./EnsembleVote.ts";

const VALID = new Set(["a", "b"]);
const ok = (label: unknown) => ({ success: true, parsed: { verdict: label } });

describe("tallyMajority", () => {
  test("returns the label when more than half of the voters agree", () => {
    expect(tallyMajority([ok("a"), ok("a"), ok("b")], "verdict", VALID)).toEqual({
      label: "a",
      divergent: false,
      votes: { a: 2, b: 1 },
    });
  });

  test("is divergent when no label has a strict majority", () => {
    const out = tallyMajority([ok("a"), ok("b")], "verdict", VALID);
    expect(out.label).toBeNull();
    expect(out.divergent).toBe(true);
  });

  test("ignores failed, unparsed and invalid answers", () => {
    const out = tallyMajority([ok("a"), { success: false, parsed: undefined }, ok("zzz"), ok(7)], "verdict", VALID);
    expect(out).toEqual({ label: "a", divergent: false, votes: { a: 1 } });
  });

  test("is divergent with no valid voters", () => {
    expect(tallyMajority([], "verdict", VALID)).toEqual({ label: null, divergent: true, votes: {} });
  });
});

describe("ensembleVote", () => {
  test("calls every level once and tallies the answers", async () => {
    const levels: string[] = [];
    const out = await ensembleVote(
      { systemPrompt: "s", userPrompt: "u", candidateField: "verdict", validLabels: VALID },
      async (options) => {
        levels.push(String(options.level));
        return ok("b") as unknown as InferenceResult;
      },
    );
    expect(levels.sort()).toEqual([...ENSEMBLE_LEVELS].sort());
    expect(out.label).toBe("b");
  });
});
