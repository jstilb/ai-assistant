/**
 * PriorityList.ts — Jm's prioritized task list across ALL projects.
 *
 * One ranked list of the work that is Jm's to do (LucidTask t-mtvpxjza-ljsg9).
 * "Jm's lane" = every active task that is NOT Kaya's autonomous work:
 *   - disposition ∉ {autonomous, drop}  (null = untriaged → still Jm's until routed)
 *   - project ≠ Icebox                   (deliberately parked; the board hides it)
 *   - status ∈ in_progress / next / inbox / waiting
 *
 * Ranking score = the stored AI priority score (`ai_priority_score`, written by
 * `tasks prioritize` and the 06:30 morning cron's runPriorityRescore, which
 * folds the 7-factor deterministic score + an LLM adjustment) when present,
 * else the live 7-factor deterministic score. No LLM call happens here — the
 * board polls this every 30s and must stay instant + free. `waiting` tasks
 * trail the list (rank continues) so blocked/parked-for-review items never
 * crowd the top.
 *
 * Pure: rankJmTasks() takes tasks in, list out. buildPriorityList() is the
 * thin DB-backed wrapper shared by the board (`GET /api/priority`) and the CLI
 * (`tasks priority`).
 *
 * @module PriorityList
 */

import type { Task, TaskDB } from "./TaskDB.ts";
import { scoreTask, type ScoringContext } from "./TaskScorer.ts";
import { loadTelosData } from "./TelosGoalLoader.ts";

// ============================================================================
// Types
// ============================================================================

export const JM_LANE_STATUSES = ["in_progress", "next", "inbox", "waiting"] as const;
export type JmLaneStatus = (typeof JM_LANE_STATUSES)[number];

/** Dispositions that mean "not Jm's to do" — Kaya's executor lane or a soft-closed capture. */
const NON_JM_DISPOSITIONS = new Set(["autonomous", "drop"]);

export type EnergyBucket = "high" | "medium" | "low" | "unset";

export interface PriorityItem {
  /** 1-based position in the list. */
  rank: number;
  task: Task;
  /** The ranking score: ai_priority_score when present, else det_score. */
  score: number;
  source: "ai" | "deterministic";
  det_score: number;
  det_reasons: string[];
  ai_score: number | null;
  ai_reasoning: string | null;
  /** Jm's hand-placed slot (board drag-and-drop); null = placed by score. */
  manual_rank: number | null;
}

export interface PriorityTotals {
  count: number;
  /** Sum of estimated_minutes over estimated tasks. */
  estimated_minutes: number;
  /** Tasks with no estimated_minutes — shown so the total is honest. */
  unestimated: number;
  waiting: number;
  by_energy: Record<EnergyBucket, { count: number; minutes: number }>;
}

export interface PriorityList {
  items: PriorityItem[];
  totals: PriorityTotals;
}

// ============================================================================
// Lane membership
// ============================================================================

export function isJmLane(task: Task, iceboxId: string | null): boolean {
  if (!(JM_LANE_STATUSES as readonly string[]).includes(task.status)) return false;
  if (task.disposition && NON_JM_DISPOSITIONS.has(task.disposition)) return false;
  if (iceboxId && task.project_id === iceboxId) return false;
  return true;
}

// ============================================================================
// Ranking (pure)
// ============================================================================

export function rankJmTasks(
  tasks: Task[],
  ctx: ScoringContext,
  iceboxId: string | null,
): PriorityList {
  const scored = tasks
    .filter((t) => isJmLane(t, iceboxId))
    .map((task) => {
      const det = scoreTask(task, ctx);
      const aiScore = typeof task.ai_priority_score === "number" ? task.ai_priority_score : null;
      return {
        task,
        score: aiScore ?? det.score,
        source: aiScore === null ? ("deterministic" as const) : ("ai" as const),
        det_score: det.score,
        det_reasons: det.reasons,
        ai_score: aiScore,
        ai_reasoning: aiScore === null ? null : task.ai_reasoning ?? null,
        manual_rank: typeof task.manual_rank === "number" && task.manual_rank >= 1 ? task.manual_rank : null,
      };
    });

  // waiting last → score desc → det desc → priority asc → due asc (nulls last)
  // → created desc → id asc (a total order, so identical data never jitters).
  scored.sort((a, b) => {
    const wa = a.task.status === "waiting" ? 1 : 0;
    const wb = b.task.status === "waiting" ? 1 : 0;
    if (wa !== wb) return wa - wb;
    if (b.score !== a.score) return b.score - a.score;
    if (b.det_score !== a.det_score) return b.det_score - a.det_score;
    if (a.task.priority !== b.task.priority) return a.task.priority - b.task.priority;
    if (a.task.due_date && b.task.due_date) {
      const dd = a.task.due_date.localeCompare(b.task.due_date);
      if (dd !== 0) return dd;
    } else if (a.task.due_date && !b.task.due_date) return -1;
    else if (!a.task.due_date && b.task.due_date) return 1;
    const cc = (b.task.created_at || "").localeCompare(a.task.created_at || "");
    if (cc !== 0) return cc;
    return a.task.id.localeCompare(b.task.id);
  });

  const items: PriorityItem[] = placePinned(scored).map((s, i) => ({ rank: i + 1, ...s }));
  return { items, totals: computeTotals(items) };
}

