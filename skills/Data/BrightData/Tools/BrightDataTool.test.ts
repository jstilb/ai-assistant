#!/usr/bin/env bun
/**
 * BrightDataTool.test.ts — Unit tests for BrightDataTool's tier-labeling honesty.
 *
 * Fully hermetic: mocks `execFileSync` (child_process) and global `fetch` so no
 * real network request is ever made. Each test uses an isolated kayaHome tmp dir
 * (via BrightDataToolOptions.kayaHome) so cache/audit writes never touch live state.
 *
 * Key behaviors under test:
 * - Tier-labeling honesty (fable-audit-brightdata-2026-07-17.md, §2/§3/§7#3):
 *   the audit-log entry and domain-cache entry must always name the tier that
 *   ACTUALLY produced the data, never the loop's nominal tier. (During the
 *   2026-07..08 stub era, tier 3's fallthrough to curl made the loop variable
 *   write false `winningTier: 3` records that poisoned the domain cache.)
 * - Tier 3 is REAL since 2026-08-20: with `skipBrowser: false` it renders via
 *   the Browser skill's Playwright (mocked here — see FakePlaywrightBrowser)
 *   and legitimately records winningTier 3.
 * - A cached tier-3 win must NOT strand a browserless (skipBrowser default)
 *   caller at the skip branch + always-fails tier 4 — _getStartTier restarts
 *   such callers at tier 1.
 * - Anti-bot block pages (Cloudflare et al.) that come back as "content" are
 *   converted to per-tier FAILURES (looksLikeBotBlockPage), never cached or
 *   served as success.
 *
 * Run:
 *   bun test ~/.claude/skills/Data/BrightData/Tools/BrightDataTool.test.ts
 */

