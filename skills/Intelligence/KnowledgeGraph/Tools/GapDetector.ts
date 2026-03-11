#!/usr/bin/env bun
/**
 * GapDetector - Knowledge Gap Detection and Note Creation
 *
 * Analyzes the knowledge graph to find:
 *   - Orphan notes (no in/out wikilinks)
 *   - Broken links (referenced but nonexistent notes)
 *   - Stub notes (< 100 words with no outlinks)
 *   - Thin clusters (< 3 notes)
 *   - Missing topics (referenced in multiple notes but no dedicated note)
 *   - Weak bridges (two clusters connected by only 1 link)
 *
 * Cross-references gaps with TELOS goals for prioritized suggestions.
 * Can generate template notes to fill detected gaps.
 *
 * CLI:
 *   bun GapDetector.ts --detect                 # Detect all gaps
 *   bun GapDetector.ts --detect --type orphan   # Specific gap type
 *   bun GapDetector.ts --suggest                # Gap-filling suggestions
 *   bun GapDetector.ts --create <gapIndex>      # Create note for gap
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname, basename } from "path";
import { loadGraphState } from "./GraphBuilder";
import type {
  GraphState,
  GraphNode,
  KnowledgeGap,
  NoteTemplate,
  GapType,
} from "./types.ts";

// ============================================
// TELOS INTEGRATION
// ============================================

interface TelosGoal {
  id: string;
  title: string;
  mission: string;
  keywords: string[];
}

/**
 * Load TELOS goals and extract keywords for matching.
 */
function loadTelosGoals(): TelosGoal[] {
  const goalsPath = join(
    process.env.HOME || "~",
    ".claude",
    "skills",
    "CORE",
    "USER",
    "TELOS",
    "GOALS.md"
  );

  if (!existsSync(goalsPath)) return [];

  const content = readFileSync(goalsPath, "utf-8");
  const goals: TelosGoal[] = [];

  // Parse goal entries
  const goalRegex = /### (G\d+):\s*(.+)\n.*?Supports:\*\*\s*(M\d+)/gm;
  let match;
  while ((match = goalRegex.exec(content)) !== null) {
    const id = match[1];
    const title = match[2].trim();
    const mission = match[3].trim();

    // Extract keywords from the title
    const keywords = title
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .map((w) => w.replace(/[^a-z]/g, ""))
      .filter(Boolean);

    goals.push({ id, title, mission, keywords });
  }

  return goals;
}

/**
 * Find TELOS goals related to a gap.
 */
function findRelatedGoals(
  gap: KnowledgeGap,
  goals: TelosGoal[]
): string[] {
  const gapText = `${gap.description} ${gap.suggestion}`.toLowerCase();
  const related: string[] = [];

  for (const goal of goals) {
    const matchScore = goal.keywords.filter((kw) =>
      gapText.includes(kw)
    ).length;
    if (matchScore > 0) {
      related.push(`${goal.id}: ${goal.title}`);
    }
  }

  // Also check mission-level matches
  const missionKeywords: Record<string, string[]> = {
    M2: ["writing", "creative", "story", "fiction", "music", "piano"],
    M5: ["professional", "ai", "machine learning", "programming", "career", "code", "data"],
    M6: ["self", "health", "habits", "reading", "learning"],
  };

  for (const [mission, keywords] of Object.entries(missionKeywords)) {
    if (keywords.some((kw) => gapText.includes(kw))) {
      const goalsForMission = goals.filter((g) => g.mission === mission);
      for (const g of goalsForMission) {
        if (!related.includes(`${g.id}: ${g.title}`)) {
          related.push(`${g.id}: ${g.title}`);
        }
      }
    }
  }

  return related.slice(0, 3); // Limit to top 3
}

// ============================================
// GAP DETECTION
// ============================================

/**
 * Find orphan notes (no wikilink in or out connections).
 */
function detectOrphans(state: GraphState): KnowledgeGap[] {
  return state.nodes
    .filter((n) => n.outLinks.length === 0 && n.inLinks.length === 0)
    .map((n) => ({
      type: "orphan" as GapType,
      description: `"${n.title}" has no incoming or outgoing wikilinks`,
      severity: n.wordCount > 200 ? "medium" : "low",
      relatedNodes: [n.id],
      suggestion: `Add wikilinks connecting "${n.title}" to related notes in ${n.folder || "the vault"}`,
      telosGoals: [],
    }));
}

/**
 * Find broken links (referenced but nonexistent notes).
 */
