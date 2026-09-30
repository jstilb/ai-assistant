#!/usr/bin/env bun
/**
 * GoalConnector - Link insights to TELOS goals
 *
 * Parses the TELOS structure (G0-G36, M0-M6, WIGs, Strategies) and provides
 * relevance scoring between insights/learnings and life goals.
 *
 * Features:
 * - Parse TELOS GOALS.md and MISSIONS.md structure
 * - Match insights to relevant goals using semantic analysis
 * - Calculate goal relevance scores
 * - Track goal-connected learnings over time
 * - Generate goal-focused briefings
 *
 * Commands:
 *   --list-goals     List all parsed goals with their metadata
 *   --list-missions  List all missions
 *   --connect TEXT   Find goals related to given text
 *   --goal ID        Show details for a specific goal (e.g., G0, G25)
 *   --mission ID     Show details for a specific mission (e.g., M0, M6)
 *   --json           Output as JSON
 *
 * Examples:
 *   bun run GoalConnector.ts --list-goals
 *   bun run GoalConnector.ts --connect "learning TypeScript patterns"
 *   bun run GoalConnector.ts --goal G28 --json
 */

import { parseArgs } from "util";
import { existsSync } from "fs";
import * as path from "path";
import { z } from "zod";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { loadTelosGoals, renderSupportsLabel } from "../../../../lib/core/TelosGoals.ts";
import type { InferenceOptions, InferenceResult } from "../../../../lib/core/Inference.ts";

/**
 * Inference function seam. Defaults to the live `inference` from Inference.ts;
 * tests inject a stub (e.g. one that throws) to force the deterministic keyword
 * fallback so `connectToGoals` never makes a live LLM call.
 */
export type GoalInferenceFn = (opts: InferenceOptions) => Promise<InferenceResult>;

// ============================================================================
// Configuration
// ============================================================================

const CLAUDE_DIR = getKayaHome();
const TELOS_DIR = path.join(CLAUDE_DIR, "USER", "TELOS");
const MISSIONS_FILE = path.join(TELOS_DIR, "MISSIONS.md");
const STRATEGIES_FILE = path.join(TELOS_DIR, "STRATEGIES.md");

// ============================================================================
// Types
// ============================================================================

export interface Goal {
  id: string;
  title: string;
  status: string;
  /** Supports label, e.g. "M6 (Self)" — callers split(" ")[0] for the id. */
  supports: string;
  isWIG: boolean;
  section: string;
}

export interface Mission {
  id: string;
  name: string;
  definition: string;
  focus: string;
  theme2026: string;
  goalIds: string[];
}

export interface Strategy {
  id: string;
  name: string;
  description: string;
  relatedGoals: string[];
}

export interface GoalConnection {
  goalId: string;
  goalTitle: string;
  missionId: string;
  missionName: string;
  relevanceScore: number;
  matchedKeywords: string[];
  reason: string;
}

export interface TelosContext {
  goals: Goal[];
  missions: Mission[];
  strategies: Strategy[];
}

// ============================================================================
// Keyword Mappings
// ============================================================================

