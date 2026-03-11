#!/usr/bin/env bun
/**
 * SessionHistorySynthesis - Extract patterns from session history
 *
 * Must run BEFORE any cleanup of history.jsonl.
 *
 * Patterns extracted:
 * - Common command sequences
 * - Skill usage frequency
 * - Time-of-day patterns
 * - Session duration trends
 * - Project distribution
 *
 * Output: MEMORY/LEARNING/SYNTHESIS/sessions/YYYY-MM-DD-patterns.md
 *
 * Usage:
 *   bun run SessionHistorySynthesis.ts [--json] [--dry-run]
 */

import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";
import { prepareOutputPath } from "./OutputPathResolver";

// ============================================================================
// Configuration
// ============================================================================

const CLAUDE_DIR = path.join(process.env.HOME!, ".claude");
const HISTORY_FILE = path.join(CLAUDE_DIR, "history.jsonl");
const SYNTHESIS_DIR = path.join(CLAUDE_DIR, "MEMORY", "LEARNING", "SYNTHESIS", "sessions");

// ============================================================================
// Types
// ============================================================================

interface HistoryEntry {
  display: string;
  pastedContents: Record<string, unknown>;
  timestamp: number;
  project: string;
  sessionId: string;
}

interface HourlyDistribution {
  [hour: number]: number;
}

interface SynthesisResult {
  period: string;
  totalPrompts: number;
  uniqueSessions: number;
  avgPromptsPerSession: number;
  peakHours: number[];
  projectDistribution: { project: string; count: number }[];
  commonCommands: { command: string; count: number }[];
  skillTriggers: { skill: string; count: number }[];
  queryPatterns: { pattern: string; count: number }[];
  recommendations: string[];
}

// ============================================================================
// Analysis Functions
// ============================================================================

function extractSkillTrigger(prompt: string): string | null {
  // Check for slash commands
  const slashMatch = prompt.match(/^\/(\w+)/);
  if (slashMatch) return slashMatch[1];

  // Check for skill keywords
  const skillKeywords: Record<string, RegExp> = {
    obsidian: /obsidian|vault|notes?/i,
    browser: /browser|screenshot|webpage/i,
    shopping: /shop|buy|purchase|cart/i,
    calendar: /calendar|schedule|event/i,
    lucidtasks: /lucidtasks|task|todo/i,
    cooking: /cook|recipe|meal/i,
    commit: /commit|push|git/i,
  };

  for (const [skill, pattern] of Object.entries(skillKeywords)) {
    if (pattern.test(prompt)) return skill;
  }

  return null;
}

function categorizePrompt(prompt: string): string {
  const lower = prompt.toLowerCase();

  if (lower.startsWith("/")) return "Slash Command";
  if (lower.match(/^(who|what|where|when|why|how|can|does|is|are)\b/i)) return "Question";
  if (lower.match(/^(create|make|build|add|implement|write)/i)) return "Creation";
  if (lower.match(/^(fix|update|change|modify|edit)/i)) return "Modification";
  if (lower.match(/^(delete|remove|clean|clear)/i)) return "Deletion";
  if (lower.match(/^(show|list|get|find|search)/i)) return "Query";
  if (lower.match(/^(yes|no|ok|continue|proceed|done)/i)) return "Confirmation";
  if (lower.length < 20) return "Short Response";

  return "General Request";
}

