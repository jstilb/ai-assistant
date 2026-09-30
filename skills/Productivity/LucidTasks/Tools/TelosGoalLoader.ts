#!/usr/bin/env bun
/**
 * TelosGoalLoader.ts - Structured TELOS Goal/Mission Data for LucidTasks
 *
 * Goals come from the typed source of truth (USER/TELOS/goals.yaml via
 * lib/core/TelosGoals.ts) — the GOALS.md regex parser was deleted 2026-08-02
 * (markdown-regex remediation, option (b); GOALS.md is now a generated
 * artifact). MISSIONS.md is still parsed here. Results are cached since
 * goals/missions change rarely.
 *
 * Usage:
 *   bun run TelosGoalLoader.ts            # Print all goals and missions
 *   bun run TelosGoalLoader.ts goals      # Print goals only
 *   bun run TelosGoalLoader.ts missions   # Print missions only
 *   bun run TelosGoalLoader.ts goal G25   # Print specific goal
 *   bun run TelosGoalLoader.ts --json     # JSON output
 *
 * @module TelosGoalLoader
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { loadTelosGoals } from "../../../../lib/core/TelosGoals.ts";

// ============================================================================
// Configuration
// ============================================================================

const KAYA_HOME = getKayaHome();
const MISSIONS_PATH = join(KAYA_HOME, "USER/TELOS/MISSIONS.md");

// ============================================================================
// Types
// ============================================================================

export interface TelosGoal {
  id: string;           // e.g., "G0", "G25"
  title: string;        // e.g., "Decrease Low-Value Media Consumption"
  status: string;       // e.g., "In Progress" (full status line as authored)
  missionId: string;    // e.g., "M6" (first supported mission)
  missionName: string;  // e.g., "Self"
}

export interface TelosMission {
  id: string;           // e.g., "M0"
  name: string;         // e.g., "Adventurer"
  definition: string;   // Full definition text
  focus: string;        // e.g., "Regional Exploration & International Travel"
  theme2026: string;    // e.g., "Explore Mexico, visit 3 new countries..."
  goalIds: string[];    // e.g., ["G3", "G4", "G5", "G6"]
}

export interface TelosData {
  goals: TelosGoal[];
  missions: TelosMission[];
  goalMap: Map<string, TelosGoal>;
  missionMap: Map<string, TelosMission>;
}

// ============================================================================
// Cache
// ============================================================================

let _cached: TelosData | null = null;
let _cacheTime: number = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// Parsers
// ============================================================================

/**
 * Load goals from the structured source (goals.yaml). Throws loud when the
 * source is missing/invalid — LucidTasks callers already guard with
 * try/catch ("TELOS not available").
 */
export function loadGoals(): TelosGoal[] {
  return loadTelosGoals().goals.map((g) => ({
    id: g.id,
    title: g.title,
    status: g.status,
    missionId: g.supports[0]?.id ?? "",
    missionName: g.supports[0]?.name ?? "",
  }));
}

/**
 * Parse MISSIONS.md into structured mission objects
 */
export function parseMissions(content: string): TelosMission[] {
  const missions: TelosMission[] = [];

  // Split by mission headings: ### M{N}: {Name}
  const missionPattern = /^### (M\d+):\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  const missionPositions: { id: string; name: string; start: number }[] = [];

  while ((match = missionPattern.exec(content)) !== null) {
    missionPositions.push({
      id: match[1],
      name: match[2].trim(),
      start: match.index,
    });
  }

  // Parse the goal mapping table at the bottom
  const goalMapping: Map<string, string[]> = new Map();
  const tablePattern = /\|\s*(M\d+)\s*\([^)]*\)\s*\|\s*([^|]+)\|/g;
  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = tablePattern.exec(content)) !== null) {
    const missionId = tableMatch[1];
    const goalRefs = tableMatch[2].trim();
    // Parse goal IDs like "G3-G6" or "G1, G21-G24"
    const goalIds = expandGoalIds(goalRefs);
    goalMapping.set(missionId, goalIds);
  }

  for (let i = 0; i < missionPositions.length; i++) {
    const { id, name, start } = missionPositions[i];
    const end = i + 1 < missionPositions.length ? missionPositions[i + 1].start : content.length;
    const block = content.slice(start, end);

    const defMatch = block.match(/\*\*Definition:\*\*\s*(.+)/);
    const focusMatch = block.match(/\*\*Focus:\*\*\s*(.+)/);
    const themeMatch = block.match(/\*\*2026 Theme:\*\*\s*(.+)/);

    missions.push({
      id,
      name,
      definition: defMatch ? defMatch[1].trim() : "",
      focus: focusMatch ? focusMatch[1].trim() : "",
      theme2026: themeMatch ? themeMatch[1].trim() : "",
      goalIds: goalMapping.get(id) || [],
    });
  }

  return missions;
}

/**
 * Expand goal ID references like "G3-G6" or "G1, G21-G24"
 */
