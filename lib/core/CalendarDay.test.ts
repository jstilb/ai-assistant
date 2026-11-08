import { describe, expect, test } from "bun:test";
import { addDays, daysBetween, isValidDay, todayISO } from "./CalendarDay.ts";

describe("CalendarDay", () => {
  test("todayISO is a valid local day", () => {
    expect(isValidDay(todayISO())).toBe(true);
  });

  test("daysBetween counts whole days across DST and month ends", () => {
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
    expect(daysBetween("2026-11-02", "2026-10-31")).toBe(-2);
  });

  test("addDays rolls months and years", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  test("isValidDay rejects malformed and impossible dates", () => {
    expect(isValidDay("2026-02-29")).toBe(false);
    expect(isValidDay("2028-02-29")).toBe(true);
    expect(isValidDay("2026-1-05")).toBe(false);
  });
});
