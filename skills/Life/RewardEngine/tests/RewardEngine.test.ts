/**
 * RewardEngine tests — deterministic schedule math, gates, and state transitions.
 * Pure logic only; no LLM, no real clock (now is injected).
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Pin KAYA_HOME to a temp dir BEFORE importing the module (KayaHome caches it).
const TMP = mkdtempSync(join(tmpdir(), "reward-engine-test-"));
process.env.KAYA_HOME = TMP;
delete process.env.KAYA_DIR;

const M = await import("../Tools/RewardEngine.ts");

const cfg: M.RewardConfig = {
  schedule: {
    pReward: 0.5,
    tierWeights: { small: 70, medium: 25, jackpot: 5 },
    pityAfter: 3,
    dailyRollCap: 5,
    cooldownMinutes: 30,
    streak: { jackpotBonusPerDay: 1, maxBonus: 15 },
  },
  rewards: {
    small: ["s1", "s2"],
    medium: ["m1"],
    jackpot: ["j1"],
  },
  nearMiss: ["miss1", "miss2"],
};

describe("mulberry32", () => {
  test("is deterministic for a given seed", () => {
    const a = M.mulberry32(42);
    const b = M.mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
  test("produces floats in [0,1)", () => {
    const r = M.mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("effectiveJackpotWeight", () => {
  test("adds streak bonus, capped at maxBonus", () => {
    expect(M.effectiveJackpotWeight(cfg.schedule, 0)).toBe(5);
    expect(M.effectiveJackpotWeight(cfg.schedule, 10)).toBe(15);
    expect(M.effectiveJackpotWeight(cfg.schedule, 100)).toBe(20); // 5 + min(15, 100)
  });
});

describe("resolveRoll", () => {
  test("near-miss when rng below pReward fails (rng >= pReward)", () => {
    const rng = () => 0.99; // > pReward (0.5) → no reward
    const r = M.resolveRoll(cfg, rng, 0, 0);
    expect(r.outcome).toBe("near_miss");
    expect(r.tier).toBeNull();
    expect(cfg.nearMiss).toContain(r.reward);
  });

  test("reward when rng below pReward", () => {
    const rng = () => 0.0; // < pReward → reward; tier draw lands on first (small)
    const r = M.resolveRoll(cfg, rng, 0, 0);
    expect(r.outcome).toBe("reward");
    expect(r.tier).toBe("small");
  });

  test("pity guarantees a reward after pityAfter near-misses regardless of rng", () => {
    const rng = () => 0.999; // would normally be a near-miss
    const r = M.resolveRoll(cfg, rng, 0, 3);
    expect(r.pityTriggered).toBe(true);
    expect(r.outcome).toBe("reward");
  });

  test("over many seeds, tier distribution roughly matches weights", () => {
    const counts = { small: 0, medium: 0, jackpot: 0, near_miss: 0 };
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const r = M.resolveRoll(cfg, M.mulberry32(i + 1), 0, 0);
      if (r.outcome === "near_miss") counts.near_miss++;
      else counts[r.tier!]++;
    }
    // ~50% near-miss
    expect(counts.near_miss / N).toBeGreaterThan(0.45);
    expect(counts.near_miss / N).toBeLessThan(0.55);
    const rewards = counts.small + counts.medium + counts.jackpot;
    // small dominates rewards (~70%), jackpot is rare (~5%)
    expect(counts.small / rewards).toBeGreaterThan(0.6);
    expect(counts.jackpot / rewards).toBeLessThan(0.1);
    expect(counts.jackpot).toBeGreaterThan(0); // but does happen
  });

  test("higher streak raises jackpot share", () => {
    const tally = (streak: number) => {
      let jackpot = 0, rewards = 0;
      for (let i = 0; i < 20000; i++) {
        const r = M.resolveRoll(cfg, M.mulberry32(i + 1), streak, 0);
        if (r.outcome === "reward") {
          rewards++;
          if (r.tier === "jackpot") jackpot++;
        }
      }
      return jackpot / rewards;
    };
    expect(tally(15)).toBeGreaterThan(tally(0));
  });

  test("falls back gracefully when a tier is empty", () => {
    const emptyJackpot: M.RewardConfig = { ...cfg, rewards: { small: ["s"], medium: ["m"], jackpot: [] } };
    // force tier selection toward jackpot via weights but reward exists path
    const r = M.resolveRoll(emptyJackpot, () => 0.0, 100, 0);
    expect(r.outcome).toBe("reward");
    expect(["small", "medium"]).toContain(r.tier); // jackpot empty → fell back
  });
});

describe("checkGate", () => {
  const baseState = (): M.EngineState => M.defaultState();

  test("allows first roll", () => {
    const g = M.checkGate(cfg.schedule, baseState(), new Date("2026-06-27T12:00:00Z"));
    expect(g.allowed).toBe(true);
    expect(g.rollsTodayAfterReset).toBe(0);
  });

  test("blocks when daily cap reached", () => {
    const s = baseState();
    s.lastRollDate = new Date("2026-06-27T12:00:00Z").toLocaleDateString("en-CA");
    s.rollsToday = 5;
    const g = M.checkGate(cfg.schedule, s, new Date("2026-06-27T13:00:00Z"));
    expect(g.allowed).toBe(false);
    expect(g.reason).toContain("cap");
  });

  test("resets daily count on a new local day", () => {
    const s = baseState();
    s.lastRollDate = "2026-06-26";
    s.rollsToday = 5;
    const g = M.checkGate(cfg.schedule, s, new Date("2026-06-27T20:00:00Z"));
    expect(g.allowed).toBe(true);
    expect(g.rollsTodayAfterReset).toBe(0);
  });

  test("blocks during cooldown", () => {
    const s = baseState();
    s.lastRollAt = "2026-06-27T12:00:00Z";
    s.lastRollDate = new Date("2026-06-27T12:00:00Z").toLocaleDateString("en-CA");
    s.rollsToday = 1;
    const g = M.checkGate(cfg.schedule, s, new Date("2026-06-27T12:10:00Z")); // 10 min < 30
    expect(g.allowed).toBe(false);
    expect(g.reason).toContain("Cooldown");
  });

  test("allows after cooldown elapses", () => {
    const s = baseState();
    s.lastRollAt = "2026-06-27T12:00:00Z";
    s.lastRollDate = new Date("2026-06-27T12:00:00Z").toLocaleDateString("en-CA");
    s.rollsToday = 1;
    const g = M.checkGate(cfg.schedule, s, new Date("2026-06-27T12:40:00Z")); // 40 min > 30
    expect(g.allowed).toBe(true);
  });
});

describe("applyRoll", () => {
  const reward: M.RollResolution = { outcome: "reward", tier: "small", reward: "s1", effectiveJackpotWeight: 5, pityTriggered: false };
  const jackpot: M.RollResolution = { outcome: "reward", tier: "jackpot", reward: "j1", effectiveJackpotWeight: 5, pityTriggered: false };
  const miss: M.RollResolution = { outcome: "near_miss", tier: null, reward: "miss1", effectiveJackpotWeight: 5, pityTriggered: false };

  test("first qualifying roll starts a 1-day streak", () => {
    const next = M.applyRoll(M.defaultState(), reward, new Date("2026-06-27T12:00:00Z"), 0);
    expect(next.streakDays).toBe(1);
    expect(next.totals.rolls).toBe(1);
    expect(next.totals.rewards).toBe(1);
    expect(next.rollsToday).toBe(1);
  });

  test("consecutive day continues the streak", () => {
    let s = M.applyRoll(M.defaultState(), reward, new Date("2026-06-26T12:00:00Z"), 0);
    s = M.applyRoll(s, reward, new Date("2026-06-27T12:00:00Z"), 0);
    expect(s.streakDays).toBe(2);
  });

  test("a gap day resets the streak to 1", () => {
    let s = M.applyRoll(M.defaultState(), reward, new Date("2026-06-25T12:00:00Z"), 0);
    s = M.applyRoll(s, reward, new Date("2026-06-27T12:00:00Z"), 0); // skipped the 26th
    expect(s.streakDays).toBe(1);
  });

  test("same-day second roll does not bump the streak", () => {
    let s = M.applyRoll(M.defaultState(), reward, new Date("2026-06-27T12:00:00Z"), 0);
    s = M.applyRoll(s, reward, new Date("2026-06-27T14:00:00Z"), s.rollsToday);
    expect(s.streakDays).toBe(1);
    expect(s.rollsToday).toBe(2);
  });

  test("near-miss increments consecutiveNearMisses; reward resets it", () => {
    let s = M.applyRoll(M.defaultState(), miss, new Date("2026-06-27T12:00:00Z"), 0);
    expect(s.consecutiveNearMisses).toBe(1);
    s = M.applyRoll(s, miss, new Date("2026-06-27T13:00:00Z"), s.rollsToday);
    expect(s.consecutiveNearMisses).toBe(2);
    s = M.applyRoll(s, reward, new Date("2026-06-27T14:00:00Z"), s.rollsToday);
    expect(s.consecutiveNearMisses).toBe(0);
  });

  test("jackpot increments jackpot total", () => {
    const s = M.applyRoll(M.defaultState(), jackpot, new Date("2026-06-27T12:00:00Z"), 0);
    expect(s.totals.jackpots).toBe(1);
  });
});

describe("ledger + state persistence", () => {
  beforeEach(() => {
    // fresh paths under the temp KAYA_HOME for each test run
  });

  test("appendLedger + readLedger round-trip and respect limit", () => {
    for (let i = 0; i < 5; i++) {
      M.appendLedger({
        at: `2026-06-27T1${i}:00:00Z`, day: "2026-06-27", work: `w${i}`, qualified: true,
        outcome: "reward", tier: "small", reward: `r${i}`, streakDays: 1, seed: i,
      });
    }
    const all = M.readLedger();
    expect(all.length).toBeGreaterThanOrEqual(5);
    const last2 = M.readLedger(2);
    expect(last2.length).toBe(2);
    expect(last2[1].reward).toBe("r4");
  });

  test("saveState + loadState round-trip", () => {
    const s = M.defaultState();
    s.streakDays = 7;
    s.totals.jackpots = 2;
    M.saveState(s);
    const { state } = M.rewardEnginePaths();
    expect(existsSync(state)).toBe(true);
    const loaded = M.loadState();
    expect(loaded.streakDays).toBe(7);
    expect(loaded.totals.jackpots).toBe(2);
  });

  test("loadState returns defaults when file absent/corrupt", () => {
    // corrupt the file
    const { state } = M.rewardEnginePaths();
    require("fs").writeFileSync(state, "{not json");
    const loaded = M.loadState();
    expect(loaded.streakDays).toBe(0);
  });
});

describe("localDay", () => {
  test("renders YYYY-MM-DD", () => {
    expect(M.localDay(new Date("2026-06-27T12:00:00Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
