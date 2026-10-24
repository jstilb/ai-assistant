#!/usr/bin/env bun
/**
 * RentalTracker.ts — Ocean Beach rental tracker: scan → enrich → extract →
 * score → expire → alert, plus the CLI.
 *
 * One `scan` (what the cron runs every 2h):
 *   1. search each source (Craigslist, Redfin); keep hits inside Ocean Beach
 *   2. reconcile into state: new / seen / missed (expiry only on SUCCESSFUL scans)
 *   3. fetch detail for listings not yet read (body text, amenities, floor plans)
 *   4. LLM-extract features for new/changed listings (cached by content hash)
 *   5. re-score every active listing against the current config
 *   6. alert (AlertGate page → Telegram) ONLY for exceptional listings never
 *      alerted before; everything else just lands on the board
 *
 * CLI:
 *   bun RentalTracker.ts scan [--no-llm] [--no-alert] [--dry-run-alert] [--json]
 *   bun RentalTracker.ts board [--all] [--limit N] [--json]   top of the ranked board
 *   bun RentalTracker.ts show <id>                            one listing, full detail
 *   bun RentalTracker.ts decide <id> <new|shortlist|contacted|toured|rejected> [note…]
 *   bun RentalTracker.ts status                               last runs + counts
 *   bun RentalTracker.ts serve [--port 31340]                 standalone board (the
 *                                                             LifeOS dashboard also mounts /rentals)
 *
 * @module RentalTracker
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { sendAlert, type AlertResult } from "../../../../lib/core/AlertGate.ts";
import { logFailure } from "../../../../lib/core/FailureLog.ts";
import { inference } from "../../../../lib/core/Inference.ts";
import { inArea, walkMinutes } from "./Geo.ts";
import { extractFeatures, keywordFeatures, mergeStructured, type InferenceFn } from "./Extract.ts";
import { isExceptional, scoreListing } from "./Score.ts";
import {
  defaultFetcher, enrichCraigslist, enrichRedfin, searchCraigslist, searchRedfin, sleep, type Fetcher,
} from "./Sources.ts";
import { expire, groupDuplicates, loadState, mergeDecisionsFromDisk, prune, reconcile, saveState, setDecision, statePath, type ReconcileResult } from "./Store.ts";
import type { Decision, RawListing, RunSummary, SourceName, StoredListing, TrackerConfig, TrackerState } from "./types.ts";

export const CONFIG_PATH = join(import.meta.dir, "..", "config", "ocean-beach.json");

export function loadConfig(path = CONFIG_PATH): TrackerConfig {
  return JSON.parse(readFileSync(path, "utf-8")) as TrackerConfig;
}

export interface ScanOptions {
  useLlm?: boolean;
  /** "send" (default) | "skip" (compute only) */
  alerts?: "send" | "skip";
  fetcher?: Fetcher;
  infer?: InferenceFn;
  send?: typeof sendAlert;
  now?: Date;
  statePath?: string;
  sources?: SourceName[];
  log?: (msg: string) => void;
}

export interface ScanReport extends RunSummary {
  exceptional: { id: string; score: number; line: string }[];
  activeCount: number;
}

function hashContent(l: StoredListing): string {
  return createHash("sha1").update(`${l.title}\n${l.text ?? ""}`).digest("hex").slice(0, 16);
}

