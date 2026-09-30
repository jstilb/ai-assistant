/**
 * Reporting.ts — queue status/report output formatting.
 *
 * Extracted from WorkOrchestrator.ts (S11 decomposition, pass 1). Pure functions that
 * take an explicit WorkQueue (and, where ISC rows are needed, an injected `loadISC`
 * callback matching the orchestrator's private loadISC semantics — returns `undefined`
 * for an item with no rows) rather than reaching into `this`.
 */

import type { WorkQueue, WorkItem } from "../../WorkQueue.ts";
import type { ISCRow } from "../../WorkOrchestrator.ts";

export interface WorkReport {
  completed: WorkItem[];
  failed: WorkItem[];
  inProgress: WorkItem[];
  blocked: WorkItem[];
  needsReview: WorkItem[];
}

/** One-shot human-readable queue status: counts + blocked item list (status-blocked and DAG-blocked). */
export function statusReport(queue: WorkQueue): string {
  const s = queue.getStats();
  const statusBlocked = queue.getAllItems().filter((i) => i.status === "blocked");
  const dagBlocked = queue.getDagBlockedItems();
  const lines = [
    `Queue: ${s.total} total | ${s.ready} ready | ${s.inProgress} in-progress | ${s.completed} completed | ${s.failed} failed | ${s.blocked} blocked`,
  ];
  if (statusBlocked.length > 0 || dagBlocked.length > 0) {
    lines.push("Blocked:");
    for (const item of statusBlocked) {
      lines.push(`  ${item.id} — ${item.title.slice(0, 40)} [awaiting-human]`);
    }
    for (const item of dagBlocked) {
      const deps = item.dependencies.join(", ");
      lines.push(`  ${item.id} — ${item.title.slice(0, 40)} (waiting: ${deps})`);
    }
  }
  return lines.join("\n");
}

/** Categorize all queue items by actual status + verification (completed/failed/inProgress/blocked/needsReview). */
export function categorizeReport(queue: WorkQueue): WorkReport {
  const all = queue.getAllItems();
  const completed: WorkItem[] = [];
  const failed: WorkItem[] = [];
  const inProgress: WorkItem[] = [];
  const blocked: WorkItem[] = [];
  const needsReview: WorkItem[] = [];

  const dagBlockedIds = new Set(queue.getDagBlockedItems().map((i) => i.id));

  for (const item of all) {
    // Items only count as completed if verification.status === "verified"
    if (item.status === "completed" && item.verification?.status === "verified") {
      completed.push(item);
    } else if (item.status === "blocked") {
      blocked.push(item);
    } else if (item.status === "failed") {
      failed.push(item);
    } else if (item.status === "needs_review" || item.verification?.status === "needs_review") {
      needsReview.push(item);
    } else if (dagBlockedIds.has(item.id)) {
      blocked.push(item);
    } else if (item.status === "in_progress" || item.status === "partial") {
      inProgress.push(item);
    } else if (item.status === "pending") {
      // pending but not blocked — just pending
    }
  }

  return { completed, failed, inProgress, blocked, needsReview };
}

/** Markdown session report from a WorkReport, resolving each item's ISC ratio via loadISC. */
export function reportMarkdown(report: WorkReport, loadISC: (itemId: string) => ISCRow[] | undefined): string {
  const lines: string[] = ["# Session Report\n"];

  const formatItem = (item: WorkItem): string => {
    const v = item.verification;
    const verdict = v ? `${v.verdict} (${v.status})` : "no verification";
    const iscRows = loadISC(item.id);
    const iscRatio = iscRows
      ? `${iscRows.filter((r) => r.status === "VERIFIED").length}/${iscRows.length} ISC verified`
      : "no ISC";
    const concerns = v?.concerns?.length ? ` | concerns: ${v.concerns.join("; ")}` : "";
    return `- **${item.title}** [${item.id.slice(0, 8)}] — ${verdict} | ${iscRatio}${concerns}`;
  };

  if (report.completed.length > 0) {
    lines.push(`## Completed (${report.completed.length})`);
    for (const item of report.completed) lines.push(formatItem(item));
    lines.push("");
  }

  if (report.inProgress.length > 0) {
    lines.push(`## In Progress (${report.inProgress.length})`);
    for (const item of report.inProgress) lines.push(formatItem(item));
    lines.push("");
  }

  if (report.failed.length > 0) {
    lines.push(`## Failed (${report.failed.length})`);
    for (const item of report.failed) lines.push(formatItem(item));
    lines.push("");
  }

  if (report.blocked.length > 0) {
    lines.push(`## Blocked (${report.blocked.length})`);
    const statusBlocked = report.blocked.filter((i) => i.status === "blocked");
    const dagBlocked = report.blocked.filter((i) => i.status !== "blocked");
    for (const item of statusBlocked) {
      const manualRows = item.metadata?.manualRows as Array<{ id: number; description: string }> | undefined;
      const desc = manualRows ? manualRows.map((r) => `#${r.id}`).join(", ") : "";
      lines.push(`${formatItem(item)} [awaiting-human]${desc ? ` | manual rows: ${desc}` : ""}`);
    }
    for (const item of dagBlocked) {
      lines.push(`- **${item.title}** [${item.id.slice(0, 8)}] — waiting: ${item.dependencies.join(", ")}`);
    }
    lines.push("");
  }

  if (report.needsReview.length > 0) {
    lines.push(`## Needs Human Review (${report.needsReview.length})`);
    for (const item of report.needsReview) lines.push(formatItem(item));
    lines.push("");
  }

  return lines.join("\n");
}

/** Prior-work digest for VERIFIED/DONE ISC rows across the given completed item IDs. */
export function generatePriorWorkSummary(
  completedItemIds: string[],
  loadISC: (itemId: string) => ISCRow[] | undefined,
): string {
  if (completedItemIds.length === 0) return "";
  const parts: string[] = [];

  for (const id of completedItemIds) {
    const rows = loadISC(id);
    if (!rows) continue;
    const verified = rows.filter((r) => r.status === "VERIFIED" || r.status === "DONE");
    if (verified.length === 0) continue;
    const list = verified.map((r) => `  - ${r.description}`).join("\n");
    parts.push(`### ${id}\n${list}`);
  }

  if (parts.length === 0) return "";
  return `## Prior Work Completed\nDo not redo this work.\n\n${parts.join("\n\n")}`;
}
