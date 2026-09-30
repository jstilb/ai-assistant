/**
 * SessionGuard.test.ts — deterministic bin/claude-browser session check.
 *
 * Fully env-injected — never reads/mutates the real process.env, so this is
 * hermetic without any KAYA_HOME/mkdtemp involved.
 */

import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkSession, expectedBrowserConfigDir, isBrowserSession, pointerLine } from "../Tools/SessionGuard.ts";

const BROWSER_HOME = join(homedir(), ".claude-browser-home");

test("isBrowserSession(): true when CLAUDE_CONFIG_DIR matches the claude-browser private config dir", () => {
  expect(isBrowserSession({ CLAUDE_CONFIG_DIR: BROWSER_HOME })).toBe(true);
});

test("isBrowserSession(): false when CLAUDE_CONFIG_DIR is unset (ordinary session)", () => {
  expect(isBrowserSession({})).toBe(false);
});

test("isBrowserSession(): false when CLAUDE_CONFIG_DIR points somewhere else entirely", () => {
  expect(isBrowserSession({ CLAUDE_CONFIG_DIR: "~/.claude" })).toBe(false);
});

test("isBrowserSession(): honors a CLAUDE_BROWSER_HOME override, matching bin/claude-browser's own derivation", () => {
  const env = { CLAUDE_BROWSER_HOME: "/custom/browser-home", CLAUDE_CONFIG_DIR: "/custom/browser-home" };
  expect(isBrowserSession(env)).toBe(true);
  expect(expectedBrowserConfigDir(env)).toBe("/custom/browser-home");
});

test("checkSession(): in-session branch — ok:true, message:null", () => {
  const result = checkSession("prune", { CLAUDE_CONFIG_DIR: BROWSER_HOME });
  expect(result).toEqual({ ok: true, message: null });
});

test("checkSession(): out-of-session branch — ok:false, exact pointer line", () => {
  const result = checkSession("prune", {});
  expect(result.ok).toBe(false);
  expect(result.message).toBe("run /youtube prune from the claude-browser session.");
});

test("pointerLine(): substitutes the actual subcommand, verbatim wording otherwise", () => {
  expect(pointerLine("wl")).toBe("run /youtube wl from the claude-browser session.");
  expect(pointerLine("steer")).toBe("run /youtube steer from the claude-browser session.");
});
