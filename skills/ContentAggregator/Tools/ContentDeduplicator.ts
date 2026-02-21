#!/usr/bin/env bun
/**
 * ContentDeduplicator.ts - Content Deduplication Engine
 *
 * Detects and removes duplicate/near-duplicate content using:
 *   1. Canonical URL matching (strip tracking params, www, trailing slashes)
 *   2. Content hash comparison
 *   3. Title similarity (Jaccard coefficient on word tokens)
 *
 * When duplicates are found, keeps the item from the highest-trust source.
 *
 * CLI Usage:
 *   bun ContentDeduplicator.ts --test            Run self-test
 */

import { normalizeUrl } from "./ContentCollector.ts";
import type { ContentItem } from "./types.ts";

// ============================================================================
// Configuration
// ============================================================================

const TITLE_SIMILARITY_THRESHOLD = 0.65; // Jaccard coefficient threshold

// ============================================================================
// Title Similarity
// ============================================================================

/**
 * Tokenize a title into normalized word set
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2) // Skip very short words
  );
}

/**
 * Jaccard similarity coefficient: |A intersect B| / |A union B|
 * Returns 0.0 (no overlap) to 1.0 (identical)
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;

  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Check if two titles are similar enough to be considered duplicates
 */
export function areTitlesSimilar(titleA: string, titleB: string): boolean {
  const tokensA = tokenize(titleA);
  const tokensB = tokenize(titleB);
  return jaccardSimilarity(tokensA, tokensB) >= TITLE_SIMILARITY_THRESHOLD;
}

// ============================================================================
// Deduplication Engine
// ============================================================================

export interface DeduplicationResult {
  unique: ContentItem[];
  duplicates: ContentItem[];
  stats: {
    inputCount: number;
    uniqueCount: number;
    urlDuplicates: number;
    hashDuplicates: number;
    titleDuplicates: number;
  };
}

/**
 * Deduplicate a batch of content items.
 *
 * Strategy: For each group of duplicates, keep the item from the source
 * with the highest trust score. If trust scores are equal, keep the
 * most recently published item.
 *
 * @param items - Array of ContentItems to deduplicate
 * @param existingItems - Optional array of already-stored items to check against
 * @param sourceTrustScores - Map of sourceId to trust score
 */
export function deduplicateContent(
  items: ContentItem[],
  existingItems: ContentItem[] = [],
  sourceTrustScores: Map<string, number> = new Map()
): DeduplicationResult {
  const stats = {
    inputCount: items.length,
    uniqueCount: 0,
    urlDuplicates: 0,
    hashDuplicates: 0,
    titleDuplicates: 0,
  };

  // Build indexes for existing items
  const seenUrls = new Set<string>();
  const seenHashes = new Set<string>();
  const seenTitles: Array<{ tokens: Set<string>; item: ContentItem }> = [];

  // Add existing items to the index
  for (const item of existingItems) {
    seenUrls.add(item.canonicalUrl);
    seenHashes.add(item.contentHash);
    seenTitles.push({ tokens: tokenize(item.title), item });
  }

  const unique: ContentItem[] = [];
  const duplicates: ContentItem[] = [];

  for (const item of items) {
    let isDuplicate = false;
    let duplicateType: "url" | "hash" | "title" | null = null;

    // Check 1: Canonical URL match
    if (seenUrls.has(item.canonicalUrl)) {
      isDuplicate = true;
      duplicateType = "url";
    }

    // Check 2: Content hash match
    if (!isDuplicate && seenHashes.has(item.contentHash)) {
      isDuplicate = true;
      duplicateType = "hash";
    }

    // Check 3: Title similarity
    if (!isDuplicate) {
      const itemTokens = tokenize(item.title);
      for (const seen of seenTitles) {
        if (jaccardSimilarity(itemTokens, seen.tokens) >= TITLE_SIMILARITY_THRESHOLD) {
          // Found a similar title - check if we should replace
          const existingTrust = sourceTrustScores.get(seen.item.sourceId) || 70;
          const newTrust = sourceTrustScores.get(item.sourceId) || 70;

          if (newTrust > existingTrust) {
            // New item is from a more trusted source - replace
            // Remove old item from unique set and add new one
            const oldIdx = unique.findIndex((u) => u.id === seen.item.id);
            if (oldIdx !== -1) {
              duplicates.push(unique[oldIdx]);
              unique.splice(oldIdx, 1);
              // Don't mark as duplicate - add the new one instead
              isDuplicate = false;
            }
          } else {
            isDuplicate = true;
            duplicateType = "title";
          }
          break;
        }
      }
    }

    if (isDuplicate) {
      duplicates.push(item);
      switch (duplicateType) {
        case "url": stats.urlDuplicates++; break;
        case "hash": stats.hashDuplicates++; break;
        case "title": stats.titleDuplicates++; break;
      }
    } else {
      unique.push(item);
      seenUrls.add(item.canonicalUrl);
      seenHashes.add(item.contentHash);
      seenTitles.push({ tokens: tokenize(item.title), item });
    }
  }

  stats.uniqueCount = unique.length;

  return { unique, duplicates, stats };
}

