#!/usr/bin/env bun
/**
 * followup.test.ts — G3 slice 2: the follow-up question in Jm's next Kaya session.
 * Run: bun test <absolute path to this file>
 */

import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dueFollowUps, followUpContext, followUpPaths, renderFollowUp } from "../Tools/FollowUp.ts";
import type { HoldEntry } from "../Tools/WeekendHolds.ts";

const NOW = new Date("2026-11-16T18:00:00Z"); // Mon Nov 16, 10:00 PST

function hold(id: string, start: string, end: string, status: HoldEntry["status"] = "placed", title = `Hold ${id}`): HoldEntry {
  return {
    weekend: "2026-11-14",
    calendarEventId: id,
    eventId: `ev-${id}`,
    title,
    start,
    end,
    sourceUrl: "https://example.com",
    returnVisit: false,
    placedAt: "2026-11-13T00:30:00Z",
    status,
  };
}

const SAT = hold("sat", "2026-11-15T04:30:00Z", "2026-11-15T06:30:00Z", "placed", "Tango Del Rey Salsa / Bachata"); // Sat 20:30 PST
const SUN = hold("sun", "2026-11-15T19:00:00Z", "2026-11-15T21:00:00Z", "kept"); // Sun 11:00 PST
const DROPPED = hold("drop", "2026-11-15T18:00:00Z", "2026-11-15T20:00:00Z", "dropped");
const OLD = hold("old", "2026-11-10T03:00:00Z", "2026-11-10T05:00:00Z"); // ended 6+ days ago
const FUTURE = hold("tue", "2026-11-18T01:30:00Z", "2026-11-18T03:30:00Z"); // Tue 17:30 PST

test("dueFollowUps: ended within 4 days, not dropped, not asked; oldest first", () => {
  const due = dueFollowUps([SUN, FUTURE, OLD, DROPPED, SAT], {}, NOW);
  expect(due.map((e) => e.calendarEventId)).toEqual(["sat", "sun"]);
  expect(dueFollowUps([SUN, SAT], { sat: "2026-11-15T20:00:00Z" }, NOW).map((e) => e.calendarEventId)).toEqual(["sun"]);
  expect(dueFollowUps([{ ...SAT, end: "not a date" }], {}, NOW)).toEqual([]);
});

test("renderFollowUp: the question names each hold with its LA day and time, and routes the answer to the Router", () => {
  const text = renderFollowUp([SAT, SUN]);
  expect(text).toContain("“Tango Del Rey Salsa / Bachata” on Sat, Nov 14 at 8:30 PM");
  expect(text).toContain("“Hold sun” on Sun, Nov 15 at 11:00 AM");
  expect(text).toContain("If you went: how was it, and anyone you want to see again?");
  expect(text).toContain("skills/Productivity/LifeOS/Capture/Router.ts");
  expect(text).toContain('"Tango Del Rey Salsa / Bachata on Nov 14, 8/10, met two people I\'d see again"');
});

test("followUpContext: shows a due hold once, then records it as asked", () => {
  const dir = mkdtempSync(join(tmpdir(), "es-followup-"));
  try {
    const paths = followUpPaths(dir);
    expect(followUpContext(NOW, paths)).toBeNull(); // no ledger yet
    expect(existsSync(paths.asked)).toBe(false);
    const state = join(dir, "skills", "Productivity", "EventScout", "State");
    Bun.spawnSync(["mkdir", "-p", state]);
    writeFileSync(paths.ledger, JSON.stringify({ entries: [SAT, DROPPED, FUTURE], runs: [] }));
    const first = followUpContext(NOW, paths);
    expect(first).toContain("Tango Del Rey Salsa / Bachata");
    expect(first).not.toContain("Hold drop");
    expect(first).not.toContain("Hold tue");
    const asked = JSON.parse(readFileSync(paths.asked, "utf8")) as { asked: Record<string, string> };
    expect(Object.keys(asked.asked)).toEqual(["sat"]);
    expect(followUpContext(NOW, paths)).toBeNull(); // asked once only
    // The Tuesday hold becomes due after it ends.
    const wed = new Date("2026-11-18T18:00:00Z");
    expect(followUpContext(wed, paths)).toContain("Hold tue");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
