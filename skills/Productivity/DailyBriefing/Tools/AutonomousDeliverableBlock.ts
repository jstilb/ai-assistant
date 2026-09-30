#!/usr/bin/env bun
/**
 * AutonomousDeliverableBlock.ts - Autonomous deliverables awaiting review
 *
 * Queries the LucidTasks DB for tasks with disposition='autonomous' and
 * status='waiting', then surfaces each task's Deliverable note link from
 * the executor's activity-log comment (actor='executor',
 * text contains "Deliverable: [[...]]").
 */

import type { BlockResult } from "./types.ts";

const BLOCK_NAME = "autonomousDeliverables";

interface DeliverableItem {
  taskId: string;
  title: string;
  noteLink: string;
}

/**
 * Extract the first [[...]] wikilink from a string, or null if absent.
 */
function extractWikiLink(text: string): string | null {
  const match = text.match(/\[\[([^\]]+)\]\]/);
  return match ? `[[${match[1]}]]` : null;
}

export async function execute(
  config: Record<string, unknown> = {}
): Promise<BlockResult> {
  try {
    const { getTaskDB } = await import(
      "../../LucidTasks/Tools/TaskDB.ts"
    );
    const db = getTaskDB();

    // Raw SQL — disposition column may not be exposed on the typed API.
    const rows = db
      .getRawDb()
      .prepare(
        "SELECT * FROM tasks WHERE disposition='autonomous' AND status='waiting' ORDER BY updated_at DESC"
      )
      .all() as Array<{
        id: string;
        title: string;
        updated_at: string;
        [key: string]: unknown;
      }>;

    if (rows.length === 0) {
      return {
        blockName: BLOCK_NAME,
        success: true,
        data: { count: 0, items: [] },
        markdown: "",
        summary: "No autonomous deliverables awaiting review",
      };
    }

    const items: DeliverableItem[] = [];

    for (const row of rows) {
      // Scan the activity log for the most recent executor Deliverable comment.
      const log = db.getActivityLog(row.id, 20);

      let noteLink = "(no note link found)";

      for (const entry of log) {
        // Comments have action='comment'; executor sets actor='executor'.
        if (entry.action !== "comment" || entry.actor !== "executor") continue;
        if (!entry.changes) continue;

        let text = "";
        try {
          const parsed = JSON.parse(entry.changes) as { text?: string };
          text = parsed.text ?? "";
        } catch {
          continue;
        }

        if (text.includes("[[")) {
          const link = extractWikiLink(text);
          if (link) {
            noteLink = link;
            break; // activity_log is DESC by created_at — first match = newest
          }
        }
      }

      items.push({ taskId: row.id, title: row.title, noteLink });
    }

    // No markdown rendering — the live path (DataGatherer) reads only .data.
    const n = items.length;
    return {
      blockName: BLOCK_NAME,
      success: true,
      data: { count: n, items },
      markdown: "",
      summary: `${n} autonomous deliverable${n === 1 ? "" : "s"} awaiting your review`,
    };
  } catch (err) {
    return {
      blockName: BLOCK_NAME,
      success: false,
      data: {},
      markdown: "",
      summary: "",
      error: String(err),
    };
  }
}

// CLI entry point
if (import.meta.main) {
  execute()
    .then((result) => {
      console.log("=== AutonomousDeliverableBlock ===\n");
      console.log("Success:", result.success);
      console.log("\nMarkdown:\n", result.markdown);
      console.log("\nSummary:", result.summary);
      console.log("\nData:", JSON.stringify(result.data, null, 2));
    })
    .catch(console.error);
}
