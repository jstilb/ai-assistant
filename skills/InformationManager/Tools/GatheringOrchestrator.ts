#!/usr/bin/env bun
/**
 * GatheringOrchestrator - Config-driven gathering engine for InformationManager
 *
 * Orchestrates multi-source gathering by loading config from config/*.json files.
 * All domain knowledge (paths, IDs, APIs) lives in config files, NOT in this tool.
 *
 * Usage:
 *   bun run GatheringOrchestrator.ts --mode consolidate
 *   bun run GatheringOrchestrator.ts --sources lucidtasks,calendar
 *   bun run GatheringOrchestrator.ts --dry-run
 *
 * Options:
 *   --mode <refresh|consolidate>  Gathering mode (default: consolidate)
 *   --sources <list>              Comma-separated sources (default: all)
 *   --config-dir <path>           Config directory (default: ./config)
 *   --json                        Output as JSON
 *   --dry-run                     Show what would be gathered
 *   --help                        Show this help
 */

import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { syncToContext, type SyncConfig } from "./SyncEngine.ts";
import { generateFolderContext } from "./FolderContextGenerator.ts";
import { generateAggregateContext, type FolderContext } from "./AggregateContextGenerator.ts";

// ============================================================================
// EINTR Retry Helper (macOS iCloud sync workaround)
// ============================================================================

/**
 * Wraps fs operations with retry logic to handle EINTR errors from iCloud sync.
 * EINTR ("Interrupted system call") occurs when macOS iCloud daemon interrupts
 * file operations on Desktop/Documents folders that are synced to iCloud.
 */
function withEINTRRetry<T>(
  operation: () => T,
  maxRetries: number = 5,
  baseDelayMs: number = 100
): T {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return operation();
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Only retry on EINTR errors
      if (errorCode === "EINTR" || errorMessage.includes("Interrupted system call")) {
        lastError = error instanceof Error ? error : new Error(errorMessage);
        // Exponential backoff: 100ms, 200ms, 400ms, 800ms, 1600ms
        const delay = baseDelayMs * Math.pow(2, attempt);
        Bun.sleepSync(delay);
        continue;
      }

      // Non-EINTR errors should throw immediately
      throw error;
    }
  }

  throw lastError || new Error("Operation failed after retries");
}

/**
 * Safe readdirSync with EINTR retry logic
 */
function safeReaddirSync(dirPath: string, options?: fs.ObjectEncodingOptions & { withFileTypes: true }): fs.Dirent[];
function safeReaddirSync(dirPath: string, options?: fs.ObjectEncodingOptions & { withFileTypes?: false }): string[];
function safeReaddirSync(dirPath: string, options?: fs.ObjectEncodingOptions & { withFileTypes?: boolean }): string[] | fs.Dirent[] {
  return withEINTRRetry(() => fs.readdirSync(dirPath, options as any));
}

/**
 * Safe existsSync with EINTR retry logic
 */
function safeExistsSync(filePath: string): boolean {
  return withEINTRRetry(() => fs.existsSync(filePath));
}

/**
 * Safe readFileSync with EINTR retry logic
 */
function safeReadFileSync(filePath: string, encoding: BufferEncoding): string {
  return withEINTRRetry(() => fs.readFileSync(filePath, encoding));
}

// ============================================================================
// Configuration
// ============================================================================

const HOME = process.env.HOME || "/Users/your-username";
const KAYA_DIR = process.env.KAYA_DIR || path.join(HOME, ".claude");
const SCRIPT_DIR = path.dirname(import.meta.path);
const DEFAULT_CONFIG_DIR = path.join(SCRIPT_DIR, "..", "config");
const CONTEXT_DIR = path.join(KAYA_DIR, "context");

type SourceType = "obsidian" | "telos" | "learnings" | "projects" | "lucidtasks" | "calendar" | "drive" | "skills";
type GatherMode = "refresh" | "consolidate";

const ALL_SOURCES: SourceType[] = ["obsidian", "telos", "learnings", "projects", "lucidtasks", "calendar", "drive", "skills"];

