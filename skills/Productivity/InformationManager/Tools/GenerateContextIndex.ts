#!/usr/bin/env bun
/**
 * GenerateContextIndex - Generates CONTEXT-INDEX.md with enhanced meta-context
 *
 * This tool GENERATES an index from existing context files. It does not "refresh"
 * (update in-place) or "sync" (pull from external). It reads what exists and
 * produces structured documentation.
 *
 * Produces structured documentation that answers:
 * 1. WHETHER - Is context loading necessary?
 * 2. WHICH - Which specific sources are relevant?
 * 3. HOW - How to combine/use them effectively?
 *
 * Features:
 * - Source status table with freshness indicators and priority
 * - Context routing rules by task type
 * - Sufficient context boundaries
 * - Freshness actions guide
 * - Quick reference card
 *
 * Usage:
 *   bun run GenerateContextIndex.ts [--dry-run] [--json]
 *
 * Options:
 *   --dry-run  Preview changes without writing
 *   --json     Output as JSON
 *   --help     Show this help
 */

import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Configuration
// ============================================================================

const HOME = process.env.HOME || "/Users/[user]";
const KAYA_DIR = path.join(HOME, ".claude");
const CONTEXT_DIR = path.join(KAYA_DIR, "context");
const CONTEXT_INDEX_PATH = path.join(KAYA_DIR, "skills", "ContextManager", "CONTEXT-INDEX.md");
const SCRIPT_DIR = path.dirname(import.meta.path);
const CONFIG_DIR = path.join(SCRIPT_DIR, "..", "config");

// Freshness thresholds (in hours)
const FRESH_THRESHOLD_HOURS = 24;
const STALE_THRESHOLD_HOURS = 72;

// ============================================================================
// Types
// ============================================================================

interface ContextFileInfo {
  source: string;
  filename: string;
  filepath: string;
  lastUpdated: Date | null;
  entriesCount: number | null;
  keyMetric: string;
  freshness: "fresh" | "stale" | "outdated" | "unknown";
  exists: boolean;
  priority: "Critical" | "Important" | "Optional";
  loadWhen: string[];
  skipWhen: string[];
  refreshCommand: string;
}

interface RoutingRule {
  taskType: string;
  keywords: string[];
  critical: string[];
  optional: string[];
  skip: string[];
}

interface IndexGenerationResult {
  sources: ContextFileInfo[];
  routingRules: RoutingRule[];
  generatedAt: string;
  totalSources: number;
  freshCount: number;
  staleCount: number;
}

interface SourceConfig {
  source: string;
  title: string;
  output: string;
  metricLabel?: string;
  priority?: string;
  loadWhen?: string[];
  skipWhen?: string[];
  freshnessRule?: string;
  [key: string]: unknown;
}

// ============================================================================
// Config-Driven Source Definitions
// ============================================================================

function loadSourceConfigs(): SourceConfig[] {
  const configs: SourceConfig[] = [];
  const configFiles = ["lucidtasks", "calendar", "drive", "learnings", "obsidian", "projects", "telos"];

  for (const name of configFiles) {
    const configPath = path.join(CONFIG_DIR, `${name}.json`);
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, "utf-8");
        configs.push(JSON.parse(content));
      } catch {
        console.error(`Failed to parse config: ${configPath}`);
      }
    }
  }

  // Skills context removed — Claude Code discovers skills natively via SKILL.md frontmatter

  return configs;
}

// ============================================================================
// Routing Rules Definition
// ============================================================================

