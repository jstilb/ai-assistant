#!/usr/bin/env bun
/**
 * ContentCollector.ts - Fetch content from all registered sources
 *
 * Orchestrates parallel collection from enabled RSS/Atom sources using
 * CachedHTTPClient for caching, retry, and rate limiting. Transforms
 * raw feed items into ContentItem format with content hashing.
 *
 * CLI Usage:
 *   bun ContentCollector.ts                     Collect from all enabled sources
 *   bun ContentCollector.ts --source "id"       Collect from specific source
 *   bun ContentCollector.ts --dry-run           Show what would be collected
 *   bun ContentCollector.ts --json              JSON output
 */

import { createHTTPClient, type CachedHTTPClient } from "../../../skills/CORE/Tools/CachedHTTPClient.ts";
import { parseRSSFeed, type FeedItem } from "./RSSParser.ts";
import {
  listSources,
  getSourcesDueForPoll,
  getSource,
  recordSourcePoll,
  recordSourceFailure,
  recordSourceSuccess,
} from "./SourceManager.ts";
import {
  type ContentItem,
  type ContentSource,
  type CollectionResult,
  type CollectionSummary,
} from "./types.ts";

// ============================================================================
// HTTP Client (dedicated instance for content collection)
// ============================================================================

const httpClient: CachedHTTPClient = createHTTPClient({
  defaultTtl: 900, // 15-minute cache for feeds
  maxRetries: 2,
  userAgent: "Kaya-ContentAggregator/1.0 (bun)",
});

// ============================================================================
// Content Item Creation
// ============================================================================

