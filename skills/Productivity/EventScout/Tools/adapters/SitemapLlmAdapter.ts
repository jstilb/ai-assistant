#!/usr/bin/env bun
/**
 * SitemapLlmAdapter.ts — XML-sitemap-enumerated detail pages → EventItem.
 *
 * For sites with NO events page, calendar plugin, ICS feed, or JSON-LD, whose
 * offerings live as one server-rendered detail page each, enumerated only by
 * an XML sitemap. First user: San Diego Writers, Ink (writeyourstorynow.org),
 * a WordPress/Elementor site whose classes, workshops, readings, certificate
 * cohorts, and recurring writing/critique groups are custom-post-type pages
 * listed in per-CPT Yoast sitemaps (classes-workshops-sitemap.xml etc.).
 * The listing pages under /all-programs/ show only titles + dates; exact
 * TIME / VENUE / PRICE blocks exist ONLY on the detail pages — hence this
 * adapter walks the pages instead of scraping a listing.
 *
 * Pipeline:
 *   1. Fetch the sitemap (source.url), parse <loc> entries. A <sitemapindex>
 *      is a misconfiguration (point the source at a LEAF sitemap) → throw.
 *      Drop hub entries (a path-prefix of another entry — Yoast lists the
 *      CPT archive page alongside its children; see dropHubEntries).
 *   2. Skip stale date-slugged pages: SDWI slugs its dated offerings
 *      "/2026-09-13-how-to-self-publish-…" — a slug date more than
 *      SLUG_DATE_GRACE_DAYS before today means the offering already started;
 *      skipping it saves the fetch. Recent starts still get fetched so the
 *      LLM can judge remaining sessions of an in-progress series. Undated
 *      slugs (recurring groups) are always fetched.
 *   3. Fetch each remaining page (bounded concurrency), slice out <main> (the
 *      Elementor nav/footer dwarfs the ~1KB content block), strip tags.
 *   4. Group "PAGE: <url>" blocks into page-aligned batches under the LLM
 *      window size and run the shared extractEventsFromContent kernel per
 *      batch — the LLM resolves recurrence ("Every Thursday", "Second Monday
 *      of Every Month") to the next occurrence, the same treatment
 *      dancestudio-pro classes get.
 *   5. Post-pass: events missing a ticketUrl get the URL of the unique page
 *      block containing their title, so bestLink() lands on the detail page
 *      instead of the sitemap XML (which is non-navigable → Google fallback).
 *
 * Error policy: sitemap failure or an empty sitemap throws; individual page
 * failures are logged and tolerated, but ALL pages failing throws (a bot-wall
 * or site change must surface loudly, not cache an honest-looking zero).
 *
 * A second sitemap-only site reuses this adapter as-is: one sources.json
 * entry per leaf sitemap, fetchTier "sitemap-llm".
 */

import { runWithConcurrency } from "../lib/concurrency.ts";
import type { EventItem, EventSource } from "../types.ts";
import { extractEventsFromContent, todayLaDateString } from "./SPAAdapter.ts";

// ============================================================================
// Tunables
// ============================================================================

/** Per-request timeout — detail pages are ~300KB of static HTML. */
const FETCH_TIMEOUT_MS = 30_000;

/** Parallel page fetches. Polite to a small nonprofit's shared host. */
const PAGE_FETCH_CONCURRENCY = 4;

/**
 * Hard cap on detail pages fetched per refresh — a runaway-sitemap backstop
 * (SDWI's largest CPT sitemap is 35 URLs). Overflow is logged loudly, never
 * silently truncated.
 */
const MAX_PAGES = 60;

/**
 * Keep date-slugged pages this many days past their slug date. A slug date is
 * a START date — multi-session series run for weeks — so recent starters stay
 * fetchable for the LLM to judge; anything older is dead inventory.
 */
const SLUG_DATE_GRACE_DAYS = 7;

/** Same real-browser UA story as BrightDataTool tier 3 — will age. */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

/** Separator between page blocks in the concatenated LLM content. */
const PAGE_SEPARATOR = "\n\n=====\n\n";

/**
 * Max chars per extraction batch — under SPAAdapter's LLM_CHUNK_SIZE (40KB)
 * so every batch is a single non-overlapping window. See batchBlocks().
 */
const BATCH_CHAR_BUDGET = 36_000;

// ============================================================================
// Pure helpers (unit-testable, no network)
// ============================================================================

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
}

/**
 * Parse `<url><loc>…</loc>[<lastmod>…</lastmod>]</url>` entries out of a leaf
 * sitemap. Throws on a `<sitemapindex>` (source must point at a leaf) and on
 * a sitemap with zero entries (site change must fail loudly).
 */
