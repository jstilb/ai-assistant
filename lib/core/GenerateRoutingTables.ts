#!/usr/bin/env bun
/**
 * ============================================================================
 * GenerateRoutingTables - Regenerate category SKILL.md routing tables from fs
 * ============================================================================
 *
 * PURPOSE:
 * Scans the Kaya skill system's category directories and regenerates the
 * `## Sub-Skills` routing tables in each category's SKILL.md. Makes the
 * filesystem the single source of truth — prevents manual drift.
 *
 * A directory is treated as a "category" if:
 *   1. It has a SKILL.md directly inside it
 *   2. At least one subdirectory inside it also has a SKILL.md
 *
 * The tool preserves everything before `## Sub-Skills` (frontmatter, prose)
 * and regenerates from that heading onward: table + Workflow Routing +
 * Voice Notification boilerplate.
 *
 * USAGE:
 *   bun lib/core/GenerateRoutingTables.ts                     # all categories
 *   bun lib/core/GenerateRoutingTables.ts --category Life     # single category
 *   bun lib/core/GenerateRoutingTables.ts --dry-run           # preview only
 *   bun lib/core/GenerateRoutingTables.ts --skills-dir /path  # override path
 *
 * ============================================================================
 */

import { parseArgs } from "util";
import { join } from "path";
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { getKayaHome } from "./KayaHome.ts";

// ============================================================================
// Constants
// ============================================================================

// frozen at import (getKayaHome cached); no test re-pins this module
const DEFAULT_SKILLS_DIR = join(getKayaHome(), "skills");
const DEFAULT_COMMANDS_DIR = join(getKayaHome(), "Commands");

const WORKFLOW_ROUTING_BOILERPLATE = `## Workflow Routing

When a sub-skill is identified from the table above:
1. Read the sub-skill's SKILL.md for its full routing and workflow list
2. Execute the appropriate workflow from that sub-skill's directory`;

const VOICE_NOTIFICATION_BOILERPLATE = `## Voice Notification

Use \`notifySync()\` from \`lib/core/NotificationService.ts\``;

// ============================================================================
// Types
// ============================================================================

export interface SubSkillEntry {
  /** Directory name, e.g. "Research" */
  name: string;
  /** Extracted USE WHEN triggers */
  triggers: string[];
  /** Relative load path, e.g. "Intelligence/Research/SKILL.md" */
  path: string;
  /** Full description from frontmatter */
  description: string;
}

export interface CategoryResult {
  category: string;
  subSkills: SubSkillEntry[];
  written: boolean;
  skipped: boolean;
  reason?: string;
}

export interface CommandResult {
  name: string;
  skillPath: string;
  written: boolean;
  skipped: boolean;
  reason?: string;
}

export interface GenerateResult {
  categories: CategoryResult[];
  totalSubSkills: number;
  commands: CommandResult[];
  errors: string[];
}

// ============================================================================
// Trigger Extraction
// ============================================================================

/**
 * Extract the full description field from SKILL.md frontmatter.
 */
function extractDescription(content: string): string {
  const descMatch = content.match(/description:\s*(.+?)(?:\n|$)/i);
  return descMatch?.[1]?.trim() ?? "";
}

/**
 * Extract USE WHEN triggers from a sub-skill SKILL.md's description frontmatter field.
 * Splits on ", " or " OR " (case-insensitive).
 * Returns lowercase, trimmed tokens.
 */
