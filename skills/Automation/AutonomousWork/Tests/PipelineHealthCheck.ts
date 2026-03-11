import { readFileSync } from "fs";
import { join } from "path";

export interface HealthCheckResult {
  totalItems: number;
  byStatus: Record<string, number>;
  oldestPending: string | null;
}

interface WorkItem {
  id: string;
  status: string;
  createdAt?: string;
  title?: string;
}

interface WorkQueue {
  items: WorkItem[];
}

/**
 * Reads MEMORY/WORK/work-queue.json relative to the project root
 * and returns a health summary.
 *
 * @param workQueuePath - Absolute path to work-queue.json (optional; defaults to project root resolution)
 */
export function healthCheck(workQueuePath?: string): HealthCheckResult {
  // Default: resolve from the script location up to the project root (.claude/)
  // File is at: skills/Automation/AutonomousWork/Tests/PipelineHealthCheck.ts
  // Project root is 4 levels up from this file's directory.
  const queuePath =
    workQueuePath ??
    join(
      new URL("../../../..", import.meta.url).pathname,
      "MEMORY/WORK/work-queue.json"
    );

  const raw = readFileSync(queuePath, "utf-8");
  const queue: WorkQueue = JSON.parse(raw) as WorkQueue;
  const items: WorkItem[] = queue.items ?? [];

  const byStatus: Record<string, number> = {};
  for (const item of items) {
    const s = item.status ?? "unknown";
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }

  const pendingItems = items.filter((i) => i.status === "pending");
  let oldestPending: string | null = null;
  if (pendingItems.length > 0) {
    const sorted = [...pendingItems].sort((a, b) => {
      const aTime = a.createdAt ?? "";
      const bTime = b.createdAt ?? "";
      return aTime.localeCompare(bTime);
    });
    oldestPending = sorted[0].id;
  }

  return {
    totalItems: items.length,
    byStatus,
    oldestPending,
  };
}

// When run directly, print the result
if (import.meta.main) {
  const result = healthCheck();
  console.log(JSON.stringify(result, null, 2));
}