import { describe, test, expect, spyOn, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as childProcess from "child_process";
import { BrightDataTool, sanitizeUrl, looksLikeBotBlockPage } from "./BrightDataTool.ts";
import type { ScrapeAuditEntry } from "./BrightDataTool.ts";

// ----------------------------------------------------------------------------
// Hermetic tier-3: mock the Browser skill module _tier3 lazily imports, so no
// real chromium ever launches. `fakeTier3Html` is what the "render" returns.
// ----------------------------------------------------------------------------
let fakeTier3Html = "";
class FakePlaywrightBrowser {
  async launch(_opts?: unknown): Promise<void> {}
  async navigate(_url: string, _opts?: unknown): Promise<void> {}
  async waitForNetworkIdle(_timeout?: number): Promise<void> {}
  async wait(_ms: number): Promise<void> {}
  async getVisibleHtml(_opts?: unknown): Promise<string> {
    return fakeTier3Html;
  }
  async close(): Promise<void> {}
}
mock.module("../../../Development/Browser/index.ts", () => ({
  PlaywrightBrowser: FakePlaywrightBrowser,
}));

function readLastAuditEntry(kayaHome: string): ScrapeAuditEntry {
  const auditPath = join(kayaHome, "MEMORY", "MONITORING", "audit", "brightdata-scrapes.jsonl");
  expect(existsSync(auditPath)).toBe(true);
  const lines = readFileSync(auditPath, "utf-8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]) as ScrapeAuditEntry;
}

describe("BrightDataTool — tier-labeling honesty", () => {
  let kayaHome: string;
  let execSpy: ReturnType<typeof spyOn>;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    kayaHome = mkdtempSync(join(tmpdir(), "brightdata-tool-test-"));
  });

  afterEach(() => {
    execSpy?.mockRestore();
    fetchSpy?.mockRestore();
    rmSync(kayaHome, { recursive: true, force: true });
  });

  test("tier-3 (skipBrowser:false) renders via the browser and records winningTier 3 in cache + audit", async () => {
    fakeTier3Html = "<html><body><div>Concert listing — hydrated by JS</div></body></html>";

    const tool = new BrightDataTool({ kayaHome });
    const result = await tool.scrape("https://example.com", {
      startTier: 3,
      skipBrowser: false,
    });

    expect(result.success).toBe(true);
    expect(result.winningTier).toBe(3);
    expect(result.content).toContain("hydrated by JS");

    const cache = await tool.showCache();
    expect(cache.domains["example.com"]?.lastSuccessTier).toBe(3);

    const entry = readLastAuditEntry(kayaHome);
    expect(entry.success).toBe(true);
    expect(entry.winningTier).toBe(3);
  });

  test("tier-3 anti-bot block page is a FAILURE — escalates with the reason, never cached as success", async () => {
    fakeTier3Html =
      "<html><head><title>Attention Required! | Cloudflare</title></head>" +
      "<body>Sorry, you have been blocked</body></html>";

    // Tier 4 is real now — point token resolution at the empty tmp home so
    // the escalation past tier 3 fails on missing-token instead of making a
    // live unlocker call (hermeticity).
    process.env["KAYA_HOME"] = kayaHome;
    try {
      const tool = new BrightDataTool({ kayaHome });
      const result = await tool.scrape("https://blocked.example.com", {
        startTier: 3,
        skipBrowser: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("anti-bot block page");

      // The block "success" must not have been recorded as a tier-3/4 win —
      // only the tier-4 breaker stamp (with its epoch lastSuccessAt sentinel)
      // may exist for the domain.
      const cache = await tool.showCache();
      const entry = cache.domains["blocked.example.com"];
      expect(entry?.lastSuccessTier === 3 || entry?.lastSuccessTier === 4).toBe(false);
    } finally {
      delete process.env["KAYA_HOME"];
    }
  });

  test("a cached tier-3 win does NOT strand a skipBrowser-default caller — it restarts at tier 1", async () => {
    // 1. Seed the domain cache with a legitimate tier-3 success.
    fakeTier3Html = "<html><body>tier3 win</body></html>";
    const tool = new BrightDataTool({ kayaHome });
    await tool.scrape("https://spa.example.com", { startTier: 3, skipBrowser: false });
    const seeded = await tool.showCache();
    expect(seeded.domains["spa.example.com"]?.lastSuccessTier).toBe(3);

    // 2. A default (browserless) scrape of the same domain must start at tier 1,
    //    not at cached tier 3 (which would skip to the always-fails tier 4).
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("<html><body>tier1 content</body></html>", { status: 200 })
    );
    const result = await tool.scrape("https://spa.example.com", {});
    expect(result.success).toBe(true);
    expect(result.winningTier).toBe(1);
    expect(result.tiersAttempted[0]).toBe(1);
  });

  test("no-regression: tier-1 success records winningTier 1", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response("<html><body>tier1 content</body></html>", { status: 200 })
    );

    const tool = new BrightDataTool({ kayaHome });
    const result = await tool.scrape("https://tier1.example.com", { startTier: 1 });

    expect(result.success).toBe(true);
    expect(result.winningTier).toBe(1);

    const cache = await tool.showCache();
    expect(cache.domains["tier1.example.com"]?.lastSuccessTier).toBe(1);

    const entry = readLastAuditEntry(kayaHome);
    expect(entry.winningTier).toBe(1);
  });

  test("no-regression: tier-2 success (skipBrowser default) records winningTier 2", async () => {
    execSpy = spyOn(childProcess, "execFileSync").mockImplementation(
      () => "<html><body>tier2 content</body></html>"
    );

    const tool = new BrightDataTool({ kayaHome });
    const result = await tool.scrape("https://tier2.example.com", { startTier: 2 });

    expect(result.success).toBe(true);
    expect(result.winningTier).toBe(2);

    const cache = await tool.showCache();
    expect(cache.domains["tier2.example.com"]?.lastSuccessTier).toBe(2);

    const entry = readLastAuditEntry(kayaHome);
    expect(entry.winningTier).toBe(2);
  });
});

