#!/usr/bin/env bun
/**
 * SdfcAdapter.ts — San Diego FC (MLS) → EventItem adapter via the ESPN API.
 *
 * Replaces the old `spa` source, which scraped a JS shell that never hydrated:
 * tier-1 returned 154KB of boilerplate (above the thin-content gate, so the
 * Playwright escalation never fired) and the LLM then hallucinated unrelated
 * friendlies from promo text — missing the entire MLS home schedule. This
 * adapter pulls structured fixtures from ESPN's public scoreboard API, which
 * carries exact dates, venue, and a home/away flag, so we can return ONLY home
 * matches (away games aren't San Diego events).
 *
 * Mirrors PadresAdapter: a pure mapper (unit-testable, no network) + a fetch
 * runner. fetchSdfcEvents() returns EventItem[]; it does NOT write to cache.
 *
 * API:
 *   https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard?dates=YYYYMMDD-YYYYMMDD&limit=1000
 *   San Diego FC ESPN team id = 22529. Returns league-wide events for the
 *   window; we filter to those where SDFC is the home team.
 */

import { createHash } from "crypto";
import { upsertEvents } from "../Cache.ts";
import type { EventItem } from "../types.ts";
import { utcIsoToLaIso } from "../lib/tz.ts";

// ============================================================================
// ESPN scoreboard types (minimal — only fields we use)
// ============================================================================

export interface EspnCompetitor {
  homeAway: "home" | "away";
  team: { id: string; displayName: string };
}

export interface EspnCompetition {
  venue?: { fullName?: string };
  competitors: EspnCompetitor[];
  status?: { type?: { name?: string } };
}

export interface EspnEvent {
  id: string;
  date: string; // UTC ISO, e.g. "2026-07-26T01:30Z"
  competitions: EspnCompetition[];
  links?: Array<{ href?: string }>;
  status?: { type?: { name?: string } };
}

interface EspnScoreboardResponse {
  events?: EspnEvent[];
}

// ============================================================================
// Constants
// ============================================================================

const SDFC_TEAM_ID = "22529";
const SOURCE_ID = "sandiego-fc";
const SCOREBOARD_URL =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard";
const SCHEDULE_PAGE_URL = "https://www.sandiegofc.com/schedule/";
/** How far ahead to look. MLS plays into Nov; home games can be 50+ days out
 *  (the Padres' 45-day window would miss the next SDFC home match), so widen. */
const WINDOW_DAYS = 180;

// ============================================================================
// Stable ID — canonical(title) + startDate + venue (SPEC §4.1)
// ============================================================================

function canonical(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function stableId(title: string, startDatetime: string, venue: string): string {
  const raw = `${canonical(title)}|${startDatetime}|${canonical(venue)}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// ============================================================================
// Helpers
// ============================================================================

/** True iff the event's HOME team is San Diego FC. */
export function isSdfcHome(ev: EspnEvent): boolean {
  const home = ev.competitions?.[0]?.competitors?.find((c) => c.homeAway === "home");
  return home?.team?.id === SDFC_TEAM_ID;
}

function mapStatus(name: string | undefined): "scheduled" | "cancelled" | "postponed" {
  const n = (name ?? "").toLowerCase();
  if (n.includes("cancel")) return "cancelled";
  if (n.includes("postpon")) return "postponed";
  // STATUS_SCHEDULED, STATUS_IN, STATUS_FINAL, etc. → scheduled
  return "scheduled";
}

// ============================================================================
// Core mapper — pure function, unit-testable. Assumes a SDFC home event.
// ============================================================================

export function mapMatchToEvent(ev: EspnEvent): EventItem {
  const comp = ev.competitions[0]!;
  const away = comp.competitors.find((c) => c.homeAway === "away");
  const opponent = away?.team?.displayName ?? "Opponent";

  const title = `San Diego FC vs ${opponent}`;
  const startDatetime = utcIsoToLaIso(ev.date);
  const venueName = comp.venue?.fullName ?? "Snapdragon Stadium";
  const webLink = ev.links?.find((l) => l.href)?.href ?? SCHEDULE_PAGE_URL;
  const status = mapStatus(ev.status?.type?.name ?? comp.status?.type?.name);

  return {
    id: stableId(title, startDatetime, venueName),
    title,
    startDatetime,
    allDay: false,
    venue: venueName,
    category: "sports",
    tags: ["mls", "soccer"],
    isFree: false,
    ticketUrl: webLink,
    sourceUrl: SCHEDULE_PAGE_URL,
    sources: [{ sourceId: SOURCE_ID, url: webLink }],
    performersOrTeams: title,
    fetchedAt: new Date().toISOString(),
    status,
  };
}

// ============================================================================
// Runner — fetches from ESPN and returns home-game EventItem[]
// ============================================================================

/** ESPN's `dates` param wants compact YYYYMMDD (no dashes). */
function compactDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

export async function fetchSdfcEvents(
  startDate?: string,
  endDate?: string
): Promise<EventItem[]> {
  const today = new Date();
  const end = new Date(today);
  end.setDate(today.getDate() + WINDOW_DAYS);

  const start = startDate ?? compactDate(today);
  const endStr = endDate ?? compactDate(end);

  const url = `${SCOREBOARD_URL}?dates=${start}-${endStr}&limit=1000`;
  const res = await fetch(url, {
    // ESPN's API started 403ing Mozilla-prefixed UAs from non-browser clients
    // (2026-08-20); plain curl-style UAs pass. Verified: this exact endpoint
    // returns 200 with curl/8.7.1 and 403 with the old custom Mozilla string.
    headers: { "User-Agent": "curl/8.7.1" },
  });
  if (!res.ok) {
    throw new Error(`ESPN scoreboard request failed: ${res.status} ${res.statusText} — ${url}`);
  }

  const data = (await res.json()) as EspnScoreboardResponse;
  return (data.events ?? []).filter(isSdfcHome).map(mapMatchToEvent);
}

// ============================================================================
// Script entry point
// ============================================================================

const IS_SCRIPT =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("SdfcAdapter.ts") || process.argv[1].endsWith("SdfcAdapter"));

if (IS_SCRIPT) {
  console.log(`\nFetching upcoming San Diego FC HOME matches (today → +${WINDOW_DAYS} days)...\n`);
  try {
    const events = await fetchSdfcEvents();
    upsertEvents(events);
    console.log(`Upserted ${events.length} home match(es) to cache.\n`);
    for (const e of events.slice(0, 10)) {
      console.log(`  [${e.startDatetime}] ${e.title} — ${e.venue ?? "TBD"} (${e.status})`);
    }
    console.log(`\nSource: ${SOURCE_ID} | ESPN team ${SDFC_TEAM_ID}`);
    process.exit(0);
  } catch (err) {
    console.error(`\nFATAL: ${(err as Error).message}`);
    process.exit(1);
  }
}