// ============================================================================
// Types
// ============================================================================

export interface SourceConfig {
  source: string;
  title: string;
  output: string;
  cli?: string;
  timeout?: number;
  metricLabel?: string;
  priority?: string;
  loadWhen?: string[];
  skipWhen?: string[];
  freshnessRule?: string;
  // Source-specific fields loaded from config
  [key: string]: unknown;
}

export interface GatherResult {
  source: SourceType;
  success: boolean;
  contextFile?: string;
  summary?: string;
  error?: string;
  entriesCount?: number;
  durationMs: number;
}

// ============================================================================
// Config Loading
// ============================================================================

function loadSourceConfig(source: SourceType, configDir: string): SourceConfig | null {
  const configPath = path.join(configDir, `${source}.json`);
  if (!fs.existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    return null;
  }
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    console.error(`Failed to parse config: ${configPath}`);
    return null;
  }
}

function resolveConfigPath(configPath: string): string {
  if (configPath.startsWith("/")) {
    return configPath;
  }
  return path.join(KAYA_DIR, configPath);
}

// ============================================================================
// Source Gatherers
// ============================================================================

async function gatherObsidian(config: SourceConfig): Promise<{ content: string; entriesCount: number }> {
  const vaultPath = config.vaultPath as string;
  let content = "";
  let entriesCount = 0;

  try {
    if (safeExistsSync(vaultPath)) {
      const excludePrefixes = (config.excludeFolders as string[]) || [".", "_"];
      const folders = safeReaddirSync(vaultPath, { withFileTypes: true })
        .filter(d => d.isDirectory() && !excludePrefixes.some(p => d.name.startsWith(p)))
        .map(d => d.name);

      content += `## Vault Structure\n\n`;
      content += `**Location:** \`${vaultPath}\`\n\n`;
      content += `**Folders:** ${folders.length}\n\n`;

      let totalNotes = 0;
      for (const folder of folders) {
        const folderPath = path.join(vaultPath, folder);
        try {
          const notes = safeReaddirSync(folderPath).filter(f => f.endsWith(".md")).length;
          totalNotes += notes;
          if (notes > 0) {
            content += `- **${folder}:** ${notes} notes\n`;
            entriesCount++;
          }
        } catch {
          // Skip inaccessible folders
        }
      }

      content += `\n**Total Notes:** ${totalNotes}\n`;
    } else {
      content = "Obsidian vault not found at expected location.\n";
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes("Interrupted system call") || errorMsg.includes("EINTR")) {
      content = `## Obsidian Vault\n\n**Status:** Temporarily inaccessible due to iCloud sync.\n\n`;
      content += `The vault at \`${vaultPath}\` is being synced by iCloud. Try again in a few minutes.\n`;
      content += `\n**Workaround:** If persistent, run: \`killall bird\` or restart Finder.\n`;
    } else {
      content = `Obsidian vault error: ${errorMsg}\n`;
    }
  }

  return { content, entriesCount };
}

