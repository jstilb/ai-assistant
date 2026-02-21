#!/usr/bin/env bun
/**
 * GoalsBlock.ts - TELOS goals and missions for daily briefing
 *
 * Reads directly from TELOS files to extract:
 * - Q1 WIGs (Wildly Important Goals)
 * - Active missions
 * - Focus recommendations
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { BlockResult } from "./types.ts";

const KAYA_HOME = process.env.KAYA_DIR || join(process.env.HOME!, ".claude");
const KAYA_CLI = join(KAYA_HOME, "bin", "kaya-cli");
const TELOS_DIR = join(KAYA_HOME, "skills", "CORE", "USER", "TELOS");

// Goal achievement sheet for live WIG metrics
const GOAL_ACHIEVEMENT_SHEET_ID = "1iiX2qfRn6Gx1q1yLu5Xu8nV-x7S_KA45gykjgQKTJdw";
const GOAL_ACHIEVEMENT_RANGE = "A11:F12";

export type { BlockResult };

interface Goal {
  id: string;
  title: string;
  status?: string;
  metric?: string;
  current?: string;
  target?: string;
  isWIG: boolean;
}

interface Mission {
  id: string;
  title: string;
  focus?: string;
}

export interface GoalsBlockConfig {
  showWIGs?: boolean;
  showMissions?: boolean;
  maxGoals?: number;
}

/**
 * Fetch live WIG metrics from Google Sheets.
 * Row 12 layout: [metric_name, value, metric_name, value, metric_name, value]
 * Returns a map of WIG ID to current value string.
 */