type Unranked = Omit<PriorityItem, "rank">;

/**
 * Manual placement (board drag-and-drop). The top of the list is Jm's hand order:
 * every pinned task sits above every unpinned one, ordered by `manual_rank`
 * (an ordinal among pins, not an absolute slot — gaps and stale numbers are fine,
 * only the relative order matters). Below the pinned block, unpinned tasks keep
 * their score order. Two pins with the same ordinal: the newer pin wins. Pinned
 * tasks ignore the waiting-last rule — Jm put them there on purpose.
 *
 * Why a block and not absolute slots: a slot pin ("#5") drifts as the list
 * shrinks and grows, and the unpinned neighbours between two pins reshuffle on
 * every rescore, so the order Jm dragged into was not what he saw the next day.
 * A drop on the board pins the dragged row AND everything above it (see
 * BoardServer POST /api/priority/pins), so the block is always a contiguous prefix.
 */
function placePinned(scored: Unranked[]): Unranked[] {
  const pinned = scored
    .filter((s): s is Unranked & { manual_rank: number } => s.manual_rank !== null)
    .sort((a, b) => {
      if (a.manual_rank !== b.manual_rank) return a.manual_rank - b.manual_rank;
      const ta = a.task.manual_ranked_at || "";
      const tb = b.task.manual_ranked_at || "";
      if (ta !== tb) return tb.localeCompare(ta);   // newer pin first
      return a.task.id.localeCompare(b.task.id);
    });
  if (pinned.length === 0) return scored;
  return [...pinned, ...scored.filter((s) => s.manual_rank === null)];
}

function computeTotals(items: PriorityItem[]): PriorityTotals {
  const by_energy: PriorityTotals["by_energy"] = {
    high: { count: 0, minutes: 0 },
    medium: { count: 0, minutes: 0 },
    low: { count: 0, minutes: 0 },
    unset: { count: 0, minutes: 0 },
  };
  let estimated_minutes = 0;
  let unestimated = 0;
  let waiting = 0;
  for (const { task } of items) {
    const bucket: EnergyBucket = task.energy_level ?? "unset";
    by_energy[bucket].count++;
    if (task.estimated_minutes) {
      estimated_minutes += task.estimated_minutes;
      by_energy[bucket].minutes += task.estimated_minutes;
    } else {
      unestimated++;
    }
    if (task.status === "waiting") waiting++;
  }
  return { count: items.length, estimated_minutes, unestimated, waiting, by_energy };
}

// ============================================================================
// DB-backed wrapper
// ============================================================================

/** Active TELOS goal ids for the scorer's goal-alignment factor; [] when TELOS is unavailable. */
export function loadActiveGoalIds(): string[] {
  try {
    return loadTelosData()
      .goals.filter((g) => g.status === "In Progress")
      .map((g) => g.id);
  } catch {
    return [];
  }
}

export function findIceboxId(db: TaskDB): string | null {
  return db.listProjects().find((p) => p.name.toLowerCase() === "icebox")?.id ?? null;
}

export function buildPriorityList(
  db: TaskDB,
  opts: { now?: Date; activeGoalIds?: string[] } = {},
): PriorityList {
  const candidates = db.listTasks({ status: [...JM_LANE_STATUSES], limit: 10_000 });
  const ctx: ScoringContext = {
    activeGoalIds: opts.activeGoalIds ?? loadActiveGoalIds(),
    now: opts.now ?? new Date(),
  };
  return rankJmTasks(candidates, ctx, findIceboxId(db));
}

/** "2h 15m" / "45m" — shared by the CLI and the board header. */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
