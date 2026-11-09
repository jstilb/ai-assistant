/**
 * JsonLd.ts — Deterministic schema.org Event JSON-LD extractor (Slice 9)
 *
 * Parses ALL <script type="application/ld+json"> blocks from fetched HTML and
 * extracts schema.org Event objects, mapping them to EventItem[].
 *
 * Handles:
 *   - Single Event object at top level
 *   - Array of objects at top level (any may be Events)
 *   - @graph array (any element with @type=Event)
 *   - ItemList whose itemListElement[].item are Events
 *   - Nested events inside non-Event top-level objects
 *   - Malformed JSON blocks (skip with warning, do not throw)
 *
 * Maps schema.org Event → EventItem:
 *   name              → title
 *   startDate         → startDatetime (naive → America/Los_Angeles via tz.ts)
 *   endDate           → endDatetime
 *   location.name     → venue
 *   location.address  → address (string or PostalAddress → formatted string)
 *   offers.price / offers.lowPrice → priceMin; 0 or "Free" → isFree:true
 *   offers.url        → ticketUrl (fallback: event url)
 *   image             → imageUrl
 *   description       → description
 *   url               → used for ticketUrl if offers.url absent
 *
 * No network calls. Pure function.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { EventItemSchema } from "../types.ts";
import type { EventItem, EventSource, Category } from "../types.ts";
import { isNaiveDatetime, naiveLaToUtcMs, utcIsoToLaIso } from "../lib/tz.ts";
import { stableId } from "./AdapterUtil.ts";

// ============================================================================
// Zod schema for raw schema.org Event (permissive — we only care about what we use)
// ============================================================================

const SchemaOrgAddressSchema = z.union([
  z.string(),
  z.object({
    "@type": z.string().optional(),
    streetAddress: z.string().optional(),
    addressLocality: z.string().optional(),
    addressRegion: z.string().optional(),
    postalCode: z.string().optional(),
    addressCountry: z.string().optional(),
  }),
]);

const SchemaOrgLocationSchema = z
  .object({
    "@type": z.string().optional(),
    name: z.string().optional(),
    address: SchemaOrgAddressSchema.optional(),
  })
  .passthrough();

const SchemaOrgCoordinateSchema = z.union([
  z.number(),
  z.string().trim().regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i)
    .transform(value => Number(value)),
]).pipe(z.number().finite());

const SchemaOrgGeoSchema = z.object({
  latitude: SchemaOrgCoordinateSchema.pipe(z.number().min(-90).max(90)),
  longitude: SchemaOrgCoordinateSchema.pipe(z.number().min(-180).max(180)),
});

const SchemaOrgOfferSchema = z.object({
  "@type": z.string().optional(),
  price: z.union([z.string(), z.number()]).optional(),
  lowPrice: z.union([z.string(), z.number()]).optional(),
  highPrice: z.union([z.string(), z.number()]).optional(),
  priceCurrency: z.string().optional(),
  url: z.string().optional(),
}).passthrough();

const SchemaOrgOffersField = z.union([SchemaOrgOfferSchema, z.array(SchemaOrgOfferSchema)]);

const SchemaOrgEventSchema = z
  .object({
    "@type": z.string(),
    name: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    location: z.union([SchemaOrgLocationSchema, z.array(SchemaOrgLocationSchema)]).optional(),
    offers: SchemaOrgOffersField.optional(),
    image: z.union([z.string(), z.array(z.string()), z.object({ url: z.string() }).passthrough()]).optional(),
    description: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();

type SchemaOrgEvent = z.infer<typeof SchemaOrgEventSchema>;

const EventbriteTimeSchema = z.object({
  id: z.string().regex(/^\d+$/),
  url: z.string(),
  timezone: z.literal("America/Los_Angeles"),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  hide_start_date: z.boolean().optional(),
  hide_end_date: z.boolean().optional(),
});
type EventbriteTime = z.infer<typeof EventbriteTimeSchema>;

function isEventbriteUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && (
      url.hostname === "eventbrite.com" || url.hostname.endsWith(".eventbrite.com") ||
      url.hostname === "eventbrite.ca" || url.hostname.endsWith(".eventbrite.ca")
    );
  } catch {
    return false;
  }
}

function eventbriteId(raw: string | undefined): string | undefined {
  if (!raw || !isEventbriteUrl(raw)) return undefined;
  return new URL(raw).pathname.match(/^\/e\/[^/]+-(\d+)\/?$/)?.[1];
}

function extractEventbriteTimes(html: string, source: EventSource): Map<string, EventbriteTime> {
  const times = new Map<string, EventbriteTime>();
  if (!isEventbriteUrl(source.url)) return times;
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  const assignments = scripts.flatMap(script => {
    const content = script[1] ?? "";
    return [...content.matchAll(/(?:^|[;\n])\s*window\.__SERVER_DATA__\s*=\s*(\{)/g)]
      .flatMap(match => (match.index === undefined ? [] : [{ content, start: match.index + match[0].length - 1 }]));
  });
  const [assignment] = assignments;
  if (assignments.length !== 1 || !assignment) return times;
  const { content, start } = assignment;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let end = start;
  for (; end < content.length; end++) {
    const char = content[end];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) break;
  }
  try {
    const state = z.object({ search_data: z.object({ events: z.object({ results: z.array(z.unknown()) }) }) })
      .safeParse(JSON.parse(content.slice(start, end + 1)));
    if (!state.success) return times;
    const seen = new Set<string>();
    for (const raw of state.data.search_data.events.results) {
      const identity = z.object({ id: z.string().regex(/^\d+$/) }).safeParse(raw);
      if (!identity.success) continue;
      const id = identity.data.id;
      if (seen.has(id)) {
        times.delete(id);
        continue;
      }
      seen.add(id);
      const parsed = EventbriteTimeSchema.safeParse(raw);
      if (parsed.success && eventbriteId(parsed.data.url) === id) times.set(id, parsed.data);
    }
  } catch {
    return times;
  }
  return times;
}

function eventbriteDatetime(date: string | undefined, time: string | undefined): string | undefined {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !time || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time)) return undefined;
  const day = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== date) return undefined;
  const naive = `${date}T${time.length === 5 ? `${time}:00` : time}`;
  const utc = naiveLaToUtcMs(naive);
  if (!Number.isFinite(utc)) return undefined;
  const matches = [utc - 3_600_000, utc, utc + 3_600_000]
    .filter(ms => utcIsoToLaIso(new Date(ms).toISOString()).slice(0, 19) === naive);
  return matches.length === 1 ? naive : undefined;
}

function withEventbriteTimes(event: SchemaOrgEvent, times: Map<string, EventbriteTime>): SchemaOrgEvent {
  const id = eventbriteId(event.url);
  const row = id ? times.get(id) : undefined;
  if (!row) return event;
  const start = row.hide_start_date === false && event.startDate === row.start_date
    ? eventbriteDatetime(row.start_date, row.start_time) : undefined;
  const end = row.hide_end_date === false && event.endDate === row.end_date
    ? eventbriteDatetime(row.end_date, row.end_time) : undefined;
  const augmented = { ...event, ...(start && { startDate: start }), ...(end && { endDate: end }) };
  const startMs = augmented.startDate ? Date.parse(coerceToIso(augmented.startDate) ?? "") : NaN;
  const endMs = augmented.endDate ? Date.parse(coerceToIso(augmented.endDate) ?? "") : NaN;
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs < startMs ? event : augmented;
}

// ============================================================================
// Stable ID — shared recipe, plus the Eventbrite occurrence form
// ============================================================================

/**
 * Without an occurrence id: the shared AdapterUtil recipe (UTC-normalized).
 * With an Eventbrite occurrence id: hash the occurrence id and its UTC start,
 * so two dates of one Eventbrite series never collapse into one id.
 */