async function fetchLiveWIGMetrics(): Promise<{ metrics: Map<string, string>; live: boolean }> {
  const metrics = new Map<string, string>();
  try {
    const proc = Bun.spawn([KAYA_CLI, "sheets", "read", GOAL_ACHIEVEMENT_SHEET_ID, GOAL_ACHIEVEMENT_RANGE, "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) return { metrics, live: false };

    const rows = JSON.parse(stdout.trim()) as string[][];
    // Row 12 (index 1 since we start from A11): pairs of [metric_name, value]
    if (rows.length >= 2) {
      const valueRow = rows[1]; // Row 12
      if (valueRow) {
        // B12 = G0 (media hours), D12 = G1 (friends count), F12 = G2 (alignment score)
        if (valueRow[1]) metrics.set("G0", valueRow[1]);
        if (valueRow[3]) metrics.set("G1", valueRow[3]);
        if (valueRow[5]) metrics.set("G2", valueRow[5]);
      }
    }
    return { metrics, live: true };
  } catch {
    return { metrics, live: false };
  }
}

export async function execute(config: GoalsBlockConfig = {}): Promise<BlockResult> {
  const { showWIGs = true, showMissions = true, maxGoals = 5 } = config;

  try {
    const goals: Goal[] = [];
    const missions: Mission[] = [];

    // Parse GOALS.md
    const goalsPath = join(TELOS_DIR, "GOALS.md");
    if (existsSync(goalsPath)) {
      const content = readFileSync(goalsPath, "utf-8");

      // Find Q1 WIG section
      const wigSectionMatch = content.match(/## Q1 WIGs[^\n]*\n([\s\S]*?)(?=\n---|\n## [A-Z]|$)/);
      const wigSection = wigSectionMatch ? wigSectionMatch[1] : "";

      // Parse all goals
      const goalMatches = content.matchAll(/### (G\d+):\s*([^\n]+)\n([\s\S]*?)(?=\n###|\n---|\n## |$)/g);

      for (const match of goalMatches) {
        const id = match[1];
        const title = match[2].trim();
        const body = match[3];

        // Check if this goal is in WIG section
        const isWIG = wigSection.includes(`### ${id}:`);

        // Parse metadata from body
        const statusMatch = body.match(/\*\*Status:\*\*\s*([^\n]+)/);
        const metricMatch = body.match(/\*\*Metric:\*\*\s*([^\n]+)/);
        const currentMatch = body.match(/\*\*Current:\*\*\s*([^\n]+)/);
        const targetMatch = body.match(/\*\*Target:\*\*\s*([^\n]+)/);

        goals.push({
          id,
          title,
          status: statusMatch?.[1]?.trim(),
          metric: metricMatch?.[1]?.trim(),
          current: currentMatch?.[1]?.trim(),
          target: targetMatch?.[1]?.trim(),
          isWIG,
        });
      }
    }

    // Parse MISSIONS.md
    const missionsPath = join(TELOS_DIR, "MISSIONS.md");
    if (existsSync(missionsPath)) {
      const content = readFileSync(missionsPath, "utf-8");

      // Parse missions
      const missionMatches = content.matchAll(/### (M\d+):\s*([^\n]+)\n([\s\S]*?)(?=\n###|\n---|\n## |$)/g);

      for (const match of missionMatches) {
        const id = match[1];
        const title = match[2].trim();
        const body = match[3];

        const focusMatch = body.match(/\*\*Focus:\*\*\s*([^\n]+)/);

        missions.push({
          id,
          title,
          focus: focusMatch?.[1]?.trim(),
        });
      }
    }

    // Fetch live WIG metrics from Google Sheets to override stale TELOS values
    const { metrics: liveMetrics, live: isLive } = await fetchLiveWIGMetrics();
    for (const goal of goals) {
      const liveValue = liveMetrics.get(goal.id);
      if (liveValue) {
        goal.current = liveValue;
      }
    }

    // Filter and limit
    const wigs = goals.filter((g) => g.isWIG).slice(0, maxGoals);
    const displayMissions = missions.slice(0, 3);

    // Generate focus recommendation
    let focusRecommendation = "";
    if (wigs.length > 0) {
      const topWIG = wigs[0];
      focusRecommendation = `Focus on ${topWIG.id}: ${topWIG.title}`;
    } else if (displayMissions.length > 0) {
      focusRecommendation = `Advance ${displayMissions[0].id}: ${displayMissions[0].title}`;
    }

    // Format markdown
    let markdown = "## Goals\n\n";

    if (showWIGs && wigs.length > 0) {
      markdown += "| WIG | Status | Metric |\n";
      markdown += "|-----|--------|--------|\n";
      for (const wig of wigs) {
        const metricStr = wig.current && wig.metric
          ? `${wig.current} ${wig.metric.includes("→") ? "" : "→ "}${wig.metric.split("→").pop()?.trim() || ""}`
          : wig.metric || "-";
        // Show full goal title without truncation
        markdown += `| **${wig.id}**: ${wig.title} | ${wig.status || "In Progress"} | ${metricStr} |\n`;
      }
      markdown += "\n";
    }

    if (showMissions && displayMissions.length > 0) {
      markdown += "**Active Missions:** ";
      markdown += displayMissions.map((m) => `${m.id} (${m.title})`).join(", ");
      markdown += "\n\n";
    }

    if (focusRecommendation) {
      markdown += `**Focus:** ${focusRecommendation}\n`;
    }

    if (!isLive) {
      markdown += `\n*Data from TELOS files (Google Sheets unavailable)*\n`;
    }

    // Generate summary
    const summary = wigs.length > 0
      ? `${wigs.length} WIGs active, focus: ${wigs[0].id}`
      : `${goals.length} goals, ${missions.length} missions`;

    return {
      blockName: "goals",
      success: true,
      data: { wigs, missions: displayMissions, focusRecommendation, allGoals: goals },
      markdown,
      summary,
    };
  } catch (error) {
    return {
      blockName: "goals",
      success: false,
      data: {},
      markdown: "## Goals\n\nFailed to load goals.\n",
      summary: "Goals unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--test") || args.includes("-t")) {
    execute({ showWIGs: true, showMissions: true, maxGoals: 5 })
      .then((result) => {
        console.log("=== Goals Block Test ===\n");
        console.log("Success:", result.success);
        console.log("\nMarkdown:\n", result.markdown);
        console.log("\nSummary:", result.summary);
        console.log("\nData:", JSON.stringify(result.data, null, 2));
      })
      .catch(console.error);
  } else {
    console.log("Usage: bun GoalsBlock.ts --test");
  }
}
