#!/usr/bin/env bun
/**
 * SPAAdapter.ts — Slice 4: JS SPA venue page → EventItem adapter.
 *
 * Two separable, independently-testable parts:
 *
 *   normalizeExtracted(raw: unknown[], source: EventSource): EventItem[]
 *       PURE FUNCTION — deterministic, testable.
 *       Takes the LLM's raw extracted array, validates/coerces each object to
 *       EventItem (via EventItemSchema), drops invalid entries, and sets:
 *         - category from source.categoryHint when the raw object has none
 *         - sources: [{ sourceId: source.id, url: source.url }]
 *         - sourceUrl: source.url
 *         - status: "scheduled" (default)
 *         - allDay: false (default)
 *         - isFree: coerced boolean (defaults false)
 *         - tags: [] if missing
 *         - fetchedAt: ISO timestamp of normalization time
 *         - id: deterministic SHA-256(title|startDatetime|venue) hex[:16]
 *       startDatetime is validated — entries with unparseable dates are dropped.
 *
 *   fetchSPAEvents(source: EventSource): Promise<EventItem[]>
 *       Fetches the SPA page (BrightData tier-1/2 first, then Playwright tier-3
 *       if needed) → page markdown/HTML → calls lib/core/Inference.ts (standard)
 *       with a strict JSON extraction prompt → parses JSON robustly (handles
 *       code-fences and prose wrappers) → normalizeExtracted.
 *
 * Fetch strategy:
 *   BrightDataTool is used with skipBrowser: false so Playwright (tier 3) fires
 *   for JS SPAs. Tier 4 (BrightData API key) is not used since we have no key.
 *   If BrightData returns empty content on tier-1/2 we rely on tier-3 Playwright.
 */

import { createHash } from "crypto";
import { inference } from "../../../../../lib/core/Inference.ts";
// cross-skill-allowed: adapter wraps Data/BrightData's fetch client by design — thin adapter over a shared client (tier-1/2/3 fetch strategy)
import { BrightDataTool } from "../../../../Data/BrightData/Tools/BrightDataTool.ts";
import { extractJsonLdEvents } from "./JsonLd.ts";
import { EventItemSchema, CategorySchema } from "../types.ts";
import type { EventItem, EventSource, Category } from "../types.ts";
import { z } from "zod";
import { isNaiveDatetime, naiveLaToUtcMs, utcIsoToLaIso, utcMsToLaParts } from "../lib/tz.ts";
import { withinHorizon, horizonDays } from "../Horizon.ts";

// ============================================================================
// Stable ID — mirrors PadresAdapter + RSSAdapter convention (SPEC §4.1)
// ============================================================================