export async function scan(cfg: TrackerConfig, opts: ScanOptions = {}): Promise<ScanReport> {
  const t0 = Date.now();
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const fetcher = opts.fetcher ?? defaultFetcher;
  const path = opts.statePath ?? statePath();
  const state = loadState(path);
  const summary: ScanReport = {
    at: now.toISOString(), ok: true, sources: {}, newListings: 0, expired: 0, extracted: 0,
    extractionFallbacks: 0, alerted: [], durationMs: 0, exceptional: [], activeCount: 0,
  };
  const searchers: Record<SourceName, () => Promise<RawListing[]>> = {
    craigslist: () => searchCraigslist(cfg, fetcher),
    redfin: () => searchRedfin(cfg, fetcher),
  };

  // 1–2. search + reconcile
  for (const source of ["craigslist", "redfin"] as SourceName[]) {
    if (!cfg.sources[source].enabled || (opts.sources && !opts.sources.includes(source))) continue;
    let rec: ReconcileResult;
    try {
      const hits = await searchers[source]();
      const local = hits.filter((h) => inArea(h.lat, h.lon, cfg.geo));
      rec = reconcile(state, source, local, true, cfg, now);
      summary.sources[source] = { ok: true, hits: hits.length, inArea: local.length };
      log(`${source}: ${hits.length} hits, ${local.length} in Ocean Beach, ${rec.newIds.length} new, ${rec.expiredIds.length} expired`);
    } catch (err) {
      const msg = (err as Error).message;
      rec = reconcile(state, source, [], false, cfg, now);
      summary.sources[source] = { ok: false, hits: 0, inArea: 0, error: msg };
      summary.ok = false;
      logFailure("RentalTracker", err, { phase: "search", source });
      log(`${source}: SEARCH FAILED — ${msg} (no listings expired for this source)`);
    }
    summary.newListings += rec.newIds.length;
    summary.expired += rec.expiredIds.length;
  }

  // 3. detail enrichment for listings not yet read
  const active = () => Object.values(state.listings).filter((l) => l.status === "active");
  for (const source of ["craigslist", "redfin"] as SourceName[]) {
    const sc = cfg.sources[source];
    if (!summary.sources[source]?.ok) continue;
    const todo = active()
      .filter((l) => l.source === source && !l.detailFetchedAt && l.price <= cfg.criteria.maxPrice)
      .sort((a, b) => (b.postedAt ?? "").localeCompare(a.postedAt ?? ""))
      .slice(0, sc.maxDetailFetchesPerRun);
    let failures = 0;
    for (const [i, l] of todo.entries()) {
      if (i > 0) await sleep(sc.detailDelayMs);
      try {
        if (source === "craigslist") {
          const d = await enrichCraigslist(l, fetcher);
          if (d.gone) {
            expire(l, "deleted on craigslist", now.toISOString());
            summary.expired++;
            continue;
          }
          l.text = d.text;
          l.structured = d.structured;
          if (d.address && /\d/.test(d.address)) l.address = d.address;
          if (d.baths !== undefined) l.baths = d.baths;
        } else {
          const d = await enrichRedfin(l, cfg, fetcher, sc.detailDelayMs);
          l.structured = d.structured;
          l.text = [l.text?.split("\n[redfin amenities]")[0], d.text].filter(Boolean).join("\n");
          if (d.plan === null) {
            expire(l, "no 1–2BR unit within budget", now.toISOString());
            summary.expired++;
          } else if (d.plan) {
            l.meta = { ...l.meta, searchPrice: l.price, planPrice: d.plan.price };
            if (l.price !== d.plan.price) l.priceHistory.push({ at: now.toISOString(), price: d.plan.price });
            l.price = d.plan.price;
            l.beds = d.plan.beds;
            l.bedsMax = d.plan.beds;
            if (d.plan.baths !== null) l.baths = d.plan.baths;
            l.text += `\n[cheapest matching unit] ${d.plan.label} $${d.plan.price}`;
          }
        }
        l.detailFetchedAt = now.toISOString();
      } catch (err) {
        failures++;
        if (failures === 1) logFailure("RentalTracker", err, { phase: "detail", source, id: l.id });
        log(`${source}: detail failed for ${l.id} — ${(err as Error).message}`);
        if (failures >= 5) {
          log(`${source}: 5 detail failures — stopping detail fetches this run`);
          break;
        }
      }
    }
    if (todo.length) log(`${source}: read ${todo.length - failures} listing pages`);
  }

  // 4. feature extraction for new / changed listings
  const needs = active()
    .filter((l) => l.detailFetchedAt && (!l.features || l.features.extractor !== "llm" || l.contentHash !== hashContent(l)))
    .filter((l) => l.price <= cfg.criteria.maxPrice)
    .slice(0, cfg.extraction.maxListingsPerRun);
  if (needs.length) {
    const ex = await extractFeatures(needs, { ...cfg.extraction, useLlm: opts.useLlm !== false }, opts.infer ?? inference);
    for (const l of needs) {
      const f = ex.features.get(l.id)!;
      l.features = mergeStructured(f, l.structured);
      l.contentHash = hashContent(l);
    }
    summary.extracted = needs.length - ex.fallbacks;
    summary.extractionFallbacks = ex.fallbacks;
    if (ex.errors.length) {
      logFailure("RentalTracker", new Error(ex.errors[0]), { phase: "extract", failedBatches: ex.errors.length, fallbacks: ex.fallbacks });
      log(`extraction: ${ex.errors.length} batch(es) failed — ${ex.fallbacks} listing(s) on keyword fallback (flagged on the board)`);
    }
    log(`extraction: ${summary.extracted} via LLM, ${ex.fallbacks} via keywords`);
  }

  // 5. score everything active (config may have changed)
  for (const l of active()) {
    const f = l.features ?? mergeStructured(keywordFeatures(l), l.structured);
    l.score = scoreListing(l, f, cfg);
  }

  // 6. alerts — exceptional, never alerted (incl. via a duplicate), not rejected
  const live = active().filter((l) => l.features && l.score);
  const groups = groupDuplicates(live);
  const byId = state.listings;
  const fresh: StoredListing[] = [];
  for (const [primary, members] of groups) {
    const p = byId[primary];
    if (members.some((m) => byId[m].alertedAt || byId[m].decision === "rejected")) continue;
    if (isExceptional(p.score!, p.features!, cfg)) fresh.push(p);
  }
  fresh.sort((a, b) => b.score!.total - a.score!.total);
  summary.exceptional = fresh.map((l) => ({ id: l.id, score: l.score!.total, line: oneLine(l) }));

  if (fresh.length && opts.alerts !== "skip") {
    const msg = formatAlert(fresh, cfg);
    const result: AlertResult = await (opts.send ?? sendAlert)(msg, {
      key: "rental-tracker:ob-exceptional",
      tier: "page",
      cooldownMs: 10 * 60_000,
      fingerprint: fresh.map((l) => l.id).sort().join(","),
    });
    summary.alertResult = result;
    // 'spooled' = deferred to the digest (quiet hours / throttle) — still delivered, so it counts.
    if (result === "paged" || result === "spooled") {
      for (const l of fresh) for (const m of groups.get(l.id) ?? [l.id]) byId[m].alertedAt = now.toISOString();
      summary.alerted = fresh.map((l) => l.id);
    }
    log(`alert: ${fresh.length} exceptional → ${result}`);
  }

  prune(state, cfg, now);
  summary.activeCount = active().length;
  summary.durationMs = Date.now() - t0;
  const { exceptional: _x, activeCount: _a, ...run } = summary;
  state.runs.push(run);
  mergeDecisionsFromDisk(state, path);
  saveState(state, path);
  return summary;
}

