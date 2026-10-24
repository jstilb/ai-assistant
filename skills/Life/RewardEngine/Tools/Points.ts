/**
 * ============================================================================
 * Points — deterministic points ledger for tasks, habits and routines
 * ============================================================================
 *
 * The roll (RewardEngine.ts) is the VARIABLE half of the reward loop: you never
 * know what a roll pays. Points are the FIXED half: every completed LucidTasks
 * task, every LifeOS habit_log entry and every checked Daily/Weekly Behaviors
 * routine item earns a known, auditable number of points, plus streak bonuses:
 *
 *   - continuation — keep an item's streak alive and each period pays a growing
 *                    bonus (capped), plus one-off milestone bonuses (7, 14, 30…)
 *   - recovery     — come back to an item after a broken streak (prior streak
 *                    ≥ N, missed ≤ M periods) and you get a "never miss twice"
 *                    bonus for restarting
 *   - weekly target — hit a per-week cadence (e.g. build ≥ 5 days/week)
 *
 * A score goal (per day / week / month) can be set and progress is shown by
 * `points` / `stats`.
 *
 * HOW SCORING STAYS HONEST:
 *   - scoreHistory() is PURE: the full completion history in → a deterministic
 *     list of point awards, each with a stable key (task:<id>, item:<slug>:<day>,
 *     streak:<slug>:<day>, …). Weights live in config/rewards.json → "points".
 *   - syncLedger() appends to points-ledger.jsonl only the difference between
 *     what the history says is owed per key and what the ledger has already
 *     paid for it. Re-running is a no-op; logging more reps later in the day
 *     tops up the delta. The ledger is append-only — points are never clawed
 *     back.
 *   - Sources are read READ-ONLY (sqlite readonly handles). Points only accrue
 *     for completions on/after points.startDate; earlier history still counts
 *     toward streaks so streaks are real from day one.
 *
 * STATE:
 *   Ledger:          $KAYA_HOME/runtime/reward-engine/points-ledger.jsonl
 *   Routine checks:  $KAYA_HOME/runtime/reward-engine/routine-checks.jsonl
 *   Goal:            $KAYA_HOME/runtime/reward-engine/points-goal.json
 * ============================================================================
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { createAppendLog } from "../../../../lib/core/AppendLog.ts";

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type Cadence = "daily" | "weekly";
export type BonusKind = "continuation" | "recovery";
export type CompletionSource = "task" | "habit" | "routine";
export type AwardKind = "task" | "base" | "continuation" | "milestone" | "recovery" | "weekly_target";
export type GoalPeriod = "day" | "week" | "month";

export interface ItemDef {
  label: string;
  cadence: Cadence;
  /** Flat points per done period (ignored when unitPoints is set). */
  points: number;
  /** Counter items: points per unit (e.g. per phone-sep rep), capped at maxUnits. */
  unitPoints?: number;
  maxUnits?: number;
  /** Units needed for the period to count as "done" for streaks. Default 1. */
  doneAt?: number;
  /** Per-week target: daily items count done days, weekly items count units. */
  weeklyTarget?: { count: number; bonus: number };
  bonuses: BonusKind[];
  /** habit_log slugs that feed this item. */
  habits?: string[];
  /** Daily/Weekly Behaviors row names that feed this item (case-insensitive). */
  routines?: string[];
}

export interface TaskWeights {
  byPriority: Record<string, number>;
  estimate: { everyMinutes: number; points: number; max: number };
  goalLinkedBonus: number;
  excludeDispositions: string[];
  /** Item that tracks "≥ 1 task completed" per day, for task streaks. */
  streakItem: string;
}

export interface StreakRules {
  continuation: { startAt: number; perPeriod: number; max: number; milestones: Record<string, number> };
  recovery: { minPriorStreak: number; maxMissedPeriods: Record<Cadence, number>; bonus: number };
}

