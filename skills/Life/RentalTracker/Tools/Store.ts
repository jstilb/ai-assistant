/**
 * Store.ts — persisted tracker state + the listing lifecycle.
 *
 * State lives OUT of the repo at <runtimeDir>/RENTALS/<search>.json (runtimeDir
 * = ~/.kaya/runtime, or KAYA_RUNTIME in tests) so branch checkouts never touch
 * it and every worktree/cron shares one copy. Writes are atomic (tmp+rename).
 *
 * Lifecycle (`reconcile`):
 *   - seen in a scan        → upsert, lastSeenAt=now, missedScans=0, price history
 *   - missing from a SUCCESSFUL scan of its source → missedScans++; at
 *     cfg.expiry.missedScans → expired ("removed")
 *   - a failed source scan never touches its listings (no mass-expiry on outage)
 *   - posted > maxAgeDays    → expired ("stale")
 *   - expired > keepExpiredDays → pruned (kept that long so re-posts don't re-alert)
 *
 * @module RentalTracker/Store
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { runtimeDir } from "../../../../lib/core/KayaHome.ts";
import { haversineMi } from "./Geo.ts";
import type { Decision, RawListing, SourceName, StoredListing, TrackerConfig, TrackerState } from "./types.ts";

export function statePath(search = "ocean-beach"): string {
  return join(runtimeDir(), "RENTALS", `${search}.json`);
}

export function emptyState(): TrackerState {
  return { version: 1, listings: {}, runs: [] };
}

export function loadState(path = statePath()): TrackerState {
  if (!existsSync(path)) return emptyState();
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as TrackerState;
  if (parsed?.version !== 1 || typeof parsed.listings !== "object") throw new Error(`RentalTracker: unrecognized state file ${path}`);
  parsed.runs ??= [];
  return parsed;
}

export function saveState(state: TrackerState, path = statePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, path);
}

const DAY = 86_400_000;

export interface ReconcileResult {
  newIds: string[];
  changedIds: string[]; // content changed → needs re-extraction
  expiredIds: string[];
}

/**
 * Merge one source's scan into state. `hits` must be the COMPLETE in-area result
 * set of a successful scan of `source`; pass `scanOk=false` to only age listings.
 */
export function reconcile(state: TrackerState, source: SourceName, hits: RawListing[], scanOk: boolean, cfg: TrackerConfig, now = new Date()): ReconcileResult {
  const iso = now.toISOString();
  const res: ReconcileResult = { newIds: [], changedIds: [], expiredIds: [] };
  const seen = new Set<string>();

  if (scanOk) {
    for (const h of hits) {
      seen.add(h.id);
      const prev = state.listings[h.id];
      if (!prev) {
        state.listings[h.id] = {
          ...h,
          firstSeenAt: iso,
          lastSeenAt: iso,
          missedScans: 0,
          status: "active",
          priceHistory: [{ at: iso, price: h.price }],
          decision: "new",
        };
        res.newIds.push(h.id);
        continue;
      }
      const reactivated = prev.status === "expired";
      // A multi-unit Redfin building's price/beds come from its floor plans (set at
      // detail time); keep them while the building's search-level price is unchanged.
      const hasPlan = prev.meta?.planPrice !== undefined;
      const keepPlan = hasPlan && h.price === prev.meta?.searchPrice;
      const price = keepPlan ? prev.price : h.price;
      if (hasPlan && !keepPlan) {
        delete prev.detailFetchedAt; // building changed — re-read its floor plans
        delete prev.meta!.planPrice;
      }
      if (prev.price !== price) {
        prev.priceHistory.push({ at: iso, price });
        res.changedIds.push(h.id);
      }
      // search-level fields refresh every scan; detail-level fields (text/structured/features) persist
      Object.assign(prev, {
        title: h.title, price, beds: keepPlan ? prev.beds : h.beds,
        bedsMax: keepPlan ? prev.bedsMax : h.bedsMax,
        meta: { ...prev.meta, ...h.meta },
        lat: h.lat, lon: h.lon, url: h.url, photo: h.photo ?? prev.photo,
        address: prev.address && prev.address.length > (h.address?.length ?? 0) ? prev.address : h.address,
        postedAt: h.postedAt ?? prev.postedAt,
        lastSeenAt: iso, missedScans: 0, status: "active",
      });
      if (reactivated) {
        delete prev.expiredAt;
        delete prev.expiredReason;
        if (prev.meta?.multi) delete prev.detailFetchedAt; // re-check its floor plans
      }
    }
    for (const l of Object.values(state.listings)) {
      if (l.source !== source || l.status !== "active" || seen.has(l.id)) continue;
      l.missedScans += 1;
      if (l.missedScans >= cfg.expiry.missedScans) expire(l, "removed from " + source, iso, res);
    }
  }

  const maxAge = cfg.expiry.maxAgeDays[source];
  for (const l of Object.values(state.listings)) {
    if (l.source !== source || l.status !== "active") continue;
    if (maxAge && l.postedAt && now.getTime() - Date.parse(l.postedAt) > maxAge * DAY) expire(l, `stale (posted > ${maxAge}d ago)`, iso, res);
  }
  return res;
}