async function gatherTelos(config: SourceConfig): Promise<{ content: string; entriesCount: number }> {
  const telosDir = resolveConfigPath(config.telosDir as string);
  const coreFiles = (config.coreFiles as string[]) || [];
  const sheets = (config.sheets as Record<string, string>) || {};
  const sheetRanges = (config.sheetRanges as Record<string, string>) || {};

  let content = "";
  let entriesCount = 0;

  content += `## TELOS Life Framework\n\n`;

  if (safeExistsSync(telosDir)) {
    for (const file of coreFiles) {
      const filePath = path.join(telosDir, file);
      if (safeExistsSync(filePath)) {
        try {
          const fileContent = safeReadFileSync(filePath, "utf-8");
          const lines = fileContent.split("\n");
          const summary = lines.slice(0, 30).join("\n");
          content += `### ${file.replace(".md", "")}\n${summary}\n\n---\n\n`;
          entriesCount++;
        } catch {
          content += `### ${file.replace(".md", "")}\n*Unable to read file*\n\n`;
        }
      }
    }
  } else {
    content += "*TELOS directory not found*\n";
  }

  // Include tracking metrics from sheets
  content += `## Tracking Metrics\n\n`;

  if (sheets.goal_achievement) {
    try {
      const range = sheetRanges.goal_achievement || "A1:Z10";
      const goalData = execSync(
        `kaya-cli sheets get ${sheets.goal_achievement} --range "${range}" 2>/dev/null`,
        { encoding: "utf-8", timeout: config.timeout as number || 10000 }
      );
      if (goalData) {
        content += `### Goal Achievement\n\`\`\`\n${goalData.slice(0, 500)}\n\`\`\`\n\n`;
        entriesCount++;
      }
    } catch {
      content += `*Goal achievement data unavailable - kaya-cli sheets not accessible*\n\n`;
    }
  }

  if (sheets.habit_building) {
    try {
      const range = sheetRanges.habit_building || "A1:AM10";
      const habitData = execSync(
        `kaya-cli sheets get ${sheets.habit_building} --range "${range}" 2>/dev/null`,
        { encoding: "utf-8", timeout: config.timeout as number || 10000 }
      );
      if (habitData) {
        content += `### Habit Tracking\n\`\`\`\n${habitData.slice(0, 500)}\n\`\`\`\n\n`;
        entriesCount++;
      }
    } catch {
      content += `*Habit tracking data unavailable*\n\n`;
    }
  }

  return { content, entriesCount };
}

async function gatherLearnings(config: SourceConfig): Promise<{ content: string; entriesCount: number }> {
  const memoryDir = resolveConfigPath(config.memoryDir as string || "MEMORY");
  const ratingsFile = resolveConfigPath(config.ratingsFile as string);
  const synthesisDir = resolveConfigPath(config.synthesisDir as string);
  const recentCount = (config.recentRatingsCount as number) || 20;

  let content = "";
  let entriesCount = 0;

  content += `## Learning Patterns\n\n`;

  if (safeExistsSync(ratingsFile)) {
    try {
      const ratingsContent = safeReadFileSync(ratingsFile, "utf-8");
      const ratings = ratingsContent.split("\n").filter(l => l.trim()).slice(-recentCount);

      let sum = 0;
      let count = 0;
      for (const line of ratings) {
        try {
          const rating = JSON.parse(line);
          if (rating.rating) {
            sum += rating.rating;
            count++;
          }
        } catch {
          // Skip invalid JSON
        }
      }

      if (count > 0) {
        const avg = (sum / count).toFixed(2);
        content += `### Recent Ratings (Last ${recentCount})\n`;
        content += `- **Average Score:** ${avg}\n`;
        content += `- **Total Ratings:** ${count}\n\n`;
        entriesCount++;
      }
    } catch {
      content += "*Unable to read ratings*\n\n";
    }
  }

  if (safeExistsSync(synthesisDir)) {
    const monthDirs = safeReaddirSync(synthesisDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort()
      .reverse()
      .slice(0, 2);

    for (const monthDir of monthDirs) {
      const files = safeReaddirSync(path.join(synthesisDir, monthDir))
        .filter(f => f.endsWith(".md"))
        .slice(0, 3);

      if (files.length > 0) {
        content += `### Synthesis (${monthDir})\n`;
        for (const file of files) {
          content += `- ${file}\n`;
          entriesCount++;
        }
        content += "\n";
      }
    }
  }

  return { content, entriesCount };
}

async function gatherProjects(config: SourceConfig): Promise<{ content: string; entriesCount: number }> {
  const projectsDir = config.projectsDir as string;
  const excludePrefixes = (config.excludeFolders as string[]) || ["."];
  const techStackDetection = (config.techStackDetection as Record<string, string>) || {};

  let content = "";
  let entriesCount = 0;

  content += `## Projects\n\n`;
  content += `**Location:** \`${projectsDir}\`\n\n`;

  if (safeExistsSync(projectsDir)) {
    const projects = safeReaddirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !excludePrefixes.some(p => d.name.startsWith(p)))
      .map(d => d.name);

    content += `| Project | Has README | Tech Stack |\n`;
    content += `|---------|------------|------------|\n`;

    for (const project of projects) {
      const projectPath = path.join(projectsDir, project);
      const hasReadme = safeExistsSync(path.join(projectPath, "README.md"));

      let tech = "";
      for (const [file, stack] of Object.entries(techStackDetection)) {
        if (safeExistsSync(path.join(projectPath, file))) {
          tech = stack;
          break;
        }
      }

      content += `| ${project} | ${hasReadme ? "Yes" : "No"} | ${tech || "-"} |\n`;
      entriesCount++;
    }
  } else {
    content += "*Projects directory not found*\n";
  }

  return { content, entriesCount };
}

