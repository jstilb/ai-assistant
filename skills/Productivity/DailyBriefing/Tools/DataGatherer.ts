#!/usr/bin/env bun
/**
 * DataGatherer.ts - Parallel data fetch layer for Daily Briefing
 *
 * Gathers ALL briefing data sources in parallel and returns structured JSON.
 * No markdown generation. No LLM calls. No interpretation. Just raw data.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { logFailure } from "../../../../lib/core/FailureLog.ts";
// cross-skill-allowed: DailyBriefing is the cross-system aggregator by design — reads LucidTasks' TaskDB read-only to gather the tasks section
import { getTaskDB } from "../../LucidTasks/Tools/TaskDB.ts";
import { execute as executeCalendar } from "./CalendarBlock.ts";
import { execute as executeGoals } from "./GoalsBlock.ts";
// cross-skill-allowed: DailyBriefing is the cross-system aggregator by design — reads LifeOS's habit log read-only to compute the habit-consistency figures in the goals section, and skill_mastery_active read-only to populate the learning section
import { habitConsistency, query as lifeOSQuery } from "../../LifeOS/StorageIO/LifeOSQuery.ts";
// Side-effect pre-import: habitConsistency() lazily imports HabitConsistency.ts
// at gather time, concurrently with gatherStrategies' lazy WigSection import —
// the two graphs share LeadDeriver, and racing their first evaluation under
// Promise.all reproduces the `Cannot access 'TRACKED_HABITS' before
// initialization` TDZ (commit 0dbcf1cf2's crash class, concurrency variant).
// Evaluating HabitConsistency here, at ordered module-load time, means every
// call-time import hits a fully-initialized cache instead of racing.
// cross-skill-allowed: DailyBriefing is the cross-system aggregator by design — side-effect pre-import only, to serialize first evaluation of a module habitConsistency() (imported above) lazily loads at gather time anyway
import "../../LifeOS/Aggregation/HabitConsistency.ts";
// NOTE: WigSection.ts / CommunityStatus.ts (the strategy compute helpers) are
// deliberately NOT statically imported — see gatherStrategies. They transitively
// pull LeadDeriver <-> HabitConsistency, and adding static edges into that cycle
// from this file changed module evaluation order enough to leave TRACKED_HABITS
// in TDZ when gatherHabits ran (the exact crash class GatherFailure's doc
// comment records).
// cross-skill-allowed: Mastery Map checkbox grammar is owned by LifeOS/Learning; briefing only renders "n/M nodes" from it (same seam ReviewPopulator uses)
import { computeProgress, parseCheckboxTree } from "../../LifeOS/Learning/MasteryMapCheckboxes.ts";
import { learningDeckFor, trackMechanic } from "../../LifeOS/Aggregation/SkillMastery.ts"; // cross-skill-allowed: gatherLearning must resolve a target's REAL Anki deck (e.g. Cooking's hand-built deck) the same way the LifeOS sweep does — a local Learning::<skill> template is the exact deck-mismatch bug the 08-23 review found
// cross-skill-allowed: DailyBriefing is the cross-system aggregator by design — reads Anki's live due/new card counts read-only for the learning section (apy needs Anki closed; the call fails soft when it's open)
import { AnkiClient } from "../../../Life/Anki/Tools/AnkiClient.ts";
// cross-skill-allowed: DailyBriefing is the cross-system aggregator by design — reads ContentAggregator's content store read-only to populate the news block
import { searchItems } from "../../../Content/ContentAggregator/Tools/ContentStore.ts";
// Type-only import — erased at compile time, so it carries none of
// WeatherService.ts's runtime module-load side effects (see gatherWeather
// below for why the value import of fetchWeatherReport stays a per-call
// dynamic import instead of joining the static imports above).
import type { WeatherReport } from "./WeatherService.ts";
// cross-skill-allowed: DailyBriefing is the cross-system aggregator by design — reads QueueRouter's queue read-only to gather pending approvals
import { loadQueueItems } from "../../../Automation/QueueRouter/Tools/QueueManager.ts";
// cross-skill-allowed: DailyBriefing is the cross-system aggregator by design — reads QueueRouter's waiting-on-Jm summary read-only
import { getWaitingOnJm as getWaitingOnJmImpl, type WaitingOnJmSummary } from "../../../Automation/QueueRouter/Tools/WaitingOnJm.ts";
// cross-skill-allowed: DailyBriefing is the cross-system aggregator by design — reads TechDebtTracker's registry read-only to gather the tech-debt summary block
import { TechDebtRegistry } from "../../../Automation/AutoMaintenance/Tools/TechDebtRegistry.ts";
import { execute as executeAutonomousDeliverables } from "./AutonomousDeliverableBlock.ts";
import { execute as executeClaudeCodeUpdates, type ClaudeCodeUpdatesData } from "./ClaudeCodeUpdatesBlock.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

// All 10 gatherer dependencies above are static, top-of-file imports rather than
// the per-call lazy dynamic imports they used to be. Repro (H1, 2026-07-03): under
// a cold module cache, running the real gatherBriefingData() Promise.all loop in
// 30 fresh `bun` processes threw `ReferenceError: Cannot access '_instance' before
// initialization` (TaskDB.ts's singleton binding) in 3/30 runs — gatherTasks,
// gatherWaitingOnJm (which statically imports WaitingOnJm.ts -> TaskDB.ts), and
// gatherAutonomousDeliverables (which dynamically imports AutonomousDeliverableBlock.ts
// -> TaskDB.ts) all raced to independently `import()` the same TaskDB.ts module
// concurrently; the failure was soft-caught per-gatherer (see each catch block
// below) so the briefing rendered with that section silently missing. Static
// imports fold every gatherer's dependency graph into ONE synchronous ES-module
// link/evaluate pass at DataGatherer.ts's own load time, before Promise.all ever
// runs, so by the time a gatherer needs e.g. TaskDB.ts it is already a fully
// -evaluated, cached module — no concurrently-initiated loader race is possible.

const KAYA_HOME = getKayaHome(); // was KAYA_DIR-only; getKayaHome() superset
const KAYA_CLI = join(KAYA_HOME, "bin", "kaya-cli");
const TELOS_DIR = join(KAYA_HOME, "USER", "TELOS");
const WIG_STATUS_PATH = join(KAYA_HOME, "skills", "Productivity", "LifeOS", "config", "wig_status.json");

/**
 * Structural, always-true coverage limits of the data sources that feed this
 * briefing. These are NOT runtime failures — they apply on every run regardless
 * of gather success/failure. Kept here (not in the editorial layer) so they are
 * independently testable and can be serialised into BriefingData for any consumer.
 *
 * Grounded in skills/Productivity/LifeOS/Data/PROVENANCE.md.
 */