/**
 * sanitizeUrl() — narrowed shell-metachar check (T4-05).
 *
 * plans/audits/remediation/theme4-sanitizeurl-narrowing.md, settled verdict:
 * "modest sanitizeUrl narrowing (drop `(` `)` `'`, keep dangerous set) WITH
 * mandatory injection+legit-URL corpus." The character class went from
 * /[`$();&|<>!\\'"]/ to /[`$;&|<>!\\"]/ — dropping exactly `(`, `)`, and `'`
 * (RFC-3986-legal path characters that Wikipedia-style disambiguation URLs
 * and apostrophe slugs use unencoded) while keeping every character the plan
 * judged load-bearing for shell-injection defense-in-depth.
 *
 * sanitizeUrl() is a pure function (no I/O), so these tests call it directly
 * rather than going through BrightDataTool/kayaHome.
 */
describe("sanitizeUrl — injection corpus (must still throw, or documents why a layer above the regex already neutralizes it)", () => {
  test("$() command substitution still throws via the bare $ — the load-bearing pair-coverage argument: dropping ( and ) alone does not open $(...) because $ alone is still blocked", () => {
    expect(() => sanitizeUrl("https://example.com/$(whoami)")).toThrow(
      /unsafe in shell context/
    );
  });

  test("; command chaining in the pathname still throws", () => {
    expect(() => sanitizeUrl("https://example.com/foo;rm-rf")).toThrow(
      /unsafe in shell context/
    );
  });

  test("| piping in the pathname still throws", () => {
    expect(() =>
      sanitizeUrl("https://example.com/foo|nc-attacker.com-4444")
    ).toThrow(/unsafe in shell context/);
  });

  test("&& chaining in the pathname still throws via &, distinct from the query-string & exclusion (which only applies to url.search, never url.pathname)", () => {
    expect(() =>
      sanitizeUrl("https://example.com/foo&&curl-evil.com/bar")
    ).toThrow(/unsafe in shell context/);
  });

  test("all throwing entries above use the same error message shape (\"unsafe in shell context\") so existing caller error-handling is unaffected by the narrowing", () => {
    expect(() => sanitizeUrl("https://example.com/foo;bar")).toThrow(
      "URL pathname contains characters unsafe in shell context: /foo;bar"
    );
  });

  test("backtick command substitution does NOT throw — the URL constructor itself percent-encodes backtick to %60 in the pathname before sanitizeUrl's regex ever runs, so the literal backtick the regex is written to catch never survives URL parsing. True both before and after this narrowing (backtick was never dropped from the character class) — not a regression, a pre-existing layered defense the regex text alone doesn't reveal.", () => {
    expect(sanitizeUrl("https://example.com/`whoami`")).toBe(
      "https://example.com/%60whoami%60"
    );
  });

  test("< and > redirects do NOT throw — the URL constructor percent-encodes both to %3C/%3E in the pathname before sanitizeUrl's regex runs (same layered defusal as backtick, per the WHATWG URL path percent-encode set). True both before and after this narrowing.", () => {
    expect(sanitizeUrl("https://example.com/foo<script>bar")).toBe(
      "https://example.com/foo%3Cscript%3Ebar"
    );
  });

  test("backslash in the pathname does NOT throw — WHATWG URL parsing treats \\ as a path separator for special schemes (http/https) and rewrites it to /, so a literal backslash never reaches sanitizeUrl's regex at all. True both before and after this narrowing.", () => {
    expect(sanitizeUrl("https://example.com/foo\\bar")).toBe(
      "https://example.com/foo/bar"
    );
  });

  test("embedded raw newline in the pathname does NOT throw — the URL constructor strips ASCII tab/newline entirely during parsing (WHATWG URL Standard's tab-and-newline removal step) before sanitizeUrl's regex ever sees the string. Per the settled scope, no explicit \\n check was added to the regex to compensate — the URL layer already removes it, and adding a redundant check would be scope creep beyond the approved narrowing.", () => {
    expect(sanitizeUrl("https://example.com/foo\nbar")).toBe(
      "https://example.com/foobar"
    );
  });

  test("embedded raw null byte in the pathname does NOT throw — the URL constructor percent-encodes it to the literal text \"%00\" before sanitizeUrl's regex runs; the regex has never checked for \\0 (neither before nor after this narrowing), so this is inert by construction of the URL layer, not by the shell-metachar check.", () => {
    expect(sanitizeUrl("https://example.com/foo\0bar")).toBe(
      "https://example.com/foo%00bar"
    );
  });

  test("fullwidth homoglyphs (＄ ｀) are NOT blocked — deliberate, per plan §5: the URL constructor percent-encodes them as non-ASCII UTF-8 bytes before the regex runs, and even if they reached the regex verbatim they are not real shell metacharacters to execve()/fetch(), only to a human eye or a naive shell wrapper. Documented explicitly so a future reader knows this was a deliberate decision, not an oversight.", () => {
    expect(sanitizeUrl("https://example.com/foo＄｀bar")).toBe(
      "https://example.com/foo%EF%BC%84%EF%BD%80bar"
    );
  });

  test("scheme allowlist is unchanged by this narrowing — ftp: still throws the scheme error (guards against an accidental over-edit reaching the unrelated SSRF/protocol boundary at :102-106)", () => {
    expect(() => sanitizeUrl("ftp://example.com/foo")).toThrow(
      /Unsupported URL scheme: ftp:/
    );
  });

  test("scheme allowlist is unchanged by this narrowing — javascript: still throws the scheme error", () => {
    expect(() => sanitizeUrl("javascript:alert(1)")).toThrow(
      /Unsupported URL scheme: javascript:/
    );
  });
});