const ROUTING_RULES: RoutingRule[] = [
  {
    taskType: "Scheduling Tasks",
    keywords: ["meeting", "calendar", "schedule", "appointment", "availability", "free time", "block time"],
    critical: ["CalendarContext.md"],
    optional: ["LucidTasksContext.md"],
    skip: ["ProjectsContext.md", "LearningsContext.md", "ObsidianContext.md"],
  },
  {
    taskType: "Task/Project Work",
    keywords: ["task", "lucidtasks", "todo", "project", "deadline", "work on", "what's due"],
    critical: ["LucidTasksContext.md"],
    optional: ["CalendarContext.md", "ProjectsContext.md"],
    skip: ["ObsidianContext.md", "LearningsContext.md"],
  },
  {
    taskType: "Goal Tracking & Progress",
    keywords: ["goals", "progress", "how am I doing", "alignment", "tracking", "metrics", "WIG", "lead measures"],
    critical: ["TelosContext.md", "TELOS files"],
    optional: ["ObsidianContext.md"],
    skip: ["ProjectsContext.md"],
  },
  {
    taskType: "Personal Knowledge Lookup",
    keywords: ["notes", "obsidian", "remember when", "what do I know about", "my notes on"],
    critical: ["ObsidianContext.md"],
    optional: ["LearningsContext.md"],
    skip: ["CalendarContext.md", "LucidTasksContext.md"],
  },
  {
    taskType: "Development Work",
    keywords: ["code", "project", "repo", "build", "deploy", "develop", "implement"],
    critical: ["ProjectsContext.md"],
    optional: ["LearningsContext.md"],
    skip: ["CalendarContext.md", "ObsidianContext.md"],
  },
  {
    taskType: "AI/Kaya Patterns",
    keywords: ["pattern", "learning", "what worked", "what failed", "improve", "iterate"],
    critical: ["LearningsContext.md"],
    optional: [],
    skip: ["CalendarContext.md", "LucidTasksContext.md", "ObsidianContext.md"],
  },
  {
    taskType: "System Understanding",
    keywords: ["how does Kaya", "skill", "workflow", "hook", "system works"],
    critical: ["Native Skill tool (auto-discovered)"],
    optional: ["LearningsContext.md"],
    skip: ["All personal context"],
  },
];

// ============================================================================
// Helper Functions
// ============================================================================

function parseFrontmatter(content: string): Record<string, string> {
  const frontmatter: Record<string, string> = {};
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (match) {
    const lines = match[1].split("\n");
    for (const line of lines) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        frontmatter[key] = value;
      }
    }
  }
  return frontmatter;
}

function calculateFreshness(lastUpdated: Date | null): "fresh" | "stale" | "outdated" | "unknown" {
  if (!lastUpdated) return "unknown";

  const hoursAgo = (Date.now() - lastUpdated.getTime()) / (1000 * 60 * 60);

  if (hoursAgo <= FRESH_THRESHOLD_HOURS) return "fresh";
  if (hoursAgo <= STALE_THRESHOLD_HOURS) return "stale";
  return "outdated";
}

function freshnessEmoji(freshness: string): string {
  switch (freshness) {
    case "fresh":
      return "🟢";
    case "stale":
      return "🟡";
    case "outdated":
      return "🔴";
    default:
      return "⚪";
  }
}

function formatTimestamp(date: Date | null): string {
  if (!date) return "Never";
  return date.toISOString().split("T")[0];
}

function extractMetric(content: string, metricLabel: string): string {
  const match = content.match(/entries_count:\s*(\d+)/);
  if (match) {
    return `${match[1]} ${metricLabel}`;
  }

  // Special case for Total Notes in Obsidian
  const notesMatch = content.match(/Total Notes:\s*(\d+)/);
  if (notesMatch) {
    return `${notesMatch[1]} notes`;
  }

  return "Unknown";
}

function getOutputFilename(config: SourceConfig): string {
  const output = config.output;
  if (output.includes("/")) {
    return output.split("/").pop() || output;
  }
  return output;
}

// ============================================================================
// Main Functions
// ============================================================================

function analyzeContextFile(config: SourceConfig): ContextFileInfo {
  const filename = getOutputFilename(config);
  const filepath = path.join(CONTEXT_DIR, filename);
  const exists = fs.existsSync(filepath);

  // Capitalize source name for display
  const displayName = config.source.charAt(0).toUpperCase() + config.source.slice(1);

  if (!exists) {
    return {
      source: displayName,
      filename,
      filepath,
      lastUpdated: null,
      entriesCount: null,
      keyMetric: "Not gathered",
      freshness: "unknown",
      exists: false,
      priority: (config.priority as "Critical" | "Important" | "Optional") || "Optional",
      loadWhen: config.loadWhen || [],
      skipWhen: config.skipWhen || [],
      refreshCommand: `refresh ${config.source}`,
    };
  }

  const content = fs.readFileSync(filepath, "utf-8");
  const frontmatter = parseFrontmatter(content);

  let lastUpdated: Date | null = null;
  if (frontmatter.last_updated && frontmatter.last_updated !== "null") {
    const parsed = new Date(frontmatter.last_updated);
    if (!isNaN(parsed.getTime())) {
      lastUpdated = parsed;
    }
  }

  // Fall back to file mtime if no valid date in frontmatter
  if (!lastUpdated) {
    const stats = fs.statSync(filepath);
    lastUpdated = stats.mtime;
  }

  const entriesCount = frontmatter.entries_count ? parseInt(frontmatter.entries_count) : null;
  const keyMetric = extractMetric(content, config.metricLabel || "entries");
  const freshness = calculateFreshness(lastUpdated);

  return {
    source: displayName,
    filename,
    filepath,
    lastUpdated,
    entriesCount,
    keyMetric,
    freshness,
    exists: true,
    priority: (config.priority as "Critical" | "Important" | "Optional") || "Optional",
    loadWhen: config.loadWhen || [],
    skipWhen: config.skipWhen || [],
    refreshCommand: `refresh ${config.source}`,
  };
}

