/**
 * source-check.test.ts — the pre-hold source check (SourceCheck.ts): calendar
 * id from a public ICS feed URL, the organizer link from a description, and
 * found / gone / failed-read verdicts with a fake calendar reader.
 */
import { test, expect } from "bun:test";
import type { CalendarEvent } from "../Tools/CalendarApi.ts";
import type { RankedEvent } from "../Tools/Ranker.ts";
import { checkCalendarSources, ordinalConflict, organizerLink, publicCalendarId } from "../Tools/SourceCheck.ts";

const CAL = "abc123@group.calendar.google.com";
const ICS = `https://calendar.google.com/calendar/ical/${encodeURIComponent(CAL)}/public/basic.ics`;
const MIN = "2026-11-14T08:00:00.000Z"; // Sat 00:00 PST
const MAX = "2026-11-16T08:00:00.000Z"; // Mon 00:00 PST

function ev(id: string, title: string, start: string, url = ICS): RankedEvent {
  return {
    id,
    title,
    startDatetime: start,
    allDay: false,
    category: "community",
    tags: [],
    isFree: true,
    sourceUrl: url,
    sources: [{ sourceId: "daylight-sd", url }],
    fetchedAt: "2026-11-12T22:00:00Z",
    status: "scheduled",
    score: 70,
    why: "a group",
  };
}

function live(summary: string, start: string, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: summary,
    summary,
    start: { dateTime: start },
    end: { dateTime: start },
    htmlLink: `https://www.google.com/calendar/event?eid=${encodeURIComponent(summary)}`,
    ...extra,
  };
}

test("publicCalendarId decodes the id of a public Google Calendar feed; other URLs give null", () => {
  expect(publicCalendarId(ICS)).toBe(CAL);
  expect(publicCalendarId("https://example.com/events")).toBeNull();
  expect(publicCalendarId(undefined)).toBeNull();
});

test("organizerLink unwraps Google's redirect, drops tracking parameters and skips Google pages", () => {
  const html =
    '<a href="https://www.google.com/calendar/event?eid=x">cal</a> ' +
    '<a href="https://www.google.com/url?q=https://www.instagram.com/p/Dbl/?igsh%3DNTc&amp;sa=D">IG</a>';
  expect(organizerLink(html)).toBe("https://www.instagram.com/p/Dbl/");
  expect(organizerLink('<a href="https://www.codepink.org/sdvigil?ref=daylight&amp;utm_source=x">x</a>')).toBe(
    "https://www.codepink.org/sdvigil?ref=daylight",
  );
  expect(organizerLink("Details at https://luma.com/repair?fbclid=abc then")).toBe("https://luma.com/repair");
  expect(organizerLink('<a href="mailto:a@b.org">mail</a>')).toBeNull();
  expect(organizerLink(undefined)).toBeNull();
});

test("found: the event's own page and organizer; gone: the event left the source; other sources are not read", async () => {
  const reads: string[] = [];
  const out = await checkCalendarSources(
    [
      ev("a", "Peace Vigil for Palestine", "2026-11-14T10:00:00-08:00"),
      ev("b", "Learn to Solder Workshop", "2026-11-15T13:00:00-08:00"),
      ev("c", "Salsa Night", "2026-11-14T20:30:00-08:00", "https://www.tangodelrey.com/weekly-events"),
      ev("d", "Next Week Vigil", "2026-11-21T10:00:00-08:00"),
    ],
    MIN,
    MAX,
    async (calendarId) => {
      reads.push(calendarId);
      return [
        live("Peace Vigil for Palestine", "2026-11-14T18:00:00Z", { description: '<a href="https://www.codepink.org/sdvigil">x</a>' }),
        // Same title, other time: the workshop moved, so it is gone at 13:00.
        live("Learn to Solder Workshop", "2026-11-15T22:00:00Z"),
      ];
    },
  );
  expect(reads).toEqual([CAL]);
  expect(out.checked).toBe(2);
  expect(out.gone).toBe(1);
  expect(out.verdicts.get("a")).toEqual({
    status: "found",
    link: "https://www.google.com/calendar/event?eid=Peace%20Vigil%20for%20Palestine",
    organizer: "https://www.codepink.org/sdvigil",
  });
  expect(out.verdicts.get("b")).toEqual({ status: "gone", calendarId: CAL });
  expect(out.verdicts.has("c")).toBe(false);
  expect(out.verdicts.has("d")).toBe(false);
});

test("a cancelled instance counts as gone; a failed read gives no verdict and an error", async () => {
  const cancelled = await checkCalendarSources([ev("a", "Vigil", "2026-11-14T10:00:00-08:00")], MIN, MAX, async () => [
    live("Vigil", "2026-11-14T18:00:00Z", { status: "cancelled" }),
  ]);
  expect(cancelled.verdicts.get("a")?.status).toBe("gone");

  const failed = await checkCalendarSources([ev("a", "Vigil", "2026-11-14T10:00:00-08:00")], MIN, MAX, async () => {
    throw new Error("socket closed");
  });
  expect(failed.verdicts.size).toBe(0);
  expect(failed.checked).toBe(0);
  expect(failed.errors).toEqual([`${CAL}: socket closed`]);
});

test("an exact title wins over a contained title at the same start (review fix)", async () => {
  const out = await checkCalendarSources([ev("a", "Yoga", "2026-11-14T10:00:00-08:00")], MIN, MAX, async () => [
    live("Yoga Flow", "2026-11-14T18:00:00Z"),
    live("Yoga", "2026-11-14T18:00:00Z"),
  ]);
  expect(out.verdicts.get("a")).toMatchObject({ status: "found", link: "https://www.google.com/calendar/event?eid=Yoga" });
});

test("ordinalConflict: a 'second Sunday' text on a third Sunday is doubtful; a fitting or weekly text is not", () => {
  const text = "Zero Waste San Diego is hosting a hands-on soldering workshop on the <i>second Sunday</i> of the month.";
  expect(ordinalConflict(text, "2026-11-15T13:00:00-08:00")).toBe("second Sunday"); // Nov 15 = 3rd Sunday
  expect(ordinalConflict(text, "2026-12-13T13:00:00-08:00")).toBeNull(); // Dec 13 = 2nd Sunday
  expect(ordinalConflict("first and third Saturdays", "2026-11-21T10:00:00-08:00")).toBeNull(); // 3rd Saturday
  expect(ordinalConflict("first and third Saturdays", "2026-11-14T10:00:00-08:00")).toBe("first and third Saturdays");
  expect(ordinalConflict("the last Friday of the month", "2026-11-27T19:00:00-08:00")).toBeNull(); // Nov 27 = last Friday
  expect(ordinalConflict("Every Saturday; on the first Saturday a potluck", "2026-11-14T10:00:00-08:00")).toBeNull();
  expect(ordinalConflict("A friendly weekly game night", "2026-11-14T19:00:00-08:00")).toBeNull();
  expect(ordinalConflict(undefined, "2026-11-14T19:00:00-08:00")).toBeNull();
});

test("a calendar event whose own text names another date rule is doubtful (no hold)", async () => {
  const out = await checkCalendarSources([ev("b", "Learn to Solder Workshop", "2026-11-15T13:00:00-08:00")], MIN, MAX, async () => [
    live("Learn to Solder Workshop", "2026-11-15T21:00:00Z", { description: "a workshop on the second Sunday of the month" }),
  ]);
  expect(out.verdicts.get("b")).toEqual({ status: "doubtful", calendarId: CAL, phrase: "second Sunday" });
  expect(out.doubtful).toBe(1);
  expect(out.gone).toBe(0);
});
