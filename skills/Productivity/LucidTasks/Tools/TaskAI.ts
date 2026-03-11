#!/usr/bin/env bun
/**
 * TaskAI.ts - AI Intelligence Layer for LucidTasks
 *
 * Provides four AI-powered capabilities via the Inference.ts tiered engine:
 *  5.1 Natural language task extraction (Haiku/fast)
 *  5.2 Task decomposition into 3-7 subtasks (Sonnet/standard)
 *  5.3 AI-enhanced priority scoring (Sonnet/standard)
 *  5.4 Weekly Opus review with strategic analysis (Opus/smart)
 *
 * All AI operations are opt-in and gracefully degrade on failure.
 * The deterministic scorer in TaskManager.ts is never replaced — AI augments only.
 *
 * @module TaskAI
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { inference } from "../../../../lib/core/Inference.ts";
import type { InferenceLevel } from "../../../../lib/core/Inference.ts";
import type { Task } from "./TaskDB.ts";

// ============================================================================
// Configuration
// ============================================================================

const KAYA_HOME = process.env.KAYA_HOME || join(process.env.HOME || "", ".claude");
const TRUST_CONFIG_PATH = join(KAYA_HOME, "skills/Productivity/LucidTasks/TrustConfig.yaml");

// ============================================================================
// TrustConfig
// ============================================================================

export interface TrustConfig {
  copilot: {
    extract_metadata: boolean;
    suggest_decomposition: boolean;
    suggest_priority: boolean;
    weekly_review: boolean;
  };
  autopilot: {
    auto_extract: boolean;
    auto_decompose: boolean;
    auto_prioritize: boolean;
    reschedule_overdue: boolean;
  };
}

const DEFAULT_TRUST_CONFIG: TrustConfig = {
  copilot: {
    extract_metadata: true,
    suggest_decomposition: true,
    suggest_priority: true,
    weekly_review: true,
  },
  autopilot: {
    auto_extract: false,
    auto_decompose: false,
    auto_prioritize: false,
    reschedule_overdue: false,
  },
};

/**
 * Load TrustConfig.yaml from disk.
 * Falls back to conservative defaults (all copilot, no autopilot) if missing or malformed.
 */
export function loadTrustConfig(): TrustConfig {
  if (!existsSync(TRUST_CONFIG_PATH)) {
    return DEFAULT_TRUST_CONFIG;
  }

  try {
    // Inline YAML parsing for the simple key: value structure used in TrustConfig
    const content = readFileSync(TRUST_CONFIG_PATH, "utf-8");
    const config: TrustConfig = JSON.parse(JSON.stringify(DEFAULT_TRUST_CONFIG));

    let currentSection: "copilot" | "autopilot" | null = null;
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith("#") || line === "") continue;

      if (line === "copilot:") {
        currentSection = "copilot";
        continue;
      }
      if (line === "autopilot:") {
        currentSection = "autopilot";
        continue;
      }

      if (currentSection) {
        const match = line.match(/^(\w+):\s*(true|false)/);
        if (match) {
          const key = match[1];
          const value = match[2] === "true";
          const section = config[currentSection] as Record<string, boolean>;
          if (key in section) {
            section[key] = value;
          }
        }
      }
    }

    return config;
  } catch {
    return DEFAULT_TRUST_CONFIG;
  }
}

// ============================================================================
// 5.1 Natural Language Task Extraction
// ============================================================================

export interface ExtractionContext {
  today: string;
  goalIds: string[];
  projectNames: string[];
}

const ExtractedTaskSchema = z.object({
  title: z.string().min(1),
  due_date: z.string().nullable().optional(),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable().optional(),
  energy_level: z.enum(["low", "medium", "high"]).nullable().optional(),
  estimated_minutes: z.number().int().positive().nullable().optional(),
  goal_id: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  context_tags: z.array(z.string()).optional(),
});

type ExtractedTask = z.infer<typeof ExtractedTaskSchema>;