async function gatherLucidTasks(config: SourceConfig): Promise<{ content: string; entriesCount: number }> {
  const cli = (config.cli as string) || "kaya-cli tasks --json";
  const timeout = (config.timeout as number) || 10000;

  let content = "";
  let entriesCount = 0;

  content += `## LucidTasks\n\n`;

  try {
    const output = execSync(`${cli} 2>/dev/null`, { encoding: "utf-8", timeout });
    if (output && output.trim().startsWith("[")) {
      try {
        const tasks = JSON.parse(output.trim()) as Array<{ title?: string; status?: string; due_date?: string }>;
        const active = tasks.filter((t) => t.status && !["done", "cancelled"].includes(t.status));
        content += `**Active Tasks:** ${active.length}\n\n`;
        for (const task of active.slice(0, 15)) {
          const due = task.due_date ? ` (due: ${task.due_date})` : "";
          content += `- ${task.title ?? "Untitled"}${due}\n`;
        }
        if (active.length > 15) {
          content += `- ...and ${active.length - 15} more\n`;
        }
        entriesCount = active.length;
      } catch {
        content += `\`\`\`\n${output.slice(0, 1000)}\n\`\`\`\n`;
        entriesCount = output.split("\n").filter((l) => l.trim()).length;
      }
    } else if (output) {
      content += `\`\`\`\n${output.slice(0, 1000)}\n\`\`\`\n`;
      entriesCount = output.split("\n").filter((l) => l.trim()).length;
    }
  } catch {
    content += "*LucidTasks data unavailable - kaya-cli tasks not accessible*\n";
  }

  return { content, entriesCount };
}

async function gatherCalendar(config: SourceConfig): Promise<{ content: string; entriesCount: number }> {
  const cli = config.cli as string;
  const timeout = (config.timeout as number) || 10000;

  let content = "";
  let entriesCount = 0;

  content += `## Calendar Events\n\n`;

  try {
    const calendarOutput = execSync(`${cli} 2>/dev/null`, { encoding: "utf-8", timeout });
    if (calendarOutput) {
      content += `### Next 7 Days\n\`\`\`\n${calendarOutput.slice(0, 1000)}\n\`\`\`\n`;
      entriesCount = calendarOutput.split("\n").filter(l => l.trim()).length;
    }
  } catch {
    content += "*Calendar data unavailable - kaya-cli calendar not accessible*\n";
  }

  return { content, entriesCount };
}