function analyzeHistory(entries: HistoryEntry[]): SynthesisResult {
  if (entries.length === 0) {
    return {
      period: new Date().toISOString().slice(0, 7),
      totalPrompts: 0,
      uniqueSessions: 0,
      avgPromptsPerSession: 0,
      peakHours: [],
      projectDistribution: [],
      commonCommands: [],
      skillTriggers: [],
      queryPatterns: [],
      recommendations: ["No history entries to analyze"],
    };
  }

  // Session analysis
  const sessions = new Set(entries.map(e => e.sessionId));
  const uniqueSessions = sessions.size;
  const avgPromptsPerSession = entries.length / uniqueSessions;

  // Hourly distribution
  const hourlyDist: HourlyDistribution = {};
  for (let h = 0; h < 24; h++) hourlyDist[h] = 0;

  for (const entry of entries) {
    const hour = new Date(entry.timestamp).getHours();
    hourlyDist[hour]++;
  }

  const peakHours = Object.entries(hourlyDist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([hour]) => parseInt(hour));

  // Project distribution
  const projectCounts = new Map<string, number>();
  for (const entry of entries) {
    const project = entry.project || "unknown";
    projectCounts.set(project, (projectCounts.get(project) || 0) + 1);
  }
  const projectDistribution = Array.from(projectCounts.entries())
    .map(([project, count]) => ({
      project: project.replace(process.env.HOME!, "~"),
      count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Common commands (slash commands)
  const commandCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.display.startsWith("/")) {
      const cmd = entry.display.split(/\s/)[0];
      commandCounts.set(cmd, (commandCounts.get(cmd) || 0) + 1);
    }
  }
  const commonCommands = Array.from(commandCounts.entries())
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Skill triggers
  const skillCounts = new Map<string, number>();
  for (const entry of entries) {
    const skill = extractSkillTrigger(entry.display);
    if (skill) {
      skillCounts.set(skill, (skillCounts.get(skill) || 0) + 1);
    }
  }
  const skillTriggers = Array.from(skillCounts.entries())
    .map(([skill, count]) => ({ skill, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Query patterns
  const patternCounts = new Map<string, number>();
  for (const entry of entries) {
    const pattern = categorizePrompt(entry.display);
    patternCounts.set(pattern, (patternCounts.get(pattern) || 0) + 1);
  }
  const queryPatterns = Array.from(patternCounts.entries())
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => b.count - a.count);

  // Recommendations
  const recommendations: string[] = [];

  if (avgPromptsPerSession < 5) {
    recommendations.push("Low prompts per session - consider using more follow-up questions");
  }
  if (avgPromptsPerSession > 50) {
    recommendations.push("High prompts per session - consider breaking into focused sessions");
  }
  if (skillTriggers.length === 0) {
    recommendations.push("No skill triggers detected - explore available Kaya skills");
  }
  if (queryPatterns.find(p => p.pattern === "Short Response")?.count > entries.length * 0.3) {
    recommendations.push("Many short responses - provide more context for better results");
  }

  if (recommendations.length === 0) {
    recommendations.push("Usage patterns look healthy");
  }

  return {
    period: new Date().toISOString().slice(0, 7),
    totalPrompts: entries.length,
    uniqueSessions,
    avgPromptsPerSession,
    peakHours,
    projectDistribution,
    commonCommands,
    skillTriggers,
    queryPatterns,
    recommendations,
  };
}

// ============================================================================
// Report Generation
// ============================================================================

function formatReport(result: SynthesisResult): string {
  const date = new Date().toISOString().split("T")[0];

  return `# Session History Synthesis

**Period:** ${result.period}
**Generated:** ${date}
**Total Prompts:** ${result.totalPrompts}

---

## Summary Statistics

| Metric | Value |
|--------|-------|
| Total Prompts | ${result.totalPrompts} |
| Unique Sessions | ${result.uniqueSessions} |
| Avg Prompts/Session | ${result.avgPromptsPerSession.toFixed(1)} |

## Peak Usage Hours

${result.peakHours.length > 0
    ? result.peakHours.map(h => `- ${h}:00 - ${h + 1}:00`).join("\n")
    : "*No peak hours detected*"}

## Project Distribution

${result.projectDistribution.length > 0
    ? result.projectDistribution.map(p => `- **${p.project}:** ${p.count} prompts`).join("\n")
    : "*No project data*"}

## Common Slash Commands

${result.commonCommands.length > 0
    ? result.commonCommands.map(c => `- \`${c.command}\`: ${c.count}x`).join("\n")
    : "*No slash commands used*"}

## Skill Triggers

${result.skillTriggers.length > 0
    ? result.skillTriggers.map(s => `- **${s.skill}:** ${s.count} triggers`).join("\n")
    : "*No skill triggers detected*"}

## Query Patterns

${result.queryPatterns.map(p => `- **${p.pattern}:** ${p.count} (${((p.count / result.totalPrompts) * 100).toFixed(1)}%)`).join("\n")}

## Recommendations

${result.recommendations.map((r, i) => `${i + 1}. ${r}`).join("\n")}

---

*Generated by SessionHistorySynthesis tool*
`;
}

async function writeSynthesis(result: SynthesisResult): Promise<string> {
  const { path: filepath } = await prepareOutputPath({
    skill: 'LEARNING/SYNTHESIS/sessions',
    title: 'patterns',
    extension: 'md',
    includeTimestamp: false, // Use date-based naming instead
  });

  // Use date-based filename for this synthesis
  const date = new Date().toISOString().split("T")[0];
  const actualPath = path.join(path.dirname(filepath), `${date}-patterns.md`);

  fs.writeFileSync(actualPath, formatReport(result));
  return actualPath;
}

// ============================================================================
// CLI
// ============================================================================

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    json: { type: "boolean" },
    "dry-run": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`
SessionHistorySynthesis - Extract patterns from session history

Usage:
  bun run SessionHistorySynthesis.ts           Run synthesis
  bun run SessionHistorySynthesis.ts --json    Output JSON instead of markdown
  bun run SessionHistorySynthesis.ts --dry-run Preview without writing

Output: MEMORY/LEARNING/SYNTHESIS/sessions/YYYY-MM-DD-patterns.md
`);
  process.exit(0);
}

// Check file exists
if (!fs.existsSync(HISTORY_FILE)) {
  const result = {
    success: false,
    message: "No history file found",
    entriesProcessed: 0,
  };
  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("No history file found at:", HISTORY_FILE);
  }
  process.exit(0);
}

// Read entries
const content = fs.readFileSync(HISTORY_FILE, "utf-8");
const entries: HistoryEntry[] = content
  .split("\n")
  .filter(line => line.trim())
  .map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter((e): e is HistoryEntry => e !== null);

// Analyze
const result = analyzeHistory(entries);

if (values.json) {
  const output = {
    success: true,
    entriesProcessed: entries.length,
    uniqueSessions: result.uniqueSessions,
    peakHours: result.peakHours,
    topSkills: result.skillTriggers.slice(0, 3).map(s => s.skill),
    recommendations: result.recommendations,
    outputFile: values["dry-run"] ? null : await writeSynthesis(result),
  };
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log(`Session History Synthesis`);
  console.log(`Processed ${entries.length} prompts from ${result.uniqueSessions} sessions`);
  console.log(`Avg prompts/session: ${result.avgPromptsPerSession.toFixed(1)}`);

  if (values["dry-run"]) {
    console.log("\n[DRY RUN] Would write synthesis report");
  } else {
    const filepath = await writeSynthesis(result);
    console.log(`\nWrote synthesis: ${filepath}`);
  }
}