describe("sanitizeUrl — legitimate-URL corpus (must NOT throw after narrowing)", () => {
  test("Wikipedia-style disambiguation parens in the pathname now pass (previously rejected — the false-rejection class this narrowing exists to fix)", () => {
    expect(
      sanitizeUrl("https://en.wikipedia.org/wiki/Godzilla_(1998_film)")
    ).toBe("https://en.wikipedia.org/wiki/Godzilla_(1998_film)");
  });

  test("apostrophe in a pathname slug now passes (previously rejected)", () => {
    expect(sanitizeUrl("https://example.com/o'brien-media")).toBe(
      "https://example.com/o'brien-media"
    );
  });

  test("band-disambiguation parens now pass", () => {
    expect(sanitizeUrl("https://example.com/wiki/Say_Anything_(band)")).toBe(
      "https://example.com/wiki/Say_Anything_(band)"
    );
  });

  test("already-percent-encoded parens continue to pass — unaffected by the narrowing, they passed before too", () => {
    expect(
      sanitizeUrl("https://example.com/wiki/Say_Anything_%28band%29")
    ).toBe("https://example.com/wiki/Say_Anything_%28band%29");
  });

  test("query string with & continues to pass — unaffected by the narrowing; query strings were already excluded from the check (url.search is never tested against the regex)", () => {
    expect(sanitizeUrl("https://example.com/path?a=1&b=2")).toBe(
      "https://example.com/path?a=1&b=2"
    );
  });

  // Regression guard: real URLs pulled from the live BrightData audit log
  // (~/.kaya/runtime/MONITORING/audit/brightdata-scrapes.jsonl — 765 entries
  // as of this writing, 2026-08-02; grown from the 329 the plan cited on
  // 2026-07-17, as EventScout's source list has evolved). Picked for domain
  // spread (8 distinct domains) and to exercise percent-encoded non-ASCII,
  // query strings, and double-hyphen path segments — none of which the
  // narrowing should ever touch, since none contain `(` `)` or `'`.
  const realAuditLogUrls: [url: string, note: string][] = [
    ["https://en.wikipedia.org/wiki/The_Coca-Cola_Company", "hyphenated title"],
    ["https://en.wikipedia.org/wiki/Nestl%C3%A9", "percent-encoded accent"],
    ["https://sdcl.bibliocommons.com/v2/events?page=5", "query string numeric param"],
    ["https://www.eventbrite.com/d/ca--san-diego/all-events/?page=3", "double-hyphen path + query"],
    [
      "https://aquarium.ucsd.edu/events/all?field_event_category_target_id%5B%5D=182&title=",
      "percent-encoded brackets + & in query",
    ],
    ["https://www.songkick.com/metro-areas/11086-us-san-diego", "hyphenated path"],
    ["https://voiceofsandiego.org/events/", "trailing-slash path, no query"],
    ["https://www.theshell.org/performances/rady-shell-calendar", "hyphenated path"],
  ];

  for (const [url, note] of realAuditLogUrls) {
    test(`real audit-log URL still passes (${note}): ${url}`, () => {
      expect(sanitizeUrl(url)).toBe(url);
    });
  }
});