export interface PointsConfig {
  startDate: string;
  tasks: TaskWeights;
  routineDefault: { points: number; bonuses: BonusKind[] };
  /** Behaviors rows that are never checkable (counted elsewhere, e.g. via the habit form). */
  routineIgnore: string[];
  streaks: StreakRules;
  items: Record<string, ItemDef>;
}

/** A normalized completion from any source. */
export interface Completion {
  source: CompletionSource;
  /** Item id; for tasks this is the task id. */
  item: string;
  day: string; // local YYYY-MM-DD
  units: number;
  label: string;
  task?: { priority: number; estimatedMinutes: number | null; goalLinked: boolean };
}

/** A deterministic award computed from history. */
export interface Award {
  key: string;
  day: string;
  kind: AwardKind;
  item: string;
  label: string;
  points: number;
  detail: string;
}

export interface PointsLedgerEntry extends Award {
  at: string;
  /** True when this entry tops up an existing key (more units logged later). */
  topUp?: boolean;
}

export interface ItemStreak {
  item: string;
  label: string;
  cadence: Cadence;
  current: number;
  lastDone: string | null;
  /** Prior streak that a recovery would restore, when a recovery is still claimable. */
  recoverable: number | null;
}

export interface PointsGoal {
  target: number;
  period: GoalPeriod;
  setAt: string;
}

export interface RoutineEntry {
  item: string;
  label: string;
  cadence: Cadence;
}

// ----------------------------------------------------------------------------
// Paths
// ----------------------------------------------------------------------------

export function pointsPaths(): { dir: string; ledger: string; routines: string; goal: string } {
  const dir = join(getKayaHome(), "runtime", "reward-engine");
  return {
    dir,
    ledger: join(dir, "points-ledger.jsonl"),
    routines: join(dir, "routine-checks.jsonl"),
    goal: join(dir, "points-goal.json"),
  };
}

// The ledger is the dedup source of truth, so it must never rotate away.
const NO_ROTATE = { maxSizeMB: 1024, maxRotatedFiles: 1000, retentionDays: 36500 };
const pointsLedgerLog = createAppendLog(pointsPaths().ledger, NO_ROTATE);
const routineCheckLog = createAppendLog(pointsPaths().routines, NO_ROTATE);

const HOME = process.env.HOME || "/Users/[user]";
export const DAILY_BEHAVIORS_PATH = join(HOME, "Desktop/obsidian/POS/Daily Behaviors.md");
export const WEEKLY_BEHAVIORS_PATH = join(HOME, "Desktop/obsidian/POS/Weekly Behaviors.md");

// ----------------------------------------------------------------------------
// Date helpers (pure, UTC math on YYYY-MM-DD strings)
// ----------------------------------------------------------------------------

function toUtc(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

export function addDays(day: string, n: number): string {
  const dt = toUtc(day);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86400000);
}

