#!/usr/bin/env bun
/**
 * QualityValidator.ts - Score transformed notes against template criteria
 *
 * Validates transformed notes by checking:
 * - Required sections present
 * - Frontmatter completeness
 * - No broken wikilinks introduced
 * - Overall template completeness score (0-100)
 * - Flags: missing sections, empty sections, suspected data loss
 *
 * CLI: bun QualityValidator.ts --path "/path/to/note.md"
 *      bun QualityValidator.ts --path "/path/to/note.md" --type recipe
 *      bun QualityValidator.ts --path "/path/to/note.md" --json
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { basename, resolve, join } from "path";
import { loadTemplates, parseFrontmatter, type TemplateConfig } from "./NoteAnalyzer.ts";

// ============================================
// TYPES
// ============================================

export interface ValidationIssue {
  severity: "error" | "warning" | "info";
  category: string;
  message: string;
}

export interface ValidationResult {
  notePath: string;
  noteTitle: string;
  templateType: string;
  templateLabel: string;
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  issues: ValidationIssue[];
  checks: {
    requiredSections: { present: string[]; missing: string[] };
    optionalSections: { present: string[]; missing: string[] };
    frontmatter: { present: string[]; missing: string[] };
    wikilinks: { total: number; potentiallyBroken: number };
    obsidianSyntax: {
      wikilinks: number;
      embeds: number;
      callouts: number;
      codeBlocks: number;
      tasks: number;
    };
    contentMetrics: {
      wordCount: number;
      headingCount: number;
      emptyH2Sections: number;
      hasTitle: boolean;
    };
  };
}

// ============================================
// VAULT HELPERS
// ============================================

const VAULT_PATH = "~/obsidian/";

function getVaultNoteNames(vaultPath: string): Set<string> {
  const names = new Set<string>();

  function walkDir(dir: string): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.name.endsWith(".md")) {
          names.add(entry.name.replace(".md", ""));
        }
      }
    } catch {
      // Permission denied or other error
    }
  }

  if (existsSync(vaultPath)) {
    walkDir(vaultPath);
  }

  return names;
}

// ============================================
// VALIDATION CHECKS
// ============================================

function extractH2Sections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  const regex = /^## (.+)$/gm;
  let match;
  const positions: Array<{ name: string; start: number }> = [];

  while ((match = regex.exec(content)) !== null) {
    positions.push({ name: match[1].trim(), start: match.index + match[0].length });
  }

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].start;
    const end = i + 1 < positions.length ? positions[i + 1].start - positions[i + 1].name.length - 4 : content.length;
    const sectionContent = content.slice(start, end).trim();
    sections.set(positions[i].name, sectionContent);
  }

  return sections;
}

function checkRequiredSections(
  content: string,
  template: TemplateConfig
): { present: string[]; missing: string[] } {
  const sections = extractH2Sections(content);
  const present: string[] = [];
  const missing: string[] = [];

  for (const required of template.requiredSections) {
    const found = Array.from(sections.keys()).some(
      (s) => s.toLowerCase() === required.toLowerCase()
    );
    if (found) {
      present.push(required);
    } else {
      missing.push(required);
    }
  }

  return { present, missing };
}

function checkOptionalSections(
  content: string,
  template: TemplateConfig
): { present: string[]; missing: string[] } {
  const sections = extractH2Sections(content);
  const present: string[] = [];
  const missing: string[] = [];

  for (const optional of template.optionalSections) {
    const found = Array.from(sections.keys()).some(
      (s) => s.toLowerCase() === optional.toLowerCase()
    );
    if (found) {
      present.push(optional);
    } else {
      missing.push(optional);
    }
  }

  return { present, missing };
}

function checkFrontmatter(
  content: string,
  template: TemplateConfig
): { present: string[]; missing: string[] } {
  const parsed = parseFrontmatter(content);
  const fm = parsed?.frontmatter || {};
  const present: string[] = [];
  const missing: string[] = [];

  for (const field of template.frontmatterFields.required) {
    if (fm[field] !== undefined && fm[field] !== null && fm[field] !== "") {
      present.push(field);
    } else {
      missing.push(field);
    }
  }

  return { present, missing };
}

function checkWikilinks(
  content: string,
  vaultNoteNames: Set<string>
): { total: number; potentiallyBroken: number } {
  const wikilinks = content.match(/\[\[([^\]|#]+)/g) || [];
  let total = 0;
  let potentiallyBroken = 0;

  for (const link of wikilinks) {
    const noteName = link.replace("[[", "").trim();
    total++;
    if (vaultNoteNames.size > 0 && !vaultNoteNames.has(noteName)) {
      potentiallyBroken++;
    }
  }

  return { total, potentiallyBroken };
}

function countEmptyH2Sections(content: string): number {
  const sections = extractH2Sections(content);
  let empty = 0;

  for (const [, sectionContent] of sections) {
    if (!sectionContent || sectionContent.trim().length === 0) {
      empty++;
    }
  }

  return empty;
}

// ============================================
// SCORING
// ============================================

function calculateScore(
  requiredSections: { present: string[]; missing: string[] },
  optionalSections: { present: string[]; missing: string[] },
  frontmatter: { present: string[]; missing: string[] },
  emptyH2Sections: number,
  contentMetrics: { wordCount: number; headingCount: number; hasTitle: boolean }
): number {
  let score = 0;

  // Required sections (40 points)
  const totalRequired = requiredSections.present.length + requiredSections.missing.length;
  if (totalRequired > 0) {
    score += (requiredSections.present.length / totalRequired) * 40;
  } else {
    score += 40; // No required sections means this check passes
  }

  // Frontmatter completeness (25 points)
  const totalFmFields = frontmatter.present.length + frontmatter.missing.length;
  if (totalFmFields > 0) {
    score += (frontmatter.present.length / totalFmFields) * 25;
  } else {
    score += 25;
  }

  // Optional sections presence (15 points)
  const totalOptional = optionalSections.present.length + optionalSections.missing.length;
  if (totalOptional > 0) {
    score += (optionalSections.present.length / totalOptional) * 15;
  }

  // Content quality (10 points)
  if (contentMetrics.wordCount > 100) score += 5;
  else if (contentMetrics.wordCount > 50) score += 3;
  if (contentMetrics.hasTitle) score += 5;

  // Penalty for empty sections (-2 per empty section, up to -10)
  score -= Math.min(emptyH2Sections * 2, 10);

  return Math.max(0, Math.min(100, Math.round(score)));
}

function scoreToGrade(score: number): "A" | "B" | "C" | "D" | "F" {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

// ============================================
// MAIN VALIDATION
// ============================================

export function validateNote(
  notePath: string,
  templateType?: string,
  options: { vaultPath?: string } = {}
): ValidationResult {
  const resolvedPath = resolve(notePath);
  const vaultPath = options.vaultPath || VAULT_PATH;

  if (!existsSync(resolvedPath)) {
    throw new Error(`Note not found: ${resolvedPath}`);
  }

  const content = readFileSync(resolvedPath, "utf-8");
  const templates = loadTemplates();
  const noteTitle = basename(resolvedPath, ".md");

  // Determine template type from frontmatter or argument
  const parsed = parseFrontmatter(content);
  const fmType = parsed?.frontmatter?.type as string | undefined;
  const detectedType = templateType || fmType;

  if (!detectedType) {
    throw new Error(
      "No template type specified. Use --type or ensure frontmatter has a 'type' field."
    );
  }

  const template = templates.find((t) => t.type === detectedType);
  if (!template) {
    throw new Error(`Unknown template type: ${detectedType}`);
  }

  // Run checks
  const requiredSections = checkRequiredSections(content, template);
  const optionalSections = checkOptionalSections(content, template);
  const frontmatter = checkFrontmatter(content, template);
  const vaultNoteNames = getVaultNoteNames(vaultPath);
  const wikilinks = checkWikilinks(content, vaultNoteNames);
  const emptyH2 = countEmptyH2Sections(content);

  // Content metrics
  const wordCount = content.split(/\s+/).filter((w) => w.length > 0).length;
  const headingCount = (content.match(/^#{1,6}\s+/gm) || []).length;
  const hasTitle = /^# .+$/m.test(content);

  // Count Obsidian syntax
  const obsidianSyntax = {
    wikilinks: (content.match(/\[\[[^\]]+\]\]/g) || []).length,
    embeds: (content.match(/!\[\[[^\]]+\]\]/g) || []).length,
    callouts: (content.match(/^>\s*\[![^\]]+\]/gm) || []).length,
    codeBlocks: Math.floor(((content.match(/^```/gm) || []).length) / 2),
    tasks: (content.match(/^-\s*\[[ x\/\-]\]/gm) || []).length,
  };

  // Calculate score
  const contentMetrics = { wordCount, headingCount, emptyH2Sections: emptyH2, hasTitle };
  const score = calculateScore(
    requiredSections,
    optionalSections,
    frontmatter,
    emptyH2,
    contentMetrics
  );
  const grade = scoreToGrade(score);

  // Build issues list
  const issues: ValidationIssue[] = [];

  for (const section of requiredSections.missing) {
    issues.push({
      severity: "error",
      category: "structure",
      message: `Missing required section: ${section}`,
    });
  }

  for (const field of frontmatter.missing) {
    issues.push({
      severity: "error",
      category: "frontmatter",
      message: `Missing required frontmatter field: ${field}`,
    });
  }

  if (wikilinks.potentiallyBroken > 0) {
    issues.push({
      severity: "warning",
      category: "links",
      message: `${wikilinks.potentiallyBroken} potentially broken wikilink(s) detected`,
    });
  }

  if (emptyH2 > 0) {
    issues.push({
      severity: "warning",
      category: "content",
      message: `${emptyH2} empty section(s) detected`,
    });
  }

  if (!hasTitle) {
    issues.push({
      severity: "info",
      category: "structure",
      message: "No H1 title heading found",
    });
  }

  if (wordCount < 50) {
    issues.push({
      severity: "info",
      category: "content",
      message: `Very short note (${wordCount} words) - may be a stub`,
    });
  }

  return {
    notePath: resolvedPath,
    noteTitle,
    templateType: template.type,
    templateLabel: template.label,
    score,
    grade,
    issues,
    checks: {
      requiredSections,
      optionalSections,
      frontmatter,
      wikilinks,
      obsidianSyntax,
      contentMetrics,
    },
  };
}

// ============================================
// CLI
// ============================================

function printResult(result: ValidationResult, jsonOutput: boolean): void {
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\n--- Quality Validation ---`);
  console.log(`Note:     ${result.noteTitle}`);
  console.log(`Template: ${result.templateLabel} (${result.templateType})`);
  console.log(`Score:    ${result.score}/100 [${result.grade}]`);
  console.log(``);

  // Required sections
  const req = result.checks.requiredSections;
  console.log(`Required Sections:`);
  for (const s of req.present) console.log(`  [OK] ${s}`);
  for (const s of req.missing) console.log(`  [MISSING] ${s}`);

  // Frontmatter
  const fm = result.checks.frontmatter;
  console.log(`\nFrontmatter:`);
  for (const f of fm.present) console.log(`  [OK] ${f}`);
  for (const f of fm.missing) console.log(`  [MISSING] ${f}`);

  // Wikilinks
  const wl = result.checks.wikilinks;
  if (wl.total > 0) {
    console.log(
      `\nWikilinks: ${wl.total} total, ${wl.potentiallyBroken} potentially broken`
    );
  }

  // Content metrics
  const cm = result.checks.contentMetrics;
  console.log(
    `\nContent: ${cm.wordCount} words, ${cm.headingCount} headings, ${cm.emptyH2Sections} empty sections`
  );

  // Obsidian syntax
  const obs = result.checks.obsidianSyntax;
  const syntaxItems: string[] = [];
  if (obs.wikilinks > 0) syntaxItems.push(`${obs.wikilinks} wikilinks`);
  if (obs.embeds > 0) syntaxItems.push(`${obs.embeds} embeds`);
  if (obs.callouts > 0) syntaxItems.push(`${obs.callouts} callouts`);
  if (obs.codeBlocks > 0) syntaxItems.push(`${obs.codeBlocks} code blocks`);
  if (obs.tasks > 0) syntaxItems.push(`${obs.tasks} tasks`);
  if (syntaxItems.length > 0) {
    console.log(`Obsidian syntax: ${syntaxItems.join(", ")}`);
  }

  // Issues
  if (result.issues.length > 0) {
    console.log(`\nIssues (${result.issues.length}):`);
    for (const issue of result.issues) {
      const icon =
        issue.severity === "error" ? "ERROR" : issue.severity === "warning" ? "WARN" : "INFO";
      console.log(`  [${icon}] ${issue.message}`);
    }
  } else {
    console.log(`\nNo issues found.`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let notePath = "";
  let templateType = "";
  let jsonOutput = false;
  let vaultPath = VAULT_PATH;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--path" && args[i + 1]) {
      notePath = args[i + 1];
      i++;
    } else if (args[i] === "--type" && args[i + 1]) {
      templateType = args[i + 1];
      i++;
    } else if (args[i] === "--json") {
      jsonOutput = true;
    } else if (args[i] === "--vault" && args[i + 1]) {
      vaultPath = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
QualityValidator - Score transformed notes against template criteria

Usage:
  bun QualityValidator.ts --path "/path/to/note.md"
  bun QualityValidator.ts --path "/path/to/note.md" --type recipe
  bun QualityValidator.ts --path "/path/to/note.md" --json

Options:
  --path <path>      Path to the note file (required)
  --type <type>      Template type (auto-detected from frontmatter if not specified)
  --vault <path>     Override vault path for wikilink checking
  --json             Output as JSON
  --help, -h         Show this help
`);
      process.exit(0);
    }
  }

  if (!notePath) {
    console.error("Error: --path is required. Use --help for usage.");
    process.exit(1);
  }

  const result = validateNote(notePath, templateType || undefined, { vaultPath });
  printResult(result, jsonOutput);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
