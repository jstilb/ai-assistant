/**
 * weekend-holds.test.ts — the Thursday plan (WeekendHolds.ts) with a fake
 * calendar client: pick rules, the calendar entry shape, return visits, one
 * placement per weekend, the quiet rule, dry run, and kept/dropped status.
 */

import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CalendarClient, CalendarEvent, NewCalendarEvent } from "../Tools/CalendarApi.ts";
import type { RankedEvent } from "../Tools/Ranker.ts";
import {
  buildHoldEvent,
  eventLink,
  HOLD_PREFIX,
  readLedger,
  returnVisitEvidence,
  runWeekendHolds,
  selectHolds,
} from "../Tools/WeekendHolds.ts";
import { defined } from "../../../../lib/test/defined.ts";

// Weekend of Sat 2026-11-14 / Sun 2026-11-15 (PST, UTC-8). Run on Thu 11-12.
const SAT = "2026-11-14";
const SUN = "2026-11-15";
const NOW = new Date("2026-11-13T00:30:00Z"); // Thu 16:30 PST

function ranked(overrides: Partial<RankedEvent> & { id: string; startDatetime: string }): RankedEvent {
  return {
    title: `Event ${overrides.id}`,
    allDay: false,
    category: "community",
    tags: [],
    isFree: true,
    sourceUrl: "https://example.com/list",
    sources: [{ sourceId: "test", url: `https://example.com/e/${overrides.id}` }],
    fetchedAt: "2026-11-12T22:00:00Z",
    status: "scheduled",
    score: 80,
    why: "a recurring social group",
    ...overrides,
  };
}

function calEvent(id: string, start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id, summary: id, start: { dateTime: start }, end: { dateTime: end }, ...extra };
}

class FakeCalendar implements CalendarClient {
  inserted: NewCalendarEvent[] = [];
  existing: CalendarEvent[] = [];
  past: CalendarEvent[] = [];
  deleted = new Set<string>();
  async listEvents(q: { timeMin: string; timeMax: string }): Promise<CalendarEvent[]> {
    const pool = Date.parse(q.timeMax) <= NOW.getTime() ? this.past : this.existing;
    return pool.filter((e) => {
      const s = Date.parse(e.start.dateTime ?? `${e.start.date}T00:00:00Z`);
      return s >= Date.parse(q.timeMin) && s < Date.parse(q.timeMax);
    });
  }
  async insertEvent(event: NewCalendarEvent): Promise<CalendarEvent> {
    this.inserted.push(event);
    const created = { ...event, id: `cal-${this.inserted.length}` };
    this.existing.push(created);
    return created;
  }
  async getEvent(id: string): Promise<CalendarEvent | null> {
    if (this.deleted.has(id)) return null;
    return this.existing.find((e) => e.id === id) ?? null;
  }
}

