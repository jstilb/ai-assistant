#!/usr/bin/env bun
/**
 * MigrateApprovalsToSpecPipeline.ts - One-time migration script
 *
 * Moves awaiting_approval items from the approvals queue to spec-pipeline.
 * Items without specs are transferred; items with specs stay in approvals.
 *
 * Applies the same context sufficiency heuristic as QueueManager.addSpecPipelineItem():
 *   - Items with descriptions >= 200 chars AND 2+ sentences → auto-advance to "researching"
 *   - Others → land at "awaiting-context"
 *
 * Usage:
 *   bun run MigrateApprovalsToSpecPipeline.ts --dry-run    # Preview what would happen
 *   bun run MigrateApprovalsToSpecPipeline.ts              # Execute migration
 *
 * @module MigrateApprovalsToSpecPipeline
 */

import {
  loadQueueItems,
  saveQueueItems,
  appendQueueItem,
  type QueueItem,
  type QueueItemStatus,
  QueueManager,
} from "./QueueManager.ts";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const KAYA_HOME = process.env.KAYA_HOME || join(process.env.HOME || "", ".claude");
const STATE_FILE = join(KAYA_HOME, "MEMORY/QUEUES/state.json");

/**
 * Check if a description has sufficient context to skip awaiting-context.
 * Same heuristic as QueueManager.hassufficientContext().
 */
function hasSufficientContext(item: QueueItem): boolean {
  // Check if context already has notes + researchGuidance
  const ctx = item.payload.context as Record<string, unknown> | undefined;
  if (ctx?.notes && ctx?.researchGuidance) {
    return true;
  }

  const desc = item.payload.description || "";
  if (desc.length < 200) return false;

  const sentences = desc.split(/[.!?]+\s+|[.!?]+$/).filter((s) => s.trim().length > 0);
  return sentences.length >= 2;
}

interface MigrationResult {
  total: number;
  migrated: number;
  autoAdvanced: number;
  awaitingContext: number;
  skipped: number;
  skippedReasons: Array<{ id: string; title: string; reason: string }>;
}

async function migrate(dryRun: boolean): Promise<MigrationResult> {
  const approvals = loadQueueItems("approvals");

  const result: MigrationResult = {
    total: approvals.length,
    migrated: 0,
    autoAdvanced: 0,
    awaitingContext: 0,
    skipped: 0,
    skippedReasons: [],
  };

  // Filter: only awaiting_approval items without specs
  const toMigrate: QueueItem[] = [];
  const toKeep: QueueItem[] = [];

  for (const item of approvals) {
    if (item.status !== "awaiting_approval") {
      toKeep.push(item);
      result.skipped++;
      result.skippedReasons.push({
        id: item.id,
        title: item.payload.title.slice(0, 50),
        reason: `status=${item.status} (not awaiting_approval)`,
      });
      continue;
    }

    if (item.spec) {
      toKeep.push(item);
      result.skipped++;
      result.skippedReasons.push({
        id: item.id,
        title: item.payload.title.slice(0, 50),
        reason: `has spec (status=${item.spec.status})`,
      });
      continue;
    }

    toMigrate.push(item);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Migration: approvals → spec-pipeline`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Mode:           ${dryRun ? "DRY RUN (no changes)" : "EXECUTE"}`);
  console.log(`Total in approvals: ${approvals.length}`);
  console.log(`To migrate:         ${toMigrate.length}`);
  console.log(`Skipped:            ${result.skipped}`);
  console.log(`${"=".repeat(60)}\n`);

  if (toMigrate.length === 0) {
    console.log("Nothing to migrate.");
    return result;
  }

  // Classify each item
  for (const item of toMigrate) {
    const sufficient = hasSufficientContext(item);
    const targetStatus: QueueItemStatus = sufficient ? "researching" : "awaiting-context";

    if (sufficient) {
      result.autoAdvanced++;
    } else {
      result.awaitingContext++;
    }

    const tag = sufficient ? "[AUTO-ADVANCE]" : "[AWAIT-CTX]   ";
    const descLen = (item.payload.description || "").length;
    console.log(`  ${tag} ${item.id.slice(0, 10)}  "${item.payload.title.slice(0, 45)}"  (desc: ${descLen} chars)`);

    if (!dryRun) {
      // Build migrated item
      const migrated: QueueItem = {
        ...JSON.parse(JSON.stringify(item)),
        queue: "spec-pipeline",
        status: targetStatus,
        updated: new Date().toISOString(),
        routing: {
          ...item.routing,
          sourceQueue: "approvals",
          targetQueue: "spec-pipeline",
        },
        payload: {
          ...item.payload,
          context: {
            ...(item.payload.context || {}),
            _meta: {
              ...((item.payload.context?._meta as Record<string, unknown>) || {}),
              migratedFrom: "approvals",
              migratedAt: new Date().toISOString(),
            },
            // For auto-advanced items, attach context so they're ready for research
            ...(sufficient
              ? {
                  notes: item.payload.description,
                  researchGuidance:
                    "Auto-advanced: description meets sufficiency threshold. Research based on description content.",
                  contextAttachedAt: new Date().toISOString(),
                }
              : {}),
          },
        },
      };

      appendQueueItem("spec-pipeline", migrated);
      result.migrated++;
    }
  }

  if (!dryRun) {
    // Rewrite approvals without migrated items
    saveQueueItems("approvals", toKeep);

    // Recompute state.json
    const qm = new QueueManager();
    await qm.recomputeStats();

    console.log(`\nMigration complete.`);
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Summary:`);
  console.log(`  Migrated:          ${dryRun ? toMigrate.length + " (would migrate)" : result.migrated}`);
  console.log(`  Auto-advanced:     ${result.autoAdvanced} (→ researching)`);
  console.log(`  Awaiting context:  ${result.awaitingContext} (→ awaiting-context)`);
  console.log(`  Skipped:           ${result.skipped}`);
  console.log(`${"─".repeat(60)}\n`);

  return result;
}

// CLI
if (import.meta.main) {
  const dryRun = process.argv.includes("--dry-run");

  migrate(dryRun)
    .then((result) => {
      if (!dryRun && result.migrated > 0) {
        console.log(`Done. Run 'bun QueueManager.ts stats' to verify.`);
      }
    })
    .catch((e) => {
      console.error(`Migration failed: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    });
}