export const STANDING_COVERAGE_NOTES: string[] = [
  "Habit, goal, and strategy figures come from LifeOS logs, which record only what was captured — a missing or 0% value may mean 'not logged,' not 'not done.' Treat silence as unknown, not failure.",
  "LifeOS habit_log entries exist only when Jm verbally reported a habit via voice, Telegram, or chat. Periods without device connectivity or active capture sessions leave genuine gaps that are indistinguishable from zero-activity periods.",
];

// ============================================================================
// BriefingData Interface
// ============================================================================

export interface TechDebtSummary {
  items: Array<{ id: string; description: string; location: string; composite: number | null }>;
  /** True count of ALL open registry items — not items.length. items is the
   *  top-10 by composite score; this says how deep the full backlog goes. */
  totalOpenCount: number;
}

/**
 * A gather that THREW an exception (a real failure), as opposed to a soft
 * dataQualityWarning. Kept separate so a hard crash can't masquerade as
 * "data unavailable" — it gets logged to the central failure log and makes
 * the run exit non-zero. (The TRACKED_HABITS import-cycle crash hid for two
 * days because it only ever became a soft warning string.)
 */
export interface GatherFailure {
  source: string;
  message: string;
}

/**
 * Record a hard gather failure: structured ledger entry + durable central log.
 * Callers ALSO keep their existing warnings.push(...) so the editorial LLM still
 * narrates the gap; this adds the loud, machine-visible trail on top.
 */
export function recordFailure(failures: GatherFailure[], source: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  failures.push({ source, message });
  logFailure(`DataGatherer:${source}`, err, { source });
}

export interface BriefingData {
  meta: {
    date: string;
    dateFormatted: string;
    dayOfWeek: string;
    timezone: string;
    userName: string;
    telosStalenessDays: number | null;
    dataQualityWarnings: string[];
    gatherFailures: GatherFailure[];
    standingCoverageNotes: string[];
  };

  tasks: {
    overdue: Array<{ id: string; title: string; dueDate: string; priority: number; project?: string }>;
    dueToday: Array<{ id: string; title: string; priority: number; project?: string }>;
    nextUp: Array<{ id: string; title: string; priority: number; project?: string }>;
    totalActiveCount: number;
    /** True counts behind the capped overdue/dueToday arrays (caps: 20/20). */
    overdueTotalCount: number;
    dueTodayTotalCount: number;
  };

  calendar: {
    events: Array<{ time: string; title: string; duration?: string; location?: string }>;
    /** True count of events parsed before CalendarBlock's 25-event cap. */
    totalEventCount?: number;
    fetchError?: string;
  };

  goals: {
    wigs: Array<{ id: string; title: string; status?: string; metric?: string; current?: string; target?: string }>;
    missions: Array<{ id: string; title: string; focus: string }>;
    currentQuarter: string;
    /**
     * Set when GoalsBlock's active-quarter WIG heading regex failed to match
     * GOALS.md — wigs will be [] even though missions/other goals parsed fine.
     * Callers (renderFallbackEditorial, the editorial LLM via
     * dataQualityWarnings) render this as a visible failure instead of a
     * silently-empty goals section. See GoalsBlock.ts data.parseError.
     */
    parseError?: string;
  };

  strategies: Array<{
    id: string; name: string; current: number; target: number; gap: number;
  }>;

  habits: Array<{
    name: string;
    avg7: number;   // trailing 7-day consistency % (recent momentum)
    avg28: number;  // trailing 28-day consistency % (longer-term)
  }>;

  news: {
    articles: Array<{
      title: string; source: string; url: string; topic: string;
      body: string; publishedAt: string; score: number;
    }>;
    /** How many items the content store returned (itself bounded at 50). */
    totalFetched: number;
    /** True count of last-24h items before the 12-article cap on `articles`. */
    totalRecent: number;
  };

  weather?: {
    current: string;
    forecast: string;
    sunrise?: string;
    sunset?: string;
    forecast3Day?: Array<{ date: string; highF: number; lowF: number; condition: string; rainChancePct: number }>;
    todayHourly?: Array<{ time: string; tempF: number; condition: string; rainChancePct: number }>;
    alerts: string[];
  };

  gmail?: {
    /** Count of unread-important messages actually fetched (query capped at 25).
     *  When countIsLowerBound is true there were more pages beyond the cap. */
    totalUnreadCount: number;
    countIsLowerBound?: boolean;
    /** Display slice — at most 10 of totalUnreadCount. */
    messages: Array<{ from: string; subject: string; snippet: string }>;
  };

  approvalQueue?: {
    pendingCount: number;
    items: Array<{ id: string; title: string; age: string }>;
  };

  /**
   * D3: compact rollup of the five WaitingOnJm surfaces (needs-grilling,
   * approvals, deferred merges, needs-Jm escalations, Lane-A deliverables).
   * Counts only — full item lists live behind `waiting-on-jm` itself; this
   * just needs to be enough for the editorial LLM / fallback to say "N things
   * are waiting on you." Undefined when every surface is at zero.
   */
  waitingOnJm?: {
    needsGrillingCount: number;
    needsGrillingOldestAgeDays: number;
    approvalsPendingCount: number;
    pendingApprovalMergesCount: number;
    needsJmEscalationsCount: number;
    laneAWaitingCount: number;
  };

  feedback?: {
    recentUsefulRate: number;
    lastFeedback: string | null;
  };

  techDebt?: TechDebtSummary;

  autonomousDeliverables?: {
    pendingCount: number;
    items: Array<{ taskId: string; title: string; noteLink: string }>;
  };

  /**
   * Filtered Claude Code / dev-tooling updates worth Jm's attention. Undefined
   * when there were no new releases or nothing rose above "minor" churn. The
   * block owns the fetch + persistent developments-log dedup + significance
   * tiering; this just carries the pre-filtered result to the editorial layer.
   * See ClaudeCodeUpdatesBlock.ts.
   */
  claudeCodeUpdates?: ClaudeCodeUpdatesData;

  /**
   * T4 Learning Loop targets (skill_mastery_active rows with a non-empty
   * phase — the live targets, e.g. Piano/Information Ecosystems; dormant
   * rows never appear here). Undefined when there are no live targets, OR
   * when none of them have anything notable this morning (no Anki cards
   * due/new and nothing due to practice) — see gatherLearning below.
   */
  learning?: {
    targets: Array<{
      name: string;
      track: string;
      /** Plain-language line: what a "review" IS for this track (knowledge =
       *  answer the cards; skill = do the rep again at the weak point; hybrid
       *  = both). From SkillMastery.trackMechanic — render it next to the
       *  target so the briefing never tells Jm to "review" a skill by recalling it. */
      reviewMeans: string;
      /** Anki due/new counts. Every registered target has a deck now
       *  (curriculum decks hold L1 recall cards for skills too), so this is
       *  fetched for all tracks; skill decks are the smaller part of the review. */
      cardsDue?: number;
      cardsNew?: number;
      /** True when the Anki reviewDue call failed (e.g. Anki open at 06:00) —
       *  fail-soft: never blocks the rest of this target or the briefing. */
      cardsUnavailable?: boolean;
      /** review_due <= today (string compare, both YYYY-MM-DD). */
      dueToPractice?: boolean;
      lastPractice?: string;
      nextAction?: string;
      /** "n/M nodes" from the Mastery Map's checkbox leaves — read live at
       *  gather time so a same-day Obsidian tick shows up; omitted when the
       *  map is missing/unparseable (fail-soft). */
      mapProgress?: string;
    }>;
  };
}

