#!/usr/bin/env bun
/**
 * ApprovalQueueBlock.ts - Pending approval items from queue
 *
 * Reads MEMORY/QUEUES/approvals.jsonl directly to show items awaiting approval.
 * Shows spec status for each item (NEEDS SPEC / SPEC READY / SPEC APPROVED).
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { BlockResult } from "./types.ts";

export type { BlockResult };

const KAYA_HOME = process.env.KAYA_DIR || join(process.env.HOME!, ".claude");
const APPROVALS_FILE = join(KAYA_HOME, "MEMORY", "QUEUES", "approvals.jsonl");
const QUEUE_SPECS_DIR = join(KAYA_HOME, "plans", "Specs", "Queue");

interface QueueItemSpec {
  id: string;
  path: string;
  status: "approved";
  approvedAt: string;
  approvedBy?: string;
}

interface QueueItem {
  id: string;
  created: string;
  status: string;
  priority: number;
  payload: {
    title: string;
    description: string;
  };
  spec?: QueueItemSpec;
}

export interface ApprovalQueueBlockConfig {
  maxItems?: number;
  includeAge?: boolean;
  showSpecStatus?: boolean;
}

function formatAge(created: string): string {
  const createdDate = new Date(created);
  const now = new Date();
  const diffMs = now.getTime() - createdDate.getTime();

  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays > 0) return `${diffDays}d ago`;
  if (diffHours > 0) return `${diffHours}h ago`;
  if (diffMins > 0) return `${diffMins}m ago`;
  return "just now";
}

/**
 * Get spec status for a queue item
 * Returns: "NEEDS SPEC" | "SPEC READY" | "SPEC APPROVED"
 */
function getSpecStatus(item: QueueItem): { label: string; hasApprovedSpec: boolean; hasDraft: boolean } {
  // Check if item has approved spec linked
  if (item.spec?.status === "approved") {
    return { label: "**[SPEC APPROVED]**", hasApprovedSpec: true, hasDraft: false };
  }

  // Check if a draft spec file exists
  const specPath = join(QUEUE_SPECS_DIR, `${item.id}-spec.md`);
  if (existsSync(specPath)) {
    return { label: "**[SPEC READY]**", hasApprovedSpec: false, hasDraft: true };
  }

  // No spec at all
  return { label: "**[NEEDS SPEC]**", hasApprovedSpec: false, hasDraft: false };
}

