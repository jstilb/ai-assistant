#!/usr/bin/env bun
/**
 * GenerateContextRouting - Generates CONTEXT-ROUTING.md lookup table
 *
 * Scans the ~/.claude filesystem and builds a markdown table mapping topic/need
 * to file path for on-demand context loading. Zero inference — purely filesystem I/O.
 *
 * Categories (exactly 7):
 *   1. Kaya System        : skills/star/SKILL.md + architecture docs
 *   2. User Identity      : USER/star.md (non-telos, non-compressed)
 *   3. Life Goals / Telos : USER/TELOS/star.md (non-compressed)
 *   4. Projects           : context/ProjectsContext.md + USER/TELOS/PROJECTS.md
 *   5. Live Context Sources : context/star.md (excluding Projects)
 *   6. Memory System      : MEMORY/ key files
 *   7. Configuration      : settings.json + USER config files
 *
 * Usage:
 *   bun GenerateContextRouting.ts [--dry-run] [--json]
 *
 * Options:
 *   --dry-run  Print to stdout without writing to disk
 *   --json     Output as JSON (implies --dry-run for the file)
 *   --help     Show this help
 */

import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Configuration
// ============================================================================

const HOME = process.env.HOME ?? "/Users/[user]";
const KAYA_DIR = path.join(HOME, ".claude");
const OUTPUT_PATH = path.join(KAYA_DIR, "CONTEXT-ROUTING.md");
const MAX_LINES = 200;

// ============================================================================
// Types
// ============================================================================

interface RouteEntry {
  topic: string;
  filePath: string;   // relative to ~/.claude/
  lastUpdated: string; // YYYY-MM-DD or "—"
}

interface CategorySection {
  name: string;
  entries: RouteEntry[];
}

interface GenerationResult {
  categories: CategorySection[];
  totalEntries: number;
  lineCount: number;
  generatedAt: string;
}

// ============================================================================
// Helpers
// ============================================================================

/** Get mtime as YYYY-MM-DD, or "—" if stat fails */
function getMtime(absolutePath: string): string {
  try {
    const stat = fs.statSync(absolutePath);
    const d = stat.mtime;
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  } catch {
    return "—";
  }
}

/** Convert an absolute path under KAYA_DIR to a relative path */
function toRelative(absolutePath: string): string {
  return path.relative(KAYA_DIR, absolutePath);
}

/** Derive a human-readable topic name from a filename / skill name */
function topicFromFilename(filename: string): string {
  const base = path.basename(filename, ".md");
  // If all-caps filename like "ABOUTME", convert to title case words
  if (/^[A-Z0-9_]+$/.test(base)) {
    return base
      .replace(/_/g, " ")
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  // CamelCase or mixed: insert spaces before capitals
  return base
    .replace(/([A-Z])/g, " $1")
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Glob files matching a pattern (simple single-level * and **) */
function globSync(dir: string, pattern: string): string[] {
  // pattern: "*.md" or "*/SKILL.md" etc.
  const parts = pattern.split("/");
  return globRecursive(dir, parts);
}

function globRecursive(dir: string, parts: string[]): string[] {
  if (parts.length === 0) return [];
  if (!fs.existsSync(dir)) return [];

  const [head, ...rest] = parts;

  if (head === "**") {
    // Match zero or more directory levels
    const results: string[] = [];
    // Try matching rest at current level
    results.push(...globRecursive(dir, rest));
    // Also recurse into subdirectories
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          results.push(...globRecursive(path.join(dir, entry.name), parts));
        }
      }
    } catch {
      // ignore
    }
    return results;
  }

  if (rest.length === 0) {
    // head is a file pattern
    const results: string[] = [];
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && matchGlob(entry.name, head)) {
          results.push(path.join(dir, entry.name));
        }
      }
    } catch {
      // ignore
    }
    return results;
  }

  // head is a directory pattern
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && matchGlob(entry.name, head)) {
        results.push(...globRecursive(path.join(dir, entry.name), rest));
      }
    }
  } catch {
    // ignore
  }
  return results;
}

function matchGlob(name: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return name === pattern;
  // Simple prefix/suffix matching for *.ext patterns
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(name);
}

// ============================================================================
// Category Builders
// ============================================================================

