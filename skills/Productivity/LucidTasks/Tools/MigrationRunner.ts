#!/usr/bin/env bun
/**
 * MigrationRunner.ts - Asana JSON to SQLite Migration
 *
 * Parses task data from context/AsanaContext.md, creates projects from
 * unique Asana project memberships, and batch-processes tasks through
 * AI inference (Haiku) for classification, goal mapping, and project assignment.
 *
 * The migration preserves asana_gid for all imported tasks, allowing
 * deduplication on re-run.
 *
 * Usage:
 *   bun run MigrationRunner.ts              # Run full migration
 *   bun run MigrationRunner.ts --dry-run    # Parse and report without writing
 *   bun run MigrationRunner.ts --skip-ai    # Import without AI classification
 *
 * @module MigrationRunner
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getTaskDB, type TaskStatus } from "./TaskDB.ts";
import { loadTelosData } from "./TelosGoalLoader.ts";
import { inference, type InferenceResult } from "../../../../lib/core/Inference.ts";

// ============================================================================
// Configuration
// ============================================================================

const KAYA_HOME = process.env.KAYA_HOME || join(process.env.HOME || "", ".claude");
const ASANA_CONTEXT_PATH = join(KAYA_HOME, "context/AsanaContext.md");
const BATCH_SIZE = 50;

// ============================================================================
// Types
// ============================================================================

interface AsanaTask {
  gid: string;
  name: string;
  notes: string;
  completed: boolean;
  created_at: string;
  modified_at: string;
  due_on: string | null;
  memberships: Array<{
    project: { gid: string; name: string };
    section: { gid: string; name: string };
  }>;
}

interface MigrationResult {
  totalParsed: number;
  totalImported: number;
  totalSkipped: number;
  totalDuplicate: number;
  projectsCreated: number;
  statusBreakdown: Record<string, number>;
  errors: string[];
}

interface AIClassification {
  status: TaskStatus;
  goalId: string | null;
  confidence: number;
}

// ============================================================================
// Parser
// ============================================================================

/**
 * Extract JSON array from AsanaContext.md
 * The file contains markdown wrapping around a JSON array of tasks.
 */
function parseAsanaContext(filePath: string): AsanaTask[] {
  if (!existsSync(filePath)) {
    throw new Error(`Asana context file not found: ${filePath}`);
  }

  const content = readFileSync(filePath, "utf-8");

  // Find the JSON array within markdown code fence
  const jsonMatch = content.match(/```\s*\n(\[[\s\S]*?\])\s*\n```/);
  if (!jsonMatch) {
    // Try to find a bare JSON array
    const bareMatch = content.match(/(\[[\s\S]*\])/);
    if (!bareMatch) {
      throw new Error("Could not find JSON task array in AsanaContext.md");
    }

    // The JSON might be truncated - try to parse what we have
    try {
      return JSON.parse(bareMatch[1]) as AsanaTask[];
    } catch {
      // JSON is likely truncated - try to repair by finding last complete object
      return repairTruncatedJSON(bareMatch[1]);
    }
  }

  try {
    return JSON.parse(jsonMatch[1]) as AsanaTask[];
  } catch {
    return repairTruncatedJSON(jsonMatch[1]);
  }
}

/**
 * Attempt to repair truncated JSON by finding the last complete object
 */
