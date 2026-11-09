#!/usr/bin/env bun
/**
 * ics.test.ts — Slice 4 TDD unit tests for ICSAdapter.
 *
 * Tests the PURE exports of ICSAdapter:
 *   - mapVeventToItem(): mapping correctness (title, startDatetime, venue, etc.)
 *   - isFutureWithin(): window filter predicate
 *
 * NO network calls. All fixtures are inline.
 *
 * Run:
 *   bun test skills/Productivity/EventScout/tests/ics.test.ts
 */

import { test, expect, setSystemTime } from "bun:test";
import ical from "node-ical";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mapVeventToItem,
  isFutureWithin,
  expandHorizonDays,
  fetchICSEvents,
  MAX_EVENTS_SAFETY,
} from "../Tools/adapters/ICSAdapter.ts";
import { SecretError } from "../../../../lib/core/Secrets.ts";
import type { VeventOccurrence } from "../Tools/adapters/ICSAdapter.ts";
import type { EventSource } from "../Tools/types.ts";
import { defined } from "../../../../lib/test/defined.ts";

// ============================================================================
// Test harness
//
// NOTE: assert() now throws on failure (converted from a non-throwing
// log+counter pattern) so a failing condition actually fails the enclosing
// bun `test()` block instead of only being tallied at the end.
// ============================================================================

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// ============================================================================
// Fixtures
// ============================================================================

const TEST_SOURCE: EventSource = {
  id: "daylight-sd",
  url: "https://calendar.google.com/calendar/ical/example.ics",
  name: "Daylight San Diego",
  fetchTier: "ics",
  categoryHint: "community",
  pollInterval: 720,
  enabled: true,
};

const TEST_SOURCE_NO_HINT: EventSource = {
  id: "daylight-sd-nohint",
  url: "https://calendar.google.com/calendar/ical/example2.ics",
  name: "Daylight SD No Hint",
  fetchTier: "ics",
  pollInterval: 720,
  enabled: true,
};

/** Fixture 1: full occurrence with location and url */
const OCC_FULL: VeventOccurrence = {
  uid: "x",
  summary: "Neighborhood Cleanup Day",
  start: new Date("2026-07-01T22:00:00Z"),
  end: new Date("2026-07-02T01:00:00Z"),
  location: "Market Creek Plaza, San Diego",
  url: "https://daylightsandiego.org/e/x",
};

/** Fixture 2: occurrence with no location and no url */
const OCC_MINIMAL: VeventOccurrence = {
  uid: "y",
  summary: "Community Town Hall",
  start: new Date("2026-07-15T19:00:00Z"),
  end: new Date("2026-07-15T21:00:00Z"),
};

// ============================================================================
// Tests — mapVeventToItem
// ============================================================================

console.log("\nEventScout ICS Adapter — Slice 4 Unit Tests\n");
console.log("--- mapVeventToItem ---\n");

test("1. title === summary (trimmed)", async () => {
  const item = mapVeventToItem(OCC_FULL, TEST_SOURCE);
  assert(item.title === "Neighborhood Cleanup Day", `title: expected "Neighborhood Cleanup Day", got "${item.title}"`);
});

test("2. startDatetime contains correct LA date (July → PDT = -07:00)", async () => {
  const item = mapVeventToItem(OCC_FULL, TEST_SOURCE);
  // 2026-07-01T22:00:00Z → PDT (-07:00) → 2026-07-01T15:00:00-07:00
  const dt = item.startDatetime;
  assert(!dt.endsWith("Z"), `startDatetime should have explicit offset, not Z: "${dt}"`);

  const offsetMatch = dt.match(/([+-]\d{2}):(\d{2})$/);
  assert(offsetMatch !== null, `startDatetime missing UTC offset: "${dt}"`);
  const offsetHours = parseInt(defined(defined(offsetMatch)[1]), 10);
  assert(offsetHours === -7, `Expected PDT offset -7, got ${offsetHours} in "${dt}"`);

  const hourMatch = dt.match(/T(\d{2}):\d{2}:\d{2}/);
  assert(hourMatch !== null, `Cannot extract local hour from "${dt}"`);
  const localHour = parseInt(defined(defined(hourMatch)[1]), 10);
  // 22:00 UTC → 15:00 PDT
  assert(localHour === 15, `Expected local hour 15 (15:00 PDT), got ${localHour} in "${dt}"`);
});