const EXTRACTION_SYSTEM_PROMPT = `You extract structured task data from natural language input.

Output a single JSON object matching this schema exactly:
{
  "title": string,             // Clean imperative title, concise (remove filler words)
  "due_date": string | null,   // ISO date YYYY-MM-DD if mentioned, else null
  "priority": 1 | 2 | 3 | null, // 1=high/urgent, 2=normal, 3=low. Infer from urgency cues
  "energy_level": "low" | "medium" | "high" | null, // Infer from task nature
  "estimated_minutes": number | null, // Infer from task complexity (15-480 range)
  "goal_id": string | null,    // Match to provided goal IDs if relevant, else null
  "project_id": string | null, // Match to provided project names if relevant, else null
  "context_tags": string[]     // Context tags like "@home", "@work", "@errands"
}

Rules:
- title must be an imperative verb phrase (e.g., "Call dentist" not "calling dentist")
- If no date is explicitly or clearly implied, set due_date to null
- "tomorrow" = next calendar day from today's date provided
- "next week" = Monday of next calendar week
- Only set goal_id if the task clearly relates to one of the provided goals
- Output ONLY the JSON object, no explanation`;

/**
 * Extract structured task metadata from natural language using Haiku (fast tier).
 * Falls back to raw title passthrough if AI fails.
 */
export async function extractTaskMetadata(
  rawInput: string,
  context: ExtractionContext
): Promise<ExtractedTask> {
  const userPrompt = `Current date: ${context.today}
Available goals: ${context.goalIds.join(", ") || "none"}
Available projects: ${context.projectNames.join(", ") || "none"}

Task input: "${rawInput}"`;

  try {
    const result = await inference({
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      userPrompt,
      level: "fast",
      expectJson: true,
    });

    if (!result.success || !result.parsed) {
      return { title: rawInput };
    }

    // Validate with Zod
    const parsed = ExtractedTaskSchema.safeParse(result.parsed);
    if (!parsed.success) {
      return { title: rawInput };
    }

    return parsed.data;
  } catch {
    return { title: rawInput };
  }
}

// ============================================================================
// 5.2 Task Decomposition
// ============================================================================

interface DecompositionContext {
  projectName?: string;
  goalDescription?: string;
}

const SubtaskProposalSchema = z.object({
  title: z.string().min(1),
  estimated_minutes: z.number().int().min(15).max(120),
  energy_level: z.enum(["low", "medium", "high"]),
});

type SubtaskProposal = z.infer<typeof SubtaskProposalSchema>;

const DecompositionOutputSchema = z.object({
  simple: z.boolean().optional(),
  message: z.string().optional(),
  subtasks: z.array(SubtaskProposalSchema).optional(),
});

type DecompositionOutput = z.infer<typeof DecompositionOutputSchema>;

const DECOMPOSITION_SYSTEM_PROMPT = `You decompose complex tasks into 3-7 specific, actionable subtasks.

Output a single JSON object:
{
  "simple": boolean,          // true if task is too simple to decompose
  "message": string | null,   // explanation if simple=true, else null
  "subtasks": [               // 3-7 subtasks if simple=false
    {
      "title": string,            // Imperative, specific action
      "estimated_minutes": number, // 15-120 minutes each
      "energy_level": "low" | "medium" | "high"
    }
  ]
}

Rules:
- Each subtask must be completable independently in one sitting (15-120 minutes)
- Subtasks should follow a logical order (e.g., research before implementation)
- Min 3, max 7 subtasks
- If the task is already simple (< 30 min single action), set simple=true
- Output ONLY the JSON object, no explanation`;

/**
 * Decompose a complex task into 3-7 actionable subtasks using Sonnet (standard tier).
 * Returns null if the task is too simple or AI fails.
 */
