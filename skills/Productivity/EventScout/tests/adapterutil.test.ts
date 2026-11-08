/**
 * AdapterUtil — the shared id/HTML helpers every EventScout adapter uses.
 * stableId output is a persisted cache key: these pins guard the recipe.
 */
import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { canonical, stableId, stripHtml } from "../Tools/adapters/AdapterUtil.ts";

const sha16 = (raw: string) => createHash("sha256").update(raw).digest("hex").slice(0, 16);

test("canonical trims, lowercases and collapses whitespace", () => {
  expect(canonical("  Tycho   LIVE \n")).toBe("tycho live");
});

test("stableId hashes canonical(title)|start|canonical(venue)", () => {
  expect(stableId(" Tycho  Live ", "2026-11-07T20:00:00-08:00", "The Observatory")).toBe(
    sha16("tycho live|2026-11-07T20:00:00-08:00|the observatory"),
  );
});

test("stableId normalizeUtc hashes the UTC ISO form; unparseable passes through", () => {
  expect(stableId("A", "2026-11-07T20:00:00-08:00", "V", { normalizeUtc: true })).toBe(
    sha16("a|2026-11-08T04:00:00.000Z|v"),
  );
  expect(stableId("A", "sometime", "V", { normalizeUtc: true })).toBe(sha16("a|sometime|v"));
});

test("stripHtml decodes common entities and blanks the rest", () => {
  expect(stripHtml("<p>Tom&#39;s &quot;Jam&quot;&nbsp;&amp; more&hellip;</p>")).toBe(`Tom's "Jam" & more`);
});