export async function execute(config: ApprovalQueueBlockConfig = {}): Promise<BlockResult> {
  const { maxItems = 10, includeAge = true, showSpecStatus = true } = config;

  try {
    if (!existsSync(APPROVALS_FILE)) {
      return {
        blockName: "approvalQueue",
        success: true,
        data: { items: [], awaitingCount: 0, pendingCount: 0, highPriorityCount: 0 },
        markdown: "## Approval Queue\n\nNo pending approvals.\n",
        summary: "Queue empty",
      };
    }

    const content = readFileSync(APPROVALS_FILE, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    const items: QueueItem[] = [];
    for (const line of lines) {
      try {
        const item = JSON.parse(line) as QueueItem;
        // Only include pending or awaiting_approval items
        if (item.status === "pending" || item.status === "awaiting_approval") {
          items.push(item);
        }
      } catch {
        // Skip invalid lines
      }
    }

    // Sort by priority (1 = highest) then by created date
    items.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return new Date(a.created).getTime() - new Date(b.created).getTime();
    });

    // Count by status
    const awaitingApproval = items.filter((i) => i.status === "awaiting_approval");
    const pending = items.filter((i) => i.status === "pending");
    const highPriority = items.filter((i) => i.priority === 1);

    // Format markdown
    let markdown = "## Approval Queue\n\n";

    if (items.length === 0) {
      markdown += "No pending approvals.\n";
    } else {
      // Quick summary line at top
      const summaryParts: string[] = [];
      if (awaitingApproval.length > 0) summaryParts.push(`**${awaitingApproval.length}** awaiting approval`);
      if (pending.length > 0) summaryParts.push(`**${pending.length}** pending`);
      if (highPriority.length > 0) summaryParts.push(`**${highPriority.length}** high priority`);
      markdown += `📋 ${summaryParts.join(", ")}\n\n`;
      if (awaitingApproval.length > 0) {
        markdown += `**Awaiting Approval (${awaitingApproval.length}):**\n`;
        for (const item of awaitingApproval.slice(0, maxItems)) {
          const age = includeAge ? ` (${formatAge(item.created)})` : "";
          const priority = item.priority === 1 ? " **HIGH**" : "";
          const specStatus = showSpecStatus ? ` ${getSpecStatus(item).label}` : "";
          markdown += `- [${item.id.slice(0, 8)}] ${item.payload.title}${priority}${age}${specStatus}\n`;
        }
        markdown += "\n";
      }

      if (pending.length > 0) {
        markdown += `**Pending Review (${pending.length}):**\n`;
        for (const item of pending.slice(0, Math.max(0, maxItems - awaitingApproval.length))) {
          const age = includeAge ? ` (${formatAge(item.created)})` : "";
          const priority = item.priority === 1 ? " **HIGH**" : "";
          const specStatus = showSpecStatus ? ` ${getSpecStatus(item).label}` : "";
          markdown += `- [${item.id.slice(0, 8)}] ${item.payload.title}${priority}${age}${specStatus}\n`;
        }
      }

      if (items.length > maxItems) {
        markdown += `\n...and ${items.length - maxItems} more in queue\n`;
      }

      // Add tip about items needing specs
      if (showSpecStatus) {
        const needingSpecs = items.filter((item) => !getSpecStatus(item).hasApprovedSpec && !getSpecStatus(item).hasDraft);
        if (needingSpecs.length > 0) {
          markdown += `\n> **Tip:** ${needingSpecs.length} item${needingSpecs.length === 1 ? '' : 's'} need${needingSpecs.length === 1 ? 's' : ''} specs. Run \`/queue review\` to create them.\n`;
        }
      }
    }

    // Count items needing specs for data
    const needingSpecsCount = items.filter((item) => !getSpecStatus(item).hasApprovedSpec && !getSpecStatus(item).hasDraft).length;
    const specReadyCount = items.filter((item) => getSpecStatus(item).hasDraft && !getSpecStatus(item).hasApprovedSpec).length;
    const specApprovedCount = items.filter((item) => getSpecStatus(item).hasApprovedSpec).length;

    // Generate summary
    const parts: string[] = [];
    if (awaitingApproval.length > 0) parts.push(`${awaitingApproval.length} awaiting`);
    if (highPriority.length > 0) parts.push(`${highPriority.length} high priority`);
    if (needingSpecsCount > 0) parts.push(`${needingSpecsCount} need specs`);
    const summary = parts.length > 0 ? parts.join(", ") : "Queue empty";

    return {
      blockName: "approvalQueue",
      success: true,
      data: {
        items: items.slice(0, maxItems),
        awaitingCount: awaitingApproval.length,
        pendingCount: pending.length,
        highPriorityCount: highPriority.length,
        totalCount: items.length,
        needingSpecsCount,
        specReadyCount,
        specApprovedCount,
      },
      markdown,
      summary,
    };
  } catch (error) {
    return {
      blockName: "approvalQueue",
      success: false,
      data: { items: [], awaitingCount: 0, pendingCount: 0, highPriorityCount: 0 },
      markdown: "## Approval Queue\n\nFailed to load queue.\n",
      summary: "Queue unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--test") || args.includes("-t")) {
    execute({ maxItems: 10, includeAge: true })
      .then((result) => {
        console.log("=== Approval Queue Block Test ===\n");
        console.log("Success:", result.success);
        console.log("\nMarkdown:\n", result.markdown);
        console.log("\nSummary:", result.summary);
        console.log("\nData:", JSON.stringify(result.data, null, 2));
      })
      .catch(console.error);
  } else {
    console.log("Usage: bun ApprovalQueueBlock.ts --test");
  }
}