async function gatherDrive(config: SourceConfig): Promise<{ content: string; entriesCount: number }> {
  const remoteName = (config.remoteName as string) || "gdrive";
  const excludedFolders = (config.excludedFolders as string[]) || [];
  const timeout = (config.timeout as number) || 120000;

  let content = "";
  let entriesCount = 0;

  content += `## Google Drive Structure\n\n`;

  try {
    // Get top-level folders only (fast) - don't use recursive as it's slow for large drives
    const rcloneTimeoutSecs = Math.floor(timeout / 1000);
    const foldersOutput = execSync(
      `rclone lsd ${remoteName}: --timeout ${rcloneTimeoutSecs}s 2>/dev/null`,
      { encoding: "utf-8", timeout: timeout + 5000 }
    );

    const folderLines = foldersOutput.trim().split("\n").filter(l => l.trim());
    const topLevelFolders: string[] = [];

    for (const line of folderLines) {
      // rclone lsd format: "          -1 2024-01-15 12:00:00        -1 FolderName"
      const parts = line.trim().split(/\s+/);
      const folderName = parts.slice(4).join(" "); // Join in case folder name has spaces

      if (!folderName || excludedFolders.some(ex => folderName.includes(ex))) {
        continue;
      }

      topLevelFolders.push(folderName);
      entriesCount++;
    }

    content += `**Remote:** \`${remoteName}:\`\n\n`;
    content += `### Top-Level Folders (${topLevelFolders.length})\n\n`;

    for (const folder of topLevelFolders.sort()) {
      content += `- ${folder}/\n`;
    }

    content += `\n## Summary\n\n`;
    content += `- **Top-Level Folders:** ${topLevelFolders.length}\n`;
    content += `- **Last Sync:** ${new Date().toISOString().split("T")[0]}\n`;
    content += `\n*Note: Only top-level folders listed for performance. Use \`rclone lsd ${remoteName}:FolderName --recursive\` for subfolder details.*\n`;

  } catch (error) {
    content += `*Google Drive data unavailable - rclone not accessible*\n\n`;
    content += `Error: ${error instanceof Error ? error.message : String(error)}\n`;
  }

  return { content, entriesCount };
}

async function gatherSkills(config: SourceConfig): Promise<{ content: string; entriesCount: number }> {
  const skillsDir = config.skillsDir as string || path.join(KAYA_DIR, "skills");
  const indexPath = path.join(skillsDir, "skill-index.json");
  const includePrivate = (config.includePrivate as boolean) ?? true;

  let content = "";
  let entriesCount = 0;

  content += `## Kaya Skills\n\n`;
  content += `**Location:** \`${skillsDir}\`\n\n`;

  // Try to read from skill-index.json if it exists (generated by GenerateSkillIndex.ts)
  if (safeExistsSync(indexPath)) {
    try {
      const indexContent = safeReadFileSync(indexPath, "utf-8");
      const index = JSON.parse(indexContent);

      const generated = new Date(index.generated).toISOString().split("T")[0];
      content += `**Index Generated:** ${generated}\n`;
      content += `**Total Skills:** ${index.totalSkills}\n`;
      content += `**Always Loaded:** ${index.alwaysLoadedCount}\n`;
      content += `**Deferred:** ${index.deferredCount}\n\n`;

      // Always Loaded Skills section
      content += `### Always Loaded\n\n`;
      content += `| Skill | Description | Triggers |\n`;
      content += `|-------|-------------|----------|\n`;

      for (const [key, skill] of Object.entries(index.skills as Record<string, { name: string; fullDescription: string; triggers: string[]; tier: string }>)) {
        if (skill.tier !== "always") continue;
        if (!includePrivate && key.startsWith("_")) continue;

        const shortDesc = skill.fullDescription.split(".")[0].replace(/USE WHEN.*$/i, "").trim();
        const triggers = skill.triggers.slice(0, 3).join(", ");
        content += `| **${skill.name}** | ${shortDesc} | ${triggers} |\n`;
        entriesCount++;
      }

      content += `\n### Deferred Skills\n\n`;
      content += `| Skill | Description | Triggers |\n`;
      content += `|-------|-------------|----------|\n`;

      for (const [key, skill] of Object.entries(index.skills as Record<string, { name: string; fullDescription: string; triggers: string[]; tier: string }>)) {
        if (skill.tier !== "deferred") continue;
        if (!includePrivate && key.startsWith("_")) continue;

        const shortDesc = skill.fullDescription.split(".")[0].replace(/USE WHEN.*$/i, "").trim();
        const triggers = skill.triggers.slice(0, 3).join(", ");
        content += `| ${skill.name} | ${shortDesc} | ${triggers} |\n`;
        entriesCount++;
      }

      content += `\n## Quick Reference\n\n`;
      content += `**Invoke skills:** Use Skill tool or \`/skill-name\`\n\n`;
      content += `**Full skill details:** \`skills/skill-index.json\`\n\n`;
      content += `**Markdown index:** \`skills/CORE/SKILL-INDEX.md\`\n`;

    } catch (error) {
      content += `*Unable to read skill index: ${error instanceof Error ? error.message : String(error)}*\n\n`;

      // Fallback: scan skills directory directly
      content += await gatherSkillsFallback(skillsDir, includePrivate);
    }
  } else {
    // No index exists, use fallback
    content += `*No skill-index.json found. Run GenerateSkillIndex.ts to create one.*\n\n`;
    const { fallbackContent, fallbackCount } = await gatherSkillsFallback(skillsDir, includePrivate);
    content += fallbackContent;
    entriesCount += fallbackCount;
  }

  return { content, entriesCount };
}

