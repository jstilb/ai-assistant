#!/usr/bin/env bun
/**
 * NoteSummarizer - AI-Powered Note and Cluster Summarization
 *
 * Summarizes individual notes or clusters of notes using the Kaya
 * Inference tool. Frames all summaries for conceptual thinking
 * (user has aphantasia -- concepts and words, not images).
 *
 * CLI:
 *   bun NoteSummarizer.ts --note <nodeId>            # Summarize single note
 *   bun NoteSummarizer.ts --cluster <clusterId>      # Summarize cluster
 *   bun NoteSummarizer.ts --query "what do I know about X?"  # Query summary
 */

import { readFileSync, existsSync } from "fs";
import { loadGraphState } from "./GraphBuilder";
import { join, basename } from "path";
import { spawn } from "child_process";
import type { GraphState, GraphNode, ConceptCluster, SearchResult } from "./types.ts";

const INFERENCE_PATH = join(
  process.env.HOME || "~",
  ".claude",
  "skills",
  "CORE",
  "Tools",
  "Inference.ts"
);

const DEFAULT_STATE_PATH = join(
  process.env.HOME || "~",
  ".claude",
  "MEMORY",
  "State",
  "knowledge-graph.json"
);

const DEFAULT_VAULT = "/Users/[user]/Desktop/obsidian";

// ============================================
// INFERENCE INTEGRATION
// ============================================

/**
 * Run inference using the Kaya Inference tool.
 * Falls back to local summarization if inference is unavailable.
 */
async function runInference(
  systemPrompt: string,
  userPrompt: string,
  level: "fast" | "standard" = "fast"
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", [INFERENCE_PATH, "--level", level, systemPrompt, userPrompt], {
      timeout: level === "fast" ? 30000 : 60000,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code: number) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        // Fall back to local summary
        resolve(localSummarize(userPrompt));
      }
    });

    proc.on("error", () => {
      resolve(localSummarize(userPrompt));
    });
  });
}

/**
 * Simple local summarization fallback (no AI needed).
 * Extracts key structural elements from the content.
 */
