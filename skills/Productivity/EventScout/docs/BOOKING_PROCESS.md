# Booking Process — events & plans → calendar → notices for booking

The end-to-end process for getting events and plans onto the calendar **and getting
reminded to actually book them** before the deadline. This closes the loop that was
missing: EventScout could discover events and put them on the calendar, but nothing
told you *"buy these tickets by Thursday or they'll be gone."*

## The three stages

```
 1. DISCOVER              2. COMMIT                    3. BOOK (notices)
 ┌───────────────┐        ┌────────────────────┐       ┌──────────────────────┐
 │ EventScout     │        │ add-to-calendar     │       │ booking scan / digest │
 │ query / prefetch│──pick─▶│  → gcal event       │──────▶│  → AlertGate notices  │
 │ (+ activity_ideas│       │  → booking ledger   │ auto  │  (page / daily digest)│
 │   plans)        │        │    (noteBooking)    │ note  │                      │
 └───────────────┘        └────────────────────┘       └──────────────────────┘
```

### Stage 1 — Discover
- `eventscout query "<what you want>"` surfaces upcoming San Diego events, ranked.
- "Plans" you already know you want live in LifeOS `activity_ideas` (save with
  `eventscout save <eventId>`), or you just decide on the spot.

### Stage 2 — Commit to the calendar
- `eventscout add-to-calendar <eventId> [--action buy-tickets|reserve|rsvp|none] [--book-by YYYY-MM-DD]`
  creates the Google Calendar event (`Tools/Actions.ts` → `kaya-cli gcal add`).
- On a successful add, EventScout automatically records the event's *booking
  requirement* in the booking ledger (`noteBooking`, best-effort — a ledger
  failure never fails the calendar add). **`--action` is the CALLING AGENT's
  judgment** (see SKILL.md "Booking Notices" → "How to judge `--action`") — the
  CLI does zero classification itself. Omitting `--action` is not an error: the
  entry lands `"unclassified"` and nags every scan/digest until re-noted.
- Manually adding something the ledger should track: `eventscout booking note <eventId> [--action ...] [--book-by ...]`.

### Stage 3 — Notices for booking
- A daily launchd job (`com.kaya.eventscout-booking-notices`, 07:30) runs
  `Tools/BookingDigest.ts`, which scans the ledger and routes each due action
  through **AlertGate** (the central alert-policy layer — no ad-hoc throttling):
  - **overdue / urgent** (deadline ≤ 2 days) → immediate Telegram **page**,
    edge-triggered per event (fingerprinted on the deadline, so it pages once,
    not every morning).
  - **soon** (deadline within the 14-day window) → **digest** spool, delivered in
    the daily System Health digest.
- Ad-hoc check any time: `eventscout booking scan` prints the human-readable digest.

## What counts as "needs booking" (agent-judged, Slice 2, 2026-07)

Classification used to be `classifyBooking()`, a regex cascade in `Tools/Booking.ts`
— an enumerated keyword list, silently wrong on anything unanticipated (deleted in
this slice). It's now the CALLING AGENT's judgment: read SKILL.md's "Booking
Notices" → "How to judge `--action`" for the full contract. Summary:

| Signal                                                     | Action        | Example                          |
|--------------------------------------------------------------|---------------|-----------------------------------|
| Reservation/table/seating wording — even on a PAID event   | `reserve`     | Chef's tasting dinner; a paid prix-fixe with "reservation required" |
| Paid, no reservation wording                                | `buy-tickets` | $45 concert, Padres game         |
| Free but has a ticket link, or RSVP/register text          | `rsvp`        | Free-but-ticketed Eventbrite     |
| None of the above                                           | `none`        | Bare free DSA meetup → no notice |
| Agent isn't confident                                        | *(omit `--action`)* | Lands `"unclassified"` — nags every scan/digest until resolved |

`none` is deliberate and skips the ledger entirely (no notice, signal not noise) —
only use it when confident; when unsure, omit `--action` rather than guess `none`.

## When to book by (lead-time policy — code default, overridable)

`computeBookBy()` = `eventStart − leadDays`, clamped to "no earlier than now" (if
the ideal window already passed, the answer is "book now"). This is the CODE
DEFAULT, used whenever `--book-by` is omitted; pass `--book-by YYYY-MM-DD`
explicitly to override it (see SKILL.md "Choosing a `--book-by` override").

| Category / action | Lead time |
|-------------------|-----------|
| sports, festival  | 21 days   |
| music, comedy, theater | 14 days |
| arts, food        | 7 days    |
| talk, film        | 5 days    |
| community         | 3 days    |
| reserve (any)     | 7 days    |
| rsvp (any)        | 3 days    |

Urgency for a notice, relative to now: **overdue** (deadline passed) → **urgent**
(≤ 2 days) → **soon** (within the window). `unclassified` entries have no bookBy
at all, so they always surface (treated like "soon" for delivery purposes) until
re-noted with a real action.

## CLI reference

```bash
# Stage 2 — commit + auto-note (--action is the AGENT's judgment, see SKILL.md)
eventscout add-to-calendar <eventId> [--action buy-tickets|reserve|rsvp|none] [--book-by YYYY-MM-DD]
eventscout booking note <eventId>    [--action buy-tickets|reserve|rsvp|none] [--book-by YYYY-MM-DD]

# Stage 3 — notices
eventscout booking scan [--window N]       # print due notices (default 14d), mark past expired
eventscout booking list                    # full ledger (all statuses)
eventscout booking booked <eventId>        # mark booked → stops reminders
eventscout booking dismiss <eventId>       # mark dismissed → stops reminders

# The daily digest (what the launchd job runs); dry-run sends nothing:
KAYA_ALERT_DRY_RUN=1 bun skills/Productivity/EventScout/Tools/BookingDigest.ts
```

## Enabling the daily notice (Jm's step)

The launchd job is defined but not loaded until you run:

```bash
bash ~/.claude/bin/rebuild-plists.sh          # writes + loads all plists
# or just this one:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kaya.eventscout-booking-notices.plist
# force-run now:
launchctl kickstart -k gui/$(id -u)/com.kaya.eventscout-booking-notices
```

## Files

| File | Role |
|------|------|
| `Tools/Booking.ts` | Pure logic: book-by date math, notice selection, renderers. Classification (`classifyBooking`/RESERVE_RE/RSVP_RE) was deleted in Slice 2 — see SKILL.md "How to judge `--action`" |
| `Tools/BookingLedger.ts` | Ledger I/O: `noteBooking(event, now, action, bookByOverride?)`, `scanNotices`, `markBooked`, `dismiss` |
| `Tools/BookingDigest.ts` | Daily delivery via AlertGate (page/digest) |
| `Tools/Actions.ts` | `addToCalendar(event, action?, bookBy?)` threads the caller's action/bookBy into `noteBooking` on success |
| `State/booking-ledger.json` | Ledger store (env override `EVENTSCOUT_BOOKING_LEDGER_PATH`; set `EVENTSCOUT_BOOKING_DRY_RUN=1` to make `noteBooking` a no-op that skips the write) |
| `bin/eventscout-booking-notices.sh` | launchd wrapper |
| `bin/rebuild-plists.sh` | `com.kaya.eventscout-booking-notices` plist block |
| `tests/booking.test.ts` | Wiring tests: explicit action → ledger entry, bookBy defaulting/override, unclassified always-surfaces, ledger round-trip, `cli.ts`'s `parseBookingFlags` validation |
```
