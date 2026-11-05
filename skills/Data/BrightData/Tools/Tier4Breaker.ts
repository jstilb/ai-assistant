#!/usr/bin/env bun
/**
 * Tier4Breaker.ts - Shared spend circuit breaker for Bright Data Tier 4
 * (Web Unlocker REST, credits-consuming). Audit item T2-11 (money boundary).
 *
 * Two independent limits, one state file shared by every spending path:
 *   1. Per-domain cooldown (default 1 hour) - same rule BrightDataTool has always had.
 *   2. Global daily call ceiling - catches fan-out across many domains.
 *
 * DEFAULT BEHAVIOR IS UNCHANGED: the daily ceiling is OFF unless a caller
 * passes `dailyCeiling` or sets BRIGHTDATA_TIER4_DAILY_CEILING. The approved
 * interim value (decisions log T2-11) is 20 per day: set BRIGHTDATA_TIER4_DAILY_CEILING=20 to apply it.
 * It is a placeholder, not a verified dollar figure: Jm must confirm the real
 * cap from the Bright Data dashboard, then switch the default on.
 *
 * A trip is never silent: check() returns a reason, and the alert hook pages
 * (key 'brightdata-tier4-breaker-tripped', tier 'page'). Trips self-heal: the
 * domain rule clears after the cooldown, the daily count at date rollover.
 *
 * State: <KAYA_HOME>/MEMORY/State/brightdata-tier4-breaker.json
 *
 * CLI (advisory pre-check for the interactive MCP path, which code cannot gate):
 *   bun Tier4Breaker.ts check --domain=<host>    exit 0 allowed, exit 2 tripped
 *   bun Tier4Breaker.ts status
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { createStateManager } from "../../../../lib/core/StateManager.ts";

const DEFAULT_DOMAIN_COOLDOWN_MS = 60 * 60 * 1000;
export const BREAKER_ALERT_KEY = "brightdata-tier4-breaker-tripped";

const BreakerStateSchema = z.object({
  domains: z.record(z.string(), z.object({ tier4LastUsedAt: z.string() })),
  daily: z.object({ date: z.string(), callCount: z.number() }),
});
type BreakerState = z.infer<typeof BreakerStateSchema>;

type BreakerDecision = { allowed: true } | { allowed: false; kind: "domain" | "daily"; reason: string };

type BreakerAlertFn = (message: string, options: { key: string; tier: "page" }) => Promise<unknown>;

interface Tier4BreakerOptions {
  /** Kaya home (tests pass a temp dir). Default: getKayaHome(). */
  kayaHome?: string;
  /** Max real calls per local day across all paths. Default: env, else disabled (Infinity). */
  dailyCeiling?: number;
  /** Per-domain cooldown. Default 1 hour. */
  domainCooldownMs?: number;
  /** Clock (tests). */
  now?: () => Date;
  /** Page hook. Default: AlertGate sendAlert, tier 'page'. */
  alert?: BreakerAlertFn;
}

/** Read BRIGHTDATA_TIER4_DAILY_CEILING; unset or invalid means no daily ceiling. */
export function resolveDailyCeiling(env: Record<string, string | undefined> = process.env): number {
  const raw = env["BRIGHTDATA_TIER4_DAILY_CEILING"];
  if (raw === undefined || raw.trim() === "") return Number.POSITIVE_INFINITY;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    process.stderr.write(
      `[Tier4Breaker] Ignoring invalid BRIGHTDATA_TIER4_DAILY_CEILING=${JSON.stringify(raw)}; daily ceiling stays off.\n`,
    );
    return Number.POSITIVE_INFINITY;
  }
  return n;
}

function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function defaultAlert(message: string, options: { key: string; tier: "page" }): Promise<unknown> {
  const { sendAlert } = await import("../../../../lib/core/AlertGate.ts");
  return sendAlert(message, options);
}

export class Tier4Breaker {
  private readonly state: ReturnType<typeof createStateManager<BreakerState>>;
  private readonly dailyCeiling: number;
  private readonly domainCooldownMs: number;
  private readonly now: () => Date;
  private readonly alert: BreakerAlertFn;