function repairTruncatedJSON(jsonStr: string): AsanaTask[] {
  // Find all complete objects by looking for matching braces
  const tasks: AsanaTask[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let objectStart = -1;

  // Skip the opening bracket
  let startIdx = jsonStr.indexOf("[");
  if (startIdx === -1) return [];

  for (let i = startIdx + 1; i < jsonStr.length; i++) {
    const char = jsonStr[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (char === "\\") {
      escape = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") {
      if (depth === 0) objectStart = i;
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0 && objectStart !== -1) {
        try {
          const obj = JSON.parse(jsonStr.slice(objectStart, i + 1));
          tasks.push(obj as AsanaTask);
        } catch {
          // Skip malformed objects
        }
        objectStart = -1;
      }
    }
  }

  return tasks;
}

// ============================================================================
// AI Classification (Haiku)
// ============================================================================

/**
 * Build a prompt for batch AI classification of tasks
 */
function buildClassificationPrompt(
  tasks: AsanaTask[],
  goalIds: string[]
): string {
  const goalList = goalIds.join(", ");

  const taskLines = tasks.map((t, i) => {
    const completed = t.completed ? "[COMPLETED]" : "[OPEN]";
    const notes = t.notes ? ` | Notes: ${t.notes.slice(0, 100)}` : "";
    const project = t.memberships?.[0]?.project?.name || "No project";
    const section = t.memberships?.[0]?.section?.name || "";
    return `${i}: ${completed} "${t.name}" | Project: ${project} | Section: ${section}${notes}`;
  });

  return `Classify these tasks. For each, provide:
- status: inbox (needs review), next (should do soon), someday (maybe later), done (already completed)
- goalId: most relevant TELOS goal from [${goalList}] or null
- confidence: 0.0-1.0

Rules:
- If [COMPLETED], status must be "done"
- If task seems stale (vague, old), use "someday"
- If task is actionable and relevant, use "inbox" or "next"
- Match goalId based on task content alignment with TELOS goals

Tasks:
${taskLines.join("\n")}

Respond ONLY with a JSON array of objects: [{"index":0,"status":"done","goalId":"G25","confidence":0.9}, ...]`;
}

/**
 * Run AI inference on a batch of tasks via direct import
 */
async function classifyBatch(
  tasks: AsanaTask[],
  goalIds: string[]
): Promise<AIClassification[]> {
  const userPrompt = buildClassificationPrompt(tasks, goalIds);
  const defaultResult = (): AIClassification => ({ status: "inbox" as TaskStatus, goalId: null, confidence: 0 });

  try {
    const result: InferenceResult = await inference({
      systemPrompt: "You are a task classifier. Respond only with a JSON array.",
      userPrompt,
      level: "fast",
    });

    if (!result.success) {
      console.error(`[Migration] AI inference failed: ${result.error}`);
      return tasks.map(defaultResult);
    }

    // Parse AI response - extract JSON array
    const jsonMatch = result.output.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error("[Migration] AI response did not contain JSON array");
      return tasks.map(defaultResult);
    }

    const results = JSON.parse(jsonMatch[0]) as Array<{
      index: number;
      status: string;
      goalId: string | null;
      confidence: number;
    }>;

    // Map results back to classifications
    return tasks.map((_, i) => {
      const result = results.find((r) => r.index === i);
      if (result) {
        return {
          status: (result.status as TaskStatus) || "inbox",
          goalId: result.goalId,
          confidence: result.confidence || 0,
        };
      }
      return defaultResult();
    });
  } catch (err) {
    console.error(`[Migration] AI classification failed: ${err}`);
    return tasks.map(defaultResult);
  }
}

/**
 * Simple classification without AI
 */
function classifyWithoutAI(task: AsanaTask): AIClassification {
  if (task.completed) {
    return { status: "done", goalId: null, confidence: 1.0 };
  }

  // Check section name for hints
  const sectionName = task.memberships?.[0]?.section?.name?.toLowerCase() || "";
  if (sectionName.includes("completed") || sectionName.includes("done")) {
    return { status: "done", goalId: null, confidence: 0.8 };
  }
  if (sectionName.includes("in progress") || sectionName.includes("doing")) {
    return { status: "in_progress", goalId: null, confidence: 0.7 };
  }
  if (sectionName.includes("someday") || sectionName.includes("later")) {
    return { status: "someday", goalId: null, confidence: 0.7 };
  }

  // Check if task has a due date
  if (task.due_on) {
    const dueDate = new Date(task.due_on);
    const now = new Date();
    if (dueDate < now) {
      return { status: "inbox", goalId: null, confidence: 0.5 };
    }
    return { status: "next", goalId: null, confidence: 0.5 };
  }

  return { status: "inbox", goalId: null, confidence: 0.3 };
}

