/**
 * HealthManager.test.ts — Tests for the unified health state singleton.
 *
 * ISC row 6: HealthManager.ts exists as single source for health state.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AlertGate } from "../../../../lib/core/AlertGate.ts";

let testHome: string;

beforeEach(() => {
  testHome = join(tmpdir(), `hm-test-${Date.now()}`);
  mkdirSync(join(testHome, "MEMORY", "AutoMaintenance"), { recursive: true });
  process.env.KAYA_HOME = testHome;
});

afterEach(() => {
  delete process.env.KAYA_HOME;
  if (existsSync(testHome)) rmSync(testHome, { recursive: true });
  // Reset singleton so next test gets a fresh StateManager with new KAYA_HOME
  import("./HealthManager").then(m => m._resetHealthManagerForTest());
});

describe("HealthManager", () => {
  it("loadHealthState returns defaults when file does not exist", async () => {
    const { loadHealthState, _resetHealthManagerForTest } = await import("./HealthManager");
    _resetHealthManagerForTest();
    const state = await loadHealthState();
    expect(state.openAlerts).toBe(0);
    expect(typeof state.lastRunByTier).toBe("object");
    expect(typeof state.issuePersistence).toBe("object");
  });

  it("saveHealthState persists and loadHealthState retrieves correctly", async () => {
    const { loadHealthState, saveHealthState, _resetHealthManagerForTest } = await import("./HealthManager");
    _resetHealthManagerForTest();

    const state = await loadHealthState();
    state.lastRunByTier["daily"] = "2026-03-29T00:00:00.000Z";
    state.openAlerts = 3;
    await saveHealthState(state);

    _resetHealthManagerForTest();
    const reloaded = await loadHealthState();
    expect(reloaded.lastRunByTier["daily"]).toBe("2026-03-29T00:00:00.000Z");
    expect(reloaded.openAlerts).toBe(3);
  });

  it("updateHealthState applies atomic transform", async () => {
    const { loadHealthState, updateHealthState, _resetHealthManagerForTest } = await import("./HealthManager");
    _resetHealthManagerForTest();

    await updateHealthState(s => ({ ...s, openAlerts: 5 }));

    _resetHealthManagerForTest();
    const loaded = await loadHealthState();
    expect(loaded.openAlerts).toBe(5);
  });

  it("issuePersistence is typed — accepts IssueRecord shape", async () => {
    const { loadHealthState, saveHealthState, _resetHealthManagerForTest } = await import("./HealthManager");
    _resetHealthManagerForTest();

    const state = await loadHealthState();
    const record = {
      firstSeen: "2026-03-29T00:00:00.000Z",
      lastSeen: "2026-03-29T01:00:00.000Z",
      occurrences: 2,
      type: "disk_warning",
      finding: "Disk usage at 85%",
      status: "monitoring" as const,
    };
    state.issuePersistence["daily:integrity:abc123"] = record;
    await saveHealthState(state);

    _resetHealthManagerForTest();
    const reloaded = await loadHealthState();
    const issue = reloaded.issuePersistence["daily:integrity:abc123"];
    expect(issue).toBeDefined();
    expect(issue!.occurrences).toBe(2);
    expect(issue!.status).toBe("monitoring");
    expect(issue!.type).toBe("disk_warning");
  });

  it("returns defaults gracefully when file is corrupt JSON", async () => {
    const { writeFileSync } = await import("fs");
    writeFileSync(join(testHome, "MEMORY", "AutoMaintenance", "health-state.json"), "not valid json");

    const { loadHealthState, _resetHealthManagerForTest } = await import("./HealthManager");
    _resetHealthManagerForTest();
    // Should not throw — returns defaults
    const state = await loadHealthState();
    expect(state.openAlerts).toBe(0);
    expect(typeof state.issuePersistence).toBe("object");
  });
});

// ============================================================================
// checkForGaps — AlertGate routing (alert-storm remediation Slice 1.4)
//
// Prior to this slice, checkForGaps fired a raw notifySync push
// UNCONDITIONALLY on every call where the gap exceeded 25h — on 2026-07-11 an
// unplugged MacBook slept through cron windows and the hourly reconciler's
// catch-up logic re-invoked checkForGaps 3x for the same gap, producing 3
// duplicate pages. These tests pin an injected AlertGate (scratch
// statePath/spoolPath + recording send, per lib/core/AlertGate.test.ts's
// makeGate() idiom) so cooldown/dedup behavior is verifiable without
// touching the real Telegram/state paths.
// ============================================================================

describe("checkForGaps — AlertGate routing", () => {
  const TIER = "daily";
  let sent: Array<{ message: string; channel: string }>;
  let clock: { now: number };

  // Lazy: `testHome` is assigned in this file's beforeAll, so it is still
  // undefined while the describe body is being evaluated.
  const spoolPath = () => join(testHome, "MEMORY", "NOTIFICATIONS", "digest-spool.jsonl");

  function makeGate(): AlertGate {
    return new AlertGate({
      statePath: join(testHome, "MEMORY", "State", "alert-gate.json"),
      spoolPath: spoolPath(),
      send: async (message, channel) => { sent.push({ message, channel }); return true; },
      now: () => clock.now,
    });
  }

  /** Digest-tier rows land here rather than on the page channel. */
  function readSpool(): Array<{ key: string; tier: string; message: string }> {
    if (!existsSync(spoolPath())) return [];
    return readFileSync(spoolPath(), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  beforeEach(() => {
    sent = [];
    clock = { now: new Date("2026-07-11T12:00:00Z").getTime() };
    // Each test asserts on absolute spool counts — start from an empty spool
    // so a prior test's rows can't leak in (the gate appends, never truncates).
    rmSync(spoolPath(), { force: true });
  });

  it("fires a page once when gap exceeds 25 hours", async () => {
    const { loadHealthState, checkForGaps, _resetHealthManagerForTest } = await import("./HealthManager");
    _resetHealthManagerForTest();

    const state = await loadHealthState();
    state.lastRunByTier[TIER] = new Date(clock.now - 26 * 60 * 60 * 1000).toISOString();

    const gate = makeGate();
    const result = await checkForGaps(TIER, state, { gate });

    expect(result.gapDetected).toBe(true);
    expect(result.gapHours).toBeGreaterThan(25);
    expect(result.notificationFired).toBe(true);
    // 2026-07-31: tier is now 'digest', so this must NOT reach the page
    // channel. sendFn fires only for tier:'page'; digest/log spool silently.
    expect(sent.length).toBe(0);
    expect(readSpool()[0]!.message).toContain(`last ${TIER} run`);
  });

  it("a repeat check spools again but the digest collapses it by key", async () => {
    const { loadHealthState, checkForGaps, _resetHealthManagerForTest } = await import("./HealthManager");
    _resetHealthManagerForTest();

    const state = await loadHealthState();
    state.lastRunByTier[TIER] = new Date(clock.now - 26 * 60 * 60 * 1000).toISOString();

    const gate = makeGate();
    const first = await checkForGaps(TIER, state, { gate });
    expect(first.notificationFired).toBe(true);

    // Simulate the hourly reconciler's catch-up re-invoking checkForGaps for
    // the same still-open gap, moments later.
    clock.now += 5 * 60 * 1000; // +5 minutes
    const second = await checkForGaps(TIER, state, { gate });
    expect(second.gapDetected).toBe(true); // gap is still real

    // The page-tier cooldown no longer applies (digest tier doesn't stamp
    // one), so both calls spool — but that is NOT a regression to the
    // 2026-07-11 triple-push: SystemHealthDigest dedupes digest entries BY KEY
    // ("latest message, ×count" — SystemHealthDigest.ts:11/157), so both rows
    // share the single `automaintenance-gap-daily` key and render as one
    // bullet. What matters is that Jm is interrupted zero times either way.
    expect(sent.length).toBe(0);
    const spooled = readSpool();
    expect(spooled.length).toBe(2);
    expect(new Set(spooled.map((e) => e.key)).size).toBe(1);
  });

  it("injected gate receives the right key and the digest tier", async () => {
    const { loadHealthState, checkForGaps, _resetHealthManagerForTest } = await import("./HealthManager");
    _resetHealthManagerForTest();

    const state = await loadHealthState();
    state.lastRunByTier[TIER] = new Date(clock.now - 30 * 60 * 60 * 1000).toISOString();

    const gate = makeGate();
    await checkForGaps(TIER, state, { gate });

    // No page channel traffic, and the spool row carries exactly the spec'd
    // key + tier — proving both were passed through as intended.
    expect(sent.length).toBe(0);
    const spooled = readSpool();
    expect(spooled.length).toBe(1);
    expect(spooled[0]!.key).toBe(`automaintenance-gap-${TIER}`);
    expect(spooled[0]!.tier).toBe("digest");
  });

  it("does not fire when force option bypasses the check", async () => {
    const { loadHealthState, checkForGaps, _resetHealthManagerForTest } = await import("./HealthManager");
    _resetHealthManagerForTest();

    const state = await loadHealthState();
    state.lastRunByTier[TIER] = new Date(clock.now - 30 * 60 * 60 * 1000).toISOString();

    const gate = makeGate();
    const result = await checkForGaps(TIER, state, { force: true, gate });

    expect(result.bypassed).toBe(true);
    expect(result.notificationFired).toBe(false);
    expect(sent.length).toBe(0);
  });
});