/** Category 1: Kaya System - skills SKILL.md files + architecture docs */
function buildKayaSystem(): RouteEntry[] {
  const entries: RouteEntry[] = [];
  const skillsDir = path.join(KAYA_DIR, "skills");

  // Add architecture doc if present
  const archFile = path.join(KAYA_DIR, "USER", "KAYA_ARCHITECTURE.md");
  if (fs.existsSync(archFile)) {
    entries.push({
      topic: "Kaya architecture overview",
      filePath: toRelative(archFile),
      lastUpdated: getMtime(archFile),
    });
  }

  // Add all hooks directory reference
  const hooksDir = path.join(KAYA_DIR, "hooks");
  if (fs.existsSync(hooksDir)) {
    entries.push({
      topic: "All hooks",
      filePath: "hooks/ (directory — browse manually)",
      lastUpdated: "—",
    });
  }

  // Scan skills/*/SKILL.md
  const skillFiles = globSync(skillsDir, "*/SKILL.md");
  skillFiles.sort();
  for (const f of skillFiles) {
    const skillName = path.basename(path.dirname(f));
    entries.push({
      topic: `Skill: ${skillName}`,
      filePath: toRelative(f),
      lastUpdated: getMtime(f),
    });
  }

  return entries;
}

// Files to exclude from User Identity (handled in other categories)
const USER_IDENTITY_EXCLUDE = new Set([
  "KAYA_ARCHITECTURE.md", // in Kaya System
]);

// Human-readable topic map for USER/*.md files
const USER_TOPIC_MAP: Record<string, string> = {
  "ABOUTME.md": "About Jm",
  "ARCHITECTURE.md": "Kaya system architecture",
  "ART.md": "Art preferences",
  "ASSETMANAGEMENT.md": "Asset management",
  "BASICINFO.md": "Basic personal info",
  "CONTACTS.md": "Contacts",
  "CORECONTENT.md": "Core content preferences",
  "DAIDENTITY.md": "DA identity (Kaya persona)",
  "DEFINITIONS.md": "Definitions / glossary",
  "JMIDENTITY.md": "Jm identity",
  "PRODUCTIVITY.md": "Productivity preferences",
  "README.md": "USER README",
  "REMINDERS.md": "Reminders",
  "RESPONSEFORMAT.md": "Response format preferences",
  "TECHSTACKPREFERENCES.md": "Technology stack preferences",
  "UserContext.md": "User context summary",
  "TELOS.md": "TELOS overview",
};

/** Category 2: User Identity - top-level USER md files (non-compressed, non-TELOS subdir) */
function buildUserIdentity(): RouteEntry[] {
  const userDir = path.join(KAYA_DIR, "USER");
  const entries: RouteEntry[] = [];

  if (!fs.existsSync(userDir)) return entries;

  // Only top-level USER/*.md files (not subdirectories like TELOS/, WORK/, etc.)
  try {
    const files = fs.readdirSync(userDir, { withFileTypes: true });
    for (const entry of files) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      if (entry.name.endsWith(".compressed.md")) continue;
      if (USER_IDENTITY_EXCLUDE.has(entry.name)) continue;

      const absPath = path.join(userDir, entry.name);
      const topic = USER_TOPIC_MAP[entry.name] ?? topicFromFilename(entry.name);
      entries.push({
        topic,
        filePath: toRelative(absPath),
        lastUpdated: getMtime(absPath),
      });
    }
  } catch {
    // ignore
  }

  entries.sort((a, b) => a.topic.localeCompare(b.topic));
  return entries;
}

/** Category 3: Life Goals / Telos - USER/TELOS md files (non-compressed) */
function buildLifeGoalsTelos(): RouteEntry[] {
  const telosDir = path.join(KAYA_DIR, "USER", "TELOS");
  const entries: RouteEntry[] = [];

  if (!fs.existsSync(telosDir)) return entries;

  const telosTopicMap: Record<string, string> = {
    "BELIEFS.md": "Opinions / beliefs",
    "BOOKS.md": "Books (reading / read)",
    "CHALLENGES.md": "Challenges",
    "FRAMES.md": "Mental frames",
    "GOALS.md": "Goals",
    "IDEAS.md": "Ideas",
    "LEARNED.md": "Things learned",
    "MISSION.md": "Core mission",
    "MISSIONS.md": "Missions",
    "MODELS.md": "Mental models",
    "MOVIES.md": "Movies",
    "NARRATIVES.md": "Narratives",
    "PREDICTIONS.md": "Predictions",
    "PROBLEMS.md": "Problems",
    "PROJECTS.md": "Projects (telos-level)",
    "README.md": "TELOS README",
    "STATUS.md": "Status (current)",
    "STRATEGIES.md": "Strategies",
    "TELOS.md": "TELOS summary",
    "TRAUMAS.md": "Traumas",
    "WISDOM.md": "Wisdom",
    "WRONG.md": "Things I was wrong about",
  };

  try {
    const files = fs.readdirSync(telosDir, { withFileTypes: true });
    for (const entry of files) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      if (entry.name.endsWith(".compressed.md")) continue;

      const absPath = path.join(telosDir, entry.name);
      const topic = telosTopicMap[entry.name] ?? topicFromFilename(entry.name);
      entries.push({
        topic,
        filePath: toRelative(absPath),
        lastUpdated: getMtime(absPath),
      });
    }
  } catch {
    // ignore
  }

  entries.sort((a, b) => a.topic.localeCompare(b.topic));
  return entries;
}