test("3. endDatetime is present when end supplied", async () => {
  const item = mapVeventToItem(OCC_FULL, TEST_SOURCE);
  assert(
    typeof item.endDatetime === "string" && item.endDatetime.length > 0,
    `endDatetime should be a non-empty string, got: ${item.endDatetime}`,
  );
});

test("4. venue === location (trimmed)", async () => {
  const item = mapVeventToItem(OCC_FULL, TEST_SOURCE);
  assert(
    item.venue === "Market Creek Plaza, San Diego",
    `venue: expected "Market Creek Plaza, San Diego", got "${item.venue}"`,
  );
});

test("5. ticketUrl === occ.url when present", async () => {
  const item = mapVeventToItem(OCC_FULL, TEST_SOURCE);
  assert(
    item.ticketUrl === "https://daylightsandiego.org/e/x",
    `ticketUrl: expected the occ.url, got "${item.ticketUrl}"`,
  );
});

test("6. category === source.categoryHint when provided", async () => {
  const item = mapVeventToItem(OCC_FULL, TEST_SOURCE);
  assert(item.category === "community", `category: expected "community" from categoryHint, got "${item.category}"`);
});

test("7. category falls back to 'other' when no categoryHint", async () => {
  const item = mapVeventToItem(OCC_FULL, TEST_SOURCE_NO_HINT);
  assert(item.category === "other", `category: expected "other" (no hint), got "${item.category}"`);
});

test("8. id is deterministic and non-empty", async () => {
  const item1 = mapVeventToItem(OCC_FULL, TEST_SOURCE);
  const item2 = mapVeventToItem(OCC_FULL, TEST_SOURCE);
  assert(typeof item1.id === "string" && item1.id.length > 0, `id should be a non-empty string, got: "${item1.id}"`);
  assert(item1.id === item2.id, `id should be deterministic: "${item1.id}" vs "${item2.id}"`);
});

test("9. sourceUrl falls back to source.url when occ.url absent", async () => {
  const item = mapVeventToItem(OCC_MINIMAL, TEST_SOURCE);
  assert(
    item.sourceUrl === TEST_SOURCE.url,
    `sourceUrl should fall back to source.url: expected "${TEST_SOURCE.url}", got "${item.sourceUrl}"`,
  );
});

test("10. venue is undefined when no location", async () => {
  const item = mapVeventToItem(OCC_MINIMAL, TEST_SOURCE);
  assert(item.venue === undefined, `venue should be undefined when no location, got "${item.venue}"`);
});

test("11. ticketUrl is undefined when no occ.url", async () => {
  const item = mapVeventToItem(OCC_MINIMAL, TEST_SOURCE);
  assert(item.ticketUrl === undefined, `ticketUrl should be undefined when no url, got "${item.ticketUrl}"`);
});

test("12. no crash when no location/url (fixture 2 maps cleanly)", async () => {
  let threw = false;
  try {
    mapVeventToItem(OCC_MINIMAL, TEST_SOURCE);
  } catch {
    threw = true;
  }
  assert(!threw, "mapVeventToItem should not throw with no location/url");
});

test("13. allDay === false", async () => {
  const item = mapVeventToItem(OCC_FULL, TEST_SOURCE);
  assert(item.allDay === false, `allDay should be false, got ${item.allDay}`);
});

test("14. isFree === false", async () => {
  const item = mapVeventToItem(OCC_FULL, TEST_SOURCE);
  assert(item.isFree === false, `isFree should be false, got ${item.isFree}`);
});

test("15. tags === []", async () => {
  const item = mapVeventToItem(OCC_FULL, TEST_SOURCE);
  assert(
    Array.isArray(item.tags) && item.tags.length === 0,
    `tags should be empty array, got ${JSON.stringify(item.tags)}`,
  );
});

