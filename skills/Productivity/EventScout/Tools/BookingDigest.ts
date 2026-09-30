#!/usr/bin/env bun
/**
 * BookingDigest.ts — deliver EventScout booking notices through AlertGate.
 *
 * This is the "notices" delivery for the booking pipeline. It scans the ledger
 * for due booking actions and routes them through the central AlertGate policy
 * (the same layer every Kaya alert sender uses — no ad-hoc throttling):
 *
 *   • overdue / urgent notices → tier 'page'   (immediate Telegram, edge-triggered
 *                                                per event via fingerprint so it
 *                                                pages once, not every run)
 *   • soon notices             → tier 'digest' (rolled into the daily digest)
 *
 * Intended to be run once a day by launchd (bin/eventscout-booking-notices.sh),
 * but safe to run by hand. Set KAYA_ALERT_DRY_RUN=1 to compute + print without
 * sending anything.
 *
 * Exit code is 0 on a clean run (including "nothing due"); non-zero only on an
 * unexpected error, so a cron monitor sees red only for real failures.
 */

import { scanNotices } from "./BookingLedger.ts";
import { renderNoticesMarkdown } from "./Booking.ts";
import type { BookingNotice } from "./Booking.ts";
import { sendAlert } from "../../../../lib/core/AlertGate.ts";
import type { AlertResult } from "../../../../lib/core/AlertGate.ts";

// A short, stable per-event line used both as the page body and (hashed) as the
// AlertGate fingerprint, so the deadline changing re-pages but a no-op run doesn't.
function noticeLine(n: BookingNotice): string {
  const e = n.entry;
  const by = e.bookBy ? e.bookBy.slice(0, 10) : "no-deadline";
  const price = e.isFree ? "free" : `$${e.priceMin ?? "?"}`;
  return `${n.urgency.toUpperCase()} · ${e.action}: ${e.title} — book by ${by} (${price}) — ${e.link}`;
}

export interface DigestOutcome {
  total: number;
  paged: number;
  spooled: number;
  expired: number;
  notices: BookingNotice[];
  results: Array<{ eventId: string; tier: "page" | "digest"; result: AlertResult }>;
}

/**
 * Scan + route. Pure-ish: all side effects go through the injected/real
 * AlertGate. `now` and `windowDays` are injectable for tests.
 */
export async function runBookingDigest(
  now: Date = new Date(),
  windowDays = 14,
): Promise<DigestOutcome> {
  const { notices, expired } = scanNotices(now, windowDays);

  const outcome: DigestOutcome = {
    total: notices.length,
    paged: 0,
    spooled: 0,
    expired: expired.length,
    notices,
    results: [],
  };

  for (const n of notices) {
    const line = noticeLine(n);
    const immediate = n.urgency === "overdue" || n.urgency === "urgent";
    const tier: "page" | "digest" = immediate ? "page" : "digest";

    const result = await sendAlert(line, {
      key: `eventscout-booking:${n.entry.eventId}`,
      tier,
      // Fingerprint on the deadline so a shifted bookBy re-pages, a stable one doesn't.
      fingerprint: n.entry.bookBy ?? "no-deadline",
    });

    if (result === "paged") outcome.paged++;
    else if (result === "spooled") outcome.spooled++;
    outcome.results.push({ eventId: n.entry.eventId, tier, result });
  }

  return outcome;
}

// ============================================================================
// CLI
// ============================================================================

if (import.meta.main) {
  const now = new Date();
  const outcome = await runBookingDigest(now);

  // Always print the human digest so the log has the full picture.
  console.log(renderNoticesMarkdown(outcome.notices, now));
  console.log(
    `\n[booking-digest] total=${outcome.total} paged=${outcome.paged} spooled=${outcome.spooled} expired=${outcome.expired}` +
      (process.env["KAYA_ALERT_DRY_RUN"] === "1" ? " (DRY RUN — nothing sent)" : "")
  );

  process.exit(0);
}