function detectBrokenLinks(state: GraphState): KnowledgeGap[] {
  return state.stats.brokenLinks
    .filter((link) => {
      // Filter out obvious non-note references
      if (link.includes("_Context") || link.includes("_Index")) return false;
      if (link.startsWith("..")) return false;
      if (link.includes(",") || link.match(/^\d/)) return false;
      return true;
    })
    .map((link) => {
      // Find which notes reference this broken link
      const referencingNotes = state.nodes
        .filter((n) => {
          const content = readFileSync(
            join(DEFAULT_VAULT, n.id),
            "utf-8"
          ).toLowerCase();
          return content.includes(`[[${link.toLowerCase()}`);
        })
        .map((n) => n.id)
        .slice(0, 5);

      return {
        type: "broken_link" as GapType,
        description: `"${link}" is referenced but does not exist`,
        severity: referencingNotes.length >= 2 ? "high" : "medium",
        relatedNodes: referencingNotes,
        suggestion: `Create a note for "${link}" or fix the broken reference`,
        telosGoals: [],
      };
    });
}

/**
 * Find stub notes (< 100 words with no outlinks).
 */
function detectStubs(state: GraphState): KnowledgeGap[] {
  return state.nodes
    .filter((n) => n.wordCount < 100 && n.outLinks.length === 0)
    .filter((n) => !n.id.includes("_Context") && !n.id.includes("_Index"))
    .map((n) => ({
      type: "stub" as GapType,
      description: `"${n.title}" has only ${n.wordCount} words and no outlinks`,
      severity: "low" as const,
      relatedNodes: [n.id],
      suggestion: `Expand "${n.title}" with more content or link to related notes`,
      telosGoals: [],
    }));
}

/**
 * Find thin clusters (< 3 notes).
 */
function detectThinClusters(state: GraphState): KnowledgeGap[] {
  return state.clusters
    .filter((c) => c.nodes.length < 3 && c.nodes.length > 0)
    .map((c) => ({
      type: "thin_cluster" as GapType,
      description: `Cluster "${c.label}" has only ${c.nodes.length} note(s)`,
      severity: "low" as const,
      relatedNodes: c.nodes,
      suggestion: `Add more notes to strengthen the "${c.label}" knowledge area`,
      telosGoals: [],
    }));
}

/**
 * Find weak bridges between clusters.
 */
function detectWeakBridges(state: GraphState): KnowledgeGap[] {
  const gaps: KnowledgeGap[] = [];

  // Build cluster pair connection counts
  const clusterPairs = new Map<string, number>();
  const nodeToCluster = new Map<string, string>();

  for (const cluster of state.clusters) {
    for (const nodeId of cluster.nodes) {
      nodeToCluster.set(nodeId, cluster.id);
    }
  }

  for (const edge of state.edges) {
    if (edge.type !== "wikilink" && edge.type !== "embed") continue;
    const sourceCluster = nodeToCluster.get(edge.source);
    const targetCluster = nodeToCluster.get(edge.target);
    if (sourceCluster && targetCluster && sourceCluster !== targetCluster) {
      const pairKey = [sourceCluster, targetCluster].sort().join(":");
      clusterPairs.set(pairKey, (clusterPairs.get(pairKey) || 0) + 1);
    }
  }

  for (const [pairKey, count] of clusterPairs) {
    if (count === 1) {
      const [c1, c2] = pairKey.split(":");
      const cluster1 = state.clusters.find((c) => c.id === c1);
      const cluster2 = state.clusters.find((c) => c.id === c2);
      if (cluster1 && cluster2 && cluster1.nodes.length >= 3 && cluster2.nodes.length >= 3) {
        gaps.push({
          type: "weak_bridge",
          description: `Only 1 connection between "${cluster1.label}" and "${cluster2.label}"`,
          severity: "medium",
          relatedNodes: [...cluster1.bridgeNotes, ...cluster2.bridgeNotes].slice(0, 5),
          suggestion: `Create notes or links connecting "${cluster1.label}" concepts to "${cluster2.label}"`,
          telosGoals: [],
        });
      }
    }
  }

  return gaps;
}

// ============================================
// MAIN DETECTION
// ============================================

/**
 * Run all gap detection and cross-reference with TELOS goals.
 */
export function detectGaps(
  state: GraphState,
  types?: GapType[]
): KnowledgeGap[] {
  const goals = loadTelosGoals();
  let allGaps: KnowledgeGap[] = [];

  const detectors: Record<GapType, () => KnowledgeGap[]> = {
    orphan: () => detectOrphans(state),
    broken_link: () => detectBrokenLinks(state),
    stub: () => detectStubs(state),
    thin_cluster: () => detectThinClusters(state),
    missing_topic: () => [], // Handled by broken links for now
    weak_bridge: () => detectWeakBridges(state),
  };

  const typesToRun = types || (Object.keys(detectors) as GapType[]);

  for (const type of typesToRun) {
    const detector = detectors[type];
    if (detector) {
      allGaps.push(...detector());
    }
  }

  // Cross-reference with TELOS goals
  for (const gap of allGaps) {
    gap.telosGoals = findRelatedGoals(gap, goals);
  }

  // Sort by severity (high first), then by number of related nodes
  const severityOrder = { high: 0, medium: 1, low: 2 };
  allGaps.sort(
    (a, b) =>
      severityOrder[a.severity] - severityOrder[b.severity] ||
      b.relatedNodes.length - a.relatedNodes.length
  );

  return allGaps;
}

