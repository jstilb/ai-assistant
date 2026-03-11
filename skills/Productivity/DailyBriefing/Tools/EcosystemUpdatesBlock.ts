#!/usr/bin/env bun
/**
 * EcosystemUpdatesBlock.ts - Anthropic ecosystem updates for DailyBriefing
 *
 * Reads the latest KayaUpgrade triage results and surfaces:
 * - Count of actionable items from latest triage
 * - Top items with titles and priorities
 * - Link to queue for review
 *
 * Data source: KayaUpgrade/State/latest-triage-result.json
 * Falls back gracefully if no triage data exists.
 */

import { existsSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { createStateManager } from "../../../../lib/core/StateManager.ts";
import type { BlockResult } from "./types.ts";

const KAYA_HOME = process.env.KAYA_DIR || join(process.env.HOME!, ".claude");
const TRIAGE_STATE_PATH = join(
  KAYA_HOME,
  "skills",
  "KayaUpgrade",
  "State",
  "latest-triage-result.json",
);
const ANTHROPIC_FINDINGS_PATH = join(
  KAYA_HOME,
  "skills",
  "KayaUpgrade",
  "State",
  "latest-anthropic-findings.json",
);

const TriageStateSchema = z.object({
  timestamp: z.string(),
  level: z.string(),
  actionableCount: z.number(),
  dismissedCount: z.number(),
  items: z.array(
    z.object({
      title: z.string(),
      priority: z.number(),
      effort: z.string(),
    }),
  ),
});

const FindingsSchema = z.object({
  timestamp: z.string(),
  daysChecked: z.number(),
  updates: z.array(z.unknown()),
});

type TriageState = z.infer<typeof TriageStateSchema>;

export async function execute(
  config: Record<string, unknown> = {},
): Promise<BlockResult> {
  const maxItems = (config.maxItems as number) || 5;

  try {
    // Check if triage data exists
    if (!existsSync(TRIAGE_STATE_PATH)) {
      return {
        blockName: "ecosystemUpdates",
        success: true,
        data: { empty: true },
        markdown: "",
        summary: "No ecosystem triage data available",
      };
    }

    const triageState = createStateManager({
      path: TRIAGE_STATE_PATH,
      schema: TriageStateSchema,
      defaults: () => ({
        timestamp: "",
        level: "",
        actionableCount: 0,
        dismissedCount: 0,
        items: [],
      }),
    });
    const triage: TriageState = await triageState.load();

    if (!triage.timestamp) {
      return {
        blockName: "ecosystemUpdates",
        success: true,
        data: { empty: true },
        markdown: "",
        summary: "No ecosystem triage data available",
      };
    }

    // Check staleness (>14 days old = stale)
    const triageDate = new Date(triage.timestamp);
    const now = new Date();
    const daysSinceTriage = Math.floor(
      (now.getTime() - triageDate.getTime()) / (1000 * 60 * 60 * 24),
    );
    const isStale = daysSinceTriage > 14;

    // Get findings count for context
    let findingsCount = 0;
    if (existsSync(ANTHROPIC_FINDINGS_PATH)) {
      try {
        const findingsState = createStateManager({
          path: ANTHROPIC_FINDINGS_PATH,
          schema: FindingsSchema,
          defaults: () => ({ timestamp: "", daysChecked: 0, updates: [] }),
        });
        const findings = await findingsState.load();
        findingsCount = findings.updates?.length || 0;
      } catch {
        // ignore
      }
    }

    // Build markdown
    let markdown = "## Ecosystem Updates\n\n";

    if (isStale) {
      markdown += `*Last triage was ${daysSinceTriage} days ago — consider running \`check for upgrades\`.*\n\n`;
    }

    if (triage.actionableCount === 0) {
      markdown += `No actionable updates from last triage (${triage.dismissedCount} dismissed). Last checked: ${triageDate.toLocaleDateString()}.\n\n`;
    } else {
      markdown += `**${triage.actionableCount} actionable** from ${findingsCount || "?"} findings, ${triage.dismissedCount} dismissed.\n\n`;

      const itemsToShow = triage.items.slice(0, maxItems);
      if (itemsToShow.length > 0) {
        markdown += "| Priority | Item | Effort |\n";
        markdown += "|----------|------|--------|\n";
        for (const item of itemsToShow) {
          const pLabel =
            item.priority === 1
              ? "P1"
              : item.priority === 2
                ? "P2"
                : "P3";
          markdown += `| ${pLabel} | ${item.title} | ${item.effort} |\n`;
        }
        markdown += "\n";

        if (triage.items.length > maxItems) {
          markdown += `_+${triage.items.length - maxItems} more in queue_\n\n`;
        }
      }

      markdown += `_Review: \`/queue list\` | Last triage: ${triageDate.toLocaleDateString()}_\n\n`;
    }

    // Voice summary
    const summary =
      triage.actionableCount > 0
        ? `${triage.actionableCount} ecosystem update${triage.actionableCount > 1 ? "s" : ""} need review`
        : "No actionable ecosystem updates";

    return {
      blockName: "ecosystemUpdates",
      success: true,
      data: {
        actionableCount: triage.actionableCount,
        dismissedCount: triage.dismissedCount,
        items: triage.items,
        daysSinceTriage,
        isStale,
        lastTriageDate: triage.timestamp,
      },
      markdown,
      summary,
    };
  } catch (error) {
    return {
      blockName: "ecosystemUpdates",
      success: false,
      data: {},
      markdown: "",
      summary: "Ecosystem updates unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
