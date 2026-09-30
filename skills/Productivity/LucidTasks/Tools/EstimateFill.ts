/**
 * EstimateFill.ts — fill energy_level + estimated_minutes for active tasks,
 * per lane, with per-lane calibration.
 *
 * Shared by `kaya-cli tasks estimate` (CLI) and the morning cron (TaskAutomation
 * Step 5) — two callers, one seam. Neither caller re-implements lane selection,
 * fill-vs-refresh, write verification, or the missing-estimate bookkeeping.
 *
 * Lanes:
 *   jm   — Jm's own work (PriorityList.isJmLane): a HUMAN's wall-clock.
 *   kaya — the executor's autonomous lane (disposition='autonomous'): an AI
 *          agent's wall-clock. Kaya overestimates its own work badly — on
 *          2026-09-10 the median estimated/actual ratio over 43 completed
 *          autonomous tasks was 5.7×, most actuals under 25 minutes — so this
 *          lane is calibrated against the DB's MEASURED actuals
 *          (TaskDB.getEstimateCalibration), fed to the model at estimate time,
 *          and hard-capped at KAYA_MAX_MINUTES. The numbers come from the DB,
 *          not from a constant, so the calibration keeps tracking reality.
 *
 * Every write is verified by re-reading the row (LucidTasks edits have failed
 * silently before), and a task the model didn't return is reported as
 * `missing`, never invented.
 *
 * @module EstimateFill
 */

import type { Task, TaskDB, EstimateCalibration } from "./TaskDB.ts";
import { estimateTaskEffort, type EffortEstimate, type EffortInput } from "./TaskAI.ts";
import { findIceboxId, isJmLane, JM_LANE_STATUSES } from "./PriorityList.ts";

// ============================================================================
// Types
// ============================================================================

export type EstimateLane = "jm" | "kaya";
export const ESTIMATE_LANES: readonly EstimateLane[] = ["jm", "kaya"] as const;

/** Hard ceiling for an agent task — the measured p75 actual is well under an hour. */
export const KAYA_MAX_MINUTES = 150;
export const KAYA_MIN_MINUTES = 3;

export type EstimateFn = (
  tasks: EffortInput[],
  opts: { actor: EstimateLane; calibration?: EstimateCalibration },
) => Promise<EffortEstimate[]>;

export interface FillOptions {
  lanes: EstimateLane[];
  /** Re-estimate the whole lane, overwriting existing values (opt-in). */
  refresh?: boolean;
  /** Compute + return proposals without writing. */
  dryRun?: boolean;
  /** Injectable for tests / no-LLM cron dry runs. Defaults to TaskAI.estimateTaskEffort. */
  estimateFn?: EstimateFn;
}

export interface FillApplied {
  lane: EstimateLane;
  id: string;
  title: string;
  energy_level?: Task["energy_level"];
  estimated_minutes?: number;
  previous: { energy_level: Task["energy_level"]; estimated_minutes: number | null };
  rationale: string;
  /** true once the row re-read matches the write (always false on dry run). */
  verified: boolean;
}

export interface LaneCounts {
  lane_size: number;
  targeted: number;
  applied: number;
}

export interface FillResult {
  dryRun: boolean;
  refresh: boolean;
  lanes: Partial<Record<EstimateLane, LaneCounts>>;
  applied: FillApplied[];
  /** Task ids the model returned nothing for. */
  missing: string[];
  /** Task ids whose write did not persist. */
  unverified: string[];
  /** Calibration fed to the kaya lane (null when that lane wasn't run or has no data). */
  kayaCalibration: EstimateCalibration | null;
}

// ============================================================================
// Lane membership
// ============================================================================

/** Kaya's own work: the executor's autonomous lane, active, not Icebox. */
export function isKayaLane(task: Task, iceboxId: string | null): boolean {
  if (!(JM_LANE_STATUSES as readonly string[]).includes(task.status)) return false;
  if (task.disposition !== "autonomous") return false;
  if (iceboxId && task.project_id === iceboxId) return false;
  return true;
}

