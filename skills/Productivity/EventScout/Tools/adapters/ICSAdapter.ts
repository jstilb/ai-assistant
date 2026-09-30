#!/usr/bin/env bun
/**
 * ICSAdapter.ts — Generic ICS/iCal adapter for EventScout.
 *
 * Parses a public ICS feed (e.g. a Google Calendar public URL), expands
 * recurring events within a [now, now+90d] window, filters to future-only,
 * and returns EventItem[].
 *
 * First consumer: Daylight San Diego (Google Calendar ICS feed).
 *
 * Exports:
 *   VeventOccurrence        — minimal occurrence shape (pure, no network deps)
 *   expandHorizonDays       — constant (90)
 *   isFutureWithin(start, now, horizon) — pure filter predicate
 *   mapVeventToItem(occ, source) — pure mapper, unit-testable
 *   fetchICSEvents(source)  — network-enabled fetcher
 *
 * Script mode:
 *   bun .../ICSAdapter.ts <icsUrl>
 */

import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import ical, { expandRecurringEvent } from "node-ical";
import type { VEvent } from "node-ical";
import type { EventItem, EventSource } from "../types.ts";
import { utcIsoToLaIso } from "../lib/tz.ts";
import { defaultKayaHome } from "../../../../../lib/core/KayaHome.ts";

// ============================================================================
// VeventOccurrence — minimal occurrence shape, decoupled from node-ical types
// ============================================================================

export interface VeventOccurrence {
  uid: string;
  summary: string;
  start: Date;
  end?: Date;
  location?: string;
  description?: string;
  url?: string;
}

// ============================================================================
// Constants
// ============================================================================

export const expandHorizonDays = 90;

// MAX_EVENTS (300) removed as a binding cap (Slice 6).
// ICS is a SINGLE feed — no pagination — so we just parse everything in the
// feed and let the Slice-5 withinHorizon post-filter (in ingestSource) handle
// the far-future trim. MAX_EVENTS_SAFETY is a runaway guard only: a public
// ICS feed with > 3000 events would be unusual and likely indicates a bug
// (e.g. a recurring event exploding across years). Exported so tests can verify.
export const MAX_EVENTS_SAFETY = 3000;

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * Extract a plain string from a node-ical ParameterValue.
 * ParameterValue<string> can be either a raw string or { val: string; params: ... }.
 */
function extractString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v != null && typeof v === "object" && "val" in v) {
    const obj = v as { val: unknown };
    if (typeof obj.val === "string") return obj.val;
  }
  return "";
}

/**
 * Strip HTML tags from a string and normalise whitespace.
 * Handles &amp; &lt; &gt; &quot; &apos; &#xxx; entities.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/gi, (_, code: string) =>
      String.fromCharCode(parseInt(code, 10))
    )
    .replace(/\s+/g, " ")
    .trim();
}

function canonical(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function stableId(title: string, startDatetime: string, venueOrFallback: string): string {
  const raw = `${canonical(title)}|${startDatetime}|${canonical(venueOrFallback)}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// ============================================================================
// isFutureWithin — pure predicate, exported for unit tests
// ============================================================================

/**
 * Returns true iff `start` is strictly after `now` AND on or before `horizon`.
 */
export function isFutureWithin(start: Date, now: Date, horizon: Date): boolean {
  return start.getTime() > now.getTime() && start.getTime() <= horizon.getTime();
}

// ============================================================================
// mapVeventToItem — pure mapper, no network
// ============================================================================

export function mapVeventToItem(occ: VeventOccurrence, source: EventSource): EventItem {
  const title = occ.summary.trim();
  if (!title) {
    throw new Error("[ICSAdapter] mapVeventToItem: summary is empty");
  }

  const startDatetime = utcIsoToLaIso(occ.start.toISOString());
  const endDatetime = occ.end != null ? utcIsoToLaIso(occ.end.toISOString()) : undefined;
  const venue = occ.location?.trim() || undefined;
  const ticketUrl = occ.url || undefined;

  let description: string | undefined;
  if (occ.description) {
    const stripped = stripHtml(occ.description).slice(0, 500);
    description = stripped || undefined;
  }

  const sourceUrl = occ.url || source.url;

  return {
    id: stableId(title, startDatetime, venue ?? source.url),
    title,
    startDatetime,
    endDatetime,
    allDay: false,
    venue,
    category: source.categoryHint ?? "other",
    tags: [],
    isFree: false,
    ticketUrl,
    sourceUrl,
    sources: [{ sourceId: source.id, url: occ.url || source.url }],
    description,
    fetchedAt: new Date().toISOString(),
    status: "scheduled",
  };
}