export function parseSitemapLocs(xml: string, sitemapUrl: string): SitemapEntry[] {
  if (/<sitemapindex[\s>]/i.test(xml)) {
    throw new Error(
      `[SitemapLlm] ${sitemapUrl} is a sitemap INDEX — point the source at one of its leaf sitemaps`
    );
  }
  const entries: SitemapEntry[] = [];
  for (const block of xml.match(/<url>[\s\S]*?<\/url>/gi) ?? []) {
    const loc = block.match(/<loc>\s*([^<\s][^<]*?)\s*<\/loc>/i)?.[1];
    if (!loc) continue;
    const lastmod = block.match(/<lastmod>\s*([^<\s][^<]*?)\s*<\/lastmod>/i)?.[1];
    entries.push({ loc, ...(lastmod !== undefined && { lastmod }) });
  }
  if (entries.length === 0) {
    throw new Error(
      `[SitemapLlm] ${sitemapUrl} contains no <url><loc> entries — sitemap format change?`
    );
  }
  return entries;
}

/**
 * Drop entries that are a path-prefix of another entry in the same sitemap.
 * Yoast CPT sitemaps list the post-type ARCHIVE page (/classes-workshops/)
 * alongside its detail pages (/classes-workshops/2026-09-13-…/); the archive
 * repeats every child's title+date without times, so the LLM re-extracts the
 * lot with invented times, duplicating the detail-page events — live-verified
 * 2026-08-24. Detail pages are never prefixes of each other, so only hubs go.
 */
export function dropHubEntries(entries: SitemapEntry[]): SitemapEntry[] {
  const norm = (u: string) => u.replace(/\/+$/, "") + "/";
  return entries.filter(
    (e) =>
      !entries.some((other) => other !== e && norm(other.loc).startsWith(norm(e.loc)))
  );
}

/**
 * "YYYY-MM-DD" prefix of the URL's last path segment, or null for undated
 * slugs (recurring groups). E.g. …/classes-workshops/2026-09-13-how-to-… →
 * "2026-09-13".
 */
export function slugDateOf(url: string): string | null {
  const lastSegment = url.replace(/\/+$/, "").split("/").pop() ?? "";
  return lastSegment.match(/^(\d{4}-\d{2}-\d{2})-/)?.[1] ?? null;
}

/**
 * Drop date-slugged pages whose slug date is more than `SLUG_DATE_GRACE_DAYS`
 * before `todayLaDate` ("YYYY-MM-DD"), then cap at MAX_PAGES (loudly).
 * String comparison suffices — both sides are ISO date strings.
 */
export function filterFetchWorthy(
  entries: SitemapEntry[],
  todayLaDate: string
): SitemapEntry[] {
  const [y, m, d] = todayLaDate.split("-").map(Number) as [number, number, number];
  const cutoffMs = Date.UTC(y, m - 1, d - SLUG_DATE_GRACE_DAYS);
  const cutoff = new Date(cutoffMs).toISOString().slice(0, 10);

  const fresh = entries.filter((e) => {
    const slugDate = slugDateOf(e.loc);
    return slugDate === null || slugDate >= cutoff;
  });
  if (fresh.length > MAX_PAGES) {
    console.warn(
      `[SitemapLlm] capping ${fresh.length} fetch-worthy pages to ${MAX_PAGES} — ` +
        `pages beyond the cap are DROPPED this refresh`
    );
    return fresh.slice(0, MAX_PAGES);
  }
  return fresh;
}

/**
 * Visible text of a detail page: prefer the <main> element (Elementor pages
 * repeat a ~150-line nav+footer around a ~1KB content block), else <body>,
 * else the whole document; strip scripts/styles/tags, decode common entities,
 * collapse whitespace.
 */
export function extractMainText(html: string): string {
  const region =
    html.match(/<main[\s>][\s\S]*?<\/main>/i)?.[0] ??
    html.match(/<body[\s>][\s\S]*?<\/body>/i)?.[0] ??
    html;
  const noTags = region
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, "\n");
  return decodeEntities(noTags)
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** Minimal HTML entity decode — numeric plus the handful SDWI pages use. */
export function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    rsquo: "’",
    lsquo: "‘",
    rdquo: "”",
    ldquo: "“",
    hellip: "…",
  };
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => named[name.toLowerCase()] ?? m);
}

export interface PageBlock {
  url: string;
  text: string;
}

/**
 * Events whose ticketUrl the LLM left unset get the URL of the UNIQUE page
 * block containing their title (case-insensitive). Ambiguous or absent titles
 * stay unset — bestLink() then falls back to a scoped Google search, since
 * the sitemap sourceUrl is .xml and deliberately non-navigable. Returns new
 * objects; never mutates input.
 */
