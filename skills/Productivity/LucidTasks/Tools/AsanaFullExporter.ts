#!/usr/bin/env bun
/**
 * AsanaFullExporter.ts - Comprehensive Asana-to-LucidTasks exporter
 *
 * Fetches ALL tasks from Asana API (all projects + My Tasks), with:
 *   - Full expanded fields (notes, due_on, assignee, tags, memberships, subtasks)
 *   - Comments/stories appended to task descriptions
 *   - Subtasks created as child tasks via parent_task_id
 *   - Deduplication via asana_gid (safe to re-run)
 *   - Archived project support (created with status: "archived")
 *
 * Usage:
 *   bun AsanaFullExporter.ts --dry-run   # Preview scope (no DB writes)
 *   bun AsanaFullExporter.ts             # Full import
 *   bun AsanaFullExporter.ts --json      # Output result as JSON
 *
 * Phase 0 of Asana-to-LucidTasks migration spec.
 */

import { parseArgs } from "util";
import { readFileSync } from "fs";
import { join } from "path";
import { getTaskDB, type TaskStatus } from "./TaskDB.ts";

// ============================================================================
// Config Loading
// ============================================================================

interface SecretsJson {
  asana?: {
    personal_access_token?: string;
    access_token?: string;
    workspace_gid?: string;
  };
}

function loadAsanaToken(): { token: string; workspaceGid: string } {
  const secretsPath = join(process.env.HOME!, ".claude", "secrets.json");
  const secrets = JSON.parse(readFileSync(secretsPath, "utf-8")) as SecretsJson;
  const token = secrets.asana?.personal_access_token ?? secrets.asana?.access_token;
  const workspaceGid = secrets.asana?.workspace_gid;

  if (!token) throw new Error("Missing asana.access_token in secrets.json");
  if (!workspaceGid) throw new Error("Missing asana.workspace_gid in secrets.json");

  return { token, workspaceGid };
}

// ============================================================================
// Asana HTTP Client
// ============================================================================

const BASE_URL = "https://app.asana.com/api/1.0";

async function asanaGet<T>(endpoint: string, token: string): Promise<T> {
  const url = `${BASE_URL}${endpoint}`;
  let attempts = 0;

  while (attempts < 3) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get("retry-after") ?? "60", 10);
      console.warn(`Rate limit hit. Waiting ${retryAfter}s...`);
      await sleep(retryAfter * 1000);
      attempts++;
      continue;
    }

    if (response.status === 401) {
      throw new Error("Asana API auth failure (401). Check ASANA_ACCESS_TOKEN in secrets.json");
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Asana API error (${response.status}): ${text.slice(0, 200)}`);
    }

    const data = (await response.json()) as { data: T };
    return data.data;
  }

  throw new Error("Max retry attempts reached");
}

// ============================================================================
// Types
// ============================================================================

interface ExportResult {
  totalFetched: number;
  totalImported: number;
  totalDuplicate: number;
  totalSkipped: number;
  projectsCreated: number;
  subtasksImported: number;
  commentsCollected: number;
  errors: string[];
  perProject: Record<string, { fetched: number; imported: number; duped: number }>;
}

interface AsanaProject {
  gid: string;
  name: string;
  archived: boolean;
  created_at: string;
  modified_at: string;
}

interface AsanaTask {
  gid: string;
  name: string;
  notes?: string;
  completed: boolean;
  created_at: string;
  modified_at: string;
  due_on?: string;
  assignee?: { name: string } | null;
  tags?: { name: string }[];
  memberships?: Array<{
    project: { gid: string; name: string };
    section: { gid: string; name: string };
  }>;
  num_subtasks?: number;
}

interface AsanaSubtask {
  gid: string;
  name: string;
  notes?: string;
  completed: boolean;
  due_on?: string;
  assignee?: { name: string } | null;
}

interface AsanaStory {
  text: string;
  created_by: { name: string };
  created_at: string;
  type: string;
}

interface AsanaUserTaskList {
  gid: string;
  name: string;
}

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatComments(stories: AsanaStory[]): string {
  const comments = stories.filter((s) => s.type === "comment");
  if (comments.length === 0) return "";
  const lines = comments.map(
    (s) => `- **${s.created_by?.name ?? "Unknown"}** (${s.created_at.slice(0, 10)}): ${s.text}`
  );
  return `\n\n## Asana Comments\n${lines.join("\n")}`;
}