// ============================================================================
// walkVevent — converts a VEvent + rrule expansion into VeventOccurrence[]
// ============================================================================

function extractOccurrences(
  event: VEvent,
  now: Date,
  horizon: Date,
): VeventOccurrence[] {
  const uid = event.uid;
  const rawSummary = extractString(event.summary);
  const rawLocation = extractString(event.location);
  const rawDescription = extractString(event.description);
  const url = typeof event.url === "string" ? event.url : undefined;

  const duration =
    event.start != null && event.end != null
      ? event.end.getTime() - event.start.getTime()
      : 0;

  // Recurring event: use expandRecurringEvent (handles exdate + recurrence overrides)
  if (event.rrule != null) {
    const instances = expandRecurringEvent(event, {
      from: now,
      to: horizon,
      includeOverrides: true,
      excludeExdates: true,
      expandOngoing: false,
    });

    const occs: VeventOccurrence[] = [];
    for (const inst of instances) {
      const start = inst.start;
      if (!isFutureWithin(start, now, horizon)) continue;

      // Use override's summary/location/description if available
      const instSummary = extractString(inst.summary) || rawSummary;
      const instEvent = inst.event;
      const instLocation =
        extractString(instEvent.location) || rawLocation;
      const instDescription =
        extractString(instEvent.description) || rawDescription;
      const instUrl =
        typeof instEvent.url === "string" ? instEvent.url : url;

      // Compute end from duration if inst.end is not meaningful
      const instEnd =
        inst.end != null && inst.end.getTime() !== inst.start.getTime()
          ? inst.end
          : duration > 0
          ? new Date(start.getTime() + duration)
          : undefined;

      occs.push({
        uid,
        summary: instSummary,
        start,
        end: instEnd,
        location: instLocation || undefined,
        description: instDescription || undefined,
        url: instUrl,
      });
    }
    return occs;
  }

  // Non-recurring: single occurrence
  if (event.start == null) return [];
  const start = event.start;
  if (!isFutureWithin(start, now, horizon)) return [];

  return [
    {
      uid,
      summary: rawSummary,
      start,
      end: event.end ?? undefined,
      location: rawLocation || undefined,
      description: rawDescription || undefined,
      url,
    },
  ];
}

// ============================================================================
// fetchICSEvents — network-enabled fetcher
// ============================================================================

/**
 * Fetch the raw ICS text with a small bounded retry. Large public ICS feeds
 * (e.g. Google Calendar's ~1 MB basic.ics) occasionally reset the connection
 * mid-transfer ("socket connection was closed unexpectedly"); a couple of
 * retries with linear backoff make the source reliably yield instead of
 * intermittently failing the whole prefetch run.
 */
