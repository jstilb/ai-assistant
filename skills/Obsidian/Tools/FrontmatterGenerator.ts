#!/usr/bin/env bun
/**
 * FrontmatterGenerator.ts - Generate and merge YAML frontmatter
 *
 * Extracts or generates YAML frontmatter fields for Obsidian notes:
 * - created, modified, type, status, tags, aliases, source, related
 * - Merges with existing frontmatter (preserve existing + add missing)
 * - Produces valid YAML that Obsidian parses correctly
 *
 * CLI: bun FrontmatterGenerator.ts --path "/path/to/note.md" --type recipe
 *      bun FrontmatterGenerator.ts --path "/path/to/note.md" --type recipe --tags "cooking,indian"
 *      bun FrontmatterGenerator.ts --path "/path/to/note.md" --type recipe --json
 */

import { existsSync, readFileSync, writeFileSync, statSync } from "fs";
import { basename, resolve } from "path";
import { loadTemplates, parseFrontmatter, type TemplateConfig } from "./NoteAnalyzer.ts";

// ============================================
// TYPES
// ============================================

export interface FrontmatterResult {
  notePath: string;
  noteTitle: string;
  templateType: string;
  existingFields: string[];
  addedFields: string[];
  mergedFrontmatter: Record<string, unknown>;
  yamlBlock: string;
  fullContent: string;
}

// ============================================
// FIELD EXTRACTION
// ============================================

function extractCreatedDate(
  content: string,
  notePath: string,
  existingFm: Record<string, unknown> | null
): string {
  // Priority: existing frontmatter > file stat > today
  if (existingFm?.created) return String(existingFm.created);

  try {
    const stat = statSync(notePath);
    return stat.birthtime.toISOString().split("T")[0];
  } catch {
    return new Date().toISOString().split("T")[0];
  }
}

function extractSource(content: string): string | null {
  // Look for URLs
  const urlMatch = content.match(/https?:\/\/[^\s\)]+/);
  if (urlMatch) return urlMatch[0];

  // Look for "Source:" or "From:" lines
  const sourceMatch = content.match(/(?:Source|From|Reference|URL):\s*(.+)/i);
  if (sourceMatch) return sourceMatch[1].trim();

  return null;
}

function extractAliases(content: string, noteTitle: string): string[] {
  const aliases: string[] = [];

  // Look for "Also known as" or "AKA" patterns
  const akaMatch = content.match(/(?:also known as|a\.?k\.?a\.?|alias(?:es)?)\s*[:=]\s*(.+)/i);
  if (akaMatch) {
    aliases.push(
      ...akaMatch[1]
        .split(/[,;]/)
        .map((a) => a.trim())
        .filter(Boolean)
    );
  }

  // If title has special characters, add a cleaned version
  const cleaned = noteTitle.replace(/[_-]/g, " ").trim();
  if (cleaned !== noteTitle && cleaned.length > 0) {
    aliases.push(cleaned);
  }

  return [...new Set(aliases)];
}

function extractRelated(content: string): string[] {
  // Extract wikilinks as related notes
  const wikilinks = content.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g) || [];
  const related = wikilinks
    .map((link) => {
      const match = link.match(/\[\[([^\]|]+)/);
      return match ? match[1].trim() : null;
    })
    .filter(Boolean) as string[];

  return [...new Set(related)].slice(0, 10); // Limit to 10
}

function inferStatus(content: string, wordCount: number): string {
  if (wordCount < 50) return "stub";

  // Check for completion indicators
  const lowerContent = content.toLowerCase();
  if (lowerContent.includes("archived") || lowerContent.includes("[archived]")) return "archived";
  if (lowerContent.includes("completed") || lowerContent.includes("[complete]")) return "complete";
  if (lowerContent.includes("in progress") || lowerContent.includes("wip") || lowerContent.includes("[in-progress]"))
    return "in-progress";

  // Check for TODO items -- many incomplete = draft
  const totalTodos = (content.match(/- \[ \]/g) || []).length;
  const completedTodos = (content.match(/- \[x\]/g) || []).length;
  if (totalTodos > 0 && completedTodos / totalTodos < 0.5) return "in-progress";

  return "complete";
}

