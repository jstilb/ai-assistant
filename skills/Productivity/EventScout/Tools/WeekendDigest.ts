#!/usr/bin/env bun
/**
 * WeekendDigest.ts — proactive Friday weekend digest (SPEC §8 fast-follow,
 * built 2026-08-20 — the ranking-quality gate SPEC §8 waited on is now held
 * by the eventscout-markdown-first eval suite).
 *
 * Queries the (prefetch-fresh) cache for the upcoming Sat+Sun window with a
 * standing query, LLM-ranks via the normal query path, and spools ONE
 * digest-tier AlertGate message with the top picks — it rides the existing
 * morning digest, never pages. Fingerprinted on the weekend's Saturday so
 * re-runs within the same weekend don't re-spool.
 *
 * Scheduled Friday 07:35 via com.kaya.cron.eventscout-weekend-digest
 * (manifest: MEMORY/daemon/cron/manifests/eventscout-weekend-digest.yaml,
 * wrapper: bin/eventscout-weekend-digest.sh). Safe to run by hand; set
 * KAYA_ALERT_DRY_RUN=1 to compute + print without sending.
 *
 * "Query is everything": the ONLY tuning lever is WEEKEND_QUERY below —
 * there is deliberately no taste profile (SKILL.md, Ranking).
 */

import { queryHybrid } from "./Query.ts";
import { loadProfile } from "./InterestProfile.ts";
import { DEFAULT_HOME, DEFAULT_RADIUS_MILES } from "./Window.ts";
import { laDateIso, utcMsToLaParts } from "./lib/tz.ts";
import { sendAlert } from "../../../../lib/core/AlertGate.ts";
import type { AlertResult } from "../../../../lib/core/AlertGate.ts";
import type { RankedEvent } from "./Ranker.ts";
import type { QueryContext } from "./types.ts";

// ============================================================================
// Constants
// ============================================================================

/** The standing query — edit THIS to change what the digest surfaces. */
const WEEKEND_QUERY =
  "fun things to do this weekend — a varied mix across live music, dance, comedy, " +
  "arts, food, and community; favor free or cheap, social, and near Ocean Beach";

const TOP_N = 10;
const ALERT_KEY = "eventscout-weekend-digest";

// ============================================================================
// Pure helpers
// ============================================================================

function laWeekday(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

function isoAddDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The upcoming weekend as LA dates. On Saturday itself the current weekend is
 * returned (a late manual run still covers today+tomorrow); any other day
 * rolls forward to the coming Saturday.
 */
export function upcomingWeekend(now: Date): { satIso: string; sunIso: string } {
  const p = utcMsToLaParts(now.getTime());
  const today = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const satIso = isoAddDays(today, (6 - laWeekday(today) + 7) % 7);
  return { satIso, sunIso: isoAddDays(satIso, 1) };
}

function priceLabel(e: RankedEvent): string {
  if (e.isFree) return "free";
  if (e.priceMin != null && e.priceMax != null && e.priceMax !== e.priceMin)
    return `$${e.priceMin}–${e.priceMax}`;
  if (e.priceMin != null) return `$${e.priceMin}+`;
  return "";
}

function timeLabel(e: RankedEvent): string {
  if (e.allDay) return "";
  // startDatetime is stored as LA-offset ISO — the wall-clock is directly sliceable.
  const hh = parseInt(e.startDatetime.slice(11, 13), 10);
  const mm = e.startDatetime.slice(14, 16);
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}${mm === "00" ? "" : `:${mm}`}${hh < 12 ? "am" : "pm"}`;
}

function humanDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Compact spool-friendly markdown: header + top-N one-liners + footer. */
export function renderWeekendDigest(
  ranked: RankedEvent[],
  satIso: string,
  sunIso: string
): string {
  const lines: string[] = [
    `🎉 Weekend picks — ${humanDate(satIso)} + ${humanDate(sunIso)} (${ranked.length} match${ranked.length === 1 ? "" : "es"})`,
  ];
  for (const e of ranked.slice(0, TOP_N)) {
    const day = e.startDatetime.slice(0, 10) === satIso ? "Sat" : "Sun";
    const parts = [
      `${day}${timeLabel(e) ? ` ${timeLabel(e)}` : ""} — ${e.title}`,
      e.venue ?? "",
      priceLabel(e),
    ].filter(Boolean);
    lines.push(`• ${parts.join(" · ")}`);
  }
  lines.push(
    `Full list: eventscout query "this weekend" --from ${satIso} --to ${sunIso}`
  );
  return lines.join("\n");
}

// ============================================================================
// Runner
// ============================================================================

export interface WeekendDigestOutcome {
  satIso: string;
  sunIso: string;
  matches: number;
  sent: boolean;
  result?: AlertResult;
  markdown?: string;
}

export async function runWeekendDigest(now: Date = new Date()): Promise<WeekendDigestOutcome> {
  const { satIso, sunIso } = upcomingWeekend(now);

  let home = DEFAULT_HOME;
  let radiusMiles = DEFAULT_RADIUS_MILES;
  try {
    const profile = await loadProfile();
    home = { lat: profile.homeLocation.lat, lng: profile.homeLocation.lng };
    radiusMiles = profile.defaultRadiusMiles;
  } catch {
    // profile is optional config — fall back to defaults
  }

  const [sy, sm, sd] = satIso.split("-").map((n) => parseInt(n, 10));
  const [ey, em, ed] = sunIso.split("-").map((n) => parseInt(n, 10));
  const context: QueryContext = {
    rawQuery: WEEKEND_QUERY,
    window: {
      start: laDateIso(sy!, sm!, sd!, 0, 0, 0),
      end: laDateIso(ey!, em!, ed!, 23, 59, 59),
    },
    home,
    radiusMiles,
  };

  // Cache-first (no refresh) — the daily prefetch keeps the cache current.
  const result = await queryHybrid(context);
  const ranked = result.rankedEvents;

  if (ranked.length === 0) {
    // Nothing this weekend → send nothing (an empty digest is noise), but log.
    console.log(`[weekend-digest] 0 matches for ${satIso}..${sunIso} — nothing spooled`);
    return { satIso, sunIso, matches: 0, sent: false };
  }

  const markdown = renderWeekendDigest(ranked, satIso, sunIso);
  const alertResult = await sendAlert(markdown, {
    key: ALERT_KEY,
    tier: "digest",
    // One spool per weekend: re-runs (manual or retried cron) share the
    // fingerprint and are edge-trigger-deduped by AlertGate.
    fingerprint: satIso,
  });
  return {
    satIso,
    sunIso,
    matches: ranked.length,
    sent: alertResult === "spooled" || alertResult === "paged",
    result: alertResult,
    markdown,
  };
}

// ============================================================================
// CLI
// ============================================================================

if (import.meta.main) {
  const outcome = await runWeekendDigest(new Date());
  if (outcome.markdown) console.log(outcome.markdown);
  console.log(
    `\n[weekend-digest] weekend=${outcome.satIso}..${outcome.sunIso} matches=${outcome.matches} ` +
      `sent=${outcome.sent}${outcome.result ? ` (${outcome.result})` : ""}` +
      (process.env["KAYA_ALERT_DRY_RUN"] === "1" ? " (DRY RUN — nothing sent)" : "")
  );
  process.exit(0);
}
