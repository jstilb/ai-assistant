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
import { z } from "zod";
import { inference } from "../../../../lib/core/Inference.ts";
import type { InferenceLevel } from "../../../../lib/core/Inference.ts";
import { recordFailure } from "../../../../lib/core/FailureLog.ts";
import { kayaHomePath } from "../../../../lib/core/KayaHome.ts";
import type { Task, EstimateCalibration } from "./TaskDB.ts";

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
    auto_estimate: boolean;
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
    auto_estimate: false,
  },
};

/**
 * Load TrustConfig.yaml from disk.
 * Falls back to conservative defaults (all copilot, no autopilot) if missing or malformed.
 */
export function loadTrustConfig(): TrustConfig {
  const trustConfigPath = kayaHomePath("skills/Productivity/LucidTasks/TrustConfig.yaml");

  if (!existsSync(trustConfigPath)) {
    return DEFAULT_TRUST_CONFIG;
  }

  try {
    // Inline YAML parsing for the simple key: value structure used in TrustConfig
    const content = readFileSync(trustConfigPath, "utf-8");
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
  projectDescriptions?: Record<string, string>;
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

/**
 * extractTaskMetadata's return shape. `degraded` is an additive-only signal
 * (never present on a genuine success) so existing callers that only read
 * ExtractedTask's original fields keep compiling unchanged.
 */
export type ExtractedTaskResult = ExtractedTask & { degraded?: true };

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
- Match project by subject/outcome using its description, never by executor or capture source. "Kaya task" alone identifies the executor: only Kaya system work belongs in Kaya.
- Youtube is Jm's own channel production, not watching, Watch Later, or recommendation cleanup. Personal media hygiene belongs in Self; operating reviews/calibration in Meta; curation-system implementation in Kaya.
- Personal LifeOS plans/WIGs/reviews belong in Meta; LifeOS code/integrations belong in Kaya. Use specific subject projects before broad areas. Do not select the machine-escalation or legacy parking projects merely from needs-jm or someday intent.
- Select only an available project name; if the subject is unclear, leave project_id null.
- Output ONLY the JSON object, no explanation`;

/**
 * Extract structured task metadata from natural language using Haiku (fast tier).
 * Falls back to raw title passthrough if AI fails. TaskAI owns loud failure
 * reporting for this fallback: every degraded path below calls recordFailure
 * itself (never silent) and marks the return value `degraded: true` so
 * callers (TaskManager) can tell a genuine success from a fallback and never
 * claim "AI extracted" for a result the AI didn't actually produce.
 */
export async function extractTaskMetadata(
  rawInput: string,
  context: ExtractionContext
): Promise<ExtractedTaskResult> {
  const userPrompt = `Current date: ${context.today}
Available goals: ${context.goalIds.join(", ") || "none"}
Available projects: ${context.projectNames.join(", ") || "none"}
Project definitions: ${JSON.stringify(context.projectDescriptions ?? {})}

Task input: "${rawInput}"`;

  const degradedFallback = (reason: string): ExtractedTaskResult => {
    recordFailure({
      source: "TaskAI:extractTaskMetadata",
      error: reason,
      context: { rawInputLength: rawInput.length },
      tier: "log",
    });
    return { title: rawInput, degraded: true };
  };

  try {
    const result = await inference({
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      userPrompt,
      level: "fast",
      expectJson: true,
    });

    if (!result.success || !result.parsed) {
      return degradedFallback(result.error || "inference returned success:false");
    }

    // Validate with Zod
    const parsed = ExtractedTaskSchema.safeParse(result.parsed);
    if (!parsed.success) {
      return degradedFallback(`schema validation failed: ${parsed.error.message}`);
    }

    return parsed.data;
  } catch (err) {
    return degradedFallback(err instanceof Error ? err.message : String(err));
  }
}

// ============================================================================
// Effort estimation — energy + minutes, per actor (`tasks estimate`, morning cron)
// ============================================================================

export type EffortActor = "jm" | "kaya";

export interface EffortInput {
  id: string;
  title: string;
  description?: string;
  projectName?: string;
  status: string;
  priority: number;
  current_energy: string | null;
  current_minutes: number | null;
}

export interface EffortEstimate {
  id: string;
  energy_level: "low" | "medium" | "high";
  estimated_minutes: number;
  rationale: string;
}

const EffortEstimateArraySchema = z.array(
  z.object({
    id: z.string(),
    energy_level: z.enum(["low", "medium", "high"]),
    estimated_minutes: z.number().int().min(1).max(480),
    rationale: z.string().max(160),
  })
);

const JM_EFFORT_SYSTEM_PROMPT = `You estimate how long a task will take the user — a person doing it themselves, not an AI — and how much energy it demands, so they can decide WHEN to schedule it.

For each task output:
- estimated_minutes: the MEDIAN realistic wall-clock time for a focused adult to do the task once, as an integer 5–480. No safety buffer. Count the user's own time end-to-end, including any waiting or travel the task itself implies. Reference points: a decision or short message 5–15; a form, registration or purchase 15–30; a phone call or errand 20–45; a reading, research or writing session 45–120; a class, outing or social event = its real duration.
- energy_level: "low" (routine, could be done tired), "medium" (needs attention), "high" (creative, socially effortful, physically demanding, or emotionally hard).
- rationale: at most 160 characters — what drove the numbers.

If current_energy / current_minutes are present they are the user's existing values: keep them unless the task clearly contradicts them.

Output ONLY a JSON array, one entry per input id, every id exactly once:
[{"id": "task-id", "energy_level": "low|medium|high", "estimated_minutes": 30, "rationale": "..."}]`;

/**
 * Kaya's own lane. The calibration block is built from MEASURED actuals
 * (TaskDB.getEstimateCalibration) because Kaya's intuition about its own work
 * runs several times too high — the numbers, not the prose, do the anchoring.
 */
function kayaEffortSystemPrompt(c: EstimateCalibration | undefined): string {
  const calibration = c && c.n > 0
    ? `CALIBRATION — this outranks intuition: Kaya's past estimates for its own tasks ran ${c.medianRatio}× too high (median estimated/actual over ${c.n} completed tasks). The median ACTUAL was ${c.medianActual} minutes and the 75th percentile ${c.p75Actual} minutes. Anchor on those actuals, not on how big the task sounds.`
    : `CALIBRATION: no measured actuals are available yet. Kaya historically over-estimates its own work several-fold — anchor on the reference points below, not on how big the task sounds.`;
  return `You estimate how long Kaya — an autonomous Claude coding/research agent running headless on Jm's Mac — will take to execute a task end-to-end (load context, build or research, verify, write the deliverable), and the energy it demands in agent terms.

${calibration}

Reference points for an agent's real wall-clock: a lookup or one-file config change 3–8 min; a small code fix with a test 8–15; a bounded research note or report 10–25; a feature slice with tests + docs 20–45; a multi-slice build or deep-research program 45–120. Hard ceiling 150. No safety buffer — give the MEDIAN.

energy_level in agent terms: "low" = lookup / config tweak / one-file change; "medium" = a bounded build or research report; "high" = a multi-slice build or open-ended investigation.
rationale: at most 160 characters.

current_energy / current_minutes, when present, are the OLD values — they are probably inflated; re-estimate from the calibration, do not keep them.

Output ONLY a JSON array, one entry per input id, every id exactly once:
[{"id": "task-id", "energy_level": "low|medium|high", "estimated_minutes": 12, "rationale": "..."}]`;
}

/**
 * Estimate energy + minutes for a batch of tasks (Sonnet, standard tier; 10 per
 * call). `actor` selects the prompt: "jm" = a human's wall-clock, "kaya" = an
 * agent's wall-clock anchored on the supplied calibration. Returns ONLY genuine
 * estimates: a batch that fails to parse or validate is reported via
 * recordFailure (never silent) and its tasks are absent from the result, so
 * callers can report "N of M estimated" honestly instead of inventing numbers.
 */
export async function estimateTaskEffort(
  tasks: EffortInput[],
  opts: { actor: EffortActor; calibration?: EstimateCalibration }
): Promise<EffortEstimate[]> {
  if (tasks.length === 0) return [];

  const systemPrompt = opts.actor === "kaya" ? kayaEffortSystemPrompt(opts.calibration) : JM_EFFORT_SYSTEM_PROMPT;
  const BATCH_SIZE = 10;
  const results: EffortEstimate[] = [];

  for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
    const batch = tasks.slice(i, i + BATCH_SIZE);
    const userPrompt = `Tasks to estimate:
${JSON.stringify(
  batch.map((t) => ({
    id: t.id,
    title: t.title,
    notes: t.description ? t.description.slice(0, 300) : undefined,
    project: t.projectName,
    status: t.status,
    priority: t.priority,
    current_energy: t.current_energy ?? undefined,
    current_minutes: t.current_minutes ?? undefined,
  })),
  null,
  2
)}`;

    let failureReason = "unknown failure";
    try {
      const result = await inference({
        systemPrompt,
        userPrompt,
        level: "standard",
        expectJson: false, // parse the array manually (same pattern as scoreTasksWithAI)
      });

      if (result.success) {
        const arrayMatch = result.output.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          const parsed = EffortEstimateArraySchema.safeParse(JSON.parse(arrayMatch[0]) as unknown);
          if (parsed.success) {
            const ids = new Set(batch.map((t) => t.id));
            const seen = new Set<string>();
            for (const e of parsed.data) {
              if (ids.has(e.id) && !seen.has(e.id)) {
                seen.add(e.id);
                results.push(e);
              }
            }
            continue;
          }
          failureReason = `schema validation failed: ${parsed.error.message}`;
        } else {
          failureReason = "no JSON array in response";
        }
      } else {
        failureReason = result.error || "inference returned success:false";
      }
    } catch (err) {
      failureReason = err instanceof Error ? err.message : String(err);
    }

    recordFailure({
      source: "TaskAI:estimateTaskEffort",
      error: failureReason,
      context: { actor: opts.actor, batchIndex: Math.floor(i / BATCH_SIZE), batchSize: batch.length },
      tier: "log",
    });
  }

  return results;
}

