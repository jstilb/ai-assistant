/**
 * FollowOnLoops.test.ts — comprehension-driven follow-on derivation.
 *
 * deriveFollowOnFromSpec asks an LLM to READ a completed spec and report the phases it
 * deferred. These tests inject a fake inference fn so the comprehension is deterministic,
 * and confirm: (a) the LLM is actually fed the spec content, (b) its JSON is mapped to
 * FollowOnLoop[], (c) failures fail LOUD into [] rather than inventing follow-on work.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { deriveFollowOnFromSpec, type InferFn } from "./FollowOnLoops.ts";
import type { InferenceResult } from "../../../../lib/core/Inference.ts";

// Isolate logFailure writes into a throw-away tmp dir so these tests never
// pollute the real failure log at ~/.claude/MEMORY/MONITORING/failure-log.jsonl.
let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "followonloops-test-"));
  mkdirSync(join(tmpHome, "MEMORY", "MONITORING"), { recursive: true });
  process.env.KAYA_HOME = tmpHome;
});

afterEach(() => {
  delete process.env.KAYA_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

/** Build a fake inference result with the given output (success unless overridden). */
function ok(output: string): InferenceResult {
  return { success: true, output, level: "fast" } as InferenceResult;
}

/** Write a spec file to a throwaway temp dir; returns its path. Caller cleans up. */
function writeSpec(content: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "followon-"));
  const path = join(dir, "spec.md");
  writeFileSync(path, content);
  return { dir, path };
}

const MULTI_PHASE_SPEC = `# Generate Spec: KayaScheduler

## 6. Implementation Approach
Phase 1 — daily planner (built now).

## Follow-On Loops
- KayaScheduler Phase 2 — recurring demand | spec: plans/Specs/scheduler-phase2.md
- KayaScheduler Phase 3 — learning loop
`;

describe("deriveFollowOnFromSpec", () => {
  test("feeds the spec to the LLM and maps its JSON to FollowOnLoop[]", async () => {
    const { dir, path } = writeSpec(MULTI_PHASE_SPEC);
    try {
      let seenPrompt = "";
      const infer: InferFn = async ({ userPrompt }) => {
        // The comprehension MUST receive the actual spec content (not just a path),
        // including the deferred-phase section the spec-generator emits.
        seenPrompt = userPrompt;
        return ok(JSON.stringify([
          { title: "KayaScheduler Phase 2 — recurring demand", specPath: "plans/Specs/scheduler-phase2.md" },
          { title: "KayaScheduler Phase 3 — learning loop" },
        ]));
      };

      const loops = await deriveFollowOnFromSpec(path, { title: "KayaScheduler", infer });
      expect(seenPrompt).toContain("## Follow-On Loops");
      expect(seenPrompt).toContain("KayaScheduler Phase 2 — recurring demand");
      expect(loops).toEqual([
        { title: "KayaScheduler Phase 2 — recurring demand", specPath: "plans/Specs/scheduler-phase2.md" },
        { title: "KayaScheduler Phase 3 — learning loop" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns [] when the LLM judges the spec fully delivered (nothing deferred)", async () => {
    const { dir, path } = writeSpec("# Single-phase spec\n\nDelivers everything in one build.");
    try {
      const infer: InferFn = async () => ok("[]");
      expect(await deriveFollowOnFromSpec(path, { infer })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tolerates prose / code fences around the JSON", async () => {
    const { dir, path } = writeSpec(MULTI_PHASE_SPEC);
    try {
      const infer: InferFn = async () =>
        ok("Here is the remaining work:\n```json\n[{\"title\": \"Phase 2\"}]\n```\n");
      expect(await deriveFollowOnFromSpec(path, { infer })).toEqual([{ title: "Phase 2" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("drops malformed elements (no/blank title) without inventing scope", async () => {
    const { dir, path } = writeSpec(MULTI_PHASE_SPEC);
    try {
      const infer: InferFn = async () =>
        ok(JSON.stringify([{ title: "" }, { notATitle: "x" }, { title: "Phase 2" }, 42, null]));
      expect(await deriveFollowOnFromSpec(path, { infer })).toEqual([{ title: "Phase 2" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails LOUD into [] when inference fails — never invents follow-on", async () => {
    const { dir, path } = writeSpec(MULTI_PHASE_SPEC);
    try {
      const failed: InferFn = async () => ({ success: false, output: "", level: "fast" } as InferenceResult);
      expect(await deriveFollowOnFromSpec(path, { infer: failed })).toEqual([]);

      const threw: InferFn = async () => { throw new Error("boom"); };
      expect(await deriveFollowOnFromSpec(path, { infer: threw })).toEqual([]);

      const garbage: InferFn = async () => ok("not json at all");
      expect(await deriveFollowOnFromSpec(path, { infer: garbage })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns [] for a missing or empty spec without calling the LLM", async () => {
    let called = false;
    const infer: InferFn = async () => { called = true; return ok("[]"); };
    expect(await deriveFollowOnFromSpec(undefined, { infer })).toEqual([]);
    expect(await deriveFollowOnFromSpec("/no/such/spec.md", { infer })).toEqual([]);
    expect(called).toBe(false);

    const { dir, path } = writeSpec("   \n  ");
    try {
      expect(await deriveFollowOnFromSpec(path, { infer })).toEqual([]);
      expect(called).toBe(false); // blank spec short-circuits before inference
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