async function fetchICSText(url: string, attempts = 3, unblock = false): Promise<string> {
  if (unblock) return fetchICSTextViaUnblocker(url, attempts);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Kaya-EventScout/1.0", Accept: "text/calendar, text/plain, */*" },
      });
      if (!res.ok) {
        throw new Error(`[ICSAdapter] HTTP ${res.status} ${res.statusText} fetching "${url}"`);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 750 * (i + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ============================================================================
// Bright Data Web Unlocker — programmatic bot-wall bypass for WAF'd feeds
// ============================================================================

/** Bright Data Web Unlocker REST endpoint + the MCP-provisioned unlocker zone. */
const BRIGHTDATA_UNLOCKER_ENDPOINT = "https://api.brightdata.com/request";
const BRIGHTDATA_UNLOCKER_ZONE = "mcp_unlocker";

/**
 * Read BRIGHTDATA_API_TOKEN from `~/.claude/secrets.json`.
 *
 * Mirrors `loadApifyToken()` in ApifyAdapter — reads at call time (no caching).
 * Throws a clear error when the file is missing/malformed or the token is absent.
 */
export function loadBrightDataToken(): string {
  const secretsPath = join(defaultKayaHome(), "secrets.json");
  if (!existsSync(secretsPath)) {
    throw new Error(
      `[ICSAdapter] secrets.json not found at ${secretsPath}. ` +
        `Add BRIGHTDATA_API_TOKEN to that file to fetch unblock:true sources.`
    );
  }
  let secrets: Record<string, unknown>;
  try {
    secrets = JSON.parse(readFileSync(secretsPath, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `[ICSAdapter] Failed to parse secrets.json at ${secretsPath}: ${(err as Error).message}`
    );
  }
  const token = secrets["BRIGHTDATA_API_TOKEN"];
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error(
      `[ICSAdapter] BRIGHTDATA_API_TOKEN is missing or empty in ${secretsPath}. ` +
        `Set it to your Bright Data API token to fetch unblock:true sources.`
    );
  }
  return token.trim();
}

/**
 * Fetch raw ICS text through the Bright Data Web Unlocker REST API, with the
 * same bounded linear-backoff retry as the plain path. Used for feeds whose
 * WAF rejects datacenter fetch/curl (e.g. Songkick per-user calendars → 406).
 */
async function fetchICSTextViaUnblocker(url: string, attempts = 3): Promise<string> {
  const token = loadBrightDataToken();
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(BRIGHTDATA_UNLOCKER_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ zone: BRIGHTDATA_UNLOCKER_ZONE, url, format: "raw" }),
      });
      const body = await res.text();
      if (!res.ok) {
        throw new Error(`[ICSAdapter] Unlocker HTTP ${res.status} ${res.statusText} fetching "${url}": ${body.slice(0, 200)}`);
      }
      // The unlocker returns the upstream body verbatim; a non-calendar body
      // (e.g. a Bright Data error JSON) means the bypass failed — fail loudly.
      if (!body.includes("BEGIN:VCALENDAR")) {
        throw new Error(`[ICSAdapter] Unlocker returned non-iCal body for "${url}": ${body.slice(0, 200)}`);
      }
      return body;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 750 * (i + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchICSEvents(source: EventSource): Promise<EventItem[]> {
  const icsText = await fetchICSText(source.url, 3, source.unblock ?? false);

  const data = ical.sync.parseICS(icsText);

  const now = new Date();
  const horizon = new Date(now.getTime() + expandHorizonDays * 24 * 60 * 60 * 1000);

  const allOccs: VeventOccurrence[] = [];

  for (const key of Object.keys(data)) {
    const comp = data[key];
    if (comp == null || comp.type !== "VEVENT") continue;
    const event = comp as VEvent;

    try {
      const occs = extractOccurrences(event, now, horizon);
      allOccs.push(...occs);
    } catch (err) {
      console.warn(
        `[ICSAdapter] skipping VEVENT uid=${event.uid}: ${(err as Error).message}`
      );
    }
  }

  // Map occurrences to EventItem, drop failures
  const items: EventItem[] = [];
  for (const occ of allOccs) {
    try {
      items.push(mapVeventToItem(occ, source));
    } catch (err) {
      console.warn(
        `[ICSAdapter] skipping occurrence "${occ.summary}" (${occ.start.toISOString()}): ${
          (err as Error).message
        }`
      );
    }
  }

  // Dedup by id
  const seen = new Set<string>();
  const deduped: EventItem[] = [];
  for (const item of items) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      deduped.push(item);
    }
  }

  // Safety runaway guard — only fires if a feed somehow contains > MAX_EVENTS_SAFETY
  // occurrences (e.g. a recurring daily event expanded across many years).
  // The real horizon bounding is done by withinHorizon in ingestSource (Slice 5).
  if (deduped.length > MAX_EVENTS_SAFETY) {
    console.log(
      `[ICSAdapter] safety bound ${MAX_EVENTS_SAFETY} hit for source "${source.id}" — returning first ${MAX_EVENTS_SAFETY} (coverage may be incomplete)`
    );
    return deduped.slice(0, MAX_EVENTS_SAFETY);
  }

  return deduped;
}

// ============================================================================
// Script entry point
// ============================================================================

const IS_SCRIPT =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("ICSAdapter.ts") ||
    process.argv[1].endsWith("ICSAdapter"));

if (IS_SCRIPT) {
  const icsUrl = process.argv[2];
  if (!icsUrl) {
    console.error("Usage: bun ICSAdapter.ts <icsUrl>");
    process.exit(1);
  }

  const source: EventSource = {
    id: "ics-adhoc",
    url: icsUrl,
    name: "Ad-hoc ICS",
    fetchTier: "ics",
    pollInterval: 720,
    enabled: true,
  };

  try {
    console.log(`\nFetching ICS feed: ${icsUrl}\n`);
    const events = await fetchICSEvents(source);
    console.log(`Found ${events.length} upcoming event(s) (next ${expandHorizonDays} days):\n`);
    for (const e of events.slice(0, 10)) {
      console.log(`  [${e.startDatetime}] ${e.title} — ${e.venue ?? "no venue"}`);
    }
    if (events.length > 10) {
      console.log(`  ... and ${events.length - 10} more`);
    }
    process.exit(0);
  } catch (err) {
    console.error(`FATAL: ${(err as Error).message}`);
    process.exit(1);
  }
}