/** Monday of the week containing `day` (weeks start Monday). */
export function weekStart(day: string): string {
  const dow = toUtc(day).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

export function periodStart(day: string, period: GoalPeriod): string {
  if (period === "day") return day;
  if (period === "week") return weekStart(day);
  return `${day.slice(0, 8)}01`;
}

/** Local YYYY-MM-DD of an instant (same convention as RewardEngine.localDay). */
export function localDayOf(instant: Date): string {
  return instant.toLocaleDateString("en-CA");
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// ----------------------------------------------------------------------------
// Pure scoring
// ----------------------------------------------------------------------------

/** Points for one completed task. */
export function taskPoints(w: TaskWeights, t: NonNullable<Completion["task"]>): { points: number; detail: string } {
  const base = w.byPriority[String(t.priority)] ?? w.byPriority["2"] ?? 0;
  const est = t.estimatedMinutes && t.estimatedMinutes > 0
    ? Math.min(w.estimate.max, Math.floor(t.estimatedMinutes / w.estimate.everyMinutes) * w.estimate.points)
    : 0;
  const goal = t.goalLinked ? w.goalLinkedBonus : 0;
  const parts = [`P${t.priority} ${base}`];
  if (est) parts.push(`+${est} size`);
  if (goal) parts.push(`+${goal} goal`);
  return { points: base + est + goal, detail: parts.join(" ") };
}

/** Base points for an item given the units logged in one period. */
export function itemBasePoints(def: ItemDef, units: number): number {
  if (units <= 0) return 0;
  if (def.unitPoints !== undefined) {
    const capped = def.maxUnits !== undefined ? Math.min(units, def.maxUnits) : units;
    return Math.round(capped * def.unitPoints);
  }
  return def.points;
}

/** Continuation bonus for reaching `streak` consecutive periods (0 below startAt). */
export function continuationBonus(rules: StreakRules, streak: number): number {
  const c = rules.continuation;
  if (streak < c.startAt) return 0;
  return Math.min(c.max, (streak - c.startAt + 1) * c.perPeriod);
}

function periodsBetween(cadence: Cadence, a: string, b: string): number {
  const d = daysBetween(a, b);
  return cadence === "daily" ? d : Math.round(d / 7);
}

/** Resolve an item definition, synthesizing one for unconfigured routine items. */
export function resolveItem(cfg: PointsConfig, item: string, fallbackLabel: string, cadence: Cadence = "daily"): ItemDef | null {
  const def = cfg.items[item];
  if (def) return def;
  if (item.startsWith("routine:")) {
    return { label: fallbackLabel, cadence, points: cfg.routineDefault.points, bonuses: cfg.routineDefault.bonuses };
  }
  return null;
}

interface PeriodState {
  /** Period key: the day (daily) or the week's Monday (weekly). */
  period: string;
  units: number;
  /** Day the period first counted as done (when the target was reached). */
  doneDay: string | null;
}

/**
 * Walk the item's done periods and return its streak events.
 * Exported for streak views; scoreHistory() uses it for bonuses.
 */
export function walkStreak(
  rules: StreakRules,
  cadence: Cadence,
  donePeriods: string[],
): Array<{ period: string; streak: number; recoveredFrom: number | null }> {
  const out: Array<{ period: string; streak: number; recoveredFrom: number | null }> = [];
  let prev: string | null = null;
  let streak = 0;
  for (const p of [...donePeriods].sort()) {
    let recoveredFrom: number | null = null;
    if (prev !== null && periodsBetween(cadence, prev, p) === 1) {
      streak += 1;
    } else {
      if (prev !== null) {
        const missed = periodsBetween(cadence, prev, p) - 1;
        if (streak >= rules.recovery.minPriorStreak && missed <= rules.recovery.maxMissedPeriods[cadence]) {
          recoveredFrom = streak;
        }
      }
      streak = 1;
    }
    out.push({ period: p, streak, recoveredFrom });
    prev = p;
  }
  return out;
}

/**
 * PURE: full completion history → deterministic awards (stable keys).
 * Only awards dated on/after cfg.startDate are emitted; earlier history still
 * builds streaks.
 */
export function scoreHistory(cfg: PointsConfig, completions: Completion[], routineCadence: Record<string, Cadence> = {}): Award[] {
  const awards: Award[] = [];
  const inWindow = (day: string) => day >= cfg.startDate;

  // 1. Tasks — one award per task; each task also feeds the task-streak item.
  const itemRows: Completion[] = [];
  for (const c of completions) {
    if (c.source === "task" && c.task) {
      if (inWindow(c.day)) {
        const { points, detail } = taskPoints(cfg.tasks, c.task);
        awards.push({ key: `task:${c.item}`, day: c.day, kind: "task", item: c.item, label: c.label, points, detail });
      }
      itemRows.push({ source: "task", item: cfg.tasks.streakItem, day: c.day, units: 1, label: "Tasks" });
    } else {
      itemRows.push(c);
    }
  }

  // 2. Group units per item per day.
  const byItem = new Map<string, { label: string; days: Map<string, number> }>();
  for (const c of itemRows) {
    if (c.units <= 0) continue;
    const g = byItem.get(c.item) ?? { label: c.label, days: new Map<string, number>() };
    g.days.set(c.day, (g.days.get(c.day) ?? 0) + c.units);
    byItem.set(c.item, g);
  }

  for (const [item, g] of [...byItem.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const def = resolveItem(cfg, item, g.label, routineCadence[item] ?? "daily");
    if (!def) continue;
    const doneAt = def.doneAt ?? 1;
    const days = [...g.days.entries()].sort(([a], [b]) => a.localeCompare(b));

    // 2a. Base points per day.
    for (const [day, units] of days) {
      const pts = itemBasePoints(def, units);
      if (pts > 0 && inWindow(day)) {
        const detail = def.unitPoints !== undefined ? `${units} × ${def.unitPoints}${def.maxUnits !== undefined && units > def.maxUnits ? ` (cap ${def.maxUnits})` : ""}` : "done";
        awards.push({ key: `item:${item}:${day}`, day, kind: "base", item, label: def.label, points: pts, detail });
      }
    }

    // 2b. Periods: daily = one per day; weekly = Monday-keyed, done when target met.
    const periods = new Map<string, PeriodState>();
    if (def.cadence === "daily") {
      for (const [day, units] of days) periods.set(day, { period: day, units, doneDay: units >= doneAt ? day : null });
    } else {
      const need = def.weeklyTarget?.count ?? doneAt;
      for (const [day, units] of days) {
        const wk = weekStart(day);
        const s = periods.get(wk) ?? { period: wk, units: 0, doneDay: null };
        s.units += units;
        if (s.doneDay === null && s.units >= need) s.doneDay = day;
        periods.set(wk, s);
      }
    }

    // 2c. Weekly target bonus.
    if (def.weeklyTarget) {
      const t = def.weeklyTarget;
      if (def.cadence === "daily") {
        const doneByWeek = new Map<string, string[]>();
        for (const s of periods.values()) {
          if (!s.doneDay) continue;
          const wk = weekStart(s.period);
          doneByWeek.set(wk, [...(doneByWeek.get(wk) ?? []), s.doneDay]);
        }
        for (const [wk, doneDays] of doneByWeek) {
          if (doneDays.length < t.count) continue;
          const day = doneDays.sort()[t.count - 1];
          if (inWindow(day)) {
            awards.push({ key: `weekly:${item}:${wk}`, day, kind: "weekly_target", item, label: def.label, points: t.bonus, detail: `${t.count} days in week of ${wk}` });
          }
        }
      } else {
        for (const s of periods.values()) {
          if (s.doneDay && inWindow(s.doneDay)) {
            awards.push({ key: `weekly:${item}:${s.period}`, day: s.doneDay, kind: "weekly_target", item, label: def.label, points: t.bonus, detail: `${t.count}/week in week of ${s.period}` });
          }
        }
      }
    }

    // 2d. Streak bonuses.
    if (!def.bonuses.length) continue;
    const doneDayByPeriod = new Map<string, string>();
    for (const s of periods.values()) if (s.doneDay) doneDayByPeriod.set(s.period, s.doneDay);
    const unit = def.cadence === "daily" ? "d" : "w";
    for (const ev of walkStreak(cfg.streaks, def.cadence, [...doneDayByPeriod.keys()])) {
      const day = doneDayByPeriod.get(ev.period) ?? ev.period;
      if (!inWindow(day)) continue;
      if (def.bonuses.includes("continuation")) {
        const bonus = continuationBonus(cfg.streaks, ev.streak);
        if (bonus > 0) {
          awards.push({ key: `streak:${item}:${ev.period}`, day, kind: "continuation", item, label: def.label, points: bonus, detail: `${ev.streak}${unit} streak` });
        }
        const milestone = cfg.streaks.continuation.milestones[String(ev.streak)];
        if (milestone) {
          awards.push({ key: `milestone:${item}:${ev.period}`, day, kind: "milestone", item, label: def.label, points: milestone, detail: `${ev.streak}${unit} milestone` });
        }
      }
      if (def.bonuses.includes("recovery") && ev.recoveredFrom !== null) {
        awards.push({ key: `recovery:${item}:${ev.period}`, day, kind: "recovery", item, label: def.label, points: cfg.streaks.recovery.bonus, detail: `restarted after a ${ev.recoveredFrom}${unit} streak broke` });
      }
    }
  }

  return awards.sort((a, b) => a.day.localeCompare(b.day) || a.key.localeCompare(b.key));
}

/**
 * PURE: what to append so the ledger pays exactly what history owes per key.
 * Never negative — already-paid points are never clawed back.
 */
export function ledgerDelta(awards: Award[], ledger: Array<Pick<PointsLedgerEntry, "key" | "points">>, at: string): PointsLedgerEntry[] {
  const paid = new Map<string, number>();
  for (const e of ledger) paid.set(e.key, (paid.get(e.key) ?? 0) + e.points);
  const out: PointsLedgerEntry[] = [];
  for (const a of awards) {
    const already = paid.get(a.key) ?? 0;
    if (a.points > already) {
      out.push(already > 0 ? { ...a, points: a.points - already, at, topUp: true } : { ...a, at });
    }
  }
  return out;
}

/** PURE: current streak per item as of `today` (broken streaks show recoverable). */
export function currentStreaks(cfg: PointsConfig, completions: Completion[], today: string, routineCadence: Record<string, Cadence> = {}): ItemStreak[] {
  const doneDays = new Map<string, { label: string; days: Map<string, number> }>();
  for (const c of completions) {
    const item = c.source === "task" ? cfg.tasks.streakItem : c.item;
    const label = c.source === "task" ? "Tasks" : c.label;
    if (c.units <= 0 && c.source !== "task") continue;
    const g = doneDays.get(item) ?? { label, days: new Map<string, number>() };
    g.days.set(c.day, (g.days.get(c.day) ?? 0) + (c.source === "task" ? 1 : c.units));
    doneDays.set(item, g);
  }
  const out: ItemStreak[] = [];
  for (const [item, g] of doneDays) {
    const def = resolveItem(cfg, item, g.label, routineCadence[item] ?? "daily");
    if (!def) continue;
    const need = def.cadence === "weekly" ? def.weeklyTarget?.count ?? def.doneAt ?? 1 : def.doneAt ?? 1;
    const totals = new Map<string, number>();
    for (const [day, units] of g.days) {
      const p = def.cadence === "daily" ? day : weekStart(day);
      totals.set(p, (totals.get(p) ?? 0) + units);
    }
    const done = [...totals.entries()].filter(([, u]) => u >= need).map(([p]) => p).sort();
    const events = walkStreak(cfg.streaks, def.cadence, done);
    const last = events[events.length - 1];
    if (!last) continue;
    const nowPeriod = def.cadence === "daily" ? today : weekStart(today);
    const gap = periodsBetween(def.cadence, last.period, nowPeriod);
    // Alive if done this period, or last period (still time to extend today/this week).
    const alive = gap <= 1;
    const missed = gap - 1;
    const recoverable = !alive && last.streak >= cfg.streaks.recovery.minPriorStreak && missed <= cfg.streaks.recovery.maxMissedPeriods[def.cadence]
      ? last.streak : null;
    out.push({ item, label: def.label, cadence: def.cadence, current: alive ? last.streak : 0, lastDone: last.period, recoverable });
  }
  return out.sort((a, b) => b.current - a.current || a.label.localeCompare(b.label));
}

/** PURE: sum ledger points inside the period containing `today`. */
export function periodScore(ledger: Array<Pick<PointsLedgerEntry, "day" | "points">>, period: GoalPeriod, today: string): number {
  const start = periodStart(today, period);
  return ledger.filter((e) => e.day >= start && e.day <= today).reduce((s, e) => s + e.points, 0);
}

/** PURE: goal progress incl. on-pace check (pro-rata through the period). */
export function goalProgress(goal: PointsGoal, score: number, today: string): {
  pct: number; remaining: number; expectedByNow: number; onPace: boolean; periodDays: number; dayOfPeriod: number;
} {
  const start = periodStart(today, goal.period);
  let periodDays = 1;
  if (goal.period === "week") periodDays = 7;
  if (goal.period === "month") {
    const [y, m] = today.split("-").map(Number);
    periodDays = new Date(Date.UTC(y ?? 1970, m ?? 1, 0)).getUTCDate();
  }
  const dayOfPeriod = daysBetween(start, today) + 1;
  const expectedByNow = Math.round((goal.target * dayOfPeriod) / periodDays);
  return {
    pct: goal.target > 0 ? Math.round((score / goal.target) * 100) : 0,
    remaining: Math.max(0, goal.target - score),
    expectedByNow,
    onPace: score >= expectedByNow,
    periodDays,
    dayOfPeriod,
  };
}

// ----------------------------------------------------------------------------
// Routine catalogue (Daily / Weekly Behaviors tables)
// ----------------------------------------------------------------------------

/**
 * Parse the routine rows out of a Behaviors note. Reads the markdown tables
 * under every "##" section except "Not yet active" / "Monthly & beyond", and
 * takes the activity column (Activity / Block / Item).
 */
export function parseBehaviors(markdown: string): string[] {
  const names: string[] = [];
  let skip = false;
  let col = -1;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      skip = /not yet active|monthly/i.test(line);
      col = -1;
      continue;
    }
    if (skip || !line.startsWith("|")) {
      if (!line.startsWith("|")) col = -1;
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (col === -1) {
      col = cells.findIndex((c) => /^(activity|block|item)$/i.test(c));
      if (col === -1) col = -2; // table without a name column
      continue;
    }
    if (col < 0) continue;
    const name = cells[col];
    if (name) names.push(name);
  }
  return names;
}

/** Build the routine catalogue: configured items with routine aliases + parsed rows. */
export function routineCatalogue(cfg: PointsConfig, daily: string[], weekly: string[]): Map<string, RoutineEntry> {
  const out = new Map<string, RoutineEntry>();
  const aliasToItem = new Map<string, string>();
  for (const [id, def] of Object.entries(cfg.items)) {
    for (const r of def.routines ?? []) aliasToItem.set(r.toLowerCase(), id);
    if (def.routines?.length) out.set(id, { item: id, label: def.label, cadence: def.cadence });
  }
  const ignored = new Set(cfg.routineIgnore.map((r) => r.toLowerCase()));
  const add = (name: string, cadence: Cadence) => {
    if (aliasToItem.has(name.toLowerCase()) || ignored.has(name.toLowerCase())) return;
    const id = `routine:${slugify(name)}`;
    if (!out.has(id)) out.set(id, { item: id, label: name, cadence });
  };
  daily.forEach((n) => add(n, "daily"));
  weekly.forEach((n) => add(n, "weekly"));
  return out;
}

/** Resolve a user-typed routine name → catalogue entry (exact slug/label, then unique substring). */
export function resolveRoutine(catalogue: Map<string, RoutineEntry>, cfg: PointsConfig, query: string): RoutineEntry | { error: string } {
  const q = query.toLowerCase().trim();
  const qs = slugify(query);
  const entries = [...catalogue.values()];
  const aliasesOf = (e: RoutineEntry) => [e.label, ...(cfg.items[e.item]?.routines ?? [])].map((s) => s.toLowerCase());
  const exact = entries.find((e) => e.item === q || e.item === `routine:${qs}` || e.item === qs || aliasesOf(e).includes(q));
  if (exact) return exact;
  const partial = entries.filter((e) => aliasesOf(e).some((a) => a.includes(q)) || e.item.includes(qs));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) return { error: `"${query}" is ambiguous: ${partial.map((e) => e.label).join(" · ")}` };
  return { error: `No routine matches "${query}". See: points routines` };
}

export function loadRoutineCatalogue(cfg: PointsConfig, dailyPath = DAILY_BEHAVIORS_PATH, weeklyPath = WEEKLY_BEHAVIORS_PATH): Map<string, RoutineEntry> {
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  return routineCatalogue(cfg, parseBehaviors(read(dailyPath)), parseBehaviors(read(weeklyPath)));
}

// ----------------------------------------------------------------------------
// Source readers (READ-ONLY)
// ----------------------------------------------------------------------------

interface TaskRow {
  id: string;
  title: string;
  priority: number | null;
  estimated_minutes: number | null;
  goal_id: string | null;
  disposition: string | null;
  completed_at: string;
}

export function readTaskCompletions(cfg: PointsConfig, dbPath: string): Completion[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT id, title, priority, estimated_minutes, goal_id, disposition, completed_at FROM tasks WHERE status = 'done' AND completed_at IS NOT NULL")
      .all() as TaskRow[];
    const excluded = new Set(cfg.tasks.excludeDispositions);
    return rows
      .filter((r) => !(r.disposition && excluded.has(r.disposition)))
      .map((r) => ({
        source: "task" as const,
        item: r.id,
        day: localDayOf(new Date(r.completed_at)),
        units: 1,
        label: r.title,
        task: { priority: r.priority ?? 2, estimatedMinutes: r.estimated_minutes, goalLinked: Boolean(r.goal_id) },
      }));
  } finally {
    db.close();
  }
}