// ============================================================================
// Formatting
// ============================================================================

export const LAUNDRY_LABEL: Record<string, string> = { in_unit: "W/D in unit", on_site: "laundry on site", none: "no laundry", unknown: "laundry ?" };
export const KIND_LABEL: Record<string, string> = { house: "house", duplex_cottage: "cottage/duplex", condo_townhome: "condo/townhome", apartment: "apartment", unknown: "" };

export function bedsLabel(l: StoredListing): string {
  const b = l.beds === null ? "?" : l.bedsMax && l.bedsMax !== l.beds ? `${l.beds}-${l.bedsMax}` : String(l.beds);
  return `${b}BR${l.baths ? `/${l.baths}BA` : ""}`;
}

export function featureBits(l: StoredListing): string[] {
  const f = l.features;
  if (!f) return [];
  const bits: string[] = [];
  bits.push(f.dishwasher === "yes" ? "dishwasher" : f.dishwasher === "no" ? "NO dishwasher" : "dishwasher ?");
  bits.push(LAUNDRY_LABEL[f.laundry]);
  if (f.yard === "private") bits.push("private yard");
  if (f.ac === "yes") bits.push("A/C");
  if (f.kitchen === "large") bits.push("big kitchen");
  return bits;
}

export function oneLine(l: StoredListing): string {
  const s = l.score!;
  const kind = l.features ? KIND_LABEL[l.features.propertyKind] : "";
  return `${s.total} · $${l.price.toLocaleString()} · ${bedsLabel(l)}${kind ? ` ${kind}` : ""} · ${l.address || l.title}`;
}

export function formatAlert(list: StoredListing[], cfg: TrackerConfig): string {
  const shown = list.slice(0, cfg.alerts.maxPerMessage);
  const lines = [`🏖️ Ocean Beach rental${list.length > 1 ? `s — ${list.length} exceptional` : " — exceptional listing"}`];
  for (const [i, l] of shown.entries()) {
    const s = l.score!;
    const near = s.newportMi <= s.voltaireMi ? `Newport ${walkMinutes(s.newportMi)} min` : `Voltaire ${walkMinutes(s.voltaireMi)} min`;
    lines.push(
      "",
      `${i + 1}) ${oneLine(l)}`,
      `   walk: beach ${walkMinutes(s.beachMi)} min · ${near} | ${featureBits(l).join(" · ")}`,
      ...(l.features?.summary ? [`   ${l.features.summary}`] : []),
      `   ${l.url}`,
    );
  }
  if (list.length > shown.length) lines.push("", `+${list.length - shown.length} more on the board`);
  lines.push("", "Board: http://localhost:31337/rentals");
  return lines.join("\n");
}

