/**
 * HealthManager.ts — Single source of truth for AutoMaintenance health state.
 *
 * Merges the previously split HealthState interfaces from SelfMonitor and HealthTracker
 * into one canonical Zod-validated schema backed by lib/core/StateManager.
 *
 * Spec: AutoMaintenance architecture review — Decision A, B, D, G
 */

import { z } from "zod";
import { join } from "path";
import { createStateManager } from "../../../../lib/core/StateManager";
import { AlertGate, getAlertGate } from "../../../../lib/core/AlertGate.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

// ============================================================================
// Schema
// ============================================================================

export const IssueRecordSchema = z.object({
  firstSeen: z.string(),
  lastSeen: z.string(),
  occurrences: z.number(),
  type: z.string(),
  finding: z.string(),
  status: z.enum(["monitoring", "escalated", "auto-resolved"]),
  /** Unix timestamp ms — set when status transitions to 'auto-resolved' */
  resolvedAt: z.number().optional(),
});

export const HealthStateSchema = z.object({
  lastRunByTier: z.record(z.string(), z.string()),
  currentStreak: z.record(z.string(), z.number()),
  longestGap: z.record(z.string(), z.string()),
  openAlerts: z.number().default(0),
  /** Typed issuePersistence — replaces the untyped field in legacy SelfMonitor.HealthState */
  issuePersistence: z.record(z.string(), IssueRecordSchema).default({}),
  lastUpdated: z.string().optional(),
});

export type HealthState = z.infer<typeof HealthStateSchema>;
export type IssueRecord = z.infer<typeof IssueRecordSchema>;
export type IssueKey = string; // format: "{workflow}:{step}:{sha256(finding)[0:8]}"

// ============================================================================
// Singleton StateManager
// ============================================================================

function getHealthStatePath(): string {
  const kayaHome = getKayaHome();
  return join(kayaHome, "MEMORY", "AutoMaintenance", "health-state.json");
}

const HEALTH_STATE_DEFAULTS: HealthState = {
  lastRunByTier: {},
  currentStreak: {},
  longestGap: {},
  openAlerts: 0,
  issuePersistence: {},
};

let _healthManager: ReturnType<typeof createStateManager<HealthState>> | null = null;

function getHealthManager(): ReturnType<typeof createStateManager<HealthState>> {
  if (!_healthManager) {
    _healthManager = createStateManager<HealthState>({
      path: getHealthStatePath(),
      schema: HealthStateSchema,
      defaults: HEALTH_STATE_DEFAULTS,
      backupOnWrite: true,
      maxBackups: 5,
    });
  }
  return _healthManager;
}

export function _resetHealthManagerForTest(): void {
  _healthManager = null;
}

// ============================================================================
// issuePersistence TTL pruning (Decision G + Bug NEW-1)
// ============================================================================

const RESOLVED_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days for auto-resolved
const STALE_MONITORING_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days for monitoring

function pruneIssuePersistence(state: HealthState): HealthState {
  const now = Date.now();
  const pruned: HealthState["issuePersistence"] = {};

  for (const [key, record] of Object.entries(state.issuePersistence)) {
    if (record.status === "auto-resolved") {
      // Prefer resolvedAt; fall back to lastSeen for backward compat
      const resolvedMs = record.resolvedAt ?? new Date(record.lastSeen).getTime();
      if (now - resolvedMs > RESOLVED_TTL_MS) continue; // TTL expired — drop
    } else if (record.status === "monitoring") {
      const lastSeenMs = new Date(record.lastSeen).getTime();
      if (now - lastSeenMs > STALE_MONITORING_TTL_MS) {
        console.warn(`[HealthManager] Stale monitoring issue (>90 days): ${key}`);
      }
    }
    pruned[key] = record;
  }

  return { ...state, issuePersistence: pruned };
}

// ============================================================================
// Public API
// ============================================================================

export async function loadHealthState(): Promise<HealthState> {
  try {
    return await getHealthManager().load();
  } catch {
    return { ...HEALTH_STATE_DEFAULTS };
  }
}

/** Save with TTL pruning before write */
export async function saveHealthState(state: HealthState): Promise<void> {
  return getHealthManager().save(pruneIssuePersistence(state));
}

export async function updateHealthState(
  fn: (state: HealthState) => HealthState | Promise<HealthState>
): Promise<HealthState> {
  return getHealthManager().update(async (state) => pruneIssuePersistence(await fn(state)));
}

