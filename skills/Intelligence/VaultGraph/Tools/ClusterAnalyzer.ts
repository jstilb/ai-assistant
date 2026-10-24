#!/usr/bin/env bun
/**
 * ClusterAnalyzer - Community Detection and Bridge Note Identification
 *
 * Implements label propagation algorithm for community detection on
 * the knowledge graph. Identifies concept clusters, bridge notes
 * (high betweenness centrality approximation), and cluster density.
 *
 * Algorithm: Label Propagation
 *   1. Each node starts with a unique label (its own ID)
 *   2. In each iteration, each node adopts the most frequent label
 *      among its neighbors (weighted by edge weight)
 *   3. Repeat until convergence or max iterations
 *   4. Nodes with the same label form a cluster
 *
 * CLI:
 *   bun ClusterAnalyzer.ts --analyze               # Run clustering
 *   bun ClusterAnalyzer.ts --bridges               # Show bridge notes
 *   bun ClusterAnalyzer.ts --cluster <id>           # Show cluster details
 */

import { existsSync } from "fs";
import { join } from "path";
import { loadGraphState, saveGraphState } from "./GraphBuilder";
import type {
  GraphState,
  GraphNode,
  GraphEdge,
  ConceptCluster,
  EdgeType,
} from "./types.ts";

// ============================================
// LABEL PROPAGATION ALGORITHM
// ============================================

/**
 * Build adjacency list with edge weights from graph state.
 * Only considers explicit link types (wikilink, embed) for clustering,
 * plus tag edges for additional signal.
 */
function buildAdjacency(
  state: GraphState,
  edgeTypes: EdgeType[] = ["wikilink", "embed", "tag", "folder"]
): Map<string, Map<string, number>> {
  const adj = new Map<string, Map<string, number>>();

  for (const node of state.nodes) {
    adj.set(node.id, new Map());
  }

  for (const edge of state.edges) {
    if (!edgeTypes.includes(edge.type)) continue;

    const sourceNeighbors = adj.get(edge.source);
    const targetNeighbors = adj.get(edge.target);

    if (sourceNeighbors) {
      const existing = sourceNeighbors.get(edge.target) || 0;
      sourceNeighbors.set(edge.target, existing + edge.weight);
    }
    if (targetNeighbors) {
      const existing = targetNeighbors.get(edge.source) || 0;
      targetNeighbors.set(edge.source, existing + edge.weight);
    }
  }

  return adj;
}

/**
 * Run label propagation community detection.
 * Returns a map of nodeId -> clusterId.
 */
export function labelPropagation(
  state: GraphState,
  maxIterations: number = 50
): Map<string, string> {
  const adj = buildAdjacency(state);
  const labels = new Map<string, string>();

  // Initialize: each node is its own label
  for (const node of state.nodes) {
    labels.set(node.id, node.id);
  }

  // Iterate
  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;

    // Shuffle node order for each iteration (deterministic shuffle)
    const nodeIds = [...state.nodes.map((n) => n.id)];
    for (let i = nodeIds.length - 1; i > 0; i--) {
      const j = (i * 7 + iter * 13) % (i + 1); // Deterministic pseudo-shuffle
      [nodeIds[i], nodeIds[j]] = [nodeIds[j], nodeIds[i]];
    }

    for (const nodeId of nodeIds) {
      const neighbors = adj.get(nodeId);
      if (!neighbors || neighbors.size === 0) continue;

      // Count weighted labels among neighbors
      const labelWeights = new Map<string, number>();
      for (const [neighbor, weight] of neighbors) {
        const neighborLabel = labels.get(neighbor)!;
        labelWeights.set(
          neighborLabel,
          (labelWeights.get(neighborLabel) || 0) + weight
        );
      }

      // Find the most frequent label
      let bestLabel = labels.get(nodeId)!;
      let bestWeight = 0;
      for (const [label, weight] of labelWeights) {
        if (weight > bestWeight) {
          bestWeight = weight;
          bestLabel = label;
        }
      }

      if (bestLabel !== labels.get(nodeId)) {
        labels.set(nodeId, bestLabel);
        changed = true;
      }
    }

    if (!changed) break;
  }

  return labels;
}

// ============================================
// CLUSTER CONSTRUCTION
// ============================================

/**
 * Convert label map to cluster objects with metadata.
 */