  constructor(options: Tier4BreakerOptions = {}) {
    const home = options.kayaHome ?? getKayaHome();
    this.dailyCeiling = options.dailyCeiling ?? resolveDailyCeiling();
    this.domainCooldownMs = options.domainCooldownMs ?? DEFAULT_DOMAIN_COOLDOWN_MS;
    this.now = options.now ?? (() => new Date());
    this.alert = options.alert ?? defaultAlert;
    const stateDir = join(home, "MEMORY", "State");
    mkdirSync(stateDir, { recursive: true }); // StateManager's lock file needs the directory to exist
    this.state = createStateManager<BreakerState>({
      path: join(stateDir, "brightdata-tier4-breaker.json"),
      schema: BreakerStateSchema,
      defaults: { domains: {}, daily: { date: "", callCount: 0 } },
    });
  }

  /**
   * Decide whether one more Tier-4 call may be made for `domain`.
   * `ignoreDomainRule` lets a caller that enforces its own per-domain rule
   * (BrightDataTool, with its --force-tier=4 override) use only the daily ceiling.
   * On a trip this pages (failure to page is logged to stderr, never hides the refusal).
   */
  async check(domain: string, opts: { ignoreDomainRule?: boolean } = {}): Promise<BreakerDecision> {
    const s = await this.state.load();
    const now = this.now();

    if (!opts.ignoreDomainRule) {
      const last = s.domains[domain]?.tier4LastUsedAt;
      if (last) {
        const elapsed = now.getTime() - new Date(last).getTime();
        if (elapsed < this.domainCooldownMs) {
          return this.trip({
            allowed: false,
            kind: "domain",
            reason: `Tier 4 breaker: ${domain} used Bright Data ${Math.round(elapsed / 60_000)}m ago (cooldown ${Math.round(this.domainCooldownMs / 60_000)}m).`,
          });
        }
      }
    }

    const today = localDate(now);
    const count = s.daily.date === today ? s.daily.callCount : 0;
    if (count >= this.dailyCeiling) {
      return this.trip({
        allowed: false,
        kind: "daily",
        reason: `Tier 4 breaker: daily ceiling reached (${count}/${this.dailyCeiling} Bright Data calls on ${today}). Resets at date rollover.`,
      });
    }
    return { allowed: true };
  }

  /** Record one real Tier-4 attempt (success or failure: a failed call still costs a request). */
  async recordUse(domain: string): Promise<void> {
    const now = this.now();
    const today = localDate(now);
    await this.state.update((s) => ({
      domains: { ...s.domains, [domain]: { tier4LastUsedAt: now.toISOString() } },
      daily: { date: today, callCount: (s.daily.date === today ? s.daily.callCount : 0) + 1 },
    }));
  }

  async status(): Promise<BreakerState & { dailyCeiling: number | null }> {
    const s = await this.state.load();
    return { ...s, dailyCeiling: Number.isFinite(this.dailyCeiling) ? this.dailyCeiling : null };
  }

  private async trip(decision: Extract<BreakerDecision, { allowed: false }>): Promise<BreakerDecision> {
    try {
      await this.alert(`[BrightData] ${decision.reason}`, { key: BREAKER_ALERT_KEY, tier: "page" });
    } catch (err) {
      process.stderr.write(
        `[Tier4Breaker] Could not page for trip (${decision.kind}): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    return decision;
  }
}

// CLI ------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const breaker = new Tier4Breaker();
  if (cmd === "status") {
    console.log(JSON.stringify(await breaker.status(), null, 2));
    return 0;
  }
  if (cmd === "check") {
    const domainArg = rest.find((a) => a.startsWith("--domain="));
    const domain = domainArg?.slice("--domain=".length);
    if (!domain) {
      console.error("Usage: Tier4Breaker.ts check --domain=<host>");
      return 1;
    }
    const decision = await breaker.check(domain);
    if (decision.allowed) {
      console.log(JSON.stringify({ allowed: true }));
      return 0;
    }
    console.log(JSON.stringify(decision));
    return 2;
  }
  console.error("Usage: Tier4Breaker.ts <check --domain=<host> | status>");
  return 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
