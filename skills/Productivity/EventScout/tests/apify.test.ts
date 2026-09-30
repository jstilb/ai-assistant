#!/usr/bin/env bun
/**
 * apify.test.ts — Unit tests for ApifyAdapter.ts (no network).
 *
 * Tests only the PURE `buildCrawlerInput` function. No Apify API calls,
 * no secrets.json reads, no LLM inference. Verified by reading ApifyAdapter.ts:
 * loadApifyToken() (the only function that reads secrets.json) is never
 * called from buildCrawlerInput or from anywhere in this file — so nothing
 * here needs a KAYA_LIVE_EVENTSCOUT_TESTS live-service gate.
 *
 * Invariants verified:
 *   1. startUrls = [{ url }]                   (correct actor entry point)
 *   2. maxCrawlPages = 1                       (single listing page only)
 *   3. crawlerType = "playwright:firefox"      (JS rendering + Cloudflare bypass)
 *   4. saveMarkdown = true                     (items have .markdown field)
 *   5. proxyConfiguration.useApifyProxy = true (Apify residential proxy pool)
 *   6. No extra top-level keys leaked           (defensive — shape stays stable)
 *   7. Different URLs produce different startUrls (url is correctly threaded)
 *
 * bun:test module.
 * Run:
 *   bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/apify.test.ts
 */

import { test } from "bun:test";
import { buildCrawlerInput, APIFY_DEFAULT_CRAWL_PAGES } from "../Tools/adapters/ApifyAdapter.ts";
import type { EventSource } from "../Tools/types.ts";

