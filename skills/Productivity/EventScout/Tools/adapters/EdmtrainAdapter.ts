#!/usr/bin/env bun
/**
 * EdmtrainAdapter.ts — EDM Train San Diego listings via api.edmtrain.com → EventItem.
 *
 * STATUS: wired but DORMANT — edmtrain-sd currently runs `fetchTier: "spa"`,
 * which works since the 2026-08-20 tier-3 stealth render (74 events extracted
 * live through the full pipeline). This adapter is the PREFERRED upgrade the
 * day a key exists: exact structured data, no browser, no LLM windows.
 * To switch: add the key (below), then set the source's fetchTier to "api"
 * (the Ingest api-tier dispatch already routes edmtrain-sd here).
 *
 *   GET https://edmtrain.com/api/locations?state=california&city=san+diego&client=KEY
 *   GET https://edmtrain.com/api/events?locationIds=ID&client=KEY
 *
 * KEY is the free developer key from https://edmtrain.com/developer-api —
 * signup is human-only (NEEDS-JM, optional optimization). It lives as
 * EDMTRAIN_API_KEY in ~/.claude/secrets.json; a missing key throws LOUDLY.
 *
 * Exact structured data (venue with lat/lng, artist lineup, date, ages) — an
 * `api`-tier source: no browser, no LLM, exempt from fuzzy dedup. EDMTrain
 * carries NO price data: isFree=false with no price (unknown ≠ free).
 *
 * Mirrors RaCoAdapter: pure mappers + a fetch runner that returns EventItem[]
 * and does NOT write cache.
 */

import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { defaultKayaHome } from "../../../../../lib/core/KayaHome.ts";
import type { EventItem } from "../types.ts";
import { naiveLaToUtcMs, utcIsoToLaIso } from "../lib/tz.ts";

// ============================================================================
// Constants
// ============================================================================

const SOURCE_ID = "edmtrain-sd";
const API_BASE = "https://edmtrain.com/api";
const LISTINGS_PAGE_URL = "https://edmtrain.com/san-diego";
const FETCH_TIMEOUT_MS = 30_000;

// ============================================================================
// API types (only the fields we use)
// ============================================================================