// ============================================
// YAML GENERATION
// ============================================

function toYamlValue(value: unknown): string {
  if (value === null || value === undefined) return '""';

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    // Use inline array for short lists
    if (value.length <= 5 && value.every((v) => typeof v === "string" && v.length < 30)) {
      return `[${value.map((v) => quoteYamlString(String(v))).join(", ")}]`;
    }
    // Use block array for longer lists
    return "\n" + value.map((v) => `  - ${quoteYamlString(String(v))}`).join("\n");
  }

  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return quoteYamlString(value);

  return String(value);
}

function quoteYamlString(str: string): string {
  // Don't quote dates, booleans, numbers
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  if (str === "true" || str === "false") return str;
  if (/^\d+(\.\d+)?$/.test(str)) return str;

  // Quote strings that contain special YAML chars
  if (/[:{}\[\],&*?|>!%@`#]/.test(str) || str.includes('"') || str.includes("'")) {
    return `"${str.replace(/"/g, '\\"')}"`;
  }

  // Quote strings that look like they might confuse YAML
  if (str.startsWith("-") || str.startsWith(" ") || str.endsWith(" ")) {
    return `"${str}"`;
  }

  return str;
}

function generateYamlBlock(fm: Record<string, unknown>): string {
  const lines: string[] = ["---"];

  // Define field order for readability
  const fieldOrder = [
    "created",
    "modified",
    "type",
    "status",
    "tags",
    "aliases",
    "source",
    "related",
    // Template-specific fields come after
  ];

  // Add ordered fields first
  const addedFields = new Set<string>();
  for (const field of fieldOrder) {
    if (fm[field] !== undefined && fm[field] !== null) {
      const val = toYamlValue(fm[field]);
      if (val.startsWith("\n")) {
        lines.push(`${field}:${val}`);
      } else {
        lines.push(`${field}: ${val}`);
      }
      addedFields.add(field);
    }
  }

  // Add remaining fields
  for (const [key, value] of Object.entries(fm)) {
    if (!addedFields.has(key) && value !== undefined && value !== null) {
      const val = toYamlValue(value);
      if (val.startsWith("\n")) {
        lines.push(`${key}:${val}`);
      } else {
        lines.push(`${key}: ${val}`);
      }
    }
  }

  lines.push("---");
  return lines.join("\n");
}

// ============================================
// MAIN GENERATION
// ============================================

export function generateFrontmatter(
  notePath: string,
  templateType: string,
  options: {
    tags?: string[];
    dryRun?: boolean;
  } = {}
): FrontmatterResult {
  const resolvedPath = resolve(notePath);

  if (!existsSync(resolvedPath)) {
    throw new Error(`Note not found: ${resolvedPath}`);
  }

  const rawContent = readFileSync(resolvedPath, "utf-8");
  const templates = loadTemplates();
  const template = templates.find((t) => t.type === templateType);

  if (!template) {
    throw new Error(`Unknown template type: ${templateType}`);
  }

  // Parse existing frontmatter
  const parsed = parseFrontmatter(rawContent);
  const existingFm = parsed?.frontmatter || {};
  const bodyContent = parsed?.body || rawContent;
  const noteTitle = basename(resolvedPath, ".md");
  const wordCount = bodyContent.split(/\s+/).filter((w) => w.length > 0).length;

  // Track what fields exist vs are added
  const existingFields = Object.keys(existingFm);
  const addedFields: string[] = [];

  // Build merged frontmatter (existing fields preserved, new fields added)
  const merged: Record<string, unknown> = { ...existingFm };

  // Required fields
  if (!merged.created) {
    merged.created = extractCreatedDate(bodyContent, resolvedPath, existingFm as Record<string, unknown>);
    addedFields.push("created");
  }

  merged.modified = new Date().toISOString().split("T")[0];
  if (!existingFields.includes("modified")) addedFields.push("modified");

  if (!merged.type) {
    merged.type = templateType;
    addedFields.push("type");
  }

  if (!merged.status) {
    merged.status = inferStatus(bodyContent, wordCount);
    addedFields.push("status");
  }

  // Tags -- merge existing with provided
  const existingTags = Array.isArray(merged.tags)
    ? (merged.tags as string[])
    : merged.tags
      ? [String(merged.tags)]
      : [];
  const providedTags = options.tags || [];
  const allTags = [...new Set([...existingTags, ...providedTags])];
  if (allTags.length > 0) {
    merged.tags = allTags;
    if (!existingFields.includes("tags")) addedFields.push("tags");
  }

  // Optional fields
  if (!merged.aliases) {
    const aliases = extractAliases(bodyContent, noteTitle);
    if (aliases.length > 0) {
      merged.aliases = aliases;
      addedFields.push("aliases");
    }
  }

  if (!merged.source) {
    const source = extractSource(bodyContent);
    if (source) {
      merged.source = source;
      addedFields.push("source");
    }
  }

  if (!merged.related) {
    const related = extractRelated(bodyContent);
    if (related.length > 0) {
      merged.related = related;
      addedFields.push("related");
    }
  }

  // Generate YAML block
  const yamlBlock = generateYamlBlock(merged);

  // Build full content
  const fullContent = `${yamlBlock}\n${bodyContent}`;

  // Write if not dry-run
  if (!options.dryRun) {
    writeFileSync(resolvedPath, fullContent);
  }

  return {
    notePath: resolvedPath,
    noteTitle,
    templateType,
    existingFields,
    addedFields,
    mergedFrontmatter: merged,
    yamlBlock,
    fullContent,
  };
}

