#!/usr/bin/env bun
/**
 * ApifyAdapter.ts — EventScout Apify fetch tier.
 *
 * Uses Apify's `website-content-crawler` actor (Playwright/Firefox + Apify
 * proxy) to render JS-heavy pages and bypass Cloudflare, then runs the
 * standard EventScout JSON-LD → LLM extraction pipeline on the rendered
 * markdown.
 *
 * Exports:
 *   buildCrawlerInput(url: string): Record<string, unknown>
 *       PURE helper — returns the actor input object. No network. Testable.
 *
 *   loadApifyToken(): string
 *       Reads APIFY_TOKEN from ~/.claude/secrets.json. Throws if missing.
 *
 *   fetchApifyEvents(source: EventSource): Promise<EventItem[]>
 *       Full fetch → extract pipeline for a single EventSource.
 *       Throws on run failure or empty content (so Ingest records the reason).
 *
 * Token:
 *   APIFY_TOKEN is NOT in process.env during EventScout runs.
 *   It lives in ~/.claude/secrets.json. `loadApifyToken()` reads it from there,
 *   mirroring the pattern used by lib/core/Inference.ts for CLAUDE_CODE_OAUTH_TOKEN.
 *
 * Actor config (verified live by orchestrator):
 *   Actor:    apify/website-content-crawler
 *   Input:    buildCrawlerInput(url)
 *   Options:  { timeout: 200 }  (seconds)
 *   Items:    .markdown (preferred) | .text
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
// cross-skill-allowed: adapter wraps Data/Apify's fetch client by design — thin adapter over a shared client
import { Apify } from "../../../../Data/Apify/index.ts";
import { extractEventsFromContent } from "./SPAAdapter.ts";
import type { EventItem, EventSource } from "../types.ts";
import { defaultKayaHome } from "../../../../../lib/core/KayaHome.ts";

// ============================================================================
// Dataset item shape — only the fields we actually read
// ============================================================================

interface CrawlerDatasetItem {
  markdown?: string;
  text?: string;
  url?: string;
}

// ============================================================================
// buildCrawlerInput — PURE, no network (unit-testable)
// ============================================================================

/**
 * Default number of pages Apify crawls when no source-level override is set.
 *
 * COST NOTE: Apify bills per page crawled. The default was 1 (event listing
 * page only) in v1. Slice 6 raises this to 5 so multi-page event listings
 * (e.g. sandiego.org paginating across 3+ pages) are fully collected.
 * Sources with a `paginate.pages` field in sources.json override this value.
 * Set lower for budget-sensitive sources or raise for content-dense sources.
 *
 * Exported so callers (fetchApifyEvents, tests) can reference the default.
 */
export const APIFY_DEFAULT_CRAWL_PAGES = 5;

/**
 * Build the input object for `apify/website-content-crawler`.
 *
 * Configuration verified live by the orchestrator against sandiego.org (a
 * Cloudflare-protected Simpleview SPA whose event grid hydrates via AJAX):
 *   - crawlerType: "playwright:firefox"      — renders JS, bypasses Cloudflare
 *   - saveMarkdown: true                     — items have a `.markdown` field
 *   - proxyConfiguration.useApifyProxy: true — residential proxy pool
 *   - maxCrawlPages: maxPages                — configurable (default APIFY_DEFAULT_CRAWL_PAGES).
 *                                              Pass source.paginate?.pages from the
 *                                              caller to use the source-level override.
 *   - dynamicContentWaitSecs: 25             — wait for the AJAX event grid to load.
 *                                              Without it the page renders only the
 *                                              filter sidebar (category counts) and
 *                                              zero event cards.
 *   - maxScrollHeightPixels: 20000           — scroll to trigger lazy-loaded cards.
 *   - htmlTransformer: "none"                — CRITICAL. The default ("readableText")
 *                                              strips the event-card title anchors,
 *                                              leaving only image + date (no title →
 *                                              every event dropped, since title is
 *                                              required). "none" preserves the full
 *                                              DOM so titles, venues, and dates all
 *                                              survive into the markdown.
 *
 * This config is strictly more capable than a bare fetch (it only adds waiting,
 * scrolling, and DOM preservation), so it is shared by every "apify" source.
 *
 * @param url      - The event listing URL to crawl.
 * @param maxPages - Number of pages to crawl. Defaults to APIFY_DEFAULT_CRAWL_PAGES.
 *                   Pass source.paginate?.pages ?? APIFY_DEFAULT_CRAWL_PAGES from
 *                   fetchApifyEvents to respect per-source config.
 *
 * PURE — deterministic, no I/O, no Date calls.
 */
export function buildCrawlerInput(url: string, maxPages: number = APIFY_DEFAULT_CRAWL_PAGES): Record<string, unknown> {
  return {
    startUrls: [{ url }],
    maxCrawlPages: maxPages,
    crawlerType: "playwright:firefox",
    saveMarkdown: true,
    proxyConfiguration: { useApifyProxy: true },
    dynamicContentWaitSecs: 25,
    maxScrollHeightPixels: 20000,
    htmlTransformer: "none",
  };
}

// ============================================================================
// loadApifyToken — reads from ~/.claude/secrets.json
// ============================================================================

