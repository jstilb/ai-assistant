#!/usr/bin/env bun
/**
 * GraphBuilder - Knowledge Graph Construction from Markdown Corpus
 *
 * Parses a directory of markdown files into a directed knowledge graph.
 * Extracts wikilinks, tags, frontmatter, headings, and embed references.
 * Computes in-degree/out-degree, detects broken links, and caches state.
 *
 * This is a GENERAL-PURPOSE graph builder. Obsidian-specific knowledge
 * (wikilink syntax, frontmatter YAML) is handled here, but the output
 * graph structures are source-agnostic.
 *
 * CLI:
 *   bun GraphBuilder.ts --rebuild                    # Full graph build
 *   bun GraphBuilder.ts --rebuild --root /path       # Custom root
 *   bun GraphBuilder.ts --stats                      # Show statistics
 *   bun GraphBuilder.ts --stats --json               # JSON statistics
 *   bun GraphBuilder.ts --neighbors <nodeId>         # Show neighbors
 *   bun GraphBuilder.ts --path <from> <to>           # Shortest path
 */

import { readdirSync, statSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, relative, dirname, basename, extname } from "path";
import YAML from "yaml";
import type {
  GraphNode,
  GraphEdge,
  GraphState,
  GraphStats,
  GraphBuildOptions,
  EdgeType,
  DEFAULT_OBSIDIAN_OPTIONS,
} from "./types.ts";

// ============================================
// MARKDOWN PARSING
// ============================================

/**
 * Extract YAML frontmatter from markdown content.
 * Returns parsed object or empty object if no frontmatter.
 */
function extractFrontmatter(content: string): Record<string, any> {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  try {
    return YAML.parse(match[1]) || {};
  } catch {
    return {};
  }
}

/**
 * Remove frontmatter from content for body parsing.
 */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
}

/**
 * Extract all [[wikilinks]] from content.
 * Returns the link targets (without display text, without heading anchors).
 */
function extractWikilinks(content: string): string[] {
  const links: string[] = [];
  // Match [[target]] and [[target|display]] but NOT ![[embeds]]
  const regex = /(?<!!)\[\[([^\]]+?)\]\]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    let target = match[1];
    // Remove display text: [[target|display]] -> target
    if (target.includes("|")) {
      target = target.split("|")[0];
    }
    // Remove heading anchor: [[target#heading]] -> target
    if (target.includes("#")) {
      target = target.split("#")[0];
    }
    // Remove block reference: [[target^block]] -> target
    if (target.includes("^")) {
      target = target.split("^")[0];
    }
    if (target.trim()) {
      links.push(target.trim());
    }
  }
  return [...new Set(links)];
}

/**
 * Extract all ![[embeds]] from content.
 */
function extractEmbeds(content: string): string[] {
  const embeds: string[] = [];
  const regex = /!\[\[([^\]]+?)\]\]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    let target = match[1];
    // Remove heading/block anchors
    if (target.includes("#")) target = target.split("#")[0];
    if (target.includes("^")) target = target.split("^")[0];
    target = target.trim();
    // Skip image/media embeds
    if (target && !target.match(/\.(png|jpg|jpeg|gif|svg|webp|mp4|mp3|pdf)$/i)) {
      embeds.push(target);
    }
  }
  return [...new Set(embeds)];
}

/**
 * Extract inline tags (#tag) from content body (not frontmatter).
 * Handles nested tags like #parent/child.
 */
function extractInlineTags(body: string): string[] {
  const tags: string[] = [];
  // Match #tag but not inside code blocks or links
  // Simple approach: match #word patterns that aren't part of headings
  const regex = /(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)/gm;
  let match;
  while ((match = regex.exec(body)) !== null) {
    tags.push(match[1].toLowerCase());
  }
  return [...new Set(tags)];
}

/**
 * Extract headings (H2+) from content body.
 */
function extractHeadings(body: string): string[] {
  const headings: string[] = [];
  const regex = /^#{2,}\s+(.+)$/gm;
  let match;
  while ((match = regex.exec(body)) !== null) {
    headings.push(match[1].trim());
  }
  return headings;
}

