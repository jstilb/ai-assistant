#!/usr/bin/env bun
/**
 * MissionGroupedBlock.ts - Re-groups calendar, task, and goal data by TELOS mission
 *
 * Takes the OUTPUT from CalendarBlock, LucidTasksBlock, and GoalsBlock and re-organizes
 * items into mission-grouped sections using keyword matching against mission titles,
 * goal titles, and a hardcoded keyword map.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { execute as executeCalendar } from "./CalendarBlock.ts";
import { execute as executeLucidTasks } from "./LucidTasksBlock.ts";
import { execute as executeGoals } from "./GoalsBlock.ts";
import type { BlockResult } from "./types.ts";

export type { BlockResult };

const KAYA_HOME = process.env.KAYA_DIR || join(process.env.HOME!, ".claude");
const TELOS_DIR = join(KAYA_HOME, "skills", "CORE", "USER", "TELOS");

interface MissionDef {
  id: string;
  title: string;
  goalIds: string[];
}

interface ClassifiedEvent {
  time: string;
  title: string;
  location?: string;
}

interface ClassifiedTask {
  title: string;
  dueDate?: string;
  isOverdue?: boolean;
  isDueToday?: boolean;
}

interface ClassifiedGoal {
  id: string;
  title: string;
  status?: string;
  current?: string;
  metric?: string;
  isWIG: boolean;
}

interface MissionSummary {
  missionId: string;
  missionTitle: string;
  events: ClassifiedEvent[];
  tasks: ClassifiedTask[];
  goals: ClassifiedGoal[];
}

// Keyword map for classifying events/tasks into missions
const MISSION_KEYWORDS: Record<string, string[]> = {
  M5: [
    "work", "meeting", "sync", "standup", "sprint", "deploy", "review",
    "pr", "code", "promotion", "cofounder", "lucidview", "application",
    "ai", "proficient", "professional", "beta", "engineering", "team",
    "1:1", "retro", "planning", "kickoff", "onboarding", "demo",
    "presentation", "interview", "client", "project",
  ],
  M6: [
    "pt", "rehab", "stretch", "meditate", "journal", "media",
    "back", "shoulder", "dtr", "alignment", "wellbeing", "health",
    "therapy", "eating", "diet", "sleep", "routine", "pomodoro",
    "boredom", "consumption", "screen",
  ],
  M1: [
    "dsa", "vball", "volleyball", "surf", "surfing", "volunteer",
    "community", "event", "neighborhood", "neighbor", "writing group",
    "music community", "professional community",
  ],
  M2: [
    "write", "writing", "piano", "novel", "draft", "story", "creative",
    "on set", "book", "publish", "short story", "practice piano",
  ],
  M3: [
    "julie", "family", "therapy", "partner", "relationship",
  ],
  M4: [
    "friend", "social", "hang out", "call", "boys trip", "acquaintance",
  ],
  M0: [
    "travel", "trip", "park", "hike", "explore", "tijuana", "mexico",
    "national park", "adventure", "country", "countries",
  ],
};

export interface MissionGroupedBlockConfig {
  includeGoals?: boolean;
  includeCalendar?: boolean;
  includeTasks?: boolean;
}

/**
 * Parse MISSIONS.md to extract mission definitions and their goal mappings.
 */
function parseMissions(): MissionDef[] {
  const missions: MissionDef[] = [];
  const missionsPath = join(TELOS_DIR, "MISSIONS.md");

  if (!existsSync(missionsPath)) return missions;

  const content = readFileSync(missionsPath, "utf-8");

  // Parse mission headers
  const missionMatches = content.matchAll(
    /### (M\d+):\s*([^\n]+)/g
  );

  for (const match of missionMatches) {
    missions.push({
      id: match[1],
      title: match[2].trim(),
      goalIds: [],
    });
  }

  // Parse the Mission -> Goal Mapping table
  const mappingMatches = content.matchAll(
    /\|\s*(M\d+)\s*\([^)]+\)\s*\|\s*([^|]+)\|/g
  );

  for (const match of mappingMatches) {
    const missionId = match[1];
    const goalRange = match[2].trim();
    const mission = missions.find((m) => m.id === missionId);
    if (!mission) continue;

    // Parse goal IDs from ranges like "G3-G6" or "G1, G21-G24"
    const parts = goalRange.split(",").map((p) => p.trim());
    for (const part of parts) {
      const rangeMatch = part.match(/G(\d+)-G(\d+)/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1]);
        const end = parseInt(rangeMatch[2]);
        for (let i = start; i <= end; i++) {
          mission.goalIds.push(`G${i}`);
        }
      } else {
        const singleMatch = part.match(/G(\d+)/);
        if (singleMatch) {
          mission.goalIds.push(`G${singleMatch[0]}`);
        }
      }
    }
  }

  return missions;
}

