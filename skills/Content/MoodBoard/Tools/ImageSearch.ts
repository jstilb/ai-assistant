#!/usr/bin/env bun
/**
 * ImageSearch.ts - Keyless, free image search across Openverse, Wikimedia
 * Commons, and the Met Museum open-access API.
 *
 * All three sources are free, require NO API key, and return properly
 * licensed imagery (CC / public domain) with attribution metadata intact.
 * (Unsplash's unofficial endpoint now requires auth; Pinterest has no free
 * API — for Pinterest, browse and pin URLs manually via BoardStore add-pin.)
 *
 * Usage:
 *   bun Tools/ImageSearch.ts "japandi bedroom" --count 8 --json
 *   bun Tools/ImageSearch.ts "1970s menswear" --sources met,wikimedia
 *
 * Flags:
 *   --sources openverse,wikimedia,met   (default: all three)
 *   --count N                           results per source (default 8, max 20)
 *   --json                              machine-readable output
 *
 * Exit codes: 0 = at least one source succeeded; 1 = every source failed.
 *
 * @module MoodBoard/ImageSearch
 */

import { httpClient } from "../../../../lib/core/CachedHTTPClient.ts";
import type { ImageCandidate, PinSource, SourceResult } from "./Types.ts";

const USER_AGENT = "KayaMoodBoard/1.0 (personal moodboard tool)";
const FETCH_OPTS = {
  cache: "disk" as const,
  ttl: 21600, // 6h — inspiration searches repeat within a session, not across weeks
  timeout: 15000,
  retry: 2,
  headers: { "User-Agent": USER_AGENT },
};

export const SEARCHABLE_SOURCES = ["openverse", "wikimedia", "met"] as const;
export type SearchableSource = (typeof SEARCHABLE_SOURCES)[number];

// ---------------------------------------------------------------------------
// Openverse (api.openverse.org) — CC-licensed imagery, mostly Flickr/Commons
// ---------------------------------------------------------------------------

interface OpenverseResult {
  title?: string | null;
  url?: string | null;
  thumbnail?: string | null;
  foreign_landing_url?: string | null;
  creator?: string | null;
  license?: string | null;
  license_version?: string | null;
}

interface OpenverseResponse {
  results?: OpenverseResult[];
}

export function mapOpenverse(json: OpenverseResponse, query: string): ImageCandidate[] {
  const results = Array.isArray(json.results) ? json.results : [];
  const candidates: ImageCandidate[] = [];
  for (const r of results) {
    if (!r.url) continue;
    const license = r.license
      ? `CC ${r.license.toUpperCase()}${r.license_version ? ` ${r.license_version}` : ""}`
      : undefined;
    candidates.push({
      imageUrl: r.url,
      thumbUrl: r.thumbnail ?? undefined,
      pageUrl: r.foreign_landing_url ?? undefined,
      title: (r.title ?? "").trim(),
      source: "openverse",
      creator: r.creator ?? undefined,
      license,
      query,
    });
  }
  return candidates;
}

async function searchOpenverse(query: string, count: number): Promise<ImageCandidate[]> {
  const url =
    `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}` +
    `&page_size=${count}&mature=false`;
  const json = await httpClient.fetchJson<OpenverseResponse>(url, FETCH_OPTS);
  return mapOpenverse(json, query);
}

// ---------------------------------------------------------------------------
// Wikimedia Commons — free media repository, strong on reference imagery
// ---------------------------------------------------------------------------

interface CommonsExtMetadataField {
  value?: string;
}

interface CommonsImageInfo {
  thumburl?: string;
  url?: string;
  descriptionurl?: string;
  mime?: string;
  extmetadata?: {
    Artist?: CommonsExtMetadataField;
    LicenseShortName?: CommonsExtMetadataField;
    ObjectName?: CommonsExtMetadataField;
  };
}

interface CommonsPage {
  title?: string;
  imageinfo?: CommonsImageInfo[];
}

interface CommonsResponse {
  query?: { pages?: Record<string, CommonsPage> };
}