/**
 * Extract H1 title from content body.
 */
function extractTitle(body: string, filename: string): string {
  const match = body.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();
  // Fallback to filename without extension
  return basename(filename, extname(filename));
}

/**
 * Count words in content body (excluding frontmatter, links, formatting).
 */
function countWords(body: string): number {
  // Strip markdown formatting for word count
  const cleaned = body
    .replace(/```[\s\S]*?```/g, "") // Remove code blocks
    .replace(/`[^`]+`/g, "") // Remove inline code
    .replace(/!\[\[.*?\]\]/g, "") // Remove embeds
    .replace(/\[\[.*?\]\]/g, "") // Remove wikilinks
    .replace(/[#*_~>\-|]/g, " ") // Remove formatting chars
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return 0;
  return cleaned.split(/\s+/).length;
}

/**
 * Parse a single markdown file into a GraphNode.
 * Exported for testing.
 */
export function parseMarkdownFile(filePath: string, rootPath: string): GraphNode {
  const content = readFileSync(filePath, "utf-8");
  const frontmatter = extractFrontmatter(content);
  const body = stripFrontmatter(content);

  const relPath = relative(rootPath, filePath);
  const folder = dirname(relPath) === "." ? "" : dirname(relPath);

  // Combine frontmatter tags and inline tags
  let fmTags: string[] = [];
  if (frontmatter.tags) {
    if (Array.isArray(frontmatter.tags)) {
      fmTags = frontmatter.tags.map((t: string) => t.toLowerCase());
    } else if (typeof frontmatter.tags === "string") {
      fmTags = [frontmatter.tags.toLowerCase()];
    }
  }
  const inlineTags = extractInlineTags(body);
  const allTags = [...new Set([...fmTags, ...inlineTags])];

  // Aliases from frontmatter
  let aliases: string[] = [];
  if (frontmatter.aliases) {
    if (Array.isArray(frontmatter.aliases)) {
      aliases = frontmatter.aliases;
    } else if (typeof frontmatter.aliases === "string") {
      aliases = [frontmatter.aliases];
    }
  }

  const stat = statSync(filePath);

  return {
    id: relPath,
    title: extractTitle(body, filePath),
    folder,
    tags: allTags,
    headings: extractHeadings(body),
    wordCount: countWords(body),
    modified: stat.mtime.toISOString(),
    outLinks: extractWikilinks(body),
    inLinks: [], // Populated during graph construction
    embeds: extractEmbeds(body),
    aliases,
  };
}

// ============================================
// FILE DISCOVERY
// ============================================

/**
 * Recursively find all files matching criteria.
 */
function findFiles(
  dir: string,
  extensions: string[],
  excludePrefixes: string[],
  rootPath: string
): string[] {
  const results: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    // Skip excluded prefixes at any level
    if (excludePrefixes.some((p) => entry.startsWith(p))) continue;

    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      results.push(...findFiles(fullPath, extensions, excludePrefixes, rootPath));
    } else if (stat.isFile() && extensions.includes(extname(entry).toLowerCase())) {
      results.push(fullPath);
    }
  }

  return results;
}

// ============================================
// LINK RESOLUTION
// ============================================

/**
 * Build a map from note basenames and paths to their full node IDs.
 * Obsidian resolves [[link]] by filename match (case-insensitive).
 */
function buildLinkResolutionMap(nodes: GraphNode[]): Map<string, string> {
  const map = new Map<string, string>();

  for (const node of nodes) {
    // Map by full relative path (without extension)
    const pathWithoutExt = node.id.replace(/\.md$/, "");
    map.set(pathWithoutExt.toLowerCase(), node.id);

    // Map by full relative path (with extension)
    map.set(node.id.toLowerCase(), node.id);

    // Map by filename only (without extension) -- last one wins for duplicates
    const nameOnly = basename(node.id, ".md");
    map.set(nameOnly.toLowerCase(), node.id);

    // Map by aliases
    for (const alias of node.aliases) {
      map.set(alias.toLowerCase(), node.id);
    }
  }

  return map;
}

/**
 * Resolve a wikilink target to a node ID.
 * Returns null if the target cannot be resolved (broken link).
 */
function resolveLink(
  target: string,
  resolutionMap: Map<string, string>
): string | null {
  const normalized = target.toLowerCase().trim();
  return resolutionMap.get(normalized) || null;
}

// ============================================
// GRAPH CONSTRUCTION
// ============================================

/**
 * Build a complete knowledge graph from a directory of markdown files.
 */
export async function buildGraph(options: GraphBuildOptions): Promise<GraphState> {
  const startTime = Date.now();

  // 1. Discover all markdown files
  const files = findFiles(
    options.rootPath,
    options.includeExtensions,
    options.excludePrefixes,
    options.rootPath
  );

  // 2. Parse all files into nodes
  const nodes: GraphNode[] = files.map((f) =>
    parseMarkdownFile(f, options.rootPath)
  );

  // 3. Build link resolution map
  const linkMap = buildLinkResolutionMap(nodes);
  const nodeIndex = new Map<string, GraphNode>();
  for (const node of nodes) {
    nodeIndex.set(node.id, node);
  }

  // 4. Resolve links and build edges
  const edges: GraphEdge[] = [];
  const brokenLinks = new Set<string>();

  for (const node of nodes) {
    // Resolve wikilinks -> edges
    const resolvedOutLinks: string[] = [];
    for (const rawLink of node.outLinks) {
      const resolved = resolveLink(rawLink, linkMap);
      if (resolved && resolved !== node.id) {
        resolvedOutLinks.push(resolved);
        edges.push({
          source: node.id,
          target: resolved,
          type: "wikilink",
          weight: 1.0,
        });
        // Add inLink to target
        const targetNode = nodeIndex.get(resolved);
        if (targetNode && !targetNode.inLinks.includes(node.id)) {
          targetNode.inLinks.push(node.id);
        }
      } else if (!resolved) {
        brokenLinks.add(rawLink);
      }
    }
    // Update outLinks to resolved IDs
    node.outLinks = resolvedOutLinks;

    // Resolve embeds -> edges
    const resolvedEmbeds: string[] = [];
    for (const rawEmbed of node.embeds) {
      const resolved = resolveLink(rawEmbed, linkMap);
      if (resolved && resolved !== node.id) {
        resolvedEmbeds.push(resolved);
        edges.push({
          source: node.id,
          target: resolved,
          type: "embed",
          weight: 0.8,
        });
      }
    }
    node.embeds = resolvedEmbeds;
  }

  // 5. Create tag co-occurrence edges (optional)
  if (options.includeTagEdges) {
    const tagToNodes = new Map<string, string[]>();
    for (const node of nodes) {
      for (const tag of node.tags) {
        if (!tagToNodes.has(tag)) tagToNodes.set(tag, []);
        tagToNodes.get(tag)!.push(node.id);
      }
    }
    for (const [_tag, nodeIds] of tagToNodes) {
      if (nodeIds.length < 2 || nodeIds.length > 50) continue; // Skip very common tags
      for (let i = 0; i < nodeIds.length; i++) {
        for (let j = i + 1; j < nodeIds.length; j++) {
          // Avoid duplicate tag edges (only check tag type, not other edge types)
          const existingTag = edges.find(
            (e) =>
              e.type === "tag" &&
              ((e.source === nodeIds[i] && e.target === nodeIds[j]) ||
               (e.source === nodeIds[j] && e.target === nodeIds[i]))
          );
          if (!existingTag) {
            edges.push({
              source: nodeIds[i],
              target: nodeIds[j],
              type: "tag",
              weight: 0.3,
            });
          }
        }
      }
    }
  }

  // 6. Create folder co-membership edges (optional)
  if (options.includeFolderEdges) {
    const folderToNodes = new Map<string, string[]>();
    for (const node of nodes) {
      if (!node.folder) continue;
      if (!folderToNodes.has(node.folder)) folderToNodes.set(node.folder, []);
      folderToNodes.get(node.folder)!.push(node.id);
    }
    for (const [_folder, nodeIds] of folderToNodes) {
      if (nodeIds.length < 2) continue;
      for (let i = 0; i < nodeIds.length; i++) {
        for (let j = i + 1; j < nodeIds.length; j++) {
          // Avoid duplicate folder edges (only check folder type)
          const existingFolder = edges.find(
            (e) =>
              e.type === "folder" &&
              ((e.source === nodeIds[i] && e.target === nodeIds[j]) ||
               (e.source === nodeIds[j] && e.target === nodeIds[i]))
          );
          if (!existingFolder) {
            edges.push({
              source: nodeIds[i],
              target: nodeIds[j],
              type: "folder",
              weight: 0.2,
            });
          }
        }
      }
    }
  }

  // 7. Compute statistics
  const tagCounts: Record<string, number> = {};
  const folderCounts: Record<string, number> = {};
  for (const node of nodes) {
    for (const tag of node.tags) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
    const folder = node.folder || "(root)";
    folderCounts[folder] = (folderCounts[folder] || 0) + 1;
  }

  // Identify orphan notes: no wikilink inLinks AND no wikilink outLinks
  const orphans = nodes.filter(
    (n) => n.outLinks.length === 0 && n.inLinks.length === 0
  );

  // Connection counts (wikilinks only for most/least connected)
  const connectionCounts = nodes.map((n) => ({
    id: n.id,
    connections: n.outLinks.length + n.inLinks.length,
  }));
  connectionCounts.sort((a, b) => b.connections - a.connections);

  const totalConnections = connectionCounts.reduce(
    (sum, c) => sum + c.connections,
    0
  );

  const stats: GraphStats = {
    totalNodes: nodes.length,
    totalEdges: edges.length,
    orphanCount: orphans.length,
    brokenLinks: [...brokenLinks],
    avgConnections: nodes.length > 0 ? totalConnections / nodes.length : 0,
    mostConnected: connectionCounts.slice(0, 10).map((c) => c.id),
    leastConnected: connectionCounts
      .filter((c) => c.connections > 0)
      .slice(-10)
      .map((c) => c.id),
    clusterCount: 0,
    tagCounts,
    folderCounts,
  };

  const buildTimeMs = Date.now() - startTime;

  const state: GraphState = {
    version: 1,
    built: new Date().toISOString(),
    ttl: 24,
    nodes,
    edges,
    clusters: [],
    stats,
  };

  return state;
}

// ============================================
// GRAPH TRAVERSAL
// ============================================

/**
 * Get all direct neighbors of a node (both in and out links).
 */
export function getNeighbors(state: GraphState, nodeId: string): GraphNode[] {
  const node = state.nodes.find((n) => n.id === nodeId);
  if (!node) return [];

  const neighborIds = new Set<string>();
  // Outgoing edges
  for (const edge of state.edges) {
    if (edge.source === nodeId) neighborIds.add(edge.target);
    if (edge.target === nodeId) neighborIds.add(edge.source);
  }

  return state.nodes.filter((n) => neighborIds.has(n.id));
}

/**
 * Find shortest path between two nodes using BFS.
 * Returns array of node IDs or null if no path exists.
 */
export function findShortestPath(
  state: GraphState,
  fromId: string,
  toId: string,
  edgeTypes?: EdgeType[]
): string[] | null {
  if (fromId === toId) return [fromId];

  // Build adjacency list
  const adjacency = new Map<string, Set<string>>();
  for (const node of state.nodes) {
    adjacency.set(node.id, new Set());
  }
  for (const edge of state.edges) {
    if (edgeTypes && !edgeTypes.includes(edge.type)) continue;
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source); // Treat as undirected for pathfinding
  }

  // BFS
  const visited = new Set<string>([fromId]);
  const queue: { nodeId: string; path: string[] }[] = [
    { nodeId: fromId, path: [fromId] },
  ];

  while (queue.length > 0) {
    const { nodeId, path } = queue.shift()!;
    const neighbors = adjacency.get(nodeId);
    if (!neighbors) continue;

    for (const neighbor of neighbors) {
      if (neighbor === toId) {
        return [...path, neighbor];
      }
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push({ nodeId: neighbor, path: [...path, neighbor] });
      }
    }
  }

  return null;
}

/**
 * Extract a subgraph centered on a node with a given depth.
 */
export function extractSubgraph(
  state: GraphState,
  centerId: string,
  maxDepth: number = 2
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const visited = new Set<string>([centerId]);
  const queue: { nodeId: string; depth: number }[] = [
    { nodeId: centerId, depth: 0 },
  ];

  while (queue.length > 0) {
    const { nodeId, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;

    for (const edge of state.edges) {
      let neighbor: string | null = null;
      if (edge.source === nodeId) neighbor = edge.target;
      if (edge.target === nodeId) neighbor = edge.source;
      if (neighbor && !visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push({ nodeId: neighbor, depth: depth + 1 });
      }
    }
  }

  const subNodes = state.nodes.filter((n) => visited.has(n.id));
  const subEdges = state.edges.filter(
    (e) => visited.has(e.source) && visited.has(e.target)
  );

  return { nodes: subNodes, edges: subEdges };
}

// ============================================
// PERSISTENCE (via StateManager)
// ============================================

import { createStateManager } from "../../CORE/Tools/StateManager";
import { z } from "zod";

/** Zod schemas for graph state validation */
const GraphNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  folder: z.string(),
  tags: z.array(z.string()),
  headings: z.array(z.string()),
  wordCount: z.number(),
  modified: z.string(),
  outLinks: z.array(z.string()),
  inLinks: z.array(z.string()),
  embeds: z.array(z.string()),
  aliases: z.array(z.string()),
});

const GraphEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  type: z.enum(["wikilink", "tag", "folder", "semantic", "embed"]),
  weight: z.number(),
  context: z.string().optional(),
});

const ConceptClusterSchema = z.object({
  id: z.string(),
  label: z.string(),
  nodes: z.array(z.string()),
  tags: z.array(z.string()),
  bridgeNotes: z.array(z.string()),
  density: z.number(),
});

const GraphStatsSchema = z.object({
  totalNodes: z.number(),
  totalEdges: z.number(),
  orphanCount: z.number(),
  brokenLinks: z.array(z.string()),
  avgConnections: z.number(),
  mostConnected: z.array(z.string()),
  leastConnected: z.array(z.string()),
  clusterCount: z.number(),
  tagCounts: z.record(z.number()),
  folderCounts: z.record(z.number()),
});

const GraphStateSchema = z.object({
  version: z.number(),
  built: z.string(),
  ttl: z.number(),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  clusters: z.array(ConceptClusterSchema),
  stats: GraphStatsSchema,
});

/**
 * Save graph state using StateManager.
 */
export async function saveGraphState(
  state: GraphState,
  path: string
): Promise<void> {
  const manager = createStateManager({
    path,
    schema: GraphStateSchema as z.ZodSchema<GraphState>,
    defaults: state,
  });
  await manager.save(state);
}

/**
 * Load graph state using StateManager.
 */
export async function loadGraphState(path: string): Promise<GraphState> {
  if (!existsSync(path)) {
    throw new Error(`Graph state file not found: ${path}`);
  }
  const manager = createStateManager({
    path,
    schema: GraphStateSchema as z.ZodSchema<GraphState>,
    defaults: { version: 1, built: "", ttl: 24, nodes: [], edges: [], clusters: [], stats: {} as GraphStats },
  });
  return await manager.load();
}

// ============================================
// FORMATTING
// ============================================

function formatStats(stats: GraphStats): string {
  const lines: string[] = [
    "Knowledge Graph Statistics",
    "=".repeat(40),
    "",
    `Total nodes:        ${stats.totalNodes}`,
    `Total edges:        ${stats.totalEdges}`,
    `Orphan notes:       ${stats.orphanCount}`,
    `Broken links:       ${stats.brokenLinks.length}`,
    `Avg connections:    ${stats.avgConnections.toFixed(1)}`,
    `Cluster count:      ${stats.clusterCount}`,
    "",
    "Most Connected Notes:",
    ...stats.mostConnected
      .slice(0, 5)
      .map((id, i) => `  ${i + 1}. ${id}`),
    "",
    "Tag Distribution (top 15):",
    ...Object.entries(stats.tagCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 15)
      .map(([tag, count]) => `  #${tag}: ${count}`),
    "",
    "Folder Distribution:",
    ...Object.entries(stats.folderCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([folder, count]) => `  ${folder}: ${count}`),
  ];

  if (stats.brokenLinks.length > 0) {
    lines.push("", "Broken Links:", ...stats.brokenLinks.map((l) => `  - ${l}`));
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

const DEFAULT_ROOT = "~/Desktop/obsidian";

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
GraphBuilder - Knowledge Graph Construction

Usage:
  bun GraphBuilder.ts --rebuild [--root <path>] [--output <path>]
  bun GraphBuilder.ts --stats [--json]
  bun GraphBuilder.ts --neighbors <nodeId>
  bun GraphBuilder.ts --path <from> <to>

Options:
  --rebuild          Build graph from vault
  --root <path>      Vault root (default: ${DEFAULT_ROOT})
  --output <path>    State file path (default: ${DEFAULT_STATE_PATH})
  --stats            Show graph statistics
  --json             Output as JSON
  --neighbors <id>   Show neighbors of a node
  --path <from> <to> Find shortest path
  --help             Show this help
`);
    process.exit(0);
  }

  const rootIdx = args.indexOf("--root");
  const rootPath = rootIdx >= 0 && args[rootIdx + 1] ? args[rootIdx + 1] : DEFAULT_ROOT;
  const outIdx = args.indexOf("--output");
  const outputPath = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : DEFAULT_STATE_PATH;

  if (args.includes("--rebuild")) {
    console.log(`Building knowledge graph from: ${rootPath}`);
    const startTime = Date.now();

    const state = await buildGraph({
      rootPath,
      excludePrefixes: [".", "_"],
      includeExtensions: [".md"],
      includeFolderEdges: true,
      includeTagEdges: true,
    });

    const elapsed = Date.now() - startTime;
    await saveGraphState(state, outputPath);

    console.log(`\nGraph built in ${elapsed}ms`);
    console.log(`Saved to: ${outputPath}`);
    console.log(`\n${formatStats(state.stats)}`);
    return;
  }

  if (args.includes("--stats")) {
    if (!existsSync(outputPath)) {
      console.error("No graph state found. Run --rebuild first.");
      process.exit(1);
    }
    const state = await loadGraphState(outputPath);

    if (args.includes("--json")) {
      console.log(JSON.stringify(state.stats, null, 2));
    } else {
      console.log(formatStats(state.stats));
    }
    return;
  }

  if (args.includes("--neighbors")) {
    const nodeId = args[args.indexOf("--neighbors") + 1];
    if (!nodeId) {
      console.error("Usage: --neighbors <nodeId>");
      process.exit(1);
    }
    const state = await loadGraphState(outputPath);
    const neighbors = getNeighbors(state, nodeId);
    console.log(`Neighbors of ${nodeId}:`);
    for (const n of neighbors) {
      console.log(`  - ${n.id} (${n.title})`);
    }
    return;
  }

  if (args.includes("--path")) {
    const fromIdx = args.indexOf("--path");
    const fromId = args[fromIdx + 1];
    const toId = args[fromIdx + 2];
    if (!fromId || !toId) {
      console.error("Usage: --path <from> <to>");
      process.exit(1);
    }
    const state = await loadGraphState(outputPath);
    const path = findShortestPath(state, fromId, toId);
    if (path) {
      console.log(`Path from ${fromId} to ${toId}:`);
      for (let i = 0; i < path.length; i++) {
        const prefix = i === 0 ? "START" : i === path.length - 1 ? "  END" : "   ->";
        console.log(`  ${prefix} ${path[i]}`);
      }
    } else {
      console.log("No path found.");
    }
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