/**
 * Parse GOALS.md to build a goalId -> goal title lookup.
 */
function parseGoalTitles(): Map<string, string> {
  const goalTitles = new Map<string, string>();
  const goalsPath = join(TELOS_DIR, "GOALS.md");

  if (!existsSync(goalsPath)) return goalTitles;

  const content = readFileSync(goalsPath, "utf-8");
  const goalMatches = content.matchAll(/### (G\d+):\s*([^\n]+)/g);

  for (const match of goalMatches) {
    goalTitles.set(match[1], match[2].trim());
  }

  return goalTitles;
}

/**
 * Classify text into the best matching mission using keyword matching.
 *
 * Scoring: checks the text against each mission's keyword list and associated
 * goal titles. The mission with the highest number of keyword hits wins.
 * Returns null if no keywords match (goes to Unclassified).
 */
function classifyToMission(
  text: string,
  missions: MissionDef[],
  goalTitles: Map<string, string>
): string | null {
  const lower = text.toLowerCase();
  let bestMission: string | null = null;
  let bestScore = 0;

  for (const mission of missions) {
    let score = 0;

    // Check hardcoded keywords for this mission
    const keywords = MISSION_KEYWORDS[mission.id] || [];
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) {
        score += 1;
      }
    }

    // Check mission title words
    const titleWords = mission.title.toLowerCase().split(/\s+/);
    for (const word of titleWords) {
      if (word.length > 3 && lower.includes(word)) {
        score += 1;
      }
    }

    // Check associated goal titles
    for (const goalId of mission.goalIds) {
      const goalTitle = goalTitles.get(goalId);
      if (goalTitle) {
        const goalWords = goalTitle.toLowerCase().split(/\s+/);
        for (const word of goalWords) {
          if (word.length > 3 && lower.includes(word)) {
            score += 0.5;
          }
        }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMission = mission.id;
    }
  }

  return bestScore > 0 ? bestMission : null;
}