async function gatherSkillsFallback(skillsDir: string, includePrivate: boolean): Promise<{ fallbackContent: string; fallbackCount: number }> {
  let fallbackContent = "### Available Skills (Fallback Scan)\n\n";
  let fallbackCount = 0;

  if (safeExistsSync(skillsDir)) {
    const dirs = safeReaddirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith("."))
      .filter(d => includePrivate || !d.name.startsWith("_"))
      .map(d => d.name);

    fallbackContent += `| Skill | Has SKILL.md |\n`;
    fallbackContent += `|-------|-------------|\n`;

    for (const dir of dirs) {
      const skillPath = path.join(skillsDir, dir, "SKILL.md");
      const hasSkill = safeExistsSync(skillPath);
      fallbackContent += `| ${dir} | ${hasSkill ? "Yes" : "No"} |\n`;
      if (hasSkill) fallbackCount++;
    }
  }

  return { fallbackContent, fallbackCount };
}

// ============================================================================
// Main Orchestration
// ============================================================================

const GATHERERS: Record<SourceType, (config: SourceConfig) => Promise<{ content: string; entriesCount: number }>> = {
  obsidian: gatherObsidian,
  telos: gatherTelos,
  learnings: gatherLearnings,
  projects: gatherProjects,
  lucidtasks: gatherLucidTasks,
  calendar: gatherCalendar,
  drive: gatherDrive,
  skills: gatherSkills,
};

export async function gatherFromSource(
  source: SourceType,
  configDir: string
): Promise<GatherResult> {
  const startTime = Date.now();

  const config = loadSourceConfig(source, configDir);
  if (!config) {
    return {
      source,
      success: false,
      error: `Config not found for ${source}`,
      durationMs: Date.now() - startTime,
    };
  }

  try {
    const gatherer = GATHERERS[source];
    if (!gatherer) {
      return {
        source,
        success: false,
        error: `Unknown source: ${source}`,
        durationMs: Date.now() - startTime,
      };
    }

    const { content, entriesCount } = await gatherer(config);

    // Use SyncEngine to write the file
    const syncConfig: SyncConfig = {
      source: config.source,
      title: config.title,
      outputPath: config.output,
      content,
      entriesCount,
    };

    const syncResult = await syncToContext(syncConfig);

    return {
      source,
      success: syncResult.success,
      contextFile: syncResult.outputPath,
      summary: `Gathered ${entriesCount} entries`,
      entriesCount,
      error: syncResult.error,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      source,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startTime,
    };
  }
}