const GOAL_KEYWORDS: Record<string, string[]> = {
  // M0: Adventurer
  G3: ["tijuana", "mexico", "travel", "border"],
  G4: ["mexico city", "cdmx", "travel", "international"],
  G5: ["countries", "international", "travel", "passport", "abroad"],
  G6: ["national park", "nature", "hiking", "outdoors", "camping"],

  // M1: Community Member
  G7: ["dsa", "politics", "democratic socialists", "organizing", "activism"],
  G8: ["volleyball", "vball", "sports", "team", "league"],
  G9: ["surf", "surfing", "ocean", "beach", "waves"],
  G10: ["writing", "writers", "workshop", "creative writing", "authors"],
  G11: ["music", "musicians", "band", "concerts", "jam"],
  G12: ["professional", "networking", "industry", "career", "tech community"],

  // M2: Creative
  G13: ["on set", "novel", "draft", "manuscript", "book 1", "draft 2"],
  G14: ["on set", "novel", "draft 3", "manuscript", "revision"],
  G15: ["book 2", "second novel", "new book", "draft 1"],
  G16: ["short story", "publish", "fiction", "magazine", "literary"],
  G17: ["writing", "rewrite", "draft", "prose", "craft"],
  G18: ["piano", "practice", "music", "instrument", "keyboard"],

  // M3: Family Man
  G19: ["therapy", "family therapy", "mental health", "counseling"],
  G20: ["julie", "partner", "relationship", "marriage", "spouse"],

  // M4: Friend
  G1: ["friends", "friendship", "social", "connection", "buddy"],
  G21: ["friends", "friendship", "meaningful", "close friends"],
  G22: ["acquaintance", "community", "networking", "social"],
  G23: ["boys trip", "guys trip", "vacation", "annual trip"],
  G24: ["calling", "phone", "staying in touch", "long distance"],

  // M5: Professional
  G25: ["lucidview", "application", "beta", "app", "product", "startup"],
  G26: ["cofounder", "co-founder", "partner", "startup", "business partner"],
  G27: ["promotion", "career", "advancement", "job", "role"],
  G28: ["ai", "artificial intelligence", "machine learning", "claude", "llm", "gpt", "tools"],

  // M6: Self
  G0: ["media consumption", "screen time", "distraction", "phone", "scrolling"],
  G2: ["alignment", "score", "tracking", "productivity", "focus"],
  G29: ["noise", "media", "excessive", "distraction"],
  G30: ["valuable media", "learning", "educational", "quality content"],
  G31: ["meaningful", "time", "energy", "purpose"],
  G32: ["dtr", "daily tracking", "habits", "routine", "system"],
  G33: ["back", "injury", "pain", "physical therapy", "spine"],
  G34: ["shoulder", "injury", "pt", "physical therapy"],
  G35: ["stretching", "flexibility", "mobility", "yoga"],
  G36: ["eating", "diet", "nutrition", "unhealthy", "food"],
};

const MISSION_KEYWORDS: Record<string, string[]> = {
  M0: ["adventure", "travel", "explore", "wander", "journey", "discover"],
  M1: ["community", "local", "neighbor", "volunteer", "activism", "civic"],
  M2: ["creative", "art", "write", "music", "craft", "express", "create"],
  M3: ["family", "home", "partner", "relationship", "parent", "support"],
  M4: ["friend", "friendship", "social", "connect", "hangout", "buddy"],
  M5: ["professional", "career", "work", "job", "startup", "business", "tech"],
  M6: ["self", "personal", "health", "growth", "mindset", "wellness", "habit"],
};

// ============================================================================
// Parser Functions
// ============================================================================