// ============================================================================
// Migration Runner
// ============================================================================

export class MigrationRunner {
  private dryRun: boolean;
  private skipAI: boolean;

  constructor(options?: { dryRun?: boolean; skipAI?: boolean }) {
    this.dryRun = options?.dryRun ?? false;
    this.skipAI = options?.skipAI ?? false;
  }

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = {
      totalParsed: 0,
      totalImported: 0,
      totalSkipped: 0,
      totalDuplicate: 0,
      projectsCreated: 0,
      statusBreakdown: {},
      errors: [],
    };

    console.log("\n=== LucidTasks Migration: Asana -> SQLite ===\n");

    // Step 1: Parse Asana data
    console.log("Step 1: Parsing AsanaContext.md...");
    let asanaTasks: AsanaTask[];
    try {
      asanaTasks = parseAsanaContext(ASANA_CONTEXT_PATH);
      result.totalParsed = asanaTasks.length;
      console.log(`  Found ${asanaTasks.length} tasks`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR: ${errMsg}`);
      result.errors.push(errMsg);
      return result;
    }

    if (asanaTasks.length === 0) {
      console.log("  No tasks found. Exiting.");
      return result;
    }

    // Step 2: Load TELOS data for goal mapping
    console.log("\nStep 2: Loading TELOS data...");
    let goalIds: string[] = [];
    try {
      const telosData = loadTelosData();
      goalIds = telosData.goals.map((g) => g.id);
      console.log(`  Loaded ${telosData.goals.length} goals, ${telosData.missions.length} missions`);
    } catch (err) {
      console.error(`  WARNING: Could not load TELOS data: ${err}`);
    }

    if (this.dryRun) {
      console.log("\n[DRY RUN] Would process the following:\n");
      this.printDryRunSummary(asanaTasks);
      return result;
    }

    // Step 3: Create projects from unique Asana projects
    console.log("\nStep 3: Creating projects...");
    const db = getTaskDB();
    const projectMap = new Map<string, string>(); // asana project gid -> lucidtasks project id

    const uniqueProjects = new Map<string, string>();
    for (const task of asanaTasks) {
      for (const membership of task.memberships || []) {
        if (membership.project?.gid && membership.project?.name) {
          uniqueProjects.set(membership.project.gid, membership.project.name);
        }
      }
    }

    for (const [asanaGid, projectName] of uniqueProjects) {
      // Check if project already exists
      const existing = db.getProjectByAsanaGid(asanaGid);
      if (existing) {
        projectMap.set(asanaGid, existing.id);
        continue;
      }

      const project = db.createProject({
        name: projectName,
        asana_project_gid: asanaGid,
      });
      projectMap.set(asanaGid, project.id);
      result.projectsCreated++;
    }
    console.log(`  Created ${result.projectsCreated} projects (${uniqueProjects.size} unique Asana projects)`);

    // Step 4: Process tasks in batches
    console.log(`\nStep 4: Processing ${asanaTasks.length} tasks...`);
    const batches = [];
    for (let i = 0; i < asanaTasks.length; i += BATCH_SIZE) {
      batches.push(asanaTasks.slice(i, i + BATCH_SIZE));
    }

    let batchNum = 0;
    for (const batch of batches) {
      batchNum++;
      console.log(`  Batch ${batchNum}/${batches.length} (${batch.length} tasks)...`);

      // Classify tasks
      let classifications: AIClassification[];
      if (this.skipAI) {
        classifications = batch.map((t) => classifyWithoutAI(t));
      } else {
        classifications = await classifyBatch(batch, goalIds);
      }

      // Insert tasks
      for (let i = 0; i < batch.length; i++) {
        const asanaTask = batch[i];
        const classification = classifications[i];

        // Skip duplicates
        if (asanaTask.gid) {
          const existing = db.getTaskByAsanaGid(asanaTask.gid);
          if (existing) {
            result.totalDuplicate++;
            continue;
          }
        }

        // Skip empty tasks
        if (!asanaTask.name || asanaTask.name.trim() === "") {
          result.totalSkipped++;
          continue;
        }

        // Get project ID from Asana membership
        const asanaProjectGid = asanaTask.memberships?.[0]?.project?.gid;
        const projectId = asanaProjectGid ? projectMap.get(asanaProjectGid) || null : null;

        // Get mission ID from goal
        let missionId: string | null = null;
        if (classification.goalId) {
          try {
            const telosData = loadTelosData();
            const goal = telosData.goalMap.get(classification.goalId);
            if (goal) missionId = goal.missionId;
          } catch { /* ignore */ }
        }

        try {
          db.createTask({
            title: asanaTask.name,
            description: asanaTask.notes || "",
            status: classification.status,
            due_date: asanaTask.due_on || null,
            project_id: projectId,
            goal_id: classification.goalId,
            mission_id: missionId,
            asana_gid: asanaTask.gid,
            raw_input: `asana-migration:${asanaTask.gid}`,
          });

          result.totalImported++;
          result.statusBreakdown[classification.status] =
            (result.statusBreakdown[classification.status] || 0) + 1;
        } catch (err) {
          const errMsg = `Failed to import task ${asanaTask.gid}: ${err}`;
          result.errors.push(errMsg);
          result.totalSkipped++;
        }
      }
    }

    db.close();

    // Print report
    this.printReport(result);

    return result;
  }

  private printDryRunSummary(tasks: AsanaTask[]): void {
    const completed = tasks.filter((t) => t.completed).length;
    const open = tasks.filter((t) => !t.completed).length;

    const projects = new Map<string, number>();
    for (const task of tasks) {
      const projectName = task.memberships?.[0]?.project?.name || "(No Project)";
      projects.set(projectName, (projects.get(projectName) || 0) + 1);
    }

    console.log(`  Total:     ${tasks.length}`);
    console.log(`  Completed: ${completed}`);
    console.log(`  Open:      ${open}`);
    console.log(`  Projects:  ${projects.size}`);
    console.log(`\n  By Project:`);
    for (const [name, count] of [...projects.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${name.padEnd(30)} ${count}`);
    }
    console.log(`\n  AI Batches Required: ${Math.ceil(tasks.length / BATCH_SIZE)}`);
  }

  private printReport(result: MigrationResult): void {
    console.log(`
=== Migration Report ===

Total Parsed:    ${result.totalParsed}
Total Imported:  ${result.totalImported}
Total Skipped:   ${result.totalSkipped}
Total Duplicate: ${result.totalDuplicate}
Projects Created:${result.projectsCreated}

By Status:
${Object.entries(result.statusBreakdown)
  .map(([status, count]) => `  ${status.padEnd(15)} ${count}`)
  .join("\n")}

Errors: ${result.errors.length}
${result.errors.length > 0 ? result.errors.slice(0, 10).map((e) => `  - ${e}`).join("\n") : "  (none)"}

============================
`);
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const skipAI = args.includes("--skip-ai");

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
MigrationRunner - Asana to LucidTasks Migration

Usage:
  bun run MigrationRunner.ts              # Run full migration with AI
  bun run MigrationRunner.ts --dry-run    # Parse only, show report
  bun run MigrationRunner.ts --skip-ai    # Import without AI classification

Options:
  --dry-run    Parse and report without writing to database
  --skip-ai    Skip AI inference (use rule-based classification)
  --help, -h   Show this help
`);
    process.exit(0);
  }

  const runner = new MigrationRunner({ dryRun, skipAI });
  runner.run().catch((err) => {
    console.error(`Migration failed: ${err}`);
    process.exit(1);
  });
}
