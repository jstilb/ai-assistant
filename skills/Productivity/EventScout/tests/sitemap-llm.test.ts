#!/usr/bin/env bun
/**
 * sitemap-llm.test.ts — unit tests for SitemapLlmAdapter's pure helpers
 * (parseSitemapLocs, slugDateOf, filterFetchWorthy, extractMainText,
 * decodeEntities, attributeTicketUrls). No network; the fetch runner is
 * exercised live via `cli.ts refresh sdwritersink-writing-groups`.
 */

import { describe, expect, test } from "bun:test";
import {
  attributeTicketUrls,
  batchBlocks,
  decodeEntities,
  dropHubEntries,
  extractMainText,
  filterFetchWorthy,
  parseSitemapLocs,
  slugDateOf,
} from "../Tools/adapters/SitemapLlmAdapter.ts";
import type { EventItem } from "../Tools/types.ts";

const SITEMAP_URL = "https://writeyourstorynow.org/classes-workshops-sitemap.xml";

const LEAF_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://writeyourstorynow.org/classes-workshops/2026-09-13-how-to-self-publish-with-theresa-halvorsen/</loc>
    <lastmod>2026-08-01T12:00:00+00:00</lastmod>
  </url>
  <url>
    <loc>https://writeyourstorynow.org/writing-reading/thursday-writers/</loc>
  </url>
</urlset>`;

describe("parseSitemapLocs", () => {
  test("extracts loc + optional lastmod from url entries", () => {
    expect(parseSitemapLocs(LEAF_SITEMAP, SITEMAP_URL)).toEqual([
      {
        loc: "https://writeyourstorynow.org/classes-workshops/2026-09-13-how-to-self-publish-with-theresa-halvorsen/",
        lastmod: "2026-08-01T12:00:00+00:00",
      },
      { loc: "https://writeyourstorynow.org/writing-reading/thursday-writers/" },
    ]);
  });

  test("throws loudly on a sitemap index", () => {
    const index = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://writeyourstorynow.org/page-sitemap.xml</loc></sitemap></sitemapindex>`;
    expect(() => parseSitemapLocs(index, SITEMAP_URL)).toThrow(/sitemap INDEX/);
  });

  test("throws loudly on a sitemap with zero entries", () => {
    const empty = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`;
    expect(() => parseSitemapLocs(empty, SITEMAP_URL)).toThrow(/no <url><loc> entries/);
  });
});

describe("dropHubEntries", () => {
  test("drops the CPT archive page that prefixes its children", () => {
    const archive = { loc: "https://x.org/classes-workshops/" };
    const child1 = { loc: "https://x.org/classes-workshops/2026-09-13-self-publish/" };
    const child2 = { loc: "https://x.org/classes-workshops/2026-09-19-poem/" };
    expect(dropHubEntries([archive, child1, child2])).toEqual([child1, child2]);
  });

  test("keeps everything when no entry prefixes another", () => {
    const a = { loc: "https://x.org/writing-reading/thursday-writers/" };
    const b = { loc: "https://x.org/writing-reading/thursday-writers-jr/" };
    expect(dropHubEntries([a, b])).toEqual([a, b]);
  });

  test("prefix matching is segment-aware, not raw-string", () => {
    // /a/thing is NOT a hub of /a/thing-else — only of /a/thing/sub.
    const a = { loc: "https://x.org/a/thing" };
    const b = { loc: "https://x.org/a/thing-else/" };
    expect(dropHubEntries([a, b])).toEqual([a, b]);
  });
});

describe("slugDateOf", () => {
  test("reads the YYYY-MM-DD prefix of a dated slug", () => {
    expect(
      slugDateOf(
        "https://writeyourstorynow.org/classes-workshops/2026-09-13-how-to-self-publish/"
      )
    ).toBe("2026-09-13");
  });

  test("returns null for undated recurring-group slugs", () => {
    expect(
      slugDateOf("https://writeyourstorynow.org/writing-reading/thursday-writers/")
    ).toBeNull();
  });

  test("handles missing trailing slash", () => {
    expect(slugDateOf("https://x.org/a/2026-01-02-thing")).toBe("2026-01-02");
  });

  test("ignores date-like text that is not a leading slug prefix", () => {
    expect(slugDateOf("https://x.org/a/thing-2026-01-02/")).toBeNull();
  });
});

describe("filterFetchWorthy", () => {
  const dated = (d: string) => ({ loc: `https://x.org/c/${d}-class/` });
  const undated = { loc: "https://x.org/g/some-group/" };

  test("keeps undated slugs, future slugs, and recent starters; drops stale", () => {
    const entries = [
      undated,
      dated("2026-09-13"), // future
      dated("2026-08-20"), // 4 days back — within 7-day grace
      dated("2026-08-01"), // stale
    ];
    expect(filterFetchWorthy(entries, "2026-08-24")).toEqual([
      undated,
      dated("2026-09-13"),
      dated("2026-08-20"),
    ]);
  });

  test("grace boundary is inclusive at exactly 7 days back", () => {
    expect(filterFetchWorthy([dated("2026-08-17")], "2026-08-24")).toEqual([
      dated("2026-08-17"),
    ]);
    expect(filterFetchWorthy([dated("2026-08-16")], "2026-08-24")).toEqual([]);
  });

  test("grace window crosses month boundaries correctly", () => {
    expect(filterFetchWorthy([dated("2026-08-28")], "2026-09-03")).toEqual([
      dated("2026-08-28"),
    ]);
  });

  test("caps at 60 pages", () => {
    const many = Array.from({ length: 70 }, (_, i) => ({
      loc: `https://x.org/g/group-${i}/`,
    }));
    expect(filterFetchWorthy(many, "2026-08-24")).toHaveLength(60);
  });
});