/** Category 4: Projects */
function buildProjects(): RouteEntry[] {
  const entries: RouteEntry[] = [];

  const projectsContext = path.join(KAYA_DIR, "context", "ProjectsContext.md");
  if (fs.existsSync(projectsContext)) {
    entries.push({
      topic: "Active projects",
      filePath: toRelative(projectsContext),
      lastUpdated: getMtime(projectsContext),
    });
  }

  const telosProjects = path.join(KAYA_DIR, "USER", "TELOS", "PROJECTS.md");
  if (fs.existsSync(telosProjects)) {
    entries.push({
      topic: "Telos-level projects",
      filePath: toRelative(telosProjects),
      lastUpdated: getMtime(telosProjects),
    });
  }

  return entries;
}

/** Category 5: Live Context Sources - context md files (excluding Projects) */
function buildLiveContextSources(): RouteEntry[] {
  const contextDir = path.join(KAYA_DIR, "context");
  const entries: RouteEntry[] = [];

  if (!fs.existsSync(contextDir)) return entries;

  const contextTopicMap: Record<string, string> = {
    "CalendarContext.md": "Calendar / schedule",
    "GoogleDriveContext.md": "Google Drive",
    "GraphContext.md": "Graph context",
    "LearningPatternsContext.md": "Learning patterns",
    "LearningsContext.md": "Learnings",
    "LucidTasksContext.md": "Tasks (LucidTasks)",
    "MasterContext.md": "Master context summary",
    "ObsidianContext.md": "Obsidian notes",
    "ProjectsContext.md": null as unknown as string, // excluded — in Projects category
    "TelosContext.md": "Telos (live sync)",
  };

  try {
    const files = fs.readdirSync(contextDir, { withFileTypes: true });
    for (const entry of files) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;

      // Skip ProjectsContext — it's in Projects category
      if (entry.name === "ProjectsContext.md") continue;

      const absPath = path.join(contextDir, entry.name);
      const topic = contextTopicMap[entry.name] ?? topicFromFilename(entry.name);
      if (topic === null) continue;

      entries.push({
        topic,
        filePath: toRelative(absPath),
        lastUpdated: getMtime(absPath),
      });
    }
  } catch {
    // ignore
  }

  entries.sort((a, b) => a.topic.localeCompare(b.topic));
  return entries;
}

/** Category 6: Memory System */
function buildMemorySystem(): RouteEntry[] {
  const entries: RouteEntry[] = [];

  const memoryFiles: Array<{ topic: string; rel: string }> = [
    { topic: "Memory index", rel: "MEMORY/index.json" },
    { topic: "Work queue state", rel: "MEMORY/QUEUES/state.json" },
    { topic: "Notifications", rel: "MEMORY/NOTIFICATIONS/notifications.jsonl" },
    { topic: "Approved work queue", rel: "MEMORY/QUEUES/approved-work.jsonl" },
    { topic: "Approvals queue", rel: "MEMORY/QUEUES/approvals.jsonl" },
  ];

  for (const { topic, rel } of memoryFiles) {
    const absPath = path.join(KAYA_DIR, rel);
    if (fs.existsSync(absPath)) {
      entries.push({
        topic,
        filePath: rel,
        lastUpdated: getMtime(absPath),
      });
    }
  }

  return entries;
}

