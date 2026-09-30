/**
 * Util.test.ts — shared date helpers must be timezone-correct regardless of
 * the process TZ env var (launchd inherits a minimal env).
 */

import { expect, test } from "bun:test";
import { daysBetween, shiftDate, todayLocal, yesterdayLocal } from "../Tools/Util.ts";

test("shiftDate: +/- integer days, calendar-anchored", () => {
  expect(shiftDate("2026-05-12", 0)).toBe("2026-05-12");
  expect(shiftDate("2026-05-12", 1)).toBe("2026-05-13");
  expect(shiftDate("2026-05-12", -1)).toBe("2026-05-11");
  expect(shiftDate("2026-05-12", 30)).toBe("2026-06-11");
  expect(shiftDate("2026-05-01", -1)).toBe("2026-04-30");
});

test("shiftDate: month/year boundary", () => {
  expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
  expect(shiftDate("2027-01-01", -1)).toBe("2026-12-31");
});

test("shiftDate: DST transition (2026-03-08 spring-forward in PDT)", () => {
  // PDT springs forward 2026-03-08 02:00 local. Shifting around it must
  // still yield calendar dates, not 23:00 of the previous day.
  expect(shiftDate("2026-03-07", 1)).toBe("2026-03-08");
  expect(shiftDate("2026-03-08", 1)).toBe("2026-03-09");
});

test("daysBetween: inclusive range", () => {
  expect(daysBetween("2026-05-10", "2026-05-12")).toEqual([
    "2026-05-10", "2026-05-11", "2026-05-12",
  ]);
});

test("daysBetween: same day → singleton", () => {
  expect(daysBetween("2026-05-12", "2026-05-12")).toEqual(["2026-05-12"]);
});

test("daysBetween: end < start → empty", () => {
  expect(daysBetween("2026-05-12", "2026-05-10")).toEqual([]);
});

test("todayLocal: returns YYYY-MM-DD shape", () => {
  expect(todayLocal()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("yesterdayLocal: one day before todayLocal", () => {
  expect(shiftDate(yesterdayLocal(), 1)).toBe(todayLocal());
});
