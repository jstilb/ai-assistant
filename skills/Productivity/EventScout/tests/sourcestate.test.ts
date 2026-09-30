/**
 * sourcestate.test.ts — lastFetched config/state split (2026-08-20).
 *
 * sources.json is pure committed config; per-source lastFetched lives in
 * State/source-state.json. These tests pin: updates never touch sources.json,
 * loadSources overlays state (state wins over a legacy in-config field), and
 * saveSources strips freshness so it can't leak back into config.
 *
 * Run: bun test ~/.claude/skills/Productivity/EventScout/tests/sourcestate.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TS = "2026-08-20T12:00:00.000Z";
const LEGACY_TS = "2026-08-01T00:00:00.000Z";

function makeSource(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    url: `https://example.com/${id}`,
    name: id,
    fetchTier: "html-llm",
    pollInterval: 720,
    enabled: true,
    ...extra,
  };
}

describe("SourceManager — lastFetched config/state split", () => {
  let dir: string;
  let sourcesPath: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eventscout-sourcestate-"));
    sourcesPath = join(dir, "sources.json");
    statePath = join(dir, "source-state.json");
    process.env["EVENTSCOUT_SOURCES_PATH"] = sourcesPath;
    process.env["EVENTSCOUT_SOURCE_STATE_PATH"] = statePath;
    writeFileSync(
      sourcesPath,
      JSON.stringify([makeSource("alpha"), makeSource("beta", { lastFetched: LEGACY_TS })], null, 2)
    );
  });

  afterEach(() => {
    delete process.env["EVENTSCOUT_SOURCES_PATH"];
    delete process.env["EVENTSCOUT_SOURCE_STATE_PATH"];
    rmSync(dir, { recursive: true, force: true });
  });

  test("updateLastFetched writes the state file and leaves sources.json byte-identical", async () => {
    const { updateLastFetched } = await import("../Tools/SourceManager.ts");
    const before = readFileSync(sourcesPath, "utf-8");
    updateLastFetched("alpha", TS);
    expect(readFileSync(sourcesPath, "utf-8")).toBe(before);
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, string>;
    expect(state["alpha"]).toBe(TS);
  });

  test("loadSources overlays state; state wins over a legacy in-config lastFetched", async () => {
    const { updateLastFetched, loadSources } = await import("../Tools/SourceManager.ts");
    updateLastFetched("beta", TS);
    const byId = new Map(loadSources().map((s) => [s.id, s]));
    expect(byId.get("beta")!.lastFetched).toBe(TS);
    // alpha has no state and no legacy field → stays unset
    expect(byId.get("alpha")!.lastFetched).toBeUndefined();
  });

  test("legacy in-config lastFetched survives as fallback when no state exists", async () => {
    const { loadSources } = await import("../Tools/SourceManager.ts");
    const beta = loadSources().find((s) => s.id === "beta")!;
    expect(beta.lastFetched).toBe(LEGACY_TS);
  });

  test("updateLastFetchedBatch ignores unregistered ids", async () => {
    const { updateLastFetchedBatch } = await import("../Tools/SourceManager.ts");
    updateLastFetchedBatch({ ghost: TS });
    expect(() => readFileSync(statePath, "utf-8")).toThrow(); // never created
  });

  test("saveSources strips lastFetched so freshness cannot leak into config", async () => {
    const { loadSources, saveSources } = await import("../Tools/SourceManager.ts");
    saveSources(loadSources()); // round-trip the merged view
    const raw = JSON.parse(readFileSync(sourcesPath, "utf-8")) as Array<Record<string, unknown>>;
    for (const s of raw) expect(s["lastFetched"]).toBeUndefined();
  });
});