// ============================================================================
// 5.1b Reorganize Task From Comment (board drawer "Comment & reorganize")
// ============================================================================

export interface ReorganizeContext {
  /** Today's ISO date (YYYY-MM-DD) for relative-date resolution. */
  today: string;
  /** Real projects the model may move the task into. */
  projects: Array<{ id: string; name: string }>;
  /** Valid task statuses the model may pick. */
  statuses: string[];
}

const ReorgUpdatesSchema = z
  .object({
    status: z.string().optional(),
    priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    project_id: z.string().nullable().optional(),
    due_date: z.string().nullable().optional(),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    scheduled_date: z.string().nullable().optional(),
    energy_level: z.enum(["low", "medium", "high"]).nullable().optional(),
    estimated_minutes: z.number().int().positive().nullable().optional(),
  })
  .strict();

const ReorgResultSchema = z.object({
  updates: ReorgUpdatesSchema,
  subtasks: z.array(z.string().min(1)).optional(),
  reply: z.string().min(1),
});

export type ReorgResult = z.infer<typeof ReorgResultSchema>;

const REORGANIZE_SYSTEM_PROMPT = `You are Kaya, reorganizing a single task in response to a comment from the user.

You are given the task's current fields, the user's comment, today's date, the
valid statuses, and the available projects (id + name). Decide what concrete
changes to make to the task and reply briefly.

Output a single JSON object matching this schema exactly:
{
  "updates": {              // include ONLY fields you are changing — omit the rest
    "status": string,            // must be one of the provided valid statuses
    "priority": 1 | 2 | 3,       // 1=high/urgent, 2=normal, 3=low
    "project_id": string | null, // must be a provided project id, or null to clear
    "due_date": string | null,   // ISO YYYY-MM-DD, or null to clear
    "title": string,
    "description": string,
    "scheduled_date": string | null, // ISO YYYY-MM-DD, or null to clear
    "energy_level": "low" | "medium" | "high" | null,
    "estimated_minutes": number | null
  },
  "subtasks": string[],     // OPTIONAL — new subtask titles to create, if the user asked to break this down
  "reply": string           // 1-3 sentence reply to the user describing what you did
}

Rules:
- Put ONLY the fields you are actually changing inside "updates". If you change nothing, "updates" is {}.
- status MUST be one of the provided valid statuses (e.g. "next", "in_progress"). Never invent one.
- project_id MUST be one of the provided project ids, or null. Match the user's words to a project name, then use that project's id.
- Resolve relative dates ("tomorrow", "next week") against today's date provided.
- "next week" = Monday of next calendar week.
- Only include "subtasks" if the user explicitly asked to break the task down or list steps.
- reply is short, in first person, and describes the concrete change ("Moved to Next and bumped to P1.").
- Output ONLY the JSON object, no explanation.`;

