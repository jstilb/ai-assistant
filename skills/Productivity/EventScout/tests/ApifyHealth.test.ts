#!/usr/bin/env bun
/**
 * ApifyHealth.test.ts — T2-09 per-source Apify streak counters.
 * Run: bun test ~/.claude/.claude/worktrees/fable-remediation-batch4/skills/Productivity/EventScout/tests/ApifyHealth.test.ts
 *
 * Mirrors lib/cron/__tests__/FailStreak.test.ts's KAYA_HOME-pin +
 * injected-sendAlertFn convention. No network call, no real Apify/BrightData
 * request, no real alert: KAYA_HOME is pinned to a mkdtemp sandbox and
 * KAYA_ALERT_DRY_RUN=1 is set for every test (belt-and-suspenders — the
 * hard-failure/page assertions also inject a spy sendAlertFn so they never
 * depend on AlertGate's real network path at all).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { AlertResult, SendAlertOptions } from "../../../../lib/core/AlertGate.ts";

const tmpHome = join(tmpdir(), `apify-health-test-${Date.now()}`);
const failureLogPath = join(tmpHome, "MEMORY/MONITORING/failure-log.jsonl");

function readFailureLogLines(): Array<Record<string, unknown>> {
  if (!existsSync(failureLogPath)) return [];
  return readFileSync(failureLogPath, "utf-8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  process.env.KAYA_HOME = tmpHome;
  process.env.KAYA_ALERT_DRY_RUN = "1";
  mkdirSync(tmpHome, { recursive: true });
});

afterEach(() => {
  delete process.env.KAYA_HOME;
  delete process.env.KAYA_ALERT_DRY_RUN;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

type SpyCall = { message: string; options: SendAlertOptions };

function makeSpySendAlert(): { fn: (message: string, options: SendAlertOptions) => Promise<AlertResult>; calls: SpyCall[] } {
  const calls: SpyCall[] = [];
  const fn = async (message: string, options: SendAlertOptions): Promise<AlertResult> => {
    calls.push({ message, options });
    return "dry-run";
  };
  return { fn, calls };
}

describe("trackApifySourceHealth — hard-failure channel (page tier)", () => {
  test("1st and 2nd consecutive hard-fail stay below threshold — no page", async () => {
    const { trackApifySourceHealth } = await import("../Tools/ApifyHealth.ts");
    const spy = makeSpySendAlert();

    const r1 = await trackApifySourceHealth("src-a", "https://example.com/a", { kind: "hard-fail", error: new Error("boom") }, spy.fn);
    expect(r1.hardFail).toEqual({ action: "below-threshold", streak: 1 });

    const r2 = await trackApifySourceHealth("src-a", "https://example.com/a", { kind: "hard-fail", error: new Error("boom") }, spy.fn);
    expect(r2.hardFail).toEqual({ action: "below-threshold", streak: 2 });

    expect(spy.calls.length).toBe(0);
  });

  test("3rd consecutive hard-fail pages, with the explicit 12h cooldown and per-source key", async () => {
    const { trackApifySourceHealth, APIFY_HARD_FAIL_PAGE_COOLDOWN_MS } = await import("../Tools/ApifyHealth.ts");
    const spy = makeSpySendAlert();

    await trackApifySourceHealth("src-b", "https://example.com/b", { kind: "hard-fail", error: new Error("timeout") }, spy.fn);
    await trackApifySourceHealth("src-b", "https://example.com/b", { kind: "hard-fail", error: new Error("timeout") }, spy.fn);
    const r3 = await trackApifySourceHealth("src-b", "https://example.com/b", { kind: "hard-fail", error: new Error("timeout") }, spy.fn);

    expect(r3.hardFail.action).toBe("paged");
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0]!.options.tier).toBe("page");
    expect(spy.calls[0]!.options.key).toBe("eventscout-apify-fail-src-b");
    expect(spy.calls[0]!.options.cooldownMs).toBe(APIFY_HARD_FAIL_PAGE_COOLDOWN_MS);
    expect(APIFY_HARD_FAIL_PAGE_COOLDOWN_MS).toBe(12 * 60 * 60 * 1000);
  });

  test("per-source isolation — a 2nd, healthy source's streak is untouched by the 1st source's 3-strike page", async () => {
    const { trackApifySourceHealth } = await import("../Tools/ApifyHealth.ts");
    const spy = makeSpySendAlert();

    // src-fail hard-fails 3x in a row (pages on the 3rd)
    await trackApifySourceHealth("src-fail", "https://example.com/fail", { kind: "hard-fail", error: new Error("e") }, spy.fn);
    await trackApifySourceHealth("src-fail", "https://example.com/fail", { kind: "hard-fail", error: new Error("e") }, spy.fn);
    const failResult = await trackApifySourceHealth("src-fail", "https://example.com/fail", { kind: "hard-fail", error: new Error("e") }, spy.fn);
    expect(failResult.hardFail.action).toBe("paged");

    // src-healthy succeeds every run, interleaved with src-fail's failures
    const healthyResult = await trackApifySourceHealth("src-healthy", "https://example.com/healthy", { kind: "success", count: 12 }, spy.fn);
    expect(healthyResult.hardFail).toEqual({ action: "reset" });

    // Only ONE page fired, and it names src-fail, never src-healthy.
    const pageCalls = spy.calls.filter((c) => c.options.tier === "page");
    expect(pageCalls.length).toBe(1);
    expect(pageCalls[0]!.options.key).toBe("eventscout-apify-fail-src-fail");
    expect(pageCalls[0]!.message).toContain("src-fail");
    expect(pageCalls[0]!.message).not.toContain("src-healthy");
  });

  test("a success (events > 0) resets an in-progress hard-fail streak", async () => {
    const { trackApifySourceHealth } = await import("../Tools/ApifyHealth.ts");
    const spy = makeSpySendAlert();

    await trackApifySourceHealth("src-c", "https://example.com/c", { kind: "hard-fail", error: new Error("e") }, spy.fn);
    await trackApifySourceHealth("src-c", "https://example.com/c", { kind: "hard-fail", error: new Error("e") }, spy.fn);
    // Streak is at 2 here — one more hard-fail would page. Instead: a clean success.
    const resetResult = await trackApifySourceHealth("src-c", "https://example.com/c", { kind: "success", count: 5 }, spy.fn);
    expect(resetResult.hardFail).toEqual({ action: "reset" });

    // Streak must have actually gone back to 0 on disk, not just in the return value —
    // one more hard-fail should be back to "1", not "3"/paged.
    const nextResult = await trackApifySourceHealth("src-c", "https://example.com/c", { kind: "hard-fail", error: new Error("e") }, spy.fn);
    expect(nextResult.hardFail).toEqual({ action: "below-threshold", streak: 1 });
    expect(spy.calls.length).toBe(0);
  });

  test("a zero-result run does NOT reset the hard-fail streak — it leaves it untouched (same root cause, not a recovery)", async () => {
    const { trackApifySourceHealth } = await import("../Tools/ApifyHealth.ts");
    const spy = makeSpySendAlert();

    await trackApifySourceHealth("src-d", "https://example.com/d", { kind: "hard-fail", error: new Error("e") }, spy.fn);
    await trackApifySourceHealth("src-d", "https://example.com/d", { kind: "hard-fail", error: new Error("e") }, spy.fn);
    // A zero-result run is NOT evidence of recovery for this channel — it must leave the streak at 2, untouched.
    const zeroRunResult = await trackApifySourceHealth("src-d", "https://example.com/d", { kind: "zero-result" }, spy.fn);
    expect(zeroRunResult.hardFail).toEqual({ action: "below-threshold", streak: 2 });

    const after = await trackApifySourceHealth("src-d", "https://example.com/d", { kind: "hard-fail", error: new Error("e") }, spy.fn);
    expect(after.hardFail.action).toBe("paged"); // 3rd hard-fail overall, streak never got wiped by the zero-result in between
    expect(spy.calls.length).toBe(1);
  });

  test("forensic JSONL: every hard-fail occurrence is recorded, tier 'log' below threshold, never 'page' (trackHealStreak owns the page dispatch)", async () => {
    const { trackApifySourceHealth } = await import("../Tools/ApifyHealth.ts");
    const spy = makeSpySendAlert();

    await trackApifySourceHealth("src-e", "https://example.com/e", { kind: "hard-fail", error: new Error("first") }, spy.fn);
    await trackApifySourceHealth("src-e", "https://example.com/e", { kind: "hard-fail", error: new Error("second") }, spy.fn);
    await trackApifySourceHealth("src-e", "https://example.com/e", { kind: "hard-fail", error: new Error("third") }, spy.fn);

    const lines = readFailureLogLines().filter(
      (l) => (l["context"] as Record<string, unknown>)["sourceId"] === "src-e",
    );
    expect(lines.length).toBe(3);
    for (const line of lines) {
      expect(line["source"]).toBe("EventScout:ApifyIngest");
      // tier is omitted from the record entirely when it's the 'log' default (see FailureLog.ts) —
      // so "not tier 'page'" is the correct assertion, not "tier === 'log'".
      expect(line["tier"]).not.toBe("page");
    }
    const streaks = lines.map((l) => (l["context"] as Record<string, unknown>)["streak"]);
    expect(streaks).toEqual([1, 2, 3]);
  });
});

describe("trackApifySourceHealth — zero-result channel (digest tier, never pages)", () => {
  test("1st and 2nd consecutive zero-result stay tier 'log' in the forensic record", async () => {
    const { trackApifySourceHealth } = await import("../Tools/ApifyHealth.ts");
    const spy = makeSpySendAlert();

    const r1 = await trackApifySourceHealth("src-z1", "https://example.com/z1", { kind: "zero-result" }, spy.fn);
    expect(r1.zeroResultStreak).toBe(1);
    expect(r1.zeroResultTier).toBe("log");

    const r2 = await trackApifySourceHealth("src-z1", "https://example.com/z1", { kind: "zero-result" }, spy.fn);
    expect(r2.zeroResultStreak).toBe(2);
    expect(r2.zeroResultTier).toBe("log");

    const lines = readFailureLogLines().filter(
      (l) => (l["context"] as Record<string, unknown>)["sourceId"] === "src-z1",
    );
    expect(lines.length).toBe(2);
    for (const line of lines) expect(line["tier"]).toBeUndefined(); // 'log' tier omits the field entirely
  });

  test("3rd consecutive zero-result reaches DIGEST tier and never pages", async () => {
    const { trackApifySourceHealth } = await import("../Tools/ApifyHealth.ts");
    const spy = makeSpySendAlert();

    await trackApifySourceHealth("src-z2", "https://example.com/z2", { kind: "zero-result" }, spy.fn);
    await trackApifySourceHealth("src-z2", "https://example.com/z2", { kind: "zero-result" }, spy.fn);
    const r3 = await trackApifySourceHealth("src-z2", "https://example.com/z2", { kind: "zero-result" }, spy.fn);

    expect(r3.zeroResultStreak).toBe(3);
    expect(r3.zeroResultTier).toBe("digest");

    const lines = readFailureLogLines().filter(
      (l) => (l["context"] as Record<string, unknown>)["sourceId"] === "src-z2",
    );
    expect(lines.length).toBe(3);
    expect(lines[0]!["tier"]).toBeUndefined();
    expect(lines[1]!["tier"]).toBeUndefined();
    expect(lines[2]!["tier"]).toBe("digest");

    // The injected sendAlertFn is wired only to the hard-fail/page channel —
    // it must NEVER be invoked by the zero-result channel, at any streak depth.
    expect(spy.calls.length).toBe(0);
  });

  test("a success (events > 0) resets the zero-result streak to 0", async () => {
    const { trackApifySourceHealth } = await import("../Tools/ApifyHealth.ts");
    const spy = makeSpySendAlert();

    await trackApifySourceHealth("src-z3", "https://example.com/z3", { kind: "zero-result" }, spy.fn);
    await trackApifySourceHealth("src-z3", "https://example.com/z3", { kind: "zero-result" }, spy.fn);
    const resetResult = await trackApifySourceHealth("src-z3", "https://example.com/z3", { kind: "success", count: 20 }, spy.fn);
    expect(resetResult.zeroResultStreak).toBe(0);
    expect(resetResult.zeroResultTier).toBe("log");

    const nextZero = await trackApifySourceHealth("src-z3", "https://example.com/z3", { kind: "zero-result" }, spy.fn);
    expect(nextZero.zeroResultStreak).toBe(1); // back to 1, not 3 — the reset actually took
  });

  test("a hard-fail run does NOT reset the zero-result streak — it leaves it untouched (same root cause, not a recovery)", async () => {
    const { trackApifySourceHealth } = await import("../Tools/ApifyHealth.ts");
    const spy = makeSpySendAlert();

    await trackApifySourceHealth("src-z4", "https://example.com/z4", { kind: "zero-result" }, spy.fn);
    await trackApifySourceHealth("src-z4", "https://example.com/z4", { kind: "zero-result" }, spy.fn);
    // A hard-fail run is NOT evidence of recovery for this channel — it must leave the streak at 2, untouched.
    const hardFailRunResult = await trackApifySourceHealth("src-z4", "https://example.com/z4", { kind: "hard-fail", error: new Error("e") }, spy.fn);
    expect(hardFailRunResult.zeroResultStreak).toBe(2);

    const after = await trackApifySourceHealth("src-z4", "https://example.com/z4", { kind: "zero-result" }, spy.fn);
    expect(after.zeroResultStreak).toBe(3); // 3rd zero-result overall, streak never got wiped by the hard-fail in between
    expect(after.zeroResultTier).toBe("digest");
    expect(spy.calls.length).toBe(0); // digest channel never invokes the page-only spy
  });

  test("REGRESSION (verify-flagged hole): a source alternating hard-fail / zero-result / hard-fail / zero-result / hard-fail eventually escalates instead of resetting forever", async () => {
    const { trackApifySourceHealth } = await import("../Tools/ApifyHealth.ts");
    const spy = makeSpySendAlert();

    // Same root cause (a degrading Apify source), manifesting as a different
    // symptom every other day. Under the old "any non-matching outcome
    // resets" semantics, this pattern never reached 3 in EITHER channel and
    // was invisible forever — exactly the silent-death case T2-09 exists to
    // close. It must now escalate via the hard-fail channel on the 5th run
    // (3 hard-fails total: run 1, run 3, run 5 — never reset by the
    // zero-results interleaved at run 2 and run 4).
    const r1 = await trackApifySourceHealth("src-alt", "https://example.com/alt", { kind: "hard-fail", error: new Error("timeout") }, spy.fn);
    expect(r1.hardFail).toEqual({ action: "below-threshold", streak: 1 });

    const r2 = await trackApifySourceHealth("src-alt", "https://example.com/alt", { kind: "zero-result" }, spy.fn);
    expect(r2.hardFail).toEqual({ action: "below-threshold", streak: 1 }); // untouched, not reset
    expect(r2.zeroResultStreak).toBe(1);

    const r3 = await trackApifySourceHealth("src-alt", "https://example.com/alt", { kind: "hard-fail", error: new Error("timeout") }, spy.fn);
    expect(r3.hardFail).toEqual({ action: "below-threshold", streak: 2 }); // 2nd hard-fail overall, not reset back to 1

    const r4 = await trackApifySourceHealth("src-alt", "https://example.com/alt", { kind: "zero-result" }, spy.fn);
    expect(r4.hardFail).toEqual({ action: "below-threshold", streak: 2 }); // still untouched
    expect(r4.zeroResultStreak).toBe(2); // zero-result channel also never got wiped by the hard-fails

    const r5 = await trackApifySourceHealth("src-alt", "https://example.com/alt", { kind: "hard-fail", error: new Error("timeout") }, spy.fn);
    expect(r5.hardFail.action).toBe("paged"); // 3rd hard-fail overall — escalates, as it must
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0]!.options.key).toBe("eventscout-apify-fail-src-alt");
  });
});
