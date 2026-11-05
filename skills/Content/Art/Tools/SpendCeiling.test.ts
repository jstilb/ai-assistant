import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIError } from "../Lib/cli-utils.ts";
import { DEFAULT_DAILY_CALL_LIMIT, reserveCalls, resolveDailyLimit } from "./SpendCeiling.ts";

describe("SpendCeiling", () => {
  let dir: string;
  let statePath: string;
  let alerts: string[];
  const alert = async (m: string): Promise<void> => {
    alerts.push(m);
  };
  const day1 = () => new Date(2026, 10, 5, 10, 0, 0);
  const day2 = () => new Date(2026, 10, 6, 10, 0, 0);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "art-ceiling-"));
    statePath = join(dir, "State", "art-spend-ceiling.json");
    alerts = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("counts calls under the limit and persists them", async () => {
    const r1 = await reserveCalls({ count: 1, limit: 3, statePath, now: day1, alert });
    const r2 = await reserveCalls({ count: 2, limit: 3, statePath, now: day1, alert });
    expect(r1.callCount).toBe(1);
    expect(r2.callCount).toBe(3);
    expect(JSON.parse(readFileSync(statePath, "utf-8")).callCount).toBe(3);
    expect(alerts).toHaveLength(0);
  });

  test("trips loudly: throws CLIError and sends a page alert; refused call is not counted", async () => {
    await reserveCalls({ count: 2, limit: 3, statePath, now: day1, alert });
    await expect(reserveCalls({ count: 2, limit: 3, model: "flux", statePath, now: day1, alert })).rejects.toThrow(
      CLIError,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("2/3 calls used today");
    expect(JSON.parse(readFileSync(statePath, "utf-8")).callCount).toBe(2);
    // The remaining budget is still usable.
    const r = await reserveCalls({ count: 1, limit: 3, statePath, now: day1, alert });
    expect(r.callCount).toBe(3);
  });

  test("a failing alert hook does not hide the trip", async () => {
    const failing = async (): Promise<void> => {
      throw new Error("telegram down");
    };
    await expect(reserveCalls({ count: 2, limit: 1, statePath, now: day1, alert: failing })).rejects.toThrow(
      /ceiling reached/,
    );
  });

  test("resets at date rollover", async () => {
    await reserveCalls({ count: 3, limit: 3, statePath, now: day1, alert });
    const r = await reserveCalls({ count: 3, limit: 3, statePath, now: day2, alert });
    expect(r.callCount).toBe(3);
    expect(JSON.parse(readFileSync(statePath, "utf-8")).date).toBe("2026-11-06");
  });

  test("rejects an invalid count", async () => {
    await expect(reserveCalls({ count: 0, limit: 3, statePath, now: day1, alert })).rejects.toThrow(CLIError);
    expect(existsSync(statePath)).toBe(false);
  });

  test("limit is configurable through ART_DAILY_CALL_LIMIT", () => {
    expect(resolveDailyLimit({})).toBe(DEFAULT_DAILY_CALL_LIMIT);
    expect(resolveDailyLimit({ ART_DAILY_CALL_LIMIT: "5" })).toBe(5);
    expect(() => resolveDailyLimit({ ART_DAILY_CALL_LIMIT: "abc" })).toThrow(CLIError);
    expect(() => resolveDailyLimit({ ART_DAILY_CALL_LIMIT: "0" })).toThrow(CLIError);
  });

  test("Generate.ts CLI refuses before any paid call when the ceiling is 1 and 2 images are requested", async () => {
    const gen = join(import.meta.dir, "Generate.ts");
    const proc = Bun.spawnSync(
      [
        process.execPath,
        gen,
        "--model",
        "flux",
        "--prompt",
        "x",
        "--output",
        join(dir, "out.png"),
        "--creative-variations",
        "2",
      ],
      {
        env: {
          ...process.env,
          KAYA_HOME: dir,
          KAYA_DIR: dir,
          ART_DAILY_CALL_LIMIT: "1",
          ART_SPEND_STATE_PATH: statePath,
          REPLICATE_API_TOKEN: "",
        },
      },
    );
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr.toString()).toContain("Art spend ceiling reached");
    expect(existsSync(join(dir, "out-v1.png"))).toBe(false);
  });
});
