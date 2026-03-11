#!/usr/bin/env bun
/**
 * ExternalEnricher - Pull from Obsidian vault and apply Fabric patterns
 *
 * Enriches knowledge by:
 * - Querying Obsidian vault for related notes
 * - Applying Fabric patterns for analysis
 * - Extracting connections between Kaya learnings and personal knowledge
 *
 * Commands:
 *   --search QUERY      Search Obsidian vault for related content
 *   --enrich TOPIC      Enrich a topic with Obsidian context
 *   --fabric PATTERN    Apply a Fabric pattern to content
 *   --list-patterns     List available Fabric patterns
 *   --json              Output as JSON
 *
 * Examples:
 *   bun run ExternalEnricher.ts --search "AI productivity"
 *   bun run ExternalEnricher.ts --enrich "machine learning patterns"
 *   bun run ExternalEnricher.ts --fabric extract_wisdom --content "..."
 */

import { parseArgs } from "util";
import { existsSync, statSync, readdirSync } from "fs";
import * as path from "path";
import { Glob } from "bun";

// ============================================================================
// Configuration
// ============================================================================

const CLAUDE_DIR = path.join(process.env.HOME!, ".claude");
const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT || path.join(process.env.HOME!, "Desktop", "obsidian");
const FABRIC_PATTERNS_DIR = path.join(process.env.HOME!, ".config", "fabric", "patterns");
const FABRIC_SKILL_DIR = path.join(CLAUDE_DIR, "skills", "Fabric");

// ============================================================================
// Types
// ============================================================================

export interface ObsidianNote {
  path: string;
  name: string;
  content: string;
  modified: Date;
  tags: string[];
  links: string[];
}

export interface EnrichmentResult {
  query: string;
  obsidianNotes: ObsidianNote[];
  fabricPatternApplied?: string;
  enrichedContent?: string;
  connections: Array<{
    source: string;
    target: string;
    relationship: string;
  }>;
}

export interface FabricPattern {
  name: string;
  path: string;
  description: string;
}

// ============================================================================
// Obsidian Functions
// ============================================================================

export async function searchObsidian(query: string, limit: number = 10): Promise<ObsidianNote[]> {
  const notes: ObsidianNote[] = [];
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 2);

  if (!existsSync(OBSIDIAN_VAULT)) {
    return [];
  }

  // Find all markdown files
  const glob = new Glob("**/*.md");
  const files: string[] = [];

  for await (const file of glob.scan({ cwd: OBSIDIAN_VAULT, onlyFiles: true })) {
    // Skip hidden directories and templates
    if (file.startsWith(".") || file.includes("/.") || file.includes("/templates/")) {
      continue;
    }
    files.push(file);
  }

  // Search through files
  for (const file of files) {
    const filePath = path.join(OBSIDIAN_VAULT, file);
    try {
      const content = await Bun.file(filePath).text();
      const contentLower = content.toLowerCase();
      const fileNameLower = path.basename(file, ".md").toLowerCase();

      // Calculate relevance score
      let score = 0;
      const matchedTerms: string[] = [];

      for (const term of queryTerms) {
        if (fileNameLower.includes(term)) {
          score += 3; // File name match is worth more
          matchedTerms.push(term);
        }
        if (contentLower.includes(term)) {
          score += 1;
          if (!matchedTerms.includes(term)) matchedTerms.push(term);
        }
      }

      // Only include if there's a match
      if (score > 0) {
        const stat = statSync(filePath);
        const tags = extractTags(content);
        const links = extractLinks(content);

        notes.push({
          path: filePath,
          name: path.basename(file, ".md"),
          content: content.slice(0, 1000), // Truncate for performance
          modified: stat.mtime,
          tags,
          links,
        });
      }
    } catch {
      // Skip files we can't read
    }
  }

  // Sort by relevance (basic: newer files ranked higher among matches)
  notes.sort((a, b) => b.modified.getTime() - a.modified.getTime());

  return notes.slice(0, limit);
}

function extractTags(content: string): string[] {
  const tagPattern = /#[\w-]+/g;
  const matches = content.match(tagPattern) || [];
  return [...new Set(matches)];
}

function extractLinks(content: string): string[] {
  const linkPattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  const links: string[] = [];
  let match;
  while ((match = linkPattern.exec(content)) !== null) {
    links.push(match[1]);
  }
  return [...new Set(links)];
}