/** Category 7: Configuration */
function buildConfiguration(): RouteEntry[] {
  const entries: RouteEntry[] = [];

  const configFiles: Array<{ topic: string; rel: string }> = [
    { topic: "Settings", rel: "settings.json" },
    { topic: "Asset management", rel: "USER/ASSETMANAGEMENT.md" },
    { topic: "Security rules", rel: "USER/KAYASECURITYSYSTEM/README.md" },
    { topic: "Productivity preferences", rel: "USER/PRODUCTIVITY.md" },
    { topic: "Tech stack preferences", rel: "USER/TECHSTACKPREFERENCES.md" },
    { topic: "Response format preferences", rel: "USER/RESPONSEFORMAT.md" },
  ];

  for (const { topic, rel } of configFiles) {
    const absPath = path.join(KAYA_DIR, rel);
    if (fs.existsSync(absPath)) {
      entries.push({
        topic,
        filePath: rel,
        lastUpdated: getMtime(absPath),
      });
    }
  }

  return entries;
}

// ============================================================================
// Markdown Rendering
// ============================================================================

function renderTable(entries: RouteEntry[]): string {
  if (entries.length === 0) {
    return "| (none found) | — | — |\n";
  }
  let out = "";
  for (const e of entries) {
    out += `| ${e.topic} | ${e.filePath} | ${e.lastUpdated} |\n`;
  }
  return out;
}

function renderMarkdown(categories: CategorySection[], generatedAt: string): string {
  let md = `# Context Routing Index\n\n`;
  md += `> Auto-generated by InformationManager. Last updated: ${generatedAt}.\n`;
  md += `> When you need specialized context not already loaded, find the path here and read the file.\n\n`;

  for (const cat of categories) {
    md += `## ${cat.name}\n\n`;
    md += `| Topic / Need | File Path | Last Updated |\n`;
    md += `|---|---|---|\n`;
    md += renderTable(cat.entries);
    md += "\n";
  }

  return md.trimEnd() + "\n";
}

// ============================================================================
// Main
// ============================================================================

function generate(): GenerationResult {
  const generatedAt = new Date().toISOString().slice(0, 10);

  const categories: CategorySection[] = [
    { name: "Kaya System", entries: buildKayaSystem() },
    { name: "User Identity", entries: buildUserIdentity() },
    { name: "Life Goals / Telos", entries: buildLifeGoalsTelos() },
    { name: "Projects", entries: buildProjects() },
    { name: "Live Context Sources", entries: buildLiveContextSources() },
    { name: "Memory System", entries: buildMemorySystem() },
    { name: "Configuration", entries: buildConfiguration() },
  ];

  const totalEntries = categories.reduce((sum, c) => sum + c.entries.length, 0);
  const markdown = renderMarkdown(categories, generatedAt);
  const lineCount = markdown.split("\n").length;

  return {
    categories,
    totalEntries,
    lineCount,
    generatedAt,
  };
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: false,
  });

  if (args.help) {
    process.stderr.write(`GenerateContextRouting - Build CONTEXT-ROUTING.md lookup table

Usage: bun GenerateContextRouting.ts [--dry-run] [--json] [--help]

Options:
  --dry-run  Print to stdout, do not write to disk
  --json     Output result as JSON (implies --dry-run)
  --help     Show this message
`);
    process.exit(0);
  }

  const isDryRun = args["dry-run"] === true || args.json === true;
  const isJson = args.json === true;

  const result = generate();
  const generatedAt = result.generatedAt;
  const categories = result.categories;

  const markdown = renderMarkdown(categories, generatedAt);
  const lineCount = markdown.split("\n").length;

  process.stderr.write(`[GenerateContextRouting] ${result.totalEntries} entries across ${categories.length} categories, ${lineCount} lines\n`);

  if (lineCount > MAX_LINES) {
    process.stderr.write(`[GenerateContextRouting] WARNING: Output is ${lineCount} lines (>${MAX_LINES}). Consider trimming.\n`);
  }

  if (isJson) {
    process.stdout.write(JSON.stringify({ ...result, markdown, lineCount }, null, 2) + "\n");
    process.exit(0);
  }

  if (isDryRun) {
    process.stdout.write(markdown);
    process.exit(0);
  }

  // Atomic write: write to .tmp then rename
  const tmpPath = OUTPUT_PATH + ".tmp";
  try {
    fs.writeFileSync(tmpPath, markdown, "utf8");
    fs.renameSync(tmpPath, OUTPUT_PATH);
    process.stderr.write(`[GenerateContextRouting] Written to ${OUTPUT_PATH}\n`);
  } catch (err) {
    process.stderr.write(`[GenerateContextRouting] ERROR writing file: ${err}\n`);
    // Clean up tmp if it exists
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    process.exit(1);
  }

  process.exit(0);
}

main();