export function expandGoalIds(refs: string): string[] {
  const ids: string[] = [];
  const parts = refs.split(",").map((s) => s.trim());

  for (const part of parts) {
    const rangeMatch = part.match(/G(\d+)\s*-\s*G(\d+)/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]);
      const end = parseInt(rangeMatch[2]);
      for (let i = start; i <= end; i++) {
        ids.push(`G${i}`);
      }
    } else {
      const singleMatch = part.match(/G(\d+)/);
      if (singleMatch) {
        ids.push(`G${singleMatch[1]}`);
      }
    }
  }

  return ids;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Load all TELOS data (goals + missions). Results are cached for 5 minutes.
 */
export function loadTelosData(): TelosData {
  const now = Date.now();
  if (_cached && now - _cacheTime < CACHE_TTL_MS) {
    return _cached;
  }

  if (!existsSync(MISSIONS_PATH)) {
    throw new Error(`TELOS MISSIONS.md not found at: ${MISSIONS_PATH}`);
  }

  const missionsContent = readFileSync(MISSIONS_PATH, "utf-8");

  const goals = loadGoals();
  const missions = parseMissions(missionsContent);

  // Build lookup maps
  const goalMap = new Map<string, TelosGoal>();
  for (const goal of goals) {
    goalMap.set(goal.id, goal);
  }

  const missionMap = new Map<string, TelosMission>();
  for (const mission of missions) {
    missionMap.set(mission.id, mission);
  }

  // Backfill mission names on goals from mission data
  for (const goal of goals) {
    if (goal.missionId && !goal.missionName) {
      const mission = missionMap.get(goal.missionId);
      if (mission) {
        goal.missionName = mission.name;
      }
    }
  }

  _cached = { goals, missions, goalMap, missionMap };
  _cacheTime = now;

  return _cached;
}

/**
 * Get a specific goal by ID
 */
export function getGoal(goalId: string): TelosGoal | undefined {
  const data = loadTelosData();
  return data.goalMap.get(goalId);
}

/**
 * Get a specific mission by ID
 */
export function getMission(missionId: string): TelosMission | undefined {
  const data = loadTelosData();
  return data.missionMap.get(missionId);
}

/**
 * Get the mission for a given goal
 */
export function getMissionForGoal(goalId: string): TelosMission | undefined {
  const goal = getGoal(goalId);
  if (!goal) return undefined;
  return getMission(goal.missionId);
}

/**
 * Get all goals for a specific mission
 */
export function getGoalsForMission(missionId: string): TelosGoal[] {
  const data = loadTelosData();
  return data.goals.filter((g) => g.missionId === missionId);
}

/**
 * Get all goal IDs (for validation)
 */
export function getAllGoalIds(): string[] {
  const data = loadTelosData();
  return data.goals.map((g) => g.id);
}

/**
 * Clear the cache (useful for testing)
 */
export function clearCache(): void {
  _cached = null;
  _cacheTime = 0;
}

// ============================================================================
// CLI Interface
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];
  const jsonMode = args.includes("--json");

  try {
    const data = loadTelosData();

    if (command === "goals" || (!command && !jsonMode)) {
      if (jsonMode) {
        console.log(JSON.stringify(data.goals, null, 2));
      } else {
        console.log(`\nTELOS Goals (${data.goals.length}):\n`);
        for (const goal of data.goals) {
          const mission = goal.missionId ? ` [${goal.missionId}: ${goal.missionName}]` : "";
          console.log(`  ${goal.id.padEnd(5)} ${goal.title}${mission}`);
          if (goal.status !== "In Progress") {
            console.log(`         Status: ${goal.status}`);
          }
        }
        console.log("");
      }
    } else if (command === "missions") {
      if (jsonMode) {
        console.log(JSON.stringify(data.missions, null, 2));
      } else {
        console.log(`\nTELOS Missions (${data.missions.length}):\n`);
        for (const mission of data.missions) {
          console.log(`  ${mission.id}: ${mission.name}`);
          console.log(`     Focus: ${mission.focus}`);
          console.log(`     Goals: ${mission.goalIds.join(", ")}`);
          console.log("");
        }
      }
    } else if (command === "goal" && args[1]) {
      const goal = data.goalMap.get(args[1]);
      if (goal) {
        if (jsonMode) {
          console.log(JSON.stringify(goal, null, 2));
        } else {
          console.log(`\n${goal.id}: ${goal.title}`);
          console.log(`  Status:      ${goal.status}`);
          console.log(`  Mission:     ${goal.missionId} (${goal.missionName})`);
          console.log("");
        }
      } else {
        console.error(`Goal not found: ${args[1]}`);
        process.exit(1);
      }
    } else if (jsonMode) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      // Default: show summary
      console.log(`\nTELOS Data Loaded:`);
      console.log(`  Goals:    ${data.goals.length}`);
      console.log(`  Missions: ${data.missions.length}`);
      console.log("");

      console.log("Goals:");
      for (const goal of data.goals) {
        const mission = goal.missionId ? ` [${goal.missionId}: ${goal.missionName}]` : "";
        console.log(`  ${goal.id.padEnd(5)} ${goal.title}${mission}`);
      }

      console.log("\nMissions:");
      for (const mission of data.missions) {
        console.log(`  ${mission.id}: ${mission.name} (${mission.goalIds.length} goals)`);
      }
      console.log("");
    }
  } catch (err) {
    console.error(`Error loading TELOS data: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