// ============================================
// CLI
// ============================================

function printResult(result: FrontmatterResult, jsonOutput: boolean, dryRun: boolean): void {
  if (jsonOutput) {
    const { fullContent, ...summary } = result;
    console.log(JSON.stringify({ ...summary, dryRun }, null, 2));
    return;
  }

  console.log(`\n--- Frontmatter Generation ---`);
  console.log(`Note:     ${result.noteTitle}`);
  console.log(`Type:     ${result.templateType}`);
  console.log(``);

  if (result.existingFields.length > 0) {
    console.log(`Existing fields: ${result.existingFields.join(", ")}`);
  }
  if (result.addedFields.length > 0) {
    console.log(`Added fields:    ${result.addedFields.join(", ")}`);
  }
  console.log(``);
  console.log(`Generated YAML:`);
  console.log(result.yamlBlock);

  if (dryRun) {
    console.log(`\n[DRY RUN - No changes written]`);
  } else {
    console.log(`\n[WRITTEN to ${result.notePath}]`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let notePath = "";
  let templateType = "";
  let tags: string[] = [];
  let jsonOutput = false;
  let dryRun = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--path" && args[i + 1]) {
      notePath = args[i + 1];
      i++;
    } else if (args[i] === "--type" && args[i + 1]) {
      templateType = args[i + 1];
      i++;
    } else if (args[i] === "--tags" && args[i + 1]) {
      tags = args[i + 1].split(",").map((t) => t.trim());
      i++;
    } else if (args[i] === "--json") {
      jsonOutput = true;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--write") {
      dryRun = false;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
FrontmatterGenerator - Generate and merge YAML frontmatter

Usage:
  bun FrontmatterGenerator.ts --path "/path/to/note.md" --type recipe
  bun FrontmatterGenerator.ts --path "/path/to/note.md" --type recipe --tags "cooking,indian"
  bun FrontmatterGenerator.ts --path "/path/to/note.md" --type recipe --write

Options:
  --path <path>      Path to the note file (required)
  --type <type>      Template type (required)
  --tags <tags>      Comma-separated tags to add
  --dry-run          Preview changes without writing (default)
  --write            Actually write changes to file
  --json             Output as JSON
  --help, -h         Show this help
`);
      process.exit(0);
    }
  }

  if (!notePath || !templateType) {
    console.error("Error: --path and --type are required. Use --help for usage.");
    process.exit(1);
  }

  const result = generateFrontmatter(notePath, templateType, { tags, dryRun });
  printResult(result, jsonOutput, dryRun);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