export async function execute(
  config: MissionGroupedBlockConfig = {}
): Promise<BlockResult> {
  const {
    includeGoals = true,
    includeCalendar = true,
    includeTasks = true,
  } = config;

  try {
    // Execute all source blocks in parallel
    const [calendarResult, lucidTasksResult, goalsResult] = await Promise.all([
      includeCalendar ? executeCalendar({}) : null,
      includeTasks ? executeLucidTasks({}) : null,
      includeGoals ? executeGoals({ showWIGs: true, showMissions: true }) : null,
    ]);

    // Parse TELOS structure
    const missions = parseMissions();
    const goalTitles = parseGoalTitles();

    // Initialize mission buckets
    const missionBuckets = new Map<string, MissionSummary>();
    for (const mission of missions) {
      missionBuckets.set(mission.id, {
        missionId: mission.id,
        missionTitle: mission.title,
        events: [],
        tasks: [],
        goals: [],
      });
    }

    // Unclassified bucket
    const unclassified: MissionSummary = {
      missionId: "unclassified",
      missionTitle: "Unclassified",
      events: [],
      tasks: [],
      goals: [],
    };

    // Classify calendar events
    if (calendarResult?.success && calendarResult.data.events) {
      const events = calendarResult.data.events as ClassifiedEvent[];
      for (const event of events) {
        const missionId = classifyToMission(
          `${event.title} ${event.location || ""}`,
          missions,
          goalTitles
        );
        const bucket = missionId ? missionBuckets.get(missionId) : null;
        if (bucket) {
          bucket.events.push(event);
        } else {
          unclassified.events.push(event);
        }
      }
    }

    // Classify LucidTasks tasks
    if (lucidTasksResult?.success && lucidTasksResult.data) {
      const allTasks: ClassifiedTask[] = [
        ...((lucidTasksResult.data.dueToday as ClassifiedTask[]) || []),
        ...((lucidTasksResult.data.overdue as ClassifiedTask[]) || []),
        ...((lucidTasksResult.data.upcoming as ClassifiedTask[]) || []),
      ];

      for (const task of allTasks) {
        const missionId = classifyToMission(
          `${task.title} ${task.dueDate || ""}`,
          missions,
          goalTitles
        );
        const bucket = missionId ? missionBuckets.get(missionId) : null;
        if (bucket) {
          bucket.tasks.push(task);
        } else {
          unclassified.tasks.push(task);
        }
      }
    }

    // Classify goals (use explicit Supports field from GOALS.md mapping)
    if (goalsResult?.success && goalsResult.data.allGoals) {
      const allGoals = goalsResult.data.allGoals as ClassifiedGoal[];
      for (const goal of allGoals) {
        // Goals have explicit mission mapping via goalIds in MISSIONS.md
        let assigned = false;
        for (const mission of missions) {
          if (mission.goalIds.includes(goal.id)) {
            const bucket = missionBuckets.get(mission.id);
            if (bucket) {
              bucket.goals.push(goal);
              assigned = true;
              break;
            }
          }
        }
        if (!assigned) {
          unclassified.goals.push(goal);
        }
      }
    }

    // Build sorted mission summaries (missions with more items first)
    const activeMissions = Array.from(missionBuckets.values())
      .filter(
        (m) => m.events.length > 0 || m.tasks.length > 0 || m.goals.length > 0
      )
      .sort((a, b) => {
        const aCount = a.events.length + a.tasks.length + a.goals.length;
        const bCount = b.events.length + b.tasks.length + b.goals.length;
        return bCount - aCount;
      });

    const hasUnclassified =
      unclassified.events.length > 0 ||
      unclassified.tasks.length > 0 ||
      unclassified.goals.length > 0;

    // Format markdown
    let markdown = "## Today by Mission\n\n";

    for (const mission of activeMissions) {
      markdown += `### ${mission.missionId}: ${mission.missionTitle}\n`;
      markdown += formatMissionItems(mission);
      markdown += "\n";
    }

    if (hasUnclassified) {
      markdown += "### Unclassified\n";
      markdown += formatMissionItems(unclassified);
      markdown += "\n";
    }

    if (activeMissions.length === 0 && !hasUnclassified) {
      markdown += "No items to display today.\n";
    }

    // Count totals
    const totalEvents = activeMissions.reduce((s, m) => s + m.events.length, 0) +
      unclassified.events.length;
    const totalTasks = activeMissions.reduce((s, m) => s + m.tasks.length, 0) +
      unclassified.tasks.length;
    const totalGoals = activeMissions.reduce((s, m) => s + m.goals.length, 0) +
      unclassified.goals.length;

    // Build summary
    const summary = `${activeMissions.length} mission${activeMissions.length !== 1 ? "s" : ""} active today, ${totalEvents} event${totalEvents !== 1 ? "s" : ""}, ${totalTasks} task${totalTasks !== 1 ? "s" : ""}`;

    // Build missionSummaries for data output
    const missionSummaries = [
      ...activeMissions,
      ...(hasUnclassified ? [unclassified] : []),
    ];

    return {
      blockName: "missionGrouped",
      success: true,
      data: {
        missionSummaries,
        totalEvents,
        totalTasks,
        totalGoals,
        activeMissionCount: activeMissions.length,
      },
      markdown,
      summary,
    };
  } catch (error) {
    return {
      blockName: "missionGrouped",
      success: false,
      data: {},
      markdown: "## Today by Mission\n\nFailed to group items by mission.\n",
      summary: "Mission grouping unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Format a mission's items as markdown bullet points.
 */
function formatMissionItems(mission: MissionSummary): string {
  let out = "";

  for (const event of mission.events) {
    const loc = event.location ? ` @ ${event.location}` : "";
    out += `- \u{1F4C5} ${event.time} \u2013 ${event.title}${loc}\n`;
  }

  for (const goal of mission.goals) {
    if (goal.isWIG) {
      const metric = goal.current && goal.metric
        ? ` (currently ${goal.current})`
        : "";
      out += `- \u{1F3AF} ${goal.id}: ${goal.title}${metric}\n`;
    }
  }

  for (const task of mission.tasks) {
    const suffix = task.isOverdue
      ? " (overdue)"
      : task.isDueToday
        ? " (due today)"
        : task.dueDate
          ? ` (due ${task.dueDate})`
          : "";
    out += `- \u2705 ${task.title}${suffix}\n`;
  }

  return out;
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--test") || args.includes("-t")) {
    execute({ includeGoals: true, includeCalendar: true, includeTasks: true })
      .then((result) => {
        console.log("=== Mission Grouped Block Test ===\n");
        console.log("Success:", result.success);
        console.log("\nMarkdown:\n", result.markdown);
        console.log("\nSummary:", result.summary);
        console.log("\nData:", JSON.stringify(result.data, null, 2));
        if (result.error) console.log("\nError:", result.error);
      })
      .catch(console.error);
  } else {
    console.log("Usage: bun MissionGroupedBlock.ts --test");
  }
}