// ============================================================================
// Board query (shared by CLI + web)
// ============================================================================

export interface BoardRow extends StoredListing {
  dupes: { id: string; source: string; url: string; price: number }[];
}

export function boardRows(state: TrackerState, opts: { includeExpired?: boolean } = {}): BoardRow[] {
  const active = Object.values(state.listings).filter((l) => l.status === "active" && l.score);
  const groups = groupDuplicates(active);
  const rows: BoardRow[] = [];
  for (const [primary, members] of groups) {
    const p = state.listings[primary];
    rows.push({ ...p, dupes: members.slice(1).map((m) => state.listings[m]).map((d) => ({ id: d.id, source: d.source, url: d.url, price: d.price })) });
  }
  if (opts.includeExpired) {
    for (const l of Object.values(state.listings)) if (l.status === "expired" && l.score) rows.push({ ...l, dupes: [] });
  }
  return rows.sort((a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0));
}

// ============================================================================
// CLI
// ============================================================================

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [cmd = "help", ...args] = argv;
  const json = args.includes("--json");
  const cfg = loadConfig();

  if (cmd === "scan") {
    const r = await scan(cfg, {
      useLlm: !args.includes("--no-llm"),
      alerts: args.includes("--no-alert") ? "skip" : "send",
      log: json ? undefined : (m) => console.log(`[rentals] ${m}`),
    });
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`[rentals] ${r.activeCount} active · ${r.newListings} new · ${r.expired} expired · ${r.exceptional.length} exceptional${r.alertResult ? ` (alert: ${r.alertResult})` : ""} · ${(r.durationMs / 1000).toFixed(0)}s`);
      for (const e of r.exceptional) console.log(`  ★ ${e.line}`);
    }
    // Loud failure for the cron ledger: every source failed = nothing scanned.
    return Object.values(r.sources).some((s) => s.ok) ? 0 : 1;
  }

  const state = loadState();

  if (cmd === "board") {
    const limit = Number(arg(args, "--limit") ?? 20);
    let rows = boardRows(state);
    if (!args.includes("--all")) rows = rows.filter((r) => r.score!.eligible && r.decision !== "rejected");
    rows = rows.slice(0, limit);
    if (json) {
      console.log(JSON.stringify(rows, null, 2));
      return 0;
    }
    for (const r of rows) {
      const s = r.score!;
      console.log(`${String(s.total).padStart(3)}  $${String(r.price).padEnd(5)} ${bedsLabel(r).padEnd(9)} beach ${s.beachMi.toFixed(2)}mi  walk ${s.walkMi.toFixed(2)}mi  ${featureBits(r).join(", ")}${r.decision !== "new" ? `  [${r.decision}]` : ""}`);
      console.log(`     ${r.address || r.title}  —  ${r.id}`);
      console.log(`     ${r.url}${r.dupes.length ? `  (+${r.dupes.length} dup)` : ""}`);
    }
    return 0;
  }

  if (cmd === "show") {
    const l = state.listings[args[0]];
    if (!l) {
      console.error(`no listing ${args[0]}`);
      return 1;
    }
    console.log(JSON.stringify(l, null, 2));
    return 0;
  }

  if (cmd === "decide") {
    const [id, decision, ...note] = args;
    const l = setDecision(state, id, decision as Decision, note.length ? note.join(" ") : undefined);
    saveState(state);
    console.log(`${l.id} → ${l.decision}${l.note ? ` (${l.note})` : ""}`);
    return 0;
  }

  if (cmd === "status") {
    const all = Object.values(state.listings);
    const active = all.filter((l) => l.status === "active");
    const out = {
      statePath: statePath(),
      active: active.length,
      eligible: active.filter((l) => l.score?.eligible).length,
      expired: all.length - active.length,
      alertedEver: all.filter((l) => l.alertedAt).length,
      keywordFallback: active.filter((l) => l.features?.extractor === "keywords").length,
      lastRuns: state.runs.slice(-5),
    };
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }

  if (cmd === "serve") {
    const { serveBoard } = await import("./Board.ts");
    serveBoard(Number(arg(args, "--port") ?? 31340));
    return -1; // keep running
  }

  console.log(readFileSync(import.meta.path, "utf-8").match(/\* CLI:[\s\S]*?\n \*\n/)?.[0].replace(/^ \* ?/gm, "") ?? "see file header");
  return cmd === "help" ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code >= 0) process.exit(code);
    })
    .catch((err) => {
      console.error(`[rentals] ${(err as Error).stack ?? err}`);
      process.exit(1);
    });
}