export async function decomposeTask(
  task: Task,
  context: DecompositionContext
): Promise<{ simple: true; message: string } | { simple: false; subtasks: SubtaskProposal[] } | null> {
  const userPrompt = `Task: "${task.title}"
Description: "${task.description || "none"}"
Project: ${context.projectName || "none"}
Goal: ${context.goalDescription || "none"}
Estimated time: ${task.estimated_minutes ? `${task.estimated_minutes} minutes` : "unknown"}`;

  try {
    const result = await inference({
      systemPrompt: DECOMPOSITION_SYSTEM_PROMPT,
      userPrompt,
      level: "standard",
      expectJson: true,
    });

    if (!result.success || !result.parsed) {
      return null;
    }

    const parsed = DecompositionOutputSchema.safeParse(result.parsed);
    if (!parsed.success) {
      return null;
    }

    const output: DecompositionOutput = parsed.data;

    if (output.simple === true) {
      return { simple: true, message: output.message || "Task is simple enough to complete directly." };
    }

    const subtasks = output.subtasks;
    if (!subtasks || subtasks.length < 3) {
      return { simple: true, message: "Task is simple enough to complete directly." };
    }

    // Cap at 7 subtasks
    return { simple: false, subtasks: subtasks.slice(0, 7) };
  } catch {
    return null;
  }
}

// ============================================================================
// 5.3 AI-Enhanced Priority Scoring
// ============================================================================

export interface ScoredTaskInput {
  id: string;
  title: string;
  priority: number;
  due_date: string | null;
  goal_id: string | null;
  project_id: string | null;
  energy_level: string | null;
  deterministic_score: number;
  reasons: string[];
}

interface AIScoredTask {
  id: string;
  adjustment: number;        // Clamped to [-20, +20]
  ai_reasoning: string;      // 1-2 sentence explanation, max 100 chars
  final_score: number;       // deterministic_score + adjustment
}

export interface AIScoringContext {
  tasks: ScoredTaskInput[];
  activeGoals: Array<{ id: string; title: string; status: string }>;
  recentCompletions: number;
  currentTime: string;
}

const AIScoredTaskArraySchema = z.array(
  z.object({
    id: z.string(),
    adjustment: z.number(),
    ai_reasoning: z.string(),
  })
);

const SCORING_SYSTEM_PROMPT = `You are a priority scoring assistant. Given a batch of tasks with their deterministic scores, provide small score adjustments (-20 to +20) based on qualitative factors the algorithm can't see.

Consider:
- Goal alignment and strategic importance
- Blocking dependencies (tasks blocking others get +adjustment)
- Collaboration impact (tasks affecting teammates get boost)
- Momentum and context switching costs
- Pattern recognition (tasks repeatedly deferred need attention)

Output a JSON array:
[
  {
    "id": "task-id",
    "adjustment": number,      // Integer -20 to +20
    "ai_reasoning": "string"   // 1-2 sentences, max 100 chars, no "I think" or "Based on"
  }
]

Rules:
- adjustment must be an integer between -20 and +20
- ai_reasoning max 100 characters
- Include ALL tasks from the input in output
- Output ONLY the JSON array, no explanation`;

/**
 * Score a batch of tasks with AI adjustments using Sonnet (standard tier).
 * Batches up to 10 tasks per inference call.
 * Adjustments are clamped to [-20, +20].
 */
export async function scoreTasksWithAI(
  tasks: ScoredTaskInput[],
  context: AIScoringContext
): Promise<AIScoredTask[]> {
  if (tasks.length === 0) return [];

  const BATCH_SIZE = 10;
  const results: AIScoredTask[] = [];

  for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
    const batch = tasks.slice(i, i + BATCH_SIZE);

    const userPrompt = `Current time: ${context.currentTime}
Recent completions (last 7 days): ${context.recentCompletions}
Active goals: ${context.activeGoals.map((g) => `${g.id}: ${g.title}`).join(", ") || "none"}

Tasks to score:
${JSON.stringify(
  batch.map((t) => ({
    id: t.id,
    title: t.title,
    priority: t.priority,
    due_date: t.due_date,
    goal_id: t.goal_id,
    project_id: t.project_id,
    energy_level: t.energy_level,
    deterministic_score: t.deterministic_score,
    score_reasons: t.reasons.join(", "),
  })),
  null,
  2
)}`;

    try {
      const result = await inference({
        systemPrompt: SCORING_SYSTEM_PROMPT,
        userPrompt,
        level: "standard",
        expectJson: false, // We'll parse arrays manually
      });

      if (result.success) {
        // Find JSON array in response
        const arrayMatch = result.output.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          const rawParsed = JSON.parse(arrayMatch[0]) as unknown;
          const parsed = AIScoredTaskArraySchema.safeParse(rawParsed);
          if (parsed.success) {
            for (const scored of parsed.data) {
              const originalTask = batch.find((t) => t.id === scored.id);
              if (!originalTask) continue;

              // Clamp adjustment to [-20, +20]
              const adjustment = Math.max(-20, Math.min(20, Math.round(scored.adjustment)));
              // Truncate reasoning to 100 chars
              const reasoning = scored.ai_reasoning.slice(0, 100);

              results.push({
                id: scored.id,
                adjustment,
                ai_reasoning: reasoning,
                final_score: originalTask.deterministic_score + adjustment,
              });
            }
            continue;
          }
        }
      }
    } catch {
      // Fallback: return tasks with zero adjustment
    }

    // Fallback for failed batch: zero adjustment
    for (const task of batch) {
      results.push({
        id: task.id,
        adjustment: 0,
        ai_reasoning: "AI scoring unavailable",
        final_score: task.deterministic_score,
      });
    }
  }

  return results;
}