export function expire(l: StoredListing, reason: string, iso: string, res?: ReconcileResult): void {
  if (l.status === "expired") return;
  l.status = "expired";
  l.expiredAt = iso;
  l.expiredReason = reason;
  res?.expiredIds.push(l.id);
}

export function prune(state: TrackerState, cfg: TrackerConfig, now = new Date()): number {
  let n = 0;
  for (const [id, l] of Object.entries(state.listings)) {
    if (l.status === "expired" && l.expiredAt && now.getTime() - Date.parse(l.expiredAt) > cfg.expiry.keepExpiredDays * DAY) {
      delete state.listings[id];
      n++;
    }
  }
  state.runs = state.runs.slice(-200);
  return n;
}

// ----------------------------------------------------------------------------
// Duplicate grouping — the same unit re-posted on Craigslist, or on both sources
// ----------------------------------------------------------------------------

const DUP_MI = 0.05; // ~80 m — cross-source geocodes differ a little
const SAME_SPOT_MI = 0.012; // ~20 m — same source, same pin

export function isDuplicate(a: StoredListing, b: StoredListing): boolean {
  if (a.beds !== b.beds) return false;
  const d = haversineMi([a.lat, a.lon], [b.lat, b.lon]);
  // Same source: craigslist reposters vary the title every time, so match on
  // pin + price + beds (+ sqft when both have it).
  if (a.source === b.source) {
    return d <= SAME_SPOT_MI && a.price === b.price && (!a.sqft || !b.sqft || a.sqft === b.sqft);
  }
  // Cross-source: the same unit listed on Craigslist and Redfin.
  return d <= DUP_MI && Math.abs(a.price - b.price) <= 100;
}

/**
 * Group active listings into duplicate clusters. Returns primary id → member ids
 * (primary = best score, then a decision-bearing one, then the oldest).
 */
export function groupDuplicates(listings: StoredListing[]): Map<string, string[]> {
  const sorted = [...listings].sort((a, b) =>
    (b.score?.total ?? 0) - (a.score?.total ?? 0) ||
    Number(b.decision !== "new") - Number(a.decision !== "new") ||
    a.firstSeenAt.localeCompare(b.firstSeenAt));
  const groups = new Map<string, string[]>();
  const assigned = new Set<string>();
  for (const p of sorted) {
    if (assigned.has(p.id)) continue;
    assigned.add(p.id);
    const members = [p.id];
    for (const q of sorted) {
      if (!assigned.has(q.id) && isDuplicate(p, q)) {
        assigned.add(q.id);
        members.push(q.id);
      }
    }
    groups.set(p.id, members);
  }
  return groups;
}

export const DECISIONS: Decision[] = ["new", "shortlist", "contacted", "toured", "rejected"];

export function setDecision(state: TrackerState, id: string, decision: Decision, note?: string): StoredListing {
  const l = state.listings[id];
  if (!l) throw new Error(`no listing ${id}`);
  if (!DECISIONS.includes(decision)) throw new Error(`decision must be one of ${DECISIONS.join(", ")}`);
  l.decision = decision;
  l.decidedAt = new Date().toISOString();
  if (note !== undefined) l.note = note.slice(0, 1000);
  return l;
}

/**
 * A scan holds state in memory for minutes; decisions made on the board in the
 * meantime are on disk. Before the scan saves, carry over any newer decision.
 */
export function mergeDecisionsFromDisk(state: TrackerState, path: string): number {
  if (!existsSync(path)) return 0;
  let n = 0;
  const disk = loadState(path);
  for (const [id, d] of Object.entries(disk.listings)) {
    const l = state.listings[id];
    if (!l || !d.decidedAt || (l.decidedAt && l.decidedAt >= d.decidedAt)) continue;
    l.decision = d.decision;
    l.decidedAt = d.decidedAt;
    l.note = d.note;
    n++;
  }
  return n;
}