export function attributeTicketUrls(
  events: EventItem[],
  blocks: PageBlock[]
): EventItem[] {
  const lowered = blocks.map((b) => ({ url: b.url, text: b.text.toLowerCase() }));
  return events.map((ev) => {
    if (ev.ticketUrl) return ev;
    const title = ev.title.trim().toLowerCase();
    if (!title) return ev;
    const hits = lowered.filter((b) => b.text.includes(title));
    return hits.length === 1 ? { ...ev, ticketUrl: hits[0]!.url } : ev;
  });
}

// ============================================================================
// Fetch runner
// ============================================================================

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status}`);
  }
  return res.text();
}

/**
 * Fetch every fresh detail page listed in the source's sitemap and extract
 * events via the shared JSON-LD → LLM kernel. Throws on sitemap failure or
 * when ALL page fetches fail; individual page failures are logged and
 * tolerated. Does NOT write to cache.
 */
export async function fetchSitemapLlmEvents(source: EventSource): Promise<EventItem[]> {
  const xml = await fetchText(source.url).catch((err: unknown) => {
    throw new Error(
      `[SitemapLlm] sitemap fetch failed for ${source.id}: ${(err as Error).message}`
    );
  });
  const entries = dropHubEntries(parseSitemapLocs(xml, source.url));
  const fresh = filterFetchWorthy(entries, todayLaDateString());
  console.log(
    `[SitemapLlm] ${source.id}: ${entries.length} sitemap entries, ${fresh.length} fetch-worthy`
  );
  if (fresh.length === 0) return [];

  const blocks: PageBlock[] = [];
  const failures: string[] = [];
  await runWithConcurrency(fresh, PAGE_FETCH_CONCURRENCY, async (entry) => {
    try {
      const html = await fetchText(entry.loc);
      const text = extractMainText(html);
      if (text.length === 0) {
        failures.push(`${entry.loc} (empty after strip)`);
        return;
      }
      blocks.push({ url: entry.loc, text });
    } catch (err) {
      failures.push(`${entry.loc} (${(err as Error).message})`);
    }
  });

  if (failures.length > 0) {
    console.warn(
      `[SitemapLlm] ${source.id}: ${failures.length}/${fresh.length} page fetches failed:\n` +
        failures.map((f) => `  - ${f}`).join("\n")
    );
  }
  if (blocks.length === 0) {
    throw new Error(
      `[SitemapLlm] ${source.id}: all ${fresh.length} page fetches failed — bot wall or site change?`
    );
  }

  // Keep sitemap order (concurrency lanes finish out of order) so batching
  // below is deterministic run-to-run.
  const order = new Map(fresh.map((e, i) => [e.loc, i]));
  blocks.sort((a, b) => (order.get(a.url) ?? 0) - (order.get(b.url) ?? 0));

  // Batch on PAGE boundaries, one kernel call per batch, instead of one giant
  // string: the kernel's raw 40KB windows OVERLAP, and a page split across a
  // window boundary gets extracted twice — once degenerate (midnight time, no
  // price, truncated URL) from the fragment. Live-verified 2026-08-24 on the
  // 35-page classes sitemap. Page-aligned batches under the window size make
  // each batch a single window: no splits, no overlap duplicates, same LLM
  // call count.
  const batches = batchBlocks(blocks);
  console.log(
    `[SitemapLlm] ${source.id}: ${blocks.length} pages in ${batches.length} extraction batch(es)`
  );
  const events: EventItem[] = [];
  for (const batch of batches) {
    events.push(...(await extractEventsFromContent(batch, source)));
  }
  return attributeTicketUrls(events, blocks);
}

/**
 * Group page blocks into concatenated batch strings of at most
 * BATCH_CHAR_BUDGET, never splitting a block. An oversized single page gets
 * its own batch (the kernel chunks it internally — acceptable for a page
 * that big). Each block carries a header line that doubles as content-level
 * prompting: without it the kernel leaves ticketUrl unset (or invents a
 * truncated archive URL) because the stripped text carries no hrefs —
 * live-verified 2026-08-24.
 */
export function batchBlocks(blocks: PageBlock[]): string[] {
  const rendered = blocks.map(
    (b) =>
      `PAGE (for every event found below, set ticketUrl to exactly this URL): ${b.url}\n${b.text}`
  );
  const batches: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  for (const r of rendered) {
    const addedLen = r.length + (current.length > 0 ? PAGE_SEPARATOR.length : 0);
    if (current.length > 0 && currentLen + addedLen > BATCH_CHAR_BUDGET) {
      batches.push(current.join(PAGE_SEPARATOR));
      current = [];
      currentLen = 0;
    }
    current.push(r);
    currentLen += r.length + (current.length > 1 ? PAGE_SEPARATOR.length : 0);
  }
  if (current.length > 0) batches.push(current.join(PAGE_SEPARATOR));
  return batches;
}