// ============================================================================
// 5.4 Weekly Opus Review
// ============================================================================

export interface ReviewData {
  period: { start: string; end: string };
  completedTasks: Array<{
    id: string;
    title: string;
    goal_id: string | null;
    project_id: string | null;
    estimated_minutes: number | null;
  }>;
  addedTasks: Array<{ id: string; title: string; goal_id: string | null }>;
  overdueTasks: Array<{ id: string; title: string; due_date: string; goal_id: string | null }>;
  activeGoals: Array<{ id: string; title: string; status: string }>;
  stats: {
    total: number;
    completedThisWeek: number;
    overdue: number;
    byStatus: Record<string, number>;
  };
}

export interface WeeklyReview {
  period: { start: string; end: string };
  summary: {
    completed: number;
    added: number;
    overdue: number;
    velocity_trend: "increasing" | "stable" | "decreasing";
  };
  goalProgress: Array<{
    goalId: string;
    goalTitle: string;
    tasksCompleted: number;
    tasksRemaining: number;
    assessment: string;
  }>;
  insights: string[];
  recommendations: string[];
  focusAreas: string[];
}

const WeeklyReviewSchema = z.object({
  period: z.object({
    start: z.string(),
    end: z.string(),
  }),
  summary: z.object({
    completed: z.number().int(),
    added: z.number().int(),
    overdue: z.number().int(),
    velocity_trend: z.enum(["increasing", "stable", "decreasing"]),
  }),
  goalProgress: z.array(
    z.object({
      goalId: z.string(),
      goalTitle: z.string(),
      tasksCompleted: z.number().int(),
      tasksRemaining: z.number().int(),
      assessment: z.string(),
    })
  ),
  insights: z.array(z.string()).min(1).max(5),
  recommendations: z.array(z.string()).min(1).max(5),
  focusAreas: z.array(z.string()).min(1).max(3),
});

const REVIEW_SYSTEM_PROMPT = `You are a strategic productivity advisor doing a weekly task review.

Analyze the provided task data and generate an insightful weekly review.

Output a single JSON object:
{
  "period": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
  "summary": {
    "completed": number,
    "added": number,
    "overdue": number,
    "velocity_trend": "increasing" | "stable" | "decreasing"
  },
  "goalProgress": [
    {
      "goalId": "G25",
      "goalTitle": "string",
      "tasksCompleted": number,
      "tasksRemaining": number,
      "assessment": "string"  // 1 sentence, specific, actionable
    }
  ],
  "insights": ["string", ...],          // 3-5 specific observations referencing actual tasks/goals
  "recommendations": ["string", ...],   // 3-5 actionable suggestions with specific task/goal references
  "focusAreas": ["string", ...]         // Top 2-3 areas for next week
}

Rules:
- insights must reference specific tasks or goals by name
- recommendations must be actionable (start with a verb)
- velocity_trend: "increasing" if this week > last week, "decreasing" if fewer, "stable" if similar
- If 0 completions this week, insights should focus on patterns that led to low completion
- Output ONLY the JSON object, no explanation`;