function jsonLdStableId(title: string, startDatetime: string, venueOrUrl: string, occurrenceId?: string): string {
  if (!occurrenceId) return stableId(title, startDatetime, venueOrUrl, { normalizeUtc: true });
  const ms = Date.parse(startDatetime);
  const utcNorm = Number.isNaN(ms) ? startDatetime : new Date(ms).toISOString();
  return createHash("sha256").update(`eventbrite|${occurrenceId}|${utcNorm}`).digest("hex").slice(0, 16);
}

// ============================================================================
// Datetime coercion — same logic as SPAAdapter.coerceToIso
// ============================================================================

function coerceToIso(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (!isNaiveDatetime(trimmed)) {
    const ts = Date.parse(trimmed);
    if (Number.isNaN(ts)) return null;
    return new Date(ts).toISOString();
  }

  const utcMs = naiveLaToUtcMs(trimmed);
  if (Number.isNaN(utcMs)) return null;
  return utcIsoToLaIso(new Date(utcMs).toISOString());
}

// ============================================================================
// Price + isFree extraction
// ============================================================================

interface PriceInfo {
  priceMin?: number;
  priceMax?: number;
  currency?: string;
  isFree: boolean;
}

function extractPriceInfo(offers: z.infer<typeof SchemaOrgOffersField> | undefined): PriceInfo {
  if (!offers) return { isFree: false };

  const offerList = Array.isArray(offers) ? offers : [offers];
  if (offerList.length === 0) return { isFree: false };

  // Use first offer for price extraction
  const offer = offerList[0]!;
  const rawMax = offer.highPrice;
  const max = typeof rawMax === "number"
    ? rawMax
    : typeof rawMax === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(rawMax.trim())
      ? Number(rawMax)
      : NaN;
  const range = {
    ...(Number.isFinite(max) && max >= 0 && { priceMax: max }),
    ...(offer.priceCurrency !== undefined && { currency: offer.priceCurrency }),
  };
  const rawPrice = offer.price ?? offer.lowPrice;

  if (rawPrice === undefined || rawPrice === null) {
    return { ...range, isFree: false };
  }

  const priceStr = String(rawPrice).trim().toLowerCase();

  // "Free" / "free" → isFree
  if (priceStr === "free") {
    return { ...range, isFree: true, priceMin: undefined };
  }

  // Numeric price
  const num = parseFloat(priceStr.replace(/[^0-9.]/g, ""));
  if (!Number.isNaN(num)) {
    return { ...range, ...(max < num && { priceMax: undefined }), isFree: num === 0, priceMin: num };
  }

  return { ...range, isFree: false };
}

