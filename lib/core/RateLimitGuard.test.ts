#!/usr/bin/env bun
/**
 * RateLimitGuard.test.ts — usage-reading coverage. Limit-banner text
 * detection moved to ClaudeRunEnd.ts (tests: lib/core/__tests__/ClaudeRunEnd.test.ts).
 */

import { describe, it, expect } from "bun:test";

// ── Unknown is not 0% (2026-10-18) ────────────────────────────────────────────

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "bun:test";
import { assessUsage, resolveModel, isRateLimited } from "./RateLimitGuard.ts";
import type { RateLimits } from "./MemoryPaths.ts";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const win = (pct: number, observedAt: string | undefined, resetsAt = "2026-10-18T16:00:00Z") => ({
  usedPercentage: pct,
  resetsAt,
  ...(observedAt ? { observedAt } : {}),
});

describe("assessUsage", () => {
  it("null state and an all-null file are UNKNOWN, with peak null (not 0)", () => {
    expect(assessUsage(null, NOW)).toMatchObject({ known: false, peak: null, readings: [], lastObservedAt: null });
    const nulls: RateLimits = { fiveHour: null, sevenDay: null, updatedAt: "2026-10-18T11:59:00Z" };
    expect(assessUsage(nulls, NOW)).toMatchObject({ known: false, peak: null });
  });

  it("a fresh current reading counts", () => {
    const s: RateLimits = {
      fiveHour: win(42, "2026-10-18T11:58:00Z"),
      sevenDay: null,
      updatedAt: "2026-10-18T11:58:00Z",
    };
    expect(assessUsage(s, NOW)).toMatchObject({ known: true, peak: 42 });
  });

  it("lastReal survives a null render, but a 3-hour-old reading is stale, reported with its age, and not counted", () => {
    const s: RateLimits = {
      fiveHour: null,
      sevenDay: null,
      updatedAt: "2026-10-18T11:59:00Z",
      lastReal: { fiveHour: win(95, "2026-10-18T09:00:00Z", "2026-10-18T14:00:00Z"), sevenDay: null },
    };
    const a = assessUsage(s, NOW);
    expect(a.known).toBe(false);
    expect(a.peak).toBeNull();
    expect(a.readings[0]).toMatchObject({ window: "fiveHour", usedPercentage: 95, fresh: false, ageMs: 3 * 3_600_000 });
    expect(a.readings[0]?.staleWhy).toContain("3.0h ago");
    expect(a.lastObservedAt).toBe("2026-10-18T09:00:00.000Z");
  });

  it("a recent reading whose window has already reset is stale", () => {
    const s: RateLimits = {
      fiveHour: win(95, "2026-10-18T11:58:00Z", "2026-10-18T11:59:00Z"),
      sevenDay: null,
      updatedAt: "2026-10-18T11:58:00Z",
    };
    const a = assessUsage(s, NOW);
    expect(a.known).toBe(false);
    expect(a.readings[0]?.staleWhy).toContain("reset");
  });

  it("an old-format current window (no observedAt) borrows updatedAt", () => {
    const s: RateLimits = { fiveHour: win(60, undefined), sevenDay: null, updatedAt: "2026-10-18T11:57:00Z" };
    expect(assessUsage(s, NOW)).toMatchObject({ known: true, peak: 60 });
  });

  it("peak is the max over fresh readings only", () => {
    const s: RateLimits = {
      fiveHour: win(30, "2026-10-18T11:58:00Z"),
      sevenDay: win(97, "2026-10-17T00:00:00Z", "2026-10-22T00:00:00Z"),
      updatedAt: "2026-10-18T11:58:00Z",
    };
    expect(assessUsage(s, NOW).peak).toBe(30);
  });
});

describe("resolveModel / isRateLimited with a state file (temp KAYA_HOME)", () => {
  let home: string;
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.KAYA_HOME;
    home = mkdtempSync(join(tmpdir(), "prl-guard-"));
    process.env.KAYA_HOME = home;
    mkdirSync(join(home, "MEMORY", "State"), { recursive: true });
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.KAYA_HOME;
    else process.env.KAYA_HOME = prev;
  });
  const write = (o: unknown) => writeFileSync(join(home, "MEMORY", "State", "rate-limits.json"), JSON.stringify(o));
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

  it("missing file: unknown, keeps the preferred model", () => {
    const r = resolveModel("sonnet");
    expect(r).toMatchObject({ model: "sonnet", wasFallback: false, known: false, peak: null });
    expect(r.reason).toContain("usage unknown");
  });

  it("a corrupt file says it could not be read or parsed (not 'never recorded'), still unknown and keeps the preferred model", () => {
    writeFileSync(join(home, "MEMORY", "State", "rate-limits.json"), "{not json");
    const r = resolveModel("sonnet");
    expect(r).toMatchObject({ model: "sonnet", wasFallback: false, known: false, peak: null });
    expect(r.reason).toContain("could not be read or parsed");
    expect(r.reason).not.toContain("ever been recorded");
    expect(isRateLimited()).toBe(false);
  });

  it("null windows: unknown, keeps the preferred model, not limited", () => {
    write({ fiveHour: null, sevenDay: null, updatedAt: ago(60_000) });
    const r = resolveModel("sonnet");
    expect(r).toMatchObject({ model: "sonnet", wasFallback: false, known: false, peak: null });
    expect(isRateLimited()).toBe(false);
  });

  it("a stale 95% is not treated as current: no fallback, reason names the age", () => {
    write({
      fiveHour: null,
      sevenDay: null,
      updatedAt: ago(60_000),
      lastReal: { fiveHour: win(95, ago(3 * 3_600_000), ahead(3_600_000)), sevenDay: null },
    });
    const r = resolveModel("sonnet");
    expect(r).toMatchObject({ model: "sonnet", wasFallback: false, known: false });
    expect(r.reason).toContain("5h 95% is stale (observed 3.0h ago)");
    expect(isRateLimited()).toBe(false);
  });

  it("a fresh 95% falls back; a fresh 40% stays", () => {
    write({ fiveHour: win(95, ago(30_000), ahead(3_600_000)), sevenDay: null, updatedAt: ago(30_000) });
    expect(resolveModel("sonnet")).toMatchObject({ model: "opus", wasFallback: true, known: true, peak: 95 });
    expect(isRateLimited()).toBe(true);
    write({ fiveHour: win(40, ago(30_000), ahead(3_600_000)), sevenDay: null, updatedAt: ago(30_000) });
    expect(resolveModel("sonnet").reason).toBe("sonnet within limits (40% used)");
  });
});