describe("extractMainText", () => {
  test("prefers <main> and drops nav/footer outside it", () => {
    const html = `<html><body><nav>Maribor Lekarna</nav><main class="site-main"><script>var x=1;</script><h1>Thursday Writers</h1><p>TIME</p><p>5:30 PM &#8211; 6:30 PM</p></main><footer>Everyone has a story.</footer></body></html>`;
    const text = extractMainText(html);
    expect(text).toContain("Thursday Writers");
    expect(text).toContain("5:30 PM – 6:30 PM");
    expect(text).not.toContain("Lekarna");
    expect(text).not.toContain("Everyone has a story");
    expect(text).not.toContain("var x=1");
  });

  test("falls back to <body> when there is no <main>", () => {
    const html = `<html><head><style>.a{}</style></head><body><p>Poetry &amp; Prose</p></body></html>`;
    expect(extractMainText(html)).toBe("Poetry & Prose");
  });

  test("falls back to whole document when there is no <body>", () => {
    expect(extractMainText("<p>bare fragment</p>")).toBe("bare fragment");
  });
});

describe("decodeEntities", () => {
  test("decodes numeric, hex, and common named entities", () => {
    expect(decodeEntities("Judy &amp; Steve &#8212; 5 PM &ndash; 6 PM &#x2019;26")).toBe(
      "Judy & Steve — 5 PM – 6 PM ’26"
    );
  });

  test("leaves unknown named entities untouched", () => {
    expect(decodeEntities("&bogus;")).toBe("&bogus;");
  });
});

describe("batchBlocks", () => {
  const block = (url: string, chars: number) => ({
    url,
    text: "x".repeat(chars),
  });

  test("keeps small blocks in one batch with headers and separators", () => {
    const batches = batchBlocks([block("https://a/", 100), block("https://b/", 100)]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toContain(
      "PAGE (for every event found below, set ticketUrl to exactly this URL): https://a/"
    );
    expect(batches[0]).toContain("https://b/");
    expect(batches[0]).toContain("\n\n=====\n\n");
  });

  test("never splits a block across batches", () => {
    // Three ~15KB blocks: budget 36KB fits two per batch, third overflows.
    const blocks = [
      block("https://a/", 15_000),
      block("https://b/", 15_000),
      block("https://c/", 15_000),
    ];
    const batches = batchBlocks(blocks);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toContain("https://a/");
    expect(batches[0]).toContain("https://b/");
    expect(batches[0]).not.toContain("https://c/");
    expect(batches[1]).toContain("https://c/");
  });

  test("an oversized single block gets its own batch", () => {
    const batches = batchBlocks([block("https://a/", 50_000), block("https://b/", 100)]);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toContain("https://b/");
  });

  test("returns no batches for no blocks", () => {
    expect(batchBlocks([])).toEqual([]);
  });
});

describe("attributeTicketUrls", () => {
  const ev = (title: string, ticketUrl?: string): EventItem => ({
    id: `id-${title}`,
    title,
    startDatetime: "2026-09-13T09:00:00",
    allDay: false,
    category: "arts",
    tags: [],
    isFree: false,
    sourceUrl: SITEMAP_URL,
    sources: [{ sourceId: "sdwritersink-classes", url: SITEMAP_URL }],
    ...(ticketUrl !== undefined && { ticketUrl }),
  });

  const blocks = [
    { url: "https://x.org/c/self-publish/", text: "How to Self-Publish\nTIME 9 AM" },
    { url: "https://x.org/g/thursday/", text: "Thursday Writers\nEvery Thursday" },
    { url: "https://x.org/g/room-a/", text: "Room to Write with Sharon" },
    { url: "https://x.org/g/room-b/", text: "Room to Write hosted by Hailey" },
  ];

  test("assigns the unique block whose text contains the title", () => {
    const [a, b] = attributeTicketUrls(
      [ev("How to Self-Publish"), ev("Thursday Writers")],
      blocks
    );
    expect(a!.ticketUrl).toBe("https://x.org/c/self-publish/");
    expect(b!.ticketUrl).toBe("https://x.org/g/thursday/");
  });

  test("leaves ambiguous titles unset (two Room to Write blocks)", () => {
    const [a] = attributeTicketUrls([ev("Room to Write")], blocks);
    expect(a!.ticketUrl).toBeUndefined();
  });

  test("never overwrites an LLM-extracted ticketUrl", () => {
    const [a] = attributeTicketUrls(
      [ev("Thursday Writers", "https://keep.me/")],
      blocks
    );
    expect(a!.ticketUrl).toBe("https://keep.me/");
  });

  test("does not mutate its inputs", () => {
    const original = ev("Thursday Writers");
    attributeTicketUrls([original], blocks);
    expect(original.ticketUrl).toBeUndefined();
  });
});
