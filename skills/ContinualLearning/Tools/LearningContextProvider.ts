#!/usr/bin/env bun
/**
 * LearningContextProvider.ts - Formats synthesis data for ContextManager consumption
 *
 * Reads the latest synthesis report and pattern history, then formats into
 * a ~200 token markdown block that can be injected into session context.
 * This closes the feedback loop: signals -> synthesis -> context -> behavior.
 *
 * Output format:
 *   ### Learning Patterns (as of {date})
 *   **Active Trends:**
 *   - {pattern}: {count}x ({trend} arrow) -- "{example}"
 *   **Recommendations:**
 *   - {recommendation}
 *   _Last synthesis: {date} | Next: ~{date}_
 *
 * Commands:
 *   --json       Output as JSON instead of markdown
 *   --help       Show usage
 *
 * Usage:
 *   bun LearningContextProvider.ts          # Output markdown block
 *   bun LearningContextProvider.ts --json   # Output as JSON
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

// ============================================================================
// Configuration
// ============================================================================

const CLAUDE_DIR = join(process.env.HOME!, ".claude");
const SYNTHESIS_DIR = join(CLAUDE_DIR, "MEMORY", "LEARNING", "SYNTHESIS");
const STATE_FILE = join(CLAUDE_DIR, "skills", "ContinualLearning", "State", "last-synthesis.json");

/** Maximum number of patterns to include in context block */
const MAX_PATTERNS = 3;
/** Maximum number of recommendations to include */
const MAX_RECOMMENDATIONS = 2;
/** Days before synthesis is considered stale */
const STALENESS_THRESHOLD_DAYS = 7;

// ============================================================================
// Types
// ============================================================================

interface SynthesisState {
  lastRun: string;
  lastRatingsTimestamp: string;
  lastVoiceTimestamp: string;
  lastSessionsProcessed: string[];
  patternHistory: Record<string, number[]>;
}

interface ParsedPattern {
  name: string;
  category: string;
  count: number;
  example: string;
  trend: "increasing" | "decreasing" | "stable";
}

interface LearningContext {
  date: string;
  patterns: ParsedPattern[];
  recommendations: string[];
  staleDays: number;
  isStale: boolean;
  markdown: string;
}

/** Default state when file doesn't exist or is invalid */
const DEFAULT_STATE: SynthesisState = {
  lastRun: "",
  lastRatingsTimestamp: "",
  lastVoiceTimestamp: "",
  lastSessionsProcessed: [],
  patternHistory: {},
};

/**
 * Load synthesis state directly from JSON file.
 * Read-only access -- no need for full StateManager overhead.
 */
