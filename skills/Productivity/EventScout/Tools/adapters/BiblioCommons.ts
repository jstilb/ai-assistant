import { createHash } from "node:crypto";
import { z } from "zod";
import { EventItemSchema } from "../types.ts";
import type { EventItem, EventSource } from "../types.ts";
import { naiveLaToUtcMs, utcIsoToLaIso } from "../lib/tz.ts";

const DefinitionSchema = z.object({
  title: z.string().refine((title) => title.trim().length > 0),
  start: z.string(),
  end: z.string(),
  // Off-site events (parks, partner venues) send branchLocationId: null and a nonBranchLocationId into entities.places.
  branchLocationId: z.string().nullish(),
  nonBranchLocationId: z.string().nullish(),
  isCancelled: z.boolean(),
  description: z.string().optional(),
});
const LocationSchema = z.object({
  name: z.string().trim().min(1),
  address: z.object({
    number: z.string().optional(), street: z.string().optional(),
    city: z.string().optional(), state: z.string().optional(), zip: z.string().optional(),
  }).optional(),
  mapLocation: z.object({
    timeZone: z.literal("America/Los_Angeles"),
    centrePoint: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
  }),
});
const StateSchema = z.object({
  entities: z.object({ events: z.record(z.string(), z.unknown()), locations: z.record(z.string(), z.unknown()), places: z.record(z.string(), z.unknown()).optional() }),
  events: z.object({ eventsSearch: z.object({ results: z.array(z.string().regex(/^[a-f0-9]{24}$/)) }) }),
  // featuredEvent is not parsed: its shape changed (string id -> object, live 2026-11 sends {}) and a featured event is also in results.
});

function localDatetime(raw: string, end: boolean): string {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?$/.test(raw)) {
    throw new Error(`[BiblioCommons] Unsupported local date: ${raw}`);
  }
  const naive = raw.length === 10 ? `${raw}T${end ? "23:59:59" : "00:00:00"}` : raw.length === 16 ? `${raw}:00` : raw;
  const ms = naiveLaToUtcMs(naive);
  if (!Number.isFinite(ms)) throw new Error(`[BiblioCommons] Invalid local date: ${raw}`);
  const iso = utcIsoToLaIso(new Date(ms).toISOString());
  if (iso.slice(0, 19) !== naive) throw new Error(`[BiblioCommons] Invalid local date: ${raw}`);
  return iso;
}

function descriptionText(raw: string): string {
  return raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/<\/?(?:p|div|br|h[1-6])\b[^>]*>/gi, "\n").replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")
    .split(/\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

/** null means this page has no supported payload; malformed recognized payloads throw. */
export function extractBiblioCommonsEvents(html: string, source: EventSource): EventItem[] | null {
  const url = new URL(source.url);
  if (url.hostname !== "sdcl.bibliocommons.com" || !/^\/v2\/events(?:\/|$)/.test(url.pathname)) return null;
  const scripts = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    const attributes = match[1] ?? "";
    if (!/\btype\s*=\s*["']application\/json["']/i.test(attributes) || !/\bdata-iso-key\s*=\s*["']_0["']/i.test(attributes)) continue;
    const state = StateSchema.parse(JSON.parse(match[2] ?? ""));
    const search = state.events.eventsSearch;
    const ids = [...new Set(search.results)];
    const now = new Date().toISOString();
    return ids.map((id) => {
      const event = z.object({ id: z.literal(id), definition: DefinitionSchema }).parse(state.entities.events[id]);
      const definition = event.definition;
      const location = definition.branchLocationId ? LocationSchema.parse(state.entities.locations[definition.branchLocationId])
        : definition.nonBranchLocationId ? LocationSchema.parse(state.entities.places?.[definition.nonBranchLocationId])
        : (() => { throw new Error(`[BiblioCommons] Event has no branch or place location: ${id}`); })();
      const startDatetime = localDatetime(definition.start, false);
      const endDatetime = localDatetime(definition.end, true);
      if (Date.parse(endDatetime) < Date.parse(startDatetime)) throw new Error(`[BiblioCommons] Reversed interval: ${id}`);
      const description = descriptionText(definition.description ?? "");
      // A free resource or registration option does not establish free admission.
      const isFree = !/\b(?:paid|tickets?|admission fee|members only)\b|\$\s*\d/i.test(description) && description.split("\n").some((line) =>
        /^free (?:admission|entry|(?:[a-z]+ )?(?:lessons|classes))(?: for adults)?[.!]?$/i.test(line));
      const address = location.address;
      const formattedAddress = address ? [[address.number, address.street].filter(Boolean).join(" "), address.city, address.state, address.zip].filter(Boolean).join(", ") : undefined;
      const canonicalUrl = new URL(`/v2/events/${id}`, url.origin).href;
      return EventItemSchema.parse({
        id: createHash("sha256").update(canonicalUrl).digest("hex").slice(0, 16),
        title: definition.title, startDatetime, endDatetime,
        allDay: definition.start.length === 10 && definition.end.length === 10,
        venue: location.name, ...(formattedAddress && { address: formattedAddress }),
        ...(location.mapLocation.centrePoint ?? {}),
        category: source.categoryHint ?? "community", tags: [], isFree,
        ...(isFree && { priceMin: 0 }), description,
        ticketUrl: canonicalUrl, sourceUrl: source.url,
        sources: [{ sourceId: source.id, url: canonicalUrl }],
        fetchedAt: now, status: definition.isCancelled ? "cancelled" : "scheduled",
      });
    });
  }
  return null;
}
