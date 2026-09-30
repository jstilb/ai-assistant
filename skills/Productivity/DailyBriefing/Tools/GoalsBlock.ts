#!/usr/bin/env bun
/**
 * GoalsBlock.ts - TELOS goals and missions for daily briefing
 *
 * Reads directly from TELOS files to extract:
 * - Q1 WIGs (Wildly Important Goals)
 * - Active missions
 * - Focus recommendations
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { sendAlert } from "../../../../lib/core/AlertGate.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { loadTelosGoals } from "../../../../lib/core/TelosGoals.ts";
// cross-skill-allowed: DailyBriefing is the cross-system aggregator by design — reads AppUsageTracker's dependency-free WIG-target discovery so the media override can't pin a retired goal ID (the G37 no-op that survived the Q3 flip)
import { readMediaWigTargets } from "../../AppUsageTracker/Tools/WigTargets.ts";
import type { BlockResult } from "./types.ts";

const KAYA_HOME = getKayaHome(); // was KAYA_DIR-only; getKayaHome() superset
const TELOS_DIR = join(KAYA_HOME, "USER", "TELOS");

// Live media metric for the current media WIG (read-only AppUsageTracker query)
const MEDIA_METRIC_SCRIPT = join(KAYA_HOME, "skills", "Productivity", "AppUsageTracker", "bin", "metric.sh");

export type { BlockResult };

interface Goal {
  id: string;
  title: string;
  status?: string;
  metric?: string;
  current?: string;
  target?: string;
  isWIG: boolean;
}

interface Mission {
  id: string;
  title: string;
  focus?: string;
}

export interface GoalsBlockConfig {
  maxGoals?: number;
  maxMissions?: number;
}

/**
 * Fetch the live media metric from AppUsageTracker (events.db).
 * Parses the 4-wk rolling average from metric.sh and returns it as hr/day.
 */