// ============================================================================
// Helpers
// ============================================================================

async function runKayaCli(args: string[], timeoutMs = 15000): Promise<string> {
  const proc = Bun.spawn([KAYA_CLI, ...args], { stdout: "pipe", stderr: "pipe" });

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`kaya-cli ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const [stdout, , exitCode] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      timeout,
    ]) as [string, string, number];

    clearTimeout(timer!);

    if (exitCode !== 0) throw new Error(`kaya-cli exit ${exitCode}`);
    return stdout.trim();
  } catch (err) {
    clearTimeout(timer!);
    throw err;
  }
}

function formatAge(created: string): string {
  const diffMs = Date.now() - new Date(created).getTime();
  const days = Math.floor(diffMs / 86400000);
  const hours = Math.floor(diffMs / 3600000);
  const mins = Math.floor(diffMs / 60000);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}

// ============================================================================
// Gatherers
// ============================================================================

async function gatherTasks(warnings: string[], failures: GatherFailure[]): Promise<BriefingData["tasks"]> {
  try {
    const db = getTaskDB();
    const today = new Date().toISOString().split("T")[0];

    const overdueTasks = db.getOverdueTasks();

    const allActive = db.listTasks({ status: ["inbox", "next", "in_progress", "waiting"] });
    const dueTodayTasks = allActive.filter((t) => t.due_date === today);
    const dueTodayIds = new Set(dueTodayTasks.map((t) => t.id));

    const nextTasks = db
      .listTasks({ status: ["next", "in_progress"], limit: 20 })
      .filter((t) => !dueTodayIds.has(t.id))
      .slice(0, 10);

    return {
      overdue: overdueTasks.slice(0, 20).map((t) => ({
        id: t.id,
        title: t.title,
        dueDate: t.due_date ?? "",
        priority: t.priority,
        project: t.project_id ?? undefined,
      })),
      dueToday: dueTodayTasks.slice(0, 20).map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        project: t.project_id ?? undefined,
      })),
      nextUp: nextTasks.map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        project: t.project_id ?? undefined,
      })),
      totalActiveCount: allActive.length,
      overdueTotalCount: overdueTasks.length,
      dueTodayTotalCount: dueTodayTasks.length,
    };
  } catch (err) {
    warnings.push(`tasks: ${err instanceof Error ? err.message : String(err)}`);
    recordFailure(failures, "tasks", err);
    return { overdue: [], dueToday: [], nextUp: [], totalActiveCount: 0, overdueTotalCount: 0, dueTodayTotalCount: 0 };
  }
}

async function gatherCalendar(warnings: string[], failures: GatherFailure[]): Promise<BriefingData["calendar"]> {
  try {
    const result = await executeCalendar({});

    if (!result.success) {
      const errMsg = result.error ?? "calendar unavailable";
      warnings.push(`calendar: ${errMsg}`);
      recordFailure(failures, "calendar", errMsg);
      return { events: [], fetchError: errMsg };
    }

    const blockData = result.data as {
      events?: BriefingData["calendar"]["events"];
      totalParsed?: number;
    };
    const events = blockData.events ?? [];
    return { events, totalEventCount: blockData.totalParsed ?? events.length };
  } catch (err) {
    warnings.push(`calendar: ${err instanceof Error ? err.message : String(err)}`);
    recordFailure(failures, "calendar", err);
    return { events: [], fetchError: String(err) };
  }
}

async function gatherGoals(warnings: string[], failures: GatherFailure[]): Promise<BriefingData["goals"]> {
  const quarter = `Q${Math.ceil((new Date().getMonth() + 1) / 3)} ${new Date().getFullYear()}`;
  try {
    const result = await executeGoals({
      maxGoals: 100,
      maxMissions: 100,
    });

    if (!result.success) {
      const errMsg = result.error ?? "unavailable";
      warnings.push(`goals: ${errMsg}`);
      recordFailure(failures, "goals", errMsg);
      return { wigs: [], missions: [], currentQuarter: quarter };
    }

    const blockData = result.data as {
      wigs?: Array<{
        id: string;
        title: string;
        status?: string;
        metric?: string;
        current?: string;
        target?: string;
      }>;
      missions?: Array<{ id: string; title: string; focus?: string }>;
      parseError?: string | null;
      unavailableLiveMetrics?: string[];
    };

    // Live-metric substitutions (G37 media, G38 cadence) that fell back to
    // narrative GOALS.md values must be visible, not silent — a stale
    // narrative number presented as current is a lie by omission. Soft
    // warning only (the value shown is still real, just possibly stale).
    for (const m of blockData.unavailableLiveMetrics ?? []) {
      warnings.push(`goals: ${m}`);
    }

    // GoalsBlock signals a soft-but-loud degradation (the active-quarter WIG
    // heading regex didn't match GOALS.md) via data.parseError while still
    // returning success:true — missions/allGoals parsed fine, only the WIG
    // derivation failed. Surface it the same way a hard failure is surfaced
    // (dataQualityWarnings + the central failure log) so the LLM editorial
    // path and renderFallbackEditorial both render it, instead of silently
    // shipping an empty-but-"successful" goals section (2026-05-19 incident,
    // commit 4f7a2da80).
    if (blockData.parseError) {
      warnings.push(`goals: ${blockData.parseError}`);
      recordFailure(failures, "goals", blockData.parseError);
    }

    return {
      wigs: (blockData.wigs ?? []).map((w) => ({
        id: w.id,
        title: w.title,
        status: w.status,
        metric: w.metric,
        current: w.current,
        target: w.target,
      })),
      missions: (blockData.missions ?? []).map((m) => ({
        id: m.id,
        title: m.title,
        focus: m.focus ?? "",
      })),
      currentQuarter: quarter,
      ...(blockData.parseError ? { parseError: blockData.parseError } : {}),
    };
  } catch (err) {
    warnings.push(`goals: ${err instanceof Error ? err.message : String(err)}`);
    recordFailure(failures, "goals", err);
    return { wigs: [], missions: [], currentQuarter: quarter };
  }
}

// ----------------------------------------------------------------------------
// Strategies (live S13-S18, replacing the frozen Q1 sheet — f890e8b5)
// ----------------------------------------------------------------------------
//
// wig_status.json's habit_log/lead_log row shapes, kept local (not imported)
// because WigSection.ts doesn't export them — computeReps/computeBinaryShowUp/
// computeWeeklyEventCount are structurally typed, so a local shape that matches
// is enough to call them without WigSection.ts exporting a new symbol.
interface StrategyHabitRow { date: string; habit: string; value: string; notes: string }
interface StrategyLeadRow { date: string; wig_id: string; count: string }

/** A wig_status.json G*'s `leads[]`/`lead` entry. Fields are `unknown` on
 *  purpose — every field is re-validated with typeof before use, same defensive
 *  posture as the rest of this file's `result.data as {...}` casts. Which of
 *  the three target fields is PRESENT (not the optional `type` string, which
 *  S13 omits entirely) selects the compute helper — mirrors exactly how
 *  WigSection.renderWigSection dispatches G42.leads/G43.lead/G44.lead. */
interface WigLead {
  id?: unknown;
  name?: unknown;
  capture_habit?: unknown;
  target_reps_per_day?: unknown;
  target_days_per_week?: unknown;
  target_distinct_events_per_week?: unknown;
}

function strategiesRowStr(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function defaultReadWigStatus(): unknown {
  return JSON.parse(readFileSync(WIG_STATUS_PATH, "utf-8"));
}

function defaultQueryHabitRows(): StrategyHabitRow[] {
  const { rows, error } = lifeOSQuery("SELECT date, habit, value, notes FROM habit_log");
  if (error) throw new Error(error);
  return rows.map((r) => ({
    date: strategiesRowStr(r.date), habit: strategiesRowStr(r.habit),
    value: strategiesRowStr(r.value), notes: strategiesRowStr(r.notes),
  }));
}

function defaultQueryLeadRows(): StrategyLeadRow[] {
  const { rows, error } = lifeOSQuery("SELECT date, wig_id, count FROM lead_log");
  if (error) throw new Error(error);
  return rows.map((r) => ({
    date: strategiesRowStr(r.date), wig_id: strategiesRowStr(r.wig_id), count: strategiesRowStr(r.count),
  }));
}

function pctOfTarget(rawCurrent: number, rawTarget: number): number {
  return Math.round((rawCurrent / rawTarget) * 1000) / 10;
}

/** Dispatches on which target field the lead carries, computes the raw
 *  current value via the same WigSection helper the dashboard uses, then
 *  normalizes to percent-of-target (target=100) so GenerateBriefing.md's gap
 *  thresholds (≤ -70/-40/-20) keep working unchanged. Raw units are embedded
 *  in `name` so the number isn't lost to the normalization. Returns null (and
 *  warns) for a lead with no id/name or no recognized target field — that
 *  lead is skipped, not fatal to the rest of the strategies gather. */
interface StrategyComputeHelpers {
  computeReps: (rows: StrategyHabitRow[], habit: string) => { last7Avg: number };
  computeBinaryShowUp: (rows: StrategyHabitRow[], def: { habit: string }) => { daysWithShowUp7d: number };
  computeWeeklyEventCount: (rows: StrategyLeadRow[], goalId: string) => number;
}

function computeStrategyFromLead(
  lead: WigLead,
  goalId: string,
  habitRows: StrategyHabitRow[],
  leadRows: StrategyLeadRow[],
  warnings: string[],
  helpers: StrategyComputeHelpers,
): BriefingData["strategies"][number] | null {
  const id = typeof lead.id === "string" ? lead.id : "";
  const name = typeof lead.name === "string" ? lead.name : "";
  const captureHabit = typeof lead.capture_habit === "string" ? lead.capture_habit : "";
  if (!id || !name) {
    warnings.push(`strategies: ${goalId} has a lead with no id/name — skipped`);
    return null;
  }

  const target = 100;

  if (typeof lead.target_reps_per_day === "number" && lead.target_reps_per_day > 0) {
    const rawTarget = lead.target_reps_per_day;
    const { last7Avg } = helpers.computeReps(habitRows, captureHabit);
    const current = pctOfTarget(last7Avg, rawTarget);
    return {
      id, target, current, gap: Math.round((current - target) * 10) / 10,
      name: `${name} (${last7Avg.toFixed(1)}/day vs target ${rawTarget}/day)`,
    };
  }

  if (typeof lead.target_days_per_week === "number" && lead.target_days_per_week > 0) {
    const rawTarget = lead.target_days_per_week;
    const { daysWithShowUp7d } = helpers.computeBinaryShowUp(habitRows, { habit: captureHabit });
    const current = pctOfTarget(daysWithShowUp7d, rawTarget);
    return {
      id, target, current, gap: Math.round((current - target) * 10) / 10,
      name: `${name} (${daysWithShowUp7d}/7 days this week vs target ${rawTarget}/wk)`,
    };
  }

  if (typeof lead.target_distinct_events_per_week === "number" && lead.target_distinct_events_per_week > 0) {
    const rawTarget = lead.target_distinct_events_per_week;
    const last7Count = helpers.computeWeeklyEventCount(leadRows, goalId);
    const current = pctOfTarget(last7Count, rawTarget);
    return {
      id, target, current, gap: Math.round((current - target) * 10) / 10,
      name: `${name} (${last7Count} of ${rawTarget} events this week)`,
    };
  }

  warnings.push(`strategies: ${goalId} lead "${id}" has no recognized target field — skipped`);
  return null;
}

/**
 * Live S13-S18 strategy progress, replacing the frozen Q1 Google Sheet read
 * (tech-debt f890e8b5 — LifeOS blocks writes to that sheet, so the briefing
 * showed the same six Q1 percentages for 9+ days). Goals and their leads are
 * discovered by SHAPE from wig_status.json (any top-level "G<n>" entry
 * carrying a `leads[]` array or a single `lead` object), never a hardcoded
 * G-list or S-list — a quarterly rollover needs no code change here, same
 * doctrine as WigTargets.ts/GoalsBlock.ts's media/community discovery.
 *
 * Per-lead compute reuses WigSection.ts's exported pure helpers
 * (computeReps/computeBinaryShowUp) and CommunityStatus.ts's
 * computeWeeklyEventCount — the exact functions the LifeOS dashboard wires
 * wig_status.json leads through, so the dashboard and this briefing section
 * cannot diverge on the underlying math (only the percent-of-target
 * normalization on top is briefing-specific).
 */
export async function gatherStrategies(
  warnings: string[],
  failures: GatherFailure[],
  deps: {
    readWigStatus?: () => unknown;
    queryHabitRows?: () => StrategyHabitRow[];
    queryLeadRows?: () => StrategyLeadRow[];
  } = {}
): Promise<BriefingData["strategies"]> {
  try {
    const readWigStatus = deps.readWigStatus ?? defaultReadWigStatus;
    const queryHabitRows = deps.queryHabitRows ?? defaultQueryHabitRows;
    const queryLeadRows = deps.queryLeadRows ?? defaultQueryLeadRows;

    const wigStatus = readWigStatus();
    if (typeof wigStatus !== "object" || wigStatus === null || Array.isArray(wigStatus)) {
      throw new Error("wig_status.json did not parse to an object");
    }

    // Imported per-call, NOT statically: these modules transitively pull the
    // LeadDeriver <-> HabitConsistency import cycle (TRACKED_HABITS); a static
    // import from this file reordered module evaluation and left TRACKED_HABITS
    // in TDZ when gatherHabits ran. Same pattern as gatherWeather's dynamic
    // fetchWeatherReport import.
    const [wigSection, communityStatus] = await Promise.all([
      // cross-skill-allowed: DailyBriefing is the cross-system aggregator by design — reads LifeOS's PURE WIG lead-compute helpers read-only (rows in, numbers out), the exact functions the LifeOS dashboard wires wig_status.json leads through, so the two surfaces cannot diverge
      import("../../LifeOS/Dashboards/WigSection.ts"),
      // cross-skill-allowed: DailyBriefing is the cross-system aggregator by design — reads LifeOS's S17 weekly-event-count helper read-only, the exact function WigSection's unexported computeS17 wraps
      import("../../LifeOS/Aggregation/CommunityStatus.ts"),
    ]);
    const helpers: StrategyComputeHelpers = {
      computeReps: wigSection.computeReps,
      computeBinaryShowUp: wigSection.computeBinaryShowUp,
      computeWeeklyEventCount: communityStatus.computeWeeklyEventCount,
    };

    const habitRows = queryHabitRows();
    const leadRows = queryLeadRows();

    const strategies: BriefingData["strategies"] = [];
    for (const [goalId, goal] of Object.entries(wigStatus as Record<string, unknown>)) {
      if (!/^G\d+$/.test(goalId) || typeof goal !== "object" || goal === null) continue;
      const g = goal as Record<string, unknown>;

      const leadsToProcess: WigLead[] = Array.isArray(g.leads)
        ? g.leads.filter((l): l is WigLead => typeof l === "object" && l !== null)
        : (typeof g.lead === "object" && g.lead !== null ? [g.lead as WigLead] : []);

      for (const lead of leadsToProcess) {
        const strategy = computeStrategyFromLead(lead, goalId, habitRows, leadRows, warnings, helpers);
        if (strategy) strategies.push(strategy);
      }
    }

    return strategies;
  } catch (err) {
    warnings.push(`strategies: ${err instanceof Error ? err.message : String(err)}`);
    recordFailure(failures, "strategies", err);
    return [];
  }
}

async function gatherHabits(warnings: string[], failures: GatherFailure[]): Promise<BriefingData["habits"]> {
  try {
    // Source of truth is the LifeOS habit_log (Telegram /habit writes), rolled up
    // by the HabitConsistency aggregator over two windows: trailing 7-day (recent
    // momentum) and trailing 28-day (longer-term consistency) so the briefing can
    // show both — a recent streak isn't diluted by a sparse month, and vice versa.
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const [rows7, rows28] = await Promise.all([
      habitConsistency(7, today),
      habitConsistency(28, today),
    ]);
    const byName7 = new Map(rows7.map(r => [r.name, r]));
    // Forward raw percentages only — the editorial LLM derives momentum/health from
    // avg7 vs avg28. The green/yellow/red status thresholds (statusFor in LifeOS)
    // are a code-side judgment the briefing no longer consumes. (habitConsistency's
    // status is left intact for its other consumers: dashboard + evening check-in.)
    return rows28.map(r28 => {
      const r7 = byName7.get(r28.name);
      return {
        name: r28.name,
        avg7: r7?.rollingAvg ?? 0,
        avg28: r28.rollingAvg,
      };
    });
  } catch (err) {
    warnings.push(`habits: ${err instanceof Error ? err.message : String(err)}`);
    recordFailure(failures, "habits", err);
    return [];
  }
}

async function gatherNews(warnings: string[], failures: GatherFailure[]): Promise<BriefingData["news"]> {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    // months: 2 (not 1) — listPartitions().slice(-months) reads whole-month
    // partitions, so near a month boundary a months:1 window silently
    // dropped yesterday's articles once they'd rolled into the prior
    // month's partition file.
    const results = await searchItems("", { limit: 50, months: 2 });

    const recent = results
      .filter((item) => new Date(item.publishedAt || item.collectedAt).getTime() > cutoff)
      .sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));
    const top = recent.slice(0, 12);

    return {
      articles: top.map((item) => ({
        title: item.title,
        source: item.sourceId,
        url: item.url,
        topic: item.topics[0] ?? "",
        body: item.body,
        publishedAt: item.publishedAt,
        score: item.relevanceScore ?? 0,
      })),
      totalFetched: results.length,
      totalRecent: recent.length,
    };
  } catch (err) {
    warnings.push(`news: ${err instanceof Error ? err.message : String(err)}`);
    recordFailure(failures, "news", err);
    return { articles: [], totalFetched: 0, totalRecent: 0 };
  }
}

export async function gatherWeather(warnings: string[], failures: GatherFailure[]): Promise<BriefingData["weather"] | undefined> {
  let report: WeatherReport;
  try {
    // Deliberately still a per-call dynamic import, unlike the 13 gatherer
    // dependencies above. WeatherService.ts is a single-consumer leaf here —
    // no other gatherer's dependency graph reaches it, so there is no
    // concurrent `import()` race target and the H1 TDZ hazard (see the block
    // comment above) does not apply. Going static would also change an
    // observable module-load side effect: WeatherService.ts statically
    // imports lib/core/CachedHTTPClient.ts, whose top-level `httpClient`
    // singleton mkdirSync's a disk cache dir in its constructor — a static
    // import here would make every import of DataGatherer.ts (including
    // gatherWeather-free unit tests) eagerly touch disk. Keeping this one
    // dynamic preserves the exact current side-effect timing (deferred to
    // when weather is actually gathered), matching WeatherBlock.ts's
    // original intent before its fold into this function.
    const { fetchWeatherReport } = await import("./WeatherService.ts");
    report = await fetchWeatherReport();
  } catch (err) {
    warnings.push(`weather: ${err instanceof Error ? err.message : String(err)}`);
    recordFailure(failures, "weather", err);
    return undefined;
  }

  try {
    const current = `${report.current.tempF}°F ${report.current.condition}`.trim();
    const forecast = `High ${report.today.highF}°F, Low ${report.today.lowF}°F`;
    const alerts = report.alerts.map((a) => a.event || "Alert").filter(Boolean);

    return {
      current,
      forecast,
      sunrise: report.astronomy.sunrise,
      sunset: report.astronomy.sunset,
      forecast3Day: report.forecast.map((d) => ({
        date: d.date,
        highF: d.highF,
        lowF: d.lowF,
        condition: d.condition,
        icon: d.icon,
        rainChancePct: d.rainChancePct,
      })),
      todayHourly: (report.today.hourly ?? [])
        .filter((_h, i) => i % 3 === 0)
        .map((h) => ({
          time: h.time,
          tempF: h.tempF,
          condition: h.condition,
          rainChancePct: h.rainChancePct,
        })),
      alerts,
    };
  } catch (err) {
    warnings.push(`weather: ${err instanceof Error ? err.message : String(err)}`);
    recordFailure(failures, "weather", err);
    return undefined;
  }
}

async function gatherGmail(warnings: string[], failures: GatherFailure[]): Promise<BriefingData["gmail"] | undefined> {
  try {
    // --max 25 (not 10): the fetch count IS the reported total, so fetch a
    // wider window than the 10-message display slice. If even 25 fills up
    // with more pages behind it, countIsLowerBound says so honestly.
    const raw = await runKayaCli(
      ["gmail", "search", "is:unread is:important newer_than:1d", "--max", "25", "--json"],
      15000
    );
    if (!raw) return undefined;

    type GmailMsg = { from?: string; subject?: string; snippet?: string };
    let messages: GmailMsg[] = [];
    let hasMorePages = false;

    if (raw.startsWith("[")) {
      messages = JSON.parse(raw) as GmailMsg[];
    } else if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw) as {
        nextPageToken?: string;
        messages?: GmailMsg[];
        threads?: Array<{ messages?: GmailMsg[] }>;
      };
      messages = parsed.messages ?? parsed.threads?.map((t) => t.messages?.[0] ?? {}) ?? [];
      hasMorePages = Boolean(parsed.nextPageToken);
    }

    if (messages.length === 0) return undefined;

    return {
      totalUnreadCount: messages.length,
      ...(hasMorePages ? { countIsLowerBound: true } : {}),
      messages: messages.slice(0, 10).map((m) => ({
        from: m.from ?? "",
        subject: m.subject ?? "",
        snippet: m.snippet ?? "",
      })),
    };
  } catch (err) {
    warnings.push(`gmail: ${err instanceof Error ? err.message : String(err)}`);
    recordFailure(failures, "gmail", err);
    return undefined;
  }
}

async function gatherApprovalQueue(warnings: string[], failures: GatherFailure[]): Promise<BriefingData["approvalQueue"] | undefined> {
  try {
    const allItems = loadQueueItems("approvals") as Array<{
      id: string; status: string; created: string; priority: number;
      payload: { title: string };
    }>;

    const pending = allItems.filter((i) => i.status === "pending" || i.status === "awaiting_approval");
    if (pending.length === 0) return undefined;

    pending.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return new Date(a.created).getTime() - new Date(b.created).getTime();
    });

    return {
      pendingCount: pending.length,
      items: pending.slice(0, 15).map((i) => ({
        id: i.id,
        title: i.payload.title,
        age: formatAge(i.created),
      })),
    };
  } catch (err) {
    warnings.push(`approvalQueue: ${err instanceof Error ? err.message : String(err)}`);
    recordFailure(failures, "approvalQueue", err);
    return undefined;
  }
}

/**
 * D3: pull the WaitingOnJm five-surface aggregate into a compact counts-only
 * shape for the briefing. Best-effort like every other gatherer here — a
 * failure pushes a warning + a recorded failure and the briefing proceeds
 * without this section, it never throws out of gatherBriefingData.
 */
export async function gatherWaitingOnJm(
  warnings: string[],
  failures: GatherFailure[],
  deps: { getWaitingOnJm?: (now?: Date) => WaitingOnJmSummary | Promise<WaitingOnJmSummary> } = {}
): Promise<BriefingData["waitingOnJm"]> {
  try {
    const getSummary = deps.getWaitingOnJm ?? getWaitingOnJmImpl;
    // F3: the real impl is async and THROWS if the process entry point didn't
    // wire bin/wire-queue-task-integration.ts — caught below like every other
    // gatherer failure, so the briefing degrades loudly (warning + recorded
    // failure + non-zero exit) instead of silently blanking this section.
    const summary = await getSummary();

    const total =
      summary.needsGrilling.count +
      summary.approvalsPending.count +
      summary.pendingApprovalMerges.count +
      summary.needsJmEscalations.count +
      summary.laneAWaitingDeliverables.count;

    if (total === 0) return undefined;

    return {
      needsGrillingCount: summary.needsGrilling.count,
      needsGrillingOldestAgeDays: summary.needsGrilling.oldestAgeDays,
      approvalsPendingCount: summary.approvalsPending.count,
      pendingApprovalMergesCount: summary.pendingApprovalMerges.count,
      needsJmEscalationsCount: summary.needsJmEscalations.count,
      laneAWaitingCount: summary.laneAWaitingDeliverables.count,
    };
  } catch (err) {
    warnings.push(`waitingOnJm: ${err instanceof Error ? err.message : String(err)}`);
    recordFailure(failures, "waitingOnJm", err);
    return undefined;
  }
}

/**
 * Strip the AUTOGEN region(s) StatusRefresh.ts (a 6-hourly LaunchAgent)
 * rewrites in STATUS.md, inclusive of their marker comments. Same
 * indexOf-anchored shape as StatusRefresh.ts's replaceMarked (copied locally,
 * not imported — that module's own top-level getKayaHome() call transitively
 * pulls LifeOS's Config.ts, which this aggregator has no business loading).
 * A missing or malformed marker pair is left untouched rather than thrown on
 * — one broken region must not blank the whole staleness signal.
 */
function stripAutogenRegions(content: string): string {
  let out = content;
  for (const name of ["last-updated", "wigs", "habits"]) {
    const open = `<!-- AUTOGEN:${name} -->`;
    const close = `<!-- /AUTOGEN:${name} -->`;
    const start = out.indexOf(open);
    const end = out.indexOf(close);
    if (start === -1 || end === -1 || end < start) continue;
    out = out.slice(0, start) + out.slice(end + close.length);
  }
  return out;
}

/** Same short non-cryptographic fingerprint idiom as this dir's Deliver.ts shortHash. */
function contentHash(content: string): string {
  return typeof Bun !== "undefined" && Bun.hash ? Bun.hash(content).toString(16) : String(content.length);
}

interface TelosContentHashState {
  hash: string;
  lastChangedISO: string;
}

function defaultTelosHashStatePath(): string {
  return join(KAYA_HOME, "MEMORY", "State", "telos-content-hash.json");
}

function loadTelosHashState(statePath: string): TelosContentHashState | null {
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<TelosContentHashState>;
    if (typeof parsed.hash === "string" && typeof parsed.lastChangedISO === "string") {
      return { hash: parsed.hash, lastChangedISO: parsed.lastChangedISO };
    }
  } catch {
    // Corrupt state — treat as missing, reseed below.
  }
  return null;
}

/**
 * Content-aware TELOS staleness: StatusRefresh.ts rewrites three AUTOGEN
 * regions of STATUS.md nearly every 6h run, so plain mtime (the old
 * implementation) was always fresh even when the hand-written narrative
 * hadn't changed in months. Instead: hash STATUS.md with the AUTOGEN regions
 * stripped, and compare against the last-known hash persisted in
 * MEMORY/State/telos-content-hash.json. A changed hash (or no prior state —
 * first run) resets the clock to now and reports 0; an unchanged hash reports
 * days elapsed since the stored change time. `deps` lets tests point at a
 * fixture STATUS.md/state file without touching module-load-time KAYA_HOME.
 */
export function gatherTelosStaleness(
  deps: { statusPath?: string; statePath?: string } = {}
): number | null {
  try {
    const statusPath = deps.statusPath ?? join(TELOS_DIR, "STATUS.md");
    if (!existsSync(statusPath)) return null;

    const content = readFileSync(statusPath, "utf-8");
    const hash = contentHash(stripAutogenRegions(content));
    const statePath = deps.statePath ?? defaultTelosHashStatePath();
    const prior = loadTelosHashState(statePath);

    if (!prior || prior.hash !== hash) {
      const lastChangedISO = new Date().toISOString();
      const dir = dirname(statePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(statePath, JSON.stringify({ hash, lastChangedISO }, null, 2));
      return 0;
    }

    return Math.floor((Date.now() - new Date(prior.lastChangedISO).getTime()) / 86400000);
  } catch {
    return null;
  }
}

function gatherFeedback(warnings: string[]): BriefingData["feedback"] | undefined {
  try {
    const feedbackPath = join(KAYA_HOME, "MEMORY", "BRIEFINGS", "feedback.jsonl");
    if (!existsSync(feedbackPath)) return undefined;

    const cutoff = Date.now() - 30 * 86400000;
    const lines = readFileSync(feedbackPath, "utf-8").trim().split("\n").filter(Boolean);

    type FeedbackEntry = { useful?: boolean; timestamp?: string; ts?: string };
    const entries: FeedbackEntry[] = [];
    let lastFeedback: string | null = null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as FeedbackEntry;
        const ts = entry.timestamp ?? entry.ts ?? "";
        if (ts && new Date(ts).getTime() > cutoff) entries.push(entry);
        if (ts) lastFeedback = ts;
      } catch { /* skip malformed */ }
    }

    if (entries.length === 0) return { recentUsefulRate: 0, lastFeedback };

    const useful = entries.filter((e) => e.useful === true).length;
    return {
      recentUsefulRate: Math.round((useful / entries.length) * 100) / 100,
      lastFeedback,
    };
  } catch (err) {
    warnings.push(`feedback: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

// ============================================================================
// Tech Debt
// ============================================================================

export async function gatherTechDebt(warnings: string[], failures: GatherFailure[]): Promise<TechDebtSummary | undefined> {
  try {
    const registry = new TechDebtRegistry();
    const top = registry.top(10);
    if (top.length === 0) return undefined;
    return {
      items: top.map((i) => ({
        id: i.id,
        description: i.description,
        location: i.location,
        composite: i.score?.composite ?? null,
      })),
      // list().length, NOT top.length — the old `total: top.length` capped the
      // reported backlog at 10 forever, hiding how deep it actually runs.
      totalOpenCount: registry.list().length,
    };
  } catch (err) {
    warnings.push(`TechDebt gather failed: ${err instanceof Error ? err.message : String(err)}`);
    recordFailure(failures, "techDebt", err);
    return undefined;
  }
}

async function gatherAutonomousDeliverables(
  warnings: string[],
  failures: GatherFailure[]
): Promise<BriefingData["autonomousDeliverables"] | undefined> {
  try {
    const result = await executeAutonomousDeliverables({});

    if (!result.success) {
      const errMsg = result.error ?? "unavailable";
      warnings.push(`autonomousDeliverables: ${errMsg}`);
      recordFailure(failures, "autonomousDeliverables", errMsg);
      return undefined;
    }

    const data = result.data as {
      count?: number;
      items?: Array<{ taskId: string; title: string; noteLink: string }>;
    };

    const count = data.count ?? 0;
    if (count === 0) return undefined;

    return {
      pendingCount: count,
      items: data.items ?? [],
    };
  } catch (err) {
    warnings.push(
      `autonomousDeliverables: ${err instanceof Error ? err.message : String(err)}`
    );
    recordFailure(failures, "autonomousDeliverables", err);
    return undefined;
  }
}

/**
 * Claude Code / dev-tooling updates. Best-effort like every other gatherer: a
 * failure (network, LLM) pushes a warning + recorded failure and the briefing
 * proceeds without the section. Returns undefined when there's nothing new or
 * nothing rose above routine churn, so the ...(x ? {x} : {}) spread omits the
 * key entirely and the editorial layer knows to skip the subsection.
 */
async function gatherClaudeCodeUpdates(
  warnings: string[],
  failures: GatherFailure[]
): Promise<ClaudeCodeUpdatesData | undefined> {
  try {
    const result = await executeClaudeCodeUpdates({});

    if (!result.success) {
      const errMsg = result.error ?? "unavailable";
      warnings.push(`claudeCodeUpdates: ${errMsg}`);
      recordFailure(failures, "claudeCodeUpdates", errMsg);
      return undefined;
    }

    const data = result.data as unknown as ClaudeCodeUpdatesData;
    // Only forward when there's something actually worth surfacing.
    if (!data.surfaced || data.surfaced.length === 0) return undefined;
    return data;
  } catch (err) {
    warnings.push(`claudeCodeUpdates: ${err instanceof Error ? err.message : String(err)}`);
    recordFailure(failures, "claudeCodeUpdates", err);
    return undefined;
  }
}

/**
 * T4 Learning Loop targets for the briefing. Reads skill_mastery_active's
 * LIVE rows (non-empty phase) read-only, computes dueToPractice from
 * review_due vs today (string compare, both YYYY-MM-DD), and pulls Anki
 * due/new counts for every track (since the 09-2026 curriculum builds every
 * registered target has a Learning::<skill> deck; for a skill the deck holds
 * L1 recall only and the rep — dueToPractice — is the real review). Each
 * target also carries `reviewMeans`, the track's plain-language review
 * instruction, so the rendered briefing says "do the rep" for a skill and
 * "answer the cards" for knowledge instead of one line for both.
 *
 * The Anki call is fail-soft PER TARGET (apy needs the collection unlocked —
 * Anki open at 06:00 is routine, not a bug): a failure sets
 * cardsUnavailable=true and pushes a soft warning, it never throws out of
 * this function or recordFailure()s (that ledger is for real crashes, not an
 * expected "Anki happened to be open" state).
 *
 * Returns undefined — the whole section vanishes — when there are no live
 * targets, or when none of them have anything notable this morning (no
 * cards due/new anywhere, and nothing due to practice anywhere).
 */
async function gatherLearning(
  warnings: string[],
  failures: GatherFailure[]
): Promise<BriefingData["learning"]> {
  try {
    const { rows, error } = lifeOSQuery("SELECT * FROM skill_mastery_active");
    if (error) throw new Error(error);

    const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
    const liveRows = rows.filter(r => str(r.phase).trim() !== "");
    if (liveRows.length === 0) return undefined;

    const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, matches meta.date's convention
    const anki = new AnkiClient();

    const targets: NonNullable<BriefingData["learning"]>["targets"] = [];
    for (const r of liveRows) {
      const name = str(r.skill);
      const track = str(r.track);
      const reviewDue = str(r.review_due);
      const dueToPractice = reviewDue !== "" && reviewDue <= today;
      const lastPractice = str(r.last_practice);
      const nextAction = str(r.next_action).trim();

      let cardsDue: number | undefined;
      let cardsNew: number | undefined;
      let cardsUnavailable: boolean | undefined;
      {
        try {
          const due = await anki.reviewDue(learningDeckFor(name));
          cardsDue = due.dueCount;
          cardsNew = due.newCount;
        } catch (err) {
          cardsUnavailable = true;
          warnings.push(`learning: Anki reviewDue unavailable for "${name}" (Anki may be open): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      let mapProgress: string | undefined;
      const mapLink = str(r.map_link);
      if (mapLink) {
        try {
          const progress = computeProgress(parseCheckboxTree(readFileSync(mapLink, "utf-8")));
          if (progress.total > 0) mapProgress = `${progress.checked}/${progress.total} nodes`;
        } catch {
          // fail-soft: missing/unparseable map just omits the progress line
        }
      }

      targets.push({
        name,
        track,
        reviewMeans: trackMechanic(track).reviewMeans,
        ...(cardsDue !== undefined ? { cardsDue } : {}),
        ...(cardsNew !== undefined ? { cardsNew } : {}),
        ...(cardsUnavailable ? { cardsUnavailable } : {}),
        ...(dueToPractice ? { dueToPractice } : {}),
        ...(lastPractice ? { lastPractice } : {}),
        ...(nextAction ? { nextAction } : {}),
        ...(mapProgress ? { mapProgress } : {}),
      });
    }

    const hasSignal = targets.some(t => (t.cardsDue ?? 0) > 0 || (t.cardsNew ?? 0) > 0 || t.dueToPractice === true);
    if (!hasSignal) return undefined;

    return { targets };
  } catch (err) {
    warnings.push(`learning: ${err instanceof Error ? err.message : String(err)}`);
    recordFailure(failures, "learning", err);
    return undefined;
  }
}

// ============================================================================
// Main Export
// ============================================================================

export async function gatherBriefingData(
  config: Record<string, unknown> = {},
  settings: Record<string, unknown> = {}
): Promise<BriefingData> {
  const now = new Date();
  // Local-timezone date, NOT toISOString() — after 17:00 PDT, UTC has already
  // rolled to tomorrow, so the ISO date read one day ahead of dateFormatted
  // (agent-found bug, supervised run 2026-07-12 17:17 PDT; invisible in the
  // normal 06:00 window). en-CA locale renders YYYY-MM-DD.
  const date = now.toLocaleDateString("en-CA");
  const dateFormatted = now.toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const dayOfWeek = now.toLocaleDateString("en-US", { weekday: "long" });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const userName = (settings.userName as string) ?? (config.userName as string) ?? "Jm";

  const warnings: string[] = [];
  // Hard failures (a gather threw) — distinct from soft warnings. Drives the
  // central failure log + non-zero exit so a crash can't hide as "data unavailable".
  const failures: GatherFailure[] = [];

  // Raw staleness number is forwarded to the LLM in meta.telosStalenessDays; the
  // editorial prompt owns the "is this stale enough to flag" judgment — no threshold here.
  const telosStaleness = gatherTelosStaleness();

  const [
    tasks,
    calendar,
    goals,
    strategies,
    habits,
    news,
    weather,
    gmail,
    approvalQueue,
    techDebt,
    autonomousDeliverables,
    waitingOnJm,
    claudeCodeUpdates,
    learning,
  ] = await Promise.all([
    gatherTasks(warnings, failures),
    gatherCalendar(warnings, failures),
    gatherGoals(warnings, failures),
    gatherStrategies(warnings, failures),
    gatherHabits(warnings, failures),
    gatherNews(warnings, failures),
    gatherWeather(warnings, failures),
    gatherGmail(warnings, failures),
    gatherApprovalQueue(warnings, failures),
    gatherTechDebt(warnings, failures),
    gatherAutonomousDeliverables(warnings, failures),
    gatherWaitingOnJm(warnings, failures),
    gatherClaudeCodeUpdates(warnings, failures),
    gatherLearning(warnings, failures),
  ]);

  const feedback = gatherFeedback(warnings);

  return {
    meta: {
      date,
      dateFormatted,
      dayOfWeek,
      timezone,
      userName,
      telosStalenessDays: telosStaleness,
      dataQualityWarnings: warnings,
      gatherFailures: failures,
      standingCoverageNotes: STANDING_COVERAGE_NOTES,
    },
    tasks,
    calendar,
    goals,
    strategies,
    habits,
    news,
    ...(weather ? { weather } : {}),
    ...(gmail ? { gmail } : {}),
    ...(approvalQueue ? { approvalQueue } : {}),
    ...(feedback ? { feedback } : {}),
    ...(techDebt ? { techDebt } : {}),
    ...(autonomousDeliverables ? { autonomousDeliverables } : {}),
    ...(waitingOnJm ? { waitingOnJm } : {}),
    ...(claudeCodeUpdates ? { claudeCodeUpdates } : {}),
    ...(learning ? { learning } : {}),
  };
}

// ============================================================================
// Self-test
// ============================================================================

if (import.meta.main) {
  // Composition root (same pattern as BriefingFallback's entry point): gatherWaitingOnJm
  // reads through the TaskClient seam (F3) — register the adapters before
  // gathering, or getWaitingOnJm throws (softly) on every standalone run.
  await import("../../../../bin/wire-queue-task-integration.ts");
  console.error("[DataGatherer] Running self-test...");
  const start = Date.now();
  gatherBriefingData()
    .then((data) => {
      const elapsed = Date.now() - start;
      console.error(`[DataGatherer] Completed in ${elapsed}ms`);
      if (data.meta.dataQualityWarnings.length > 0) {
        console.error("[DataGatherer] Warnings:");
        for (const w of data.meta.dataQualityWarnings) {
          console.error(`  - ${w}`);
        }
      }
      console.log(JSON.stringify(data, null, 2));
    })
    .catch((err) => {
      console.error("[DataGatherer] Fatal error:", err);
      process.exit(1);
    });
}