function generateId(): string {
  return `ci-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function hashContent(text: string): string {
  if (typeof Bun !== "undefined" && Bun.hash) {
    return Bun.hash(text).toString(16);
  }
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

function feedItemToContentItem(
  feedItem: FeedItem,
  source: ContentSource
): ContentItem {
  const now = new Date().toISOString();

  return {
    id: generateId(),
    sourceId: source.id,
    sourceType: source.type,
    title: feedItem.title,
    url: feedItem.url,
    canonicalUrl: normalizeUrl(feedItem.url),
    author: feedItem.author,
    publishedAt: feedItem.publishedAt,
    collectedAt: now,
    body: feedItem.body,
    tags: [...feedItem.tags, ...source.topics],
    topics: [], // Set by topic matching later
    relevanceScore: 0, // Set by scoring later
    goalAlignment: [],
    contentHash: hashContent(feedItem.title + feedItem.url + feedItem.body.slice(0, 500)),
    summary: "", // Set by summarizer later
    status: "new",
    deliveredVia: [],
  };
}

// ============================================================================
// URL Normalization (shared with ContentDeduplicator)
// ============================================================================

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);

    // Remove www. prefix
    let hostname = parsed.hostname.replace(/^www\./, "");
    parsed.hostname = hostname;

    // Remove tracking params
    const trackingParams = [
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "ref", "source", "fbclid", "gclid", "mc_cid", "mc_eid",
      "s", "share", "via",
    ];
    for (const param of trackingParams) {
      parsed.searchParams.delete(param);
    }

    // Remove trailing slash (but keep root /)
    let path = parsed.pathname;
    if (path.length > 1 && path.endsWith("/")) {
      path = path.slice(0, -1);
    }
    parsed.pathname = path;

    // Remove hash
    parsed.hash = "";

    // Force HTTPS
    parsed.protocol = "https:";

    return parsed.toString();
  } catch {
    return url;
  }
}

// ============================================================================
// Single Source Collection
// ============================================================================

async function collectFromSource(source: ContentSource): Promise<{
  items: ContentItem[];
  result: CollectionResult;
}> {
  const startTime = Date.now();
  const result: CollectionResult = {
    sourceId: source.id,
    sourceName: source.name,
    itemsFound: 0,
    itemsNew: 0,
    itemsDuplicate: 0,
    durationMs: 0,
  };

  try {
    // Use fetchWithHash for change detection
    const fetchResult = await httpClient.fetchWithHash(
      source.url,
      source.lastContentHash,
      {
        cache: "disk",
        ttl: source.pollInterval * 60, // Cache matches poll interval
        timeout: 15000, // 15s timeout per source
        retry: 2,
      }
    );

    // Record the poll
    await recordSourcePoll(source.id, fetchResult.hash);

    // If content hasn't changed, skip parsing
    if (!fetchResult.changed && source.lastContentHash) {
      result.durationMs = Date.now() - startTime;
      await recordSourceSuccess(source.id);
      return { items: [], result };
    }

    // Parse the feed
    const feed = parseRSSFeed(fetchResult.data);
    result.itemsFound = feed.items.length;

    // Convert to ContentItems
    const items = feed.items.map((feedItem) =>
      feedItemToContentItem(feedItem, source)
    );

    result.itemsNew = items.length;
    result.durationMs = Date.now() - startTime;

    await recordSourceSuccess(source.id);
    return { items, result };
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.durationMs = Date.now() - startTime;

    const { disabled } = await recordSourceFailure(source.id);
    if (disabled) {
      result.error += " (source auto-disabled after 5 failures)";
    }

    return { items: [], result };
  }
}

// ============================================================================
// Batch Collection
// ============================================================================

export async function collectAll(options: {
  dueOnly?: boolean;
  sourceId?: string;
  concurrency?: number;
}): Promise<{ items: ContentItem[]; summary: CollectionSummary }> {
  const { dueOnly = true, sourceId, concurrency = 5 } = options;
  const startTime = Date.now();

  // Determine which sources to collect
  let sources: ContentSource[];
  if (sourceId) {
    const source = await getSource(sourceId);
    sources = source ? [source] : [];
  } else if (dueOnly) {
    sources = await getSourcesDueForPoll();
  } else {
    sources = await listSources(true);
  }

  const allItems: ContentItem[] = [];
  const results: CollectionResult[] = [];

  // Process in batches for controlled concurrency
  for (let i = 0; i < sources.length; i += concurrency) {
    const batch = sources.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map((source) => collectFromSource(source))
    );

    for (const settled of batchResults) {
      if (settled.status === "fulfilled") {
        allItems.push(...settled.value.items);
        results.push(settled.value.result);
      } else {
        // This shouldn't happen since collectFromSource catches errors
        results.push({
          sourceId: "unknown",
          sourceName: "unknown",
          itemsFound: 0,
          itemsNew: 0,
          itemsDuplicate: 0,
          error: settled.reason?.message || "Unknown error",
          durationMs: 0,
        });
      }
    }
  }

  const summary: CollectionSummary = {
    totalSources: sources.length,
    successfulSources: results.filter((r) => !r.error).length,
    failedSources: results.filter((r) => !!r.error).length,
    totalItemsFound: results.reduce((sum, r) => sum + r.itemsFound, 0),
    totalNewItems: allItems.length,
    totalDuplicates: 0, // Set after dedup
    durationMs: Date.now() - startTime,
    results,
  };

  return { items: allItems, summary };
}

// ============================================================================
// CLI Interface
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const hasFlag = (name: string) => args.includes(name);
  const getArg = (name: string): string | undefined => {
    const idx = args.indexOf(name);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
  };

  if (hasFlag("--help")) {
    console.log(`
ContentCollector - Fetch content from registered sources

Usage:
  bun ContentCollector.ts                        Collect from due sources
  bun ContentCollector.ts --all                  Collect from ALL enabled sources
  bun ContentCollector.ts --source "id"          Collect from specific source
  bun ContentCollector.ts --dry-run              Show what would be collected
  bun ContentCollector.ts --json                 JSON output
`);
    return;
  }

  const jsonOutput = hasFlag("--json");
  const dryRun = hasFlag("--dry-run");
  const sourceId = getArg("--source");
  const collectAllSources = hasFlag("--all");

  if (dryRun) {
    const sources = sourceId
      ? [await getSource(sourceId)].filter(Boolean) as ContentSource[]
      : collectAllSources
        ? await listSources(true)
        : await getSourcesDueForPoll();

    if (jsonOutput) {
      console.log(JSON.stringify(sources.map((s) => ({
        id: s.id,
        name: s.name,
        url: s.url,
        lastPolled: s.lastPolled || "never",
      })), null, 2));
    } else {
      console.log(`\n  ${sources.length} sources would be collected:\n`);
      for (const s of sources) {
        console.log(`  - ${s.name} (${s.url})`);
        console.log(`    Last polled: ${s.lastPolled || "never"}`);
      }
      console.log();
    }
    return;
  }

  console.log("Starting content collection...\n");

  const { items, summary } = await collectAll({
    dueOnly: !collectAllSources,
    sourceId,
  });

  if (jsonOutput) {
    console.log(JSON.stringify({ summary, itemCount: items.length }, null, 2));
  } else {
    console.log(`  Collection Complete:`);
    console.log(`  -------------------`);
    console.log(`  Sources polled:   ${summary.totalSources}`);
    console.log(`  Successful:       ${summary.successfulSources}`);
    console.log(`  Failed:           ${summary.failedSources}`);
    console.log(`  Items found:      ${summary.totalItemsFound}`);
    console.log(`  New items:        ${summary.totalNewItems}`);
    console.log(`  Duration:         ${summary.durationMs}ms`);
    console.log();

    if (summary.failedSources > 0) {
      console.log("  Failed sources:");
      for (const r of summary.results.filter((r) => r.error)) {
        console.log(`    - ${r.sourceName}: ${r.error}`);
      }
      console.log();
    }

    if (items.length > 0) {
      console.log(`  Recent items (first 10):`);
      for (const item of items.slice(0, 10)) {
        console.log(`    - [${item.sourceType}] ${item.title}`);
        console.log(`      ${item.url}`);
      }
      console.log();
    }
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