// ============================================
// NOTE CREATION
// ============================================

/**
 * Generate a template note to fill a detected gap.
 */
export function generateNoteTemplate(
  gap: KnowledgeGap,
  state: GraphState
): NoteTemplate | null {
  if (gap.type === "broken_link") {
    // Create the missing note
    const title = gap.description.match(/"([^"]+)"/)?.[1] || "Untitled";
    const folder = inferFolder(title, gap.relatedNodes, state);
    const tags = inferTags(title, gap.relatedNodes, state);

    const backlinks = gap.relatedNodes
      .map((id) => {
        const node = state.nodes.find((n) => n.id === id);
        return node ? `- [[${node.id.replace(".md", "")}|${node.title}]]` : null;
      })
      .filter(Boolean)
      .join("\n");

    return {
      path: `${folder}/${title}.md`,
      title,
      tags,
      content: `---
tags: [${tags.join(", ")}]
---

# ${title}

<!-- This note was created to fill a detected knowledge gap. -->
<!-- It was referenced by ${gap.relatedNodes.length} other note(s). -->

## Overview

TODO: Add content about ${title}.

## Related Notes

${backlinks}

## Key Concepts

-

## Notes

-
`,
      gap,
    };
  }

  if (gap.type === "weak_bridge") {
    const title = gap.description.match(/"([^"]+)"/)?.[1] || "Bridge Note";
    const secondMatch = gap.description.match(/and "([^"]+)"/)?.[1] || "";

    return {
      path: `Meta/${title} - ${secondMatch} Connection.md`,
      title: `${title} - ${secondMatch} Connection`,
      tags: ["bridge", "connection"],
      content: `---
tags: [bridge, connection]
---

# ${title} to ${secondMatch}

<!-- This bridge note connects two knowledge clusters. -->

## How ${title} Relates to ${secondMatch}

TODO: Describe the connection.

## Key Overlapping Concepts

-

## Notes

-
`,
      gap,
    };
  }

  return null;
}

/**
 * Infer the best folder for a new note based on referencing notes.
 */
function inferFolder(
  title: string,
  relatedNodes: string[],
  state: GraphState
): string {
  const folderCounts = new Map<string, number>();
  for (const nodeId of relatedNodes) {
    const node = state.nodes.find((n) => n.id === nodeId);
    if (node?.folder) {
      folderCounts.set(node.folder, (folderCounts.get(node.folder) || 0) + 1);
    }
  }
  const sorted = [...folderCounts.entries()].sort(([, a], [, b]) => b - a);
  return sorted[0]?.[0] || "Meta";
}

/**
 * Infer tags for a new note based on referencing notes.
 */