export async function getRelatedNotes(noteName: string): Promise<ObsidianNote[]> {
  const notes: ObsidianNote[] = [];

  if (!existsSync(OBSIDIAN_VAULT)) {
    return [];
  }

  // Find notes that link to this note
  const glob = new Glob("**/*.md");

  for await (const file of glob.scan({ cwd: OBSIDIAN_VAULT, onlyFiles: true })) {
    if (file.startsWith(".") || file.includes("/.")) continue;

    const filePath = path.join(OBSIDIAN_VAULT, file);
    try {
      const content = await Bun.file(filePath).text();
      const links = extractLinks(content);

      if (links.some((l) => l.toLowerCase() === noteName.toLowerCase())) {
        const stat = statSync(filePath);
        notes.push({
          path: filePath,
          name: path.basename(file, ".md"),
          content: content.slice(0, 500),
          modified: stat.mtime,
          tags: extractTags(content),
          links,
        });
      }
    } catch {
      // Skip
    }
  }

  return notes;
}

// ============================================================================
// Fabric Functions
// ============================================================================

export async function listFabricPatterns(): Promise<FabricPattern[]> {
  const patterns: FabricPattern[] = [];

  // Check both system fabric patterns and skill-local patterns
  const patternDirs = [FABRIC_PATTERNS_DIR, path.join(FABRIC_SKILL_DIR, "patterns")];

  for (const dir of patternDirs) {
    if (!existsSync(dir)) continue;

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const systemPath = path.join(dir, entry.name, "system.md");
          if (existsSync(systemPath)) {
            const content = await Bun.file(systemPath).text();
            const descMatch = content.match(/^#\s*(.+)/m);
            patterns.push({
              name: entry.name,
              path: systemPath,
              description: descMatch ? descMatch[1].slice(0, 100) : entry.name,
            });
          }
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  return patterns.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getFabricPattern(name: string): Promise<string | null> {
  const patternDirs = [FABRIC_PATTERNS_DIR, path.join(FABRIC_SKILL_DIR, "patterns")];

  for (const dir of patternDirs) {
    const systemPath = path.join(dir, name, "system.md");
    if (existsSync(systemPath)) {
      return await Bun.file(systemPath).text();
    }
  }

  return null;
}

// Common patterns for quick access
const ENRICHMENT_PATTERNS = [
  "extract_wisdom",
  "summarize",
  "extract_ideas",
  "extract_insights",
  "analyze_claims",
  "find_connections",
];

// ============================================================================
// Enrichment Engine
// ============================================================================

export async function enrichTopic(topic: string): Promise<EnrichmentResult> {
  const result: EnrichmentResult = {
    query: topic,
    obsidianNotes: [],
    connections: [],
  };

  // Search Obsidian for related notes
  result.obsidianNotes = await searchObsidian(topic, 5);

  // Find connections between notes
  if (result.obsidianNotes.length > 1) {
    for (let i = 0; i < result.obsidianNotes.length; i++) {
      for (let j = i + 1; j < result.obsidianNotes.length; j++) {
        const noteA = result.obsidianNotes[i];
        const noteB = result.obsidianNotes[j];

        // Check if they share tags
        const sharedTags = noteA.tags.filter((t) => noteB.tags.includes(t));
        if (sharedTags.length > 0) {
          result.connections.push({
            source: noteA.name,
            target: noteB.name,
            relationship: `Shared tags: ${sharedTags.join(", ")}`,
          });
        }

        // Check if they link to each other
        if (noteA.links.includes(noteB.name)) {
          result.connections.push({
            source: noteA.name,
            target: noteB.name,
            relationship: "Direct link",
          });
        }
        if (noteB.links.includes(noteA.name)) {
          result.connections.push({
            source: noteB.name,
            target: noteA.name,
            relationship: "Direct link",
          });
        }
      }
    }
  }

  return result;
}

export function buildEnrichedContext(result: EnrichmentResult): string {
  let context = `# Enriched Context: ${result.query}\n\n`;

  if (result.obsidianNotes.length > 0) {
    context += `## Related Notes from Obsidian (${result.obsidianNotes.length})\n\n`;
    for (const note of result.obsidianNotes) {
      context += `### ${note.name}\n`;
      context += `Tags: ${note.tags.join(", ") || "none"}\n`;
      context += `Links: ${note.links.slice(0, 5).join(", ") || "none"}\n\n`;
      context += `${note.content.slice(0, 300)}...\n\n`;
    }
  }

  if (result.connections.length > 0) {
    context += `## Connections\n\n`;
    for (const conn of result.connections) {
      context += `- ${conn.source} → ${conn.target}: ${conn.relationship}\n`;
    }
    context += "\n";
  }

  return context;
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      search: { type: "string" },
      enrich: { type: "string" },
      fabric: { type: "string" },
      content: { type: "string" },
      "list-patterns": { type: "boolean" },
      limit: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
ExternalEnricher - Pull from Obsidian vault and apply Fabric patterns

Usage:
  bun run ExternalEnricher.ts --search QUERY      Search Obsidian vault
  bun run ExternalEnricher.ts --enrich TOPIC      Enrich topic with context
  bun run ExternalEnricher.ts --fabric PATTERN    Apply Fabric pattern
  bun run ExternalEnricher.ts --list-patterns     List Fabric patterns
  bun run ExternalEnricher.ts --json              Output as JSON

Options:
  --limit N          Max results (default: 10)
  --content TEXT     Content to apply pattern to (for --fabric)

Examples:
  bun run ExternalEnricher.ts --search "productivity"
  bun run ExternalEnricher.ts --enrich "AI tool usage"
  bun run ExternalEnricher.ts --list-patterns
`);
    process.exit(0);
  }

  const limit = values.limit ? parseInt(values.limit) : 10;

  if (values["list-patterns"]) {
    const patterns = await listFabricPatterns();

    if (values.json) {
      console.log(JSON.stringify(patterns, null, 2));
    } else {
      console.log(`📜 Fabric Patterns (${patterns.length})\n`);
      console.log(`Recommended for enrichment:`);
      for (const name of ENRICHMENT_PATTERNS) {
        const p = patterns.find((pat) => pat.name === name);
        if (p) {
          console.log(`  ★ ${p.name}`);
        }
      }
      console.log(`\nAll patterns:`);
      for (const p of patterns.slice(0, 20)) {
        const star = ENRICHMENT_PATTERNS.includes(p.name) ? "★" : " ";
        console.log(`  ${star} ${p.name}`);
      }
      if (patterns.length > 20) {
        console.log(`  ... and ${patterns.length - 20} more`);
      }
    }
    return;
  }

  if (values.search) {
    const notes = await searchObsidian(values.search, limit);

    if (values.json) {
      console.log(JSON.stringify(notes, null, 2));
    } else {
      console.log(`🔍 Obsidian Search: "${values.search}"\n`);

      if (notes.length === 0) {
        console.log("No matching notes found.");
      } else {
        console.log(`Found ${notes.length} notes:\n`);
        for (const note of notes) {
          console.log(`📝 ${note.name}`);
          console.log(`   Path: ${note.path.replace(OBSIDIAN_VAULT, "...")}`);
          console.log(`   Tags: ${note.tags.slice(0, 5).join(", ") || "none"}`);
          console.log(`   Links: ${note.links.slice(0, 3).join(", ") || "none"}`);
          console.log(``);
        }
      }
    }
    return;
  }

  if (values.enrich) {
    const result = await enrichTopic(values.enrich);

    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const context = buildEnrichedContext(result);
      console.log(context);
    }
    return;
  }

  if (values.fabric) {
    const pattern = await getFabricPattern(values.fabric);

    if (!pattern) {
      console.error(`Pattern not found: ${values.fabric}`);
      console.error(`Use --list-patterns to see available patterns.`);
      process.exit(1);
    }

    if (values.json) {
      console.log(
        JSON.stringify(
          {
            pattern: values.fabric,
            systemPrompt: pattern,
            content: values.content || "(no content provided)",
          },
          null,
          2
        )
      );
    } else {
      console.log(`📜 Fabric Pattern: ${values.fabric}\n`);
      console.log(`System Prompt (first 500 chars):`);
      console.log(pattern.slice(0, 500));
      if (pattern.length > 500) console.log("...");
      console.log(`\nTo apply this pattern, use the Fabric skill or inference tool.`);
    }
    return;
  }

  // Default: show summary
  console.log(`🔗 ExternalEnricher`);
  console.log(`   Obsidian vault: ${existsSync(OBSIDIAN_VAULT) ? "✓ Found" : "✗ Not found"}`);
  console.log(`   Fabric patterns: ${(await listFabricPatterns()).length} available`);
  console.log(`\nUse --help for usage information.`);
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}