// ============================================================================
// Address formatting — handles string or PostalAddress object
// ============================================================================

function formatAddress(raw: z.infer<typeof SchemaOrgAddressSchema> | undefined): string | undefined {
  if (!raw) return undefined;
  if (typeof raw === "string") return raw.trim() || undefined;

  // PostalAddress object
  const parts: string[] = [];
  if (raw.streetAddress) parts.push(raw.streetAddress);
  if (raw.addressLocality) parts.push(raw.addressLocality);
  if (raw.addressRegion) parts.push(raw.addressRegion);
  if (raw.postalCode) parts.push(raw.postalCode);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

// ============================================================================
// Image URL extraction — handles string, array, or ImageObject
// ============================================================================

function extractImageUrl(image: SchemaOrgEvent["image"]): string | undefined {
  if (!image) return undefined;
  if (typeof image === "string") return image;
  if (Array.isArray(image)) return image[0] ?? undefined;
  if (typeof image === "object" && "url" in image && typeof image.url === "string") {
    return image.url;
  }
  return undefined;
}

// ============================================================================
// Ticket URL extraction — offers.url first, then event url
// ============================================================================

function extractTicketUrl(
  offers: z.infer<typeof SchemaOrgOffersField> | undefined,
  eventUrl: string | undefined,
): string | undefined {
  if (offers) {
    const offerList = Array.isArray(offers) ? offers : [offers];
    for (const offer of offerList) {
      if (offer.url) return offer.url;
    }
  }
  return eventUrl;
}

// ============================================================================
// Category from source hint
// ============================================================================

function categoryFromHint(hint: Category | undefined): Category {
  return hint ?? "other";
}

// ============================================================================
// Convert a validated schema.org Event → EventItem
// Returns null if required fields (name + parseable startDate) are missing.
// ============================================================================

function schemaEventToItem(ev: SchemaOrgEvent, source: EventSource, now: string): EventItem | null {
  // name is required
  const title = ev.name?.trim();
  if (!title) return null;

  // startDate is required
  if (!ev.startDate) return null;
  const startDatetime = coerceToIso(ev.startDate);
  if (startDatetime === null) return null;

  // endDate optional
  const endDatetime = ev.endDate ? (coerceToIso(ev.endDate) ?? undefined) : undefined;

  // location
  const locationRaw = Array.isArray(ev.location) ? ev.location[0] : ev.location;
  const venue = locationRaw?.name?.trim() || undefined;
  const address = formatAddress(locationRaw?.address);
  const coordinates = SchemaOrgGeoSchema.safeParse(locationRaw?.geo);

  // price
  const priceInfo = extractPriceInfo(ev.offers);

  // ticket url
  const ticketUrl = extractTicketUrl(ev.offers, ev.url);

  // image
  const imageUrl = extractImageUrl(ev.image);

  // description
  const description = ev.description?.trim() || undefined;

  // category from source hint only (JSON-LD rarely includes schema.org category usefully)
  const category = categoryFromHint(source.categoryHint);

  // stable id
  const venueOrUrl = venue ?? source.url;
  const id = jsonLdStableId(title, startDatetime, venueOrUrl, eventbriteId(ev.url));

  const item: EventItem = {
    id,
    title,
    startDatetime,
    ...(endDatetime !== undefined && { endDatetime }),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(ev.startDate.trim()) && { startTimeKnown: false }),
    ...(endDatetime !== undefined && ev.endDate !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(ev.endDate.trim()) && { endTimeKnown: false }),
    allDay: false,
    ...(venue !== undefined && { venue }),
    ...(address !== undefined && { address }),
    ...(coordinates.success && { lat: coordinates.data.latitude, lng: coordinates.data.longitude }),
    category,
    tags: [],
    isFree: priceInfo.isFree,
    ...(priceInfo.priceMin !== undefined && { priceMin: priceInfo.priceMin }),
    ...(priceInfo.priceMax !== undefined && { priceMax: priceInfo.priceMax }),
    ...(priceInfo.currency !== undefined && { currency: priceInfo.currency }),
    ...(ticketUrl !== undefined && { ticketUrl }),
    sourceUrl: source.url,
    sources: [{ sourceId: source.id, url: source.url }],
    ...(description !== undefined && { description }),
    ...(imageUrl !== undefined && { imageUrl }),
    fetchedAt: now,
    status: "scheduled",
  };

  // Final schema validation (defence-in-depth)
  const validated = EventItemSchema.safeParse(item);
  if (!validated.success) {
    console.warn("[JsonLd] assembled item failed EventItemSchema:", validated.error.issues);
    return null;
  }

  return validated.data;
}