function loadSynthesisState(): SynthesisState {
  if (!existsSync(STATE_FILE)) return { ...DEFAULT_STATE };
  try {
    const content = readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(content) as Partial<SynthesisState>;
    return { ...DEFAULT_STATE, ...parsed };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

// ============================================================================
// Trend Computation (shared logic with KnowledgeSynthesizer)
// ============================================================================

function computeTrend(history: number[]): "increasing" | "decreasing" | "stable" {
  if (!history || history.length < 2) return "stable";

  const first = history[0];
  const last = history[history.length - 1];
  const slope = (last - first) / history.length;

  if (Math.abs(slope) < 0.5) return "stable";
  return slope > 0 ? "increasing" : "decreasing";
}

function trendArrow(trend: "increasing" | "decreasing" | "stable"): string {
  switch (trend) {
    case "increasing": return "^";
    case "decreasing": return "v";
    case "stable": return "->";
  }
}

// ============================================================================
// Synthesis File Discovery
// ============================================================================

/**
 * Find the most recent synthesis report file.
 * Searches MEMORY/LEARNING/SYNTHESIS/ for the newest .md file.
 */
function findLatestSynthesis(): string | null {
  if (!existsSync(SYNTHESIS_DIR)) return null;

  // List year-month subdirectories
  const subdirs = readdirSync(SYNTHESIS_DIR)
    .filter((d) => {
      const fullPath = join(SYNTHESIS_DIR, d);
      return statSync(fullPath).isDirectory() && /^\d{4}-\d{2}$/.test(d);
    })
    .sort()
    .reverse(); // Most recent first

  for (const subdir of subdirs) {
    const dirPath = join(SYNTHESIS_DIR, subdir);
    const files = readdirSync(dirPath)
      .filter((f) => f.endsWith("-synthesis.md"))
      .sort()
      .reverse(); // Most recent first

    if (files.length > 0) {
      return join(dirPath, files[0]);
    }
  }

  return null;
}

// ============================================================================
// Pattern Extraction from Synthesis Report
// ============================================================================

/**
 * Parse patterns from a synthesis markdown report.
 * Extracts pattern name, count, and first example from the report format.
 */
function extractPatternsFromReport(content: string): Array<{ name: string; category: string; count: number; example: string }> {
  const patterns: Array<{ name: string; category: string; count: number; example: string }> = [];
  let currentCategory = "";

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect category headers like "### Frustration Patterns"
    const categoryMatch = line.match(/^### (\w+) Patterns/);
    if (categoryMatch) {
      currentCategory = categoryMatch[1].toLowerCase();
      continue;
    }

    // Detect pattern lines like "- **Tool/System Failures** (8x)"
    const patternMatch = line.match(/^- \*\*(.+?)\*\* \((\d+)x\)/);
    if (patternMatch && currentCategory) {
      let example = "";
      // Look for example on next line
      if (i + 1 < lines.length) {
        const exampleMatch = lines[i + 1].match(/^\s+- Example: "(.+?)\.{3}?"?/);
        if (exampleMatch) {
          example = exampleMatch[1];
        }
      }

      patterns.push({
        name: patternMatch[1],
        category: currentCategory,
        count: parseInt(patternMatch[2], 10),
        example,
      });
    }
  }

  // Sort by count descending (frustrations first, then others)
  return patterns.sort((a, b) => {
    // Prioritize frustration patterns
    if (a.category === "frustration" && b.category !== "frustration") return -1;
    if (a.category !== "frustration" && b.category === "frustration") return 1;
    return b.count - a.count;
  });
}

/**
 * Extract recommendations from synthesis report.
 */
function extractRecommendations(content: string): string[] {
  const recommendations: string[] = [];
  const recSection = content.split("## Recommendations");

  if (recSection.length < 2) return recommendations;

  const lines = recSection[1].split("\n");
  for (const line of lines) {
    const match = line.match(/^\d+\.\s+(.+)/);
    if (match) {
      recommendations.push(match[1]);
    }
    // Stop at next section or end
    if (line.startsWith("---") || line.startsWith("## ")) break;
  }

  return recommendations;
}

// ============================================================================
// Context Generation
// ============================================================================

/**
 * Generate the learning context block for ContextManager.
 * Returns a LearningContext object with markdown and structured data.
 */
export function generateLearningContext(): LearningContext {
  const emptyContext: LearningContext = {
    date: "",
    patterns: [],
    recommendations: [],
    staleDays: 0,
    isStale: false,
    markdown: "",
  };

  // Find latest synthesis file
  const synthesisPath = findLatestSynthesis();
  if (!synthesisPath) {
    return emptyContext;
  }

  // Read synthesis report
  let reportContent: string;
  try {
    reportContent = readFileSync(synthesisPath, "utf-8");
  } catch {
    return emptyContext;
  }

  // Read state for trend data
  const state = loadSynthesisState();
  const lastRunDate = state.lastRun ? new Date(state.lastRun) : null;

  // Calculate staleness
  const now = new Date();
  const staleDays = lastRunDate
    ? Math.floor((now.getTime() - lastRunDate.getTime()) / (1000 * 60 * 60 * 24))
    : 999;
  const isStale = staleDays > STALENESS_THRESHOLD_DAYS;

  // Extract patterns from report
  const rawPatterns = extractPatternsFromReport(reportContent);
  const recommendations = extractRecommendations(reportContent);

  // Apply trend data from pattern history
  const patterns: ParsedPattern[] = rawPatterns.slice(0, MAX_PATTERNS).map((p) => {
    const historyKey = `${p.category}:${p.name}`;
    const history = state.patternHistory[historyKey] ?? [];
    return {
      name: p.name,
      category: p.category,
      count: p.count,
      example: p.example,
      trend: computeTrend(history),
    };
  });

  // Format date strings
  const lastDateStr = lastRunDate ? lastRunDate.toISOString().split("T")[0] : "unknown";
  const nextDateStr = lastRunDate
    ? new Date(lastRunDate.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]
    : "unknown";

  // Build markdown block
  let markdown = `### Learning Patterns (as of ${lastDateStr})\n\n`;

  if (isStale) {
    markdown += `**Warning:** Synthesis data is ${staleDays} days old. Patterns may not reflect current state.\n\n`;
  }

  if (patterns.length > 0) {
    markdown += "**Active Trends:**\n";
    for (const p of patterns) {
      const arrow = trendArrow(p.trend);
      const exampleStr = p.example ? ` -- "${p.example}"` : "";
      markdown += `- ${p.name}: ${p.count}x (${p.trend} ${arrow})${exampleStr}\n`;
    }
    markdown += "\n";
  }

  const topRecs = recommendations.slice(0, MAX_RECOMMENDATIONS);
  if (topRecs.length > 0) {
    markdown += "**Recommendations:**\n";
    for (const rec of topRecs) {
      markdown += `- ${rec}\n`;
    }
    markdown += "\n";
  }

  markdown += `_Last synthesis: ${lastDateStr} | Next: ~${nextDateStr}_\n`;

  return {
    date: lastDateStr,
    patterns,
    recommendations: topRecs,
    staleDays,
    isStale,
    markdown,
  };
}

// ============================================================================
// Context Source Interface (for ContextManager integration)
// ============================================================================

/**
 * Context source function compatible with ContextManager's file-based system.
 * Generates the learning context and writes it to a context file that
 * ContextManager can load as part of the development profile.
 */
export function refreshLearningContextFile(): string {
  const contextFilePath = join(CLAUDE_DIR, "context", "LearningPatternsContext.md");
  const context = generateLearningContext();

  if (context.markdown) {
    const { writeFileSync: writeFile, mkdirSync: mkDir } = require("fs");
    const contextDir = join(CLAUDE_DIR, "context");
    if (!existsSync(contextDir)) {
      mkDir(contextDir, { recursive: true });
    }
    writeFile(contextFilePath, context.markdown, "utf-8");
  }

  return contextFilePath;
}

// ============================================================================
// CLI
// ============================================================================

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
LearningContextProvider - Format synthesis data for session context

Usage:
  bun LearningContextProvider.ts          Output markdown context block
  bun LearningContextProvider.ts --json   Output as JSON
  bun LearningContextProvider.ts --refresh  Refresh context file for ContextManager
  bun LearningContextProvider.ts --help   Show this help

Output: ~200 token markdown block for ContextManager injection
`);
    process.exit(0);
  }

  if (args.includes("--refresh")) {
    const filePath = refreshLearningContextFile();
    console.log(`Context file written to: ${filePath}`);
    return;
  }

  const context = generateLearningContext();

  if (args.includes("--json")) {
    console.log(JSON.stringify(context, null, 2));
  } else {
    if (context.markdown) {
      console.log(context.markdown);
    } else {
      console.log("No synthesis data available.");
    }
  }
}

if (import.meta.main) {
  main();
}

export type { LearningContext, ParsedPattern };
