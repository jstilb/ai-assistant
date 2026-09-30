#!/usr/bin/env bun
/**
 * ApifyHealth.ts — per-source streak counters for EventScout's Apify-tier
 * ingest path (T2-09, plans/audits/remediation/theme2-eventscout-apify-escalation.md).
 *
 * WHY: `ApifyAdapter.fetchApifyEvents()` is correctly fail-loud (throws on
 * TIMED-OUT/bad status/empty dataset), but `Ingest.ts`'s per-source worker
 * loop caught every one of those throws into an in-memory
 * `IngestResult.failureReasons` map that only ever reached `console.error` —
 * never FailureLog, never AlertGate. A 15-day live-log audit found both
 * Apify sources (`sandiego-org-events`, `bandsintown-sd`) silently degraded
 * on 5/15 days each (33%) with zero trace beyond an unmonitored log file.
 * This module closes that gap with two independent per-source streaks:
 *
 *   - hard-failure streak (the fetch threw)      → PAGE   at streak >= 3
 *   - zero-result streak (resolved, 0 events)     → DIGEST at streak >= 3
 *
 * Both streaks reset to 0 ONLY on a genuine success (events.length > 0) for
 * that source — exactly what the source plan's §5 table specifies ("both
 * counters reset to 0 on any run that returns events.length > 0"). A run
 * that does NOT match a given channel leaves that channel's streak file
 * completely UNTOUCHED (neither incremented nor reset) unless it was a
 * success.
 *
 * This deliberately does NOT reuse FailStreak.ts's `trackFailStreak()` doc
 * comment's "ANY other outcome resets the streak" precedent, even though it
 * looks superficially similar. That precedent is for ONE streak tracking ONE
 * failure signature, where a different outcome is genuine evidence the
 * problem cleared. Here, hard-failure and zero-result are TWO SYMPTOMS OF
 * THE SAME ROOT CAUSE — a degrading Apify source (Cloudflare/proxy issues
 * can manifest as either a thrown timeout or a resolved-empty response from
 * one day to the next; see the source plan's own 07-04/07-08 same-day
 * dual-source observation). A source that alternates hard-fail / zero-result
 * / hard-fail / zero-result forever is NOT recovering between occurrences —
 * it is failing every single day. If either channel reset on the other's
 * occurrence (an earlier version of this file did exactly that), such a
 * source would never reach threshold in EITHER channel, silently defeating
 * the entire point of this slice. Only a genuine success — the fetch
 * actually returning events — is real evidence of health, so only that
 * clears either counter. See `ApifyHealth.test.ts`'s alternating-pattern
 * regression test for the failing case this closes.
 *
 * Zero-result is deliberately never allowed to page: a source *could*
 * legitimately have nothing on for a day, so the false-positive cost is
 * capped at one digest line, never an interruption.
 *
 * NO ADDED SPEND: this module never calls fetchApifyEvents() or any other
 * network/paid API — it only runs AFTER Ingest.ts's per-source fetch has
 * already resolved or thrown, and its own state (streak counters, the
 * forensic JSONL line, the alert dispatch) is pure local I/O.
 *
 * Reuse, not reinvention:
 *   - Hard-failure streak uses `trackHealStreak()` (lib/cron/FailStreak.ts)
 *     verbatim — it already owns "binary needs-healing → page at threshold"
 *     with an injectable cooldown and sendAlertFn, so the page-tier half of
 *     this module is a pure "connect existing pipes" call, no new escalation
 *     logic invented.
 *   - Zero-result streak uses FailStreak.ts's own low-level
 *     `readFailStreak`/`writeFailStreak`/`HEAL_ESCALATE_THRESHOLD` directly.
 *     `trackHealStreak()` cannot be reused here as-is: it unconditionally
 *     sends with `tier: 'page'` (see its implementation), and this channel
 *     must never page. Dispatching through FailureLog.recordFailure()'s own
 *     tier routing instead reuses that existing digest/log bridge rather
 *     than adding a second "trackHealStreak but digest" mechanism — digest
 *     tier also has no cooldown concept in AlertGate (every digest-tier
 *     `send()` call spools unconditionally — confirmed by reading
 *     AlertGate.ts's `send()`), so there is nothing for a cooldownMs
 *     parameter to do here.
 *
 * Forensic trail: every hard-failure and zero-result occurrence gets exactly
 * one `recordFailure()` JSONL line (tier 'log' below threshold, escalating
 * to 'page'/'digest' at threshold) — a clean success writes nothing (it is
 * not a failure). The hard-failure branch's `recordFailure()` call is always
 * tier 'log', deliberately never 'page': `trackHealStreak()` above already
 * owns the one-and-only page dispatch for that channel, so routing this
 * call's tier to 'page' too would double-fire the alert.
 */