/**
 * Generate a weekly strategic review using Opus (smart tier).
 * Returns null on failure.
 */
export async function generateWeeklyReview(data: ReviewData): Promise<WeeklyReview | null> {
  const userPrompt = `Review Period: ${data.period.start} to ${data.period.end}

Completed Tasks (${data.completedTasks.length}):
${
  data.completedTasks.length > 0
    ? data.completedTasks.map((t) => `  - "${t.title}" [goal:${t.goal_id || "none"}, est:${t.estimated_minutes || "?"}min]`).join("\n")
    : "  (none)"
}

Added Tasks (${data.addedTasks.length}):
${
  data.addedTasks.length > 0
    ? data.addedTasks.map((t) => `  - "${t.title}" [goal:${t.goal_id || "none"}]`).join("\n")
    : "  (none)"
}

Overdue Tasks (${data.overdueTasks.length}):
${
  data.overdueTasks.length > 0
    ? data.overdueTasks.map((t) => `  - "${t.title}" [due:${t.due_date}, goal:${t.goal_id || "none"}]`).join("\n")
    : "  (none)"
}

Active Goals (${data.activeGoals.length}):
${
  data.activeGoals.length > 0
    ? data.activeGoals.map((g) => `  - ${g.id}: "${g.title}"`).join("\n")
    : "  (none)"
}

Stats:
  Total tasks in system: ${data.stats.total}
  Completed this week: ${data.stats.completedThisWeek}
  Overdue: ${data.stats.overdue}
  By status: ${JSON.stringify(data.stats.byStatus)}`;

  try {
    const result = await inference({
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      userPrompt,
      level: "smart",
      expectJson: true,
    });

    if (!result.success || !result.parsed) {
      return null;
    }

    const parsed = WeeklyReviewSchema.safeParse(result.parsed);
    if (!parsed.success) {
      // Try once more with the raw output if expectJson JSON detection failed
      const jsonMatch = result.output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const rawParsed = JSON.parse(jsonMatch[0]) as unknown;
          const retryParsed = WeeklyReviewSchema.safeParse(rawParsed);
          if (retryParsed.success) {
            return retryParsed.data;
          }
        } catch {
          // fall through to null
        }
      }
      return null;
    }

    return parsed.data;
  } catch {
    return null;
  }
}

// ============================================================================
// Review Output Formatter
// ============================================================================

/**
 * Format a WeeklyReview into human-readable text output.
 */
export function formatWeeklyReview(review: WeeklyReview): string {
  const lines: string[] = [];

  lines.push(`\nWeekly Review: ${review.period.start} - ${review.period.end}`);
  lines.push("");

  lines.push("Summary:");
  lines.push(`  Completed: ${review.summary.completed} tasks | Added: ${review.summary.added} tasks | Overdue: ${review.summary.overdue}`);
  lines.push(`  Velocity: ${review.summary.velocity_trend}`);
  lines.push("");

  if (review.goalProgress.length > 0) {
    lines.push("Goal Progress:");
    for (const gp of review.goalProgress) {
      const total = gp.tasksCompleted + gp.tasksRemaining;
      lines.push(`  ${gp.goalId} ${gp.goalTitle}:  ${gp.tasksCompleted}/${total} tasks done  "${gp.assessment}"`);
    }
    lines.push("");
  }

  if (review.insights.length > 0) {
    lines.push("Insights:");
    for (let i = 0; i < review.insights.length; i++) {
      lines.push(`  ${i + 1}. ${review.insights[i]}`);
    }
    lines.push("");
  }

  if (review.recommendations.length > 0) {
    lines.push("Recommendations:");
    for (let i = 0; i < review.recommendations.length; i++) {
      lines.push(`  ${i + 1}. ${review.recommendations[i]}`);
    }
    lines.push("");
  }

  if (review.focusAreas.length > 0) {
    lines.push("Focus Areas Next Week:");
    for (let i = 0; i < review.focusAreas.length; i++) {
      lines.push(`  ${i + 1}. ${review.focusAreas[i]}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
