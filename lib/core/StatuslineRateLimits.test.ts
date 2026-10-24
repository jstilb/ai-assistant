#!/usr/bin/env bun
/**
 * StatuslineRateLimits.test.ts — drives the REAL statusline-command.sh with a sample payload (field names from the
 * Claude Code 2.1.302 statusline schema: .rate_limits.five_hour / .seven_day, resets_at in epoch seconds) against a
 * temp KAYA_DIR, and checks what lands in MEMORY/State/rate-limits.json. The real state file is never touched.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RateLimitsSchema } from "./MemoryPaths.ts";

const SCRIPT = join(import.meta.dir, "..", "..", "statusline-command.sh");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prl-statusline-"));
  mkdirSync(join(dir, "MEMORY", "State", "cache"), { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ daidentity: { name: "Kaya" }, rateLimits: { enabled: false } }));
});

function render(payload: unknown): { code: number; stateRaw: string } {
  const p = Bun.spawnSync(["bash", SCRIPT], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    env: { ...process.env, KAYA_DIR: dir, KAYA_HOME: dir, COLUMNS: "120" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  return { code: p.exitCode ?? -1, stateRaw: readFileSync(join(dir, "MEMORY", "State", "rate-limits.json"), "utf-8") };
}

const base = { workspace: { current_dir: "/tmp" }, model: { display_name: "Opus" } };
const nowSec = (): number => Math.floor(Date.now() / 1000);

describe("statusline-command.sh rate-limits.json", () => {
  it("parses five_hour / seven_day and writes ISO resetsAt, observedAt and lastReal", () => {
    const five = nowSec() + 3600;
    const week = nowSec() + 86_400;
    const { stateRaw } = render({ ...base, rate_limits: { five_hour: { used_percentage: 42.4, resets_at: five }, seven_day: { used_percentage: 81, resets_at: week } } });
    const s = RateLimitsSchema.parse(JSON.parse(stateRaw));
    expect(s.fiveHour?.usedPercentage).toBe(42.4);
    expect(s.fiveHour?.resetsAt).toBe(new Date(five * 1000).toISOString().replace(".000Z", "Z"));
    expect(s.sevenDay?.usedPercentage).toBe(81);
    expect(s.fiveHour?.observedAt).toBe(s.updatedAt);
    expect(s.lastReal?.sevenDay?.usedPercentage).toBe(81);
  });

  it("a render with no rate_limits NEVER overwrites the last real reading", () => {
    render({ ...base, rate_limits: { five_hour: { used_percentage: 70, resets_at: nowSec() + 3600 } } });
    const first = RateLimitsSchema.parse(JSON.parse(readFileSync(join(dir, "MEMORY", "State", "rate-limits.json"), "utf-8")));
    const { stateRaw } = render(base);
    const s = RateLimitsSchema.parse(JSON.parse(stateRaw));
    expect(s.fiveHour).toBeNull();
    expect(s.sevenDay).toBeNull();
    expect(s.lastReal?.fiveHour).toEqual(first.fiveHour);
    expect(s.lastReal?.sevenDay).toBeNull();
  });

  it("a window the payload drops keeps its own last reading while the other updates", () => {
    render({ ...base, rate_limits: { five_hour: { used_percentage: 10, resets_at: nowSec() + 3600 }, seven_day: { used_percentage: 55, resets_at: nowSec() + 86_400 } } });
    const { stateRaw } = render({ ...base, rate_limits: { five_hour: { used_percentage: 12, resets_at: nowSec() + 3600 } } });
    const s = RateLimitsSchema.parse(JSON.parse(stateRaw));
    expect(s.lastReal?.fiveHour?.usedPercentage).toBe(12);
    expect(s.lastReal?.sevenDay?.usedPercentage).toBe(55);
    expect(s.sevenDay).toBeNull();
  });

  it("malformed stdin leaves an existing rate-limits.json byte-identical", () => {
    render({ ...base, rate_limits: { five_hour: { used_percentage: 70, resets_at: nowSec() + 3600 } } });
    const file = join(dir, "MEMORY", "State", "rate-limits.json");
    const before = readFileSync(file);
    const p = Bun.spawnSync(["bash", SCRIPT], {
      stdin: new TextEncoder().encode("this is {not json"),
      env: { ...process.env, KAYA_DIR: dir, KAYA_HOME: dir, COLUMNS: "120" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    expect(p.exitCode).not.toBeNull();
    expect(Buffer.compare(before, readFileSync(file))).toBe(0);
  });

  it("the old wrong key names (5_hour / 7_day) are not read", () => {
    const { stateRaw } = render({ ...base, rate_limits: { "5_hour": { used_percentage: 99, resets_at: nowSec() + 3600 } } });
    const s = RateLimitsSchema.parse(JSON.parse(stateRaw));
    expect(s.fiveHour).toBeNull();
    expect(s.lastReal?.fiveHour).toBeNull();
  });
});