async function fetchLiveMediaMetric(): Promise<{ value: string | null; live: boolean }> {
  try {
    const proc = Bun.spawn(["bash", MEDIA_METRIC_SCRIPT], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return { value: null, live: false };

    // e.g. "4-wk avg (per logged day) : 283.7 min/logged-day"
    const match = stdout.match(/4-wk avg[^:]*:\s*([\d.]+)\s*min/);
    if (!match) return { value: null, live: false };

    const hrs = parseFloat(match[1]!) / 60;
    // Total media (all-value, 28d avg) companion, distinct label so it can't
    // be confused with the low-value line above.
    const mediaMatch = stdout.match(/Total media \(28d avg\)\s*:\s*(\d+)\s*min/);
    const mediaCtx = mediaMatch ? ` / ${(parseInt(mediaMatch[1]!, 10) / 60).toFixed(1)} total media` : "";
    return { value: `${hrs.toFixed(1)} hrs/day low-value${mediaCtx} (4-wk avg)`, live: true };
  } catch {
    return { value: null, live: false };
  }
}

/**
 * Fetch live community-WIG status from the lead_log scoreboard (via LifeOS's
 * CommunityStatus aggregator — the same weekly-event-count computation the
 * WIG dashboard's S17 line uses, so the two surfaces cannot diverge).
 * Returns briefing-ready status + current strings. Fails soft → caller
 * keeps the narrative GOALS.md status.
 */
async function fetchLiveCommunityStatus(): Promise<{ statusLine: string; currentLine: string } | null> {
  try {
    // cross-skill-allowed: DailyBriefing is the cross-system aggregator by design — reads LifeOS's community-status aggregator read-only for the community goals status line
    const { communityStatus } = await import("../../LifeOS/Aggregation/CommunityStatus.ts");
    const result = await communityStatus();
    if (!result) return null;
    return { statusLine: result.statusLine, currentLine: result.currentLine };
  } catch {
    return null;
  }
}

/**
 * Discover which goal is the current community WIG (wig_status.json, by
 * shape — see CommunityStatus.readCommunityWigLead). Isolated so a broken
 * LifeOS module load degrades to "no community WIG" instead of failing the
 * whole goals block. Fails soft → null.
 */
async function discoverCommunityWigGoalId(): Promise<string | null> {
  try {
    // cross-skill-allowed: DailyBriefing is the cross-system aggregator by design — reads LifeOS's community-WIG discovery so the override can't pin a retired goal ID (the G38 no-op that survived the Q3 flip)
    const { readCommunityWigLead } = await import("../../LifeOS/Aggregation/CommunityStatus.ts");
    return readCommunityWigLead()?.goalId ?? null;
  } catch {
    return null;
  }
}

export async function execute(
  config: GoalsBlockConfig = {},
  deps: {
    fetchMediaMetric?: typeof fetchLiveMediaMetric;
    fetchCadence?: typeof fetchLiveCommunityStatus;
    discoverCommunityGoalId?: typeof discoverCommunityWigGoalId;
  } = {}
): Promise<BlockResult> {
  const { maxGoals = 5, maxMissions = 3 } = config;
  const fetchMedia = deps.fetchMediaMetric ?? fetchLiveMediaMetric;
  const fetchCadence = deps.fetchCadence ?? fetchLiveCommunityStatus;
  const discoverCommunityGoal = deps.discoverCommunityGoalId ?? discoverCommunityWigGoalId;

  try {
    const goals: Goal[] = [];
    const missions: Mission[] = [];

    // Load TELOS goals from the structured source (goals.yaml). The old
    // GOALS.md regex chain was one of five parsers independently re-deriving
    // Jm's hand-written grammar — deleted 2026-08-02 (markdown-regex
    // remediation, option (b)); GOALS.md is now a generated artifact.
    let wigParseError: string | null = null;
    try {
      const telos = loadTelosGoals();
      const activeIds = new Set(telos.activeWigs.map((g) => g.id));

      for (const g of telos.goals) {
        goals.push({
          id: g.id,
          title: g.title,
          status: g.status,
          isWIG: activeIds.has(g.id),
        });
      }

      if (telos.activeWigs.length === 0) {
        // Fail loud: an empty active set used to be a silent no-op — a real
        // incident (commit 4f7a2da80, "GoalsBlock ... hardcoded '## Q1 WIGs',
        // so the daily briefing kept surfacing closed Q1 goals"). Log + page +
        // carry an explicit marker so callers render a visible failure
        // instead of a quietly-empty goals section.
        wigParseError =
          `GoalsBlock: no active-quarter WIG section in goals.yaml — ` +
          `flag the current quarter's section with active: true + wig: true ` +
          `(its heading must contain "Active"). ` +
          `WIGs will render empty until goals.yaml is fixed.`;
        console.warn(`[GoalsBlock] ${wigParseError}`);
        sendAlert(wigParseError, { key: "goalsblock-heading-miss", tier: "page" });
      }
    } catch (error) {
      // Same fail-loud treatment as the empty-active-set branch: a missing or
      // invalid goals.yaml is a strictly worse failure (zero goal data at
      // all), so it must page just as loudly, through the identical key/tier.
      wigParseError =
        `GoalsBlock: failed to load TELOS goals from goals.yaml — ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `WIGs and goals will render empty until goals.yaml is fixed.`;
      console.warn(`[GoalsBlock] ${wigParseError}`);
      sendAlert(wigParseError, { key: "goalsblock-heading-miss", tier: "page" });
    }

    // Parse MISSIONS.md
    const missionsPath = join(TELOS_DIR, "MISSIONS.md");
    if (existsSync(missionsPath)) {
      const content = readFileSync(missionsPath, "utf-8");

      // Parse missions
      const missionMatches = content.matchAll(/### (M\d+):\s*([^\n]+)\n([\s\S]*?)(?=\n###|\n---|\n## |$)/g);

      for (const match of missionMatches) {
        const id = match[1];
        const title = match[2].trim();
        const body = match[3];

        const focusMatch = body.match(/\*\*Focus:\*\*\s*([^\n]+)/);

        missions.push({
          id,
          title,
          focus: focusMatch?.[1]?.trim(),
        });
      }
    }

    // Live-metric overrides. When a fetch fails, the goal keeps its narrative
    // GOALS.md value — but that substitution must be VISIBLE, not silent, so
    // each failure (for a goal that actually exists) lands in
    // unavailableLiveMetrics, which DataGatherer surfaces as a
    // dataQualityWarning (mirrors the media-metric "unavailable" pattern).
    const unavailableLiveMetrics: string[] = [];

    // Override the current media WIG with the live AppUsageTracker metric.
    // The goal ID comes from wig_status.json (discovered by shape, see
    // WigTargets.ts) — a hardcoded "G37" here survived the Q3 rollover as a
    // silent no-op: the lookup found nothing, so the briefing showed G42's
    // static narrative value AND never flagged the substitution.
    const mediaWig = readMediaWigTargets();
    if (mediaWig) {
      // Same isWIG preference as the community override below: GOALS.md
      // retains closed quarters' sections, so prefer the active instance.
      const mediaGoal =
        goals.find((g) => g.id === mediaWig.goalId && g.isWIG)
        ?? goals.find((g) => g.id === mediaWig.goalId);
      if (!mediaGoal) {
        // wig_status.json names a media WIG that GOALS.md doesn't have —
        // config drift between the two rollover surfaces must be visible.
        if (goals.length > 0) {
          unavailableLiveMetrics.push(
            `${mediaWig.goalId} media WIG is in wig_status.json but not in GOALS.md — live media metric not shown; reconcile the rollover surfaces`
          );
        }
      } else {
        const { value: liveMedia } = await fetchMedia();
        if (liveMedia) {
          mediaGoal.current = liveMedia;
        } else {
          unavailableLiveMetrics.push(
            `${mediaWig.goalId} media metric (AppUsageTracker events.db) unavailable — showing narrative GOALS.md value, which may be stale`
          );
        }
      }
    }
    // mediaWig === null → no media WIG this quarter (or wig_status.json
    // unreadable): retired goals aren't briefing noise, and the unreadable
    // case is surfaced loudly by Freshness's own "no media WIG target" note.

    // Override the current community WIG with live lead_log status. The
    // editorial layer leads with goals[].status verbatim, so a stale GOALS.md
    // status line would otherwise be repeated even after the lead_log
    // scoreboard moved. The goal ID comes from wig_status.json (discovered by
    // shape) — the hardcoded "G38" here survived the Q3 rollover as a silent
    // no-op, same drift class as the media override above. The isWIG
    // preference matters because GOALS.md retains closed quarters' sections:
    // prefer the active-quarter instance, fall back to any parsed instance.
    const communityGoalId = await discoverCommunityGoal();
    if (communityGoalId) {
      const communityGoal =
        goals.find((g) => g.id === communityGoalId && g.isWIG)
        ?? goals.find((g) => g.id === communityGoalId);
      if (!communityGoal) {
        if (goals.length > 0) {
          unavailableLiveMetrics.push(
            `${communityGoalId} community WIG is in wig_status.json but not in GOALS.md — live cadence not shown; reconcile the rollover surfaces`
          );
        }
      } else {
        const liveCadence = await fetchCadence();
        if (liveCadence) {
          communityGoal.status = liveCadence.statusLine;
          communityGoal.current = liveCadence.currentLine;
        } else {
          unavailableLiveMetrics.push(
            `${communityGoalId} community status (LifeOS lead_log) unavailable — showing narrative GOALS.md status, which may be stale`
          );
        }
      }
    }
    // communityGoalId === null → no community WIG this quarter (or
    // wig_status.json unreadable): retired goals aren't briefing noise.

    // Filter and limit
    const wigs = goals.filter((g) => g.isWIG).slice(0, maxGoals);
    const displayMissions = missions.slice(0, maxMissions);

    // No code-side focus recommendation — the editorial LLM picks the day's focus
    // (it already selects focusTask from the full goal/task set).

    // No markdown/summary rendering: the live path (DataGatherer.gatherGoals)
    // reads only .data; composition is the editorial layer's job. The old
    // markdown table + summary strings here were dead code.
    const summary = wigParseError
      ? "WIG parse failed — check goals.yaml"
      : `${wigs.length} WIGs, ${missions.length} missions`;

    return {
      blockName: "goals",
      // Overall gather still succeeded (missions/allGoals parsed fine) — the
      // WIG-heading failure is carried explicitly via data.parseError rather
      // than flipping this to false, so DataGatherer doesn't discard the
      // missions/goals data that DID parse. See DataGatherer.gatherGoals().
      success: true,
      data: { wigs, missions: displayMissions, allGoals: goals, parseError: wigParseError, unavailableLiveMetrics },
      markdown: "",
      summary,
    };
  } catch (error) {
    return {
      blockName: "goals",
      success: false,
      data: {},
      markdown: "## Goals\n\nFailed to load goals.\n",
      summary: "Goals unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--test") || args.includes("-t")) {
    execute({ maxGoals: 5 })
      .then((result) => {
        console.log("=== Goals Block Test ===\n");
        console.log("Success:", result.success);
        console.log("\nSummary:", result.summary);
        console.log("\nData:", JSON.stringify(result.data, null, 2));
      })
      .catch(console.error);
  } else {
    console.log("Usage: bun GoalsBlock.ts --test");
  }
}