export interface EdmtrainEvent {
  id: number;
  /** Event page on edmtrain.com */
  link: string | null;
  /** Often null — the artist lineup IS the title for club shows */
  name: string | null;
  ages: string | null;
  festivalInd: boolean;
  /** "2026-08-21" */
  date: string;
  /** "22:00:00" or null */
  startTime: string | null;
  endTime: string | null;
  venue: {
    name: string;
    /** "San Diego, CA" */
    location: string;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
  artistList: Array<{ name: string }> | null;
}

interface EdmtrainResponse<T> {
  success?: boolean;
  data?: T;
  message?: string;
}

// ============================================================================
// Key loading — EDMTRAIN_API_KEY from ~/.claude/secrets.json
// ============================================================================

/** Mirrors loadBrightDataToken() in ICSAdapter — read at call time, fail loud. */
export function loadEdmtrainKey(): string {
  const secretsPath = join(defaultKayaHome(), "secrets.json");
  if (!existsSync(secretsPath)) {
    throw new Error(
      `[Edmtrain] secrets.json not found at ${secretsPath}. ` +
        `Add EDMTRAIN_API_KEY (free key: https://edmtrain.com/developer-api).`
    );
  }
  let secrets: Record<string, unknown>;
  try {
    secrets = JSON.parse(readFileSync(secretsPath, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `[Edmtrain] Failed to parse secrets.json at ${secretsPath}: ${(err as Error).message}`
    );
  }
  const key = secrets["EDMTRAIN_API_KEY"];
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error(
      `[Edmtrain] EDMTRAIN_API_KEY is missing or empty in ${secretsPath}. ` +
        `Sign up for the free key at https://edmtrain.com/developer-api (NEEDS-JM), ` +
        `then set fetchTier: "api" on the "${SOURCE_ID}" source.`
    );
  }
  return key.trim();
}

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
// Pure mappers
// ============================================================================

/** "22:00:00" + "2026-08-21" → LA-offset ISO; null time → null. */
export function edmtrainTimeToLaIso(date: string, time: string | null): string | null {
  if (!time || !/^\d{2}:\d{2}(:\d{2})?$/.test(time)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const naive = `${date}T${time.length === 5 ? `${time}:00` : time}`;
  return utcIsoToLaIso(new Date(naiveLaToUtcMs(naive)).toISOString());
}

/**
 * Map one EDMTrain event to an EventItem. Pure — `fetchedAt` injected.
 * Returns null for rows missing essentials (date, and a name or lineup).
 */
export function mapEdmtrainEventToItem(e: EdmtrainEvent, fetchedAt: string): EventItem | null {
  if (!e.date || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) return null;
  const artists = (e.artistList ?? []).map((a) => a.name.trim()).filter(Boolean);
  const title = e.name?.trim() || artists.join(", ");
  if (!title) return null;

  const start = edmtrainTimeToLaIso(e.date, e.startTime);
  const allDay = start == null;
  const startDatetime = start ?? edmtrainTimeToLaIso(e.date, "00:00:00");
  if (!startDatetime) return null;

  const venue = e.venue?.name?.trim() ?? "";
  const eventUrl = e.link?.trim() || LISTINGS_PAGE_URL;
  const ages = e.ages?.trim().toLowerCase();

  const tags = ["electronic", "nightlife", "edmtrain"];
  if (ages) tags.push(ages);
  if (e.festivalInd) tags.push("festival");

  const item: EventItem = {
    id: stableId(title, startDatetime, venue),
    title,
    startDatetime,
    allDay,
    category: e.festivalInd ? "festival" : "music",
    tags,
    // EDMTrain carries no price data — unknown, never assumed free.
    isFree: false,
    ticketUrl: eventUrl,
    sourceUrl: eventUrl,
    sources: [{ sourceId: SOURCE_ID, url: eventUrl }],
    fetchedAt,
    status: "scheduled",
  };
  if (venue) item.venue = venue;
  const address = e.venue?.address?.trim() || e.venue?.location?.trim();
  if (address) item.address = address;
  if (typeof e.venue?.latitude === "number" && typeof e.venue?.longitude === "number") {
    item.lat = e.venue.latitude;
    item.lng = e.venue.longitude;
  }
  const end = edmtrainTimeToLaIso(e.date, e.endTime);
  if (end) item.endDatetime = end;
  if (artists.length > 0) item.performersOrTeams = artists.join(", ");
  return item;
}

// ============================================================================
// Fetch runner
// ============================================================================

async function apiGet<T>(path: string, key: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${API_BASE}${path}${path.includes("?") ? "&" : "?"}client=${encodeURIComponent(key)}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`[Edmtrain] HTTP ${res.status} ${res.statusText} for ${path}`);
    const body = (await res.json()) as EdmtrainResponse<T>;
    if (body.success === false || body.data === undefined) {
      throw new Error(`[Edmtrain] API error for ${path}: ${body.message ?? "no data"}`);
    }
    return body.data;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchEdmtrainEvents(): Promise<EventItem[]> {
  const key = loadEdmtrainKey();

  const locations = await apiGet<Array<{ id: number; city: string | null }>>(
    "/locations?state=california&city=san%20diego",
    key
  );
  const sd = locations.find((l) => l.city?.toLowerCase() === "san diego") ?? locations[0];
  if (!sd) throw new Error("[Edmtrain] locations API returned no San Diego location");

  const events = await apiGet<EdmtrainEvent[]>(`/events?locationIds=${sd.id}`, key);
  const fetchedAt = new Date().toISOString();
  const byId = new Map<string, EventItem>();
  for (const e of events) {
    const item = mapEdmtrainEventToItem(e, fetchedAt);
    if (item) byId.set(item.id, item);
  }
  console.log(`[Edmtrain] ${events.length} listings → ${byId.size} events (location ${sd.id})`);
  return [...byId.values()];
}