// ============================================================================
// Assertion helpers — throw on failure so bun:test reports real pass/fail
// ============================================================================

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}\n         expected: ${JSON.stringify(expected)}\n         actual:   ${JSON.stringify(actual)}`
  );
}

// ============================================================================
// Fixtures
// ============================================================================

const TEST_URL = "https://www.sandiego.org/events.aspx";
const input = buildCrawlerInput(TEST_URL);

// ============================================================================
// Tests
// ============================================================================

test("startUrls shape", () => {
  const startUrls = input["startUrls"];
  assert(Array.isArray(startUrls), "startUrls is an array");
  assert(
    Array.isArray(startUrls) && startUrls.length === 1,
    "startUrls has exactly one entry"
  );
  if (Array.isArray(startUrls) && startUrls.length === 1) {
    const entry = startUrls[0] as Record<string, unknown>;
    assertEqual(entry["url"], TEST_URL, "startUrls[0].url matches input url");
    const keys = Object.keys(entry);
    assertEqual(keys, ["url"], "startUrls[0] has only 'url' key");
  }
});

test("maxCrawlPages defaults to APIFY_DEFAULT_CRAWL_PAGES", () => {
  assertEqual(input["maxCrawlPages"], APIFY_DEFAULT_CRAWL_PAGES, `maxCrawlPages is APIFY_DEFAULT_CRAWL_PAGES (${APIFY_DEFAULT_CRAWL_PAGES})`);
});

test("crawlerType is playwright:firefox", () => {
  assertEqual(
    input["crawlerType"],
    "playwright:firefox",
    'crawlerType is "playwright:firefox"'
  );
});

test("saveMarkdown is true", () => {
  assertEqual(input["saveMarkdown"], true, "saveMarkdown is true");
});

test("proxyConfiguration uses Apify residential proxy pool", () => {
  const proxyConfig = input["proxyConfiguration"];
  assert(
    typeof proxyConfig === "object" && proxyConfig !== null,
    "proxyConfiguration is an object"
  );
  if (typeof proxyConfig === "object" && proxyConfig !== null) {
    const pc = proxyConfig as Record<string, unknown>;
    assertEqual(pc["useApifyProxy"], true, "proxyConfiguration.useApifyProxy is true");
  }
});

test("top-level shape stability — no unexpected keys", () => {
  const topLevelKeys = Object.keys(input).sort();
  const expectedKeys = [
    "crawlerType",
    "dynamicContentWaitSecs",
    "htmlTransformer",
    "maxCrawlPages",
    "maxScrollHeightPixels",
    "proxyConfiguration",
    "saveMarkdown",
    "startUrls",
  ].sort();
  assertEqual(topLevelKeys, expectedKeys, "top-level keys match expected set");
});

test("dynamic-rendering params required for AJAX-hydrated SPAs", () => {
  assertEqual(input["dynamicContentWaitSecs"], 25, "dynamicContentWaitSecs is 25 (wait for AJAX grid)");
  assertEqual(input["maxScrollHeightPixels"], 20000, "maxScrollHeightPixels is 20000 (trigger lazy-load)");
  assertEqual(
    input["htmlTransformer"],
    "none",
    'htmlTransformer is "none" (preserve title anchors; readableText strips them)'
  );
});

test("URL threading — different URLs produce different startUrls", () => {
  const url2 = "https://www.bandsintown.com/c/san-diego-ca";
  const input2 = buildCrawlerInput(url2);
  const startUrls2 = input2["startUrls"];
  assert(Array.isArray(startUrls2) && startUrls2.length === 1, "second call has one startUrl");
  if (Array.isArray(startUrls2) && startUrls2.length === 1) {
    const entry2 = startUrls2[0] as Record<string, unknown>;
    assertEqual(entry2["url"], url2, "second call threads its own url");
    assert(entry2["url"] !== TEST_URL, "second url differs from first");
  }
  // Other fields stay identical
  assertEqual(
    input2["crawlerType"],
    input["crawlerType"],
    "crawlerType is stable across calls"
  );
  assertEqual(
    input2["maxCrawlPages"],
    input["maxCrawlPages"],
    "maxCrawlPages is stable across calls"
  );
});

// ============================================================================
// Slice 6: Apify configurable maxCrawlPages tests
//
// These tests verify the NEW behavior:
//   - APIFY_DEFAULT_CRAWL_PAGES is exported and > 1 (default was 1)
//   - buildCrawlerInput uses APIFY_DEFAULT_CRAWL_PAGES as the default
//   - buildCrawlerInput accepts an optional maxPages override
//   - When source.paginate.pages is present, that value is used
//
// The old "maxCrawlPages === 1 by default" behavior is intentionally
// invalidated — the new default is APIFY_DEFAULT_CRAWL_PAGES (> 1).
// ============================================================================

test("Slice 6: APIFY_DEFAULT_CRAWL_PAGES is exported and > 1", () => {
  assertEqual(typeof APIFY_DEFAULT_CRAWL_PAGES, "number", "APIFY_DEFAULT_CRAWL_PAGES is a number");
  assert(APIFY_DEFAULT_CRAWL_PAGES > 1, `APIFY_DEFAULT_CRAWL_PAGES should be > 1, got ${APIFY_DEFAULT_CRAWL_PAGES}`);
});

test("Slice 6: buildCrawlerInput with no override uses APIFY_DEFAULT_CRAWL_PAGES", () => {
  const inputDefault = buildCrawlerInput(TEST_URL);
  assertEqual(
    inputDefault["maxCrawlPages"],
    APIFY_DEFAULT_CRAWL_PAGES,
    `default maxCrawlPages equals APIFY_DEFAULT_CRAWL_PAGES (${APIFY_DEFAULT_CRAWL_PAGES})`
  );
});

test("Slice 6: buildCrawlerInput with explicit maxPages override", () => {
  const inputOverride = buildCrawlerInput(TEST_URL, 10);
  assertEqual(
    inputOverride["maxCrawlPages"],
    10,
    "buildCrawlerInput(url, 10) → maxCrawlPages = 10"
  );
});

test("Slice 6: explicit maxPages=1 is a backwards-compatible override", () => {
  const input1 = buildCrawlerInput(TEST_URL, 1);
  assertEqual(input1["maxCrawlPages"], 1, "buildCrawlerInput(url, 1) → maxCrawlPages = 1");
});

test("Slice 6: source.paginate.pages threads to maxCrawlPages", () => {
  // This tests the convention: callers should pass source.paginate?.pages to buildCrawlerInput.
  // We verify the function correctly threads the value.
  const sourceWithPaginate: EventSource = {
    id: "test-apify",
    url: TEST_URL,
    name: "Test Apify Source",
    fetchTier: "apify",
    pollInterval: 60,
    enabled: true,
    paginate: { param: "page", pages: 7 },
  };
  const pages = sourceWithPaginate.paginate?.pages ?? APIFY_DEFAULT_CRAWL_PAGES;
  const inputFromSource = buildCrawlerInput(sourceWithPaginate.url, pages);
  assertEqual(
    inputFromSource["maxCrawlPages"],
    7,
    "source.paginate.pages=7 threads to maxCrawlPages=7"
  );
});