// ============================================================================
// Gap and streak logic (migrated from SelfMonitor — thresholds aligned)
// ============================================================================

export interface GapCheckResult {
  gapDetected: boolean;
  gapHours?: number;
  notificationFired: boolean;
  bypassed?: boolean;
}

export interface StatusData {
  lastRunByTier: { [tier: string]: string };
  currentStreak: { [tier: string]: number };
  longestGap: { [tier: string]: string };
  openAlerts: number;
}

/**
 * options.gate lets callers (tests) inject an AlertGate with a scratch
 * statePath/spoolPath + recording send, so cooldown/dedup behavior is
 * verifiable without touching the real Telegram/state paths. Production
 * callers omit it and get the default singleton (see getAlertGate()).
 */
export async function checkForGaps(
  tier: string,
  state: HealthState,
  options: { force?: boolean; gate?: AlertGate } = {},
): Promise<GapCheckResult> {
  if (options.force) return { gapDetected: false, notificationFired: false, bypassed: true };
  const lastRun = state.lastRunByTier[tier];
  if (!lastRun) return { gapDetected: false, notificationFired: false };
  const gapHours = (Date.now() - new Date(lastRun).getTime()) / (1000 * 60 * 60);
  if (gapHours > 25) {
    // Routed through AlertGate (not a raw notifySync push) — on 2026-07-11 an
    // unplugged MacBook slept through cron windows and the hourly reconciler's
    // catch-up re-invoked checkForGaps 3x, firing 3 raw pushes for the same
    // gap. AlertGate's per-key cooldown makes this edge-triggered: at most one
    // page per tier per cooldown window, with later re-checks demoted to the
    // digest spool (never silently dropped).
    // TIER (2026-07-31): 'digest', not 'page'. The daily SystemHealthDigest
    // ALREADY renders this exact line as one of its bullets, so paging it
    // separately delivered the same sentence twice (confirmed in the 07-17..
    // 07-31 send log: standalone "AutoMaintenance gap: N hours" pages on
    // 3 days, each of which also carried the identical bullet inside that
    // morning's 🩺 digest). A >25h maintenance gap is worth knowing about
    // once a day; it is not worth a dedicated interrupt.
    const gate = options.gate ?? getAlertGate();
    const result = await gate.send(
      `AutoMaintenance gap: ${Math.round(gapHours)} hours since last ${tier} run`,
      { key: `automaintenance-gap-${tier}`, tier: "digest", cooldownMs: 24 * 60 * 60 * 1000 },
    );
    // 'spooled' is the digest-tier success result; 'paged' can no longer occur
    // here. Kept as an explicit set so a future tier change stays honest.
    return { gapDetected: true, gapHours: Math.round(gapHours), notificationFired: result === "spooled" };
  }
  return { gapDetected: false, notificationFired: false };
}

/**
 * Calculate current streak for a tier.
 * Gap threshold: 25 hours — aligned with checkForGaps (fixes §2.8 misalignment).
 * Previously used Math.round(diffMs/(24h)) === 1 which was inconsistent with 25h gap-detection.
 */
export function calculateStreak(_tier: string, runs: string[]): number {
  if (runs.length === 0) return 0;
  const sorted = runs.map((r) => new Date(r)).sort((a, b) => b.getTime() - a.getTime());
  let streak = 1;
  for (let i = 1; i < sorted.length; i++) {
    const gapHours = (sorted[i - 1].getTime() - sorted[i].getTime()) / (1000 * 60 * 60);
    if (gapHours <= 25) streak++;
    else break;
  }
  return streak;
}

export function calculateLongestGap(tier: string, runs: Array<{ tier: string; timestamp: string }>): { days: number; description: string } {
  const times = runs.filter((r) => r.tier === tier).map((r) => new Date(r.timestamp).getTime()).sort();
  if (times.length < 2) return { days: 0, description: "N/A" };
  let max = 0, start = 0, end = 0;
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] > max) { max = times[i] - times[i - 1]; start = times[i - 1]; end = times[i]; }
  }
  const days = Math.round(max / (1000 * 60 * 60 * 24));
  const fmt = (ts: number) => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return { days, description: `${days} days (${fmt(start)} – ${new Date(end).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })})` };
}

export function markIssueResolved(state: HealthState, key: IssueKey): HealthState {
  const record = state.issuePersistence[key];
  if (!record) return state;
  return { ...state, issuePersistence: { ...state.issuePersistence, [key]: { ...record, status: "auto-resolved", resolvedAt: Date.now() } } };
}