export function laneTasks(db: TaskDB, lane: EstimateLane): Task[] {
  const iceboxId = findIceboxId(db);
  const active = db.listTasks({ status: [...JM_LANE_STATUSES], limit: 10_000 });
  return active.filter((t) => (lane === "jm" ? isJmLane(t, iceboxId) : isKayaLane(t, iceboxId)));
}

// ============================================================================
// Fill
// ============================================================================

export async function fillEstimates(db: TaskDB, opts: FillOptions): Promise<FillResult> {
  const refresh = opts.refresh ?? false;
  const dryRun = opts.dryRun ?? false;
  const estimateFn = opts.estimateFn ?? estimateTaskEffort;
  const projectMap = new Map(db.listProjects().map((p) => [p.id, p.name] as const));

  const result: FillResult = {
    dryRun,
    refresh,
    lanes: {},
    applied: [],
    missing: [],
    unverified: [],
    kayaCalibration: null,
  };

  for (const lane of opts.lanes) {
    const lane_size_tasks = laneTasks(db, lane);
    const targets = refresh
      ? lane_size_tasks
      : lane_size_tasks.filter((t) => !t.energy_level || !t.estimated_minutes);
    const counts: LaneCounts = { lane_size: lane_size_tasks.length, targeted: targets.length, applied: 0 };
    result.lanes[lane] = counts;
    if (targets.length === 0) continue;

    let calibration: EstimateCalibration | undefined;
    if (lane === "kaya") {
      const c = db.getEstimateCalibration("autonomous");
      calibration = c.n > 0 ? c : undefined;
      result.kayaCalibration = calibration ?? null;
    }

    const estimates = await estimateFn(
      targets.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description || undefined,
        projectName: t.project_id ? projectMap.get(t.project_id) : undefined,
        status: t.status,
        priority: t.priority,
        current_energy: t.energy_level,
        current_minutes: t.estimated_minutes,
      })),
      { actor: lane, calibration },
    );

    const byId = new Map(estimates.map((e) => [e.id, e] as const));
    for (const t of targets) {
      const e = byId.get(t.id);
      if (!e) {
        result.missing.push(t.id);
        continue;
      }
      const minutes = lane === "kaya"
        ? Math.min(KAYA_MAX_MINUTES, Math.max(KAYA_MIN_MINUTES, e.estimated_minutes))
        : e.estimated_minutes;

      // Fill-only keeps any field already set; --refresh overwrites both.
      const updates: Partial<Task> = {};
      if (refresh || !t.energy_level) updates.energy_level = e.energy_level;
      if (refresh || !t.estimated_minutes) updates.estimated_minutes = minutes;

      let verified = false;
      if (!dryRun && Object.keys(updates).length > 0) {
        db.updateTask(t.id, updates, "ai");
        db.logActivity(
          t.id,
          "ai_estimated",
          JSON.stringify({
            lane,
            ...updates,
            from: { energy_level: t.energy_level, estimated_minutes: t.estimated_minutes },
            rationale: e.rationale,
          }),
          "ai",
        );
        const after = db.getTask(t.id);
        verified =
          !!after &&
          (updates.energy_level === undefined || after.energy_level === updates.energy_level) &&
          (updates.estimated_minutes === undefined || after.estimated_minutes === updates.estimated_minutes);
        if (!verified) result.unverified.push(t.id);
      }
      counts.applied++;
      result.applied.push({
        lane,
        id: t.id,
        title: t.title,
        energy_level: updates.energy_level,
        estimated_minutes: updates.estimated_minutes ?? undefined,
        previous: { energy_level: t.energy_level, estimated_minutes: t.estimated_minutes },
        rationale: e.rationale,
        verified,
      });
    }
  }

  return result;
}