describe("BrightDataTool — tier 4 (Web Unlocker REST)", () => {
  let kayaHome: string;
  let fetchSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    kayaHome = mkdtempSync(join(tmpdir(), "brightdata-tier4-test-"));
    // loadBrightDataToken resolves secrets via getKayaHome() (env-keyed cache,
    // re-resolves per call) — point it at the tmp home.
    process.env["KAYA_HOME"] = kayaHome;
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
    delete process.env["KAYA_HOME"];
    rmSync(kayaHome, { recursive: true, force: true });
  });

  test("missing token fails tier 4 loudly (no fetch made) and aggregates into the final error", async () => {
    const tool = new BrightDataTool({ kayaHome });
    const result = await tool.scrape("https://walled.example.com", { startTier: 4, forceTier4: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain("BRIGHTDATA_API_TOKEN");
  });

  test("unlocker success records winningTier 4, brightDataUsed, and the tier-4 breaker stamp", async () => {
    writeFileSync(join(kayaHome, "secrets.json"), JSON.stringify({ BRIGHTDATA_API_TOKEN: "t" }));
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("<html><body>unlocked real content</body></html>", { status: 200 })
    );

    const tool = new BrightDataTool({ kayaHome });
    const result = await tool.scrape("https://walled.example.com", { startTier: 4 });
    expect(result.success).toBe(true);
    expect(result.winningTier).toBe(4);
    expect(result.brightDataUsed).toBe(true);
    expect(result.content).toContain("unlocked real content");

    const cache = await tool.showCache();
    expect(cache.domains["walled.example.com"]?.lastSuccessTier).toBe(4);
    expect(cache.domains["walled.example.com"]?.tier4LastUsedAt).toBeDefined();

    // Circuit breaker: a second tier-4 attempt within the hour is refused.
    const second = await tool.scrape("https://walled.example.com", { startTier: 4 });
    expect(second.success).toBe(false);
    expect(second.error).toContain("circuit breaker");
  });

  test("unlocker-served block page is a failure, never a cached success", async () => {
    writeFileSync(join(kayaHome, "secrets.json"), JSON.stringify({ BRIGHTDATA_API_TOKEN: "t" }));
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("<title>Attention Required! | Cloudflare</title>", { status: 200 })
    );

    const tool = new BrightDataTool({ kayaHome });
    const result = await tool.scrape("https://stillblocked.example.com", { startTier: 4 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("anti-bot block page");
    const cache = await tool.showCache();
    expect(cache.domains["stillblocked.example.com"]?.lastSuccessTier).not.toBe(4);
  });
});

describe("looksLikeBotBlockPage", () => {
  test("Cloudflare 'Attention Required' interstitial matches", () => {
    expect(
      looksLikeBotBlockPage("<title>Attention Required! | Cloudflare</title><p>blocked</p>")
    ).toBe(true);
  });

  test("Cloudflare 'Sorry, you have been blocked' matches", () => {
    expect(looksLikeBotBlockPage("<h1>Sorry, you have been blocked</h1>")).toBe(true);
  });

  test("ordinary small page does not match", () => {
    expect(
      looksLikeBotBlockPage("<html><body><h1>Events this weekend</h1><ul><li>Show</li></ul></body></html>")
    ).toBe(false);
  });

  test("large page mentioning the phrases does not match (size gate)", () => {
    const article =
      "<article>How CDNs work: sometimes you see Sorry, you have been blocked pages…</article>" +
      "x".repeat(25_000);
    expect(looksLikeBotBlockPage(article)).toBe(false);
  });
});