function mapStatus(completed: boolean, sectionName: string): TaskStatus {
  if (completed) return "done";
  const s = sectionName.toLowerCase();
  if (s.includes("in progress") || s.includes("doing")) return "in_progress";
  if (s.includes("someday") || s.includes("later")) return "someday";
  if (s.includes("next") || s.includes("weekly")) return "next";
  return "inbox";
}

// ============================================================================
// Task Importer
// ============================================================================

async function importTask(
  task: AsanaTask,
  token: string,
  lucidProjectId: string | null,
  parentTaskId: string | null,
  projectName: string,
  result: ExportResult,
  db: ReturnType<typeof getTaskDB>
): Promise<string | null> {
  // Fetch comments
  let commentsBlock = "";
  try {
    const stories = await asanaGet<AsanaStory[]>(
      `/tasks/${task.gid}/stories?opt_fields=text,created_by.name,created_at,type`,
      token
    );
    await sleep(450);
    commentsBlock = formatComments(stories);
    const commentCount = stories.filter((s) => s.type === "comment").length;
    result.commentsCollected += commentCount;
  } catch {
    // Comments unavailable — import task without comments
  }

  const sectionName = task.memberships?.[0]?.section?.name ?? "";

  const labels: string[] = [];
  if (task.assignee?.name) labels.push(`assignee:${task.assignee.name}`);
  for (const tag of task.tags ?? []) labels.push(`tag:${tag.name}`);

  const contextTags: string[] = [];
  if (sectionName) contextTags.push(`section:${sectionName}`);
  if (projectName) contextTags.push(`project:${projectName}`);

  const description = `${task.notes ?? ""}${commentsBlock}`;
  const status = mapStatus(task.completed, sectionName);

  const created = db.createTask({
    title: task.name,
    description,
    status,
    due_date: task.due_on ?? null,
    project_id: lucidProjectId,
    parent_task_id: parentTaskId,
    labels,
    context_tags: contextTags,
    asana_gid: task.gid,
  });

  return created.id;
}

// ============================================================================
// Main Export
// ============================================================================