// ============================================================================
// Schema.org type guard
// ============================================================================

function isEventType(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  const type = (obj as Record<string, unknown>)["@type"];
  if (typeof type === "string") return type === "Event" || type === "schema:Event";
  if (Array.isArray(type)) return type.includes("Event") || type.includes("schema:Event");
  return false;
}

// ============================================================================
// Extract all schema.org Event candidates from a single parsed JSON-LD value
// ============================================================================

function collectEventCandidates(value: unknown): unknown[] {
  if (typeof value !== "object" || value === null) return [];

  const candidates: unknown[] = [];

  if (Array.isArray(value)) {
    // Top-level array — recurse each element
    for (const item of value) {
      candidates.push(...collectEventCandidates(item));
    }
    return candidates;
  }

  const obj = value as Record<string, unknown>;

  // Direct Event
  if (isEventType(obj)) {
    candidates.push(obj);
    return candidates;
  }

  // @graph array
  const graph = obj["@graph"];
  if (Array.isArray(graph)) {
    for (const item of graph) {
      candidates.push(...collectEventCandidates(item));
    }
  }

  // ItemList — itemListElement[].item
  if (obj["@type"] === "ItemList") {
    const elements = obj["itemListElement"];
    if (Array.isArray(elements)) {
      for (const el of elements) {
        if (typeof el === "object" && el !== null && !Array.isArray(el)) {
          const inner = (el as Record<string, unknown>)["item"];
          if (inner) candidates.push(...collectEventCandidates(inner));
        }
      }
    }
  }

  return candidates;
}

// ============================================================================
// Main export — extractJsonLdEvents
// ============================================================================

/**
 * Parse ALL <script type="application/ld+json"> blocks in the given HTML
 * and return EventItem[] for any schema.org Event objects found.
 *
 * Tolerates malformed JSON (skips bad blocks with a console.warn).
 * Returns [] if no events are found.
 *
 * @param html   - Raw HTML string (may be thousands of chars)
 * @param source - EventSource for metadata (id, url, categoryHint)
 */
export function extractJsonLdEvents(html: string, source: EventSource): EventItem[] {
  const now = new Date().toISOString();
  const results: EventItem[] = [];
  const eventbriteTimes = extractEventbriteTimes(html, source);

  // Extract all <script type="application/ld+json"> block contents
  const scriptRegex = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  for (const match of html.matchAll(scriptRegex)) {
    const raw = match[1]?.trim();
    if (!raw) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(`[JsonLd] Skipping malformed JSON-LD block in ${source.url}`);
      continue;
    }

    // Collect all Event candidates from this block
    const candidates = collectEventCandidates(parsed);

    for (const candidate of candidates) {
      // Validate against the schema.org Event schema (permissive)
      const schemaResult = SchemaOrgEventSchema.safeParse(candidate);
      if (!schemaResult.success) {
        // Candidate didn't match even the permissive schema — skip
        continue;
      }

      const item = schemaEventToItem(withEventbriteTimes(schemaResult.data, eventbriteTimes), source, now);
      if (item !== null) {
        results.push(item);
      }
    }
  }

  return results;
}