function tempLedger(): { path: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "es-holds-"));
  return { path: join(dir, "holds-ledger.json"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

// ============================================================================
// selectHolds
// ============================================================================

test("selectHolds keeps only timed, scheduled, strong, short, daytime picks", () => {
  const picks = selectHolds(
    [
      ranked({ id: "allday", startDatetime: `${SAT}T00:00:00-08:00`, allDay: true }),
      ranked({ id: "notime", startDatetime: `${SAT}T00:00:00-08:00`, startTimeKnown: false }),
      ranked({ id: "weak", startDatetime: `${SAT}T18:00:00-08:00`, score: 20 }),
      ranked({ id: "long", startDatetime: `${SAT}T10:00:00-08:00`, endDatetime: `${SAT}T20:00:00-08:00` }),
      ranked({ id: "early", startDatetime: `${SAT}T07:00:00-08:00` }),
      ranked({ id: "postponed", startDatetime: `${SAT}T18:00:00-08:00`, status: "postponed" }),
      ranked({ id: "friday", startDatetime: "2026-11-13T20:30:00-08:00", endDatetime: `${SAT}T01:00:00-08:00` }),
      ranked({ id: "good", startDatetime: `${SAT}T19:00:00-08:00` }),
    ],
    [],
    [SAT, SUN],
  );
  expect(picks.map((p) => p.id)).toEqual(["good"]);
});

test("selectHolds takes one pick per venue", () => {
  const picks = selectHolds(
    [
      ranked({ id: "club-sat", startDatetime: `${SAT}T20:30:00-08:00`, venue: "Tango Del Rey" }),
      ranked({ id: "club-sun", startDatetime: `${SUN}T20:30:00-08:00`, venue: "tango del rey" }),
      ranked({ id: "other", startDatetime: `${SUN}T10:00:00-08:00`, venue: "Sunset Cliffs" }),
    ],
    [],
    [SAT, SUN],
  );
  expect(picks.map((p) => p.id)).toEqual(["club-sat", "other"]);
});

test("eventLink turns a public Google Calendar ICS feed into its web view", () => {
  const feed = "https://calendar.google.com/calendar/ical/abc123%40group.calendar.google.com/public/basic.ics";
  const e = ranked({ id: "ics", startDatetime: `${SAT}T10:00:00-08:00`, sources: [{ sourceId: "x", url: feed }], sourceUrl: feed });
  expect(eventLink(e)).toBe("https://calendar.google.com/calendar/embed?src=abc123%40group.calendar.google.com&ctz=America%2FLos_Angeles");
  expect(eventLink(ranked({ id: "web", startDatetime: `${SAT}T10:00:00-08:00` }))).toBe("https://example.com/e/web");
});

test("eventLink prefers a specific event URL over a find page, and gives null when none exists", () => {
  const find = "https://www.meetup.com/find/us--ca--san-diego/";
  const base = { startDatetime: `${SUN}T15:00:00-08:00`, sources: [{ sourceId: "meetup-sd", url: find }], sourceUrl: find };
  expect(eventLink(ranked({ id: "m1", ...base, ticketUrl: "https://www.meetup.com/sd-volley/events/123/" }))).toBe(
    "https://www.meetup.com/sd-volley/events/123/",
  );
  expect(eventLink(ranked({ id: "m2", ...base, ticketUrl: "https://eventbrite.com" }))).toBeNull();
  expect(selectHolds([ranked({ id: "m3", ...base })], [], [SAT, SUN])).toHaveLength(0);
});

test("buildHoldEvent: no bare-domain ticket line, a repeating-listing note, and a clean place line", () => {
  const e = ranked({
    id: "tdr",
    title: "Salsa / Bachata (Saturdays)",
    startDatetime: `${SAT}T20:30:00-08:00`,
    endDatetime: `${SUN}T01:00:00-08:00`,
    ticketUrl: "https://eventbrite.com",
    venue: "Coronado Beach",
    address: "Coronado Beach, Coronado, CA 92118, USA, Coronado, CA",
  });
  const d = defined(buildHoldEvent(e, SAT, null, NOW).description);
  expect(d).not.toContain("Tickets:");
  expect(d).toContain("Repeating listing:");
  expect(d).toContain("Where: Coronado Beach, Coronado, CA 92118\n");
  expect(defined(buildHoldEvent(ranked({ id: "one", startDatetime: `${SAT}T10:00:00-08:00` }), SAT, null, NOW).description)).not.toContain(
    "Repeating listing:",
  );
});

test("selectHolds avoids Jm's calendar, other picks, repeats, and a third pick on one day", () => {
  const busy = [{ startMs: Date.parse(`${SAT}T12:00:00-08:00`), endMs: Date.parse(`${SAT}T13:00:00-08:00`) }];
  const picks = selectHolds(
    [
      ranked({ id: "clash-cal", startDatetime: `${SAT}T13:15:00-08:00` }), // within the 30 min buffer
      ranked({ id: "sat-a", startDatetime: `${SAT}T10:00:00-08:00`, endDatetime: `${SAT}T11:00:00-08:00` }),
      ranked({ id: "sat-b", startDatetime: `${SAT}T18:00:00-08:00` }),
      ranked({ id: "sat-c", startDatetime: `${SAT}T21:00:00-08:00` }), // third on Saturday
      ranked({ id: "clash-pick", startDatetime: `${SAT}T19:00:00-08:00` }),
      ranked({ id: "repeat", title: "Event sat-a", startDatetime: `${SUN}T10:00:00-08:00` }),
      ranked({ id: "sun-a", startDatetime: `${SUN}T15:00:00-08:00` }),
      ranked({ id: "sun-b", startDatetime: `${SUN}T19:00:00-08:00` }), // over the max of 3
    ],
    busy,
    [SAT, SUN],
  );
  expect(picks.map((p) => p.id)).toEqual(["sat-a", "sat-b", "sun-a"]);
});

// ============================================================================
// buildHoldEvent
// ============================================================================

test("buildHoldEvent: tentative, free, silent, tagged, with the source facts", () => {
  const e = ranked({
    id: "e1",
    title: "Open Mic",
    startDatetime: `${SAT}T19:00:00-08:00`,
    isFree: false,
    priceMin: 10,
    priceMax: 15,
    venue: "The Holding Company",
    address: "5046 Newport Ave, San Diego",
  });
  const body = buildHoldEvent(e, SAT, "calendar 2026-10-03", NOW);
  expect(body.summary).toBe(`${HOLD_PREFIX}Open Mic`);
  expect(body.status).toBe("tentative");
  expect(body.transparency).toBe("transparent");
  expect(body.reminders).toEqual({ useDefault: false, overrides: [] });
  expect(body.extendedProperties?.private).toEqual({ eventscoutHold: "1", eventscoutWeekend: SAT, eventscoutEventId: "e1" });
  expect(body.start.dateTime).toBe("2026-11-15T03:00:00.000Z");
  expect(body.end.dateTime).toBe("2026-11-15T05:00:00.000Z");
  const d = defined(body.description);
  expect(d).toContain("Source: https://example.com/e/e1");
  expect(d).toContain("Price: $10–$15");
  expect(d).toContain("end time not listed");
  expect(d).toContain("Return visit: this place is in your history (calendar 2026-10-03).");
  expect(d).toContain(
    'After you go: how was it, and anyone you want to see again? Tell Kaya in one line with a rating, for example "Open Mic on Nov 14, 8/10, met two people I\'d see again". It goes to your activity log.',
  );
  expect(d).toContain("To drop it, delete this event.");
  expect(body.location).toBe("The Holding Company, 5046 Newport Ave, San Diego");
});

// ============================================================================
// returnVisitEvidence
// ============================================================================

test("returnVisitEvidence matches a venue in history as whole words only", () => {
  const history = [
    { text: "Trivia at Pizza Port OB", source: "calendar" as const, date: "2026-10-01" },
    { text: "beach walk", source: "activity_log" as const, date: "2026-05-02" },
  ];
  const at = (venue: string) => ranked({ id: venue, startDatetime: `${SAT}T19:00:00-08:00`, venue });
  expect(returnVisitEvidence(at("Pizza Port"), history)).toBe("calendar 2026-10-01");
  expect(returnVisitEvidence(at("San Diego"), history)).toBeNull();
  expect(returnVisitEvidence(at("Port"), history)).toBeNull();
  expect(returnVisitEvidence(at("Pizza Portal"), history)).toBeNull();
});

// ============================================================================
// runWeekendHolds
// ============================================================================

const PICKS = [
  ranked({ id: "a", startDatetime: `${SAT}T10:00:00-08:00` }),
  ranked({ id: "b", startDatetime: `${SAT}T18:00:00-08:00` }),
  ranked({ id: "c", startDatetime: `${SUN}T15:00:00-08:00` }),
  ranked({ id: "d", startDatetime: `${SUN}T19:00:00-08:00` }),
];

test("places at most 3 holds once per weekend and records them", async () => {
  const { path, done } = tempLedger();
  try {
    const cal = new FakeCalendar();
    const first = await runWeekendHolds(PICKS, SAT, SUN, { client: cal, now: NOW, history: [], path });
    expect(first.placed).toBe(3);
    expect(cal.inserted).toHaveLength(3);
    const ledger = readLedger(path);
    expect(ledger.entries.map((e) => e.status)).toEqual(["placed", "placed", "placed"]);
    expect(ledger.runs).toHaveLength(1);

    const again = await runWeekendHolds(PICKS, SAT, SUN, { client: cal, now: NOW, history: [], path });
    expect(again.placed).toBe(0);
    expect(again.reason).toContain("already planned");
    expect(cal.inserted).toHaveLength(3);
  } finally {
    done();
  }
});

test("dry run writes nothing", async () => {
  const { path, done } = tempLedger();
  try {
    const cal = new FakeCalendar();
    const out = await runWeekendHolds(PICKS, SAT, SUN, { client: cal, now: NOW, history: [], path, dryRun: true });
    expect(out.picks).toHaveLength(3);
    expect(out.placed).toBe(0);
    expect(cal.inserted).toHaveLength(0);
    expect(existsSync(path)).toBe(false);
  } finally {
    done();
  }
});

test("a full weekend stays quiet", async () => {
  const { path, done } = tempLedger();
  try {
    const cal = new FakeCalendar();
    cal.existing = [
      calEvent("x1", `${SAT}T11:00:00-08:00`, `${SAT}T12:00:00-08:00`),
      calEvent("x2", `${SAT}T20:00:00-08:00`, `${SAT}T22:00:00-08:00`),
      calEvent("x3", `${SUN}T13:00:00-08:00`, `${SUN}T14:00:00-08:00`),
    ];
    const out = await runWeekendHolds(PICKS, SAT, SUN, { client: cal, now: NOW, history: [], path });
    expect(out.placed).toBe(0);
    expect(out.reason).toContain("weekend already full");
    expect(cal.inserted).toHaveLength(0);
  } finally {
    done();
  }
});

test("a failed status check of an old hold does not stop this weekend's holds", async () => {
  const { path, done } = tempLedger();
  try {
    const cal = new FakeCalendar();
    await runWeekendHolds(PICKS, SAT, SUN, { client: cal, now: NOW, history: [], path });
    cal.getEvent = async () => {
      throw new Error("HTTP 503");
    };
    const next = await runWeekendHolds(
      PICKS.map((p) => ({ ...p, startDatetime: p.startDatetime.replace("2026-11-14", "2026-11-21").replace("2026-11-15", "2026-11-22") })),
      "2026-11-21",
      "2026-11-22",
      { client: cal, now: new Date("2026-11-20T00:30:00Z"), history: [], path },
    );
    expect(next.placed).toBe(3);
    expect(next.reconciled).toEqual({ kept: 0, dropped: 0 });
    expect(readLedger(path).entries.slice(0, 3).map((e) => e.status)).toEqual(["placed", "placed", "placed"]);
  } finally {
    done();
  }
});

test("past holds become kept or dropped on the next run", async () => {
  const { path, done } = tempLedger();
  try {
    const cal = new FakeCalendar();
    await runWeekendHolds(PICKS, SAT, SUN, { client: cal, now: NOW, history: [], path });
    cal.deleted.add("cal-2");
    const nextThursday = new Date("2026-11-20T00:30:00Z");
    const out = await runWeekendHolds([], "2026-11-21", "2026-11-22", { client: cal, now: nextThursday, history: [], path });
    expect(out.reconciled).toEqual({ kept: 2, dropped: 1 });
    expect(readLedger(path).entries.map((e) => e.status)).toEqual(["kept", "dropped", "kept"]);
  } finally {
    done();
  }
});

// ============================================================================
// G2: recurring communities first
// ============================================================================

// One-offs with high scores, a weekly salsa social (community) with a lower
// score, and a weekly improv show (recurring, but judged not a community).
const ONE_OFFS = [
  ranked({ id: "o1", title: "Big Concert", venue: "Arena", score: 95, startDatetime: `${SAT}T19:00:00-08:00` }),
  ranked({ id: "o2", title: "Food Fest", venue: "Park", score: 92, startDatetime: `${SAT}T11:00:00-08:00` }),
  ranked({ id: "o3", title: "Gallery Talk", venue: "Museum", score: 90, startDatetime: `${SUN}T18:00:00-08:00` }),
];
const SALSA = ranked({ id: "s1", title: "Salsa Social", venue: "Tango Del Rey", score: 55, startDatetime: `${SUN}T13:00:00-08:00` });
const IMPROV = ranked({ id: "i1", title: "Improv Show", venue: "Improv Club", score: 85, startDatetime: `${SUN}T20:30:00-08:00` });
const WEAK = ranked({ id: "w1", title: "Kids Lego Club", venue: "Library", score: 20, startDatetime: `${SAT}T15:00:00-08:00` });
const G2_RANKED = [...ONE_OFFS, IMPROV, SALSA, WEAK];
const G2_CACHE = [
  ...G2_RANKED,
  { ...SALSA, id: "s2", startDatetime: "2026-11-22T13:00:00-08:00" },
  { ...SALSA, id: "s3", startDatetime: "2026-11-29T13:00:00-08:00" },
  { ...IMPROV, id: "i2", startDatetime: "2026-11-22T20:30:00-08:00" },
  { ...WEAK, id: "w2", startDatetime: "2026-11-21T15:00:00-08:00" },
];

test("a recurring community comes before higher-scored one-offs; its hold says how often it meets", async () => {
  const { path, done } = tempLedger();
  try {
    const cal = new FakeCalendar();
    const asked: string[] = [];
    const out = await runWeekendHolds(G2_RANKED, SAT, SUN, {
      client: cal,
      now: NOW,
      history: [],
      path,
      community: {
        loadCache: () => G2_CACHE,
        classify: async (candidates) => {
          asked.push(...candidates.map((c) => c.title));
          return new Map(candidates.map((c) => [c.key, { community: c.title === "Salsa Social", kind: "k" }]));
        },
      },
    });
    // Only eligible recurring series go to the classifier (the score-20 kids club does not).
    expect(asked.sort()).toEqual(["Improv Show", "Salsa Social"]);
    expect(out.communityCheck).toMatchObject({ candidates: 2, communities: 1 });
    expect(out.picks.map((p) => p.title)).toEqual(["Salsa Social", "Big Concert", "Food Fest"]);
    expect(defined(out.picks[0]).community).toBe("meets weekly on Sundays (EventScout found it on 3 dates, Nov 15 – Nov 29)");
    expect(defined(out.picks[1]).community).toBeNull();
    const salsaHold = defined(cal.inserted[0]);
    expect(salsaHold.description).toContain(
      "Recurring group: meets weekly on Sundays (EventScout found it on 3 dates, Nov 15 – Nov 29). Going again is how you become a regular.",
    );
    expect(defined(cal.inserted[1]).description).not.toContain("Recurring group");
    const entries = readLedger(path).entries;
    expect(entries.map((e) => e.community)).toEqual([true, false, false]);
    expect(defined(entries[0]).seriesKey).toBe("salsa social|tango del rey");
  } finally {
    done();
  }
});

test("a failed community check still places holds in score order and reports the error", async () => {
  const { path, done } = tempLedger();
  try {
    const cal = new FakeCalendar();
    const out = await runWeekendHolds(G2_RANKED, SAT, SUN, {
      client: cal,
      now: NOW,
      history: [],
      path,
      community: {
        loadCache: () => G2_CACHE,
        classify: async () => {
          throw new Error("community check LLM call failed: timeout");
        },
      },
    });
    expect(out.communityError).toContain("timeout");
    expect(out.placed).toBe(3);
    expect(out.picks.map((p) => p.title)).toEqual(["Big Concert", "Food Fest", "Gallery Talk"]);
    expect(out.picks.every((p) => p.community === null)).toBe(true);
  } finally {
    done();
  }
});

test("an unreadable cache degrades to score order instead of costing the holds", async () => {
  const { path, done } = tempLedger();
  try {
    const cal = new FakeCalendar();
    let classified = false;
    const out = await runWeekendHolds(G2_RANKED, SAT, SUN, {
      client: cal,
      now: NOW,
      history: [],
      path,
      community: {
        loadCache: () => {
          throw new Error("cache JSON is corrupt");
        },
        classify: async () => {
          classified = true;
          return new Map();
        },
      },
    });
    expect(out.communityError).toContain("corrupt");
    expect(classified).toBe(false);
    expect(out.placed).toBe(3);
  } finally {
    done();
  }
});

// ============================================================================
// Pre-hold source check (review 1, 2026-11-08)
// ============================================================================

const FEED = "https://calendar.google.com/calendar/ical/abc123%40group.calendar.google.com/public/basic.ics";
const fromFeed = (id: string, title: string, start: string, score: number): RankedEvent =>
  ranked({ id, title, startDatetime: start, score, venue: `Hall ${id}`, sourceUrl: FEED, sources: [{ sourceId: "daylight-sd", url: FEED }] });

test("source check: a found event links to its own page with the organizer; a gone event is replaced by the next", async () => {
  const { path, done } = tempLedger();
  try {
    const cal = new FakeCalendar();
    const out = await runWeekendHolds(
      [
        fromFeed("v", "Weekly Vigil (Saturdays)", `${SAT}T10:00:00-08:00`, 90),
        fromFeed("g", "Repair Workshop", `${SUN}T13:00:00-08:00`, 85),
        ranked({ id: "x", title: "Other Show", startDatetime: `${SUN}T18:00:00-08:00`, score: 60 }),
      ],
      SAT,
      SUN,
      {
        client: cal,
        now: NOW,
        history: [],
        path,
        sourceCheck: {
          list: async () => [
            {
              id: "pub-v",
              summary: "Weekly Vigil (Saturdays)",
              start: { dateTime: "2026-11-14T18:00:00Z" },
              end: { dateTime: "2026-11-14T19:00:00Z" },
              htmlLink: "https://www.google.com/calendar/event?eid=VIGIL",
              description: '<a href="https://www.google.com/url?q=https://org.example/vigil&amp;sa=D">site</a>',
            },
          ],
        },
      },
    );
    expect(out.sourceCheck).toEqual({ checked: 2, gone: 1, doubtful: 0, skipped: ["Repair Workshop (gone from the source)"] });
    expect(out.sourceCheckError).toBeUndefined();
    expect(out.picks.map((p) => p.title)).toEqual(["Weekly Vigil (Saturdays)", "Other Show"]);
    expect(defined(out.picks[0]).link).toBe("https://www.google.com/calendar/event?eid=VIGIL");
    expect(defined(out.picks[0]).sourceCheck).toBe("on source; organizer https://org.example/vigil");
    expect(defined(out.picks[1]).sourceCheck).toBeNull();
    const vigil = defined(cal.inserted[0]);
    expect(vigil.source?.url).toBe("https://www.google.com/calendar/event?eid=VIGIL");
    expect(vigil.description).toContain("Source: https://www.google.com/calendar/event?eid=VIGIL");
    expect(vigil.description).toContain("Organizer page: https://org.example/vigil");
    expect(vigil.description).toContain("Checked on the source: Thu, Nov 12 at 4:30 PM (this date and time are on it).");
    // The source confirmed this exact date, so no "pattern, not this exact date" warning.
    expect(vigil.description).not.toContain("Repeating listing");
    expect(readLedger(path).entries.map((e) => e.sourceUrl)).toEqual([
      "https://www.google.com/calendar/event?eid=VIGIL",
      "https://example.com/e/x",
    ]);
  } finally {
    done();
  }
});

test("source check: a failed calendar read keeps the picks with the calendar-view link and reports the error", async () => {
  const { path, done } = tempLedger();
  try {
    const cal = new FakeCalendar();
    const out = await runWeekendHolds([fromFeed("v", "Weekly Vigil", `${SAT}T10:00:00-08:00`, 90)], SAT, SUN, {
      client: cal,
      now: NOW,
      history: [],
      path,
      sourceCheck: {
        list: async () => {
          throw new Error("socket closed");
        },
      },
    });
    expect(out.sourceCheckError).toBe("abc123@group.calendar.google.com: socket closed");
    expect(out.placed).toBe(1);
    expect(defined(out.picks[0]).link).toBe(
      "https://calendar.google.com/calendar/embed?src=abc123%40group.calendar.google.com&ctz=America%2FLos_Angeles",
    );
    expect(defined(out.picks[0]).sourceCheck).toBeNull();
  } finally {
    done();
  }
});

// ============================================================================
// Weeknight holds (review 1, 2026-11-08)
// ============================================================================

const WK_DAYS = ["2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"];
const RUN_CLUB = ranked({ id: "r1", title: "Tuesday Run Club", venue: "OB Pier", score: 60, startDatetime: "2026-11-17T18:30:00-08:00" });
const TRIVIA = ranked({ id: "t1", title: "Trivia Night", venue: "Pub", score: 75, startDatetime: "2026-11-18T19:00:00-08:00" });
const NOON_YOGA = ranked({ id: "y1", title: "Noon Yoga", venue: "Studio", score: 80, startDatetime: "2026-11-16T12:00:00-08:00" });
const WK_CACHE = [
  ...G2_CACHE,
  RUN_CLUB,
  { ...RUN_CLUB, id: "r2", startDatetime: "2026-11-24T18:30:00-08:00" },
  { ...RUN_CLUB, id: "r3", startDatetime: "2026-12-01T18:30:00-08:00" },
  TRIVIA,
  { ...TRIVIA, id: "t2", startDatetime: "2026-11-25T19:00:00-08:00" },
  NOON_YOGA,
  { ...NOON_YOGA, id: "y2", startDatetime: "2026-11-23T12:00:00-08:00" },
];
const COMMUNITY_TITLES = new Set(["Salsa Social", "Tuesday Run Club", "Noon Yoga"]);

async function runWithWeeknight(cal: FakeCalendar, path: string, wkRanked: RankedEvent[], asked: string[] = []) {
  return runWeekendHolds(G2_RANKED, SAT, SUN, {
    client: cal,
    now: NOW,
    history: [],
    path,
    community: {
      loadCache: () => WK_CACHE,
      classify: async (candidates) => {
        asked.push(...candidates.map((c) => c.title));
        return new Map(candidates.map((c) => [c.key, { community: COMMUNITY_TITLES.has(c.title), kind: "k" }]));
      },
    },
    weeknight: { ranked: wkRanked, days: WK_DAYS },
  });
}

test("weeknight: one evening community hold takes the last slot; one community call covers both", async () => {
  const { path, done } = tempLedger();
  try {
    const cal = new FakeCalendar();
    const asked: string[] = [];
    // Trivia scores higher but is not a community; noon yoga is a community but not an evening.
    const out = await runWithWeeknight(cal, path, [TRIVIA, NOON_YOGA, RUN_CLUB], asked);
    expect(asked.sort()).toEqual(["Improv Show", "Salsa Social", "Trivia Night", "Tuesday Run Club"]);
    expect(out.picks.map((p) => p.title)).toEqual(["Salsa Social", "Big Concert", "Tuesday Run Club"]);
    expect(out.weeknight).toEqual({ candidates: 1, picked: 1, reason: "a weeknight community fits" });
    expect(defined(out.picks[2]).community).toBe("meets weekly on Tuesdays (EventScout found it on 3 dates, Nov 17 – Dec 1)");
    const run = defined(cal.inserted[2]);
    expect(run.summary).toBe(`${HOLD_PREFIX}Tuesday Run Club`);
    expect(run.start.dateTime).toBe("2026-11-18T02:30:00.000Z");
    expect(run.status).toBe("tentative");
    expect(run.extendedProperties?.private?.["eventscoutWeekend"]).toBe(SAT);
    expect(readLedger(path).entries).toHaveLength(3);
  } finally {
    done();
  }
});

test("weeknight: no hold when the evening overlaps Jm's calendar; the weekend keeps 3 picks", async () => {
  const { path, done } = tempLedger();
  try {
    const cal = new FakeCalendar();
    cal.existing.push(calEvent("own-tue", "2026-11-18T02:00:00Z", "2026-11-18T04:00:00Z"));
    const out = await runWithWeeknight(cal, path, [RUN_CLUB]);
    expect(out.weeknight).toEqual({ candidates: 1, picked: 0, reason: "no weeknight community passed the rules" });
    expect(out.picks.map((p) => p.title)).toEqual(["Salsa Social", "Big Concert", "Food Fest"]);
  } finally {
    done();
  }
});

test("weeknight: never the same group or place as a weekend pick that stays", async () => {
  const { path, done } = tempLedger();
  try {
    const cal = new FakeCalendar();
    const tuesdaySalsa = { ...SALSA, id: "s9", startDatetime: "2026-11-17T19:00:00-08:00" };
    const out = await runWithWeeknight(cal, path, [tuesdaySalsa]);
    expect(out.weeknight?.candidates).toBe(0);
    expect(out.picks.map((p) => p.title)).toEqual(["Salsa Social", "Big Concert", "Food Fest"]);
  } finally {
    done();
  }
});

test("weeknight: a failed community check gives no weeknight hold and says why", async () => {
  const { path, done } = tempLedger();
  try {
    const cal = new FakeCalendar();
    const out = await runWeekendHolds(G2_RANKED, SAT, SUN, {
      client: cal,
      now: NOW,
      history: [],
      path,
      community: {
        loadCache: () => WK_CACHE,
        classify: async () => {
          throw new Error("timeout");
        },
      },
      weeknight: { ranked: [RUN_CLUB], days: WK_DAYS },
    });
    expect(out.communityError).toBe("timeout");
    expect(out.weeknight).toEqual({
      candidates: 0,
      picked: 0,
      reason: "no weeknight hold: community check failed (weeknight holds are communities only)",
    });
    expect(out.picks).toHaveLength(3);
    expect(out.picks.map((p) => p.title)).not.toContain("Tuesday Run Club");
  } finally {
    done();
  }
});