test("16. status === 'scheduled'", async () => {
  const item = mapVeventToItem(OCC_FULL, TEST_SOURCE);
  assert(item.status === "scheduled", `status should be "scheduled", got "${item.status}"`);
});

test("17. sources[0].sourceId === source.id", async () => {
  const item = mapVeventToItem(OCC_FULL, TEST_SOURCE);
  assert(
    item.sources.length >= 1 && defined(item.sources[0]).sourceId === "daylight-sd",
    `sources[0].sourceId expected "daylight-sd", got "${item.sources[0]?.sourceId}"`,
  );
});

test("18. fetchedAt is a valid ISO timestamp", async () => {
  const item = mapVeventToItem(OCC_FULL, TEST_SOURCE);
  const parsed = new Date(item.fetchedAt);
  assert(!Number.isNaN(parsed.getTime()), `fetchedAt "${item.fetchedAt}" should parse to a valid Date`);
});

// ============================================================================
// Tests — isFutureWithin
// ============================================================================

console.log("\n--- isFutureWithin ---\n");

const NOW = new Date("2026-06-01T00:00:00Z");
const HORIZON = new Date(NOW.getTime() + expandHorizonDays * 24 * 60 * 60 * 1000);

test("19. date strictly before now → false", async () => {
  const past = new Date("2026-05-31T23:59:59Z");
  const result = isFutureWithin(past, NOW, HORIZON);
  assert(!result, `date before now should be false, got ${result}`);
});

test("20. date equal to now → false (strictly after required)", async () => {
  const result = isFutureWithin(NOW, NOW, HORIZON);
  assert(!result, `date === now should be false (strictly after required), got ${result}`);
});

test("21. date 30 days out → true", async () => {
  const thirtyDays = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
  const result = isFutureWithin(thirtyDays, NOW, HORIZON);
  assert(result, `date 30 days out should be true, got ${result}`);
});

test("22. date exactly at horizon → true (inclusive)", async () => {
  const result = isFutureWithin(HORIZON, NOW, HORIZON);
  assert(result, `date at horizon should be true (inclusive), got ${result}`);
});

test("23. date 120 days out (beyond 90) → false", async () => {
  const beyond = new Date(NOW.getTime() + 120 * 24 * 60 * 60 * 1000);
  const result = isFutureWithin(beyond, NOW, HORIZON);
  assert(!result, `date 120 days out should be false (beyond horizon), got ${result}`);
});

test("24. expandHorizonDays === 90", async () => {
  assert(expandHorizonDays === 90, `expandHorizonDays should be 90, got ${expandHorizonDays}`);
});

// ============================================================================
// Slice 6: ICS 300-cap removal tests
//
// These tests verify:
//   - A feed with >300 in-horizon events returns ALL of them (old 300 cap gone)
//   - MAX_EVENTS_SAFETY is exported and is a large value (≥ 1000)
//   - The safety cap (MAX_EVENTS_SAFETY) is still applied as a runaway guard
//
// Strategy: mock globalThis.fetch to return a synthetic ICS feed with 310
// unique in-horizon VEVENT entries. The old MAX_EVENTS=300 would clip to 300.
// The new code must return all 310 (up to MAX_EVENTS_SAFETY).
// ============================================================================

console.log("\n--- Slice 6: fetchICSEvents cap-removal (mocked fetch) ---\n");

/**
 * Build a minimal ICS string with `n` unique in-horizon VEVENT entries.
 * Each event is a distinct non-recurring future event (7 days from now onward).
 * We spread them across many days so dedup doesn't collapse them.
 */
