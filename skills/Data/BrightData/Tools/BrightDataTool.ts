#!/usr/bin/env bun
/**
 * BrightDataTool.ts - Four-tier URL content scraping tool
 *
 * Usage:
 *   bun BrightDataTool.ts scrape --url=<url> [--start-tier=1] [--timeout=60] [--force-tier=4] [--skip-browser]
 *   bun BrightDataTool.ts cache --show          # show domain tier cache
 *   bun BrightDataTool.ts cache --clear=<domain> # clear cached tier for domain
 *   bun BrightDataTool.ts --help
 *
 * Tiers:
 *   1: WebFetch (fetch API — no subprocess)
 *   2: curl via execFileSync argument array (no shell injection)
 *   3: Headless Playwright render (skipped by default for cost/latency unless --skip-browser=false)
 *   4: Bright Data Web Unlocker REST API (credits-consuming, circuit breaker: 1 call/domain/hour)
 */

import { join } from "path";
// cross-skill-allowed: tier 3 renders via the Browser skill's Playwright — its node_modules owns the dependency; a lib seam waits for a second consumer (one adapter = hypothetical seam)
import type { PlaywrightBrowser } from "../../../Development/Browser/index.ts";
import { mkdirSync, existsSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import { z } from "zod";
import { createStateManager } from "../../../../lib/core/StateManager";
import { createAppendLog } from "../../../../lib/core/AppendLog";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

// ============================================================================
// TYPES
// ============================================================================

export interface ScrapeAuditEntry {
  ts: number;
  url: string;
  domain: string;
  startTier: number;
  winningTier?: number;
  success: boolean;
  durationMs: number;
  tiersAttempted: number[];
  brightDataUsed: boolean;
  tier3Skipped?: boolean;
  error?: string;
}

export interface ScrapeResult {
  success: boolean;
  content?: string;
  winningTier?: number;
  tiersAttempted: number[];
  durationMs: number;
  brightDataUsed: boolean;
  tier3Skipped: boolean;
  error?: string;
  domain: string;
}

export interface BrightDataToolOptions {
  /** Override the Kaya home directory (for testing) */
  kayaHome?: string;
  /** User agent for curl tier */
  userAgent?: string;
}

// ============================================================================
// DOMAIN CACHE SCHEMA
// ============================================================================

const DomainCacheEntrySchema = z.object({
  lastSuccessTier: z.number().min(1).max(4),
  lastSuccessAt: z.string(),
  tier4LastUsedAt: z.string().optional(),
  consecutiveFailures: z.number().default(0),
});

const DomainCacheSchema = z.object({
  domains: z.record(z.string(), DomainCacheEntrySchema),
});

type DomainCache = z.infer<typeof DomainCacheSchema>;
type DomainCacheEntry = z.infer<typeof DomainCacheEntrySchema>;

// ============================================================================
// BOT-BLOCK DETECTION
// ============================================================================

/**
 * Detect anti-bot interstitial/block pages that come back HTTP 200 with real
 * HTML — Cloudflare "Attention Required"/"Just a moment", PerimeterX, Incapsula.
 * Without this a blocked fetch is recorded as a SUCCESS: the block page poisons
 * the domain-tier cache and flows downstream as page content (observed live
 * 2026-08-20: tier 3 rendered edmtrain.com's Cloudflare block page and reported
 * success). Patterns are deliberately narrow and only applied to small
 * responses — a real article that merely mentions these phrases is far larger
 * than any interstitial.
 */
const BOT_BLOCK_MAX_LENGTH = 20_000;
const BOT_BLOCK_PATTERNS =
  /Attention Required! \| Cloudflare|Sorry, you have been blocked|Just a moment\.\.\.|cf-chl-bypass|challenge-platform|_Incapsula_Resource|Access to this page has been denied/;

export function looksLikeBotBlockPage(content: string): boolean {
  return content.length < BOT_BLOCK_MAX_LENGTH && BOT_BLOCK_PATTERNS.test(content);
}

// ============================================================================
// BRIGHT DATA TOKEN (tier 4)
// ============================================================================

/**
 * Read BRIGHTDATA_API_TOKEN from ~/.claude/secrets.json at call time.
 * Mirrors EventScout ICSAdapter's loadBrightDataToken (kept local — the
 * dependency arrow must not point from this shared tool into a skill).
 */
export function loadBrightDataToken(): string {
  const secretsPath = join(getKayaHome(), "secrets.json");
  if (!existsSync(secretsPath)) {
    throw new Error(
      `Tier 4 unlocker needs secrets.json (not found at ${secretsPath}) with BRIGHTDATA_API_TOKEN set.`
    );
  }
  let secrets: Record<string, unknown>;
  try {
    secrets = JSON.parse(readFileSync(secretsPath, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Tier 4 unlocker: failed to parse ${secretsPath}: ${(err as Error).message}`);
  }
  const token = secrets["BRIGHTDATA_API_TOKEN"];
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error(
      `Tier 4 unlocker: BRIGHTDATA_API_TOKEN is missing or empty in ${secretsPath}.`
    );
  }
  return token.trim();
}

// ============================================================================
// URL SANITIZATION
// ============================================================================

/**
 * Validate and sanitize a URL before passing to shell commands.
 *
 * Rules:
 * 1. Must parse as a valid URL
 * 2. Only http: and https: schemes allowed
 * 3. Hostname and pathname must not contain shell-dangerous metacharacters
 * 4. Returns the URL parser's normalized form (strips user input artifacts)
 */
export function sanitizeUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: cannot parse "${rawUrl}"`);
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(
      `Unsupported URL scheme: ${url.protocol}. Only http and https are allowed.`
    );
  }

  // Reject shell-dangerous characters in hostname and pathname only.
  // Query strings are excluded: they are percent-encoded by the URL parser and
  // the dangerous characters there do not survive encoding (e.g. $ → %24).
  const dangerous = /[`$;&|<>!\\"]/;
  if (dangerous.test(url.hostname)) {
    throw new Error(
      `URL hostname contains characters unsafe in shell context: ${url.hostname}`
    );
  }
  if (dangerous.test(url.pathname)) {
    throw new Error(
      `URL pathname contains characters unsafe in shell context: ${url.pathname}`
    );
  }

  // Return the URL parser's normalized form
  return url.toString();
}

// ============================================================================
// BRIGHTDATA TOOL CLASS
// ============================================================================

export class BrightDataTool {
  private readonly kayaHome: string;
  private readonly userAgent: string;
  private readonly domainCacheManager: ReturnType<typeof createStateManager<DomainCache>>;
  private readonly auditLog: ReturnType<typeof createAppendLog>;

  constructor(options: BrightDataToolOptions = {}) {
    this.kayaHome =
      options.kayaHome ?? getKayaHome();
    this.userAgent =
      options.userAgent ??
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    const stateDir = join(this.kayaHome, "skills", "Data", "BrightData", "State");
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }

    this.domainCacheManager = createStateManager<DomainCache>({
      path: join(stateDir, "domain-cache.json"),
      schema: DomainCacheSchema,
      defaults: { domains: {} },
    });

    const auditDir = join(this.kayaHome, "MEMORY", "MONITORING", "audit");
    this.auditLog = createAppendLog(join(auditDir, "brightdata-scrapes.jsonl"), {
      retentionDays: 90,
      maxSizeMB: 10,
    });
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  async scrape(
    url: string,
    opts: {
      startTier?: number;
      timeoutMs?: number;
      skipBrowser?: boolean;
      forceTier4?: boolean;
    } = {}
  ): Promise<ScrapeResult> {
    const timeoutMs = opts.timeoutMs ?? 60_000;

    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Scrape timeout: exceeded ${timeoutMs}ms for ${url}`)),
        timeoutMs
      );
    });

    try {
      return await Promise.race([this._scrape(url, opts), timeoutPromise]);
    } finally {
      // Without this, a scrape that resolves before the timeout leaves the
      // timer pending — it keeps the event loop alive and fires its rejection
      // callback against an already-settled race later.
      clearTimeout(timer!);
    }
  }

  async showCache(): Promise<DomainCache> {
    return this.domainCacheManager.load();
  }

  async clearDomainCache(domain: string): Promise<void> {
    await this.domainCacheManager.update((cache) => {
      const updated = { ...cache.domains };
      delete updated[domain];
      return { domains: updated };
    });
  }

  // --------------------------------------------------------------------------
  // Internal scrape logic
  // --------------------------------------------------------------------------

  private async _scrape(
    rawUrl: string,
    opts: {
      startTier?: number;
      skipBrowser?: boolean;
      forceTier4?: boolean;
    }
  ): Promise<ScrapeResult> {
    const start = Date.now();
    const skipBrowser = opts.skipBrowser ?? true;
    const forceTier4 = opts.forceTier4 ?? false;

    // 1. Sanitize URL
    let url: string;
    let domain: string;
    try {
      url = sanitizeUrl(rawUrl);
      domain = new URL(url).hostname;
    } catch (err) {
      return this._fail(rawUrl, "unknown", start, [], false, false, String(err));
    }

    // 2. Determine starting tier
    const cache = await this._loadCache();
    const startTier = opts.startTier ?? this._getStartTier(domain, cache, skipBrowser);
    const tiersAttempted: number[] = [];

    // 3. Execute tiers in order
    const tierErrors: string[] = [];
    for (let tier = startTier; tier <= 4; tier++) {
      tiersAttempted.push(tier);

      if (tier === 3 && skipBrowser) {
        // Tier 3 is skipped by default: a headless browser launch is orders of
        // magnitude more expensive than tiers 1/2, so callers opt in with
        // skipBrowser: false (--skip-browser=false). Continue to tier 4.
        continue;
      }

      if (tier === 4) {
        if (!forceTier4 && !this._canUseTier4(domain, cache)) {
          return this._fail(
            url,
            domain,
            start,
            tiersAttempted,
            false,
            skipBrowser,
            `Tier 4 circuit breaker: ${domain} used Bright Data within the last hour. Use --force-tier=4 to bypass.` +
              (tierErrors.length > 0 ? ` (earlier tiers: ${tierErrors.join(" | ")})` : "")
          );
        }

        // Tier 4 is REAL since 2026-08-20: the Bright Data Web Unlocker REST
        // API (the same cron-safe path ICSAdapter uses for unblock:true
        // sources) — no interactive MCP context needed. The 1/domain/hour
        // circuit breaker above still gates it; usage is recorded even on
        // failure (a failed unlocker call still consumed a request).
        let t4 = await this._tier4(url, domain, start, tiersAttempted, skipBrowser);
        await this._recordTier4Use(domain);
        if (t4.success && t4.content && looksLikeBotBlockPage(t4.content)) {
          t4 = {
            ...t4,
            success: false,
            content: undefined,
            winningTier: undefined,
            error: `Tier 4 returned an anti-bot block page (${t4.content.length} chars)`,
          };
        }
        if (t4.success) {
          await this._updateCache(domain, 4, cache);
          this._writeAudit({
            ts: Date.now(),
            url,
            domain,
            startTier,
            winningTier: 4,
            success: true,
            durationMs: t4.durationMs,
            tiersAttempted,
            brightDataUsed: true,
            tier3Skipped: skipBrowser,
          });
          return t4;
        }
        if (t4.error) tierErrors.push(t4.error);
        break; // tier 4 is the last rung — fall to the aggregated failure below
      }

      // Tiers 1-3 are all implemented (tier 3 since 2026-08-20 — before that it
      // was a stub whose `tier as 1 | 2` cast silently fell through to tier-2
      // curl). Tier 4 returned above, and tier 3 + skipBrowser continued above,
      // so the cast is sound here.
      let result = await this._executeTier(tier as 1 | 2 | 3, url, domain, start, tiersAttempted, skipBrowser);
      if (result.success && result.content && looksLikeBotBlockPage(result.content)) {
        // A block interstitial is a FAILURE for this tier — escalate instead of
        // caching/serving it as content (see looksLikeBotBlockPage).
        result = {
          ...result,
          success: false,
          content: undefined,
          winningTier: undefined,
          error: `Tier ${tier} returned an anti-bot block page (${result.content.length} chars)`,
        };
      }
      if (result.success) {
        // Record result.winningTier — the tier that ACTUALLY served the data —
        // never the loop variable. During the stub era the loop variable wrote
        // false `winningTier: 3` records that poisoned _getStartTier into the
        // skip branch + always-fails tier 4; self-reported winningTier keeps
        // the audit log and domain cache honest by construction.
        const actualTier = result.winningTier ?? tier;
        await this._updateCache(domain, actualTier, cache);
        this._writeAudit({
          ts: Date.now(),
          url,
          domain,
          startTier,
          winningTier: actualTier,
          success: true,
          durationMs: result.durationMs,
          tiersAttempted,
          brightDataUsed: false,
          tier3Skipped: skipBrowser,
        });
        return result;
      }

      // On tier failure, record why and continue to next tier
      if (result.error) tierErrors.push(result.error);
    }

    // All tiers failed — surface every per-tier reason, not just the last
    const tier4Attempted = tiersAttempted.includes(4);
    const finalResult = this._fail(
      url,
      domain,
      start,
      tiersAttempted,
      tier4Attempted,
      skipBrowser,
      tierErrors.length > 0 ? `All tiers failed: ${tierErrors.join(" | ")}` : "All tiers failed"
    );
    this._writeAudit({
      ts: Date.now(),
      url,
      domain,
      startTier,
      success: false,
      durationMs: finalResult.durationMs,
      tiersAttempted,
      brightDataUsed: tier4Attempted,
      tier3Skipped: skipBrowser,
      error: finalResult.error,
    });
    return finalResult;
  }

  private async _executeTier(
    tier: 1 | 2 | 3,
    url: string,
    domain: string,
    start: number,
    tiersAttempted: number[],
    skipBrowser: boolean
  ): Promise<ScrapeResult> {
    if (tier === 1) {
      return this._tier1(url, domain, start, tiersAttempted, skipBrowser);
    }
    if (tier === 3) {
      return this._tier3(url, domain, start, tiersAttempted, skipBrowser);
    }
    return this._tier2(url, domain, start, tiersAttempted, skipBrowser);
  }

  /**
   * Tier 1: WebFetch using native fetch() — no subprocess.
   */
  private async _tier1(
    url: string,
    domain: string,
    start: number,
    tiersAttempted: number[],
    skipBrowser: boolean
  ): Promise<ScrapeResult> {
    // Bound the fetch with an AbortController. Without this, a stalled connection leaves the
    // fetch() promise unresolved forever: the outer Promise.race in scrape() rejects on its
    // own timeout, but the in-flight fetch keeps the Bun event loop alive — which is how an
    // EventScout prefetch hung for ~7 days (and leaked its claude -p children as zombies).
    // 30s is half the default outer scrape timeout (60s) so the fetch aborts first.
    const TIER1_FETCH_TIMEOUT_MS = 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIER1_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": this.userAgent,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
        signal: controller.signal,
      });

      if (!response.ok) {
        return {
          success: false,
          tiersAttempted,
          durationMs: Date.now() - start,
          brightDataUsed: false,
          tier3Skipped: skipBrowser,
          domain,
          error: `Tier 1 HTTP ${response.status} ${response.statusText}`,
        };
      }

      const content = await response.text();
      return {
        success: true,
        content,
        winningTier: 1,
        tiersAttempted,
        durationMs: Date.now() - start,
        brightDataUsed: false,
        tier3Skipped: skipBrowser,
        domain,
      };
    } catch (err) {
      const aborted = (err as Error)?.name === "AbortError";
      return {
        success: false,
        tiersAttempted,
        durationMs: Date.now() - start,
        brightDataUsed: false,
        tier3Skipped: skipBrowser,
        domain,
        error: aborted
          ? `Tier 1 fetch aborted after ${TIER1_FETCH_TIMEOUT_MS}ms (timeout)`
          : `Tier 1 fetch error: ${String(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Tier 2: curl via execFileSync with argument array — no shell interpolation.
   * URL is passed as a literal argument, never interpolated into a shell string.
   */
  private _tier2(
    url: string,
    domain: string,
    start: number,
    tiersAttempted: number[],
    skipBrowser: boolean
  ): ScrapeResult {
    try {
      const output = execFileSync(
        "curl",
        [
          "-sS",
          "-L",
          "-A",
          this.userAgent,
          "-H",
          "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
          "-H",
          "Accept-Language: en-US,en;q=0.9",
          "-H",
          "DNT: 1",
          "-H",
          "Connection: keep-alive",
          "-H",
          "Upgrade-Insecure-Requests: 1",
          "-H",
          "Sec-Fetch-Dest: document",
          "-H",
          "Sec-Fetch-Mode: navigate",
          "-H",
          "Sec-Fetch-Site: none",
          "-H",
          "Sec-Fetch-User: ?1",
          "-H",
          "Cache-Control: max-age=0",
          "--compressed",
          "--max-time",
          "30",
          url, // argument, not interpolated into a shell string
        ],
        { encoding: "utf-8", timeout: 35_000 }
      );

      if (!output || output.trim().length === 0) {
        return {
          success: false,
          tiersAttempted,
          durationMs: Date.now() - start,
          brightDataUsed: false,
          tier3Skipped: skipBrowser,
          domain,
          error: "Tier 2 curl returned empty content",
        };
      }

      return {
        success: true,
        content: output,
        winningTier: 2,
        tiersAttempted,
        durationMs: Date.now() - start,
        brightDataUsed: false,
        tier3Skipped: skipBrowser,
        domain,
      };
    } catch (err) {
      return {
        success: false,
        tiersAttempted,
        durationMs: Date.now() - start,
        brightDataUsed: false,
        tier3Skipped: skipBrowser,
        domain,
        error: `Tier 2 curl error: ${String(err)}`,
      };
    }
  }

  /**
   * Tier 3: real headless browser render via the Browser skill's Playwright.
   *
   * Implemented 2026-08-20 — until then tier 3 was a stub whose call silently
   * fell through to tier-2 curl, so no caller ever got a browser render.
   * Playwright is loaded lazily from the Browser skill (whose node_modules
   * owns the dependency), so tiers 1/2/4 never pay the import; a missing
   * install fails this tier loudly instead of falling through.
   *
   * Wait strategy: goto domcontentloaded → best-effort networkidle (lets AJAX
   * hydration finish) → short settle. networkidle is deliberately NOT the goto
   * condition: pages with long-polling/analytics never reach idle and would
   * fail the whole navigation despite a fully rendered DOM.
   */
  private async _tier3(
    url: string,
    domain: string,
    start: number,
    tiersAttempted: number[],
    skipBrowser: boolean
  ): Promise<ScrapeResult> {
    const TIER3_NAV_TIMEOUT_MS = 45_000;
    const TIER3_IDLE_TIMEOUT_MS = 15_000;
    const TIER3_SETTLE_MS = 500;
    // The headless shell's default UA advertises "HeadlessChrome" and the
    // automation blink feature — either alone gets a Cloudflare block page.
    // With both masked, bandsintown.com served real content (581KB) where the
    // defaults got the 3.5KB interstitial (verified live 2026-08-20).
    const TIER3_ARGS = ["--disable-blink-features=AutomationControlled"];
    const TIER3_USER_AGENT =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

    let browser: PlaywrightBrowser | null = null;
    try {
      // cross-skill-allowed: lazy tier-3-only import — see the type import note at the top of this file
      const mod = await import("../../../Development/Browser/index.ts").catch((err: unknown) => {
        throw new Error(
          `Tier 3 could not load Playwright from the Browser skill ` +
            `(run: bun install in skills/Development/Browser): ${String(err)}`
        );
      });
      browser = new mod.PlaywrightBrowser();
      await browser.launch({
        headless: true,
        defaultTimeout: TIER3_NAV_TIMEOUT_MS,
        args: TIER3_ARGS,
        userAgent: TIER3_USER_AGENT,
      });
      await browser.navigate(url, { waitUntil: "domcontentloaded", timeout: TIER3_NAV_TIMEOUT_MS });
      await browser.waitForNetworkIdle(TIER3_IDLE_TIMEOUT_MS).catch(() => {
        // Never-idle pages (long-polling, analytics beacons) still have a
        // rendered DOM — proceed with whatever hydrated.
      });
      await browser.wait(TIER3_SETTLE_MS);
      const content = await browser.getVisibleHtml({
        removeScripts: true,
        removeStyles: true,
        removeComments: true,
      });

      if (!content || content.trim().length === 0) {
        return {
          success: false,
          tiersAttempted,
          durationMs: Date.now() - start,
          brightDataUsed: false,
          tier3Skipped: skipBrowser,
          domain,
          error: "Tier 3 browser returned empty content",
        };
      }
      return {
        success: true,
        content,
        winningTier: 3,
        tiersAttempted,
        durationMs: Date.now() - start,
        brightDataUsed: false,
        tier3Skipped: skipBrowser,
        domain,
      };
    } catch (err) {
      return {
        success: false,
        tiersAttempted,
        durationMs: Date.now() - start,
        brightDataUsed: false,
        tier3Skipped: skipBrowser,
        domain,
        error: `Tier 3 browser error: ${String(err)}`,
      };
    } finally {
      if (browser) {
        await browser.close().catch(() => {
          // Close failure after a completed render shouldn't mask the result;
          // the chromium child dies with the process either way.
        });
      }
    }
  }

  /**
   * Tier 4: Bright Data Web Unlocker REST API — the cron-safe path ICSAdapter
   * proved for unblock:true sources. Implemented 2026-08-20; before this the
   * tier always failed with "requires interactive MCP context", which was an
   * implementation gap, not a platform constraint. Costs credits — the
   * 1/domain/hour circuit breaker in _scrape gates every call.
   */
  private async _tier4(
    url: string,
    domain: string,
    start: number,
    tiersAttempted: number[],
    skipBrowser: boolean
  ): Promise<ScrapeResult> {
    const TIER4_FETCH_TIMEOUT_MS = 90_000;
    let token: string;
    try {
      token = loadBrightDataToken();
    } catch (err) {
      return {
        success: false,
        tiersAttempted,
        durationMs: Date.now() - start,
        brightDataUsed: false,
        tier3Skipped: skipBrowser,
        domain,
        error: String((err as Error).message),
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIER4_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch("https://api.brightdata.com/request", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ zone: "mcp_unlocker", url, format: "raw" }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 200);
        return {
          success: false,
          tiersAttempted,
          durationMs: Date.now() - start,
          brightDataUsed: true,
          tier3Skipped: skipBrowser,
          domain,
          error: `Tier 4 unlocker HTTP ${res.status}: ${body}`,
        };
      }
      const content = await res.text();
      if (!content || content.trim().length === 0) {
        return {
          success: false,
          tiersAttempted,
          durationMs: Date.now() - start,
          brightDataUsed: true,
          tier3Skipped: skipBrowser,
          domain,
          error: "Tier 4 unlocker returned empty content",
        };
      }
      return {
        success: true,
        content,
        winningTier: 4,
        tiersAttempted,
        durationMs: Date.now() - start,
        brightDataUsed: true,
        tier3Skipped: skipBrowser,
        domain,
      };
    } catch (err) {
      const aborted = (err as Error)?.name === "AbortError";
      return {
        success: false,
        tiersAttempted,
        durationMs: Date.now() - start,
        brightDataUsed: true,
        tier3Skipped: skipBrowser,
        domain,
        error: aborted
          ? `Tier 4 unlocker aborted after ${TIER4_FETCH_TIMEOUT_MS}ms (timeout)`
          : `Tier 4 unlocker error: ${String(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Stamp tier4LastUsedAt for the circuit breaker — on every ATTEMPT, success
   * or not (a failed unlocker call still consumed a request). Success-path
   * lastSuccessTier bookkeeping stays in _updateCache.
   */
  private async _recordTier4Use(domain: string): Promise<void> {
    try {
      const now = new Date().toISOString();
      await this.domainCacheManager.update((c) => {
        const existing = c.domains[domain];
        return {
          domains: {
            ...c.domains,
            [domain]: existing
              ? { ...existing, tier4LastUsedAt: now }
              : {
                  lastSuccessTier: 1,
                  lastSuccessAt: new Date(0).toISOString(),
                  tier4LastUsedAt: now,
                  consecutiveFailures: 0,
                },
          },
        };
      });
    } catch (err) {
      console.error(`[BrightData] Failed to record tier-4 use for ${domain}:`, err);
    }
  }

  // --------------------------------------------------------------------------
  // Domain cache helpers
  // --------------------------------------------------------------------------

  private async _loadCache(): Promise<DomainCache> {
    try {
      return await this.domainCacheManager.load();
    } catch {
      return { domains: {} };
    }
  }

  /**
   * Determine which tier to start on based on cache history.
   * Falls back to Tier 1 if:
   *   - Domain has never been scraped
   *   - Last success was more than 24 hours ago
   *   - Last success was Tier 3 but this caller has the browser disabled
   *     (starting a browserless call at 3 would skip straight to the
   *     programmatically-dead Tier 4 and fail without trying 1/2)
   */
  private _getStartTier(domain: string, cache: DomainCache, skipBrowser: boolean): number {
    const entry: DomainCacheEntry | undefined = cache.domains[domain];
    if (!entry) return 1;
    const lastSuccess = new Date(entry.lastSuccessAt).getTime();
    const stale = Date.now() - lastSuccess > 24 * 60 * 60 * 1000;
    if (stale) return 1;
    if (entry.lastSuccessTier === 3 && skipBrowser) return 1;
    return entry.lastSuccessTier;
  }

  /**
   * Circuit breaker: max 1 Tier 4 call per domain per hour.
   */
  canUseTier4(domain: string, cache: DomainCache): boolean {
    return this._canUseTier4(domain, cache);
  }

  private _canUseTier4(domain: string, cache: DomainCache): boolean {
    const entry = cache.domains[domain];
    if (!entry?.tier4LastUsedAt) return true;
    const elapsed = Date.now() - new Date(entry.tier4LastUsedAt).getTime();
    const oneHour = 60 * 60 * 1000;
    if (elapsed < oneHour) {
      console.warn(
        `[BrightData] Tier 4 circuit breaker: ${domain} used Tier 4 ${Math.round(elapsed / 60_000)}m ago. Rate limit: 1/hour.`
      );
      return false;
    }
    return true;
  }

  private async _updateCache(
    domain: string,
    successTier: number,
    cache: DomainCache
  ): Promise<void> {
    try {
      const now = new Date().toISOString();
      await this.domainCacheManager.update((c) => ({
        domains: {
          ...c.domains,
          [domain]: {
            lastSuccessTier: successTier as 1 | 2 | 3 | 4,
            lastSuccessAt: now,
            tier4LastUsedAt:
              successTier === 4
                ? now
                : c.domains[domain]?.tier4LastUsedAt,
            consecutiveFailures: 0,
          },
        },
      }));
    } catch (err) {
      // Cache update failure must not break the scrape, but must not vanish silently either —
      // a swallowed failure here previously left no trace of why the domain-tier cache was
      // stale or missing entries.
      console.error(`[BrightData] Failed to update domain cache for ${domain}:`, err);
    }
  }

  // --------------------------------------------------------------------------
  // Audit log
  // --------------------------------------------------------------------------

  private _writeAudit(entry: ScrapeAuditEntry): void {
    try {
      this.auditLog.append(entry as unknown as Record<string, unknown>);
    } catch (err) {
      // Audit log failures must not break the scrape, but must not vanish silently either —
      // a swallowed failure here previously left no trace of why an audit entry was missing.
      console.error(`[BrightData] Failed to write audit log entry for ${entry.domain}:`, err);
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private _fail(
    url: string,
    domain: string,
    start: number,
    tiersAttempted: number[],
    brightDataUsed: boolean,
    tier3Skipped: boolean,
    error: string
  ): ScrapeResult {
    return {
      success: false,
      tiersAttempted,
      durationMs: Date.now() - start,
      brightDataUsed,
      tier3Skipped,
      domain,
      error,
    };
  }
}

// ============================================================================
// CLI INTERFACE
// ============================================================================

function parseFlag(args: string[], flag: string): string | undefined {
  const entry = args.find((a) => a.startsWith(`--${flag}=`));
  if (entry) return entry.slice(`--${flag}=`.length);
  const idx = args.indexOf(`--${flag}`);
  if (idx !== -1 && idx + 1 < args.length && !args[idx + 1].startsWith("--")) {
    return args[idx + 1];
  }
  return undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(`--${flag}`) || args.some((a) => a.startsWith(`--${flag}=`));
}

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
BrightDataTool.ts — Four-tier URL content scraping

USAGE:
  bun BrightDataTool.ts scrape --url=<url> [options]
  bun BrightDataTool.ts cache --show
  bun BrightDataTool.ts cache --clear=<domain>

COMMANDS:
  scrape          Scrape a URL using progressive tier escalation
  cache           Manage the domain-tier cache

SCRAPE OPTIONS:
  --url=<url>         URL to scrape (required)
  --start-tier=<n>    Start at tier 1-4 (default: auto from cache)
  --timeout=<sec>     Total timeout in seconds (default: 60)
  --skip-browser      Skip Tier 3 browser automation (default: true)
  --force-tier=4      Bypass Tier 4 circuit breaker (use carefully — costs credits)
  --output=json       Output result as JSON

CACHE OPTIONS:
  --show              Print all cached domain entries
  --clear=<domain>    Clear cached tier for a specific domain

TIERS:
  1  WebFetch (fetch API — no subprocess)
  2  curl with Chrome headers (execFileSync — no shell injection)
  3  Headless Playwright render (Browser skill's chromium; waits for AJAX
     hydration). Skipped by default for cost/latency — enable with
     --skip-browser=false
  4  Bright Data Web Unlocker REST (credits-consuming — circuit breaker:
     1/domain/hour; needs BRIGHTDATA_API_TOKEN in ~/.claude/secrets.json)

EXAMPLES:
  bun BrightDataTool.ts scrape --url=https://example.com
  bun BrightDataTool.ts scrape --url=https://example.com --start-tier=2 --timeout=30
  bun BrightDataTool.ts cache --show
  bun BrightDataTool.ts cache --clear=example.com
`);
    process.exit(0);
  }

  const command = args[0];
  const tool = new BrightDataTool();

  if (command === "cache") {
    if (hasFlag(args, "show")) {
      const cache = await tool.showCache();
      console.log(JSON.stringify(cache, null, 2));
    } else {
      const clearDomain = parseFlag(args, "clear");
      if (clearDomain) {
        await tool.clearDomainCache(clearDomain);
        console.log(`Cleared cache for domain: ${clearDomain}`);
      } else {
        console.error("cache command requires --show or --clear=<domain>");
        process.exit(1);
      }
    }
    process.exit(0);
  }

  if (command === "scrape") {
    const url = parseFlag(args, "url");
    if (!url) {
      console.error("scrape command requires --url=<url>");
      process.exit(1);
    }

    const startTierArg = parseFlag(args, "start-tier");
    const timeoutArg = parseFlag(args, "timeout");
    const skipBrowser = !hasFlag(args, "skip-browser") || parseFlag(args, "skip-browser") !== "false";
    const forceTier4 = hasFlag(args, "force-tier") && parseFlag(args, "force-tier") === "4";
    const outputJson = parseFlag(args, "output") === "json";

    const result = await tool.scrape(url, {
      startTier: startTierArg ? parseInt(startTierArg, 10) : undefined,
      timeoutMs: timeoutArg ? parseInt(timeoutArg, 10) * 1000 : undefined,
      skipBrowser,
      forceTier4,
    });

    if (outputJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.success) {
        console.log(result.content);
      } else {
        console.error(`Scrape failed (tiers attempted: ${result.tiersAttempted.join("→")}): ${result.error}`);
        process.exit(1);
      }
    }
    process.exit(0);
  }

  console.error(`Unknown command: ${command}. Use --help for usage.`);
  process.exit(1);
}
