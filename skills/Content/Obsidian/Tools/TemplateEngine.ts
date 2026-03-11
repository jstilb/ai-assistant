#!/usr/bin/env bun
/**
 * TemplateEngine.ts - Restructure note content into template sections
 *
 * Takes a note and its detected template type, then reorganizes the content
 * into the template's section structure. Preserves ALL original text (zero data loss).
 *
 * Handles:
 * - Moving content to appropriate sections
 * - Mixed content types (use primary type)
 * - Very short notes (flag as stubs, minimal template)
 * - Already-structured notes (only add missing sections)
 * - Obsidian syntax preservation (wikilinks, embeds, callouts, Dataview, tasks, code blocks)
 *
 * CLI: bun TemplateEngine.ts --path "/path/to/note.md" --type recipe
 *      bun TemplateEngine.ts --path "/path/to/note.md" --type recipe --dry-run
 *      bun TemplateEngine.ts --path "/path/to/note.md" --type recipe --json
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, join, dirname, resolve } from "path";
import { loadTemplates, parseFrontmatter, type TemplateConfig } from "./NoteAnalyzer.ts";

// ============================================
// TYPES
// ============================================

export interface TransformResult {
  notePath: string;
  noteTitle: string;
  templateType: string;
  templateLabel: string;
  original: string;
  transformed: string;
  isStub: boolean;
  alreadyStructured: boolean;
  sectionsAdded: string[];
  sectionsExisting: string[];
  sectionsEmpty: string[];
  diff: string[];
  obsidianSyntaxPreserved: {
    wikilinks: number;
    embeds: number;
    callouts: number;
    codeBlocks: number;
    tasks: number;
    dataviewBlocks: number;
  };
}

// ============================================
// OBSIDIAN SYNTAX DETECTION
// ============================================

interface ObsidianSyntaxCount {
  wikilinks: number;
  embeds: number;
  callouts: number;
  codeBlocks: number;
  tasks: number;
  dataviewBlocks: number;
}

function countObsidianSyntax(content: string): ObsidianSyntaxCount {
  return {
    wikilinks: (content.match(/\[\[[^\]]+\]\]/g) || []).length,
    embeds: (content.match(/!\[\[[^\]]+\]\]/g) || []).length,
    callouts: (content.match(/^>\s*\[![^\]]+\]/gm) || []).length,
    codeBlocks: (content.match(/^```/gm) || []).length / 2, // pairs
    tasks: (content.match(/^-\s*\[[ x\/\-]\]/gm) || []).length,
    dataviewBlocks: (content.match(/^```dataview/gm) || []).length,
  };
}

function verifySyntaxPreservation(original: string, transformed: string): boolean {
  const origCounts = countObsidianSyntax(original);
  const transCounts = countObsidianSyntax(transformed);

  return (
    transCounts.wikilinks >= origCounts.wikilinks &&
    transCounts.embeds >= origCounts.embeds &&
    transCounts.callouts >= origCounts.callouts &&
    transCounts.codeBlocks >= origCounts.codeBlocks &&
    transCounts.tasks >= origCounts.tasks &&
    transCounts.dataviewBlocks >= origCounts.dataviewBlocks
  );
}

// ============================================
// SECTION EXTRACTION
// ============================================

interface Section {
  heading: string;
  level: number;
  content: string;
}

function extractSections(content: string): Section[] {
  const sections: Section[] = [];
  const lines = content.split("\n");
  let currentSection: Section | null = null;
  let contentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      // Save previous section
      if (currentSection) {
        currentSection.content = contentLines.join("\n").trim();
        sections.push(currentSection);
      }

      currentSection = {
        heading: headingMatch[2].trim(),
        level: headingMatch[1].length,
        content: "",
      };
      contentLines = [];
    } else {
      contentLines.push(line);
    }
  }

  // Save last section
  if (currentSection) {
    currentSection.content = contentLines.join("\n").trim();
    sections.push(currentSection);
  } else if (contentLines.length > 0) {
    // Content before any heading
    sections.push({
      heading: "_preamble",
      level: 0,
      content: contentLines.join("\n").trim(),
    });
  }

  return sections;
}

function findMatchingSection(
  existingHeading: string,
  templateSections: string[]
): string | null {
  const normalizedExisting = existingHeading.toLowerCase().trim();

  for (const templateSection of templateSections) {
    const normalizedTemplate = templateSection.toLowerCase().trim();

    // Exact match
    if (normalizedExisting === normalizedTemplate) return templateSection;

    // Partial match (existing heading contains template section name)
    if (normalizedExisting.includes(normalizedTemplate)) return templateSection;
    if (normalizedTemplate.includes(normalizedExisting)) return templateSection;
  }

  return null;
}

// ============================================
// TEMPLATE APPLICATION
// ============================================

function applyTemplate(
  bodyContent: string,
  template: TemplateConfig,
  isStub: boolean
): {
  output: string;
  sectionsAdded: string[];
  sectionsExisting: string[];
  sectionsEmpty: string[];
} {
  const allTemplateSections = [...template.requiredSections, ...template.optionalSections];
  const existingSections = extractSections(bodyContent);
  const sectionMap = new Map<string, string>();
  const unmappedContent: string[] = [];
  const sectionsExisting: string[] = [];

  // Map existing sections to template sections
  for (const section of existingSections) {
    if (section.heading === "_preamble") {
      // Preamble content goes to first required section or remains as-is
      if (section.content.trim()) {
        unmappedContent.push(section.content);
      }
      continue;
    }

    const match = findMatchingSection(section.heading, allTemplateSections);
    if (match) {
      const existing = sectionMap.get(match) || "";
      sectionMap.set(match, existing ? `${existing}\n\n${section.content}` : section.content);
      sectionsExisting.push(match);
    } else {
      // Keep unmatched sections and their content
      unmappedContent.push(`## ${section.heading}\n\n${section.content}`);
    }
  }

  // If there's unmapped content and no sections mapped yet, put it in first required section
  if (unmappedContent.length > 0 && sectionMap.size === 0) {
    const firstSection = template.requiredSections[0];
    sectionMap.set(firstSection, unmappedContent.join("\n\n"));
    unmappedContent.length = 0;
    sectionsExisting.push(firstSection);
  }

  // Build output with template sections
  const outputParts: string[] = [];
  const sectionsAdded: string[] = [];
  const sectionsEmpty: string[] = [];

  // For stubs, only add required sections
  const sectionsToInclude = isStub ? template.requiredSections : allTemplateSections;

  for (const sectionName of sectionsToInclude) {
    const content = sectionMap.get(sectionName);

    if (content && content.trim()) {
      outputParts.push(`## ${sectionName}\n\n${content}`);
    } else if (template.requiredSections.includes(sectionName)) {
      // Always add required sections (even empty)
      outputParts.push(`## ${sectionName}\n\n`);
      if (!sectionsExisting.includes(sectionName)) {
        sectionsAdded.push(sectionName);
        sectionsEmpty.push(sectionName);
      }
    } else if (sectionsExisting.includes(sectionName)) {
      // Add optional sections only if they existed
      outputParts.push(`## ${sectionName}\n\n${content || ""}`);
    }
    // Skip optional sections that didn't exist (don't add empty optional sections)
  }

  // Append unmapped content in a catch-all section
  if (unmappedContent.length > 0) {
    outputParts.push(`## Other\n\n${unmappedContent.join("\n\n")}`);
    sectionsAdded.push("Other");
  }

  // Track newly added sections
  for (const sectionName of template.requiredSections) {
    if (!sectionsExisting.includes(sectionName)) {
      if (!sectionsAdded.includes(sectionName)) {
        sectionsAdded.push(sectionName);
      }
    }
  }

  return {
    output: outputParts.join("\n\n"),
    sectionsAdded,
    sectionsExisting: [...new Set(sectionsExisting)],
    sectionsEmpty,
  };
}

// ============================================
// DIFF GENERATION
// ============================================

function generateDiff(original: string, transformed: string): string[] {
  const origLines = original.split("\n");
  const transLines = transformed.split("\n");
  const diff: string[] = [];

  // Simple line-level diff (not a full diff algorithm, but shows changes)
  const origSet = new Set(origLines.map((l) => l.trim()));
  const transSet = new Set(transLines.map((l) => l.trim()));

  for (const line of transLines) {
    const trimmed = line.trim();
    if (trimmed && !origSet.has(trimmed)) {
      diff.push(`+ ${line}`);
    }
  }

  for (const line of origLines) {
    const trimmed = line.trim();
    if (trimmed && !transSet.has(trimmed)) {
      diff.push(`- ${line}`);
    }
  }

  return diff;
}

// ============================================
// MAIN TRANSFORM
// ============================================

export function transformNote(
  notePath: string,
  templateType: string,
  options: { dryRun?: boolean } = {}
): TransformResult {
  const resolvedPath = resolve(notePath);

  if (!existsSync(resolvedPath)) {
    throw new Error(`Note not found: ${resolvedPath}`);
  }

  const rawContent = readFileSync(resolvedPath, "utf-8");
  const templates = loadTemplates();
  const template = templates.find((t) => t.type === templateType);

  if (!template) {
    const validTypes = templates.map((t) => t.type).join(", ");
    throw new Error(`Unknown template type: ${templateType}. Valid types: ${validTypes}`);
  }

  // Parse existing content
  const parsed = parseFrontmatter(rawContent);
  const bodyContent = parsed?.body || rawContent;
  const noteTitle = basename(resolvedPath, ".md");

  // Detect state
  const wordCount = bodyContent.split(/\s+/).filter((w) => w.length > 0).length;
  const isStub = wordCount < template.stubThreshold;
  const existingSections = extractSections(bodyContent);
  const alreadyStructured =
    existingSections.length >= template.requiredSections.length &&
    existingSections.some((s) =>
      template.requiredSections.some(
        (r) => s.heading.toLowerCase().includes(r.toLowerCase())
      )
    );

  // Apply template
  const { output, sectionsAdded, sectionsExisting, sectionsEmpty } = applyTemplate(
    bodyContent,
    template,
    isStub
  );

  // Build the title heading
  const titleHeading = `# ${noteTitle}\n\n`;

  // Reconstruct with frontmatter if it existed
  let transformed: string;
  if (parsed?.frontmatter) {
    // Keep existing frontmatter block intact
    const fmMatch = rawContent.match(/^---\n[\s\S]*?\n---\n/);
    const fmBlock = fmMatch ? fmMatch[0] : "";
    transformed = `${fmBlock}${titleHeading}${output}\n`;
  } else {
    transformed = `${titleHeading}${output}\n`;
  }

  // Verify syntax preservation
  const origSyntax = countObsidianSyntax(rawContent);
  const transSyntax = countObsidianSyntax(transformed);
  const syntaxOk = verifySyntaxPreservation(rawContent, transformed);

  if (!syntaxOk) {
    console.error(
      "WARNING: Obsidian syntax may have been lost during transformation. " +
      "Review the output carefully."
    );
  }

  // Generate diff
  const diff = generateDiff(rawContent, transformed);

  // Write if not dry-run
  if (!options.dryRun) {
    writeFileSync(resolvedPath, transformed);
  }

  return {
    notePath: resolvedPath,
    noteTitle,
    templateType: template.type,
    templateLabel: template.label,
    original: rawContent,
    transformed,
    isStub,
    alreadyStructured,
    sectionsAdded,
    sectionsExisting,
    sectionsEmpty,
    diff,
    obsidianSyntaxPreserved: transSyntax,
  };
}

// ============================================
// CLI
// ============================================

function printResult(result: TransformResult, jsonOutput: boolean, dryRun: boolean): void {
  if (jsonOutput) {
    // Don't include full content in JSON to keep it manageable
    const { original, transformed, ...summary } = result;
    console.log(JSON.stringify({ ...summary, dryRun }, null, 2));
    return;
  }

  console.log(`\n--- Template Transformation ---`);
  console.log(`Note:     ${result.noteTitle}`);
  console.log(`Template: ${result.templateLabel} (${result.templateType})`);
  console.log(`Stub:     ${result.isStub ? "Yes (minimal template applied)" : "No"}`);
  console.log(
    `Existing: ${result.alreadyStructured ? "Already structured (added missing sections only)" : "Restructured"}`
  );
  console.log(``);

  if (result.sectionsExisting.length > 0) {
    console.log(`Sections kept:   ${result.sectionsExisting.join(", ")}`);
  }
  if (result.sectionsAdded.length > 0) {
    console.log(`Sections added:  ${result.sectionsAdded.join(", ")}`);
  }
  if (result.sectionsEmpty.length > 0) {
    console.log(`Sections empty:  ${result.sectionsEmpty.join(", ")}`);
  }

  const syntax = result.obsidianSyntaxPreserved;
  const syntaxItems = [];
  if (syntax.wikilinks > 0) syntaxItems.push(`${syntax.wikilinks} wikilinks`);
  if (syntax.embeds > 0) syntaxItems.push(`${syntax.embeds} embeds`);
  if (syntax.callouts > 0) syntaxItems.push(`${syntax.callouts} callouts`);
  if (syntax.codeBlocks > 0) syntaxItems.push(`${syntax.codeBlocks} code blocks`);
  if (syntax.tasks > 0) syntaxItems.push(`${syntax.tasks} tasks`);
  if (syntax.dataviewBlocks > 0) syntaxItems.push(`${syntax.dataviewBlocks} dataview blocks`);

  if (syntaxItems.length > 0) {
    console.log(`\nObsidian syntax: ${syntaxItems.join(", ")}`);
  }

  if (dryRun) {
    console.log(`\n[DRY RUN - No changes written]`);
    if (result.diff.length > 0) {
      console.log(`\nDiff preview (${result.diff.length} changes):`);
      for (const line of result.diff.slice(0, 30)) {
        console.log(`  ${line}`);
      }
      if (result.diff.length > 30) {
        console.log(`  ... and ${result.diff.length - 30} more changes`);
      }
    }
  } else {
    console.log(`\n[WRITTEN to ${result.notePath}]`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let notePath = "";
  let templateType = "";
  let jsonOutput = false;
  let dryRun = true; // Default to dry-run for safety

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--path" && args[i + 1]) {
      notePath = args[i + 1];
      i++;
    } else if (args[i] === "--type" && args[i + 1]) {
      templateType = args[i + 1];
      i++;
    } else if (args[i] === "--json") {
      jsonOutput = true;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--write") {
      dryRun = false;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
TemplateEngine - Restructure note content into template sections

Usage:
  bun TemplateEngine.ts --path "/path/to/note.md" --type recipe
  bun TemplateEngine.ts --path "/path/to/note.md" --type recipe --write
  bun TemplateEngine.ts --path "/path/to/note.md" --type recipe --json

Options:
  --path <path>      Path to the note file (required)
  --type <type>      Template type to apply (required)
  --dry-run          Preview changes without writing (default)
  --write            Actually write changes to file
  --json             Output as JSON
  --help, -h         Show this help

Template types: learning, reference, recipe, journal, project, meeting,
                book, troubleshooting, concept-map, resource-list, lecture
`);
      process.exit(0);
    }
  }

  if (!notePath || !templateType) {
    console.error("Error: --path and --type are required. Use --help for usage.");
    process.exit(1);
  }

  const result = transformNote(notePath, templateType, { dryRun });
  printResult(result, jsonOutput, dryRun);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