function buildICSFeed(n: number): string {
  const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN"];
  const baseMs = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days from now
  for (let i = 0; i < n; i++) {
    const startMs = baseMs + i * 30 * 60 * 1000; // 30-min increments
    const endMs = startMs + 60 * 60 * 1000; // 1-hour events
    const toIcsDate = (ms: number): string => {
      return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    };
    lines.push(
      "BEGIN:VEVENT",
      `UID:test-event-${i}@ics-test`,
      `DTSTART:${toIcsDate(startMs)}`,
      `DTEND:${toIcsDate(endMs)}`,
      `SUMMARY:Test Event ${i}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

const ICS_TEST_SOURCE: EventSource = {
  id: "daylight-sd",
  url: "https://calendar.google.com/calendar/ical/test.ics",
  name: "Daylight San Diego",
  fetchTier: "ics",
  categoryHint: "community",
  pollInterval: 720,
  enabled: true,
};

test("25. MAX_EVENTS_SAFETY is exported and >= 1000", async () => {
  assert(
    typeof MAX_EVENTS_SAFETY === "number" && MAX_EVENTS_SAFETY >= 1000,
    `MAX_EVENTS_SAFETY should be a number >= 1000, got ${MAX_EVENTS_SAFETY}`,
  );
});

test("26. feed with 310 in-horizon events → all 310 returned (old 300 cap removed)", async () => {
  const originalFetch = globalThis.fetch;
  const icsBody = buildICSFeed(310);
  globalThis.fetch = fakeFetch(async () => {
    return new Response(icsBody, {
      status: 200,
      headers: { "Content-Type": "text/calendar" },
    });
  });
  try {
    const result = await fetchICSEvents(ICS_TEST_SOURCE);
    assert(
      result.length === 310,
      `26. feed with 310 events → expected 310, got ${result.length} (old cap=300 should be gone)`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("27. feed with 299 events → all 299 returned (regression: still works under cap)", async () => {
  const originalFetch = globalThis.fetch;
  const icsBody = buildICSFeed(299);
  globalThis.fetch = fakeFetch(async () => {
    return new Response(icsBody, {
      status: 200,
      headers: { "Content-Type": "text/calendar" },
    });
  });
  try {
    const result = await fetchICSEvents(ICS_TEST_SOURCE);
    assert(result.length === 299, `27. 299-event feed → expected 299, got ${result.length}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ============================================================================
// unblock routing: WAF'd feeds fetch through the Bright Data Web Unlocker
// Strategy: mock globalThis.fetch + point KAYA_HOME at a temp secrets.json so the
// token loader resolves a dummy token. Asserts the unlocker endpoint (not the
// source URL) is hit, with auth + zone + target url in the request.
// ============================================================================

console.log("\n--- unblock routing (mocked fetch + temp secrets) ---\n");

/** Run `fn` with KAYA_HOME pointed at a temp dir containing a fake secrets.json. */
async function withTempSecrets(token: string | null, fn: () => Promise<void>): Promise<void> {
  const originalKayaHome = process.env.KAYA_HOME;
  const dir = mkdtempSync(join(tmpdir(), "es-ics-secrets-"));
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const body = token == null ? {} : { BRIGHTDATA_API_TOKEN: token };
    writeFileSync(join(dir, ".claude", "secrets.json"), JSON.stringify(body));
    process.env.KAYA_HOME = join(dir, ".claude");
    await fn();
  } finally {
    if (originalKayaHome === undefined) delete process.env.KAYA_HOME;
    else process.env.KAYA_HOME = originalKayaHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

const UNBLOCK_SOURCE: EventSource = {
  id: "songkick-tracked-jm",
  url: "https://www.songkick.com/users/jm-stilb/calendars.ics?filter=tracked_artist",
  name: "Songkick — Jm's Tracked Artists",
  fetchTier: "ics",
  categoryHint: "music",
  pollInterval: 720,
  unblock: true,
  enabled: true,
};

test("28. unblock:true routes through the Bright Data unlocker endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl = "";
  let calledAuth: string | null = null;
  let calledBody: Record<string, unknown> = {};
  await withTempSecrets("dummy-token-123", async () => {
    globalThis.fetch = fakeFetch(async (input: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(input);
      calledAuth = new Headers(init?.headers).get("Authorization");
      calledBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(buildICSFeed(3), { status: 200, headers: { "Content-Type": "text/calendar" } });
    });
    try {
      const result = await fetchICSEvents(UNBLOCK_SOURCE);
      assert(calledUrl === "https://api.brightdata.com/request", `28a. hits unlocker endpoint, got "${calledUrl}"`);
      assert(calledAuth === "Bearer dummy-token-123", "28b. sends Bearer auth with the temp-secrets token");
      assert(calledBody.url === UNBLOCK_SOURCE.url, `28c. body.url is the source url, got "${String(calledBody.url)}"`);
      assert(calledBody.zone === "mcp_unlocker", `28d. body.zone is mcp_unlocker, got "${String(calledBody.zone)}"`);
      assert(result.length === 3, `28e. parses unlocked feed → expected 3, got ${result.length}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("29. unblock:true throws when the unlocker returns a non-iCal body (fail loud)", async () => {
  const originalFetch = globalThis.fetch;
  await withTempSecrets("dummy-token-123", async () => {
    globalThis.fetch = fakeFetch(
      async () => new Response('{"error":"blocked"}', { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    let threw = false;
    try {
      await fetchICSEvents(UNBLOCK_SOURCE);
    } catch {
      threw = true;
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert(threw, "29. non-iCal unlocker body should throw, not silently return 0 events");
  });
});

test("30. unblock:true throws a clear error when BRIGHTDATA_API_TOKEN is absent", async () => {
  const originalFetch = globalThis.fetch;
  await withTempSecrets(null, async () => {
    globalThis.fetch = fakeFetch(
      async () => new Response(buildICSFeed(1), { status: 200, headers: { "Content-Type": "text/calendar" } }),
    );
    let msg = "";
    try {
      await fetchICSEvents(UNBLOCK_SOURCE);
    } catch (err) {
      msg = (err as Error).message;
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert(/BRIGHTDATA_API_TOKEN/.test(msg), `30. missing token should error mentioning the key, got "${msg}"`);
  });
});

test("31. unblock:true with a malformed secrets.json throws SecretError file-malformed (no fetch, no value)", async () => {
  const originalFetch = globalThis.fetch;
  const originalKayaHome = process.env.KAYA_HOME;
  const dir = mkdtempSync(join(tmpdir(), "es-ics-secrets-bad-"));
  let fetched = false;
  let caught: unknown = null;
  try {
    writeFileSync(join(dir, "secrets.json"), '{"BRIGHTDATA_API_TOKEN": "SENTINEL-ics-0001",');
    process.env.KAYA_HOME = dir;
    globalThis.fetch = fakeFetch(async () => {
      fetched = true;
      return new Response(buildICSFeed(1), { status: 200, headers: { "Content-Type": "text/calendar" } });
    });
    await fetchICSEvents(UNBLOCK_SOURCE);
  } catch (err) {
    caught = err;
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKayaHome === undefined) delete process.env.KAYA_HOME;
    else process.env.KAYA_HOME = originalKayaHome;
    rmSync(dir, { recursive: true, force: true });
  }
  assert(caught instanceof SecretError, "31a. malformed secrets file throws a SecretError");
  assert(caught instanceof SecretError && caught.kind === "file-malformed", "31b. kind is file-malformed");
  assert(caught instanceof Error && !caught.message.includes("SENTINEL"), "31c. message holds no secret value");
  assert(!fetched, "31d. no fetch is made");
});

/** Adds Bun's `fetch.preconnect` so a plain function satisfies `typeof fetch`. */
function fakeFetch(fn: (...args: Parameters<typeof fetch>) => Promise<Response>): typeof fetch {
  return Object.assign(fn, { preconnect: () => {} });
}

// ============================================================================
// Tier-4 spend breaker (T2-11): checked before each unlocker request, each real
// attempt recorded, and an open breaker fails loudly with no request sent.
// ============================================================================

test("32. unblock:true checks the breaker before and records each real attempt", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const breaker = {
    check: async (domain: string) => {
      calls.push(`check:${domain}`);
      return { allowed: true } as const;
    },
    recordUse: async (domain: string) => {
      calls.push(`record:${domain}`);
    },
  };
  await withTempSecrets("dummy-token-123", async () => {
    globalThis.fetch = fakeFetch(async () => {
      calls.push("fetch");
      return new Response(buildICSFeed(2), { status: 200, headers: { "Content-Type": "text/calendar" } });
    });
    try {
      const result = await fetchICSEvents(UNBLOCK_SOURCE, { breaker });
      assert(result.length === 2, `32a. feed parsed, got ${result.length}`);
      assert(
        calls.join(",") === "check:www.songkick.com,fetch,record:www.songkick.com",
        `32b. order check, fetch, record; got ${calls.join(",")}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("33. unblock:true fails loudly and sends no request when the breaker is open", async () => {
  const originalFetch = globalThis.fetch;
  let fetched = 0;
  let recorded = 0;
  const breaker = {
    check: async () => ({ allowed: false, kind: "daily", reason: "daily ceiling 20 reached" }) as const,
    recordUse: async () => {
      recorded++;
    },
  };
  await withTempSecrets("dummy-token-123", async () => {
    globalThis.fetch = fakeFetch(async () => {
      fetched++;
      return new Response(buildICSFeed(1), { status: 200 });
    });
    let msg = "";
    try {
      await fetchICSEvents(UNBLOCK_SOURCE, { breaker });
    } catch (err) {
      msg = (err as Error).message;
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert(/breaker open \(daily\).*daily ceiling 20 reached/.test(msg), `33a. loud breaker error, got "${msg}"`);
    assert(fetched === 0, `33b. no unlocker request when open, got ${fetched}`);
    assert(recorded === 0, `33c. nothing recorded when no request was made, got ${recorded}`);
  });
});

test("native DATE metadata preserves calendar dates and exclusive DTEND in LA and UTC", () => {
  const previousTZ = process.env.TZ;
  try {
    for (const zone of ["America/Los_Angeles", "UTC"]) {
      process.env.TZ = zone;
      const parsed = ical.sync.parseICS("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:native-date\r\nDTSTART;VALUE=DATE:20261029\r\nDTEND;VALUE=DATE:20261031\r\nSUMMARY:Native DATE\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
      const event = parsed["native-date"];
      if (!event || event.type !== "VEVENT") throw new Error("Native parser did not return VEVENT");
      expect(event.start.dateOnly).toBe(true);
      const mapped = mapVeventToItem({ uid: event.uid, summary: String(event.summary), start: event.start, end: event.end }, TEST_SOURCE);
      expect(mapped).toMatchObject({ allDay: true, startDatetime: "2026-10-29T00:00:00-07:00", endDatetime: "2026-10-30T23:59:59-07:00" });
    }
  } finally {
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

test("native DATE without an explicit occurrence end does not invent a mapper duration", () => {
  const parsed = ical.sync.parseICS("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:date-no-end\r\nDTSTART;VALUE=DATE:20261029\r\nSUMMARY:Date no end\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
  const event = parsed["date-no-end"];
  if (!event || event.type !== "VEVENT") throw new Error("Native parser did not return VEVENT");
  const mapped = mapVeventToItem({ uid: event.uid, summary: String(event.summary), start: event.start }, TEST_SOURCE);
  expect(mapped.allDay).toBe(true);
  expect(mapped.endDatetime).toBeUndefined();
});

test("actual recurring DATE adapter path retains metadata without network", async () => {
  const originalFetch = globalThis.fetch;
  const previousTZ = process.env.TZ;
  try {
    process.env.TZ = "UTC";
    setSystemTime(new Date("2026-10-28T12:00:00Z"));
    globalThis.fetch = fakeFetch(async () => new Response("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:date-recurring\r\nDTSTART;VALUE=DATE:20261029\r\nDTEND;VALUE=DATE:20261030\r\nRRULE:FREQ=DAILY;COUNT=2\r\nSUMMARY:Recurring DATE\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"));
    const events = await fetchICSEvents(TEST_SOURCE);
    expect(events).toHaveLength(2);
    expect(events.map(event => event.recurrenceRule)).toEqual(["RRULE:FREQ=DAILY;COUNT=2", "RRULE:FREQ=DAILY;COUNT=2"]);
    expect(events.every(event => event.allDay)).toBe(true);
    expect(events.map(event => event.startDatetime)).toEqual(["2026-10-29T00:00:00-07:00", "2026-10-30T00:00:00-07:00"]);
    expect(events.map(event => event.endDatetime)).toEqual(["2026-10-29T23:59:59-07:00", "2026-10-30T23:59:59-07:00"]);
  } finally {
    setSystemTime();
    globalThis.fetch = originalFetch;
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

async function coordinateFeed(properties: string[], overrideProperties?: string[]): Promise<ReturnType<typeof mapVeventToItem>[]> {
  const originalFetch = globalThis.fetch;
  const recurring = overrideProperties !== undefined;
  const override = recurring ? ["BEGIN:VEVENT", "UID:coordinate-contract", "RECURRENCE-ID:20261030T120000Z", "DTSTART:20261030T140000Z", "DTEND:20261030T150000Z", "SUMMARY:Override", ...overrideProperties, "END:VEVENT"] : [];
  const body = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:coordinate-contract", "DTSTART:20261029T120000Z", "DTEND:20261029T130000Z", "SUMMARY:Coordinate contract", "LOCATION:Master venue", ...(recurring ? ["RRULE:FREQ=DAILY;COUNT=2"] : []), ...properties, "END:VEVENT", ...override, "END:VCALENDAR"].join("\r\n");
  try {
    setSystemTime(new Date("2026-10-28T00:00:00Z"));
    globalThis.fetch = fakeFetch(async () => new Response(body));
    return await fetchICSEvents(TEST_SOURCE);
  } finally {
    globalThis.fetch = originalFetch;
    setSystemTime();
  }
}

test("native Apple literal coordinate strings, wrappers and folded values survive the adapter", async () => {
  for (const property of [
    "X-APPLE-STRUCTURED-LOCATION:geo:32.75,-117.15",
    "X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=Master venue:geo:32.75,-117.15",
    "X-APPLE-STRUCTURED-LOCATION;VALUE=URI:geo:32.75,\r\n -117.15",
  ]) {
    const events = await coordinateFeed([property]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ lat: 32.75, lng: -117.15, venue: "Master venue", isFree: false });
  }
  const zero = await coordinateFeed(["X-APPLE-STRUCTURED-LOCATION:geo:0,+0"]);
  expect(zero[0]).toMatchObject({ lat: 0, lng: 0 });
  const boundary = await coordinateFeed(["X-APPLE-STRUCTURED-LOCATION:geo:-90,180"]);
  expect(boundary[0]).toMatchObject({ lat: -90, lng: 180 });
});

test("native unsupported, invalid, repeated and standard GEO properties remain unknown", async () => {
  const propertySets = [
    [], ["GEO:;"], ["GEO:32.75;-117.15"], ["GEO:32.75;-117.15", "GEO:33;-118"],
    ["X-APPLE-STRUCTURED-LOCATION:geo:32.75,-117.15", "GEO:32.75;-117.15"],
    ["X-APPLE-STRUCTURED-LOCATION:geo:32.75,-117.15", "X-APPLE-STRUCTURED-LOCATION:geo:33,-118"],
    ...["", "geo:", "geo:32.75,", "geo:,-117.15", "geo:NaN,-117", "geo:32,Infinity", "geo:91,-117", "geo:32,-181", "geo:32,-117,10", "geo:32,-117;u=10", "geo:3e1,-117", "https://example.com/geo:32,-117"].map(value => [`X-APPLE-STRUCTURED-LOCATION:${value}`]),
  ];
  for (const properties of propertySets) {
    const events = await coordinateFeed(properties);
    expect(events).toHaveLength(1);
    expect(events[0]?.lat).toBeUndefined();
    expect(events[0]?.lng).toBeUndefined();
  }
});

test("recurrence inherits master coordinates only when override venue evidence permits it", async () => {
  const master = ["X-APPLE-STRUCTURED-LOCATION:geo:32.75,-117.15"];
  for (const override of [[], ["LOCATION:Master venue"], ["LOCATION: Master venue "]]) {
    const events = await coordinateFeed(master, override);
    expect(events).toHaveLength(2);
    expect(events.every(event => event.lat === 32.75 && event.lng === -117.15)).toBe(true);
    expect(events[1]?.startDatetime).toBe("2026-10-30T07:00:00-07:00");
  }
  const own = await coordinateFeed(master, ["LOCATION:Changed venue", "X-APPLE-STRUCTURED-LOCATION:geo:33,-118"]);
  expect(own[0]).toMatchObject({ lat: 32.75, lng: -117.15 });
  expect(own[1]).toMatchObject({ lat: 33, lng: -118, venue: "Changed venue" });
  for (const override of [
    ["LOCATION:Changed venue"], ["LOCATION:"], ["X-APPLE-STRUCTURED-LOCATION:invalid"],
    ["GEO:;"], ["X-APPLE-STRUCTURED-LOCATION:geo:33,-118", "GEO:33;-118"],
    ["X-APPLE-STRUCTURED-LOCATION:geo:33,-118", "X-APPLE-STRUCTURED-LOCATION:geo:34,-119"],
  ]) {
    const events = await coordinateFeed(master, override);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ lat: 32.75, lng: -117.15 });
    expect(events[1]?.lat).toBeUndefined();
    expect(events[1]?.lng).toBeUndefined();
  }
});

test("ICS recurrence provenance preserves exception and override dates without marking single events", async () => {
  const originalFetch = globalThis.fetch;
  try {
    setSystemTime(new Date("2026-11-04T22:00:08.488Z"));
    const rule = "RRULE:FREQ=WEEKLY;UNTIL=20261120T075959Z;BYDAY=FR";
    globalThis.fetch = fakeFetch(async () => new Response([
      "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:weekly-provenance",
      "DTSTART;TZID=America/Los_Angeles:20261030T190000",
      "DTEND;TZID=America/Los_Angeles:20261030T200000", rule,
      "EXDATE;TZID=America/Los_Angeles:20261113T190000", "SUMMARY:Weekly source", "END:VEVENT",
      "BEGIN:VEVENT", "UID:weekly-provenance", "RECURRENCE-ID;TZID=America/Los_Angeles:20261106T190000",
      "DTSTART;TZID=America/Los_Angeles:20261107T200000", "DTEND;TZID=America/Los_Angeles:20261107T210000",
      "SUMMARY:Moved source", "END:VEVENT", "BEGIN:VEVENT", "UID:single-provenance",
      "DTSTART;TZID=America/Los_Angeles:20261115T120000", "SUMMARY:Explicit date", "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n")));
    const events = await fetchICSEvents(TEST_SOURCE);
    expect(events).toHaveLength(2);
    const moved = events.find(event => event.title === "Moved source");
    expect(moved).toMatchObject({ startDatetime: "2026-11-07T20:00:00-08:00", endDatetime: "2026-11-07T21:00:00-08:00", recurrenceRule: rule, recurrenceOverride: true });
    expect(events.find(event => event.title === "Explicit date")?.recurrenceRule).toBeUndefined();
  } finally {
    setSystemTime();
    globalThis.fetch = originalFetch;
  }
});

test("ICS source-description evidence stays complete without changing the ranking description", () => {
  const sourceDescription = "Calendar source text ".repeat(40) + "conflicting source detail";
  const event = mapVeventToItem({ ...OCC_FULL, description: `<p>${sourceDescription}</p>` }, TEST_SOURCE);
  expect(event.sourceDescription).toBe(sourceDescription);
  expect(event.description).toBe(sourceDescription.slice(0, 500));
  expect(mapVeventToItem(OCC_FULL, TEST_SOURCE).sourceDescription).toBeUndefined();
});

test("pure mapper emits a complete valid coordinate pair or neither axis", () => {
  expect(mapVeventToItem({ ...OCC_FULL, coordinates: { lat: 0, lng: 0 } }, TEST_SOURCE)).toMatchObject({ lat: 0, lng: 0 });
  for (const coordinates of [{ lat: 91, lng: -117 }, { lat: 32, lng: NaN }, { lat: 32 }, { lat: null, lng: -117 }]) {
    const occurrence = { ...OCC_FULL };
    Object.defineProperty(occurrence, "coordinates", { value: coordinates });
    const event = mapVeventToItem(occurrence, TEST_SOURCE);
    expect(event.lat).toBeUndefined();
    expect(event.lng).toBeUndefined();
  }
});