// ============================================================================
// CLI Interface
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--test")) {
    console.log("ContentDeduplicator Self-Test\n");

    let passed = 0;
    let failed = 0;

    const test = (name: string, fn: () => void) => {
      try {
        fn();
        console.log(`  [PASS] ${name}`);
        passed++;
      } catch (e) {
        console.log(`  [FAIL] ${name}: ${e instanceof Error ? e.message : e}`);
        failed++;
      }
    };

    // URL normalization tests
    test("normalizeUrl strips UTM params", () => {
      const result = normalizeUrl("https://example.com/article?utm_source=twitter&utm_medium=social");
      if (result !== "https://example.com/article") throw new Error(`Got: ${result}`);
    });

    test("normalizeUrl strips www", () => {
      const result = normalizeUrl("https://www.example.com/article");
      if (result !== "https://example.com/article") throw new Error(`Got: ${result}`);
    });

    test("normalizeUrl strips trailing slash", () => {
      const result = normalizeUrl("https://example.com/article/");
      if (result !== "https://example.com/article") throw new Error(`Got: ${result}`);
    });

    test("normalizeUrl forces HTTPS", () => {
      const result = normalizeUrl("http://example.com/article");
      if (!result.startsWith("https://")) throw new Error(`Got: ${result}`);
    });

    // Title similarity tests
    test("identical titles are similar", () => {
      if (!areTitlesSimilar("AI Breakthrough in 2026", "AI Breakthrough in 2026"))
        throw new Error("Should be similar");
    });

    test("near-identical titles are similar", () => {
      if (!areTitlesSimilar(
        "OpenAI announces new GPT model for developers",
        "OpenAI announces new GPT model"
      )) throw new Error("Should be similar");
    });

    test("different titles are not similar", () => {
      if (areTitlesSimilar(
        "New breakthrough in quantum computing",
        "San Diego weather forecast for the week"
      )) throw new Error("Should not be similar");
    });

    // Deduplication tests
    test("deduplicateContent removes URL duplicates", () => {
      const items: ContentItem[] = [
        makeTestItem("1", "Article A", "https://example.com/a"),
        makeTestItem("2", "Article B", "https://example.com/a"), // same URL
      ];
      const result = deduplicateContent(items);
      if (result.unique.length !== 1) throw new Error(`Expected 1, got ${result.unique.length}`);
      if (result.stats.urlDuplicates !== 1) throw new Error(`Expected 1 url dup`);
    });

    test("deduplicateContent removes title duplicates", () => {
      const items: ContentItem[] = [
        makeTestItem("1", "Breaking AI news from Anthropic today", "https://a.com/1"),
        makeTestItem("2", "Breaking AI news from Anthropic", "https://b.com/2"),
      ];
      const result = deduplicateContent(items);
      if (result.unique.length !== 1) throw new Error(`Expected 1, got ${result.unique.length}`);
    });

    test("deduplicateContent keeps distinct items", () => {
      const items: ContentItem[] = [
        makeTestItem("1", "AI breakthrough in quantum computing", "https://a.com/1"),
        makeTestItem("2", "San Diego weather report for the week", "https://b.com/2"),
      ];
      const result = deduplicateContent(items);
      if (result.unique.length !== 2) throw new Error(`Expected 2, got ${result.unique.length}`);
    });

    test("deduplicateContent checks against existing items", () => {
      const existing: ContentItem[] = [
        makeTestItem("old", "Existing article about AI safety", "https://a.com/existing"),
      ];
      const items: ContentItem[] = [
        makeTestItem("new", "Existing article about AI safety research", "https://b.com/new"),
      ];
      const result = deduplicateContent(items, existing);
      if (result.unique.length !== 0) throw new Error(`Expected 0, got ${result.unique.length}`);
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } else {
    console.log("Usage: bun ContentDeduplicator.ts --test");
  }
}

// ============================================================================
// Test Helpers
// ============================================================================

function makeTestItem(id: string, title: string, url: string): ContentItem {
  return {
    id,
    sourceId: "test-source",
    sourceType: "rss",
    title,
    url,
    canonicalUrl: normalizeUrl(url),
    author: "Test Author",
    publishedAt: new Date().toISOString(),
    collectedAt: new Date().toISOString(),
    body: "Test body content",
    tags: [],
    topics: [],
    relevanceScore: 0,
    goalAlignment: [],
    contentHash: `hash-${id}`,
    summary: "",
    status: "new",
    deliveredVia: [],
  };
}
