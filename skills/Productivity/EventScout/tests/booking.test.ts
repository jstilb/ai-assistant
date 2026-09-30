#!/usr/bin/env bun
/**
 * booking.test.ts — tests for Booking.ts (pure logic) + BookingLedger.ts (I/O)
 * + cli.ts's booking flag parsing.
 *
 * Markdown-first de-determinization, Slice 2 (2026-07): booking action
 * classification used to be a regex-keyword cascade (deleted from
 * Tools/Booking.ts in this slice's Commit 3) — an enumerated keyword list,
 * silently wrong on anything unanticipated. The AGENT now judges the action
 * from SKILL.md's "Booking Notices" guidance and passes it explicitly via
 * `--action`. These
 * tests cover the WIRING that replaced classification: an explicit (or
 * omitted) action flowing through to the correct ledger entry, bookBy
 * defaulting from the lead-day tables, an explicit --book-by override, and
 * "unclassified" entries always surfacing until resolved. Zero LLM calls —
 * there is no inference in this code path to stub.
 *
 * Deterministic: every function takes an explicit `now`; the ledger is scoped to
 * a temp file via EVENTSCOUT_BOOKING_LEDGER_PATH so no real state is touched.
 *
 * Run directly:
 *   bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/booking.test.ts
 */

import { mkdtempSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { test } from "bun:test";
import {
  computeBookBy,
  buildLedgerEntry,
  selectDueNotices,
  findExpiredIds,
  urgencyOf,
  renderNoticesMarkdown,
  renderNoticesTelegram,
} from "../Tools/Booking.ts";
import type { BookingLedgerEntry } from "../Tools/Booking.ts";
import type { EventItem } from "../Tools/types.ts";
import { parseBookingFlags, BookingFlagError } from "../cli.ts";

// ============================================================================
// Harness
// ============================================================================

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Assertion failed: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

// ============================================================================
// Fixtures
// ============================================================================

function makeEvent(
  overrides: Partial<EventItem> & { id: string; startDatetime: string }
): EventItem {
  return {
    title: `Event ${overrides.id}`,
    allDay: false,
    category: "other",
    tags: [],
    isFree: true,
    sourceUrl: "https://example.com/event",
    sources: [{ sourceId: "test", url: "https://example.com/event" }],
    fetchedAt: "2026-06-01T00:00:00Z",
    status: "scheduled",
    ...overrides,
  };
}

const NOW = new Date("2026-07-01T12:00:00-07:00");

// ============================================================================
// buildLedgerEntry — WIRING tests (agent-supplied action, not classified)
//
// These reuse the same event fixtures the old regex-classification tests
// used, but now the ACTION is passed in explicitly rather than guessed from
// event text. The last case is the eval's precedence case: a PAID event with
// reservation wording — the agent (not code) is responsible for choosing
// "reserve" over "buy-tickets" here.
// ============================================================================

test("buildLedgerEntry: paid ticketed concert, action=buy-tickets → correct entry", () => {
  const e = makeEvent({
    id: "1",
    title: "Tycho at Observatory",
    startDatetime: "2026-07-20T20:00:00-07:00",
    category: "music",
    isFree: false,
    priceMin: 35,
    ticketUrl: "https://tix.example.com/show",
  });
  const entry = buildLedgerEntry(e, NOW, "buy-tickets")!;
  assertEq(entry.action, "buy-tickets", "action carried verbatim from caller");
  assertEq(entry.link, "https://tix.example.com/show", "link uses ticketUrl");
  assertEq(entry.status, "open", "status open");
  assert(entry.bookBy !== null, "bookBy computed from lead-day default");
});

test("buildLedgerEntry: free event with ticket link, action=rsvp → correct entry", () => {
  const e = makeEvent({
    id: "2",
    startDatetime: "2026-07-10T18:00:00-07:00",
    category: "community",
    isFree: true,
    ticketUrl: "https://eventbrite.com/free-thing",
  });
  const entry = buildLedgerEntry(e, NOW, "rsvp")!;
  assertEq(entry.action, "rsvp", "action carried verbatim");
  assert(entry.bookBy !== null, "bookBy computed (3d rsvp lead)");
});

test("buildLedgerEntry: reservation wording, action=reserve → correct entry", () => {
  const e = makeEvent({
    id: "3",
    startDatetime: "2026-07-08T19:00:00-07:00",
    category: "food",
    isFree: true,
    description: "Chef's tasting menu — reservation required, table for two.",
  });
  const entry = buildLedgerEntry(e, NOW, "reserve")!;
  assertEq(entry.action, "reserve", "action carried verbatim");
});

test("buildLedgerEntry: bare free meetup, action=none → null (skips noise)", () => {
  const e = makeEvent({
    id: "5",
    startDatetime: "2026-07-05T18:00:00-07:00",
    category: "community",
    isFree: true,
  });
  assertEq(buildLedgerEntry(e, NOW, "none"), null, "explicit none → no ledger entry");
});

test("buildLedgerEntry: PRECEDENCE CASE — paid event WITH reservation wording, action=reserve", () => {
  const e = makeEvent({
    id: "7",
    startDatetime: "2026-07-12T19:00:00-07:00",
    category: "food",
    isFree: false,
    priceMin: 90,
    description: "Prix-fixe dinner. Reservation required.",
  });
  // The AGENT judges reserve over buy-tickets here (table/seat language wins
  // even though the event is paid) — code just wires through what it's told.
  const entry = buildLedgerEntry(e, NOW, "reserve")!;
  assertEq(entry.action, "reserve", "agent's reserve judgment carried through, not overridden by isFree=false");
  assert(entry.bookBy !== null, "bookBy computed (7d reserve lead, not 7d food-category lead)");
});

test("buildLedgerEntry: no action supplied → unclassified, bookBy null, entry NOT dropped", () => {
  const e = makeEvent({
    id: "15",
    title: "Tycho at Observatory",
    startDatetime: "2026-07-25T20:00:00-07:00",
    venue: "Observatory North Park",
    category: "music",
    isFree: false,
    priceMin: 45,
    ticketUrl: "https://tix.example.com/tycho",
  });
  const entry = buildLedgerEntry(e, NOW)!;
  assert(entry !== null, "unclassified still produces an entry (never silently dropped)");
  assertEq(entry.action, "unclassified", "omitted action defaults to unclassified");
  assertEq(entry.bookBy, null, "unclassified has no computed bookBy");
  assertEq(entry.status, "open", "status open");
  assertEq(entry.eventId, "15", "eventId carried");
});

test("buildLedgerEntry: explicit --book-by OVERRIDES the computed lead-day default", () => {
  const e = makeEvent({
    id: "16",
    startDatetime: "2026-08-30T19:00:00-07:00", // far out — computed default would NOT be this date
    category: "music",
    isFree: false,
    priceMin: 25,
  });
  const override = "2026-07-15T00:00:00-07:00";
  const entry = buildLedgerEntry(e, NOW, "buy-tickets", override)!;
  assertEq(entry.bookBy, override, "explicit bookBy wins over computed default");

  const computedDefault = computeBookBy(e, "buy-tickets", NOW);
  assert(computedDefault !== override, "sanity: the computed default is NOT the override we gave");
});

test("buildLedgerEntry: explicit --book-by applies even to an unclassified entry", () => {
  const e = makeEvent({
    id: "17",
    startDatetime: "2026-08-01T19:00:00-07:00",
    category: "music",
    isFree: false,
    priceMin: 25,
  });
  const override = "2026-07-10T00:00:00-07:00";
  const entry = buildLedgerEntry(e, NOW, undefined, override)!;
  assertEq(entry.action, "unclassified", "action still unclassified");
  assertEq(entry.bookBy, override, "override applies even without a resolved action");
});

// ============================================================================
// computeBookBy — pure lead-day date math (action passed directly, no
// classification object). Same policy as before the migration.
// ============================================================================

test("computeBookBy: music action=buy-tickets 30d out → 14d lead", () => {
  const e = makeEvent({
    id: "8",
    startDatetime: "2026-07-31T20:00:00-07:00",
    category: "music",
    isFree: false,
    priceMin: 40,
  });
  const bookBy = computeBookBy(e, "buy-tickets", NOW);
  // 07-31 20:00 minus 14 days = 07-17 20:00 (well after NOW)
  assert(bookBy !== null && bookBy.startsWith("2026-07-18"), `music bookBy = ${bookBy} (~07-17/18 UTC)`);
});

test("computeBookBy: sports gets 21d lead (earlier than music's 14d)", () => {
  const sport = makeEvent({
    id: "9",
    startDatetime: "2026-08-30T19:00:00-07:00",
    category: "sports",
    isFree: false,
    priceMin: 25,
  });
  const music = makeEvent({
    id: "10",
    startDatetime: "2026-08-30T19:00:00-07:00",
    category: "music",
    isFree: false,
    priceMin: 25,
  });
  const sB = Date.parse(computeBookBy(sport, "buy-tickets", NOW)!);
  const mB = Date.parse(computeBookBy(music, "buy-tickets", NOW)!);
  assert(sB < mB, "sports bookBy is earlier than music bookBy (21d vs 14d)");
});

test("computeBookBy: reserve uses its fixed 7d lead, not the category lead", () => {
  const e = makeEvent({
    id: "18",
    startDatetime: "2026-07-31T20:00:00-07:00",
    category: "community", // 3d category lead — must NOT be used for reserve
    isFree: true,
  });
  const bookBy = Date.parse(computeBookBy(e, "reserve", NOW)!);
  const eventStart = Date.parse(e.startDatetime);
  const impliedLeadDays = Math.round((eventStart - bookBy) / (24 * 60 * 60 * 1000));
  assertEq(impliedLeadDays, 7, "reserve action lead is 7d regardless of category");
});

test("computeBookBy: rsvp uses its fixed 3d lead", () => {
  const e = makeEvent({
    id: "19",
    startDatetime: "2026-07-31T20:00:00-07:00",
    category: "sports", // 21d category lead — must NOT be used for rsvp
    isFree: true,
  });
  const bookBy = Date.parse(computeBookBy(e, "rsvp", NOW)!);
  const eventStart = Date.parse(e.startDatetime);
  const impliedLeadDays = Math.round((eventStart - bookBy) / (24 * 60 * 60 * 1000));
  assertEq(impliedLeadDays, 3, "rsvp action lead is 3d regardless of category");
});

test("computeBookBy: lead window already passed → book now (clamped to NOW)", () => {
  const e = makeEvent({
    id: "11",
    startDatetime: "2026-07-04T20:00:00-07:00", // 3 days out, music lead is 14d
    category: "music",
    isFree: false,
    priceMin: 30,
  });
  const bookBy = computeBookBy(e, "buy-tickets", NOW);
  assertEq(bookBy, NOW.toISOString(), "bookBy clamps to NOW when ideal lead already passed");
});

test("computeBookBy: event already started → null", () => {
  const e = makeEvent({
    id: "12",
    startDatetime: "2026-06-30T20:00:00-07:00", // yesterday
    category: "music",
    isFree: false,
    priceMin: 30,
  });
  assertEq(computeBookBy(e, "buy-tickets", NOW), null, "past event → null bookBy");
});

test("computeBookBy: action=none → null", () => {
  const e = makeEvent({ id: "13", startDatetime: "2026-07-20T18:00:00-07:00", isFree: true });
  assertEq(computeBookBy(e, "none", NOW), null, "none-action → null bookBy");
});

test("computeBookBy: action=unclassified → null", () => {
  const e = makeEvent({ id: "14", startDatetime: "2026-07-20T18:00:00-07:00", isFree: true });
  assertEq(computeBookBy(e, "unclassified", NOW), null, "unclassified-action → null bookBy");
});

// ============================================================================
// selectDueNotices + urgency + expiry
// ============================================================================

function entry(overrides: Partial<BookingLedgerEntry> & { eventId: string }): BookingLedgerEntry {
  return {
    title: `Entry ${overrides.eventId}`,
    startDatetime: "2026-07-25T20:00:00-07:00",
    action: "buy-tickets",
    reason: "test",
    bookBy: "2026-07-10T20:00:00-07:00",
    link: "https://example.com",
    isFree: false,
    status: "open",
    notedAt: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

test("selectDueNotices: within window included, beyond excluded", () => {
  const entries = [
    entry({ eventId: "near", bookBy: "2026-07-05T00:00:00-07:00", startDatetime: "2026-07-20T20:00:00-07:00" }),
    entry({ eventId: "far", bookBy: "2026-08-30T00:00:00-07:00", startDatetime: "2026-09-15T20:00:00-07:00" }),
  ];
  const ids = selectDueNotices(entries, NOW, 14).map((n) => n.entry.eventId);
  assertEq(ids, ["near"], "only bookBy within 14d surfaces");
});

test("selectDueNotices: non-open statuses excluded", () => {
  const entries = [
    entry({ eventId: "booked", status: "booked", bookBy: "2026-07-05T00:00:00-07:00" }),
    entry({ eventId: "dismissed", status: "dismissed", bookBy: "2026-07-05T00:00:00-07:00" }),
    entry({ eventId: "open", status: "open", bookBy: "2026-07-05T00:00:00-07:00" }),
  ];
  const ids = selectDueNotices(entries, NOW, 14).map((n) => n.entry.eventId);
  assertEq(ids, ["open"], "booked/dismissed suppressed");
});

test("selectDueNotices: passed event excluded even if open", () => {
  const entries = [
    entry({ eventId: "past", startDatetime: "2026-06-20T20:00:00-07:00", bookBy: "2026-06-01T00:00:00-07:00" }),
  ];
  assertEq(selectDueNotices(entries, NOW, 14).length, 0, "past event not surfaced");
});

test("selectDueNotices: sorted overdue → urgent → soon", () => {
  const entries = [
    entry({ eventId: "soon", bookBy: "2026-07-10T00:00:00-07:00" }),   // ~9d out
    entry({ eventId: "overdue", bookBy: "2026-06-28T00:00:00-07:00" }), // past
    entry({ eventId: "urgent", bookBy: "2026-07-02T00:00:00-07:00" }),  // ~1d out
  ];
  const ids = selectDueNotices(entries, NOW, 14).map((n) => n.entry.eventId);
  assertEq(ids, ["overdue", "urgent", "soon"], "priority ordering by urgency");
});

test("selectDueNotices: UNCLASSIFIED (no bookBy) entries ALWAYS surface, even with a tiny window", () => {
  const entries = [
    entry({
      eventId: "unclassified1",
      action: "unclassified",
      bookBy: null,
      startDatetime: "2026-12-25T20:00:00-07:00", // far in the future
    }),
  ];
  // windowDays=0 would exclude any bookBy'd entry outside "today" — but an
  // unclassified entry has no bookBy at all, so it must still surface. This
  // is what makes "unclassified nags in every digest until resolved" true.
  const ids = selectDueNotices(entries, NOW, 0).map((n) => n.entry.eventId);
  assertEq(ids, ["unclassified1"], "unclassified entry surfaces regardless of window size");
});

test("selectDueNotices: unclassified entry stops surfacing once booked/dismissed", () => {
  const entries = [
    entry({ eventId: "resolved", action: "unclassified", bookBy: null, status: "booked" }),
  ];
  assertEq(selectDueNotices(entries, NOW, 0).length, 0, "booked unclassified entry no longer nags");
});

test("urgencyOf: classifies overdue/urgent/soon", () => {
  assertEq(urgencyOf(entry({ eventId: "a", bookBy: "2026-06-28T00:00:00-07:00" }), NOW).urgency, "overdue", "past bookBy → overdue");
  assertEq(urgencyOf(entry({ eventId: "b", bookBy: "2026-07-02T00:00:00-07:00" }), NOW).urgency, "urgent", "≤2d → urgent");
  assertEq(urgencyOf(entry({ eventId: "c", bookBy: "2026-07-12T00:00:00-07:00" }), NOW).urgency, "soon", ">2d → soon");
});

test("findExpiredIds: only open + passed events (expiry unchanged by this migration)", () => {
  const entries = [
    entry({ eventId: "past-open", startDatetime: "2026-06-20T20:00:00-07:00" }),
    entry({ eventId: "past-booked", status: "booked", startDatetime: "2026-06-20T20:00:00-07:00" }),
    entry({ eventId: "future-open", startDatetime: "2026-07-20T20:00:00-07:00" }),
    entry({ eventId: "past-unclassified", action: "unclassified", bookBy: null, startDatetime: "2026-06-20T20:00:00-07:00" }),
  ];
  assertEq(
    findExpiredIds(entries, NOW),
    ["past-open", "past-unclassified"],
    "only open+passed flagged expired — unclassified expires the same as any other open entry"
  );
});

// ============================================================================
// Renderers
// ============================================================================

test("renderNoticesMarkdown: empty → caught-up message", () => {
  assert(renderNoticesMarkdown([], NOW).includes("caught up"), "empty markdown = caught up");
});

test("renderNoticesMarkdown: includes title, deadline, link", () => {
  const notices = selectDueNotices(
    [entry({ eventId: "z", title: "Padres vs Dodgers", bookBy: "2026-07-04T00:00:00-07:00", link: "https://mlb.com/x" })],
    NOW,
    14
  );
  const md = renderNoticesMarkdown(notices, NOW);
  assert(md.includes("Padres vs Dodgers"), "markdown has title");
  assert(md.includes("https://mlb.com/x"), "markdown has link");
  assert(/book/i.test(md), "markdown has a book-by phrase");
});

test("renderNoticesMarkdown: unclassified entry shows the ⚠️ Needs review label", () => {
  const notices = selectDueNotices(
    [entry({ eventId: "z2", title: "Mystery Event", action: "unclassified", bookBy: null })],
    NOW,
    14
  );
  const md = renderNoticesMarkdown(notices, NOW);
  assert(md.includes("⚠️ Needs review"), "unclassified renders the needs-review label, not silently as 'none'");
});

test("renderNoticesTelegram: escapes HTML + stays under limit", () => {
  const notices = selectDueNotices(
    [entry({ eventId: "z", title: "Rock & Roll <Live>", bookBy: "2026-07-04T00:00:00-07:00" })],
    NOW,
    14
  );
  const tg = renderNoticesTelegram(notices, NOW);
  assert(tg.includes("&amp;") && tg.includes("&lt;Live&gt;"), "telegram escapes & and <>");
  assert(tg.length <= 4096, "telegram under 4096 chars");
});

// ============================================================================
// cli.ts — parseBookingFlags (--action / --book-by validation)
// ============================================================================

test("parseBookingFlags: no flags → unclassified action, no bookBy override", () => {
  const { action, bookBy } = parseBookingFlags([]);
  assertEq(action, "unclassified", "absent --action → unclassified, NOT an error");
  assertEq(bookBy, undefined, "absent --book-by → no override");
});

test("parseBookingFlags: --action rsvp → action=rsvp", () => {
  const { action } = parseBookingFlags(["--action", "rsvp"]);
  assertEq(action, "rsvp", "valid --action parsed");
});

for (const validAction of ["buy-tickets", "reserve", "rsvp", "none"] as const) {
  test(`parseBookingFlags: --action ${validAction} accepted`, () => {
    const { action } = parseBookingFlags(["--action", validAction]);
    assertEq(action, validAction, `--action ${validAction} round-trips`);
  });
}

test("parseBookingFlags: --action bogus → throws BookingFlagError, LOUD", () => {
  let threw = false;
  try {
    parseBookingFlags(["--action", "bogus"]);
  } catch (err) {
    threw = err instanceof BookingFlagError;
    assert(/bogus/.test((err as Error).message), "error message names the bad value");
  }
  assert(threw, "invalid --action throws BookingFlagError (non-zero exit at the CLI layer)");
});

test("parseBookingFlags: --book-by 2026-07-10 → LA-midnight ISO instant", () => {
  const { bookBy } = parseBookingFlags(["--book-by", "2026-07-10"]);
  assert(bookBy !== undefined && bookBy.startsWith("2026-07-10T00:00:00"), `bookBy = ${bookBy}`);
});

test("parseBookingFlags: malformed --book-by (not YYYY-MM-DD) → throws", () => {
  let threw = false;
  try {
    parseBookingFlags(["--book-by", "07/10/2026"]);
  } catch (err) {
    threw = err instanceof BookingFlagError;
  }
  assert(threw, "malformed --book-by throws BookingFlagError");
});

test("parseBookingFlags: invalid calendar date (Feb 30) → throws", () => {
  let threw = false;
  try {
    parseBookingFlags(["--book-by", "2026-02-30"]);
  } catch (err) {
    threw = err instanceof BookingFlagError;
  }
  assert(threw, "Feb 30 throws BookingFlagError");
});

test("parseBookingFlags: --action and --book-by combine", () => {
  const { action, bookBy } = parseBookingFlags(["--action", "buy-tickets", "--book-by", "2026-08-01"]);
  assertEq(action, "buy-tickets", "action parsed");
  assert(bookBy !== undefined && bookBy.startsWith("2026-08-01"), `bookBy = ${bookBy}`);
});

// ============================================================================
// Ledger I/O (scoped to temp file)
// ============================================================================

test("ledger: note (explicit action) → list → scan → mark booked round-trip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "es-booking-"));
  const path = join(dir, "booking-ledger.json");
  const prev = process.env["EVENTSCOUT_BOOKING_LEDGER_PATH"];
  process.env["EVENTSCOUT_BOOKING_LEDGER_PATH"] = path;
  try {
    // Fresh import so the module reads the scoped env path at call time.
    const L = await import("../Tools/BookingLedger.ts");

    const e = makeEvent({
      id: "round1",
      title: "Comedy Night",
      startDatetime: "2026-07-20T20:00:00-07:00",
      category: "comedy",
      isFree: false,
      priceMin: 25,
      ticketUrl: "https://tix.example.com/comedy",
    });

    const res = L.noteBooking(e, NOW, "buy-tickets");
    assert(res.noted === true, "noteBooking records with an explicit action");
    assertEq(res.entry!.action, "buy-tickets", "explicit action carried through noteBooking");
    assert(existsSync(path), "ledger file written");

    assertEq(L.listEntries().length, 1, "one entry after note");

    // Idempotent: re-note same id does not duplicate.
    L.noteBooking(e, NOW, "buy-tickets");
    assertEq(L.listEntries().length, 1, "re-note same id → no duplicate");

    const scan = L.scanNotices(NOW, 30);
    assertEq(scan.notices.length, 1, "scan surfaces the open notice");

    assert(L.markBooked("round1") === true, "markBooked returns true");
    const scan2 = L.scanNotices(NOW, 30);
    assertEq(scan2.notices.length, 0, "booked entry no longer surfaces");

    // markBooked on unknown id → false
    assert(L.markBooked("nope") === false, "markBooked unknown id → false");
  } finally {
    if (prev === undefined) delete process.env["EVENTSCOUT_BOOKING_LEDGER_PATH"];
    else process.env["EVENTSCOUT_BOOKING_LEDGER_PATH"] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger: noteBooking with NO action → unclassified entry always surfaces on scan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "es-booking-"));
  const path = join(dir, "booking-ledger.json");
  const prev = process.env["EVENTSCOUT_BOOKING_LEDGER_PATH"];
  process.env["EVENTSCOUT_BOOKING_LEDGER_PATH"] = path;
  try {
    const L = await import("../Tools/BookingLedger.ts");
    const e = makeEvent({
      id: "unclass1",
      title: "Mystery Fundraiser",
      startDatetime: "2026-12-01T18:00:00-07:00", // far out
      category: "community",
      isFree: true,
    });

    const res = L.noteBooking(e, NOW); // no action passed
    assert(res.noted === true, "unclassified events ARE noted, not skipped");
    assertEq(res.entry!.action, "unclassified", "action defaults to unclassified");
    assertEq(res.entry!.bookBy, null, "no computed bookBy for unclassified");

    // A tiny window (1 day) would exclude any dated entry that's months out —
    // but the unclassified entry has no bookBy, so it must still surface.
    const scan = L.scanNotices(NOW, 1);
    assertEq(scan.notices.length, 1, "unclassified entry surfaces even with a 1-day window");
    assertEq(scan.notices[0]!.entry.action, "unclassified", "surfaced entry is the unclassified one");

    // Re-noting with a real action resolves it out of the "always nag" state
    // in the sense that it now has a real bookBy governing its window.
    L.noteBooking(e, NOW, "rsvp");
    const scan2 = L.scanNotices(NOW, 1);
    assertEq(scan2.notices.length, 0, "re-noted with a real (rsvp) action, now respects the window like any other entry");
  } finally {
    if (prev === undefined) delete process.env["EVENTSCOUT_BOOKING_LEDGER_PATH"];
    else process.env["EVENTSCOUT_BOOKING_LEDGER_PATH"] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger: noteBooking with action=none is NOT noted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "es-booking-"));
  const path = join(dir, "booking-ledger.json");
  const prev = process.env["EVENTSCOUT_BOOKING_LEDGER_PATH"];
  process.env["EVENTSCOUT_BOOKING_LEDGER_PATH"] = path;
  try {
    const L = await import("../Tools/BookingLedger.ts");
    const e = makeEvent({ id: "none1", startDatetime: "2026-07-20T18:00:00-07:00", isFree: true });
    const res = L.noteBooking(e, NOW, "none");
    assertEq(res.noted, false, "explicit none → not noted");
    assertEq(L.listEntries().length, 0, "no ledger entry written for none");
  } finally {
    if (prev === undefined) delete process.env["EVENTSCOUT_BOOKING_LEDGER_PATH"];
    else process.env["EVENTSCOUT_BOOKING_LEDGER_PATH"] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger: scan flips passed open events to expired (expiry behavior unchanged)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "es-booking-"));
  const path = join(dir, "booking-ledger.json");
  const prev = process.env["EVENTSCOUT_BOOKING_LEDGER_PATH"];
  process.env["EVENTSCOUT_BOOKING_LEDGER_PATH"] = path;
  try {
    const L = await import("../Tools/BookingLedger.ts");
    const past = makeEvent({
      id: "past1",
      startDatetime: "2026-06-20T20:00:00-07:00",
      category: "music",
      isFree: false,
      priceMin: 30,
    });
    // Note with an earlier "now" so it's a valid open entry, then scan at NOW.
    L.noteBooking(past, new Date("2026-06-01T00:00:00-07:00"), "buy-tickets");
    const scan = L.scanNotices(NOW, 30);
    assertEq(scan.expired, ["past1"], "passed event flagged expired");
    assertEq(L.listEntries()[0]!.status, "expired", "status persisted as expired");
  } finally {
    if (prev === undefined) delete process.env["EVENTSCOUT_BOOKING_LEDGER_PATH"];
    else process.env["EVENTSCOUT_BOOKING_LEDGER_PATH"] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