/**
 * Read APIFY_TOKEN from `~/.claude/secrets.json`.
 *
 * Mirrors the pattern used by `lib/core/Inference.ts` for CLAUDE_CODE_OAUTH_TOKEN:
 * reads the secrets file at call time (no caching — callers are infrequent).
 *
 * Throws a clear error when:
 *   - secrets.json does not exist
 *   - secrets.json is malformed / not parseable as JSON
 *   - APIFY_TOKEN key is absent or not a non-empty string
 */
export function loadApifyToken(): string {
  const secretsPath = join(defaultKayaHome(), "secrets.json");

  if (!existsSync(secretsPath)) {
    throw new Error(
      `[ApifyAdapter] secrets.json not found at ${secretsPath}. ` +
        `Add APIFY_TOKEN to that file to use the apify fetch tier.`
    );
  }

  let secrets: Record<string, unknown>;
  try {
    secrets = JSON.parse(readFileSync(secretsPath, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `[ApifyAdapter] Failed to parse secrets.json at ${secretsPath}: ${(err as Error).message}`
    );
  }

  const token = secrets["APIFY_TOKEN"];
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error(
      `[ApifyAdapter] APIFY_TOKEN is missing or empty in ${secretsPath}. ` +
        `Set it to your Apify API token to use the apify fetch tier.`
    );
  }

  return token.trim();
}

// ============================================================================
// fetchApifyEvents — full fetch + extract pipeline
// ============================================================================

/**
 * Fetch a JS-heavy / Cloudflare-protected event page via Apify's
 * `website-content-crawler` actor, then run EventScout's standard
 * JSON-LD → LLM extraction on the rendered markdown.
 *
 * Throws if:
 *   - APIFY_TOKEN cannot be loaded from secrets.json
 *   - The actor run does not finish with status "SUCCEEDED"
 *   - The dataset contains no items
 *   - The first item has neither `.markdown` nor `.text`
 *
 * Callers (Ingest.ts) wrap this in a per-source timeout and catch/log the
 * thrown error — so throwing here is the correct error-reporting path.
 *
 * @param source - EventSource with fetchTier === "apify".
 * @returns      - EventItem[] extracted from the rendered page; may be empty
 *                 if the page rendered but contained no recognisable events.
 */
export async function fetchApifyEvents(source: EventSource): Promise<EventItem[]> {
  console.log(`[ApifyAdapter] Fetching via Apify: ${source.url}`);

  // 1. Load token from secrets.json
  const token = loadApifyToken();

  // 2. Call the actor
  // Use source.paginate?.pages as maxCrawlPages if present (Slice 6: per-source config).
  // Falls back to APIFY_DEFAULT_CRAWL_PAGES. Cost note: Apify bills per page.
  const maxPages = source.paginate?.pages ?? APIFY_DEFAULT_CRAWL_PAGES;
  const apify = new Apify(token);
  const input = buildCrawlerInput(source.url, maxPages);

  const run = await apify.callActor(
    "apify/website-content-crawler",
    input,
    { timeout: 200 }, // seconds — verified by orchestrator
  );

  console.log(`[ApifyAdapter] Actor run finished: status=${run.status} id=${run.id}`);

  if (run.status !== "SUCCEEDED") {
    throw new Error(
      `[ApifyAdapter] Actor run for ${source.url} did not succeed: status=${run.status}`
    );
  }

  // 3. Fetch dataset items
  const dataset = apify.getDataset(run.defaultDatasetId);
  const items = await dataset.listItems<CrawlerDatasetItem>({ limit: 1 });

  if (items.length === 0) {
    throw new Error(
      `[ApifyAdapter] Actor run for ${source.url} succeeded but dataset is empty`
    );
  }

  const firstItem = items[0];
  // firstItem is guaranteed by the length check above; narrow the type explicitly
  if (firstItem === undefined) {
    throw new Error(
      `[ApifyAdapter] Dataset item unexpectedly undefined for ${source.url}`
    );
  }

  const content: string | undefined = firstItem.markdown ?? firstItem.text;

  if (!content || content.trim() === "") {
    throw new Error(
      `[ApifyAdapter] Actor run for ${source.url} returned an item with no markdown or text content`
    );
  }

  console.log(
    `[ApifyAdapter] Rendered content: ${content.length} chars for ${source.url}`
  );

  // 4. Run the standard EventScout extraction pipeline (JSON-LD → LLM)
  const events = await extractEventsFromContent(content, source);

  console.log(
    `[ApifyAdapter] Extracted ${events.length} event(s) from ${source.url}`
  );

  return events;
}

// ============================================================================
// Script entry point — ad-hoc live test
// ============================================================================

const IS_SCRIPT =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("ApifyAdapter.ts") ||
    process.argv[1].endsWith("ApifyAdapter"));

if (IS_SCRIPT) {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: bun .../ApifyAdapter.ts <url>");
    process.exit(1);
  }

  // Minimal EventSource for ad-hoc testing
  const source: EventSource = {
    id: "apify-adhoc",
    url,
    name: "Ad-hoc Apify test",
    fetchTier: "apify",
    pollInterval: 60,
    enabled: true,
  };

  try {
    const events = await fetchApifyEvents(source);
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