import {
  trackHealStreak,
  readFailStreak,
  writeFailStreak,
  HEAL_ESCALATE_THRESHOLD,
  type FailStreakResult,
} from "../../../../lib/cron/FailStreak.ts";
import { recordFailure } from "../../../../lib/core/FailureLog.ts";
import { sendAlert } from "../../../../lib/core/AlertGate.ts";

/**
 * Page-tier cooldown for the hard-failure channel. The live schedule is
 * confirmed 1 run/day (bin/eventscout-prefetch.sh, 14:00 daily plist —
 * see this slice's source plan §1). 12h is deliberately HALF that cadence,
 * not the AlertGate default (24h): it guarantees any reasonable cron-time
 * drift between consecutive daily runs can never accidentally land inside
 * a still-open 24h cooldown window and silently skip a full day's page
 * while the source stays dead, while still being long enough that an
 * accidental same-day manual re-run (`bun cli.ts prefetch`) doesn't double-page.
 */
export const APIFY_HARD_FAIL_PAGE_COOLDOWN_MS = 12 * 60 * 60 * 1000;

export type ApifySourceOutcome =
  | { readonly kind: "hard-fail"; readonly error: unknown }
  | { readonly kind: "zero-result" }
  | { readonly kind: "success"; readonly count: number };

export interface ApifyHealthResult {
  /** Hard-failure (page-tier) streak outcome, straight from trackHealStreak(). */
  hardFail: FailStreakResult;
  /** Zero-result (digest-tier) streak count after this run (0 = just reset). */
  zeroResultStreak: number;
  /** Tier the zero-result channel routed to THIS run ('digest' only at threshold). */
  zeroResultTier: "log" | "digest";
}

function hardFailAlertKey(sourceId: string): string {
  return `eventscout-apify-fail-${sourceId}`;
}

function zeroResultAlertKey(sourceId: string): string {
  return `eventscout-apify-zero-${sourceId}`;
}

/**
 * Read-only view of a streak file for a channel this run did NOT touch
 * (see this module's top-of-file doc: a non-matching, non-success outcome
 * leaves the OTHER channel's file completely alone). Reports the streak's
 * current on-disk value without mutating it or dispatching anything —
 * 'reset' when it's 0, 'below-threshold' otherwise (it can never already be
 * 'paged' territory without this same function having been in the
 * increment path on a prior call, which would have returned that verdict
 * then; this call is purely a passthrough report of "what's there now").
 */
function peekStreak(target: string): FailStreakResult {
  const streak = readFailStreak(target);
  return streak > 0 ? { action: "below-threshold", streak } : { action: "reset" };
}

/**
 * Update both per-source streaks for one ingest run and route the
 * escalation. Call once per apify-tier source per `ingestAllCore()` run,
 * after the fetch has resolved or thrown — never before, and never more
 * than once per source per run (each call is one "day"/one cron fire's
 * worth of streak movement).
 *
 * `sendAlertFn` is injectable (default: the real AlertGate bridge) so tests
 * can assert exactly what would have been sent without touching the network
 * — mirrors FailStreak.test.ts's `fakeSendAlert` convention.
 */