async function runExport(dryRun: boolean): Promise<ExportResult> {
  const result: ExportResult = {
    totalFetched: 0,
    totalImported: 0,
    totalDuplicate: 0,
    totalSkipped: 0,
    projectsCreated: 0,
    subtasksImported: 0,
    commentsCollected: 0,
    errors: [],
    perProject: {},
  };

  const { token, workspaceGid } = loadAsanaToken();
  const db = dryRun ? null : getTaskDB();

  const OPT_FIELDS =
    "gid,name,notes,completed,created_at,modified_at,due_on,assignee.name,tags.name,memberships.project.name,memberships.section.name,num_subtasks";

  // ---------------------------------------------------------------------------
  // Step 1: Fetch all projects (active + archived)
  // ---------------------------------------------------------------------------
  console.log("Fetching Asana projects...");
  const activeProjects = await asanaGet<AsanaProject[]>(
    `/workspaces/${workspaceGid}/projects?archived=false&opt_fields=gid,name,archived,created_at,modified_at`,
    token
  );
  await sleep(450);

  const archivedProjects = await asanaGet<AsanaProject[]>(
    `/workspaces/${workspaceGid}/projects?archived=true&opt_fields=gid,name,archived,created_at,modified_at`,
    token
  );
  await sleep(450);

  // Deduplicate
  const seenGids = new Set<string>();
  const uniqueProjects: AsanaProject[] = [];
  for (const p of [...activeProjects, ...archivedProjects]) {
    if (!seenGids.has(p.gid)) {
      seenGids.add(p.gid);
      uniqueProjects.push(p);
    }
  }

  console.log(
    `Found ${uniqueProjects.length} unique projects (${activeProjects.length} active + ${archivedProjects.length} archived fetched)`
  );

  // ---------------------------------------------------------------------------
  // Step 2: Create LucidTasks projects
  // ---------------------------------------------------------------------------
  const projectGidToLucidId = new Map<string, string>();

  for (const proj of uniqueProjects) {
    if (dryRun) {
      projectGidToLucidId.set(proj.gid, `dry-${proj.gid}`);
      console.log(`  [DRY RUN] Project: ${proj.name} (${proj.archived ? "archived" : "active"})`);
    } else {
      const existing = db!.getProjectByAsanaGid(proj.gid);
      if (existing) {
        projectGidToLucidId.set(proj.gid, existing.id);
        console.log(`  [SKIP] Project already exists: ${proj.name}`);
      } else {
        const created = db!.createProject({
          name: proj.name,
          status: proj.archived ? "archived" : "active",
          asana_project_gid: proj.gid,
        });
        projectGidToLucidId.set(proj.gid, created.id);
        result.projectsCreated++;
        console.log(`  [CREATED] ${proj.name} (${proj.archived ? "archived" : "active"})`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 3: Fetch and import tasks per project
  // ---------------------------------------------------------------------------
  for (const proj of uniqueProjects) {
    console.log(`\nProject: ${proj.name}`);
    result.perProject[proj.name] = { fetched: 0, imported: 0, duped: 0 };

    let tasks: AsanaTask[] = [];
    try {
      tasks = await asanaGet<AsanaTask[]>(
        `/projects/${proj.gid}/tasks?opt_fields=${OPT_FIELDS}&limit=100`,
        token
      );
      await sleep(450);
    } catch (error) {
      const msg = `Failed to fetch tasks for ${proj.name}: ${error instanceof Error ? error.message : String(error)}`;
      result.errors.push(msg);
      console.error(`  ERROR: ${msg}`);
      continue;
    }

    result.perProject[proj.name].fetched = tasks.length;
    result.totalFetched += tasks.length;
    console.log(`  ${tasks.length} tasks`);

    const lucidProjectId = projectGidToLucidId.get(proj.gid) ?? null;

    for (const task of tasks) {
      if (dryRun) {
        result.totalImported++;
        result.perProject[proj.name].imported++;
        continue;
      }

      // Dedup check
      const existing = db!.getTaskByAsanaGid(task.gid);
      if (existing) {
        result.totalDuplicate++;
        result.perProject[proj.name].duped++;
        continue;
      }

      try {
        const createdId = await importTask(
          task,
          token,
          lucidProjectId,
          null,
          proj.name,
          result,
          db!
        );

        result.totalImported++;
        result.perProject[proj.name].imported++;

        // Fetch subtasks if any
        if ((task.num_subtasks ?? 0) > 0 && createdId) {
          try {
            const subtasks = await asanaGet<AsanaSubtask[]>(
              `/tasks/${task.gid}/subtasks?opt_fields=gid,name,notes,completed,due_on,assignee.name`,
              token
            );
            await sleep(450);

            for (const sub of subtasks) {
              const existingSub = db!.getTaskByAsanaGid(sub.gid);
              if (existingSub) {
                result.totalDuplicate++;
                continue;
              }

              const subLabels: string[] = [];
              if (sub.assignee?.name) subLabels.push(`assignee:${sub.assignee.name}`);

              db!.createTask({
                title: sub.name,
                description: sub.notes ?? "",
                status: sub.completed ? "done" : "inbox",
                due_date: sub.due_on ?? null,
                project_id: lucidProjectId,
                parent_task_id: createdId,
                labels: subLabels,
                asana_gid: sub.gid,
              });

              result.subtasksImported++;
              result.totalImported++;
            }
          } catch (error) {
            const msg = `Subtask fetch failed for "${task.name}": ${error instanceof Error ? error.message : String(error)}`;
            result.errors.push(msg);
          }
        }
      } catch (error) {
        const msg = `Import failed for "${task.name}" (${task.gid}): ${error instanceof Error ? error.message : String(error)}`;
        result.errors.push(msg);
        console.error(`  ERROR: ${msg}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 4: My Tasks
  // ---------------------------------------------------------------------------
  console.log("\nFetching My Tasks...");
  try {
    const me = await asanaGet<{ gid: string; name: string }>(
      "/users/me?opt_fields=gid,name",
      token
    );
    await sleep(450);

    const myTaskList = await asanaGet<AsanaUserTaskList>(
      `/users/${me.gid}/user_task_list?workspace=${workspaceGid}&opt_fields=gid,name`,
      token
    );
    await sleep(450);

    const myTasks = await asanaGet<AsanaTask[]>(
      `/user_task_lists/${myTaskList.gid}/tasks?opt_fields=${OPT_FIELDS}&limit=100`,
      token
    );
    await sleep(450);

    console.log(`  ${myTasks.length} personal tasks`);
    result.totalFetched += myTasks.length;
    result.perProject["My Tasks"] = { fetched: myTasks.length, imported: 0, duped: 0 };

    for (const task of myTasks) {
      if (dryRun) {
        result.totalImported++;
        result.perProject["My Tasks"].imported++;
        continue;
      }

      const existing = db!.getTaskByAsanaGid(task.gid);
      if (existing) {
        result.totalDuplicate++;
        result.perProject["My Tasks"].duped++;
        continue;
      }

      try {
        await importTask(task, token, null, null, "My Tasks", result, db!);
        result.totalImported++;
        result.perProject["My Tasks"].imported++;
      } catch (error) {
        const msg = `My Task import failed for "${task.name}": ${error instanceof Error ? error.message : String(error)}`;
        result.errors.push(msg);
      }
    }
  } catch (error) {
    const msg = `My Tasks fetch failed: ${error instanceof Error ? error.message : String(error)}`;
    result.errors.push(msg);
    console.warn(`  WARNING: ${msg}`);
  }

  if (!dryRun) {
    db!.close();
  }

  return result;
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`
AsanaFullExporter - Comprehensive Asana to LucidTasks importer

USAGE:
  bun AsanaFullExporter.ts [options]

OPTIONS:
  --dry-run    Preview scope without writing to DB
  --json       Output result as JSON
  -h, --help   Show this help

WHAT IT DOES:
  1. Fetches all Asana projects (active + archived)
  2. Creates LucidTasks projects for each (dedup via asana_project_gid)
  3. Fetches all tasks per project with expanded fields
  4. Fetches comments/stories for each task
  5. Fetches subtasks and creates them as child tasks
  6. Fetches My Tasks (personal/unassigned)
  7. Deduplicates via asana_gid (safe to re-run)

RATE LIMITING:
  450ms delay between API requests (~133 req/min, under Asana 150/min limit)
`);
    return;
  }

  const dryRun = values["dry-run"] ?? false;
  console.log(`\n=== Asana Full Exporter ${dryRun ? "(DRY RUN)" : ""} ===\n`);

  const startTime = Date.now();
  const result = await runExport(dryRun);
  const durationMs = Date.now() - startTime;
  const durationMin = (durationMs / 60000).toFixed(1);

  if (values.json) {
    console.log(JSON.stringify({ ...result, durationMs }, null, 2));
  } else {
    console.log(`\n=== Export Report ===`);
    console.log(`Duration: ${durationMin} min`);
    console.log(`Projects Created: ${result.projectsCreated}`);
    console.log(`Total Fetched: ${result.totalFetched}`);
    console.log(`Total Imported: ${result.totalImported}`);
    console.log(`Total Duplicates (skipped): ${result.totalDuplicate}`);
    console.log(`Subtasks Imported: ${result.subtasksImported}`);
    console.log(`Comments Collected: ${result.commentsCollected}`);
    console.log(`Errors: ${result.errors.length}`);

    if (result.errors.length > 0) {
      console.log(`\nErrors:`);
      for (const err of result.errors) console.log(`  - ${err}`);
    }

    console.log(`\nPer-Project:`);
    for (const [name, c] of Object.entries(result.perProject)) {
      console.log(`  ${name}: fetched=${c.fetched} imported=${c.imported} duped=${c.duped}`);
    }

    if (dryRun) {
      console.log(`\n[DRY RUN] No changes made. Run without --dry-run to execute.`);
    } else {
      console.log(`\nImport complete!`);
    }
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