function generateContextIndex(sources: ContextFileInfo[]): string {
  const timestamp = new Date().toISOString();

  let content = `# Kaya Context Index

**Auto-loaded at session start.** Meta-documentation for context loading decisions.

This index answers three questions:
1. **WHETHER** - Is context loading necessary for this task?
2. **WHICH** - Which specific sources are relevant?
3. **HOW** - How to combine/use them effectively?

---

## Quick Reference Card

| Task | Critical Context | Optional | Refresh If Missing |
|------|------------------|----------|-------------------|
| Scheduling | Calendar | LucidTasks | \`refresh calendar\` |
| Task work | LucidTasks | Calendar | \`refresh lucidtasks\` |
| Goals/Progress | TELOS | Obsidian | \`refresh telos\` |
| Personal knowledge | Obsidian | Learnings | \`refresh obsidian\` |
| Development | Projects | Skills | \`refresh projects\` |
| AI patterns | Learnings | Skills | \`refresh learnings\` |
| System info | Skills | — | \`refresh skills\` |
| File storage | Drive | — | \`refresh drive\` |

---

## Source Status (Dynamic)

Last refreshed: ${timestamp.split("T")[0]}

| Source | Context File | Last Updated | Status | Priority | Key Metric |
|--------|--------------|--------------|--------|----------|------------|
`;

  for (const source of sources) {
    const status = freshnessEmoji(source.freshness);
    const date = formatTimestamp(source.lastUpdated);
    const file = source.exists ? `\`context/${source.filename}\`` : "Not gathered";
    content += `| ${source.source} | ${file} | ${date} | ${status} | ${source.priority} | ${source.keyMetric} |\n`;
  }

  content += `
**Legend:** 🟢 Fresh (<24h) | 🟡 Stale (24-72h) | 🔴 Outdated (>72h) | ⚪ Not gathered

---

## Context Routing Rules

`;

  for (const rule of ROUTING_RULES) {
    content += `### ${rule.taskType}
**Keywords**: ${rule.keywords.join(", ")}
**Critical**: ${rule.critical.join(", ")}
**Optional**: ${rule.optional.join(", ")}
**Skip**: ${rule.skip.join(", ")}

`;
  }

  content += `---

## Sufficient Context Boundaries

### Minimum Required (Cannot Proceed Without)
| Task Type | Must Have | Why |
|-----------|-----------|-----|
| Scheduling | Calendar | Need availability data |
| Task work | LucidTasks | Need task list |
| Goal tracking | TELOS | Need goals, metrics, and definitions |
| Knowledge lookup | Obsidian | Need note content |

### Improves Quality (Helpful but Optional)
| Task Type | Nice to Have | Benefit |
|-----------|--------------|---------|
| Scheduling | LucidTasks | See task deadlines to avoid conflicts |
| Task work | Calendar | See time available for tasks |
| Goal tracking | Obsidian | Personal notes add context |
| Development | Learnings | Past patterns prevent mistakes |

### Stop Loading When
- **Simple questions**: Don't load context for "what time is it" or "tell me a joke"
- **System-only tasks**: Skip personal context for Kaya maintenance
- **Single-source tasks**: If task clearly maps to one source, don't load others
- **Already have answer**: If TELOS (loaded at start) answers the question, stop

---

## Freshness Actions

| Status | Meaning | Action |
|--------|---------|--------|
| 🟢 Fresh | Updated <24h ago | Use directly, high confidence |
| 🟡 Stale | Updated 24-72h ago | Use but note uncertainty in response |
| 🔴 Outdated | Updated >72h ago | Refresh before high-stakes work; warn user for time-sensitive tasks |
| ⚪ Not gathered | Never collected | Run gather command before proceeding |

### When to Refresh Before Proceeding

**Always refresh** for:
- Financial decisions
- Scheduling commitments
- Goal/progress reports to user
- Any task where user says "make sure it's current"

**Okay to use stale** for:
- General knowledge questions
- System understanding
- Historical lookups ("what did I work on last month")

### Refresh Commands

\`\`\`bash
# Individual sources
refresh lucidtasks
refresh calendar
refresh telos
refresh obsidian
refresh projects
refresh learnings
refresh skills
refresh drive

# All sources at once
gather all context
bun Tools/GatheringOrchestrator.ts --mode consolidate
\`\`\`

---

## Source Registry (Detailed)

`;

  const purposeMap: Record<string, string> = {
    LucidTasks: "Task management, deadlines, project tracking",
    Calendar: "Schedule, availability, meetings, time blocks",
    Drive: "File storage structure, shared documents, cloud files",
    Learnings: "AI patterns, what worked/failed, system improvements, captured insights",
    Obsidian: "Personal knowledge base, notes, thoughts, research",
    Projects: "Active development projects, repos, tech stacks",
    Skills: "Available Kaya skills, capabilities, workflows",
    Telos: "Life goals, missions, challenges, strategies, status, habit metrics, alignment scores, lead measures",
  };

  const freshnessRuleMap: Record<string, string> = {
    LucidTasks: "Update daily; stale after 24h for active work",
    Calendar: "Update daily; stale after 24h for scheduling",
    Drive: "Update weekly; tolerant of staleness",
    Learnings: "Update weekly; tolerant of staleness",
    Obsidian: "Update weekly; tolerant of staleness",
    Projects: "Update weekly; stale after changes",
    Skills: "Update monthly; stable",
    Telos: "User-maintained; update when goals change; tracking metrics weekly",
  };

  for (const source of sources) {
    content += `### ${source.source}
- **Purpose**: ${purposeMap[source.source] || "Context data"}
- **Load When**: ${source.loadWhen.join(", ")}
- **Skip When**: ${source.skipWhen.join(", ")}
- **Freshness**: ${freshnessRuleMap[source.source] || "Update as needed"}
- **Prerequisites**: None
- **Priority**: ${source.priority}${source.source === "Telos" ? " (auto-loaded)" : ""}
- **Access**: \`context/${source.filename}\` or \`${source.refreshCommand}\`

`;
  }

  content += `---

## Your Life Context (TELOS)

Core files loaded at session start. For full details, read these files directly.

| Topic | File | Loaded |
|-------|------|--------|
| Missions | \`USER/TELOS/MISSIONS.md\` | Yes |
| Goals | \`USER/TELOS/GOALS.md\` | Yes |
| Challenges | \`USER/TELOS/CHALLENGES.md\` | Yes |
| Status | \`USER/TELOS/STATUS.md\` | Yes |
| Strategies | \`USER/TELOS/STRATEGIES.md\` | Yes |

### Additional TELOS Files (Load On-Demand)

| Topic | File |
|-------|------|
| Beliefs | \`USER/TELOS/BELIEFS.md\` |
| Narratives | \`USER/TELOS/NARRATIVES.md\` |
| Mental Models | \`USER/TELOS/MODELS.md\` |
| Mental Frames | \`USER/TELOS/FRAMES.md\` |
| Projects | \`USER/TELOS/PROJECTS.md\` |
| Problems | \`USER/TELOS/PROBLEMS.md\` |
| Books | \`USER/TELOS/BOOKS.md\` |
| Movies | \`USER/TELOS/MOVIES.md\` |
| Ideas | \`USER/TELOS/IDEAS.md\` |
| Predictions | \`USER/TELOS/PREDICTIONS.md\` |

---

## System Documentation

| Topic | File |
|-------|------|
| Architecture | \`SYSTEM/KAYASYSTEMARCHITECTURE.md\` |
| Skills Guide | \`SYSTEM/SKILLSYSTEM.md\` |
| Hooks | \`SYSTEM/THEHOOKSYSTEM.md\` |
| Memory | \`SYSTEM/MEMORYSYSTEM.md\` |
| Notifications | \`SYSTEM/THENOTIFICATIONSYSTEM.md\` |
| Agents | \`SYSTEM/PAIAGENTSYSTEM.md\` |
| Security | \`SYSTEM/KAYASECURITYSYSTEM/\` |
| Documentation Index | \`SYSTEM/DOCUMENTATIONINDEX.md\` |

---

## Personal Configuration

| Topic | File |
|-------|------|
| Identity | \`settings.json\`, \`USER/DAIDENTITY.md\` |
| Assets | \`USER/ASSETMANAGEMENT.md\` |
| Tech Stack | \`USER/TECHSTACKPREFERENCES.md\` |
| Contacts | \`USER/CONTACTS.md\` |
| Definitions | \`USER/DEFINITIONS.md\` |

---

## Core Tools

| Tool | Location | Purpose |
|------|----------|---------|
| StateManager | \`Tools/StateManager.ts\` | Type-safe state persistence |
| NotificationService | \`Tools/NotificationService.ts\` | Multi-channel notifications |
| ConfigLoader | \`Tools/ConfigLoader.ts\` | SYSTEM/USER tiered config |
| MemoryStore | \`Tools/MemoryStore.ts\` | Learning/research storage |
| Inference | \`Tools/Inference.ts\` | AI model inference (fast/standard/smart) |

**Full tools documentation:** \`lib/core/README.md\`

---

## Quick Lookups

| Need | Action |
|------|--------|
| All skills | Use the native Skill tool (Claude Code discovers SKILL.md files automatically) |
| All CLIs | Read \`CLI-INDEX.md\` |
| Past work | \`MEMORY/WORK/\` directories |
| Learnings | \`MEMORY/LEARNING/\` |
| Session history | \`MEMORY/sessions/\` |

---

*Paths relative to \`$KAYA_HOME/\` unless otherwise noted.*
*Source status auto-generated by GenerateContextIndex.ts*
`;

  return content;
}