export async function trackApifySourceHealth(
  sourceId: string,
  sourceUrl: string,
  outcome: ApifySourceOutcome,
  sendAlertFn: typeof sendAlert = sendAlert,
): Promise<ApifyHealthResult> {
  const isHardFail = outcome.kind === "hard-fail";
  const isZeroResult = outcome.kind === "zero-result";
  const isSuccess = outcome.kind === "success";

  // --- Hard-failure channel (page-tier) ------------------------------------
  // Only touched (incremented or reset) on a hard-fail or a genuine success.
  // A zero-result run is NOT evidence this channel recovered — see top-of-
  // file doc — so it leaves this streak file completely untouched.
  const hardFailKey = hardFailAlertKey(sourceId);
  const hardFail = isZeroResult
    ? peekStreak(hardFailKey)
    : await trackHealStreak(
        hardFailKey,
        isHardFail,
        (streak) =>
          `EventScout Apify source "${sourceId}" (${sourceUrl}) has hard-failed ${streak} ` +
          `consecutive ingest runs — likely dead (timeout, bad actor status, or empty content). ` +
          `A blind retry will not fix this; needs investigation. See ` +
          `MEMORY/MONITORING/failure-log.jsonl (source="EventScout:ApifyIngest") for the per-run errors.`,
        hardFailKey,
        APIFY_HARD_FAIL_PAGE_COOLDOWN_MS,
        sendAlertFn,
      );
  if (isHardFail) {
    // trackHealStreak() above already owns the one-and-only page dispatch
    // for this channel (via sendAlertFn, tier: 'page' internally) — this
    // recordFailure() call is deliberately always tier 'log' (forensic-only)
    // so the same occurrence is never double-alerted.
    const streak =
      hardFail.action === "below-threshold" || hardFail.action === "paged"
        ? hardFail.streak
        : 0;
    recordFailure({
      source: "EventScout:ApifyIngest",
      error: outcome.error,
      context: { sourceId, url: sourceUrl, channel: "hard-fail", streak },
      tier: "log",
      alertKey: hardFailKey,
    });
  }

  // --- Zero-result channel (digest-tier, never pages) ----------------------
  // Only touched (incremented or reset) on a zero-result or a genuine
  // success. A hard-fail run is NOT evidence this channel recovered — see
  // top-of-file doc — so it leaves this streak file completely untouched.
  const zeroKey = zeroResultAlertKey(sourceId);
  let zeroResultStreak: number;
  if (isZeroResult) {
    zeroResultStreak = readFailStreak(zeroKey) + 1;
    writeFailStreak(zeroKey, zeroResultStreak);
  } else if (isSuccess) {
    zeroResultStreak = 0;
    writeFailStreak(zeroKey, 0);
  } else {
    zeroResultStreak = readFailStreak(zeroKey); // hard-fail run: leave untouched
  }
  const zeroResultTier: "log" | "digest" =
    isZeroResult && zeroResultStreak >= HEAL_ESCALATE_THRESHOLD ? "digest" : "log";
  if (isZeroResult) {
    recordFailure({
      source: "EventScout:ApifyIngest",
      error: undefined,
      context: {
        sourceId,
        url: sourceUrl,
        channel: "zero-result",
        streak: zeroResultStreak,
        note: "0 events, no exception",
      },
      tier: zeroResultTier,
      alertKey: zeroKey,
      alertMessage:
        `EventScout Apify source "${sourceId}" (${sourceUrl}) has returned 0 events on ` +
        `${zeroResultStreak} consecutive ingest runs with no thrown error — this source normally ` +
        `returns well above zero, so this may be silently broken rather than genuinely quiet. ` +
        `Digest-only: never pages on zero-result alone.`,
    });
  }

  return { hardFail, zeroResultStreak, zeroResultTier };
}
