#!/usr/bin/env bun
/**
 * StrategiesBlock.ts - Lead measure performance for daily briefing
 *
 * Reads directly from TELOS STRATEGIES.md to extract:
 * - All active strategies (S0-S8) with performance data
 * - Gap analysis and status indicators
 * - Worst-performing strategies for focus
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { BlockResult } from "./types.ts";

const KAYA_HOME = process.env.KAYA_DIR || join(process.env.HOME!, ".claude");
const KAYA_CLI = join(KAYA_HOME, "bin", "kaya-cli");
const TELOS_DIR = join(KAYA_HOME, "skills", "CORE", "USER", "TELOS");

// Goal achievement sheet for live lead measure percentages
const GOAL_ACHIEVEMENT_SHEET_ID = "1iiX2qfRn6Gx1q1yLu5Xu8nV-x7S_KA45gykjgQKTJdw";
const GOAL_ACHIEVEMENT_RANGE = "A3:G8";

// Map sheet lead IDs to TELOS strategy IDs
const LEAD_TO_STRATEGY: Record<string, string> = {
  "lead1": "S0", // Boredom Blocks
  "lead2": "S1", // Pomodoro
  "lead3": "S2", // STORER
  "lead4": "S3", // Lock phone (mapped to Community Events as closest)
  "lead5": "S4", // Friendship investment → Social Invitations
  "lead 6": "S5", // Alignment hour (note the space in the sheet)
};

export type { BlockResult };

interface Strategy {
  id: string;
  name: string;
  supports: string;
  target: string;
  current: string;
  gap: number;
  status: string;
  linkedChallenges: string;
}

export interface StrategiesBlockConfig {
  maxStrategies?: number;
  showGapAnalysis?: boolean;
}

function parsePercentage(value: string): number {
  const match = value.match(/([\d.]+)%/);
  if (match) return parseFloat(match[1]!);
  // Only fall back to bare numbers if no % found — avoids misreading
  // descriptive targets like "2+ invitations per week" as 2%
  const numMatch = value.match(/^([\d.]+)$/);
  if (numMatch) return parseFloat(numMatch[1]!);
  return NaN;
}

interface SummaryRow {
  id: string;
  target: number;
  current: number;
  gap: number;
  status: string;
}

/**
 * Parse the performance summary table as source of truth for percentages.
 * Format: | S0 (Boredom Blocks) | 100% | 64.3% | -35.7% | Needs improvement |
 */
function parseSummaryTable(content: string): Map<string, SummaryRow> {
  const rows = new Map<string, SummaryRow>();
  const tableMatch = content.match(/## Strategy Performance Summary[\s\S]*?\|[-|]+\|([\s\S]*?)(?=\n---|\n## |$)/);
  if (!tableMatch) return rows;

  const lines = tableMatch[1]!.split("\n").filter((l) => l.trim().startsWith("|"));
  for (const line of lines) {
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 5) continue;

    const idMatch = cells[0]!.match(/(S\d+)/);
    if (!idMatch) continue;

    const targetPct = parsePercentage(cells[1]!);
    const currentPct = parsePercentage(cells[2]!);
    const gapMatch = cells[3]!.match(/-?([\d.]+)%/);
    const gapVal = gapMatch ? parseFloat(cells[3]!) : currentPct - targetPct;

    rows.set(idMatch[1]!, {
      id: idMatch[1]!,
      target: isNaN(targetPct) ? 0 : targetPct,
      current: isNaN(currentPct) ? 0 : currentPct,
      gap: Math.round(gapVal * 10) / 10,
      status: cells[4] || "",
    });
  }
  return rows;
}

/**
 * Fetch live lead measure percentages from Google Sheets.
 * Rows 3-8 layout: col A = lead ID, col B = description, col G = % Success
 * Returns map of TELOS strategy ID to current percentage.
 */
