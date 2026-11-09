/**
 * PadresAdapter.ts — Slice 2: MLB StatsAPI → EventItem adapter for the Padres.
 *
 * Exports:
 *   mapGameToEvent(game: MlbGame): EventItem     — pure mapper (unit-testable, no network)
 *   fetchPadresEvents(source): Promise<EventItem[]>
 *       fetches the upcoming window (today → +45 days), maps, and returns EventItem[].
 *
 * Live probe: bun Tools/Ingest.ts --source padres-mlb
 *
 * Cache integration:
 *   fetchPadresEvents() returns the EventItem[]; it does NOT write to cache.
 *   Callers (the prefetch runner) handle cache writes themselves.
 *
 * API:
 *   https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=135&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *   Padres teamId = 135
 */

import type { EventItem, EventSource } from "../types.ts";
import { utcIsoToLaIso } from "../lib/tz.ts";
import { stableId } from "./AdapterUtil.ts";

// ============================================================================
// MLB API types (minimal, only fields we use)
// ============================================================================

interface MlbTeamRef {
  id: number;
  name: string;
}

export interface MlbTeamSlot {
  team: MlbTeamRef;
}

export interface MlbStatus {
  abstractGameState: string; // "Preview" | "Live" | "Final"
  detailedState: string; // "Scheduled" | "In Progress" | "Final" | "Cancelled" | "Postponed" | ...
}

export interface MlbVenue {
  id: number;
  name: string;
}

export interface MlbGame {
  gamePk: number;
  gameDate: string; // UTC ISO: "2026-06-15T19:40:00Z"
  status: MlbStatus;
  teams: {
    away: MlbTeamSlot;
    home: MlbTeamSlot;
  };
  venue: MlbVenue;
}

interface MlbScheduleResponse {
  dates: Array<{
    date: string;
    games: MlbGame[];
  }>;
}

// ============================================================================
// Constants
// ============================================================================

const PADRES_TEAM_ID = 135;
export const SOURCE_ID = "padres-mlb";
const BASE_URL = "https://statsapi.mlb.com/api/v1/schedule";
const SCHEDULE_PAGE_URL = "https://www.mlb.com/padres/schedule";

// ============================================================================
// Status mapping
// ============================================================================

function mapStatus(status: MlbStatus): "scheduled" | "cancelled" | "postponed" {
  const detail = status.detailedState.toLowerCase();
  if (detail.includes("cancel")) return "cancelled";
  if (detail.includes("postpone")) return "postponed";
  // Preview, Scheduled, In Progress, Live, Completed Early, etc. → scheduled
  return "scheduled";
}

// ============================================================================
// Core mapper — pure function, unit-testable
// ============================================================================

export function mapGameToEvent(game: MlbGame): EventItem {
  const isPadresHome = game.teams.home.team.id === PADRES_TEAM_ID;
  const opponent = isPadresHome ? game.teams.away.team.name : game.teams.home.team.name;

  const title = isPadresHome ? `Padres vs ${opponent}` : `Padres @ ${opponent}`;

  const startDatetime = utcIsoToLaIso(game.gameDate);
  const venueName = game.venue.name;

  const sourceUrl = `${SCHEDULE_PAGE_URL}`;
  const stableSourceUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=135&gamePk=${game.gamePk}`;

  return {
    id: stableId(title, startDatetime, venueName),
    title,
    startDatetime,
    allDay: false,
    venue: venueName,
    category: "sports",
    tags: ["mlb", "baseball"],
    isFree: false,
    sourceUrl,
    sources: [{ sourceId: SOURCE_ID, url: stableSourceUrl }],
    performersOrTeams: title,
    fetchedAt: new Date().toISOString(),
    status: mapStatus(game.status),
  };
}

// ============================================================================
// Runner — fetches from the MLB API and returns EventItem[]
// ============================================================================

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function fetchPadresEvents(_source: EventSource): Promise<EventItem[]> {
  const today = new Date();
  const defaultEnd = new Date(today);
  defaultEnd.setDate(today.getDate() + 45);

  const start = formatDate(today);
  const end = formatDate(defaultEnd);

  const url = `${BASE_URL}?sportId=1&teamId=${PADRES_TEAM_ID}&startDate=${start}&endDate=${end}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`MLB StatsAPI request failed: ${res.status} ${res.statusText} — ${url}`);
  }

  const data = (await res.json()) as MlbScheduleResponse;

  const events: EventItem[] = [];
  for (const dateEntry of data.dates) {
    for (const game of dateEntry.games) {
      events.push(mapGameToEvent(game));
    }
  }

  return events;
}