function inferTags(
  title: string,
  relatedNodes: string[],
  state: GraphState
): string[] {
  const tagCounts = new Map<string, number>();
  for (const nodeId of relatedNodes) {
    const node = state.nodes.find((n) => n.id === nodeId);
    if (node) {
      for (const tag of node.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }
  }
  return [...tagCounts.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([tag]) => tag);
}

/**
 * Write a note template to the vault.
 */
export function createNote(
  template: NoteTemplate,
  vaultRoot: string
): string {
  const fullPath = join(vaultRoot, template.path);
  const dir = dirname(fullPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (existsSync(fullPath)) {
    throw new Error(`Note already exists: ${fullPath}`);
  }

  writeFileSync(fullPath, template.content);
  return fullPath;
}

// ============================================
// FORMATTING
// ============================================

function formatGaps(gaps: KnowledgeGap[]): string {
  if (gaps.length === 0) return "No knowledge gaps detected.";

  const lines: string[] = [
    "Knowledge Gap Report",
    "=".repeat(40),
    "",
    `Total gaps: ${gaps.length}`,
    `  High severity: ${gaps.filter((g) => g.severity === "high").length}`,
    `  Medium severity: ${gaps.filter((g) => g.severity === "medium").length}`,
    `  Low severity: ${gaps.filter((g) => g.severity === "low").length}`,
    "",
  ];

  // Group by type
  const byType = new Map<string, KnowledgeGap[]>();
  for (const gap of gaps) {
    if (!byType.has(gap.type)) byType.set(gap.type, []);
    byType.get(gap.type)!.push(gap);
  }

  const typeLabels: Record<string, string> = {
    broken_link: "Broken Links",
    orphan: "Orphan Notes",
    stub: "Stub Notes",
    thin_cluster: "Thin Clusters",
    weak_bridge: "Weak Bridges",
    missing_topic: "Missing Topics",
  };

  for (const [type, typeGaps] of byType) {
    lines.push(`--- ${typeLabels[type] || type} (${typeGaps.length}) ---`);
    for (let i = 0; i < Math.min(typeGaps.length, 10); i++) {
      const g = typeGaps[i];
      const severity = g.severity === "high" ? "[!!]" : g.severity === "medium" ? "[!]" : "[ ]";
      lines.push(`  ${severity} ${g.description}`);
      lines.push(`      Suggestion: ${g.suggestion}`);
      if (g.telosGoals.length > 0) {
        lines.push(`      TELOS: ${g.telosGoals.join(", ")}`);
      }
    }
    if (typeGaps.length > 10) {
      lines.push(`  ... and ${typeGaps.length - 10} more`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ============================================
// CLI
// ============================================

const DEFAULT_STATE_PATH = join(
  process.env.HOME || "~",
  ".claude",
  "MEMORY",
  "State",
  "knowledge-graph.json"
);

const DEFAULT_VAULT = "/Users/[user]/Desktop/obsidian";

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
GapDetector - Knowledge Gap Detection

Usage:
  bun GapDetector.ts --detect                      # Detect all gaps
  bun GapDetector.ts --detect --type orphan         # Specific type
  bun GapDetector.ts --suggest                      # Gap-filling suggestions
  bun GapDetector.ts --create <index>               # Create note for gap
  bun GapDetector.ts --json                         # JSON output

Gap Types: orphan, broken_link, stub, thin_cluster, weak_bridge

Options:
  --detect             Run gap detection
  --type <type>        Filter by gap type
  --suggest            Show note creation suggestions
  --create <index>     Create a note from suggestion (0-based)
  --json               Output as JSON
  --help               Show this help
`);
    process.exit(0);
  }

  if (!existsSync(DEFAULT_STATE_PATH)) {
    console.error("No graph state found. Run GraphBuilder --rebuild first.");
    process.exit(1);
  }

  const state: GraphState = await loadGraphState(DEFAULT_STATE_PATH);

  if (args.includes("--detect")) {
    const typeIdx = args.indexOf("--type");
    const types = typeIdx >= 0 ? [args[typeIdx + 1] as GapType] : undefined;

    console.log("Detecting knowledge gaps...\n");
    const gaps = detectGaps(state, types);

    if (args.includes("--json")) {
      console.log(JSON.stringify(gaps, null, 2));
    } else {
      console.log(formatGaps(gaps));
    }
    return;
  }

  if (args.includes("--suggest")) {
    const gaps = detectGaps(state);
    const templates = gaps
      .filter((g) => g.type === "broken_link" || g.type === "weak_bridge")
      .map((g, idx) => {
        const template = generateNoteTemplate(g, state);
        return template ? { index: idx, template } : null;
      })
      .filter(Boolean);

    if (templates.length === 0) {
      console.log("No note creation suggestions available.");
      return;
    }

    console.log("Note Creation Suggestions:");
    console.log("=".repeat(40));
    for (const item of templates.slice(0, 15)) {
      console.log(`\n[${item!.index}] ${item!.template.title}`);
      console.log(`    Path: ${item!.template.path}`);
      console.log(`    Tags: ${item!.template.tags.join(", ")}`);
      console.log(`    Gap: ${item!.template.gap.description}`);
    }
    console.log(
      `\nUse --create <index> to create a note. Use with caution.`
    );
    return;
  }

  const createIdx = args.indexOf("--create");
  if (createIdx >= 0) {
    const index = parseInt(args[createIdx + 1]);
    const gaps = detectGaps(state);
    const creatableGaps = gaps.filter(
      (g) => g.type === "broken_link" || g.type === "weak_bridge"
    );

    if (isNaN(index) || index >= creatableGaps.length) {
      console.error(`Invalid index. Range: 0-${creatableGaps.length - 1}`);
      process.exit(1);
    }

    const template = generateNoteTemplate(creatableGaps[index], state);
    if (!template) {
      console.error("Cannot generate template for this gap type.");
      process.exit(1);
    }

    const fullPath = createNote(template, DEFAULT_VAULT);
    console.log(`Created: ${fullPath}`);
    console.log(`Title: ${template.title}`);
    console.log(`Tags: ${template.tags.join(", ")}`);
    return;
  }

  console.log("Use --help for usage information.");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
