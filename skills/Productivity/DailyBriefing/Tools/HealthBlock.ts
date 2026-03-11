#!/usr/bin/env bun
/**
 * HealthBlock.ts - Health data for daily briefing
 *
 * Reads from the health Google Sheet via kaya-cli to extract:
 * - Daily health metrics and logs
 * - Raw spreadsheet rows for display
 */

import { join } from "path";
import type { BlockResult } from "./types.ts";

const KAYA_HOME = process.env.KAYA_DIR || join(process.env.HOME!, ".claude");
const KAYA_CLI = join(KAYA_HOME, "bin", "kaya-cli");

export type { BlockResult };

// InformationManager health sheet configuration
const HEALTH_SHEET_ID = "1cY_1c5pJxyPBiQNlXeYGo9CFAJ8Khl91qQXhyP6ztBc";
const HEALTH_RANGE = "A1:Z50";

export interface HealthBlockConfig {
  settings?: Record<string, unknown>;
}

/**
 * Read sheet data via kaya-cli sheets read using Bun.spawn.
 * Returns parsed rows as string[][].
 */
async function readSheet(sheetId: string, range: string): Promise<string[][]> {
  const proc = Bun.spawn([KAYA_CLI, "sheets", "read", sheetId, range, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`kaya-cli sheets read failed: ${stderr.trim() || `exit code ${exitCode}`}`);
  }

  const trimmed = stdout.trim();
  if (!trimmed) return [];

  // Try JSON parse first (kaya-cli may return JSON array)
  if (trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as string[][];
    } catch {
      // Fall through to TSV parsing
    }
  }

  // Parse as TSV/CSV
  return trimmed.split("\n").map((line) => line.split("\t"));
}

export async function execute(config: HealthBlockConfig = {}): Promise<BlockResult> {
  try {
    const rows = await readSheet(HEALTH_SHEET_ID, HEALTH_RANGE);

    if (rows.length === 0) {
      return {
        blockName: "health",
        success: true,
        data: { rows: [], message: "No health data found" },
        markdown: "## Health\n\nNo health data available.\n",
        summary: "No health data",
      };
    }

    // Use first row as headers
    const headers = rows[0] ?? [];
    const dataRows = rows.slice(1).filter((r) => r.some((cell) => cell.trim() !== ""));

    // Format markdown table from headers + rows
    let markdown = "## Health\n\n";

    if (headers.length > 0) {
      const visibleHeaders = headers.filter((h) => h.trim() !== "");
      const colCount = visibleHeaders.length;

      if (colCount > 0) {
        markdown += `| ${visibleHeaders.join(" | ")} |\n`;
        markdown += `|${" --- |".repeat(colCount)}\n`;

        for (const row of dataRows.slice(0, 10)) {
          const cells = row.slice(0, colCount).map((c) => c.trim() || "—");
          markdown += `| ${cells.join(" | ")} |\n`;
        }
        markdown += "\n";
      }
    }

    if (dataRows.length === 0) {
      markdown += "_No health entries recorded._\n";
    }

    const summary = `${dataRows.length} health record${dataRows.length !== 1 ? "s" : ""} loaded`;

    return {
      blockName: "health",
      success: true,
      data: {
        rows: dataRows,
        headers,
        rowCount: dataRows.length,
      },
      markdown,
      summary,
    };
  } catch (error) {
    return {
      blockName: "health",
      success: false,
      data: {},
      markdown: "## Health\n\nFailed to load health data.\n",
      summary: "Health data unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--test") || args.includes("-t")) {
    execute({})
      .then((result) => {
        console.log("=== Health Block Test ===\n");
        console.log("Success:", result.success);
        console.log("\nMarkdown:\n", result.markdown);
        console.log("\nSummary:", result.summary);
        if (result.error) console.log("\nError:", result.error);
        console.log("\nData:", JSON.stringify(result.data, null, 2));
      })
      .catch(console.error);
  } else {
    console.log("Usage: bun HealthBlock.ts --test");
  }
}
