#!/usr/bin/env bun
/**
 * CLI.ts — QueueManager CLI dispatch entry point.
 *
 * Extracted from QueueManager.ts per QueueRouter spec Decision A (ISC #1).
 * This file contains ONLY the CLI argument parsing and dispatch logic.
 * The QueueManager class API is unchanged and lives in QueueManager.ts.
 *
 * Usage:
 *   bun run CLI.ts <command> [args...]
 *   (See --help for full command reference)
 */

import { existsSync, readFileSync } from "fs";
import { basename, join, resolve } from "path";
import {
  QueueManager,
  type QueueItem,
  type QueueItemStatus,
  type QueueItemSpec,
  type Priority,
  generateId,
  getQueueFilePath,
} from "./QueueManager.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

/**
 * Render an absolute spec path as a clickable link to its file.
 * - Interactive terminal (stdout is a TTY): emits an OSC 8 hyperlink targeting a
 *   `file://` URL, so clicking opens the spec in the OS default markdown viewer/editor.
 *   The visible text is the path relative to KAYA_HOME for readability.
 * - Piped output (e.g. when Kaya relays CLI results in chat): emits the plain absolute
 *   path, which Claude Code renders as a clickable file link that opens in the editor.
 */
function specLink(specPath: string): string {
  if (process.stdout.isTTY && specPath.startsWith("/")) {
    const rel = specPath.replace(getKayaHome() + "/", "");
    const url = "file://" + encodeURI(specPath);
    const OSC = "\x1b]8;;";
    const ST = "\x1b\\";
    return `${OSC}${url}${ST}${rel}${OSC}${ST}`;
  }
  return specPath;
}