export async function gatherAll(
  mode: GatherMode,
  sources: SourceType[],
  configDir: string
): Promise<{ results: GatherResult[]; masterContext?: string }> {
  const results: GatherResult[] = [];

  for (const source of sources) {
    const result = await gatherFromSource(source, configDir);
    results.push(result);
    console.log(`[${result.success ? "OK" : "FAIL"}] ${source}: ${result.summary || result.error}`);
  }

  let masterContext: string | undefined;
  if (mode === "consolidate") {
    const timestamp = new Date().toISOString();
    const successfulSources = results.filter(r => r.success);

    let content = `## Context Sources\n\n`;
    content += `| Source | Status | Entries | File |\n`;
    content += `|--------|--------|---------|------|\n`;

    for (const result of results) {
      const status = result.success ? "OK" : "Failed";
      const entries = result.entriesCount || 0;
      const file = result.contextFile ? path.basename(result.contextFile) : "-";
      content += `| ${result.source} | ${status} | ${entries} | ${file} |\n`;
    }

    content += `\n## Quick Load Commands\n\n`;
    content += `**Load all context:**\n- Read MasterContext.md for overview\n- Load specific context files as needed\n\n`;
    content += `**For Obsidian tasks:**\n- Load ObsidianContext.md for structure\n- Load relevant folder's _Context.md for detail\n\n`;
    content += `**For development tasks:**\n- Load ProjectsContext.md\n- Load relevant project README\n\n`;
    content += `**For life planning tasks:**\n- Load TelosContext.md for framework\n\n`;
    content += `**For understanding AI behavior:**\n- Load LearningsContext.md for patterns\n\n`;

    const masterConfig: SyncConfig = {
      source: "master",
      title: "Master Context Index",
      outputPath: "context/MasterContext.md",
      content,
      entriesCount: successfulSources.length,
    };

    const masterResult = await syncToContext(masterConfig);
    masterContext = masterResult.outputPath;
    console.log(`\nMaster context written to: ${masterContext}`);
  }

  return { results, masterContext };
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      mode: { type: "string", short: "m", default: "consolidate" },
      sources: { type: "string", short: "s" },
      "config-dir": { type: "string", short: "c" },
      json: { type: "boolean" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`
GatheringOrchestrator - Config-driven gathering engine for InformationManager

Usage:
  bun run GatheringOrchestrator.ts --mode consolidate
  bun run GatheringOrchestrator.ts --sources obsidian,telos
  bun run GatheringOrchestrator.ts --json

Options:
  --mode <refresh|consolidate>  Gathering mode (default: consolidate)
  --sources <list>              Comma-separated sources (default: all)
  --config-dir <path>           Config directory (default: ./config)
  --json                        Output as JSON
  --dry-run                     Show what would be gathered
  --help                        Show this help

Sources: obsidian, telos, learnings, projects, lucidtasks, calendar, drive, skills

Config files are loaded from config/*.json:
  lucidtasks.json, calendar.json, drive.json, learnings.json,
  obsidian.json, projects.json, skills.json, telos.json
`);
    process.exit(0);
  }

  const mode = (values.mode as GatherMode) || "consolidate";
  const sources = values.sources
    ? (values.sources.split(",") as SourceType[])
    : ALL_SOURCES;
  const configDir = values["config-dir"] || DEFAULT_CONFIG_DIR;

  if (values["dry-run"]) {
    console.log(`Mode: ${mode}`);
    console.log(`Sources to gather: ${sources.join(", ")}`);
    console.log(`Config directory: ${configDir}`);
    console.log(`Output directory: ${CONTEXT_DIR}`);
    console.log("\nConfigs found:");
    for (const source of sources) {
      const configPath = path.join(configDir, `${source}.json`);
      const exists = fs.existsSync(configPath);
      console.log(`  ${source}: ${exists ? "OK" : "MISSING"} (${configPath})`);
    }
    process.exit(0);
  }

  console.log(`Gathering context (mode: ${mode})...`);
  console.log(`Sources: ${sources.join(", ")}`);
  console.log(`Config: ${configDir}\n`);

  const { results, masterContext } = await gatherAll(mode, sources, configDir);

  if (values.json) {
    console.log(JSON.stringify({ results, masterContext }, null, 2));
  } else {
    console.log(`\n=== Summary ===`);
    const successful = results.filter(r => r.success).length;
    const totalEntries = results.reduce((sum, r) => sum + (r.entriesCount || 0), 0);
    const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);
    console.log(`Sources: ${successful}/${results.length} successful`);
    console.log(`Entries: ${totalEntries} total`);
    console.log(`Duration: ${totalDuration}ms`);
    if (masterContext) {
      console.log(`Master: ${masterContext}`);
    }
  }
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}