function localSummarize(content: string): string {
  const lines = content.split("\n");
  const headings = lines
    .filter((l) => l.match(/^#{1,3}\s/))
    .map((l) => l.replace(/^#+\s+/, "").trim());

  const bullets = lines
    .filter((l) => l.match(/^[-*]\s/))
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .slice(0, 10);

  const summary: string[] = [];
  if (headings.length > 0) {
    summary.push("Key topics: " + headings.slice(0, 5).join(", "));
  }
  if (bullets.length > 0) {
    summary.push("Key points:");
    for (const b of bullets.slice(0, 5)) {
      summary.push(`  - ${b}`);
    }
  }

  return summary.join("\n") || "No structural content to summarize.";
}

// ============================================
// NOTE SUMMARIZATION
// ============================================

/**
 * Read and summarize a single note.
 */
export async function summarizeNote(
  nodeId: string,
  state: GraphState,
  vaultRoot: string = DEFAULT_VAULT,
  useInference: boolean = true
): Promise<string> {
  const node = state.nodes.find((n) => n.id === nodeId);
  if (!node) return `Note not found: ${nodeId}`;

  const filePath = join(vaultRoot, nodeId);
  if (!existsSync(filePath)) return `File not found: ${filePath}`;

  const content = readFileSync(filePath, "utf-8");

  // Build context about the note's position in the graph
  const context = buildNodeContext(node, state);

  if (!useInference) {
    return formatLocalSummary(node, content, context);
  }

  const systemPrompt = `You are a knowledge graph navigator summarizing notes for someone with aphantasia who thinks in concepts and words, not images. Be concise, structured, and concept-first. Use lists and explicit connections. No spatial or visual metaphors.`;

  const userPrompt = `Summarize this note from my knowledge vault. Include:
1. Core concept (1 sentence)
2. Key points (3-5 bullets)
3. Connections to other topics (based on links/tags)
4. What this enables understanding of

Note: "${node.title}"
Folder: ${node.folder || "(root)"}
Tags: ${node.tags.join(", ") || "(none)"}
${context}

Content:
${content.slice(0, 3000)}`;

  try {
    return await runInference(systemPrompt, userPrompt, "fast");
  } catch {
    return formatLocalSummary(node, content, context);
  }
}

/**
 * Build context string about a node's graph position.
 */
function buildNodeContext(node: GraphNode, state: GraphState): string {
  const parts: string[] = [];

  if (node.outLinks.length > 0) {
    const linkTitles = node.outLinks
      .map((id) => {
        const target = state.nodes.find((n) => n.id === id);
        return target?.title || basename(id, ".md");
      })
      .slice(0, 5);
    parts.push(`Links to: ${linkTitles.join(", ")}`);
  }

  if (node.inLinks.length > 0) {
    const linkTitles = node.inLinks
      .map((id) => {
        const source = state.nodes.find((n) => n.id === id);
        return source?.title || basename(id, ".md");
      })
      .slice(0, 5);
    parts.push(`Linked from: ${linkTitles.join(", ")}`);
  }

  // Find which cluster this note belongs to
  for (const cluster of state.clusters) {
    if (cluster.nodes.includes(node.id)) {
      parts.push(`Cluster: ${cluster.label} (${cluster.nodes.length} notes)`);
      break;
    }
  }

  return parts.join("\n");
}

/**
 * Format a local (non-AI) summary.
 */
function formatLocalSummary(
  node: GraphNode,
  content: string,
  context: string
): string {
  const lines: string[] = [
    `# ${node.title}`,
    "",
    `Folder: ${node.folder || "(root)"}`,
    `Tags: ${node.tags.join(", ") || "(none)"}`,
    `Word count: ${node.wordCount}`,
    "",
  ];

  if (node.headings.length > 0) {
    lines.push("## Topics Covered");
    for (const h of node.headings) {
      lines.push(`- ${h}`);
    }
    lines.push("");
  }

  if (context) {
    lines.push("## Graph Position");
    lines.push(context);
    lines.push("");
  }

  // Extract first meaningful paragraph
  const body = content.replace(/^---[\s\S]*?---\s*/, "").replace(/^#[^\n]+\n/, "");
  const firstPara = body
    .split("\n\n")
    .find((p) => p.trim().length > 30 && !p.startsWith("#"));
  if (firstPara) {
    lines.push("## Opening");
    lines.push(firstPara.trim().slice(0, 300));
  }

  return lines.join("\n");
}

// ============================================
// CLUSTER SUMMARIZATION
// ============================================

/**
 * Summarize an entire cluster of notes.
 */
export async function summarizeCluster(
  clusterId: string,
  state: GraphState,
  vaultRoot: string = DEFAULT_VAULT,
  useInference: boolean = true
): Promise<string> {
  const cluster = state.clusters.find((c) => c.id === clusterId);
  if (!cluster) return `Cluster not found: ${clusterId}`;

  // Collect titles, tags, and brief descriptions
  const noteDescriptions = cluster.nodes.slice(0, 20).map((nodeId) => {
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node) return "";
    return `- "${node.title}" (${node.folder}) [${node.tags.slice(0, 3).join(", ")}] - ${node.wordCount} words, ${node.headings.slice(0, 3).join(", ")}`;
  }).filter(Boolean);

  const bridgeInfo = cluster.bridgeNotes.length > 0
    ? `Bridge notes connecting to other clusters: ${cluster.bridgeNotes.map((id) => {
        const node = state.nodes.find((n) => n.id === id);
        return node?.title || id;
      }).join(", ")}`
    : "No bridge notes to other clusters.";

  if (!useInference) {
    return formatLocalClusterSummary(cluster, noteDescriptions, bridgeInfo, state);
  }

  const systemPrompt = `You are a knowledge graph navigator summarizing a cluster of related notes. The user has aphantasia and thinks in concepts and words. Be structured, use lists, and make connections explicit. No visual metaphors.`;

  const userPrompt = `Summarize this knowledge cluster from my Obsidian vault:

Cluster: "${cluster.label}"
Notes: ${cluster.nodes.length}
Dominant tags: ${cluster.tags.join(", ")}
Density: ${(cluster.density * 100).toFixed(1)}%
${bridgeInfo}

Notes in this cluster:
${noteDescriptions.join("\n")}

Provide:
1. What this cluster is about (1-2 sentences)
2. Key themes/concepts (3-5 bullets)
3. How notes relate to each other
4. Connections to other knowledge areas (via bridges)
5. What's missing or could be expanded`;

  try {
    return await runInference(systemPrompt, userPrompt, "fast");
  } catch {
    return formatLocalClusterSummary(cluster, noteDescriptions, bridgeInfo, state);
  }
}

function formatLocalClusterSummary(
  cluster: ConceptCluster,
  noteDescriptions: string[],
  bridgeInfo: string,
  state: GraphState
): string {
  return [
    `# Cluster: ${cluster.label}`,
    "",
    `Size: ${cluster.nodes.length} notes`,
    `Tags: ${cluster.tags.join(", ")}`,
    `Density: ${(cluster.density * 100).toFixed(1)}%`,
    "",
    "## Notes",
    ...noteDescriptions,
    "",
    "## Connections",
    bridgeInfo,
  ].join("\n");
}

// ============================================
// QUERY-BASED SUMMARIZATION
// ============================================

/**
 * Answer a "what do I know about X?" question using search results.
 */
export async function answerQuery(
  query: string,
  searchResults: SearchResult[],
  state: GraphState,
  vaultRoot: string = DEFAULT_VAULT,
  useInference: boolean = true
): Promise<string> {
  if (searchResults.length === 0) {
    return `I couldn't find any notes related to "${query}" in your vault.`;
  }

  // Read top results
  const topResults = searchResults.slice(0, 5);
  const noteContents = topResults.map((r) => {
    const filePath = join(vaultRoot, r.nodeId);
    let content = "";
    try {
      content = readFileSync(filePath, "utf-8").slice(0, 1000);
    } catch {
      content = "(content unavailable)";
    }
    return {
      title: r.title,
      folder: r.folder,
      score: r.score,
      matchedTerms: r.matchedTerms,
      content,
    };
  });

  if (!useInference) {
    return formatLocalQueryAnswer(query, noteContents);
  }

  const systemPrompt = `You are a knowledge graph navigator answering questions about the user's personal knowledge vault. The user has aphantasia and thinks in concepts and words. Be direct, structured, and concept-first. Cite specific note titles.`;

  const userPrompt = `Answer this question about my knowledge vault: "${query}"

Top matching notes:
${noteContents.map((n, i) =>
  `${i + 1}. "${n.title}" (${n.folder}) - ${(n.score * 100).toFixed(0)}% match
   Matched: ${n.matchedTerms.join(", ")}
   Content preview: ${n.content.slice(0, 400)}`
).join("\n\n")}

Provide:
1. Direct answer to the question
2. What specific notes cover this topic
3. Key concepts from those notes
4. Related areas to explore
5. Any knowledge gaps (topics mentioned but not covered)`;

  try {
    return await runInference(systemPrompt, userPrompt, "fast");
  } catch {
    return formatLocalQueryAnswer(query, noteContents);
  }
}

function formatLocalQueryAnswer(
  query: string,
  results: { title: string; folder: string; score: number; matchedTerms: string[]; content: string }[]
): string {
  const lines: string[] = [
    `# What I know about: ${query}`,
    "",
    `Found ${results.length} relevant notes:`,
    "",
  ];

  for (const r of results) {
    lines.push(`## ${r.title} (${r.folder})`);
    lines.push(`Relevance: ${(r.score * 100).toFixed(0)}%`);
    lines.push(`Matched concepts: ${r.matchedTerms.join(", ")}`);
    lines.push("");
    // Extract first meaningful paragraph
    const body = r.content.replace(/^---[\s\S]*?---\s*/, "").trim();
    const firstPara = body.split("\n\n").find((p) => p.trim().length > 20);
    if (firstPara) {
      lines.push(firstPara.trim().slice(0, 200));
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ============================================
// CLI
// ============================================

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
NoteSummarizer - AI-Powered Summarization

Usage:
  bun NoteSummarizer.ts --note <nodeId>           # Summarize note
  bun NoteSummarizer.ts --cluster <clusterId>     # Summarize cluster
  bun NoteSummarizer.ts --no-ai --note <id>       # Local summary (no AI)

Options:
  --note <nodeId>      Summarize a specific note
  --cluster <id>       Summarize a cluster
  --no-ai              Use local summarization only (no Inference)
  --help               Show this help
`);
    process.exit(0);
  }

  if (!existsSync(DEFAULT_STATE_PATH)) {
    console.error("No graph state found. Run GraphBuilder --rebuild first.");
    process.exit(1);
  }

  const state: GraphState = await loadGraphState(DEFAULT_STATE_PATH);

  const useInference = !args.includes("--no-ai");

  const noteIdx = args.indexOf("--note");
  if (noteIdx >= 0) {
    const nodeId = args[noteIdx + 1];
    if (!nodeId) {
      console.error("Usage: --note <nodeId>");
      process.exit(1);
    }
    const summary = await summarizeNote(nodeId, state, DEFAULT_VAULT, useInference);
    console.log(summary);
    return;
  }

  const clusterIdx = args.indexOf("--cluster");
  if (clusterIdx >= 0) {
    const clusterId = args[clusterIdx + 1];
    if (!clusterId) {
      console.error("Usage: --cluster <clusterId>");
      process.exit(1);
    }
    const summary = await summarizeCluster(clusterId, state, DEFAULT_VAULT, useInference);
    console.log(summary);
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