/**
 * Reorganize a single task from a user comment using Sonnet (standard tier).
 * Mirrors extractTaskMetadata: build prompt → inference(expectJson) → Zod-validate.
 * Returns null on inference failure or schema mismatch so the caller can fail loudly.
 */
export async function reorganizeTaskFromComment(
  task: Task,
  comment: string,
  ctx: ReorganizeContext
): Promise<ReorgResult | null> {
  const projectList =
    ctx.projects.length > 0
      ? ctx.projects.map((p) => `  - ${p.id}: ${p.name}`).join("\n")
      : "  (none)";

  const userPrompt = `Today: ${ctx.today}
Valid statuses: ${ctx.statuses.join(", ")}
Available projects:
${projectList}

Current task:
  title: ${JSON.stringify(task.title)}
  description: ${JSON.stringify(task.description || "")}
  status: ${task.status}
  priority: ${task.priority}
  project_id: ${task.project_id ?? "null"}
  due_date: ${task.due_date ?? "null"}
  scheduled_date: ${task.scheduled_date ?? "null"}
  energy_level: ${task.energy_level ?? "null"}
  estimated_minutes: ${task.estimated_minutes ?? "null"}

User comment: ${JSON.stringify(comment)}`;

  try {
    const result = await inference({
      systemPrompt: REORGANIZE_SYSTEM_PROMPT,
      userPrompt,
      level: "standard",
      expectJson: true,
    });

    if (!result.success || !result.parsed) {
      // Lands in the board server's launchd stderr log — without this the
      // 401-revoked-token class of failure is invisible (2026-07-16 incident).
      console.error(`[TaskAI] reorganize inference failed: ${result.error ?? "success but no parsed JSON"}`);
      return null;
    }

    const parsed = ReorgResultSchema.safeParse(result.parsed);
    if (!parsed.success) {
      console.error(`[TaskAI] reorganize output failed schema: ${parsed.error.message.slice(0, 300)}`);
      return null;
    }

    return parsed.data;
  } catch (err) {
    console.error(`[TaskAI] reorganize threw: ${err instanceof Error ? err.message : String(err)}`);
    return null;
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
  /** Brief task content/notes (truncated to 200 chars) */
  taskNotes?: string;
  /** Dependency info: "subtask of: <id>" or "blocks: [ids]" */
  dependencyInfo?: string;
  /** User's current focus area */
  userFocusArea?: string;
  /** Resolved project name */
  projectName?: string;
  /** Resolved goal title from TELOS */
  goalTitle?: string;
  /** Parent task title if this is a subtask */
  parentTaskTitle?: string;
  /** Number of subtasks under this task */
  subtaskCount?: number;
}

export interface AIScoredTask {
  id: string;
  adjustment: number;        // Clamped to [-20, +20]
  ai_reasoning: string;      // 1-2 sentence explanation, max 100 chars
  final_score: number;       // deterministic_score + adjustment
  /** Additive-only: present (true) only on a fallback item — never on a genuine AI score. */
  degraded?: true;
}

export interface AIScoringContext {
  tasks: ScoredTaskInput[];
  activeGoals: Array<{ id: string; title: string; status: string }>;
  recentCompletions: number;
  currentTime: string;
  /** Today's calendar events summary */
  todayCalendar?: string;
  /** Current TELOS mission focus themes */
  userFocusAreas?: string[];
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
- Goal alignment: use goal_title to understand strategic importance relative to user focus areas
- Task notes: use notes field for semantic understanding of task scope/complexity
- Today's calendar: factor in time availability and scheduling conflicts
- Parent/subtask relationships: subtasks of active parents get priority; tasks with many subtasks may be epics
- Project context: use project name to understand domain and group related work
- Energy matching: consider time of day vs energy level
- Momentum: tasks in active projects with recent completions get boost
- Pattern recognition: tasks repeatedly deferred need attention

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
 *
 * TaskAI owns loud failure reporting for its own fallback: any batch that
 * doesn't genuinely succeed calls recordFailure itself (never silent) and
 * every item in that batch is marked `degraded: true` so callers can tell a
 * genuine AI score from a zero-adjustment stub.
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
    const batchIndex = Math.floor(i / BATCH_SIZE);

    const focusBlock = context.userFocusAreas?.length
      ? `\nUser focus areas:\n${context.userFocusAreas.join("\n")}`
      : "";
    const calendarBlock = context.todayCalendar
      ? `\nToday's calendar:\n${context.todayCalendar}`
      : "";

    const userPrompt = `Current time: ${context.currentTime}
Recent completions (last 7 days): ${context.recentCompletions}
Active goals: ${context.activeGoals.map((g) => `${g.id}: ${g.title}`).join(", ") || "none"}${focusBlock}${calendarBlock}

Tasks to score:
${JSON.stringify(
  batch.map((t) => {
    const entry: Record<string, unknown> = {
      id: t.id,
      title: t.title,
      priority: t.priority,
      due_date: t.due_date,
      goal_id: t.goal_id,
      project: t.projectName || t.project_id,
      energy_level: t.energy_level,
      deterministic_score: t.deterministic_score,
      score_reasons: t.reasons.join(", "),
    };
    if (t.goalTitle) entry.goal_title = t.goalTitle;
    if (t.taskNotes) entry.notes = t.taskNotes;
    if (t.parentTaskTitle) entry.parent_task = t.parentTaskTitle;
    if (t.subtaskCount) entry.subtask_count = t.subtaskCount;
    if (t.dependencyInfo) entry.dependency_info = t.dependencyInfo;
    return entry;
  }),
  null,
  2
)}`;

    let succeeded = false;
    let failureReason = "unknown failure";

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
            succeeded = true;
          } else {
            failureReason = `schema validation failed: ${parsed.error.message}`;
          }
        } else {
          failureReason = "no JSON array found in response";
        }
      } else {
        failureReason = result.error || "inference returned success:false";
      }
    } catch (err) {
      failureReason = err instanceof Error ? err.message : String(err);
    }

    if (!succeeded) {
      recordFailure({
        source: "TaskAI:scoreTasksWithAI:batch",
        error: failureReason,
        context: { batchIndex, batchSize: batch.length },
        tier: "log",
      });

      // Fallback for failed batch: zero adjustment, honestly marked degraded.
      for (const task of batch) {
        results.push({
          id: task.id,
          adjustment: 0,
          ai_reasoning: "AI scoring unavailable",
          final_score: task.deterministic_score,
          degraded: true,
        });
      }
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
 * Returns null on failure. TaskAI owns loud failure reporting for this
 * fallback too (fable-audit batch2: this was the one degraded path in the
 * file that returned null silently — every branch below now calls
 * recordFailure, matching extractTaskMetadata's idiom above).
 */
export async function generateWeeklyReview(data: ReviewData): Promise<WeeklyReview | null> {
  const degradedFallback = (reason: string): null => {
    recordFailure({
      source: "TaskAI:generateWeeklyReview",
      error: reason,
      context: { completedCount: data.completedTasks.length, period: `${data.period.start}..${data.period.end}` },
      tier: "log",
    });
    return null;
  };

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
      return degradedFallback(result.error || "inference returned success:false");
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
          // fall through to degradedFallback below
        }
      }
      return degradedFallback(`schema validation failed: ${parsed.error.message}`);
    }

    return parsed.data;
  } catch (err) {
    return degradedFallback(err instanceof Error ? err.message : String(err));
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
