/**
 * SurfaceClassifier.native.test.ts — ADR-0006 / Phase 6
 *
 * Native surface reconciliation (consumer side):
 *   - `WorkSurface` includes `native`.
 *   - The consumer BRIDGES to the producer's LLM-classified surface (`item.surface`)
 *     instead of re-guessing with keyword heuristics (root-cause fix).
 *   - Phase 6: SurfaceClassifier is reduced to `isNative()` + `mapProducerSurface()`;
 *     `isNative` is the single boolean that drives the human/device lock.
 */

import { describe, it, expect } from "bun:test";
import { isNative, mapProducerSurface, type WorkSurface } from "./SurfaceClassifier.ts";
import type { WorkItem } from "./WorkQueue.ts";

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "t1",
    title: "Item",
    description: "",
    status: "pending",
    priority: "normal",
    dependencies: [],
    source: "manual",
    createdAt: new Date().toISOString(),
    ...overrides,
  } as WorkItem;
}

describe("isNative — producer-surface bridge (ADR-0006)", () => {
  it("trusts producer surface 'native' over the browser-ish keywords in the spec", () => {
    // Spec text is deliberately browser-ish (render/component/button/form/panel) —
    // the pre-ADR-0006 bug mis-tagged this 'browser' and booted Playwright at it.
    const item = makeItem({ surface: "native" });
    const spec = "The screen renders a component with a button and a form panel.";
    expect(isNative(item, spec)).toBe(true);
  });

  it("is false for non-native producer surfaces (library/daemon/browser/cli/api)", () => {
    expect(isNative(makeItem({ surface: "library" }))).toBe(false);
    expect(isNative(makeItem({ surface: "daemon" }))).toBe(false);
    expect(isNative(makeItem({ surface: "browser" }))).toBe(false);
    expect(isNative(makeItem({ surface: "cli" }))).toBe(false);
    expect(isNative(makeItem({ surface: "api" }))).toBe(false);
  });

  it("is false when no producer surface is present — native is producer-driven, not keyword-guessed", () => {
    // Phase 6: we no longer keyword-detect surface; absent producer surface = not native.
    expect(isNative(makeItem({ surface: undefined }), "render a page component button")).toBe(false);
  });

  it("'native' is a valid WorkSurface value", () => {
    const s: WorkSurface = "native";
    expect(s).toBe("native");
  });
});

describe("mapProducerSurface precedence (ADR-0006 — item-level verify guard)", () => {
  // The item-level verify() path resolves surface as
  //   mapProducerSurface(item.surface) ?? metadata.workSurface ?? "integration"
  // so a producer 'native' wins over a STALE cached metadata.workSurface (which a
  // pre-bridge prepare() may have mis-set to 'browser') — preventing a native item
  // from silently routing to a non-native run and skipping the human gate.
  it("returns a concrete surface for every producer value (wins over stale cache)", () => {
    expect(mapProducerSurface("native")).toBe("native");
    expect(mapProducerSurface("browser")).toBe("browser");
    expect(mapProducerSurface("cli")).toBe("cli");
    expect(mapProducerSurface("api")).toBe("api");
    expect(mapProducerSurface("library")).toBe("integration");
    expect(mapProducerSurface("daemon")).toBe("integration");
  });

  it("returns undefined for absent/unknown so the cached/default fallback applies", () => {
    expect(mapProducerSurface(undefined)).toBeUndefined();
    expect(mapProducerSurface("")).toBeUndefined();
    expect(mapProducerSurface("ios")).toBeUndefined();
  });
});

// Note: WorkQueue.loadFromLegacy removed in S5a — ADR-0006 surface plumbing
// test block deleted (tested deleted functionality).
