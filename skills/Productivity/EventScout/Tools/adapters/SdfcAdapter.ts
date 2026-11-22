/**
 * SdfcAdapter.ts — San Diego FC (MLS) → EventItem adapter via the ESPN API.
 *
 * Replaces the old `spa` source, which scraped a JS shell that never hydrated:
 * tier-1 returned 154KB of boilerplate (above the thin-content gate, so the
 * Playwright escalation never fired) and the LLM then hallucinated unrelated
 * friendlies from promo text — missing the entire MLS home schedule. This
 * adapter pulls structured fixtures from ESPN's public team-schedule API, which
 * carries exact dates, venue, and a home/away flag, so we can return ONLY home
 * matches (away games aren't San Diego events).
 *
 * Mirrors PadresAdapter: a pure mapper (unit-testable, no network) + a fetch
 * runner. fetchSdfcEvents() returns EventItem[]; it does NOT write to cache.
 *
 * API (San Diego FC ESPN team id = 22529):
 *   https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/teams/22529/schedule?fixture=true
 *     → upcoming fixtures (next season once published)
 *   https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/teams/22529/schedule
 *     → current season results + scheduled matches (playoffs)
 *   We merge both, keep future SDFC HOME matches inside WINDOW_DAYS.
 *
 *   Why not the league scoreboard: since ~2026-11 ESPN answers ANY
 *   `scoreboard?dates=A-B` range (even 2 days) with 400 "Failed to get events
 *   endpoint." — only single-day queries still work, which would cost 180
 *   requests per prefetch. The team schedule is one request per feed.
 */

import type { EventItem, EventSource } from "../types.ts";
import { utcIsoToLaIso } from "../lib/tz.ts";
import { stableId } from "./AdapterUtil.ts";

// ============================================================================
// ESPN schedule event types (minimal — only fields we use)
// ============================================================================

interface EspnCompetitor {
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

interface EspnScheduleResponse {
  events?: EspnEvent[];
}

// ============================================================================
// Constants
// ============================================================================

const SDFC_TEAM_ID = "22529";
export const SOURCE_ID = "sandiego-fc";
const TEAM_SCHEDULE_URL = `https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/teams/${SDFC_TEAM_ID}/schedule`;
const SCHEDULE_PAGE_URL = "https://www.sandiegofc.com/schedule/";
/** How far ahead to look. MLS plays into Nov; home games can be 50+ days out
 *  (the Padres' 45-day window would miss the next SDFC home match), so widen. */
const WINDOW_DAYS = 180;

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
// Window selection — pure, unit-testable
// ============================================================================

/**
 * From a merged list of team-schedule events, keep SDFC HOME matches that kick
 * off between `now` and `now + windowDays`, de-duplicated by ESPN event id and
 * sorted by kickoff. Past results (the non-fixture feed) fall out here.
 */
export function selectUpcomingHome(
  events: EspnEvent[],
  now: Date,
  windowDays: number = WINDOW_DAYS,
): EspnEvent[] {
  const startMs = now.getTime();
  const endMs = startMs + windowDays * 24 * 60 * 60 * 1000;
  const seen = new Set<string>();
  const out: EspnEvent[] = [];
  for (const ev of events) {
    if (!ev?.id || seen.has(ev.id)) continue;
    const t = Date.parse(ev.date);
    if (!Number.isFinite(t) || t < startMs || t > endMs) continue;
    if (!isSdfcHome(ev)) continue;
    seen.add(ev.id);
    out.push(ev);
  }
  return out.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

// ============================================================================
// Runner — fetches from ESPN and returns home-game EventItem[]
// ============================================================================

async function fetchSchedule(url: string): Promise<EspnEvent[]> {
  const res = await fetch(url, {
    // ESPN's API started 403ing Mozilla-prefixed UAs from non-browser clients
    // (2026-08-20); plain curl-style UAs pass.
    headers: { "User-Agent": "curl/8.7.1" },
  });
  if (!res.ok) {
    throw new Error(`ESPN team schedule request failed: ${res.status} ${res.statusText} — ${url}`);
  }
  const data = (await res.json()) as EspnScheduleResponse;
  return data.events ?? [];
}

export async function fetchSdfcEvents(_source: EventSource): Promise<EventItem[]> {
  // Both feeds: `fixture=true` is the upcoming schedule (incl. next season once
  // published); the plain feed is the current season incl. any playoff match
  // that is already scheduled but not yet in the fixture list.
  const [fixtures, season] = await Promise.all([
    fetchSchedule(`${TEAM_SCHEDULE_URL}?fixture=true`),
    fetchSchedule(TEAM_SCHEDULE_URL),
  ]);
  return selectUpcomingHome([...fixtures, ...season], new Date()).map(mapMatchToEvent);
}