function formatItem(item: QueueItem): string {
  const statusEmoji: Record<string, string> = {
    pending: "pending",
    in_progress: "in_progress",
    awaiting_approval: "awaiting_approval",
    completed: "completed",
    approved: "approved",
    failed: "failed",
    rejected: "rejected",
    // execution-phase statuses derived from pipeline stage
    partial: "partial",
    needs_review: "needs_review",
    blocked: "blocked",
    // spec-pipeline statuses
    "awaiting-context": "awaiting-context",
    "researching": "researching",
    "generating-spec": "generating-spec",
    "revision-needed": "revision-needed",
    "escalated": "escalated",
  };

  const priorityLabel: Record<Priority, string> = {
    1: "HIGH",
    2: "NORMAL",
    3: "LOW",
  };

  const lines = [
    "───────────────────────────────────────",
    `ID:       ${item.id}`,
    `Title:    ${item.payload?.title ?? "(no title)"}`,
    `Queue:    ${item.queue}`,
    `Status:   ${statusEmoji[item.status] ?? item.status}`,
    `Priority: ${priorityLabel[item.priority]}`,
    `Type:     ${item.type}`,
    `Source:   ${item.source}`,
    `Created:  ${item.created}`,
  ];

  if (item.payload?.description) {
    lines.push(`Desc:     ${item.payload.description.slice(0, 60)}${item.payload.description.length > 60 ? "..." : ""}`);
  }

  if (item.result?.completedAt) {
    lines.push(`Completed: ${item.result.completedAt}`);
  }

  if (item.result?.approvedAt) {
    lines.push(`Approved: ${item.result.approvedAt}`);
  }

  if (item.result?.error) {
    lines.push(`Error:    ${item.result.error}`);
  }

  // Show spec path as a clickable link for easy navigation (see specLink()).
  const specPath = item.spec?.path
    || (existsSync(join(getKayaHome(), `Plans/Specs/Queue/${item.id}-spec.md`))
      ? join(getKayaHome(), `Plans/Specs/Queue/${item.id}-spec.md`)
      : undefined);
  if (specPath) {
    lines.push(`Spec:     ${specLink(specPath)}`);
  }

  if (item.result?.reviewNotes) {
    lines.push(`Notes:    ${item.result.reviewNotes}`);
  }

  lines.push("───────────────────────────────────────");

  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(`
QueueManager - Universal Queue Management for Kaya

Commands:
  add <title> [--desc <description>] [--id <custom-id>] [--queue name] [--priority 1-3] [--type task] [--notes "..."] [--no-spec] [--spec <path>]
  add --title <title> [--description <desc>] [--id <custom-id>] [--queue name] [--priority 1-3] [--type task] [--notes "..."] [--no-spec] [--spec <path>]
      Add an item to a queue (title can be positional or --title flag)
      --no-spec     Skip auto enrichment and spec generation
      --spec <path> Attach an existing spec/plan file (implies --no-spec)

  list [--queue name] [--status pending] [--priority 1-3]
      List items

  get <id>
      Get item details

  next [--queue name]
      Get next pending item

  update <id> --status <status>
      Update item status

  complete <id> [--output "result"]
      Mark item as completed

  fail <id> --error "reason"
      Mark item as failed

  approve <id> [--notes "..."] [--reviewer "..."]
      Approve an item (requires approved spec)

  approve-spec <id> [--reviewer "..."]
      Approve a draft spec on an item (does not approve the item itself)

  reject <id> [--reason "..."] [--reviewer "..."]
      Reject an item

  transfer <id> --to <target-queue> [--status <status>] [--notes "..."] [--by "..."] [--priority 1-3]
      Transfer item to another queue (preserves all metadata)

  remove <id>
      Remove an item

  stats [--queue name]
      Show queue statistics

  cleanup [--days 30]
      Remove old completed/failed items

  recompute
      Rebuild state.json from actual JSONL data (fixes stat drift)

  reconcile [--dry-run]
      Archive queue items whose linked LucidTask is done/cancelled/someday.
      --dry-run  Report what would be archived without making any changes.

Progress Tracking:
  init-progress <id> <totalPhases>
      Initialize progress tracking for an item

  set-phase <id> <phase>
      Set the current phase number

  complete-phase <id> <phase>
      Mark a phase as completed

  update-isc <id> <criterion> <evidence>
      Mark ISC criterion complete (evidence REQUIRED)

  progress <id>
      Show progress details for an item

Examples:
  bun run QueueManager.ts add "Review PR" --desc "Check auth changes" --type approval
  bun run QueueManager.ts add "Custom Task" --id my-custom-id --desc "With custom ID" --notes "Linked spec"
  bun run QueueManager.ts add "My Feature" --desc "Details" --no-spec
  bun run QueueManager.ts add "My Feature" --desc "Details" --spec plans/my-feature-spec.md
  bun run QueueManager.ts list --status pending
  bun run QueueManager.ts approve abc123 --notes "Looks good!"
  bun run QueueManager.ts init-progress abc123 5
  bun run QueueManager.ts complete-phase abc123 1
  bun run QueueManager.ts update-isc abc123 "Tests pass" "PR #42"
  bun run QueueManager.ts progress abc123
  bun run QueueManager.ts stats
`);
    process.exit(0);
  }

  const qm = new QueueManager();

  // Helper to get arg value
  const getArg = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index !== -1 ? args[index + 1] : undefined;
  };

  switch (command) {
    case "add": {
      // Support both positional title and --title flag
      const titleFlag = getArg("title");
      const positionalTitle = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
      const title = titleFlag || positionalTitle;
      const description = getArg("description") || getArg("desc") || "";
      const queue = getArg("queue");
      const priority = getArg("priority") ? (parseInt(getArg("priority")!) as Priority) : undefined;
      const type = getArg("type");
      const source = getArg("source");
      const id = getArg("id");
      const notes = getArg("notes");
      const specPath = getArg("spec");
      const contextRaw = getArg("context");
      let context: Record<string, unknown> | undefined;
      if (contextRaw) {
        try {
          const parsed = JSON.parse(contextRaw);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            context = parsed as Record<string, unknown>;
          } else {
            console.error("Error: --context must be a JSON object (not array/primitive)");
            process.exit(1);
          }
        } catch {
          console.error(`Error: --context is not valid JSON: ${contextRaw.slice(0, 80)}`);
          process.exit(1);
        }
      }

      // Build spec object from --spec <path> if provided
      let spec: QueueItemSpec | undefined;
      if (specPath) {
        const { resolve } = await import("path");
        const resolvedPath = resolve(specPath);
        if (!existsSync(resolvedPath)) {
          console.error(`Error: spec file not found: ${resolvedPath}`);
          process.exit(1);
        }
        const specId = basename(resolvedPath, ".md");
        spec = {
          id: specId,
          path: resolvedPath,
          status: "approved",
          approvedAt: new Date().toISOString(),
        };
      }

      if (!title) {
        console.error("Error: title required (positional or --title)");
        process.exit(1);
      }

      // Use addSpecPipelineItem for spec-pipeline queue to ensure correct initial status
      const addPromise = queue === "spec-pipeline"
        ? qm.addSpecPipelineItem({ title, description, context }, { id, priority, type, source })
        : qm.add({ title, description }, { id, queue, priority, type, source, notes, spec, context });

      addPromise
        .then((newId) => {
          console.log(`Added item: ${newId}`);
          return qm.get(newId);
        })
        .then((item) => {
          if (item) console.log(formatItem(item));
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "list": {
      const positionalQueue = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
      const queue = getArg("queue") ?? positionalQueue;
      const status = getArg("status") as QueueItemStatus | undefined;
      const priority = getArg("priority") ? (parseInt(getArg("priority")!) as Priority) : undefined;

      qm.list({ queue, status, priority })
        .then((items) => {
          if (items.length === 0) {
            console.log("No items found.");
          } else {
            console.log(`\nFound ${items.length} items:\n`);
            for (const item of items) {
              console.log(formatItem(item));
            }
          }
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "get": {
      const id = args[1];
      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }

      qm.get(id)
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          console.log(formatItem(item));
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "next": {
      const queue = getArg("queue");

      qm.next(queue)
        .then((item) => {
          if (!item) {
            console.log("No pending items.");
          } else {
            console.log("Next pending item:");
            console.log(formatItem(item));
          }
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "update": {
      const id = args[1];
      const status = getArg("status") as QueueItemStatus | undefined;

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }

      qm.update(id, { status })
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          console.log(`Updated: ${id}`);
          console.log(formatItem(item));
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "transfer": {
      const id = args[1];
      const targetQueue = getArg("to");
      const status = getArg("status") as QueueItemStatus | undefined;
      const notes = getArg("notes");
      const transferredBy = getArg("by");
      const priority = getArg("priority") ? (parseInt(getArg("priority")!) as Priority) : undefined;

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }
      if (!targetQueue) {
        console.error("Error: --to <target-queue> required");
        process.exit(1);
      }

      qm.transfer(id, { targetQueue, status, notes, transferredBy, priority })
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          console.log(`Transferred: ${id} → ${targetQueue}`);
          console.log(formatItem(item));
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    case "complete": {
      const id = args[1];
      const output = getArg("output");

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }

      qm.complete(id, { output })
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          console.log(`Completed: ${id}`);
          console.log(formatItem(item));
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "fail": {
      const id = args[1];
      const error = getArg("error") || "Unknown error";

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }

      qm.fail(id, error)
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          console.log(`Failed: ${id}`);
          console.log(formatItem(item));
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "approve": {
      const id = args[1];
      const notes = getArg("notes");
      const reviewer = getArg("reviewer");

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }

      qm.approve(id, { notes, reviewer })
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          console.log(`Approved: ${id}`);
          if (item.queue === "approved-work") {
            console.log(`Promoted to approved-work queue`);
          }
          console.log(formatItem(item));
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    case "approve-spec": {
      const id = args[1];
      const reviewer = getArg("reviewer") || "Jm";

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }

      qm.approveSpec(id, reviewer)
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          console.log(`Spec approved for: ${id}`);
          console.log(`Spec status: draft -> approved`);
          console.log(`Item can now be approved via: approve ${id}`);
          console.log(formatItem(item));
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    case "reject": {
      const id = args[1];
      const reason = getArg("reason");
      const reviewer = getArg("reviewer");

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }

      // Check if item is in approvals queue — if so, route to spec-pipeline
      qm.get(id)
        .then(async (existing) => {
          if (!existing) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }

          let item: QueueItem | null;
          if (existing.queue === "approvals" && reason) {
            item = await qm.rejectToSpecPipeline(id, reason, reviewer);
            if (item) {
              console.log(`Rejected: ${id}`);
              console.log(`Transferred to spec-pipeline (status: ${item.status})`);
              console.log(formatItem(item));
            }
          } else {
            item = await qm.reject(id, { reason, reviewer });
            if (item) {
              console.log(`Rejected: ${id}`);
              console.log(formatItem(item));
            }
          }

          if (!item) {
            console.error(`Failed to reject: ${id}`);
            process.exit(1);
          }
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "remove": {
      const id = args[1];

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }

      qm.remove(id)
        .then((removed) => {
          if (!removed) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          console.log(`Removed: ${id}`);
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "stats": {
      const queue = getArg("queue");

      qm.stats(queue)
        .then((stats) => {
          console.log(`
Queue Statistics${queue ? ` (${queue})` : ""}:
  Total:              ${stats.total}
  Pending:            ${stats.pending}
  In Progress:        ${stats.inProgress}
  Awaiting Approval:  ${stats.awaitingApproval}
  Completed:          ${stats.completed}
  Failed:             ${stats.failed}

By Priority:
  HIGH (1):           ${stats.byPriority[1]}
  NORMAL (2):         ${stats.byPriority[2]}
  LOW (3):            ${stats.byPriority[3]}

By Queue:
${Object.entries(stats.byQueue)
  .map(([q, count]) => `  ${q}: ${count}`)
  .join("\n")}
`);
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "cleanup": {
      const days = getArg("days") ? parseInt(getArg("days")!) : 30;

      qm.cleanup(days)
        .then((result) => {
          console.log(`Cleanup complete: removed ${result.removed} items (${result.archived} archived to MEMORY/QUEUES/archive/)`);
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    // =========================================================================
    // Progress Tracking Commands
    // =========================================================================

    case "init-progress": {
      const id = args[1];
      const totalPhases = args[2] ? parseInt(args[2]) : undefined;

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }
      if (!totalPhases || isNaN(totalPhases) || totalPhases < 1) {
        console.error("Error: totalPhases must be a positive number");
        process.exit(1);
      }

      qm.initProgress(id, totalPhases)
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          console.log(`✅ Progress initialized: ${totalPhases} phases`);
          console.log(`   Current phase: 1/${totalPhases}`);
          console.log(`   Phases completed: none`);
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    case "set-phase": {
      const id = args[1];
      const phase = args[2] ? parseInt(args[2]) : undefined;

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }
      if (!phase || isNaN(phase)) {
        console.error("Error: phase number required");
        process.exit(1);
      }

      qm.setPhase(id, phase)
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          console.log(`✅ Current phase set to: ${phase}/${item.progress?.totalPhases}`);
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    case "complete-phase": {
      const id = args[1];
      const phase = args[2] ? parseInt(args[2]) : undefined;

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }
      if (!phase || isNaN(phase)) {
        console.error("Error: phase number required");
        process.exit(1);
      }

      qm.completePhase(id, phase)
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          const progress = item.progress!;
          console.log(`✅ Phase ${phase} marked complete`);
          console.log(`   Completed: [${progress.phasesCompleted.join(", ")}]`);
          console.log(`   Current phase: ${progress.currentPhase}/${progress.totalPhases}`);
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    case "update-isc": {
      const id = args[1];
      const criterion = args[2];
      const evidence = args[3];

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }
      if (!criterion) {
        console.error("Error: criterion required");
        process.exit(1);
      }
      if (!evidence) {
        console.error("Error: evidence is REQUIRED (PR link, test output, etc.)");
        process.exit(1);
      }

      qm.updateISC(id, criterion, true, evidence)
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          const iscProgress = qm.getISCProgress(item);
          console.log(`✅ ISC criterion completed: "${criterion.slice(0, 40)}${criterion.length > 40 ? "..." : ""}"`);
          console.log(`   Evidence: ${evidence}`);
          console.log(`   ISC progress: ${iscProgress.completed}/${iscProgress.total}`);
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    case "progress": {
      const id = args[1];

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }

      qm.get(id)
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          if (!item.progress) {
            console.log(`No progress tracking for item: ${id}`);
            console.log(`Use 'init-progress ${id} <totalPhases>' to initialize.`);
            process.exit(0);
          }

          const progress = item.progress;
          const iscProgress = qm.getISCProgress(item);
          const isComplete = qm.isFullyComplete(item);

          console.log(`
Progress for: ${item.payload.title}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Phase Progress:
  Current Phase:   ${progress.currentPhase}/${progress.totalPhases}
  Completed:       [${progress.phasesCompleted.join(", ") || "none"}]
  All Done:        ${isComplete ? "✅ Yes" : "❌ No"}

ISC Progress:
  Completed:       ${iscProgress.completed}/${iscProgress.total}
`);

          if (Object.keys(progress.iscStatus).length > 0) {
            console.log("ISC Criteria:");
            for (const [criterion, status] of Object.entries(progress.iscStatus)) {
              const check = status.completed ? "✅" : "⬜";
              const desc = criterion.length > 50 ? criterion.slice(0, 50) + "..." : criterion;
              console.log(`  ${check} ${desc}`);
              if (status.evidence) {
                console.log(`     Evidence: ${status.evidence}`);
              }
            }
          }

          console.log(`
Last Updated: ${progress.lastUpdated}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    case "recompute": {
      qm.recomputeStats()
        .then((state) => {
          console.log(`✅ State recomputed from JSONL data:`);
          console.log(`   Queues:          [${state.queues.join(", ")}]`);
          console.log(`   Total items:     ${state.stats.totalItems}`);
          console.log(`   Total processed: ${state.stats.totalProcessed}`);
          if (state.stats.lastProcessedAt) {
            console.log(`   Last processed:  ${state.stats.lastProcessedAt}`);
          }
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    case "reconcile": {
      const dryRun = args.includes("--dry-run");
      const { reconcileQueueWithLucidTasks } = await import("./QueueTaskReconciler.ts");

      console.log(`QueueTaskReconciler — ${dryRun ? "DRY RUN" : "LIVE"}`);
      console.log("Querying closed LucidTasks and scanning queue items...\n");

      reconcileQueueWithLucidTasks({ dryRun })
        .then((report) => {
          console.log(`Scanned:        ${report.scanned} items with lucidTaskId`);
          console.log(`Matched closed: ${report.matchedClosed}`);
          console.log(`Archived:       ${report.archived.length}`);
          console.log(`Skipped:        ${report.skipped.length}`);
          console.log(`Mode:           ${report.dryRun ? "dry-run (no changes made)" : "live"}`);

          if (report.archived.length > 0) {
            console.log("\nArchived items:");
            for (const entry of report.archived) {
              const prefix = dryRun ? "[would archive]" : "[archived]";
              console.log(`  ${prefix} ${entry.itemId}  lucid:${entry.lucidTaskId}  taskStatus:${entry.taskStatus}`);
              console.log(`           title: ${entry.title}`);
            }
          }

          if (report.skipped.length > 0) {
            console.log("\nSkipped items:");
            for (const entry of report.skipped) {
              console.log(`  [skipped] ${entry.itemId}  reason: ${entry.reason}`);
            }
          }

          if (report.archived.length === 0 && report.skipped.length === 0) {
            console.log("\nNo orphaned items found — queues are consistent with LucidTasks.");
          }
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    // =========================================================================
    // Spec Pipeline Commands
    // =========================================================================

    case "context": {
      // context <id> --notes "..." --research "..." [--scope "..."]
      const id = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
      const notes = getArg("notes");
      const research = getArg("research");
      const scope = getArg("scope");

      if (!id) {
        console.error("Error: item ID required");
        console.error("Usage: context <id> --notes \"Problem context\" --research \"Research guidance\" [--scope \"Scope hints\"]");
        process.exit(1);
      }
      if (!notes) {
        console.error("Error: --notes required");
        process.exit(1);
      }
      if (!research) {
        console.error("Error: --research required");
        process.exit(1);
      }

      qm.attachContext(id, notes, research, scope)
        .then((item) => {
          if (!item) {
            console.error(`Item not found in spec-pipeline: ${id}`);
            process.exit(1);
          }
          console.log(`Context attached: ${id}`);
          console.log(`Status: awaiting-context → researching`);
          console.log(formatItem(item));
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    case "pipeline-list": {
      // pipeline-list [--status <status>]
      const pipelineStatus = getArg("status");

      qm.listSpecPipeline(pipelineStatus)
        .then((items) => {
          if (items.length === 0) {
            console.log(`No spec-pipeline items${pipelineStatus ? ` with status "${pipelineStatus}"` : ""}.`);
          } else {
            console.log(`\nSpec Pipeline (${items.length} items${pipelineStatus ? `, status: ${pipelineStatus}` : ""}):\n`);
            for (const item of items) {
              const ctx = item.payload.context as Record<string, unknown> | undefined;
              const meta = ctx?._meta as Record<string, unknown> | undefined;
              const revCount = meta?.revisionCount ?? 0;
              const hasContext = !!(ctx?.notes);
              const statusLine = `${item.status}${revCount ? ` (rev:${revCount})` : ""}${hasContext ? " [ctx]" : ""}`;
              console.log(`  ${item.id}  ${item.payload.title.slice(0, 50)}  [${statusLine}]`);
            }
            console.log("");
          }
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "reject-to-pipeline": {
      // reject-to-pipeline <id> [--reason "..."] [--reviewer "..."]
      const id = args[1];
      const reason = getArg("reason") || "No reason provided";
      const reviewer = getArg("reviewer");

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }

      qm.rejectToSpecPipeline(id, reason, reviewer)
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          const meta = (item.payload.context?._meta as Record<string, unknown>) || {};
          const revCount = meta.revisionCount ?? 1;
          console.log(`Rejected → spec-pipeline: ${id}`);
          console.log(`Status: ${item.status}`);
          console.log(`Revision count: ${revCount}`);
          if (item.status === "escalated") {
            console.log(`ESCALATED: 3 rejections reached — manual review required`);
          }
          console.log(formatItem(item));
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    case "park-for-grill": {
      // park-for-grill <id> --brief '<json>'
      // OR convenience flags: --missing "a|b" --questions "a|b" [--confidence 0.7]
      const id = args[1] && !args[1].startsWith("--") ? args[1] : undefined;

      if (!id) {
        console.error("Error: item ID required");
        console.error("Usage: park-for-grill <id> --brief '{\"missing\":[...],\"suggested_questions\":[...]}' [--confidence 0.7]");
        console.error("   OR: park-for-grill <id> --missing \"a|b\" --questions \"a|b\" [--confidence 0.7]");
        process.exit(1);
      }

      let brief: { missing: string[]; suggested_questions: string[]; confidence?: number };

      const briefRaw = getArg("brief");
      if (briefRaw) {
        // --brief '<json>' form
        let parsed: unknown;
        try {
          parsed = JSON.parse(briefRaw);
        } catch {
          console.error(`Error: --brief is not valid JSON: ${briefRaw.slice(0, 120)}`);
          process.exit(1);
        }
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !Array.isArray((parsed as Record<string, unknown>).missing) ||
          !Array.isArray((parsed as Record<string, unknown>).suggested_questions)
        ) {
          console.error("Error: --brief JSON must have missing[] and suggested_questions[] arrays");
          process.exit(1);
        }
        const p = parsed as Record<string, unknown>;
        brief = {
          missing: p.missing as string[],
          suggested_questions: p.suggested_questions as string[],
          ...(typeof p.confidence === "number" ? { confidence: p.confidence } : {}),
        };
      } else {
        // Convenience flags: --missing "a|b" --questions "a|b" [--confidence 0.7]
        const missingRaw = getArg("missing");
        const questionsRaw = getArg("questions");
        if (!missingRaw || !questionsRaw) {
          console.error("Error: provide either --brief '<json>' or both --missing and --questions");
          process.exit(1);
        }
        const confidenceRaw = getArg("confidence");
        const confidence = confidenceRaw ? parseFloat(confidenceRaw) : undefined;
        brief = {
          missing: missingRaw.split("|").map((s) => s.trim()).filter(Boolean),
          suggested_questions: questionsRaw.split("|").map((s) => s.trim()).filter(Boolean),
          ...(confidence !== undefined && !isNaN(confidence) ? { confidence } : {}),
        };
      }

      // --force overrides the grill-stamp guard (re-park an already-grilled
      // item). Without it, parking grilled content throws with guidance.
      qm.parkForGrill(id, brief, { force: args.includes("--force") })
        .then((item) => {
          if (!item) {
            console.error(`Item not found in spec-pipeline: ${id}`);
            process.exit(1);
          }
          console.log(`Parked for grill: ${id}`);
          console.log(`Status: ${item.status}`);
          console.log(formatItem(item));
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    // =========================================================================
    // Grill Commands (Slice 3 — human-present only)
    // =========================================================================

    case "grill": {
      // grill <subcommand> [args...]
      // HUMAN-PRESENT ONLY — never invoke headless / from cron / via claude -p.
      const grillSub = args[1];

      if (!grillSub || grillSub === "--help") {
        console.log(`
grill — Interactive grill session (human-present only)

Subcommands:
  grill list                               Show top 5 parked items (of the true total)
  grill next                               Auto-select the oldest-waiting item + print its brief (display-only)
  grill draft-findings <id> [--file <path>]  Draft a findings doc from a transcript (stdin or --file); prints only, never persists/finalizes
  grill finalize <id> --notes "..." --research "..." [--scope "..."] [--findings <path>] [--deep-research]
  grill kill <id> [--lucid <lucidTaskId>]
  grill split <id> --titles "a|b|c" [--lucid <parentLtid>]
  grill defer <id> [--until <iso>]

Finalize paths:
  --findings <path>   Grill-written research findings artifact — the research
                      phase dispatches its VERDICT directly (no autonomous
                      research spawn). Recommended for every grill.
  (no --findings)     Pipeline runs the autonomous research subagent (15-30 min).
  --deep-research     Force the autonomous spawn even when findings are provided.

WARNING: Never invoke grill headless, from cron, or via claude -p.
`);
        process.exit(0);
      }

      const {
        listParkedForGrill: grillList,
        finalizeGrillToSpec,
        killTask,
        splitTask,
        deferTask,
        draftFindings,
        getGrillBacklogSummary,
        getGrillBrief,
        getGrillBriefForId,
        formatBacklogLabel,
      } = await import("./GrillRunner.ts");

      const priorityLabel: Record<string, string> = {
        "1": "HIGH", "2": "NORMAL", "3": "LOW",
      };

      switch (grillSub) {
        case "list": {
          const limitStr = getArg("limit");
          const limit = limitStr ? parseInt(limitStr) : 5;
          const items = grillList(limit);
          const total = getGrillBacklogSummary().total;
          if (items.length === 0) {
            console.log("No items parked for grill.");
          } else {
            console.log(`\nParked for Grill (${formatBacklogLabel(items.length, total)}):\n`);
            for (const item of items) {
              const brief = getGrillBrief(item);
              console.log(`  ${item.id}  ${item.payload.title}  [${priorityLabel[String(item.priority)] ?? item.priority}]`);
              if (brief.missing.length) {
                console.log(`    Missing: ${brief.missing.join("; ")}`);
              }
              if (brief.suggestedQuestions.length) {
                for (const q of brief.suggestedQuestions) {
                  console.log(`    ? ${q}`);
                }
              }
              console.log("");
            }
          }
          break;
        }

        case "next": {
          // Display-only: auto-selects the oldest-waiting item (oldest-first
          // is the sensible default) and prints its grill brief, ready for an
          // in-session interview. Never writes/mutates queue state.
          const summary = getGrillBacklogSummary();
          if (!summary.topItem) {
            console.log("No items parked for grill.");
            break;
          }
          console.log(`\n${summary.total} waiting, oldest ${Math.round(summary.oldestAgeDays)} days\n`);
          console.log(`Selected: ${summary.topItem.id}  ${summary.topItem.title}`);
          console.log(`Why: ${summary.topItem.whyTop}\n`);
          const brief = getGrillBriefForId(summary.topItem.id);
          if (brief?.missing.length) {
            console.log(`Missing: ${brief.missing.join("; ")}`);
          }
          if (brief?.suggestedQuestions.length) {
            for (const q of brief.suggestedQuestions) {
              console.log(`  ? ${q}`);
            }
            console.log(`\nTip: bun ~/.claude/skills/Automation/QueueRouter/Tools/GrillPreResearch.ts ${summary.topItem.id}  (narrow to human-only questions before the interview)`);
          }
          console.log("");
          break;
        }

        case "draft-findings": {
          // Draft-only: prints a findings draft for review, never writes the
          // artifact and never calls finalize. Draft goes to stdout (clean —
          // safe to redirect to a file); status/errors go to stderr.
          const id = args[2] && !args[2].startsWith("--") ? args[2] : undefined;
          const filePath = getArg("file");

          if (!id) {
            console.error("Error: item ID required");
            console.error("Usage: grill draft-findings <id> [--file <transcriptPath>]  (reads stdin if --file omitted)");
            process.exit(1);
          }

          const readTranscript = async (): Promise<string> => {
            if (filePath) {
              if (!existsSync(filePath)) {
                console.error(`Error: --file not found: ${filePath}`);
                process.exit(1);
              }
              return readFileSync(filePath, "utf-8");
            }
            const chunks: string[] = [];
            const reader = Bun.stdin.stream().getReader();
            const decoder = new TextDecoder();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(decoder.decode(value, { stream: true }));
            }
            return chunks.join("");
          };

          readTranscript()
            .then(async (transcript) => {
              if (!transcript.trim()) {
                console.error("Error: no transcript provided (empty stdin and no --file)");
                process.exit(1);
              }
              const result = await draftFindings(id, transcript);
              if (!result.ok) {
                console.error(`draft-findings failed: ${result.message}`);
                process.exit(1);
              }
              console.error(`Draft generated for ${id} — REVIEW before finalize (this is a draft, not a finalized artifact).`);
              console.error(`To save it: re-run and redirect stdout, e.g.:\n  bun ~/.claude/skills/Automation/QueueRouter/Tools/CLI.ts grill draft-findings ${id} --file <transcript> > ~/.claude/MEMORY/WORK/grill-${id}-findings.md\n`);
              console.log(result.draft);
            })
            .catch((e) => {
              console.error(`Error: ${e instanceof Error ? e.message : e}`);
              process.exit(1);
            });
          break;
        }

        case "finalize": {
          const id = args[2] && !args[2].startsWith("--") ? args[2] : undefined;
          const notes = getArg("notes");
          const research = getArg("research");
          const scope = getArg("scope");
          const findings = getArg("findings");
          const deepResearch = args.includes("--deep-research");

          if (!id) {
            console.error("Error: item ID required");
            console.error("Usage: grill finalize <id> --notes \"...\" --research \"...\" [--scope \"...\"] [--findings <path>] [--deep-research]");
            process.exit(1);
          }
          if (!notes) {
            console.error("Error: --notes required");
            process.exit(1);
          }
          if (!research) {
            console.error("Error: --research required");
            process.exit(1);
          }
          if (findings && !existsSync(findings)) {
            console.error(`Error: --findings file not found: ${findings}`);
            process.exit(1);
          }

          finalizeGrillToSpec(id, { notes, researchGuidance: research, scopeHints: scope, findingsPath: findings, deepResearch })
            .then((r) => {
              if (r.ok) {
                console.log(`Finalized: ${id} → status: ${r.status}`);
                if (r.specPath) console.log(`Spec: ${specLink(r.specPath)}`);
              } else {
                console.error(`Finalize failed: ${r.message}`);
                process.exit(1);
              }
            })
            .catch((e) => {
              console.error(`Error: ${e instanceof Error ? e.message : e}`);
              process.exit(1);
            });
          break;
        }

        case "kill": {
          const id = args[2] && !args[2].startsWith("--") ? args[2] : undefined;
          const lucidOverride = getArg("lucid");

          if (!id) {
            console.error("Error: item ID required");
            console.error("Usage: grill kill <id> [--lucid <lucidTaskId>]");
            process.exit(1);
          }

          // Resolve the lucidTaskId: explicit --lucid flag wins; otherwise fall back to
          // the item's own payload.context.lucidTaskId so callers don't have to look it up.
          const resolveAndKill = async (): Promise<void> => {
            let lucidTaskId = lucidOverride;
            if (!lucidTaskId) {
              const item = await qm.get(id);
              const ctxId = item?.payload?.context?.lucidTaskId;
              if (typeof ctxId === "string" && ctxId) {
                lucidTaskId = ctxId;
              }
            }

            const r = await killTask(id, { lucidTaskId });
            if (r.ok) {
              console.log(r.message);
            } else {
              console.error(`Kill failed: ${r.message}`);
              process.exit(1);
            }
          };

          resolveAndKill().catch((e) => {
            console.error(`Error: ${e instanceof Error ? e.message : e}`);
            process.exit(1);
          });
          break;
        }

        case "split": {
          const id = args[2] && !args[2].startsWith("--") ? args[2] : undefined;
          const titlesRaw = getArg("titles");
          const lucid = getArg("lucid");

          if (!id) {
            console.error("Error: item ID required");
            console.error("Usage: grill split <id> --titles \"a|b|c\" [--lucid <parentLtid>]");
            process.exit(1);
          }
          if (!titlesRaw) {
            console.error("Error: --titles required");
            process.exit(1);
          }

          const titles = titlesRaw.split("|").map((s) => s.trim()).filter(Boolean);
          if (titles.length === 0) {
            console.error("Error: --titles must contain at least one non-empty title");
            process.exit(1);
          }

          splitTask(id, titles, { lucidParentId: lucid })
            .then((r) => {
              if (r.ok) {
                console.log(r.message);
                console.log(`Child IDs: ${r.childIds.join(", ")}`);
              } else {
                console.error(`Split failed: ${r.message}`);
                process.exit(1);
              }
            })
            .catch((e) => {
              console.error(`Error: ${e instanceof Error ? e.message : e}`);
              process.exit(1);
            });
          break;
        }

        case "defer": {
          const id = args[2] && !args[2].startsWith("--") ? args[2] : undefined;
          const until = getArg("until");

          if (!id) {
            console.error("Error: item ID required");
            console.error("Usage: grill defer <id> [--until <iso>]");
            process.exit(1);
          }

          deferTask(id, { until })
            .then((r) => {
              if (r.ok) {
                console.log(r.message);
              } else {
                console.error(`Defer failed: ${r.message}`);
                process.exit(1);
              }
            })
            .catch((e) => {
              console.error(`Error: ${e instanceof Error ? e.message : e}`);
              process.exit(1);
            });
          break;
        }

        default:
          console.error(`Unknown grill subcommand: ${grillSub}`);
          console.error("Use 'grill --help' for usage.");
          process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Use --help for usage.");
      process.exit(1);
  }
}