export interface HabitRow { date: string; habit: string; value: string }

/** PURE: habit_log rows → completions for configured items. */
export function habitCompletions(cfg: PointsConfig, rows: HabitRow[], canonical: (raw: string) => string | null = (s) => s): Completion[] {
  const habitToItem = new Map<string, string>();
  for (const [id, def] of Object.entries(cfg.items)) for (const h of def.habits ?? []) habitToItem.set(h, id);
  const out: Completion[] = [];
  for (const r of rows) {
    const value = Number(r.value ?? "0");
    if (!Number.isFinite(value) || value <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(r.date ?? "")) continue;
    const slug = canonical(r.habit ?? "") ?? r.habit;
    const item = habitToItem.get(slug);
    if (!item) continue;
    const def = cfg.items[item];
    // Toggles count once per row; counters carry their value.
    const units = def?.unitPoints !== undefined ? value : 1;
    out.push({ source: "habit", item, day: r.date, units, label: def?.label ?? slug });
  }
  return out;
}

export function readHabitRows(dbPath: string): HabitRow[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT date, habit, value FROM habit_log").all() as HabitRow[];
  } finally {
    db.close();
  }
}

/** PURE: dedupe habit toggles to one unit per (item, day) so double-logs don't double-pay. */
export function dedupeToggles(cfg: PointsConfig, completions: Completion[]): Completion[] {
  const seen = new Set<string>();
  const out: Completion[] = [];
  for (const c of completions) {
    if (c.source === "task") { out.push(c); continue; }
    const def = cfg.items[c.item];
    const isCounter = def?.unitPoints !== undefined;
    if (isCounter) { out.push(c); continue; }
    const k = `${c.item}|${c.day}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...c, units: 1 });
  }
  return out;
}

export interface RoutineCheck { at: string; day: string; item: string; label: string; cadence: Cadence }

export function readRoutineChecks(): RoutineCheck[] {
  return readJsonl<RoutineCheck>(pointsPaths().routines);
}

export function appendRoutineCheck(check: RoutineCheck): void {
  routineCheckLog.append(check);
}

export function routineCompletions(checks: RoutineCheck[]): Completion[] {
  return checks.map((c) => ({ source: "routine" as const, item: c.item, day: c.day, units: 1, label: c.label }));
}

// ----------------------------------------------------------------------------
// Ledger + goal IO
// ----------------------------------------------------------------------------

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

export function readPointsLedger(): PointsLedgerEntry[] {
  return readJsonl<PointsLedgerEntry>(pointsPaths().ledger);
}

export function loadGoal(): PointsGoal | null {
  const { goal } = pointsPaths();
  if (!existsSync(goal)) return null;
  try {
    const g = JSON.parse(readFileSync(goal, "utf8")) as Partial<PointsGoal>;
    return typeof g.target === "number" && g.target > 0 && (g.period === "day" || g.period === "week" || g.period === "month")
      ? { target: g.target, period: g.period, setAt: g.setAt ?? "" }
      : null;
  } catch {
    return null;
  }
}

export function saveGoal(goal: PointsGoal | null): void {
  const { dir, goal: path } = pointsPaths();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(goal ?? {}, null, 2));
}

// ----------------------------------------------------------------------------
// Sync (IO wrapper around the pure core)
// ----------------------------------------------------------------------------

export interface SourcePaths { tasksDb: string; lifeosDb: string; dailyBehaviors: string; weeklyBehaviors: string }

export function defaultSourcePaths(): SourcePaths {
  const home = getKayaHome();
  return {
    tasksDb: join(home, "skills/Productivity/LucidTasks/Data/lucidtasks.db"),
    lifeosDb: join(home, "skills/Productivity/LifeOS/Data/lifeos.db"),
    dailyBehaviors: DAILY_BEHAVIORS_PATH,
    weeklyBehaviors: WEEKLY_BEHAVIORS_PATH,
  };
}

/** Gather every completion from all three sources. */
export async function gatherCompletions(cfg: PointsConfig, paths: SourcePaths = defaultSourcePaths()): Promise<{
  completions: Completion[]; routineCadence: Record<string, Cadence>; warnings: string[];
}> {
  const warnings: string[] = [];
  let canonical: (raw: string) => string | null = (s) => s;
  try {
    // cross-skill-allowed: habit alias folding must match LifeOS's canonicalSlug exactly; lazy, read-only, falls back to raw slugs
    const hc = await import("../../../Productivity/LifeOS/Aggregation/HabitConsistency.ts");
    canonical = hc.canonicalSlug;
  } catch {
    warnings.push("habit alias folding unavailable (HabitConsistency import failed) — raw slugs used");
  }
  const safe = <T>(label: string, fn: () => T[]): T[] => {
    try {
      return fn();
    } catch (e) {
      warnings.push(`${label} unreadable: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  };
  const tasks = safe("LucidTasks", () => readTaskCompletions(cfg, paths.tasksDb));
  const habits = safe("habit_log", () => habitCompletions(cfg, readHabitRows(paths.lifeosDb), canonical));
  const checks = safe("routine checks", () => readRoutineChecks());
  const routineCadence: Record<string, Cadence> = {};
  for (const c of checks) routineCadence[c.item] = c.cadence;
  const completions = dedupeToggles(cfg, [...tasks, ...habits, ...routineCompletions(checks)]);
  return { completions, routineCadence, warnings };
}

/** Score the full history and append whatever the ledger doesn't have yet. */
export async function syncLedger(cfg: PointsConfig, now: Date = new Date(), paths?: SourcePaths, dryRun = false): Promise<{
  appended: PointsLedgerEntry[]; ledger: PointsLedgerEntry[]; completions: Completion[]; routineCadence: Record<string, Cadence>; warnings: string[];
}> {
  const { completions, routineCadence, warnings } = await gatherCompletions(cfg, paths);
  const today = localDayOf(now);
  // Never pay for future-dated rows (habit form lets you pick any date).
  const awards = scoreHistory(cfg, completions, routineCadence).filter((a) => a.day <= today);
  const existing = readPointsLedger();
  const appended = ledgerDelta(awards, existing, now.toISOString());
  if (!dryRun) for (const e of appended) pointsLedgerLog.append(e);
  return { appended, ledger: [...existing, ...appended], completions, routineCadence, warnings };
}
