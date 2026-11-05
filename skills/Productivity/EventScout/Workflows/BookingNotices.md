# EventScout: booking notices (discover, calendar, book)

Moved out of `SKILL.md`. Read it before you judge `--action` or `--book-by` for an event that needs a booking step.

## Booking Notices (discover → calendar → *book*)

EventScout closes the loop from discovery to attendance. Putting an event on the
calendar is not the last step — many events need a **booking action** first (buy
tickets, make a reservation, RSVP) and that action has a deadline. The booking
subsystem tracks those deadlines and reminds you before they pass.

**Classification is agent-judged, not guessed in code** (markdown-first
de-determinization, Slice 2, 2026-07). The old classifier (`classifyBooking`, a
regex cascade over ticket/reservation keywords) was an enumerated keyword list —
silently wrong on anything unanticipated. `cli.ts` now does zero text-sniffing:
**YOU (the calling agent)** read the event's title/description/price/tags and pass
the booking action explicitly.

```bash
bun skills/Productivity/EventScout/cli.ts add-to-calendar <eventId> [--action buy-tickets|reserve|rsvp|none] [--book-by YYYY-MM-DD]
bun skills/Productivity/EventScout/cli.ts booking note <eventId>    [--action buy-tickets|reserve|rsvp|none] [--book-by YYYY-MM-DD]

# Booking notices:
bun skills/Productivity/EventScout/cli.ts booking scan [--window N]  # due actions (default 14d)
bun skills/Productivity/EventScout/cli.ts booking list              # full ledger
bun skills/Productivity/EventScout/cli.ts booking booked <eventId>  # stop reminders (booked)
bun skills/Productivity/EventScout/cli.ts booking dismiss <eventId> # stop reminders (dismissed)
```

### How to judge `--action` (agents)

Read the event's title, description, price fields (`isFree`/`priceMin`/`priceMax`),
and any ticket URL, then judge which of the four actions applies:

- **`buy-tickets`** — the event costs money and you need to purchase entry ahead of
  time (a priced concert, a Padres game, a paid comedy show).
- **`reserve`** — you're holding a table/seat ahead of time, usually free to hold
  but capacity-limited by a physical reservation (tasting menu, prix-fixe dinner,
  "table for two", omakase, assigned seating). **This applies even when the event
  is ALSO paid** — see the precedence rule below.
- **`rsvp`** — free (or free-to-claim-a-ticket) but capacity-limited by a
  headcount/signup rather than a held table (Eventbrite RSVP, "register", "sign
  up", "limited spots", a free ticket link with no reservation language).
- **`none`** — just show up. No ticket, no RSVP, no reservation — a bare free
  meetup or drop-in event. Passing `--action none` deliberately skips the ledger
  entry entirely (no notice, so the digest stays signal, not noise) — only use it
  when you're confident no booking is needed; if you're unsure, omit the flag
  instead (see below), don't guess `none`.

**Precedence when signals conflict:** reservation/table/seating wording wins over
price. A **paid** event that ALSO reads "reservation required" / "table for two" /
"prix-fixe" is `reserve`, not `buy-tickets` — the thing being secured is a table,
not a ticket, even though money changes hands. Only fall back to `buy-tickets` when
the event is paid with no reservation/table language at all.

**When you're not confident, omit `--action` entirely.** This is NOT an error — the
CLI accepts it and the entry lands `"unclassified"` (rendered as ⚠️ Needs review),
which nags in every `booking scan`/digest until it's re-noted with a real action or
explicitly marked booked/dismissed. Surfacing an event for a second look beats
silently mislabeling it — guessing wrong and burying the mistake in `none` or a
confident-but-incorrect action is exactly the failure mode this migration removed.

### Choosing a `--book-by` override

Code still owns the date arithmetic: `bookBy = eventStart − leadDays`, clamped to
"book now" if the ideal lead window has already passed. **These are the code's
default lead times, and they remain authoritative whenever `--book-by` is
omitted** — you don't need to compute a date yourself in the normal case:

- `buy-tickets` — keyed by category: sports/festival 21 days, music/comedy/theater
  14 days, arts/food 7 days, talk/film 5 days, community/other 3–7 days.
- `reserve` — always a 7-day lead, regardless of category.
- `rsvp` — always a 3-day lead, regardless of category.

Pass an explicit `--book-by YYYY-MM-DD` only when you know a deadline that differs
from that default — e.g. the event page says tickets go on sale Friday and
typically sell out same-day (sooner than the 14-day default), or a reservation
line names an explicit cutoff date. The override always wins over the computed
default, and it still applies even to an `unclassified` entry (you can record a
known deadline before you're sure of the exact action).

- **Delivery** (`Tools/BookingDigest.ts`, daily 07:30 via
  `com.kaya.cron.eventscout-booking-notices` — migrated 2026-08-20 to the
  monitored run-cron-job family, manifest in
  `MEMORY/daemon/cron/manifests/eventscout-booking-notices.yaml`):
  overdue/urgent actions **page** via AlertGate (edge-triggered per event),
  "soon" ones roll into the daily digest. Passed events are auto-expired so
  they stop nagging. `unclassified` entries have no bookBy, so they roll into
  the daily digest every day until resolved.

Full write-up: [docs/BOOKING_PROCESS.md](../docs/BOOKING_PROCESS.md).

---
