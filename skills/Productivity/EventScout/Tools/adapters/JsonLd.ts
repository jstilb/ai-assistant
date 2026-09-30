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

import { createHash } from "crypto";
import { z } from "zod";
import { EventItemSchema, CategorySchema } from "../types.ts";
import type { EventItem, EventSource, Category } from "../types.ts";
import { isNaiveDatetime, naiveLaToUtcMs, utcIsoToLaIso } from "../lib/tz.ts";

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

const SchemaOrgLocationSchema = z.object({
  "@type": z.string().optional(),
  name: z.string().optional(),
  address: SchemaOrgAddressSchema.optional(),
}).passthrough();

const SchemaOrgOfferSchema = z.object({
  "@type": z.string().optional(),
  price: z.union([z.string(), z.number()]).optional(),
  lowPrice: z.union([z.string(), z.number()]).optional(),
  priceCurrency: z.string().optional(),
  url: z.string().optional(),
}).passthrough();

const SchemaOrgOffersField = z.union([
  SchemaOrgOfferSchema,
  z.array(SchemaOrgOfferSchema),
]);

const SchemaOrgEventSchema = z.object({
  "@type": z.string(),
  name: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  location: z.union([SchemaOrgLocationSchema, z.array(SchemaOrgLocationSchema)]).optional(),
  offers: SchemaOrgOffersField.optional(),
  image: z.union([z.string(), z.array(z.string()), z.object({ url: z.string() }).passthrough()]).optional(),
  description: z.string().optional(),
  url: z.string().optional(),
}).passthrough();

type SchemaOrgEvent = z.infer<typeof SchemaOrgEventSchema>;

// ============================================================================
// Stable ID — mirrors SPAAdapter convention
// ============================================================================

function canonical(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function stableId(title: string, startDatetime: string, venueOrUrl: string): string {
  const utcNorm = (() => {
    const ms = Date.parse(startDatetime);
    return isNaN(ms) ? startDatetime : new Date(ms).toISOString();
  })();
  const raw = `${canonical(title)}|${utcNorm}|${canonical(venueOrUrl)}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// ============================================================================
// Datetime coercion — same logic as SPAAdapter.coerceToIso
// ============================================================================

function coerceToIso(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (!isNaiveDatetime(trimmed)) {
    const ts = Date.parse(trimmed);
    if (isNaN(ts)) return null;
    return new Date(ts).toISOString();
  }

  const utcMs = naiveLaToUtcMs(trimmed);
  if (isNaN(utcMs)) return null;
  return utcIsoToLaIso(new Date(utcMs).toISOString());
}

// ============================================================================
// Price + isFree extraction
// ============================================================================

interface PriceInfo {
  priceMin?: number;
  isFree: boolean;
}

function extractPriceInfo(offers: z.infer<typeof SchemaOrgOffersField> | undefined): PriceInfo {
  if (!offers) return { isFree: false };

  const offerList = Array.isArray(offers) ? offers : [offers];
  if (offerList.length === 0) return { isFree: false };

  // Use first offer for price extraction
  const offer = offerList[0]!;
  const rawPrice = offer.price ?? offer.lowPrice;

  if (rawPrice === undefined || rawPrice === null) {
    return { isFree: false };
  }

  const priceStr = String(rawPrice).trim().toLowerCase();

  // "Free" / "free" → isFree
  if (priceStr === "free") {
    return { isFree: true, priceMin: undefined };
  }

  // Numeric price
  const num = parseFloat(priceStr.replace(/[^0-9.]/g, ""));
  if (!isNaN(num)) {
    return { isFree: num === 0, priceMin: num };
  }

  return { isFree: false };
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
  eventUrl: string | undefined
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

function schemaEventToItem(
  ev: SchemaOrgEvent,
  source: EventSource,
  now: string
): EventItem | null {
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
  const id = stableId(title, startDatetime, venueOrUrl);

  const item: EventItem = {
    id,
    title,
    startDatetime,
    ...(endDatetime !== undefined && { endDatetime }),
    allDay: false,
    ...(venue !== undefined && { venue }),
    ...(address !== undefined && { address }),
    category,
    tags: [],
    isFree: priceInfo.isFree,
    ...(priceInfo.priceMin !== undefined && { priceMin: priceInfo.priceMin }),
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

  // Extract all <script type="application/ld+json"> block contents
  const scriptRegex = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptRegex.exec(html)) !== null) {
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

      const item = schemaEventToItem(schemaResult.data, source, now);
      if (item !== null) {
        results.push(item);
      }
    }
  }

  return results;
}
