/**
 * LiveVerifyContext.test.ts — Slice 1: context-aware engine selection.
 * Pure function over env — no spawns.
 */

import { test, expect, describe } from "bun:test";
import { resolveLiveVerifyContext, resolveLiveVerifyMode } from "./LiveVerifyContext.ts";

describe("resolveLiveVerifyContext", () => {
  test("explicit override wins over everything", () => {
    expect(resolveLiveVerifyContext({ KAYA_LIVE_VERIFY_MODE: "explorer", CLAUDECODE: "1" }).mode).toBe("explorer");
    expect(resolveLiveVerifyContext({ KAYA_LIVE_VERIFY_MODE: "self-verify", KAYA_CRON_JOB_ID: "job-1" }).mode).toBe("self-verify");
    expect(resolveLiveVerifyContext({ KAYA_LIVE_VERIFY_MODE: "self_verify" }).mode).toBe("self-verify");
  });

  test("authorized cron context → explorer (even if CLAUDECODE is set)", () => {
    // A cron `claude -p` run sets BOTH — cron must win so the Explorer still runs.
    const ctx = resolveLiveVerifyContext({ KAYA_CRON_JOB_ID: "knowledge-daily", CLAUDECODE: "1" });
    expect(ctx.mode).toBe("explorer");
    expect(ctx.reason).toContain("cron");
  });

  test("authorized autonomous flag → explorer", () => {
    expect(resolveLiveVerifyContext({ KAYA_AUTONOMOUS: "1" }).mode).toBe("explorer");
    expect(resolveLiveVerifyContext({ KAYA_AUTONOMOUS: "true" }).mode).toBe("explorer");
  });

  test("interactive session (CLAUDECODE, no cron) → self-verify", () => {
    const ctx = resolveLiveVerifyContext({ CLAUDECODE: "1" });
    expect(ctx.mode).toBe("self-verify");
    expect(ctx.reason).toContain("interactive");
  });

  test("bare/unknown context defaults to self-verify (never attempt the blocked spawn)", () => {
    expect(resolveLiveVerifyContext({}).mode).toBe("self-verify");
  });

  test("resolveLiveVerifyMode is a thin alias", () => {
    expect(resolveLiveVerifyMode({ KAYA_CRON_JOB_ID: "x" })).toBe("explorer");
    expect(resolveLiveVerifyMode({})).toBe("self-verify");
  });
});