export async function generateContextIndexFile(dryRun = false): Promise<IndexGenerationResult> {
  // Load configs and analyze files
  const configs = loadSourceConfigs();
  const sources = configs.map(analyzeContextFile);

  const result: IndexGenerationResult = {
    sources,
    routingRules: ROUTING_RULES,
    generatedAt: new Date().toISOString(),
    totalSources: sources.length,
    freshCount: sources.filter((s) => s.freshness === "fresh").length,
    staleCount: sources.filter((s) => s.freshness === "stale").length,
  };

  if (!dryRun) {
    const indexContent = generateContextIndex(sources);
    fs.writeFileSync(CONTEXT_INDEX_PATH, indexContent);
  }

  return result;
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`
GenerateContextIndex - Generates CONTEXT-INDEX.md with enhanced meta-context

Usage:
  bun run GenerateContextIndex.ts [--dry-run] [--json]

Options:
  --dry-run  Preview changes without writing
  --json     Output as JSON
  --help     Show this help

Output:
  Updates skills/ContextManager/CONTEXT-INDEX.md with:
  - Quick reference card for common tasks
  - Source status table with freshness and priority
  - Context routing rules by task type
  - Sufficient context boundaries
  - Freshness actions guide
  - Detailed source registry
`);
    process.exit(0);
  }

  const result = await generateContextIndexFile(values["dry-run"]);

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`=== Context Index Generation ===`);
    console.log(`Total sources: ${result.totalSources}`);
    console.log(`Fresh: ${result.freshCount}`);
    console.log(`Stale: ${result.staleCount}`);
    console.log(`Outdated: ${result.totalSources - result.freshCount - result.staleCount}`);
    console.log(`Routing rules: ${result.routingRules.length}`);
    console.log("");

    for (const source of result.sources) {
      const emoji = freshnessEmoji(source.freshness);
      const date = formatTimestamp(source.lastUpdated);
      console.log(`${emoji} ${source.source} [${source.priority}]: ${source.keyMetric} (${date})`);
    }

    if (!values["dry-run"]) {
      console.log(`\nWrote to: ${CONTEXT_INDEX_PATH}`);
    } else {
      console.log(`\n[DRY RUN] Would write to: ${CONTEXT_INDEX_PATH}`);
    }
  }
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}
