import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMediaWigTargets } from "../Tools/WigTargets.ts";

function writeWigStatus(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "freshness-wig-"));
  const path = join(dir, "wig_status.json");
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

describe("readMediaWigTargets", () => {
  test("finds the media goal's dual targets from wig_status.json", () => {
    const path = writeWigStatus({
      period: "2026-Q3",
      G42: {
        name: "Media reduction",
        targets: {
          total_media_incl_youtube: { target_min_per_day: 170 },
          low_value: { target_min_per_day: 120 },
        },
      },
      G43: { name: "Community Involvement" },
    });
    expect(readMediaWigTargets(path)).toEqual({
      goalId: "G42",
      lowValue: 120,
      totalMedia: 170,
    });
  });

  test("discovers the goal generically by shape, not by the G42 key", () => {
    const path = writeWigStatus({
      G57: { targets: { low_value: { target_min_per_day: 90 } } },
    });
    expect(readMediaWigTargets(path)).toEqual({
      goalId: "G57",
      lowValue: 90,
      totalMedia: null,
    });
  });

  test("returns null when no goal has a low_value target (e.g. media WIG retired)", () => {
    const path = writeWigStatus({
      period: "2027-Q1",
      G50: { name: "Something else", targets: { widgets: { target_min_per_day: 5 } } },
    });
    expect(readMediaWigTargets(path)).toBeNull();
  });

  test("returns null on missing or malformed file instead of throwing", () => {
    expect(readMediaWigTargets("/nonexistent/wig_status.json")).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "freshness-wig-"));
    const bad = join(dir, "wig_status.json");
    writeFileSync(bad, "not json {");
    expect(readMediaWigTargets(bad)).toBeNull();
  });
});