function extractTriggersFromDescription(content: string): string[] {
  const descMatch = content.match(/description:\s*(.+?)(?:\n|$)/i);
  if (!descMatch) return [];
  const useWhenMatch = descMatch[1].match(/USE WHEN\s+(.+?)(?:\.|$)/i);
  if (!useWhenMatch) return [];
  return useWhenMatch[1]
    .split(/,\s*|\s+OR\s+/i)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

// ============================================================================
// Category Detection
// ============================================================================

/**
 * Returns true if the given directory is a "category":
 * - Has its own SKILL.md
 * - Contains at least one subdirectory that also has a SKILL.md
 */
export function isCategoryDir(categoryPath: string): boolean {
  if (!existsSync(join(categoryPath, "SKILL.md"))) return false;

  try {
    const entries = readdirSync(categoryPath, { withFileTypes: true });
    return entries.some(
      (e) =>
        e.isDirectory() &&
        existsSync(join(categoryPath, e.name, "SKILL.md"))
    );
  } catch {
    return false;
  }
}

// ============================================================================
// Sub-Skill Scanning
// ============================================================================

/**
 * Scan a category directory for sub-skills with SKILL.md files.
 * Returns entries sorted alphabetically by name.
 * Unreadable sub-skill SKILL.md files are skipped silently (errors surfaced
 * via the errors array in GenerateResult — callers collect them separately).
 */
export function scanCategorySubSkills(
  categoryName: string,
  skillsDir: string
): SubSkillEntry[] {
  const categoryPath = join(skillsDir, categoryName);
  const entries: SubSkillEntry[] = [];

  let dirEntries;
  try {
    dirEntries = readdirSync(categoryPath, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const dirent of dirEntries) {
    if (!dirent.isDirectory()) continue;
    const subSkillMd = join(categoryPath, dirent.name, "SKILL.md");
    if (!existsSync(subSkillMd)) continue;

    let triggers: string[];
    let description: string;
    try {
      const content = readFileSync(subSkillMd, "utf-8");
      triggers = extractTriggersFromDescription(content);
      description = extractDescription(content);
    } catch {
      // Unreadable — skip this entry; callers add to errors
      continue;
    }

    if (triggers.length === 0) {
      triggers = [dirent.name.toLowerCase()];
    }

    entries.push({
      name: dirent.name,
      triggers,
      path: `${categoryName}/${dirent.name}/SKILL.md`,
      description,
    });
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

// ============================================================================
// Table Builder
// ============================================================================

/**
 * Build the markdown Sub-Skills table string for a category.
 * Includes the heading, column headers, separator row, and one row per sub-skill.
 */
export function buildSubSkillsTable(
  _categoryName: string,
  subSkills: SubSkillEntry[]
): string {
  const rows = subSkills.map(
    (s) =>
      `| **${s.name}** | ${s.triggers.join(", ")} | \`${s.path}\` |`
  );

  return [
    "## Sub-Skills",
    "",
    "| Sub-Skill | Triggers | Load |",
    "|-----------|----------|------|",
    ...rows,
  ].join("\n");
}

// ============================================================================
// Content Regeneration
// ============================================================================

/**
 * Given the existing category SKILL.md content, regenerate it:
 * - Preserve everything before `\n## Sub-Skills`
 * - Replace from `## Sub-Skills` onward with fresh table + boilerplate
 *
 * If `## Sub-Skills` heading is not found, returns the original content unchanged.
 */
export function regenerateCategorySkillMd(
  existingContent: string,
  categoryName: string,
  subSkills: SubSkillEntry[]
): string {
  // Find the position of `## Sub-Skills` at a line boundary
  const headingIndex = existingContent.search(/\n## Sub-Skills/);
  if (headingIndex === -1) {
    return existingContent; // heading not found — return unchanged
  }

  // `preserved` ends with the last char before the `\n## Sub-Skills` sequence,
  // so it already contains a trailing newline from the preceding prose line.
  // We append exactly one blank line before the heading.
  const preserved = existingContent.slice(0, headingIndex);
  const table = buildSubSkillsTable(categoryName, subSkills);

  return (
    preserved +
    "\n" +
    table +
    "\n\n" +
    WORKFLOW_ROUTING_BOILERPLATE +
    "\n\n" +
    VOICE_NOTIFICATION_BOILERPLATE +
    "\n"
  );
}

// ============================================================================
// Per-Category Generator
// ============================================================================

/**
 * Regenerate the routing table for a single category.
 *
 * Returns a CategoryResult describing what happened.
 * When dryRun is true, computes the result but does not write the file.
 */
export function generateForCategory(
  categoryName: string,
  skillsDir: string,
  dryRun: boolean = false
): CategoryResult {
  const categoryPath = join(skillsDir, categoryName);

  if (!isCategoryDir(categoryPath)) {
    return {
      category: categoryName,
      subSkills: [],
      written: false,
      skipped: true,
      reason: "Not a category directory (missing SKILL.md or no sub-skill SKILL.md found)",
    };
  }

  const subSkills = scanCategorySubSkills(categoryName, skillsDir);

  if (subSkills.length === 0) {
    return {
      category: categoryName,
      subSkills: [],
      written: false,
      skipped: true,
      reason: "No sub-skills found",
    };
  }

  const skillMdPath = join(categoryPath, "SKILL.md");
  let existingContent: string;
  try {
    existingContent = readFileSync(skillMdPath, "utf-8");
  } catch (err) {
    return {
      category: categoryName,
      subSkills,
      written: false,
      skipped: true,
      reason: `Could not read SKILL.md: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Guard: heading must exist
  if (existingContent.search(/\n## Sub-Skills/) === -1) {
    return {
      category: categoryName,
      subSkills,
      written: false,
      skipped: true,
      reason: "No ## Sub-Skills heading found",
    };
  }

  const newContent = regenerateCategorySkillMd(existingContent, categoryName, subSkills);

  if (!dryRun) {
    writeFileSync(skillMdPath, newContent, "utf-8");
  }

  return {
    category: categoryName,
    subSkills,
    written: !dryRun,
    skipped: false,
  };
}

// ============================================================================
// Command File Generation
// ============================================================================

const GENERATED_COMMAND_MARKER = "<!-- auto-generated by GenerateRoutingTables -->";

/**
 * Build the markdown content for an auto-generated command file.
 */
function buildCommandContent(
  commandName: string,
  skillName: string,
  categoryName: string,
  skillPath: string,
  description: string
): string {
  return [
    `# /${commandName} - ${skillName} (${categoryName})`,
    "",
    GENERATED_COMMAND_MARKER,
    "",
    description,
    "",
    "## Execution",
    "",
    `When this command is invoked, read and execute: \`~/.claude/skills/${skillPath}\``,
    "",
  ].join("\n");
}

/**
 * Detect hand-written (non-generated) command files that should not be overwritten.
 * A command is hand-written if it exists and does NOT contain the auto-generated marker.
 */
function isHandWrittenCommand(commandPath: string): boolean {
  if (!existsSync(commandPath)) return false;
  try {
    const content = readFileSync(commandPath, "utf-8");
    return !content.includes(GENERATED_COMMAND_MARKER);
  } catch {
    return true; // If we can't read it, don't overwrite
  }
}

/**
 * Generate Commands/*.md files for all sub-skills across all categories.
 * Skips hand-written command files. Returns results for each sub-skill.
 */
export function generateCommandFiles(
  categories: CategoryResult[],
  commandsDir: string = DEFAULT_COMMANDS_DIR,
  dryRun: boolean = false
): CommandResult[] {
  const results: CommandResult[] = [];

  for (const cat of categories) {
    if (cat.skipped) continue;

    for (const sub of cat.subSkills) {
      const commandName = sub.name.toLowerCase();
      const commandPath = join(commandsDir, `${commandName}.md`);

      if (isHandWrittenCommand(commandPath)) {
        results.push({
          name: commandName,
          skillPath: sub.path,
          written: false,
          skipped: true,
          reason: "Hand-written command exists",
        });
        continue;
      }

      const content = buildCommandContent(
        commandName,
        sub.name,
        cat.category,
        sub.path,
        sub.description
      );

      if (!dryRun) {
        writeFileSync(commandPath, content, "utf-8");
      }

      results.push({
        name: commandName,
        skillPath: sub.path,
        written: !dryRun,
        skipped: false,
      });
    }
  }

  return results;
}

// ============================================================================
// Full Generator
// ============================================================================

export interface GenerateOptions {
  skillsDir?: string;
  commandsDir?: string;
  dryRun?: boolean;
  /** When false, skip command file generation. Default: true. */
  commands?: boolean;
}

/**
 * Scan all directories in skillsDir and regenerate routing tables for every
 * category found. Optionally generates Commands/*.md files for each sub-skill.
 *
 * When dryRun is true, no files are written.
 */
export function generateAllRoutingTables(
  skillsDirOrOptions: string | GenerateOptions = DEFAULT_SKILLS_DIR,
  dryRun: boolean = false
): GenerateResult {
  // Support both legacy (string, boolean) and new (options object) signatures
  const opts: GenerateOptions =
    typeof skillsDirOrOptions === "string"
      ? { skillsDir: skillsDirOrOptions, dryRun }
      : skillsDirOrOptions;

  const skillsDir = opts.skillsDir ?? DEFAULT_SKILLS_DIR;
  const effectiveDryRun = opts.dryRun ?? dryRun;
  const generateCmds = opts.commands ?? true;
  const commandsDir = opts.commandsDir ?? DEFAULT_COMMANDS_DIR;

  const errors: string[] = [];
  const categories: CategoryResult[] = [];

  let topLevelEntries;
  try {
    topLevelEntries = readdirSync(skillsDir, { withFileTypes: true });
  } catch (err) {
    errors.push(
      `Cannot read skills directory "${skillsDir}": ${err instanceof Error ? err.message : String(err)}`
    );
    return { categories: [], totalSubSkills: 0, commands: [], errors };
  }

  const categoryNames = topLevelEntries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  for (const name of categoryNames) {
    const categoryPath = join(skillsDir, name);
    if (!isCategoryDir(categoryPath)) continue;

    const result = generateForCategory(name, skillsDir, effectiveDryRun);
    categories.push(result);
  }

  const totalSubSkills = categories.reduce(
    (sum, c) => sum + c.subSkills.length,
    0
  );

  const commands = generateCmds
    ? generateCommandFiles(categories, commandsDir, effectiveDryRun)
    : [];

  return { categories, totalSubSkills, commands, errors };
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      category: { type: "string", short: "c" },
      "dry-run": { type: "boolean", short: "n" },
      "no-commands": { type: "boolean" },
      "skills-dir": { type: "string", short: "d" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
GenerateRoutingTables - Regenerate Kaya skill category routing tables and slash commands

USAGE:
  bun lib/core/GenerateRoutingTables.ts                      # all categories + commands
  bun lib/core/GenerateRoutingTables.ts --category Life      # single category + commands
  bun lib/core/GenerateRoutingTables.ts --dry-run            # preview only
  bun lib/core/GenerateRoutingTables.ts --no-commands        # routing tables only
  bun lib/core/GenerateRoutingTables.ts --skills-dir /path   # override path

OPTIONS:
  -c, --category <name>   Process only this category
  -n, --dry-run           Compute changes without writing files
      --no-commands       Skip generating Commands/*.md slash command files
  -d, --skills-dir <path> Override default skills directory
  -h, --help              Show this help message

NOTES:
  - Preserves frontmatter and prose above ## Sub-Skills
  - Regenerates table from sub-directories that have SKILL.md
  - Auto-generates Commands/*.md for each sub-skill (skips hand-written commands)
  - Extracts triggers from description: USE WHEN clause in each sub-skill
  - Sorts sub-skills alphabetically
`);
    return;
  }

  const skillsDir = values["skills-dir"] ?? DEFAULT_SKILLS_DIR;
  const dryRun = values["dry-run"] ?? false;
  const noCommands = values["no-commands"] ?? false;

  if (!existsSync(skillsDir)) {
    console.error(`Error: skills directory not found: ${skillsDir}`);
    process.exit(1);
  }

  if (dryRun) {
    console.log("[dry-run] No files will be written.\n");
  }

  let result: GenerateResult;

  if (values.category) {
    const single = generateForCategory(values.category, skillsDir, dryRun);
    const commands = noCommands
      ? []
      : generateCommandFiles([single], DEFAULT_COMMANDS_DIR, dryRun);
    result = {
      categories: [single],
      totalSubSkills: single.subSkills.length,
      commands,
      errors: [],
    };
  } else {
    result = generateAllRoutingTables({
      skillsDir,
      dryRun,
      commands: !noCommands,
    });
  }

  // Report results
  for (const cat of result.categories) {
    if (cat.skipped) {
      console.log(`SKIP  ${cat.category}${cat.reason ? ` — ${cat.reason}` : ""}`);
    } else if (cat.written) {
      console.log(
        `OK    ${cat.category} — ${cat.subSkills.length} sub-skills: ${cat.subSkills.map((s) => s.name).join(", ")}`
      );
    } else {
      // dry-run
      console.log(
        `DRY   ${cat.category} — ${cat.subSkills.length} sub-skills would be written: ${cat.subSkills.map((s) => s.name).join(", ")}`
      );
    }
  }

  // Report command results
  if (result.commands.length > 0) {
    console.log("");
    const cmdWritten = result.commands.filter((c) => !c.skipped);
    const cmdSkipped = result.commands.filter((c) => c.skipped);
    for (const cmd of cmdWritten) {
      const verb = dryRun ? "DRY" : "CMD";
      console.log(`${verb}   /${cmd.name} → ${cmd.skillPath}`);
    }
    for (const cmd of cmdSkipped) {
      console.log(`SKIP  /${cmd.name} — ${cmd.reason}`);
    }
  }

  if (result.errors.length > 0) {
    console.error("\nErrors:");
    for (const e of result.errors) {
      console.error(`  ${e}`);
    }
  }

  const processed = result.categories.filter((c) => !c.skipped).length;
  const skipped = result.categories.filter((c) => c.skipped).length;
  const action = dryRun ? "would update" : "updated";
  const cmdCount = result.commands.filter((c) => !c.skipped).length;
  const cmdAction = dryRun ? "would generate" : "generated";

  console.log(
    `\nDone. ${action} ${processed} categories (${result.totalSubSkills} total sub-skills), skipped ${skipped}.` +
    (result.commands.length > 0 ? ` ${cmdAction} ${cmdCount} commands.` : "")
  );
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
