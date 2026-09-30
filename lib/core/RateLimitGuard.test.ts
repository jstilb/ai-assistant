#!/usr/bin/env bun
/**
 * RateLimitGuard.test.ts — regression coverage for rate/usage/session-limit
 * detection. The 2026-06-22 executor failure was a "session limit" notice that
 * the old pattern (which only matched the bare "hit your limit" wording) missed.
 */

import { describe, it, expect } from "bun:test";
import { isRateLimitError, extractResetInfo } from "./RateLimitGuard.ts";

describe("isRateLimitError", () => {
  it("matches the 5-hour session-limit notice (the 2026-06-22 regression)", () => {
    expect(
      isRateLimitError("You've hit your session limit · resets 11:50pm (America/Los_Angeles)")
    ).toBe(true);
  });

  it("matches the original bare 'hit your limit · resets' wording", () => {
    expect(isRateLimitError("You've hit your limit · resets 3pm")).toBe(true);
  });

  it("matches a plain usage-limit notice with no reset clause", () => {
    expect(isRateLimitError("You've hit your usage limit")).toBe(true);
  });

  it("matches a weekly-limit notice", () => {
    expect(isRateLimitError("You've hit your weekly limit · resets Monday")).toBe(true);
    // Per-model pool banner (2026-08-29 Fable outage) says "reached", not "hit".
    expect(isRateLimitError("You've reached your Fable 5 limit. Switch to another model, or manage usage credits")).toBe(true);
  });

  it("does NOT false-positive on prose that merely mentions rate limiting", () => {
    expect(
      isRateLimitError("The API documentation explains how rate limiting works in general.")
    ).toBe(false);
  });

  it("does NOT match ordinary research output", () => {
    expect(isRateLimitError("I found 5 writing conferences in San Diego.")).toBe(false);
  });
});

describe("extractResetInfo", () => {
  it("pulls the reset time out of a session-limit notice", () => {
    expect(
      extractResetInfo("You've hit your session limit · resets 11:50pm (America/Los_Angeles)")
    ).toBe("11:50pm");
  });

  it("returns null when there is no reset clause", () => {
    expect(extractResetInfo("You've hit your usage limit")).toBeNull();
  });
});
