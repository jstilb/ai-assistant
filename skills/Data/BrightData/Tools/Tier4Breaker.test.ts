/**
 * Tier4Breaker.test.ts - hermetic tests for the shared Bright Data Tier-4 spend breaker (T2-11).
 * Every test uses its own temp Kaya home and an injected clock + alert hook.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrightDataTool } from "./BrightDataTool.ts";
import { BREAKER_ALERT_KEY, Tier4Breaker, resolveDailyCeiling } from "./Tier4Breaker.ts";

let home: string;
let clock: Date;
let alerts: Array<{ message: string; key: string; tier: string }>;
const alert = async (message: string, options: { key: string; tier: "page" }) => {
  alerts.push({ message, ...options });
};

function make(opts: { dailyCeiling?: number; domainCooldownMs?: number } = {}): Tier4Breaker {
  return new Tier4Breaker({ kayaHome: home, now: () => clock, alert, ...opts });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tier4-breaker-test-"));
  clock = new Date(2026, 6, 20, 12, 0, 0);
  alerts = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("resolveDailyCeiling", () => {
  test("unset or blank means no ceiling (current behavior)", () => {
    expect(resolveDailyCeiling({})).toBe(Number.POSITIVE_INFINITY);
    expect(resolveDailyCeiling({ BRIGHTDATA_TIER4_DAILY_CEILING: " " })).toBe(Number.POSITIVE_INFINITY);
  });

  test("numeric value is used; 0 is a valid hard stop", () => {
    expect(resolveDailyCeiling({ BRIGHTDATA_TIER4_DAILY_CEILING: "20" })).toBe(20);
    expect(resolveDailyCeiling({ BRIGHTDATA_TIER4_DAILY_CEILING: "0" })).toBe(0);
  });

  test("invalid value falls back to no ceiling but says so on stderr", () => {
    const spy = spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
    try {
      expect(resolveDailyCeiling({ BRIGHTDATA_TIER4_DAILY_CEILING: "abc" })).toBe(Number.POSITIVE_INFINITY);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Tier4Breaker", () => {
  test("default (no ceiling) never trips on the daily rule, however many calls", async () => {
    const b = make();
    for (let i = 0; i < 50; i++) await b.recordUse(`d${i}.example.com`);
    expect((await b.check("fresh.example.com")).allowed).toBe(true);
    expect(alerts).toHaveLength(0);
  });

  test("per-domain cooldown trips after one use and clears after the cooldown", async () => {
    const b = make();
    await b.recordUse("a.example.com");
    const tripped = await b.check("a.example.com");
    expect(tripped.allowed).toBe(false);
    if (!tripped.allowed) expect(tripped.kind).toBe("domain");
    expect((await b.check("b.example.com")).allowed).toBe(true);

    clock = new Date(clock.getTime() + 61 * 60 * 1000);
    expect((await b.check("a.example.com")).allowed).toBe(true);
  });

  test("daily ceiling trips across different domains, pages, and resets at date rollover", async () => {
    const b = make({ dailyCeiling: 2 });
    await b.recordUse("a.example.com");
    await b.recordUse("b.example.com");

    const tripped = await b.check("c.example.com");
    expect(tripped.allowed).toBe(false);
    if (!tripped.allowed) {
      expect(tripped.kind).toBe("daily");
      expect(tripped.reason).toContain("2/2");
    }
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.key).toBe(BREAKER_ALERT_KEY);
    expect(alerts[0]?.tier).toBe("page");

    clock = new Date(2026, 6, 21, 0, 5, 0);
    expect((await b.check("c.example.com")).allowed).toBe(true);
  });

  test("ceiling 0 refuses every call (forced trip)", async () => {
    const b = make({ dailyCeiling: 0 });
    const d = await b.check("a.example.com");
    expect(d.allowed).toBe(false);
    expect(alerts).toHaveLength(1);
  });

  test("ignoreDomainRule skips the per-domain cooldown but still enforces the daily ceiling", async () => {
    const b = make({ dailyCeiling: 1 });
    await b.recordUse("a.example.com");
    const d = await b.check("a.example.com", { ignoreDomainRule: true });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.kind).toBe("daily");

    const open = make({ dailyCeiling: 5 });
    expect((await open.check("a.example.com", { ignoreDomainRule: true })).allowed).toBe(true);
  });

  test("a failing alert hook is logged to stderr and the refusal still stands", async () => {
    const spy = spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
    try {
      const b = new Tier4Breaker({
        kayaHome: home,
        now: () => clock,
        dailyCeiling: 0,
        alert: async () => {
          throw new Error("telegram down");
        },
      });
      const d = await b.check("a.example.com");
      expect(d.allowed).toBe(false);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("state is shared between instances through the state file", async () => {
    await make({ dailyCeiling: 1 }).recordUse("a.example.com");
    const other = make({ dailyCeiling: 1 });
    expect((await other.check("z.example.com")).allowed).toBe(false);
    expect((await other.status()).daily.callCount).toBe(1);
  });
});

describe("BrightDataTool wiring", () => {
  let fetchSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    process.env["KAYA_HOME"] = home;
    writeFileSync(join(home, "secrets.json"), JSON.stringify({ BRIGHTDATA_API_TOKEN: "t" }));
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
    delete process.env["KAYA_HOME"];
  });

  test("a tripped daily ceiling refuses Tier 4 before any request is sent, even with forceTier4", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response("<html>ok</html>", { status: 200 })) as unknown as typeof fetch,
    );
    const tool = new BrightDataTool({ kayaHome: home, tier4Breaker: make({ dailyCeiling: 0 }) });
    const result = await tool.scrape("https://walled.example.com", { startTier: 4, forceTier4: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain("daily ceiling");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(alerts).toHaveLength(1);
  });

  test("a real Tier-4 call is counted against the shared ceiling", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response("<html><body>unlocked</body></html>", { status: 200 })) as unknown as typeof fetch,
    );
    const breaker = make({ dailyCeiling: 1 });
    const tool = new BrightDataTool({ kayaHome: home, tier4Breaker: breaker });

    const first = await tool.scrape("https://one.example.com", { startTier: 4 });
    expect(first.success).toBe(true);
    expect((await breaker.status()).daily.callCount).toBe(1);

    const second = await tool.scrape("https://two.example.com", { startTier: 4 });
    expect(second.success).toBe(false);
    expect(second.error).toContain("daily ceiling");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("default breaker (no ceiling) leaves existing behavior unchanged", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response("<html><body>unlocked</body></html>", { status: 200 })) as unknown as typeof fetch,
    );
    const tool = new BrightDataTool({ kayaHome: home });
    const a = await tool.scrape("https://one.example.com", { startTier: 4 });
    const b = await tool.scrape("https://two.example.com", { startTier: 4 });
    expect(a.success && b.success).toBe(true);
  });
});