export function parseMissions(content: string): Mission[] {
  const missions: Mission[] = [];
  const lines = content.split("\n");

  let currentMission: Partial<Mission> | null = null;
  let currentField = "";

  for (const line of lines) {
    // Parse mission headers
    if (line.startsWith("### M")) {
      // Save previous mission
      if (currentMission?.id) {
        missions.push(currentMission as Mission);
      }

      const match = line.match(/### (M\d+): (.+)/);
      if (match) {
        currentMission = {
          id: match[1],
          name: match[2],
          definition: "",
          focus: "",
          theme2026: "",
          goalIds: [],
        };
      }
    }

    if (currentMission) {
      if (line.startsWith("**Definition:**")) {
        currentMission.definition = line.replace("**Definition:**", "").trim();
      }
      if (line.startsWith("**Focus:**")) {
        currentMission.focus = line.replace("**Focus:**", "").trim();
      }
      if (line.startsWith("**2026 Theme:**")) {
        currentMission.theme2026 = line.replace("**2026 Theme:**", "").trim();
      }
    }
  }

  // Don't forget the last mission
  if (currentMission?.id) {
    missions.push(currentMission as Mission);
  }

  // Extract goal IDs from goal mapping section
  const mappingMatch = content.match(/## Mission → Goal Mapping[\s\S]*?\|[\s\S]*?\|([\s\S]*?)---/);
  if (mappingMatch) {
    const tableRows = mappingMatch[1].split("\n").filter((l) => l.includes("|"));
    for (const row of tableRows) {
      const parts = row.split("|").map((p) => p.trim());
      if (parts.length >= 3) {
        const missionMatch = parts[1].match(/M(\d+)/);
        const goalsText = parts[2];
        if (missionMatch) {
          const mission = missions.find((m) => m.id === `M${missionMatch[1]}`);
          if (mission) {
            const goalMatches = goalsText.match(/G\d+/g);
            if (goalMatches) {
              mission.goalIds = goalMatches;
            }
          }
        }
      }
    }
  }

  return missions;
}

// ============================================================================
// Connection Logic
// ============================================================================

export async function loadTelosContext(): Promise<TelosContext> {
  const context: TelosContext = {
    goals: [],
    missions: [],
    strategies: [],
  };

  // Goals come from the structured source (goals.yaml) — the GOALS.md regex
  // parser was deleted 2026-08-02 (markdown-regex remediation, option (b)).
  // loadTelosGoals throws loud on a missing/invalid source.
  context.goals = loadTelosGoals().goals.map((g) => ({
    id: g.id,
    title: g.title,
    status: g.status,
    supports: renderSupportsLabel(g.supports),
    isWIG: g.sectionWig,
    section: g.sectionHeading.replace(/^## /, ""),
  }));

  if (existsSync(MISSIONS_FILE)) {
    const content = await Bun.file(MISSIONS_FILE).text();
    context.missions = parseMissions(content);
  }

  return context;
}

// Zod schema for goal connection inference result
const GoalConnectionInferenceSchema = z.array(z.object({
  goalId: z.string(),
  relevanceScore: z.number().min(0).max(1),
  reason: z.string(),
}));

export async function connectToGoals(
  text: string,
  context?: TelosContext,
  opts?: { inferenceFn?: GoalInferenceFn },
): Promise<GoalConnection[]> {
  const ctx = context || await loadTelosContext();
  if (ctx.goals.length === 0) return [];

  // Try LLM inference first. The inference dependency is injectable via
  // opts.inferenceFn so callers (tests) can force the deterministic keyword
  // fallback below instead of making a live, non-deterministic LLM call.
  try {
    const inference = opts?.inferenceFn ?? (await import('../../../../lib/core/Inference.ts')).inference;

    // Build compact goal manifest for the prompt
    const goalManifest = ctx.goals.map(g => {
      const missionId = g.supports.split(" ")[0];
      const mission = ctx.missions.find(m => m.id === missionId);
      return `${g.id}: ${g.title} (${missionId}: ${mission?.name || 'Unknown'})`;
    }).join('\n');

    const result = await inference({
      systemPrompt: `You are a personal goal alignment analyzer. Given text and a list of life goals, identify which goals are relevant.

Goals:
${goalManifest}

Return JSON array only: [{ "goalId": "G28", "relevanceScore": 0.85, "reason": "brief explanation" }]
Return empty array [] if no goals are relevant. Score 0.0-1.0. Max 5 goals.`,
      userPrompt: text,
      level: 'standard',
      expectJson: true,
      timeout: 30000,
    });

    if (result.success && result.parsed) {
      const parsed = GoalConnectionInferenceSchema.safeParse(result.parsed);
      if (parsed.success && parsed.data.length > 0) {
        return parsed.data
          .map(item => {
            const goal = ctx.goals.find(g => g.id === item.goalId);
            if (!goal) return null;
            const missionId = goal.supports.split(" ")[0];
            const mission = ctx.missions.find(m => m.id === missionId);
            return {
              goalId: item.goalId,
              goalTitle: goal.title,
              missionId,
              missionName: mission?.name || goal.supports,
              relevanceScore: item.relevanceScore,
              matchedKeywords: [],
              reason: item.reason,
            };
          })
          .filter((c): c is GoalConnection => c !== null)
          .sort((a, b) => b.relevanceScore - a.relevanceScore);
      }
    }
  } catch {
    // Fall through to keyword fallback
  }

  return _connectToGoalsKeyword(text, ctx);
}

/** Keyword-based fallback for goal connection (used when inference fails) */
function _connectToGoalsKeyword(text: string, ctx: TelosContext): GoalConnection[] {
  const connections: GoalConnection[] = [];
  const textLower = text.toLowerCase();

  for (const goal of ctx.goals) {
    const keywords = GOAL_KEYWORDS[goal.id] || [];
    const matchedKeywords: string[] = [];

    for (const keyword of keywords) {
      if (textLower.includes(keyword.toLowerCase())) {
        matchedKeywords.push(keyword);
      }
    }

    const titleWords = goal.title.toLowerCase().split(/\s+/);
    for (const word of titleWords) {
      if (word.length > 3 && textLower.includes(word) && !matchedKeywords.includes(word)) {
        matchedKeywords.push(word);
      }
    }

    if (matchedKeywords.length > 0) {
      const mission = ctx.missions.find((m) => m.id === goal.supports.split(" ")[0]);
      connections.push({
        goalId: goal.id,
        goalTitle: goal.title,
        missionId: goal.supports.split(" ")[0],
        missionName: mission?.name || goal.supports,
        relevanceScore: Math.min(1, matchedKeywords.length * 0.3),
        matchedKeywords,
        reason: `Matched keywords: ${matchedKeywords.join(", ")}`,
      });
    }
  }

  // Mission-level fallback
  for (const mission of ctx.missions) {
    const missionKeywords = MISSION_KEYWORDS[mission.id] || [];
    const matchedKeywords = missionKeywords.filter(kw => textLower.includes(kw.toLowerCase()));

    if (matchedKeywords.length > 0 && !connections.some(c => c.missionId === mission.id)) {
      const firstGoal = ctx.goals.find((g) => g.supports.startsWith(mission.id));
      if (firstGoal) {
        connections.push({
          goalId: firstGoal.id,
          goalTitle: firstGoal.title,
          missionId: mission.id,
          missionName: mission.name,
          relevanceScore: Math.min(0.8, matchedKeywords.length * 0.25),
          matchedKeywords,
          reason: `Mission-level match: ${matchedKeywords.join(", ")}`,
        });
      }
    }
  }

  return connections.sort((a, b) => b.relevanceScore - a.relevanceScore);
}

export async function getGoal(id: string, context?: TelosContext): Promise<Goal | undefined> {
  const ctx = context || await loadTelosContext();
  return ctx.goals.find((g) => g.id === id);
}

export async function getMission(id: string, context?: TelosContext): Promise<Mission | undefined> {
  const ctx = context || await loadTelosContext();
  return ctx.missions.find((m) => m.id === id);
}

export async function getGoalsByMission(missionId: string, context?: TelosContext): Promise<Goal[]> {
  const ctx = context || await loadTelosContext();
  return ctx.goals.filter((g) => g.supports.startsWith(missionId));
}

export async function getWIGs(context?: TelosContext): Promise<Goal[]> {
  const ctx = context || await loadTelosContext();
  return ctx.goals.filter((g) => g.isWIG);
}

// ============================================================================
// LLM result enrichment (SLIM-HYBRID: CLI accepts pre-scored connections from
// a workflow prompt and enriches them with deterministic goal metadata)
// ============================================================================

/** Raw item produced by the ConnectToGoals workflow prompt */
const WorkflowLlmItemSchema = z.object({
  goalId: z.string(),
  relevanceScore: z.number().min(0).max(1),
  reason: z.string(),
});

/**
 * Enrich LLM-scored goal IDs with full goal/mission metadata from the parsed
 * TELOS context. This is the deterministic scaffolding that remains after
 * lifting LLM judgment to Workflows/ConnectToGoals.md.
 */
export function enrichLlmConnections(
  rawItems: Array<{ goalId: string; relevanceScore: number; reason: string }>,
  ctx: TelosContext,
): GoalConnection[] {
  return rawItems
    .map((item) => {
      const goal = ctx.goals.find((g) => g.id === item.goalId);
      if (!goal) return null;
      const missionId = goal.supports.split(" ")[0];
      const mission = ctx.missions.find((m) => m.id === missionId);
      return {
        goalId: item.goalId,
        goalTitle: goal.title,
        missionId,
        missionName: mission?.name || goal.supports,
        relevanceScore: item.relevanceScore,
        matchedKeywords: [],
        reason: item.reason,
      };
    })
    .filter((c): c is GoalConnection => c !== null)
    .sort((a, b) => b.relevanceScore - a.relevanceScore);
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "list-goals": { type: "boolean" },
      "list-missions": { type: "boolean" },
      connect: { type: "string" },
      // Accept pre-scored JSON from workflow prompt (SLIM-HYBRID entry point)
      "llm-result": { type: "string" },
      goal: { type: "string" },
      mission: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
GoalConnector - Link insights to TELOS goals

Usage:
  bun run GoalConnector.ts --list-goals              List all goals
  bun run GoalConnector.ts --list-missions           List all missions
  bun run GoalConnector.ts --connect TEXT            Find goals (keyword fallback)
  bun run GoalConnector.ts --llm-result JSON         Enrich pre-scored LLM result
  bun run GoalConnector.ts --goal G28                Show goal details
  bun run GoalConnector.ts --mission M5              Show mission details
  bun run GoalConnector.ts --json                    Output as JSON

LLM-result format (from ConnectToGoals workflow prompt):
  '[{"goalId":"G28","relevanceScore":0.85,"reason":"..."}]'

Examples:
  bun run GoalConnector.ts --list-goals --json
  bun run GoalConnector.ts --connect "improving my AI workflow"
  bun run GoalConnector.ts --llm-result '[{"goalId":"G28","relevanceScore":0.9,"reason":"AI focus"}]'
  bun run GoalConnector.ts --goal G28
`);
    process.exit(0);
  }

  const context = await loadTelosContext();

  if (values["list-goals"]) {
    if (values.json) {
      console.log(JSON.stringify(context.goals, null, 2));
    } else {
      const byMission = new Map<string, Goal[]>();
      for (const goal of context.goals) {
        const missionId = goal.supports.split(" ")[0];
        const list = byMission.get(missionId) || [];
        list.push(goal);
        byMission.set(missionId, list);
      }
      for (const mission of context.missions) {
        const goals = byMission.get(mission.id) || [];
        console.log(`\n${mission.id}: ${mission.name} (${goals.length} goals)`);
        for (const g of goals) {
          console.log(`  ${g.id}: ${g.title}${g.isWIG ? " [WIG]" : ""}`);
        }
      }
    }
    return;
  }

  if (values["list-missions"]) {
    if (values.json) {
      console.log(JSON.stringify(context.missions, null, 2));
    } else {
      for (const m of context.missions) {
        console.log(`${m.id}: ${m.name} — ${m.focus}`);
      }
    }
    return;
  }

  // SLIM-HYBRID path: accept pre-scored connections from workflow prompt
  if (values["llm-result"]) {
    const rawParsed = JSON.parse(values["llm-result"]) as unknown;
    const validated = z.array(WorkflowLlmItemSchema).parse(rawParsed);
    const connections = enrichLlmConnections(validated, context);
    console.log(JSON.stringify(connections, null, 2));
    return;
  }

  // Keyword-only fallback for direct CLI use (no LLM call in CLI path)
  if (values.connect) {
    const connections = _connectToGoalsKeyword(values.connect, context);
    if (values.json) {
      console.log(JSON.stringify(connections, null, 2));
    } else {
      for (const c of connections.slice(0, 5)) {
        console.log(`${c.goalId} (${(c.relevanceScore * 100).toFixed(0)}%): ${c.goalTitle}`);
        console.log(`  Mission: ${c.missionId} - ${c.missionName}`);
        console.log(`  Reason: ${c.reason}`);
      }
      if (connections.length === 0) console.log("No goal connections found.");
    }
    return;
  }

  if (values.goal) {
    const goal = await getGoal(values.goal, context);
    if (!goal) {
      console.error(`Goal not found: ${values.goal}`);
      process.exit(1);
    }
    if (values.json) {
      console.log(JSON.stringify(goal, null, 2));
    } else {
      console.log(`${goal.id}: ${goal.title}`);
      console.log(`  Status: ${goal.status}`);
      console.log(`  Supports: ${goal.supports}${goal.isWIG ? " [WIG]" : ""}`);
    }
    return;
  }

  if (values.mission) {
    const mission = await getMission(values.mission, context);
    if (!mission) {
      console.error(`Mission not found: ${values.mission}`);
      process.exit(1);
    }
    if (values.json) {
      const goals = await getGoalsByMission(values.mission, context);
      console.log(JSON.stringify({ mission, goals }, null, 2));
    } else {
      console.log(`${mission.id}: ${mission.name}`);
      if (mission.focus) console.log(`  Focus: ${mission.focus}`);
      if (mission.theme2026) console.log(`  2026 Theme: ${mission.theme2026}`);
      const goals = await getGoalsByMission(values.mission, context);
      for (const g of goals) {
        console.log(`  ${g.id}: ${g.title}${g.isWIG ? " [WIG]" : ""}`);
      }
    }
    return;
  }

  // Default: show summary
  const ctx = context;
  console.log(`Missions: ${ctx.missions.length} | Goals: ${ctx.goals.length} | WIGs: ${ctx.goals.filter(g => g.isWIG).length}`);
  console.log(`Use --help for usage information.`);
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}
