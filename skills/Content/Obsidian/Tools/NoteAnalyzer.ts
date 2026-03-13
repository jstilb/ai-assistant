#!/usr/bin/env bun
/**
 * NoteAnalyzer.ts - Classify Obsidian notes into template types
 *
 * Reads note content and classifies it into one of 11+ template types using:
 * 1. Content signal detection (keywords, patterns)
 * 2. Folder context boosting
 * 3. Existing frontmatter detection
 * 4. Fast inference for ambiguous cases
 *
 * Confidence scoring:
 *   High (>0.85): Auto-apply template
 *   Medium (0.6-0.85): Suggest, ask confirm
 *   Low (<0.6): Show top 3 options, ask user
 *
 * CLI: bun NoteAnalyzer.ts --path "/path/to/note.md"
 *      bun NoteAnalyzer.ts --path "/path/to/note.md" --json
 *      bun NoteAnalyzer.ts --path "/path/to/note.md" --use-inference
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { inference } from "../../../../lib/core/Inference.ts";

// ============================================
// TYPES
// ============================================

export interface TemplateConfig {
  type: string;
  label: string;
  description: string;
  requiredSections: string[];
  optionalSections: string[];
  frontmatterFields: {
    required: string[];
    optional: string[];
  };
  signals: {
    keywords: string[];
    contentPatterns?: string[];
    folderBias: string[];
  };
  stubThreshold: number;
  version: number;
}

export interface AnalysisResult {
  notePath: string;
  noteTitle: string;
  detectedType: string;
  detectedLabel: string;
  confidence: number;
  confidenceLevel: "high" | "medium" | "low";
  scores: Record<string, number>;
  topCandidates: Array<{ type: string; label: string; score: number }>;
  signals: {
    keywordMatches: Record<string, string[]>;
    patternMatches: Record<string, string[]>;
    folderMatch: string | null;
    existingFrontmatter: Record<string, unknown> | null;
    existingType: string | null;
  };
  isStub: boolean;
  wordCount: number;
  hasExistingStructure: boolean;
}

// ============================================
// TEMPLATE LOADING
// ============================================

const TEMPLATES_DIR = join(dirname(import.meta.dir), "Templates");

export function loadTemplates(): TemplateConfig[] {
  const templates: TemplateConfig[] = [];

  if (!existsSync(TEMPLATES_DIR)) {
    throw new Error(`Templates directory not found: ${TEMPLATES_DIR}`);
  }

  const files = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    const content = readFileSync(join(TEMPLATES_DIR, file), "utf-8");
    try {
      templates.push(JSON.parse(content));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse template file "${file}": ${message}`);
    }
  }

  return templates;
}

// ============================================
// FRONTMATTER PARSING
// ============================================

export function parseFrontmatter(
  content: string
): { frontmatter: Record<string, unknown>; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const yamlBlock = match[1];
  const body = match[2];

  // Simple YAML parser for frontmatter (handles common cases)
  const frontmatter: Record<string, unknown> = {};
  const lines = yamlBlock.split("\n");

  for (const line of lines) {
    const kvMatch = line.match(/^(\w[\w_-]*):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      let value: unknown = kvMatch[2].trim();

      // Handle arrays in bracket notation: [tag1, tag2]
      if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
        value = value
          .slice(1, -1)
          .split(",")
          .map((v) => v.trim().replace(/^["']|["']$/g, ""));
      }
      // Handle quoted strings
      else if (typeof value === "string" && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      // Handle numbers
      else if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) {
        value = parseFloat(value);
      }
      // Handle booleans
      else if (value === "true") value = true;
      else if (value === "false") value = false;

      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

// ============================================
// CONTENT ANALYSIS
// ============================================

function countWords(text: string): number {
  return text
    .replace(/```[\s\S]*?```/g, "") // exclude code blocks
    .replace(/---[\s\S]*?---/g, "") // exclude frontmatter
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

function extractFolderName(notePath: string, vaultPath: string): string | null {
  const relativePath = notePath.replace(vaultPath, "").replace(/^\//, "");
  const parts = relativePath.split("/");
  return parts.length > 1 ? parts[0] : null;
}

function hasExistingStructure(content: string): boolean {
  const headingCount = (content.match(/^##\s+/gm) || []).length;
  const hasFrontmatter = content.startsWith("---");
  return headingCount >= 2 && hasFrontmatter;
}

function scoreTemplate(
  content: string,
  bodyContent: string,
  template: TemplateConfig,
  folderName: string | null,
  existingType: string | null
): { score: number; keywordMatches: string[]; patternMatches: string[] } {
  let score = 0;
  const keywordMatches: string[] = [];
  const patternMatches: string[] = [];
  const lowerContent = bodyContent.toLowerCase();

  // 1. Keyword matching (up to 0.45)
  // Uses ratio of matched keywords + density bonus for 3+ matches
  const totalKeywords = template.signals.keywords.length;
  let matchedKeywords = 0;
  for (const keyword of template.signals.keywords) {
    if (lowerContent.includes(keyword.toLowerCase())) {
      matchedKeywords++;
      keywordMatches.push(keyword);
    }
  }
  const keywordRatio = totalKeywords > 0 ? matchedKeywords / totalKeywords : 0;
  let keywordScore = keywordRatio * 0.35;
  // Density bonus: 3+ keyword matches = extra boost (strong signal)
  if (matchedKeywords >= 5) keywordScore += 0.10;
  else if (matchedKeywords >= 3) keywordScore += 0.05;
  score += Math.min(keywordScore, 0.45);

  // 2. Content pattern matching (up to 0.2)
  if (template.signals.contentPatterns) {
    const totalPatterns = template.signals.contentPatterns.length;
    let matchedPatterns = 0;
    for (const pattern of template.signals.contentPatterns) {
      if (content.includes(pattern)) {
        matchedPatterns++;
        patternMatches.push(pattern);
      }
    }
    const patternScore = totalPatterns > 0 ? (matchedPatterns / totalPatterns) * 0.2 : 0;
    score += patternScore;
  }

  // 3. Folder context boosting (up to 0.30)
  // Folder is a very strong signal in a well-organized vault
  if (folderName && template.signals.folderBias.includes(folderName)) {
    score += 0.30;
  }

  // 4. Existing frontmatter type match (strong boost)
  if (existingType) {
    if (existingType.toLowerCase() === template.type.toLowerCase()) {
      score = Math.max(score, 0.75); // Existing type is authoritative
    }
  }

  return { score, keywordMatches, patternMatches };
}

// ============================================
// INFERENCE FALLBACK
// ============================================

async function classifyWithInference(
  content: string,
  templateTypes: string[]
): Promise<{ type: string; confidence: number } | null> {
  const systemPrompt = `You are a note classifier. Given note content, classify it into exactly one of these types: ${templateTypes.join(", ")}. Respond with JSON only: {"type": "<type>", "confidence": <0.0-1.0>}`;

  // Truncate content to first 2000 chars for speed
  const truncated = content.slice(0, 2000);

  const result = await inference({
    systemPrompt,
    userPrompt: `Classify this note:\n\n${truncated}`,
    level: "fast",
    expectJson: true,
    timeout: 15000,
  });

  if (result.success && result.parsed) {
    const parsed = result.parsed as { type: string; confidence: number };
    if (parsed.type && typeof parsed.confidence === "number") {
      return parsed;
    }
  }

  return null;
}

// ============================================
// MAIN ANALYSIS
// ============================================

const VAULT_PATH = "/Users/[user]/Desktop/obsidian/";

export async function analyzeNote(
  notePath: string,
  options: { useInference?: boolean; vaultPath?: string } = {}
): Promise<AnalysisResult> {
  const vaultPath = options.vaultPath || VAULT_PATH;
  const resolvedPath = resolve(notePath);

  if (!existsSync(resolvedPath)) {
    throw new Error(`Note not found: ${resolvedPath}`);
  }

  const rawContent = readFileSync(resolvedPath, "utf-8");
  const templates = loadTemplates();

  // Parse frontmatter
  const parsed = parseFrontmatter(rawContent);
  const frontmatter = parsed?.frontmatter || null;
  const bodyContent = parsed?.body || rawContent;
  const existingType = frontmatter?.type as string | null;

  // Extract metadata
  const folderName = extractFolderName(resolvedPath, vaultPath);
  const wordCount = countWords(rawContent);
  const noteTitle = basename(resolvedPath, ".md");
  const isStub = wordCount < 50;
  const existingStructure = hasExistingStructure(rawContent);

  // Score all templates
  const scores: Record<string, number> = {};
  const signalDetails: Record<string, { keywordMatches: string[]; patternMatches: string[] }> = {};

  for (const template of templates) {
    const result = scoreTemplate(rawContent, bodyContent, template, folderName, existingType as string | null);
    scores[template.type] = result.score;
    signalDetails[template.type] = {
      keywordMatches: result.keywordMatches,
      patternMatches: result.patternMatches,
    };
  }

  // Sort by score
  const sorted = Object.entries(scores).sort(([, a], [, b]) => b - a);
  const topType = sorted[0][0];
  let topScore = sorted[0][1];

  // If scores are very close and useInference is enabled, use AI
  if (options.useInference && topScore < 0.6) {
    const aiResult = await classifyWithInference(
      bodyContent,
      templates.map((t) => t.type)
    );
    if (aiResult && scores[aiResult.type] !== undefined) {
      // Blend AI confidence with heuristic score
      scores[aiResult.type] = Math.min(1.0, scores[aiResult.type] + aiResult.confidence * 0.3);
      topScore = Math.max(...Object.values(scores));
    }
  }

  // Re-sort after potential inference boost
  const finalSorted = Object.entries(scores).sort(([, a], [, b]) => b - a);
  const finalType = finalSorted[0][0];
  const finalScore = finalSorted[0][1];

  // Determine confidence level
  const confidenceLevel: "high" | "medium" | "low" =
    finalScore > 0.85 ? "high" : finalScore >= 0.6 ? "medium" : "low";

  // Build top candidates
  const topCandidates = finalSorted.slice(0, 3).map(([type, score]) => {
    const template = templates.find((t) => t.type === type)!;
    return { type, label: template.label, score: Math.round(score * 100) / 100 };
  });

  // Build keyword/pattern match maps for top candidates
  const keywordMatches: Record<string, string[]> = {};
  const patternMatches: Record<string, string[]> = {};
  for (const candidate of topCandidates) {
    const details = signalDetails[candidate.type];
    if (details) {
      keywordMatches[candidate.type] = details.keywordMatches;
      patternMatches[candidate.type] = details.patternMatches;
    }
  }

  const matchedTemplate = templates.find((t) => t.type === finalType)!;

  return {
    notePath: resolvedPath,
    noteTitle,
    detectedType: finalType,
    detectedLabel: matchedTemplate.label,
    confidence: Math.round(finalScore * 100) / 100,
    confidenceLevel,
    scores,
    topCandidates,
    signals: {
      keywordMatches,
      patternMatches,
      folderMatch: folderName,
      existingFrontmatter: frontmatter,
      existingType: existingType as string | null,
    },
    isStub,
    wordCount,
    hasExistingStructure: existingStructure,
  };
}

// ============================================
// CLI
// ============================================

function printResult(result: AnalysisResult, jsonOutput: boolean): void {
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\n--- Note Analysis ---`);
  console.log(`Note:       ${result.noteTitle}`);
  console.log(`Path:       ${result.notePath}`);
  console.log(`Words:      ${result.wordCount}${result.isStub ? " (STUB)" : ""}`);
  console.log(`Structured: ${result.hasExistingStructure ? "Yes" : "No"}`);
  console.log(``);
  console.log(`Detected Type: ${result.detectedLabel} (${result.detectedType})`);
  console.log(`Confidence:    ${(result.confidence * 100).toFixed(0)}% [${result.confidenceLevel.toUpperCase()}]`);
  console.log(``);
  console.log(`Top Candidates:`);
  for (const c of result.topCandidates) {
    const bar = "=".repeat(Math.round(c.score * 20));
    console.log(`  ${c.label.padEnd(20)} ${(c.score * 100).toFixed(0).padStart(3)}% ${bar}`);
  }

  if (result.signals.existingType) {
    console.log(`\nExisting type in frontmatter: ${result.signals.existingType}`);
  }
  if (result.signals.folderMatch) {
    console.log(`Folder context: ${result.signals.folderMatch}`);
  }

  const topKeywords = result.signals.keywordMatches[result.detectedType];
  if (topKeywords && topKeywords.length > 0) {
    console.log(`Matched keywords: ${topKeywords.slice(0, 8).join(", ")}`);
  }

  console.log(``);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let notePath = "";
  let jsonOutput = false;
  let useInference = false;
  let vaultPath = VAULT_PATH;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--path" && args[i + 1]) {
      notePath = args[i + 1];
      i++;
    } else if (args[i] === "--json") {
      jsonOutput = true;
    } else if (args[i] === "--use-inference") {
      useInference = true;
    } else if (args[i] === "--vault" && args[i + 1]) {
      vaultPath = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
NoteAnalyzer - Classify Obsidian notes into template types

Usage:
  bun NoteAnalyzer.ts --path "/path/to/note.md"
  bun NoteAnalyzer.ts --path "/path/to/note.md" --json
  bun NoteAnalyzer.ts --path "/path/to/note.md" --use-inference

Options:
  --path <path>       Path to the note file (required)
  --json              Output as JSON
  --use-inference     Use AI inference for low-confidence results
  --vault <path>      Override vault path (default: /Users/[user]/Desktop/obsidian/)
  --help, -h          Show this help
`);
      process.exit(0);
    }
  }

  if (!notePath) {
    console.error("Error: --path is required. Use --help for usage.");
    process.exit(1);
  }

  const result = await analyzeNote(notePath, { useInference, vaultPath });
  printResult(result, jsonOutput);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