function canonical(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function stableId(title: string, startDatetime: string, venueOrUrl: string): string {
  // Normalise startDatetime to UTC ISO before hashing so that an offset-aware
  // string ("-07:00") and a naive string converted to the same LA wall-clock
  // both produce the same id.
  const utcNorm = (() => {
    const ms = Date.parse(startDatetime);
    return isNaN(ms) ? startDatetime : new Date(ms).toISOString();
  })();
  const raw = `${canonical(title)}|${utcNorm}|${canonical(venueOrUrl)}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// ============================================================================
// Raw LLM output schema — permissive input, strict output
// ============================================================================

/**
 * Permissive schema for what the LLM might return per event.
 * Required: title (string), startDatetime (string parseable as a date).
 * All other fields are optional.
 */
const RawEventSchema = z.object({
  title: z.string().min(1),
  startDatetime: z.string().min(1),
  endDatetime: z.string().optional(),
  venue: z.string().optional(),
  description: z.string().optional(),
  ticketUrl: z.string().optional(),
  isFree: z.union([z.boolean(), z.string(), z.number()]).optional(),
  priceMin: z.number().optional(),
  priceMax: z.number().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  imageUrl: z.string().optional(),
  performersOrTeams: z.string().optional(),
});

type RawEvent = z.infer<typeof RawEventSchema>;

// ============================================================================
// Date coercion — validates + normalises startDatetime
// ============================================================================

/**
 * Attempt to parse a raw datetime string into an offset-aware ISO 8601 string.
 *
 * Accepts:
 *   - Offset-aware ISO 8601 ("2026-06-05T19:00:00-07:00") → same instant, re-emitted as LA-offset ISO
 *   - UTC ISO 8601 ("2026-06-06T02:00:00Z") → same instant, re-emitted as LA-offset ISO
 *   - NAIVE datetime ("2026-06-05T19:00:00", no Z, no offset) → treated as
 *     America/Los_Angeles local time and converted to the correct UTC-equivalent
 *     offset-aware ISO string (e.g. "2026-06-05T19:00:00-07:00").
 *   - Date-only ("2026-06-05") → treated as LA local midnight
 *   - "Month DD, YYYY HH:MM AM/PM" (common venue calendar format) → parsed via
 *     Date.parse as UTC (these are already locale-ambiguous; no better signal)
 *
 * Returns null if the date is completely unparseable (NaN) — callers drop the event.
 *
 * Why naive → LA:
 *   Venue pages served from America/Los_Angeles display local times without offsets.
 *   Treating a naive "7:00 PM" as UTC would silently shift it 7–8 hours (PDT/PST),
 *   producing incorrect UTC instants and broken date-filter results.
 */
function coerceToIso(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Fast path: offset-aware or Z strings — parse normally, re-emit as
  // LA-offset ISO. The instant is preserved exactly; only the representation
  // is normalized, because EventItem.startDatetime is "ISO 8601,
  // America/Los_Angeles" (SPEC §4.1) and a UTC-Z string renders a 7 PM class
  // as "T02:00" wherever the raw value is displayed (e.g. Wix pages embed
  // correct -07:00 timestamps that a Z round-trip used to obscure).
  if (!isNaiveDatetime(trimmed)) {
    const ts = Date.parse(trimmed);
    if (isNaN(ts)) return null;
    return utcIsoToLaIso(new Date(ts).toISOString());
  }

  // Naive path: no timezone designator.
  // Treat as America/Los_Angeles local time.

  // Date-only strings ("YYYY-MM-DD") → LA local midnight.
  // naiveLaToUtcMs handles both "YYYY-MM-DD" and "YYYY-MM-DDTHH:MM:SS" forms
  // because appending "Z" to "YYYY-MM-DDZ" gives a valid UTC midnight parse,
  // and the offset correction moves it to LA midnight.
  const utcMs = naiveLaToUtcMs(trimmed);
  if (isNaN(utcMs)) return null;

  // Convert the resolved UTC instant to an LA offset-aware ISO string so that
  // the stored value carries the correct wall-clock time visibly.
  return utcIsoToLaIso(new Date(utcMs).toISOString());
}

// ============================================================================
// Category coercion
// ============================================================================

function coerceCategory(raw: string | undefined, hint: Category | undefined): Category {
  if (raw) {
    const parsed = CategorySchema.safeParse(raw.toLowerCase().trim());
    if (parsed.success) return parsed.data;
  }
  return hint ?? "other";
}

// ============================================================================
// isFree coercion
// ============================================================================

function coerceIsFree(raw: boolean | string | number | undefined): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw === 0;
  if (typeof raw === "string") {
    const lower = raw.toLowerCase().trim();
    return lower === "true" || lower === "yes" || lower === "free";
  }
  return false;
}

// ============================================================================
// normalizeExtracted — PURE FUNCTION, deterministic core
// ============================================================================

/**
 * Validate and coerce an array of raw LLM-extracted objects into EventItems.
 *
 * Drops any entry that:
 *   - Fails the permissive RawEventSchema (missing title, etc.)
 *   - Has a completely unparseable startDatetime
 *
 * @param raw    - Raw array from LLM JSON output (unknown[]).
 * @param source - The EventSource that was scraped.
 * @returns      - Array of valid EventItems; may be empty.
 */
export function normalizeExtracted(raw: unknown[], source: EventSource): EventItem[] {
  const now = new Date().toISOString();
  const results: EventItem[] = [];
  let droppedInvalidShape = 0;
  let droppedUnparseableDate = 0;
  let droppedFinalSchema = 0;

  for (const entry of raw) {
    // Step 1: permissive schema parse (catches missing title, wrong types, etc.)
    const rawParsed = RawEventSchema.safeParse(entry);
    if (!rawParsed.success) {
      // Drop — missing required field or wrong shape
      droppedInvalidShape++;
      continue;
    }
    const r: RawEvent = rawParsed.data;

    // Step 2: date validation — drop if unparseable
    const startDatetime = coerceToIso(r.startDatetime);
    if (startDatetime === null) {
      // Drop — can't make sense of the date. This is observable (not silent):
      // logged individually so a source that's systematically emitting
      // unparseable dates (e.g. year-less captions the extraction prompt
      // failed to resolve) is visible in prefetch/refresh logs, not just a
      // lower-than-expected final count.
      droppedUnparseableDate++;
      console.warn(
        `[SPAAdapter] normalizeExtracted (${source.id}): dropping "${r.title}" — ` +
        `unparseable startDatetime "${r.startDatetime}"`
      );
      continue;
    }

    // Step 3: optional endDatetime
    const endDatetime =
      r.endDatetime ? (coerceToIso(r.endDatetime) ?? undefined) : undefined;

    // Step 4: category
    const category = coerceCategory(r.category, source.categoryHint);

    // Step 5: isFree
    const isFree = coerceIsFree(r.isFree);

    // Step 6: stable id
    const venueOrUrl = r.venue ?? source.url;
    const id = stableId(r.title, startDatetime, venueOrUrl);

    // Step 7: assemble EventItem
    const item: EventItem = {
      id,
      title: r.title,
      startDatetime,
      ...(endDatetime !== undefined && { endDatetime }),
      allDay: false,
      ...(r.venue !== undefined && { venue: r.venue }),
      category,
      tags: r.tags ?? [],
      isFree,
      ...(r.priceMin !== undefined && { priceMin: r.priceMin }),
      ...(r.priceMax !== undefined && { priceMax: r.priceMax }),
      ...(r.ticketUrl !== undefined && { ticketUrl: r.ticketUrl }),
      sourceUrl: source.url,
      sources: [{ sourceId: source.id, url: source.url }],
      ...(r.performersOrTeams !== undefined && { performersOrTeams: r.performersOrTeams }),
      ...(r.description !== undefined && { description: r.description }),
      ...(r.imageUrl !== undefined && { imageUrl: r.imageUrl }),
      fetchedAt: now,
      status: "scheduled",
    };

    // Step 8: final schema validation (defence-in-depth)
    const validated = EventItemSchema.safeParse(item);
    if (!validated.success) {
      // This shouldn't happen if our coercions are correct, but log and drop
      droppedFinalSchema++;
      console.warn("[SPAAdapter] assembled item failed EventItemSchema:", validated.error.issues);
      continue;
    }

    results.push(validated.data);
  }

  // Visible drop-count summary — never let a source silently lose events.
  // A large gap between raw.length and results.length with no log line was
  // exactly how the year-less-date extraction bug went undetected (only 1 of
  // ~5 events on majestyinmotion-events survived normalizeExtracted).
  const totalDropped = droppedInvalidShape + droppedUnparseableDate + droppedFinalSchema;
  if (totalDropped > 0) {
    console.warn(
      `[SPAAdapter] normalizeExtracted (${source.id}): dropped ${totalDropped}/${raw.length} raw entr${totalDropped === 1 ? "y" : "ies"} ` +
      `(${droppedInvalidShape} invalid shape, ${droppedUnparseableDate} unparseable date, ${droppedFinalSchema} failed final schema) — ` +
      `${results.length} survived`
    );
  }

  return results;
}

// ============================================================================
// JSON extraction from LLM output — robust, handles code-fences + prose
// ============================================================================

/**
 * Extract a JSON array from LLM text output.
 *
 * Strategies (in order):
 *   1. Direct JSON.parse (clean response)
 *   2. Strip ```json ... ``` code fences
 *   3. Greedy array extraction: find first '[' and matching ']'
 *
 * Returns an empty array if no valid JSON array is found.
 */
function extractJsonArray(text: string): unknown[] {
  const trimmed = text.trim();

  // Strategy 1: direct parse
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {}

  // Strategy 2: code fence strip
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }

  // Strategy 3: greedy bracket match
  const openIdx = trimmed.indexOf("[");
  if (openIdx !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    let closeIdx = -1;

    for (let i = openIdx; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\" && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) { closeIdx = i; break; }
      }
    }

    if (closeIdx !== -1) {
      try {
        const parsed = JSON.parse(trimmed.slice(openIdx, closeIdx + 1));
        if (Array.isArray(parsed)) return parsed;
      } catch {}
    }
  }

  return [];
}

// ============================================================================
// Pure helpers — content chunking, page-URL building, id dedup (testable)
// ============================================================================

/**
 * Split fetched page content into overlapping windows for LLM extraction.
 *
 * Listing pages routinely exceed the per-call snippet size (the LLM only sees
 * the first `chunkSize` chars). Many pages also front-load boilerplate, pushing
 * real events past the first window entirely. Chunking covers more of the page;
 * `overlap` keeps events that straddle a boundary intact (dedup by id removes
 * the duplicate copy).
 *
 * Behaviour:
 *   - content.length <= chunkSize → returns [content] (identical to the old
 *     single-slice behaviour — a strict superset, never fewer events).
 *   - otherwise → up to `maxChunks` windows of `chunkSize`, advancing by
 *     (chunkSize - overlap) each step.
 *
 * PURE — deterministic, no I/O.
 */
export function chunkContent(
  content: string,
  chunkSize: number,
  maxChunks: number,
  overlap: number,
): string[] {
  if (content.length <= chunkSize) return [content];
  const stride = Math.max(1, chunkSize - overlap);
  const chunks: string[] = [];
  for (let start = 0; start < content.length && chunks.length < maxChunks; start += stride) {
    chunks.push(content.slice(start, start + chunkSize));
  }
  return chunks;
}

/**
 * Build a paginated URL by setting a query-string parameter to `page`.
 * Preserves any existing query params on the base URL.
 *
 * PURE — deterministic, no I/O.
 */
export function buildPageUrl(baseUrl: string, param: string, page: number): string {
  const u = new URL(baseUrl);
  u.searchParams.set(param, String(page));
  return u.toString();
}

/**
 * Drop EventItems whose stable id was already seen, keeping first occurrence.
 * Used to collapse the same event surfaced by overlapping chunks or repeated
 * across pages, before the global dedupeAndMerge runs.
 *
 * PURE — deterministic, no I/O.
 */
export function dedupById(events: EventItem[]): EventItem[] {
  const seen = new Set<string>();
  const out: EventItem[] = [];
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

// ============================================================================
// trimToContentStart — PURE, no I/O (Slice 5)
// ============================================================================

/**
 * Trim deep-boilerplate prefix from a large page so LLM windowing starts at
 * the first event-dense offset rather than byte 0.
 *
 * Algorithm:
 *   1. If content.length <= LLM_CHUNK_SIZE → return unchanged (already fits
 *      in one window; trimming would be both useless and potentially harmful).
 *   2. Compute candidate start offsets:
 *      a. ldOffset  — byte of the first `application/ld+json` occurrence.
 *      b. linkClusterOffset — byte of the first href in the MOST-repeated
 *         "deep event link" template (path depth ≥ 2, digit segments replaced
 *         with '#', minimum 5 occurrences required).
 *   3. startOffset = minimum of available candidates (absent → ignored).
 *   4. SAFETY GATE: only trim when startOffset > LLM_CHUNK_SIZE (the content
 *      we care about is genuinely beyond the first window). Back off 500 chars
 *      so we don't cut mid-card. Return unchanged otherwise.
 *
 * PURE — deterministic, no I/O, no Date calls.
 * Strict TypeScript: no `any`, no unwarranted `as`, no `@ts-ignore`.
 */
export function trimToContentStart(content: string): string {
  // Rule 1: small pages — never trim.
  if (content.length <= LLM_CHUNK_SIZE) return content;

  // ── Candidate a: first JSON-LD block ─────────────────────────────────────
  const ldOffset = content.indexOf("application/ld+json");

  // ── Candidate b: most-repeated deep event-link template ──────────────────
  // Find all href="..." values and build a template by:
  //   - extracting the path (strip scheme + host)
  //   - collapsing all numeric runs to '#'
  //   - keeping only the first 3 path segments (depth ≥ 2 required)
  // Count occurrences per template; winner must have ≥ 5 repeats.
  // linkClusterOffset = byte index of the FIRST full href matching the winner.
  const hrefRe = /href="([^"]+)"/g;
  const templateCount = new Map<string, number>();
  const templateFirstMatch = new Map<string, number>(); // template → byte offset of first href attr

  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(content)) !== null) {
    const fullMatch = m[0];      // e.g. href="https://x.org/events/2026/06/01/slug"
    const href = m[1];           // e.g. https://x.org/events/2026/06/01/slug
    if (!href) continue;

    // Extract path (strip scheme + host if absolute; take as-is if relative).
    let path: string;
    try {
      // Use URL if it looks absolute.
      if (href.startsWith("http://") || href.startsWith("https://")) {
        path = new URL(href).pathname;
      } else {
        path = href.startsWith("/") ? href.split("?")[0] ?? href : "/" + (href.split("?")[0] ?? href);
      }
    } catch {
      path = href;
    }

    // Split path into segments, drop empty ones from leading slash.
    const segments = path.split("/").filter((s) => s.length > 0);

    // Require depth ≥ 2 (at least 2 non-empty segments, e.g. /events/2026/...).
    if (segments.length < 2) continue;

    // Replace digit-only runs with '#' and keep at most the first 3 segments.
    const normalized = segments
      .slice(0, 3)
      .map((seg) => /^\d+$/.test(seg) ? "#" : seg)
      .join("/");

    // Require the normalized template to still have depth ≥ 2.
    if (normalized.split("/").filter((s) => s.length > 0).length < 2) continue;

    const count = (templateCount.get(normalized) ?? 0) + 1;
    templateCount.set(normalized, count);

    // Record the byte offset of the first occurrence of this template's href attr.
    if (!templateFirstMatch.has(normalized)) {
      // m.index is the start of the full `href="..."` attribute in content.
      templateFirstMatch.set(normalized, m.index);
    }
  }

  // Find the template with the most occurrences (minimum 5 to be a real cluster).
  // CRITICAL: only consider "detail-page" templates — those containing a
  // digit-collapsed segment ('#', i.e. a year/date/id). Static navigation links
  // (e.g. "events/all", repeated in every card header + the site nav, 300+ times
  // near byte 0) otherwise win on raw count and pin startOffset to ~0, defeating
  // the trim entirely. Real event detail URLs (/events/2026/06/01/slug) collapse
  // to templates like "events/#/#" and are what we want to window on.
  const MIN_CLUSTER_REPEATS = 5;
  let winnerTemplate: string | null = null;
  let winnerCount = 0;
  for (const [tpl, count] of templateCount) {
    if (!tpl.includes("#")) continue;
    if (count >= MIN_CLUSTER_REPEATS && count > winnerCount) {
      winnerCount = count;
      winnerTemplate = tpl;
    }
  }

  const linkClusterOffset: number =
    winnerTemplate !== null
      ? (templateFirstMatch.get(winnerTemplate) ?? -1)
      : -1;

  // ── startOffset: minimum of available candidates ──────────────────────────
  const candidates: number[] = [];
  if (ldOffset !== -1) candidates.push(ldOffset);
  if (linkClusterOffset !== -1) candidates.push(linkClusterOffset);

  if (candidates.length === 0) return content; // no signal → unchanged

  const startOffset = Math.min(...candidates);

  // ── Safety gate: only trim when the signal is genuinely deep ─────────────
  if (startOffset <= LLM_CHUNK_SIZE) return content;

  // ── Upper safety gate: a signal too close to the END means trimming would
  // discard almost the whole page (the real listing is BEFORE this late anchor —
  // e.g. off-season sports schedule pages with a footer link cluster). If the
  // remaining tail is smaller than a single chunk, skip the trim and let
  // chunking scan from the top instead. Fixes sd-gulls silent-zero
  // (signal landed at 97.9% of the page, leaving an 8KB fragment with 0 events).
  if (content.length - startOffset < LLM_CHUNK_SIZE) {
    console.warn(
      `[SPAAdapter] trimToContentStart: signal at ${startOffset} is within the ` +
      `last ${content.length - startOffset} chars of ${content.length} — too deep; ` +
      `skipping trim and scanning from the top instead`
    );
    return content;
  }

  // Back off 500 chars so we don't cut mid-card.
  const trimPoint = Math.max(0, startOffset - 500);

  console.log(
    `[SPAAdapter] trimToContentStart: trimming from offset ${trimPoint} ` +
    `(signal at ${startOffset}) — ${content.length} → ${content.length - trimPoint} chars`
  );

  return content.slice(trimPoint);
}

// ============================================================================
// "Today" for prompt injection — LA calendar date, PURE (deterministic given `now`)
// ============================================================================

/**
 * Return today's date as "YYYY-MM-DD" in America/Los_Angeles wall-clock time.
 *
 * Used to inject a ground-truth "today" into the extraction prompt so the LLM
 * can resolve year-less dates ("July 5th", "Friday Aug 22") against a real
 * reference point instead of guessing or omitting the year. Defaults to
 * `new Date()`; callers (and tests) may pass `now` explicitly for determinism.
 *
 * PURE given `now` — no I/O beyond reading the clock argument.
 */
export function todayLaDateString(now: Date = new Date()): string {
  const p = utcMsToLaParts(now.getTime());
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

// ============================================================================
// SPA extraction prompt
// ============================================================================

/**
 * Build the extraction system prompt for a given "today" (LA calendar date,
 * "YYYY-MM-DD").
 *
 * Year-less-date fix (2026-07-10): many source pages give dates without a
 * year in their raw text ("🗓️ July 5th", "Friday Aug 22") — the LLM used to
 * have no ground truth for "today" and would emit a year-less or ambiguous
 * startDatetime, which normalizeExtracted then had to drop as unparseable
 * (~15 html-llm sources affected; majestyinmotion-events yielded 1/~5 events
 * before this fix). Per house rule ("determinism must earn its place"), the
 * fix is prompt-level, not a deterministic NL date parser: hand the model the
 * real current date and instruct it to resolve year-less dates itself and
 * ALWAYS output a full year — the model is far better positioned to judge
 * "does this recurring Friday social mean this Friday or next year's?" than
 * a regex ever could be.
 *
 * The prompt also now asks for ISO 8601 ONLY (no more "Month DD, YYYY HH:MM
 * AM/PM" alternate) — live-verified 2026-07-10 that the alternate free-text
 * format silently fails downstream: `coerceToIso`'s naive-datetime branch
 * appends a bare "Z" before `Date.parse`, which only round-trips for
 * ISO-shaped strings, so a fully-year-qualified "July 12, 2026 05:00 PM" was
 * STILL being dropped as "unparseable" even after the year fix. Narrowing
 * the prompt to one unambiguous format is itself the fix (still zero NL
 * parsing added to normalizeExtracted) and sidesteps that bug entirely.
 *
 * PURE — deterministic given `todayLaDate`, no I/O.
 */
export function buildExtractionSystemPrompt(todayLaDate: string): string {
  return `You are an event extraction assistant. Your ONLY task is to extract upcoming events from the provided webpage content and return them as a JSON array.

Today's date is ${todayLaDate} (America/Los_Angeles). Use this as your reference point for resolving any date in the source content that doesn't state a year.

Output ONLY a valid JSON array of event objects. Do not include any prose, explanation, or markdown outside the JSON array.

Each event object should include as many of these fields as you can extract:
- title (string, required) — the event name
- startDatetime (string, required) — the start date/time as a FULL ISO 8601 datetime string, e.g. "2026-07-12T17:00:00" (no "Z"/UTC suffix — venue-local America/Los_Angeles time is assumed) or "2026-07-12T17:00:00-07:00" if you're confident of the offset. Do NOT use "Month DD, YYYY HH:MM AM/PM" or any other free-text date format — ISO 8601 only. It MUST include an explicit, specific year. Source pages routinely give dates with NO year at all — "🗓️ July 5th", "Friday Aug 22", "Sat 12/6" — you must still resolve these to a complete date using today's date (${todayLaDate}) as the reference: pick the next plausible occurrence of that month/day on or after today (if the month/day already passed this year and the event reads as recurring or is otherwise clearly future-framed, roll it to next year's occurrence instead). Use your best judgment on ambiguous cases, but NEVER emit a year-less date, a placeholder year, or drop the event for lacking a year — always output a complete, real ISO 8601 datetime with an explicit year.
- endDatetime (string, optional) — end date/time in the same ISO 8601 format (the same year-resolution rule applies if it also lacks a year)
- venue (string, optional) — venue or location name
- description (string, optional) — short event description
- ticketUrl (string, optional) — URL to buy tickets
- isFree (boolean, optional) — whether the event is free
- priceMin (number, optional) — minimum ticket price in USD (just the number, no currency symbol)
- performersOrTeams (string, optional) — performers, artists, or teams
- category (string, optional) — the single best-fitting category from EXACTLY this list (lowercase): music, comedy, theater, sports, arts, community, festival, talk, film, food, other. Guidance: concerts / live bands / DJs / singers → "music"; stand-up → "comedy"; plays / musicals → "theater"; lectures / author or speaker talks → "talk"; film screenings → "film"; multi-day fairs or festivals → "festival"; farmers markets / meetups / neighborhood gatherings → "community"; gallery shows / exhibits → "arts"; games / matches → "sports"; food tours / tastings / happy hours / dinners / beer or wine events → "food". Use "other" only when none clearly fit.

Skip events that are clearly in the past. Include only future or current events.
If no events are found, return an empty array: []`;
}

// ============================================================================
// extractEventsFromContent — single-sourced JSON-LD → LLM extraction
// ============================================================================

/**
 * Run the full JSON-LD pre-pass → LLM extraction pipeline on pre-fetched content.
 *
 * This is the shared extraction kernel used by both the SPA/html-llm fetch path
 * and the Apify fetch tier. Keeping logic single-sourced ensures the two tiers
 * behave identically and tests only need to cover one place.
 *
 * Pipeline:
 *   1. JSON-LD pre-pass (deterministic, schema.org Event extraction).
 *      If events found, return them immediately (high confidence).
 *   2. Otherwise: `extractViaLLM` (applies trimToContentStart + chunking).
 *
 * @param content - Rendered page markdown/HTML string (already fetched).
 * @param source  - EventSource the content was fetched for.
 * @returns       - EventItem[] extracted; may be empty if nothing found.
 */
export async function extractEventsFromContent(
  content: string,
  source: EventSource,
): Promise<EventItem[]> {
  // JSON-LD pre-pass (deterministic, fast)
  const jsonLdEvents = extractJsonLdEvents(content, source);
  if (jsonLdEvents.length > 0) {
    return jsonLdEvents;
  }

  // Fallback to LLM extraction (trimToContentStart + chunking)
  return extractViaLLM(content, source);
}

// ============================================================================
// fetchSPAEvents — live fetch + LLM extract
// ============================================================================

// ============================================================================
// Content size threshold for Playwright escalation
// ============================================================================

/**
 * Pages below this byte count are suspicious (likely SPA shells with no
 * rendered content). Trigger a Playwright escalation attempt.
 */
const THIN_CONTENT_THRESHOLD = 50_000;

// ============================================================================
// LLM extraction helper — reusable for both first attempt and post-escalation
// ============================================================================

/** Size of one LLM extraction window (chars). Pages are split into windows of this size. */
const LLM_CHUNK_SIZE = 40_000;
/** Max windows extracted per page — bounds LLM cost/latency. 4 → up to ~150KB covered. */
const LLM_MAX_CHUNKS = 4;
/** Overlap between consecutive windows so boundary-straddling events survive. */
const LLM_CHUNK_OVERLAP = 2_000;

/**
 * Run one LLM extraction call over a single content window.
 * Throws if the inference call itself fails (caller handles per-chunk).
 */
async function extractChunkViaLLM(
  chunk: string,
  source: EventSource,
): Promise<EventItem[]> {
  const inferenceResult = await inference({
    systemPrompt: buildExtractionSystemPrompt(todayLaDateString()),
    userPrompt:
      `Extract all upcoming events from the following webpage content.\n\n` +
      `Source URL: ${source.url}\n` +
      `Page content:\n\n${chunk}`,
    level: "standard",
    expectJson: false,
    timeout: 120_000,
    // 3 attempts total. A timeout here is almost always a stalled socket (machine
    // slept mid-call / dead TCP) that a longer wait can't revive — a fresh spawn
    // does. Two retries make recovery near-certain so a stall never drops a window.
    retries: 2,
    retryDelayMs: 3000,
  });

  if (!inferenceResult.success) {
    throw new Error(
      `[SPAAdapter] LLM extraction failed for ${source.url}: ${inferenceResult.error ?? "unknown error"}`
    );
  }

  const rawArray = extractJsonArray(inferenceResult.output);
  return normalizeExtracted(rawArray, source);
}

/**
 * LLM-extract events from page content, covering more than the first window.
 *
 * Splits content into up to LLM_MAX_CHUNKS overlapping windows and extracts
 * each in PARALLEL (wall-clock stays ~one inference, not N×), then merges and
 * dedups by stable id. For pages <= one window this is identical to the prior
 * single-slice behaviour. A chunk whose inference fails is skipped (logged),
 * not fatal — the surviving chunks still contribute.
 */
async function extractViaLLM(
  content: string,
  source: EventSource
): Promise<EventItem[]> {
  const trimmed = trimToContentStart(content);
  // Per-source override for content-dense pages whose listing exceeds the
  // default 4-window (~150KB) budget — events past it would be silently dropped.
  const maxWindows = source.maxLlmWindows ?? LLM_MAX_CHUNKS;
  const chunks = chunkContent(trimmed, LLM_CHUNK_SIZE, maxWindows, LLM_CHUNK_OVERLAP);
  if (chunks.length > 1) {
    console.log(
      `[SPAAdapter] Content ${trimmed.length} chars → ${chunks.length} window(s) for LLM extraction`
    );
  }

  const settled = await Promise.allSettled(
    chunks.map((chunk) => extractChunkViaLLM(chunk, source))
  );

  const all: EventItem[] = [];
  let failures = 0;
  for (const r of settled) {
    if (r.status === "fulfilled") all.push(...r.value);
    else { failures++; console.warn(`[SPAAdapter] window extraction skipped: ${(r.reason as Error)?.message ?? r.reason}`); }
  }

  const deduped = dedupById(all);
  console.log(
    `[SPAAdapter] LLM returned ${deduped.length} unique event(s) ` +
    `(${chunks.length} window(s), ${failures} failed)`
  );
  return deduped;
}

// ============================================================================
// Playwright (tier-3) escalation helper
// ============================================================================

async function escalateToPlaywright(
  url: string,
  tool: BrightDataTool
): Promise<string | null> {
  console.log(
    `[SPAAdapter] Escalating to Playwright (tier-3) for thin/empty content: ${url}`
  );
  const pw = await tool.scrape(url, {
    startTier: 3,
    skipBrowser: false,  // explicitly enable Playwright
    timeoutMs: 90_000,
  });
  if (pw.success && pw.content && pw.content.length > 0) {
    console.log(
      `[SPAAdapter] Playwright returned ${pw.content.length} chars ` +
      `(tier ${pw.winningTier})`
    );
    return pw.content;
  }
  console.warn(
    `[SPAAdapter] Playwright escalation failed for ${url}: ` +
    `${pw.error ?? "no content"} (tiers: ${pw.tiersAttempted.join(",")})`
  );
  return null;
}

/**
 * Fetch a JS SPA event calendar page and extract events.
 *
 * Pipeline (per source, best-effort):
 *   1. Fetch via BrightData tier-1/2 (lightweight HTTP).
 *   2. Run JSON-LD pre-pass (deterministic, schema.org Event extraction).
 *      If JSON-LD yields events, use them (high confidence).
 *   3. If JSON-LD yields 0, run LLM extraction on the fetched content.
 *   4. Playwright escalation: if the fetched content is suspiciously thin
 *      (< 50KB) OR both JSON-LD + LLM yielded 0 events, attempt one Playwright
 *      (tier-3) re-fetch and retry JSON-LD + LLM on the rendered DOM.
 *      Capped to one escalation per call. Logs when escalation fires.
 *
 * @param source - EventSource with fetchTier === "spa" or "html-llm".
 * @returns      - EventItem[] extracted from the page; may be empty.
 */
async function fetchEventsForUrl(url: string, source: EventSource): Promise<EventItem[]> {
  console.log(`[SPAAdapter] Fetching page: ${url}`);

  const tool = new BrightDataTool();

  // --- Step 1: tier-1/2 fetch ---
  const scrapeResult = await tool.scrape(url, {
    startTier: 1,
    skipBrowser: true,   // Lightweight: tier-1 fetch, tier-2 curl only
    timeoutMs: 60_000,
  });

  let content: string | null = null;

  if (scrapeResult.success && scrapeResult.content) {
    content = scrapeResult.content;
    console.log(
      `[SPAAdapter] Fetched ${content.length} chars via tier ${scrapeResult.winningTier} ` +
      `(tiers tried: ${scrapeResult.tiersAttempted.join(",")})`
    );
  } else {
    console.warn(
      `[SPAAdapter] Tier-1/2 fetch failed for ${url}: ` +
      `${scrapeResult.error ?? "no content"} — will try Playwright`
    );
  }

  // Determine if we need Playwright escalation immediately (before extraction)
  const thinContent = !content || content.length < THIN_CONTENT_THRESHOLD;
  let escalated = false;

  // --- Step 2 (only if we have content): JSON-LD pre-pass + LLM ---
  let events: EventItem[] = [];

  if (content) {
    const jsonLdCount = extractJsonLdEvents(content, source).length;
    console.log(`[SPAAdapter] JSON-LD pre-pass: ${jsonLdCount} event(s)`);
    if (jsonLdCount === 0) {
      console.log("[SPAAdapter] JSON-LD yielded 0 — falling back to LLM extraction...");
    }
    try {
      events = await extractEventsFromContent(content, source);
    } catch (err) {
      console.warn(`[SPAAdapter] extraction error: ${(err as Error).message}`);
    }
  }

  // --- Step 3: Playwright escalation ---
  // Escalate if: (a) content was thin/absent, or (b) both JSON-LD and LLM yielded 0
  const needsEscalation = thinContent || events.length === 0;

  if (needsEscalation) {
    const pwContent = await escalateToPlaywright(url, tool);
    escalated = true;

    if (pwContent) {
      console.log("[SPAAdapter] Post-Playwright extraction...");
      try {
        const pwEvents = await extractEventsFromContent(pwContent, source);
        if (pwEvents.length > 0) {
          events = pwEvents;
        }
      } catch (err) {
        console.warn(`[SPAAdapter] Post-Playwright extraction error: ${(err as Error).message}`);
      }
    }
  }

  console.log(
    `[SPAAdapter] ${events.length} valid EventItem(s) ` +
    `(escalated=${escalated})`
  );

  // If nothing worked at all, throw so callers can record the failure
  if (!content && !escalated) {
    throw new Error(
      `[SPAAdapter] Failed to fetch ${url} — ` +
      `tiers attempted: ${scrapeResult.tiersAttempted.join(",")} — ` +
      `error: ${scrapeResult.error ?? "no content returned"}`
    );
  }

  return events;
}

// ============================================================================
// Pagination safety bound — caps the page loop regardless of other stop conditions.
//
// WHY 40: Each SPA page covers ~1-4 weeks of events; 40 pages → ~1-2 years of
// coverage minimum, well past any realistic 120-day horizon. A source that
// returns new events past page 40 is almost certainly misconfigured or paginating
// infinitely (e.g. the param doesn't advance the listing). Logging at this cap
// is mandatory — no silent truncation.
// ============================================================================
export const MAX_PAGES_SAFETY = 40;

/**
 * Injectable page fetcher type.
 * Receives the fully-built page URL and the EventSource; returns EventItem[].
 * Allows tests to mock the network + LLM without any real I/O.
 */
export type PageFetcherFn = (url: string, source: EventSource) => Promise<EventItem[]>;

/**
 * Core horizon-aware pagination loop — separated from the real fetcher so tests
 * can inject a mock pageFn.
 *
 * STOP CONDITIONS (all must hold to continue to the next page):
 *   1. Page produced at least one event (empty page → stop).
 *   2. Page produced at least one NEW unique event not already accumulated
 *      (no-new-uniques → stop; catches no-op params that refetch page 1 forever).
 *   3. At least one event on the page is within the horizon
 *      (all-past-horizon → stop; assumes listings are roughly date-ordered — the
 *      Slice-5 downstream filter is the authoritative backstop).
 *      ASSUMPTION: pages are roughly sorted newest→oldest or oldest→newest such
 *      that once a whole page is past the horizon, subsequent pages will also be
 *      past the horizon. This assumption can break for non-date-sorted sources;
 *      the downstream withinHorizon filter is the safety net in that case.
 *   4. Safety bound not exceeded: MAX_PAGES_SAFETY (40). Logs loudly when hit.
 *
 * The configured `paginate.pages` value is respected as the normal upper bound,
 * but the stop conditions above can end the loop earlier.
 *
 * Single-page sources (no `paginate`) call `pageFn` exactly once and return.
 *
 * @param source   - EventSource describing what to fetch.
 * @param pageFn   - Fetcher called with (url, source) per page.
 * @param now      - Reference instant for horizon checks. Pass explicitly for
 *                   deterministic tests; defaults to new Date() in production.
 * @returns        - Deduped EventItem[] across all fetched pages.
 */
export async function fetchSPAEventsWithPageFn(
  source: EventSource,
  pageFn: PageFetcherFn,
  now: Date = new Date(),
): Promise<EventItem[]> {
  // ── Single-page path (no paginate config) ────────────────────────────────
  if (!source.paginate) {
    console.log(`[SPAAdapter] Single-page fetch (${source.id}): ${source.url}`);
    const events = await pageFn(source.url, source);
    const deduped = dedupById(events);
    console.log(`[SPAAdapter] Single-page total (${source.id}): ${deduped.length} event(s)`);
    return deduped;
  }

  // ── Multi-page path ───────────────────────────────────────────────────────
  const { param, pages: configuredPages } = source.paginate;
  const start = source.paginate.start ?? 1;
  // Normal upper bound from config (no safety cap here — safety handled inside loop).
  const upperBound = start + configuredPages;

  const all: EventItem[] = [];
  // Track seen ids across pages for no-new-uniques detection.
  const seenIds = new Set<string>();
  const days = horizonDays();
  let pagesFetched = 0;

  for (let p = start; p < upperBound; p++) {
    // Stop condition 4 (safety bound) — checked FIRST, BEFORE fetching.
    // Fires when we've already fetched MAX_PAGES_SAFETY pages without any other
    // stop condition triggering. Log loudly — this should never happen with a
    // well-behaved source and a sane paginate.pages config.
    if (pagesFetched >= MAX_PAGES_SAFETY) {
      console.warn(
        `[SPAAdapter] SAFETY BOUND HIT: ${source.id} reached MAX_PAGES_SAFETY=${MAX_PAGES_SAFETY} pages ` +
        `— stopping pagination. Review 'paginate.pages' config or source behavior. ` +
        `Events fetched so far: ${all.length}`,
      );
      break;
    }

    const pageUrl = buildPageUrl(source.url, param, p);
    console.log(`[SPAAdapter] Paginated fetch (${source.id}): page ${p} → ${pageUrl}`);

    let pageEvents: EventItem[] = [];
    try {
      pageEvents = await pageFn(pageUrl, source);
    } catch (err) {
      console.warn(
        `[SPAAdapter] page ${p} failed: ${(err as Error).message} — stopping pagination`,
      );
      break;
    }
    pagesFetched++;

    console.log(`[SPAAdapter] page ${p}: ${pageEvents.length} raw event(s)`);

    // Stop condition 1: empty page → nothing more to fetch.
    if (pageEvents.length === 0) {
      console.log(`[SPAAdapter] page ${p} empty — stopping pagination`);
      break;
    }

    // Stop condition 2: no new unique events (no-op param safety).
    const newEvents = pageEvents.filter((e) => !seenIds.has(e.id));
    if (newEvents.length === 0) {
      console.log(
        `[SPAAdapter] page ${p} has no new unique events (all ${pageEvents.length} already seen) ` +
        `— stopping pagination (no-op param or deduplication loop)`,
      );
      break;
    }

    // Stop condition 3: all events on this page are beyond the horizon.
    // NOTE: We check the RAW page events (not just newEvents) because we want to
    // detect the horizon boundary based on the full page, not just the incremental
    // new slice. A page where every event is beyond the horizon signals we've
    // walked past the relevant date range — stop fetching further pages.
    // ASSUMPTION documented above: listings are roughly date-ordered.
    const inHorizonEvents = withinHorizon(pageEvents, now, days);
    if (inHorizonEvents.length === 0) {
      console.log(
        `[SPAAdapter] page ${p} is entirely beyond ${days}-day horizon — ` +
        `stopping pagination (date-ordering assumption: further pages also past horizon)`,
      );
      // Add the in-horizon events (empty here, but keep the pattern uniform).
      // The beyond-horizon events are intentionally dropped here; the downstream
      // withinHorizon filter in Ingest.ts is the authoritative backstop.
      break;
    }

    // Accumulate new events + update seen set.
    for (const e of newEvents) {
      seenIds.add(e.id);
      all.push(e);
    }

    console.log(
      `[SPAAdapter] page ${p}: added ${newEvents.length} new event(s) ` +
      `(${pageEvents.length - newEvents.length} dupes skipped, ` +
      `${pageEvents.length - inHorizonEvents.length} beyond horizon on page)`,
    );
  }

  const deduped = dedupById(all);
  console.log(
    `[SPAAdapter] Paginated total (${source.id}): ${deduped.length} unique event(s) ` +
    `across fetched pages`,
  );
  return deduped;
}

/**
 * Fetch a JS SPA / html-llm source, paginating when `source.paginate` is set.
 *
 * Horizon-aware: stops paginating when a page is entirely beyond the
 * EVENTSCOUT_HORIZON_DAYS horizon, or when no new unique events appear
 * (no-op pagination param safety), or at MAX_PAGES_SAFETY pages.
 *
 * @param source - EventSource with fetchTier === "spa" or "html-llm".
 * @returns      - EventItem[] across all fetched pages; may be empty.
 */
export async function fetchSPAEvents(source: EventSource): Promise<EventItem[]> {
  return fetchSPAEventsWithPageFn(
    source,
    (url, src) => fetchEventsForUrl(url, src),
  );
}

// ============================================================================
// Script entry point — live test
// ============================================================================

const IS_SCRIPT =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("SPAAdapter.ts") ||
    process.argv[1].endsWith("SPAAdapter"));

if (IS_SCRIPT) {
  const sourcesPath = new URL("../sources.json", import.meta.url).pathname;
  const { readFileSync } = await import("fs");
  const { z } = await import("zod");
  const { EventSourceSchema } = await import("../types.ts");

  const sources = z.array(EventSourceSchema).parse(
    JSON.parse(readFileSync(sourcesPath, "utf-8"))
  );

  const spaSources = sources.filter((s) => s.fetchTier === "spa" && s.enabled);
  if (spaSources.length === 0) {
    console.error("No enabled SPA sources found in sources.json");
    process.exit(1);
  }

  const source = spaSources[0]!;
  console.log(`\nEventScout — SPA Adapter Live Test\nSource: ${source.id} (${source.url})\n`);

  try {
    const events = await fetchSPAEvents(source);
    console.log(`\nExtracted ${events.length} event(s):\n`);
    for (const ev of events.slice(0, 5)) {
      console.log(`  - ${ev.title}`);
      console.log(`    start: ${ev.startDatetime}`);
      if (ev.venue) console.log(`    venue: ${ev.venue}`);
      if (ev.ticketUrl) console.log(`    tickets: ${ev.ticketUrl}`);
      console.log();
    }
    if (events.length > 5) console.log(`  ... and ${events.length - 5} more.`);
  } catch (err) {
    console.error(`\nFATAL: ${(err as Error).message}`);
    process.exit(1);
  }
}