async function fetchLiveLeadMeasures(): Promise<{ measures: Map<string, number>; live: boolean }> {
  const measures = new Map<string, number>();
  try {
    const proc = Bun.spawn([KAYA_CLI, "sheets", "read", GOAL_ACHIEVEMENT_SHEET_ID, GOAL_ACHIEVEMENT_RANGE, "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) return { measures, live: false };

    const rows = JSON.parse(stdout.trim()) as string[][];
    for (const row of rows) {
      const leadId = (row[0] || "").trim().toLowerCase();
      const pctStr = row[6] || ""; // Column G (index 6)
      const strategyId = LEAD_TO_STRATEGY[leadId];
      if (strategyId && pctStr) {
        const pct = parsePercentage(pctStr);
        if (!isNaN(pct)) {
          measures.set(strategyId, pct);
        }
      }
    }
    return { measures, live: true };
  } catch {
    return { measures, live: false };
  }
}

function determineStatus(gap: number): string {
  if (gap <= -70) return "Critical";
  if (gap <= -40) return "Struggling";
  if (gap <= -20) return "Needs improvement";
  if (gap < 0) return "Moderate";
  return "On track";
}

export async function execute(config: StrategiesBlockConfig = {}): Promise<BlockResult> {
  const { maxStrategies = 20, showGapAnalysis = true } = config;

  try {
    const strategies: Strategy[] = [];

    const strategiesPath = join(TELOS_DIR, "STRATEGIES.md");
    if (!existsSync(strategiesPath)) {
      return {
        blockName: "strategies",
        success: false,
        data: {},
        markdown: "## Strategies\n\nSTRATEGIES.md not found.\n",
        summary: "Strategies unavailable",
        error: "STRATEGIES.md not found",
      };
    }

    const content = readFileSync(strategiesPath, "utf-8");

    // Parse the performance summary table first — it has reliable percentage data
    const summaryRows = parseSummaryTable(content);

    // Parse strategy sections: ### S\d+: Name
    const strategyMatches = content.matchAll(
      /### (S\d+):\s*([^\n]+)\n([\s\S]*?)(?=\n###|\n---|\n## |$)/g
    );

    for (const match of strategyMatches) {
      const id = match[1]!;
      const name = match[2]!.trim();
      const body = match[3]!;

      const supportsMatch = body.match(/\*\*Supports:\*\*\s*([^\n]+)/);
      const targetMatch = body.match(/\*\*Target:\*\*\s*([^\n]+)/);
      const currentMatch = body.match(/\*\*Current:\*\*\s*([^\n]+)/);
      const challengesMatch = body.match(/\*\*Linked Challenges:\*\*\s*([^\n]+)/);

      const targetStr = targetMatch?.[1]?.trim() || "100%";
      const currentStr = currentMatch?.[1]?.trim() || "0%";

      // Prefer summary table percentages (reliable) over parsing descriptive targets
      const summary = summaryRows.get(id);
      const gap = summary ? summary.gap : (() => {
        const t = parsePercentage(targetStr);
        const c = parsePercentage(currentStr);
        return (isNaN(t) || isNaN(c)) ? 0 : Math.round((c - t) * 10) / 10;
      })();

      strategies.push({
        id,
        name,
        supports: supportsMatch?.[1]?.trim() || "",
        target: summary ? `${summary.target}%` : targetStr,
        current: summary ? `${summary.current}%` : currentStr,
        gap,
        status: summary ? summary.status : determineStatus(gap),
        linkedChallenges: challengesMatch?.[1]?.trim() || "",
      });
    }

    // Overlay live data from Google Sheets
    const { measures: liveMeasures, live: isLive } = await fetchLiveLeadMeasures();
    for (const strategy of strategies) {
      const livePct = liveMeasures.get(strategy.id);
      if (livePct !== undefined) {
        const targetPct = parsePercentage(strategy.target);
        const target = isNaN(targetPct) ? 100 : targetPct;
        strategy.current = `${livePct}%`;
        strategy.gap = Math.round((livePct - target) * 10) / 10;
        strategy.status = determineStatus(strategy.gap);
      }
    }

    // Sort by gap (worst first)
    const sorted = [...strategies].sort((a, b) => a.gap - b.gap);
    const displayed = sorted.slice(0, maxStrategies);

    // Format markdown
    let markdown = "## Strategies\n\n";
    markdown += "| Strategy | Target | Current | Gap | Status |\n";
    markdown += "|----------|--------|---------|-----|--------|\n";

    for (const s of displayed) {
      const gapStr = s.gap >= 0 ? `+${s.gap}%` : `${s.gap}%`;
      markdown += `| **${s.id}**: ${s.name} | ${s.target} | ${s.current} | ${gapStr} | ${s.status} |\n`;
    }
    markdown += "\n";

    if (showGapAnalysis && sorted.length > 0) {
      const critical = sorted.filter((s) => s.status === "Critical");
      const struggling = sorted.filter((s) => s.status === "Struggling");

      if (critical.length > 0) {
        markdown += `**Critical:** ${critical.map((s) => `${s.id} (${s.name})`).join(", ")}\n`;
      }
      if (struggling.length > 0) {
        markdown += `**Struggling:** ${struggling.map((s) => `${s.id} (${s.name})`).join(", ")}\n`;
      }

      const worst = sorted[0]!;
      markdown += `\n**Biggest gap:** ${worst.id} (${worst.name}) at ${worst.gap}%\n`;
    }

    if (!isLive) {
      markdown += `\n*Data from TELOS files (Google Sheets unavailable)*\n`;
    }

    // Summary
    const critical = sorted.filter((s) => s.status === "Critical").length;
    const summary =
      critical > 0
        ? `${strategies.length} strategies, ${critical} critical`
        : `${strategies.length} strategies tracked`;

    return {
      blockName: "strategies",
      success: true,
      data: {
        strategies: displayed,
        totalStrategies: strategies.length,
        criticalCount: sorted.filter((s) => s.status === "Critical").length,
        worstStrategy: sorted[0] || null,
        top3Worst: sorted.slice(0, 3),
      },
      markdown,
      summary,
    };
  } catch (error) {
    return {
      blockName: "strategies",
      success: false,
      data: {},
      markdown: "## Strategies\n\nFailed to load strategies.\n",
      summary: "Strategies unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--test") || args.includes("-t")) {
    execute({ showGapAnalysis: true })
      .then((result) => {
        console.log("=== Strategies Block Test ===\n");
        console.log("Success:", result.success);
        console.log("\nMarkdown:\n", result.markdown);
        console.log("\nSummary:", result.summary);
        console.log("\nData:", JSON.stringify(result.data, null, 2));
      })
      .catch(console.error);
  } else {
    console.log("Usage: bun StrategiesBlock.ts --test");
  }
}