export function buildClusters(
  state: GraphState,
  labels: Map<string, string>
): ConceptCluster[] {
  // Group nodes by label
  const clusterNodes = new Map<string, string[]>();
  for (const [nodeId, label] of labels) {
    if (!clusterNodes.has(label)) clusterNodes.set(label, []);
    clusterNodes.get(label)!.push(nodeId);
  }

  const nodeIndex = new Map(state.nodes.map((n) => [n.id, n]));
  const clusters: ConceptCluster[] = [];
  let clusterIdx = 0;

  for (const [_label, nodeIds] of clusterNodes) {
    if (nodeIds.length < 2) continue; // Skip singleton clusters

    const clusterNode = nodeIds.map((id) => nodeIndex.get(id)!).filter(Boolean);

    // Compute dominant tags
    const tagCounts = new Map<string, number>();
    for (const node of clusterNode) {
      for (const tag of node.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }
    const sortedTags = [...tagCounts.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([tag]) => tag);

    // Compute dominant folders
    const folderCounts = new Map<string, number>();
    for (const node of clusterNode) {
      if (node.folder) {
        folderCounts.set(node.folder, (folderCounts.get(node.folder) || 0) + 1);
      }
    }
    const dominantFolder = [...folderCounts.entries()]
      .sort(([, a], [, b]) => b - a)
      .map(([f]) => f)[0] || "Mixed";

    // Generate cluster label from dominant folder and tags
    const label = generateClusterLabel(dominantFolder, sortedTags, nodeIds.length);

    // Compute internal density
    const nodeSet = new Set(nodeIds);
    let internalEdges = 0;
    for (const edge of state.edges) {
      if (nodeSet.has(edge.source) && nodeSet.has(edge.target)) {
        internalEdges++;
      }
    }
    const possibleEdges = (nodeIds.length * (nodeIds.length - 1)) / 2;
    const density = possibleEdges > 0 ? internalEdges / possibleEdges : 0;

    clusters.push({
      id: `cluster-${clusterIdx++}`,
      label,
      nodes: nodeIds,
      tags: sortedTags,
      bridgeNotes: [], // Computed separately
      density,
    });
  }

  // Sort by size descending
  clusters.sort((a, b) => b.nodes.length - a.nodes.length);

  return clusters;
}

/**
 * Generate a human-readable cluster label.
 */
function generateClusterLabel(
  dominantFolder: string,
  topTags: string[],
  size: number
): string {
  if (dominantFolder && dominantFolder !== "Mixed") {
    const tagSuffix =
      topTags.length > 0 && !dominantFolder.toLowerCase().includes(topTags[0])
        ? ` (${topTags[0]})`
        : "";
    return `${dominantFolder}${tagSuffix}`;
  }
  if (topTags.length > 0) {
    return topTags.slice(0, 2).join(" + ");
  }
  return `Cluster (${size} notes)`;
}

// ============================================
// BRIDGE NOTE DETECTION
// ============================================

/**
 * Approximate betweenness centrality using random sampling.
 * Full betweenness is O(V*E), so we sample a subset of shortest paths.
 *
 * A bridge note connects multiple clusters. We detect bridge notes as
 * nodes that have neighbors in 2+ different clusters.
 */
export function detectBridgeNotes(
  state: GraphState,
  clusters: ConceptCluster[]
): Map<string, string[]> {
  // Build nodeId -> clusterId map
  const nodeToCluster = new Map<string, string>();
  for (const cluster of clusters) {
    for (const nodeId of cluster.nodes) {
      nodeToCluster.set(nodeId, cluster.id);
    }
  }

  // Build adjacency
  const adj = buildAdjacency(state, ["wikilink", "embed"]);

  // Find nodes that connect different clusters
  const bridgeNotes = new Map<string, string[]>(); // nodeId -> [clusterId, ...]

  for (const node of state.nodes) {
    const nodeCluster = nodeToCluster.get(node.id);
    if (!nodeCluster) continue;

    const neighbors = adj.get(node.id);
    if (!neighbors) continue;

    const connectedClusters = new Set<string>();
    connectedClusters.add(nodeCluster);

    for (const [neighbor] of neighbors) {
      const neighborCluster = nodeToCluster.get(neighbor);
      if (neighborCluster && neighborCluster !== nodeCluster) {
        connectedClusters.add(neighborCluster);
      }
    }

    if (connectedClusters.size >= 2) {
      bridgeNotes.set(node.id, [...connectedClusters]);
    }
  }

  return bridgeNotes;
}

/**
 * Assign bridge notes to their clusters.
 */
function assignBridgeNotes(
  clusters: ConceptCluster[],
  bridgeNotes: Map<string, string[]>
): void {
  for (const cluster of clusters) {
    cluster.bridgeNotes = [];
    for (const [nodeId, connectedClusters] of bridgeNotes) {
      if (connectedClusters.includes(cluster.id)) {
        cluster.bridgeNotes.push(nodeId);
      }
    }
  }
}

// ============================================
// MAIN ANALYSIS
// ============================================

/**
 * Run complete cluster analysis: detection, labeling, bridge notes.
 * Returns updated graph state with clusters populated.
 */
export function analyzeGraph(state: GraphState): GraphState {
  // Run label propagation
  const labels = labelPropagation(state);

  // Build clusters
  const clusters = buildClusters(state, labels);

  // Detect bridge notes
  const bridgeNotes = detectBridgeNotes(state, clusters);

  // Assign bridge notes to clusters
  assignBridgeNotes(clusters, bridgeNotes);

  // Update state
  return {
    ...state,
    clusters,
    stats: {
      ...state.stats,
      clusterCount: clusters.length,
    },
  };
}

// ============================================
// FORMATTING
// ============================================

function formatClusters(state: GraphState): string {
  const lines: string[] = [
    "Knowledge Graph Clusters",
    "=".repeat(40),
    "",
    `Total clusters: ${state.clusters.length}`,
    "",
  ];

  for (const cluster of state.clusters) {
    lines.push(`--- ${cluster.label} (${cluster.nodes.length} notes) ---`);
    lines.push(`  ID: ${cluster.id}`);
    lines.push(`  Tags: ${cluster.tags.join(", ") || "(none)"}`);
    lines.push(`  Density: ${(cluster.density * 100).toFixed(1)}%`);
    lines.push(`  Bridge notes: ${cluster.bridgeNotes.length}`);
    if (cluster.bridgeNotes.length > 0) {
      for (const bn of cluster.bridgeNotes.slice(0, 3)) {
        lines.push(`    - ${bn}`);
      }
    }
    // Show top 5 notes
    lines.push(`  Notes (top 5):`);
    for (const nodeId of cluster.nodes.slice(0, 5)) {
      const node = state.nodes.find((n) => n.id === nodeId);
      lines.push(`    - ${node?.title || nodeId}`);
    }
    if (cluster.nodes.length > 5) {
      lines.push(`    ... and ${cluster.nodes.length - 5} more`);
    }
    lines.push("");
  }

  // Bridge note summary
  const allBridges = new Set<string>();
  for (const c of state.clusters) {
    for (const b of c.bridgeNotes) {
      allBridges.add(b);
    }
  }
  if (allBridges.size > 0) {
    lines.push("Bridge Notes (connecting clusters):");
    for (const bn of [...allBridges].slice(0, 10)) {
      const node = state.nodes.find((n) => n.id === bn);
      lines.push(`  - ${node?.title || bn} (${bn})`);
    }
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

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
ClusterAnalyzer - Community Detection

Usage:
  bun ClusterAnalyzer.ts --analyze                # Run clustering
  bun ClusterAnalyzer.ts --bridges                # Show bridge notes
  bun ClusterAnalyzer.ts --cluster <id>           # Show cluster details
  bun ClusterAnalyzer.ts --json                   # JSON output

Options:
  --analyze          Run label propagation clustering
  --bridges          List bridge notes connecting clusters
  --cluster <id>     Show details of a specific cluster
  --json             Output as JSON
  --help             Show this help
`);
    process.exit(0);
  }

  if (!existsSync(DEFAULT_STATE_PATH)) {
    console.error("No graph state found. Run GraphBuilder --rebuild first.");
    process.exit(1);
  }

  let state: GraphState = await loadGraphState(DEFAULT_STATE_PATH);

  if (args.includes("--analyze")) {
    console.log("Running cluster analysis...");
    const startTime = Date.now();

    state = analyzeGraph(state);
    const elapsed = Date.now() - startTime;

    // Save updated state with clusters via StateManager
    await saveGraphState(state, DEFAULT_STATE_PATH);

    console.log(`Analysis complete in ${elapsed}ms\n`);

    if (args.includes("--json")) {
      console.log(JSON.stringify(state.clusters, null, 2));
    } else {
      console.log(formatClusters(state));
    }
    return;
  }

  if (args.includes("--bridges")) {
    if (state.clusters.length === 0) {
      console.error("No clusters found. Run --analyze first.");
      process.exit(1);
    }
    const allBridges = new Set<string>();
    for (const c of state.clusters) {
      for (const b of c.bridgeNotes) {
        allBridges.add(b);
      }
    }
    console.log(`Bridge notes: ${allBridges.size}\n`);
    for (const bn of allBridges) {
      const node = state.nodes.find((n) => n.id === bn);
      console.log(`  - ${node?.title || bn}`);
    }
    return;
  }

  const clusterIdx = args.indexOf("--cluster");
  if (clusterIdx >= 0) {
    const clusterId = args[clusterIdx + 1];
    const cluster = state.clusters.find((c) => c.id === clusterId);
    if (!cluster) {
      console.error(`Cluster ${clusterId} not found.`);
      console.error(`Available: ${state.clusters.map((c) => c.id).join(", ")}`);
      process.exit(1);
    }
    if (args.includes("--json")) {
      console.log(JSON.stringify(cluster, null, 2));
    } else {
      console.log(`Cluster: ${cluster.label}`);
      console.log(`Notes: ${cluster.nodes.length}`);
      console.log(`Tags: ${cluster.tags.join(", ")}`);
      console.log(`Density: ${(cluster.density * 100).toFixed(1)}%`);
      console.log(`\nAll notes:`);
      for (const nodeId of cluster.nodes) {
        const node = state.nodes.find((n) => n.id === nodeId);
        console.log(`  - ${node?.title || nodeId}`);
      }
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
