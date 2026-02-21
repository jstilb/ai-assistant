#!/usr/bin/env bun
/**
 * TagSuggester.ts - Suggest contextually relevant tags from vault taxonomy
 *
 * Scans the vault's existing tag taxonomy (all tags with frequencies),
 * then suggests 3-5 content tags based on note content + existing taxonomy.
 * Supports nested tags (e.g., programming/python).
 * Never invents tag hierarchies that don't exist in vault unless asked.
 *
 * Two modes:
 * 1. Heuristic: keyword matching against vault tags (instant, no API)
 * 2. Inference: uses fast inference for deeper content analysis
 *
 * CLI: bun TagSuggester.ts --path "/path/to/note.md"
 *      bun TagSuggester.ts --path "/path/to/note.md" --use-inference
 *      bun TagSuggester.ts --scan-taxonomy
 *      bun TagSuggester.ts --path "/path/to/note.md" --json
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from "fs";
import { basename, join, resolve, dirname } from "path";
import { parseFrontmatter } from "./NoteAnalyzer.ts";
import { inference } from "../../CORE/Tools/Inference.ts";

// ============================================
// TYPES
// ============================================

export interface TagTaxonomy {
  tags: Record<string, number>; // tag -> frequency
  nestedTags: Record<string, string[]>; // parent -> children
  totalNotes: number;
  lastScanned: string;
}

export interface TagSuggestion {
  tag: string;
  reason: string;
  confidence: number;
  existsInVault: boolean;
  frequency: number; // how many notes already use this tag
}

export interface TagSuggestionResult {
  notePath: string;
  noteTitle: string;
  suggestedTags: TagSuggestion[];
  existingTags: string[];
  taxonomySize: number;
  method: "heuristic" | "inference" | "hybrid";
}

// ============================================
// TAXONOMY SCANNING
// ============================================

const VAULT_PATH = "~/obsidian/";
const CACHE_PATH = join(
  process.env.HOME || "/Users/your-username",
  ".claude/MEMORY/cache/.tag-taxonomy-cache.json"
);

function scanVaultTags(vaultPath: string): TagTaxonomy {
  const tags: Record<string, number> = {};
  let totalNotes = 0;

  function walkDir(dir: string): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.name.endsWith(".md")) {
          totalNotes++;
          extractTagsFromFile(fullPath, tags);
        }
      }
    } catch {
      // Permission denied or similar
    }
  }

  walkDir(vaultPath);

  // Build nested tag hierarchy
  const nestedTags: Record<string, string[]> = {};
  for (const tag of Object.keys(tags)) {
    if (tag.includes("/")) {
      const parts = tag.split("/");
      const parent = parts[0];
      if (!nestedTags[parent]) nestedTags[parent] = [];
      nestedTags[parent].push(tag);
    }
  }

  return {
    tags,
    nestedTags,
    totalNotes,
    lastScanned: new Date().toISOString(),
  };
}

function extractTagsFromFile(filePath: string, tags: Record<string, number>): void {
  try {
    const content = readFileSync(filePath, "utf-8");

    // Extract from frontmatter
    const parsed = parseFrontmatter(content);
    if (parsed?.frontmatter?.tags) {
      const fmTags = Array.isArray(parsed.frontmatter.tags)
        ? (parsed.frontmatter.tags as string[])
        : [String(parsed.frontmatter.tags)];
      for (const tag of fmTags) {
        const cleanTag = tag.replace(/^#/, "").trim();
        if (cleanTag) {
          tags[cleanTag] = (tags[cleanTag] || 0) + 1;
        }
      }
    }

    // Extract inline tags (# followed by word chars, not headings)
    const body = parsed?.body || content;
    const inlineTags = body.match(/(?:^|\s)#([\w/-]+)/g) || [];
    for (const match of inlineTags) {
      const tag = match.trim().replace(/^#/, "");
      // Filter out likely headings and numbers
      if (tag && !/^\d+$/.test(tag) && tag.length > 1) {
        tags[tag] = (tags[tag] || 0) + 1;
      }
    }
  } catch {
    // Can't read file
  }
}

function loadCachedTaxonomy(): TagTaxonomy | null {
  if (!existsSync(CACHE_PATH)) return null;

  try {
    const raw = readFileSync(CACHE_PATH, "utf-8");
    const cached = JSON.parse(raw) as TagTaxonomy;

    // Check if cache is less than 1 hour old
    const cachedTime = new Date(cached.lastScanned).getTime();
    const now = Date.now();
    if (now - cachedTime < 60 * 60 * 1000) {
      return cached;
    }
  } catch {
    // Invalid cache
  }

  return null;
}

function saveTaxonomyCache(taxonomy: TagTaxonomy): void {
  try {
    const dir = dirname(CACHE_PATH);
    if (!existsSync(dir)) {
      const { mkdirSync } = require("fs");
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(CACHE_PATH, JSON.stringify(taxonomy, null, 2));
  } catch {
    // Cache write failed -- non-fatal
  }
}

export function getTaxonomy(
  vaultPath: string = VAULT_PATH,
  forceRefresh: boolean = false
): TagTaxonomy {
  if (!forceRefresh) {
    const cached = loadCachedTaxonomy();
    if (cached) return cached;
  }

  const taxonomy = scanVaultTags(vaultPath);
  saveTaxonomyCache(taxonomy);
  return taxonomy;
}

// ============================================
// HEURISTIC TAG SUGGESTION
// ============================================

function suggestTagsHeuristic(
  content: string,
  noteTitle: string,
  taxonomy: TagTaxonomy,
  existingTags: string[]
): TagSuggestion[] {
  const suggestions: TagSuggestion[] = [];
  const lowerContent = content.toLowerCase();
  const lowerTitle = noteTitle.toLowerCase();
  const existingSet = new Set(existingTags.map((t) => t.toLowerCase()));

  // Score each vault tag against note content
  const scored: Array<{ tag: string; score: number; reason: string }> = [];

  // Split content into words for word-boundary matching
  const contentWords = new Set(lowerContent.split(/[\s,.:;!?()\[\]{}"']+/).filter(w => w.length > 0));
  const titleWords = new Set(lowerTitle.split(/[\s,.:;!?()\[\]{}"']+/).filter(w => w.length > 0));

  for (const [tag, frequency] of Object.entries(taxonomy.tags)) {
    if (existingSet.has(tag.toLowerCase())) continue; // Skip existing tags

    let score = 0;
    let reason = "";
    const lowerTag = tag.toLowerCase();
    const tagParts = lowerTag.split("/");
    const leafTag = tagParts[tagParts.length - 1];

    // Skip very short tags that cause false positives (1-2 chars)
    if (leafTag.length <= 2) continue;

    // For short tags (3-4 chars), require word-boundary match to avoid false positives
    const isShortTag = leafTag.length <= 4;

    // Direct mention in content (word-boundary for short, substring for long)
    if (isShortTag) {
      // For short tags like "gre", "sql", "nlp" -- require exact word match
      if (contentWords.has(leafTag)) {
        score += 3;
        reason = `"${leafTag}" appears as distinct word in content`;
      }
    } else {
      // For longer tags, substring match is fine
      if (lowerContent.includes(leafTag)) {
        score += 3;
        reason = `"${leafTag}" appears in content`;
      }
    }

    // Multi-word tag match (e.g., "machine-learning" -> check "machine learning")
    if (leafTag.includes("-")) {
      const unHyphenated = leafTag.replace(/-/g, " ");
      if (lowerContent.includes(unHyphenated)) {
        score += 4; // Strong signal
        reason = `"${unHyphenated}" appears in content`;
      }
    }

    // Title match (always strong signal)
    if (isShortTag) {
      if (titleWords.has(leafTag)) {
        score += 5;
        reason = `"${leafTag}" appears in title`;
      }
    } else {
      if (lowerTitle.includes(leafTag)) {
        score += 5;
        reason = `"${leafTag}" appears in title`;
      }
    }

    // Frequency bonus (popular tags are more likely relevant)
    if (frequency > 20) score += 1.5;
    else if (frequency > 10) score += 1;
    else if (frequency > 5) score += 0.5;

    // Penalty for very rare tags (likely too specific)
    if (frequency <= 1) score -= 1;

    if (score > 0) {
      scored.push({ tag, score, reason });
    }
  }

  // Sort by score descending and take top 5
  scored.sort((a, b) => b.score - a.score);
  const topTags = scored.slice(0, 5);

  for (const item of topTags) {
    const freq = taxonomy.tags[item.tag] || 0;
    suggestions.push({
      tag: item.tag,
      reason: item.reason,
      confidence: Math.min(1.0, item.score / 7),
      existsInVault: true,
      frequency: freq,
    });
  }

  return suggestions;
}

// ============================================
// INFERENCE TAG SUGGESTION
// ============================================

async function suggestTagsWithInference(
  content: string,
  noteTitle: string,
  taxonomy: TagTaxonomy,
  existingTags: string[]
): Promise<TagSuggestion[]> {
  // Get top 50 most frequent vault tags to provide as context
  const topVaultTags = Object.entries(taxonomy.tags)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 50)
    .map(([tag, freq]) => `${tag} (${freq})`);

  const systemPrompt = `You are a tag suggestion engine for an Obsidian knowledge vault. Given note content and the vault's existing tag taxonomy, suggest 3-5 tags.

Rules:
- ONLY suggest tags that exist in the vault taxonomy (listed below)
- Tags should be relevant to the note's content
- Prefer specific tags over generic ones
- Support nested tags (e.g., programming/python)
- Do NOT suggest tags the note already has
- Respond with JSON array only: [{"tag": "tag-name", "reason": "why"}]

Existing vault tags (most common):
${topVaultTags.join(", ")}

Note's existing tags: ${existingTags.join(", ") || "none"}`;

  // Truncate content
  const truncated = content.slice(0, 1500);

  const result = await inference({
    systemPrompt,
    userPrompt: `Title: ${noteTitle}\n\nContent:\n${truncated}`,
    level: "fast",
    expectJson: true,
    timeout: 15000,
  });

  if (result.success && result.parsed) {
    const parsed = result.parsed as Array<{ tag: string; reason: string }>;
    if (Array.isArray(parsed)) {
      return parsed.map((item) => ({
        tag: item.tag,
        reason: item.reason || "AI suggestion",
        confidence: 0.7,
        existsInVault: taxonomy.tags[item.tag] !== undefined,
        frequency: taxonomy.tags[item.tag] || 0,
      }));
    }
  }

  return [];
}

// ============================================
// MAIN SUGGESTION
// ============================================

export async function suggestTags(
  notePath: string,
  options: {
    useInference?: boolean;
    vaultPath?: string;
    forceRefreshTaxonomy?: boolean;
  } = {}
): Promise<TagSuggestionResult> {
  const resolvedPath = resolve(notePath);
  const vaultPath = options.vaultPath || VAULT_PATH;

  if (!existsSync(resolvedPath)) {
    throw new Error(`Note not found: ${resolvedPath}`);
  }

  const rawContent = readFileSync(resolvedPath, "utf-8");
  const noteTitle = basename(resolvedPath, ".md");
  const taxonomy = getTaxonomy(vaultPath, options.forceRefreshTaxonomy);

  // Get existing tags
  const parsed = parseFrontmatter(rawContent);
  const existingTags: string[] = [];
  if (parsed?.frontmatter?.tags) {
    const fmTags = Array.isArray(parsed.frontmatter.tags)
      ? (parsed.frontmatter.tags as string[])
      : [String(parsed.frontmatter.tags)];
    existingTags.push(...fmTags);
  }

  // Extract inline tags from body
  const body = parsed?.body || rawContent;
  const inlineTags = body.match(/(?:^|\s)#([\w/-]+)/g) || [];
  for (const match of inlineTags) {
    const tag = match.trim().replace(/^#/, "");
    if (tag && !/^\d+$/.test(tag) && tag.length > 1) {
      existingTags.push(tag);
    }
  }

  const uniqueExisting = [...new Set(existingTags)];

  // Suggest tags
  let suggestedTags: TagSuggestion[];
  let method: "heuristic" | "inference" | "hybrid";

  if (options.useInference) {
    // Hybrid: heuristic first, then inference to supplement
    const heuristicSuggestions = suggestTagsHeuristic(
      rawContent,
      noteTitle,
      taxonomy,
      uniqueExisting
    );
    const inferenceSuggestions = await suggestTagsWithInference(
      rawContent,
      noteTitle,
      taxonomy,
      uniqueExisting
    );

    // Merge: heuristic suggestions first, then add unique inference suggestions
    const seenTags = new Set(heuristicSuggestions.map((s) => s.tag));
    suggestedTags = [...heuristicSuggestions];
    for (const s of inferenceSuggestions) {
      if (!seenTags.has(s.tag)) {
        suggestedTags.push(s);
        seenTags.add(s.tag);
      }
    }
    suggestedTags = suggestedTags.slice(0, 5);
    method = "hybrid";
  } else {
    suggestedTags = suggestTagsHeuristic(rawContent, noteTitle, taxonomy, uniqueExisting);
    method = "heuristic";
  }

  return {
    notePath: resolvedPath,
    noteTitle,
    suggestedTags,
    existingTags: uniqueExisting,
    taxonomySize: Object.keys(taxonomy.tags).length,
    method,
  };
}

// ============================================
// CLI
// ============================================

function printTaxonomy(taxonomy: TagTaxonomy): void {
  console.log(`\n--- Vault Tag Taxonomy ---`);
  console.log(`Total notes scanned: ${taxonomy.totalNotes}`);
  console.log(`Unique tags: ${Object.keys(taxonomy.tags).length}`);
  console.log(`Last scanned: ${taxonomy.lastScanned}`);
  console.log(``);

  // Show top 30 tags
  const sorted = Object.entries(taxonomy.tags)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 30);

  console.log(`Top 30 tags:`);
  for (const [tag, freq] of sorted) {
    const bar = "=".repeat(Math.min(freq, 40));
    console.log(`  ${tag.padEnd(30)} ${String(freq).padStart(4)} ${bar}`);
  }

  // Show nested tag hierarchies
  const nestedKeys = Object.keys(taxonomy.nestedTags);
  if (nestedKeys.length > 0) {
    console.log(`\nNested tag hierarchies (${nestedKeys.length}):`);
    for (const parent of nestedKeys.sort()) {
      const children = taxonomy.nestedTags[parent];
      console.log(`  ${parent}/`);
      for (const child of children) {
        console.log(`    ${child} (${taxonomy.tags[child] || 0})`);
      }
    }
  }
}

function printResult(result: TagSuggestionResult, jsonOutput: boolean): void {
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\n--- Tag Suggestions ---`);
  console.log(`Note:      ${result.noteTitle}`);
  console.log(`Method:    ${result.method}`);
  console.log(`Taxonomy:  ${result.taxonomySize} unique tags`);
  console.log(``);

  if (result.existingTags.length > 0) {
    console.log(`Existing tags: ${result.existingTags.join(", ")}`);
    console.log(``);
  }

  if (result.suggestedTags.length > 0) {
    console.log(`Suggested tags:`);
    for (const tag of result.suggestedTags) {
      const vaultStatus = tag.existsInVault ? `in vault (${tag.frequency} notes)` : "NEW";
      const conf = `${(tag.confidence * 100).toFixed(0)}%`;
      console.log(`  ${tag.tag.padEnd(25)} ${conf.padStart(4)} -- ${tag.reason} [${vaultStatus}]`);
    }
  } else {
    console.log(`No tag suggestions found.`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let notePath = "";
  let jsonOutput = false;
  let useInference = false;
  let scanTaxonomy = false;
  let forceRefresh = false;
  let vaultPath = VAULT_PATH;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--path" && args[i + 1]) {
      notePath = args[i + 1];
      i++;
    } else if (args[i] === "--json") {
      jsonOutput = true;
    } else if (args[i] === "--use-inference") {
      useInference = true;
    } else if (args[i] === "--scan-taxonomy") {
      scanTaxonomy = true;
    } else if (args[i] === "--refresh") {
      forceRefresh = true;
    } else if (args[i] === "--vault" && args[i + 1]) {
      vaultPath = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
TagSuggester - Suggest contextually relevant tags from vault taxonomy

Usage:
  bun TagSuggester.ts --path "/path/to/note.md"
  bun TagSuggester.ts --path "/path/to/note.md" --use-inference
  bun TagSuggester.ts --scan-taxonomy
  bun TagSuggester.ts --path "/path/to/note.md" --json

Options:
  --path <path>       Path to the note file
  --use-inference     Use AI inference for deeper analysis
  --scan-taxonomy     Scan and display vault tag taxonomy
  --refresh           Force refresh of cached taxonomy
  --vault <path>      Override vault path
  --json              Output as JSON
  --help, -h          Show this help
`);
      process.exit(0);
    }
  }

  if (scanTaxonomy) {
    const taxonomy = getTaxonomy(vaultPath, forceRefresh);
    if (jsonOutput) {
      console.log(JSON.stringify(taxonomy, null, 2));
    } else {
      printTaxonomy(taxonomy);
    }
    return;
  }

  if (!notePath) {
    console.error("Error: --path is required. Use --help for usage.");
    process.exit(1);
  }

  const result = await suggestTags(notePath, {
    useInference,
    vaultPath,
    forceRefreshTaxonomy: forceRefresh,
  });
  printResult(result, jsonOutput);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