/** Commons Artist fields arrive as HTML fragments — strip to plain text. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function mapWikimedia(json: CommonsResponse, query: string): ImageCandidate[] {
  const pages = json.query?.pages ?? {};
  const candidates: ImageCandidate[] = [];
  for (const page of Object.values(pages)) {
    const info = page.imageinfo?.[0];
    if (!info?.url) continue;
    // Commons File: namespace includes PDFs/DJVU/video — keep raster images only
    if (info.mime && !info.mime.startsWith("image/")) continue;
    const title = (page.title ?? "").replace(/^File:/, "").replace(/\.[a-zA-Z0-9]+$/, "");
    const artist = info.extmetadata?.Artist?.value;
    const license = info.extmetadata?.LicenseShortName?.value;
    candidates.push({
      imageUrl: info.url,
      thumbUrl: info.thumburl ?? undefined,
      pageUrl: info.descriptionurl ?? undefined,
      title,
      source: "wikimedia",
      creator: artist ? stripHtml(artist) : undefined,
      license: license ? stripHtml(license) : undefined,
      query,
    });
  }
  return candidates;
}

async function searchWikimedia(query: string, count: number): Promise<ImageCandidate[]> {
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&generator=search" +
    `&gsrsearch=${encodeURIComponent(`filetype:bitmap ${query}`)}&gsrnamespace=6&gsrlimit=${count}` +
    "&prop=imageinfo&iiprop=url%7Cextmetadata%7Cmime&iiurlwidth=800&format=json";
  const json = await httpClient.fetchJson<CommonsResponse>(url, FETCH_OPTS);
  return mapWikimedia(json, query);
}

// ---------------------------------------------------------------------------
// Met Museum open access — art, Costume Institute (fashion history gold)
// ---------------------------------------------------------------------------

interface MetSearchResponse {
  objectIDs?: number[] | null;
}

export interface MetObject {
  objectID?: number;
  title?: string;
  primaryImageSmall?: string;
  primaryImage?: string;
  artistDisplayName?: string;
  objectDate?: string;
  objectURL?: string;
  isPublicDomain?: boolean;
  department?: string;
}

export function mapMetObject(obj: MetObject, query: string): ImageCandidate | null {
  const image = obj.primaryImageSmall || obj.primaryImage;
  if (!image) return null;
  const datePart = obj.objectDate ? ` (${obj.objectDate})` : "";
  return {
    imageUrl: image,
    thumbUrl: obj.primaryImageSmall || undefined,
    pageUrl: obj.objectURL || undefined,
    title: `${obj.title ?? "Untitled"}${datePart}`,
    source: "met",
    creator: obj.artistDisplayName || undefined,
    license: obj.isPublicDomain ? "Public Domain (Met Open Access)" : undefined,
    query,
  };
}

async function searchMet(query: string, count: number): Promise<ImageCandidate[]> {
  const searchUrl =
    "https://collectionapi.metmuseum.org/public/collection/v1/search" +
    `?q=${encodeURIComponent(query)}&hasImages=true`;
  const search = await httpClient.fetchJson<MetSearchResponse>(searchUrl, FETCH_OPTS);
  const ids = (search.objectIDs ?? []).slice(0, Math.min(count * 4, 32));

  const candidates: ImageCandidate[] = [];
  // Sequential-ish batches of 8 — polite to the free API, still fast enough
  for (let i = 0; i < ids.length && candidates.length < count; i += 8) {
    const batch = ids.slice(i, i + 8);
    const objects = await Promise.allSettled(
      batch.map((id) =>
        httpClient.fetchJson<MetObject>(
          `https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`,
          FETCH_OPTS
        )
      )
    );
    for (const settled of objects) {
      if (settled.status !== "fulfilled") continue;
      const candidate = mapMetObject(settled.value, query);
      if (candidate) candidates.push(candidate);
      if (candidates.length >= count) break;
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const SEARCHERS: Record<SearchableSource, (q: string, n: number) => Promise<ImageCandidate[]>> = {
  openverse: searchOpenverse,
  wikimedia: searchWikimedia,
  met: searchMet,
};

export async function searchImages(
  query: string,
  options: { sources?: SearchableSource[]; count?: number } = {}
): Promise<SourceResult[]> {
  const sources = options.sources ?? [...SEARCHABLE_SOURCES];
  const count = Math.min(Math.max(options.count ?? 8, 1), 20);

  return Promise.all(
    sources.map(async (source): Promise<SourceResult> => {
      try {
        const candidates = await SEARCHERS[source](query, count);
        return { source, ok: true, candidates };
      } catch (err) {
        return {
          source,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          candidates: [],
        };
      }
    })
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function isSearchableSource(value: string): value is SearchableSource {
  return (SEARCHABLE_SOURCES as readonly string[]).includes(value);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const VALUE_FLAGS = new Set(["--sources", "--count"]);
  const positional = args.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1] ?? ""));
  const query = positional[0];

  if (!query || args.includes("--help")) {
    console.log('Usage: bun Tools/ImageSearch.ts "<query>" [--sources openverse,wikimedia,met] [--count 8] [--json]');
    process.exit(query ? 0 : 1);
  }

  const sourcesIdx = args.indexOf("--sources");
  const rawSources = sourcesIdx >= 0 ? (args[sourcesIdx + 1] ?? "") : SEARCHABLE_SOURCES.join(",");
  const sources = rawSources.split(",").map((s) => s.trim()).filter(isSearchableSource);
  if (sources.length === 0) {
    console.error(`No valid sources in "${rawSources}". Valid: ${SEARCHABLE_SOURCES.join(", ")}`);
    process.exit(1);
  }

  const countIdx = args.indexOf("--count");
  const count = countIdx >= 0 ? parseInt(args[countIdx + 1] ?? "8", 10) || 8 : 8;
  const jsonOutput = args.includes("--json");

  const results = await searchImages(query, { sources, count });
  const anyOk = results.some((r) => r.ok);

  if (jsonOutput) {
    console.log(JSON.stringify({ query, results }, null, 2));
  } else {
    for (const r of results) {
      if (!r.ok) {
        console.log(`\n[${r.source}] FAILED: ${r.error}`);
        continue;
      }
      console.log(`\n[${r.source}] ${r.candidates.length} results for "${query}"`);
      for (const c of r.candidates) {
        const meta = [c.creator, c.license].filter(Boolean).join(" · ");
        console.log(`  - ${c.title || "(untitled)"}${meta ? ` — ${meta}` : ""}`);
        console.log(`    ${c.imageUrl}`);
      }
    }
  }

  if (!anyOk) {
    console.error("\nAll image sources failed — check network / API availability.");
    process.exit(1);
  }
}
