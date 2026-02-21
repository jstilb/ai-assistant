#!/usr/bin/env bun
// TraceVisualizer.ts - Mermaid diagram generation for ContextGraph
//
// Generates Mermaid markdown diagrams from the decision graph for
// rendering in GitHub, Obsidian, and CLI-based viewers.
//
// Features:
//   - Decision chain flowcharts (trace from a root node)
//   - High-level overview graphs (pattern nodes as anchors)
//   - Temporal timeline views
//   - Session-scoped views
//   - Goal-aligned decision views
//
// CLI:
//   bun TraceVisualizer.ts --trace <nodeId>
//   bun TraceVisualizer.ts --session <sessionId>
//   bun TraceVisualizer.ts --goal G25
//   bun TraceVisualizer.ts --overview --period month
//   bun TraceVisualizer.ts --timeline --since 7d
//   bun TraceVisualizer.ts --help
//
// @module ContextGraph/TraceVisualizer
// @version 1.0.0

import { createGraphManager, type GraphManager } from "./GraphManager";
import type {
  DecisionNode,
  DecisionEdge,
  DecisionNodeType,
  DecisionEdgeType,
  ContextGraphState,
} from "./types";

// ============================================
// STYLE CONFIG
// ============================================

const NODE_SHAPES: Record<DecisionNodeType, [string, string]> = {
  decision: ["[", "]"],
  context: ["(", ")"],
  outcome: ["{", "}"],
  pattern: ["[[", "]]"],
  goal: ["((", "))"],
  session: [">", "]"],
};

const EDGE_STYLES: Record<DecisionEdgeType, string> = {
  caused: "-->",
  influenced: "-.->",
  preceded: "-->",
  outcome_of: "==>",
  context_for: "-.->",
  pattern_member: "---",
  goal_aligned: "-.->",
  supersedes: "--x",
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

function sanitizeMermaid(s: string): string {
  return s.replace(/["\[\]{}()#<>|]/g, " ").replace(/\s+/g, " ").trim();
}

function formatNodeLabel(node: DecisionNode): string {
  const [open, close] = NODE_SHAPES[node.type] || ["[", "]"];
  const label = sanitizeMermaid(truncate(node.title, 60));
  return `${node.id}${open}"${label}"${close}`;
}

function formatEdgeLabel(edge: DecisionEdge): string {
  const style = EDGE_STYLES[edge.type] || "-->";
  const label = edge.type.replace(/_/g, " ");
  return `${edge.source} ${style}|${label}| ${edge.target}`;
}

// ============================================
// DIAGRAM GENERATORS
// ============================================

/**
 * Generate a Mermaid flowchart from a decision chain trace.
 */
export async function generateMermaidTrace(
  gm: GraphManager,
  rootNodeId: string,
  maxDepth: number = 5
): Promise<string> {
  const trace = await gm.traceDecisionChain(rootNodeId, maxDepth);

  if (!trace.root) {
    return `%% Node not found: ${rootNodeId}`;
  }

  const lines: string[] = [
    "flowchart TD",
    `  %% Decision trace from: ${sanitizeMermaid(trace.root.title)}`,
    `  %% Chain length: ${trace.chain.length} nodes, ${trace.edges.length} edges`,
    "",
  ];

  // Add node definitions
  for (const node of trace.chain) {
    lines.push(`  ${formatNodeLabel(node)}`);
  }

  lines.push("");

  // Add edges
  for (const edge of trace.edges) {
    lines.push(`  ${formatEdgeLabel(edge)}`);
  }

  // Add styling
  lines.push("");
  lines.push("  %% Styles");
  lines.push("  classDef decision fill:#4ecdc4,stroke:#333,color:#000");
  lines.push("  classDef outcome fill:#ff6b6b,stroke:#333,color:#000");
  lines.push("  classDef context fill:#95afc0,stroke:#333,color:#000");
  lines.push("  classDef pattern fill:#f9ca24,stroke:#333,color:#000");
  lines.push("  classDef goal fill:#6c5ce7,stroke:#fff,color:#fff");
  lines.push("  classDef session fill:#dfe6e9,stroke:#333,color:#000");

  // Apply classes
  for (const node of trace.chain) {
    lines.push(`  class ${node.id} ${node.type}`);
  }

  return lines.join("\n");
}

/**
 * Generate a high-level overview of the graph for a time period.
 */
export async function generateOverview(
  gm: GraphManager,
  period: "week" | "month" | "all" = "month"
): Promise<string> {
  const state = await gm.loadState();
  const allNodes = Object.values(state.nodes) as DecisionNode[];

  if (allNodes.length === 0) {
    return "flowchart TD\n  empty[No decisions in graph]";
  }

  // Filter by period
  const now = Date.now();
  let sinceMs = 0;
  switch (period) {
    case "week":
      sinceMs = now - 7 * 24 * 60 * 60 * 1000;
      break;
    case "month":
      sinceMs = now - 30 * 24 * 60 * 60 * 1000;
      break;
    case "all":
      sinceMs = 0;
      break;
  }

  const filtered = sinceMs > 0
    ? allNodes.filter((n) => new Date(n.timestamp).getTime() >= sinceMs)
    : allNodes;

  // Group by type for overview
  const byType = new Map<DecisionNodeType, DecisionNode[]>();
  for (const node of filtered) {
    const list = byType.get(node.type) || [];
    list.push(node);
    byType.set(node.type, list);
  }

  const lines: string[] = [
    "flowchart TD",
    `  %% ContextGraph Overview (${period})`,
    `  %% ${filtered.length} nodes total`,
    "",
  ];

  // Create summary nodes per type
  for (const [type, nodes] of byType) {
    const [open, close] = NODE_SHAPES[type] || ["[", "]"];
    lines.push(`  ${type}_summary${open}"${type}: ${nodes.length} nodes"${close}`);
  }

  lines.push("");

  // Show top 5 most connected nodes from each type
  const edges = Object.values(state.edges) as DecisionEdge[];
  const nodeEdgeCounts = new Map<string, number>();
  for (const edge of edges) {
    nodeEdgeCounts.set(edge.source, (nodeEdgeCounts.get(edge.source) || 0) + 1);
    nodeEdgeCounts.set(edge.target, (nodeEdgeCounts.get(edge.target) || 0) + 1);
  }

  const topNodes = filtered
    .filter((n) => nodeEdgeCounts.has(n.id))
    .sort(
      (a, b) =>
        (nodeEdgeCounts.get(b.id) || 0) - (nodeEdgeCounts.get(a.id) || 0)
    )
    .slice(0, 15);

  for (const node of topNodes) {
    lines.push(`  ${formatNodeLabel(node)}`);
  }

  lines.push("");

  // Add edges between top nodes
  const topNodeIds = new Set(topNodes.map((n) => n.id));
  for (const edge of edges) {
    if (topNodeIds.has(edge.source) && topNodeIds.has(edge.target)) {
      lines.push(`  ${formatEdgeLabel(edge)}`);
    }
  }

  // Connect summary nodes to top nodes
  lines.push("");
  for (const node of topNodes) {
    lines.push(`  ${node.type}_summary -.-> ${node.id}`);
  }

  // Styling
  lines.push("");
  lines.push("  classDef decision fill:#4ecdc4,stroke:#333,color:#000");
  lines.push("  classDef outcome fill:#ff6b6b,stroke:#333,color:#000");
  lines.push("  classDef context fill:#95afc0,stroke:#333,color:#000");
  lines.push("  classDef pattern fill:#f9ca24,stroke:#333,color:#000");
  lines.push("  classDef goal fill:#6c5ce7,stroke:#fff,color:#fff");
  lines.push("  classDef session fill:#dfe6e9,stroke:#333,color:#000");

  for (const node of topNodes) {
    lines.push(`  class ${node.id} ${node.type}`);
  }

  return lines.join("\n");
}

/**
 * Generate a temporal timeline view of decisions.
 */
export async function generateTimeline(
  gm: GraphManager,
  since: string = "7d",
  until?: string
): Promise<string> {
  const state = await gm.loadState();
  const allNodes = Object.values(state.nodes) as DecisionNode[];

  // Parse since
  const sinceDate = parseSinceDate(since);
  const untilDate = until ? new Date(until) : new Date();

  const filtered = allNodes
    .filter((n) => {
      const ts = new Date(n.timestamp);
      return ts >= sinceDate && ts <= untilDate;
    })
    .sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

  if (filtered.length === 0) {
    return `flowchart LR\n  empty[No decisions in timeframe]`;
  }

  // Group by day
  const byDay = new Map<string, DecisionNode[]>();
  for (const node of filtered) {
    const day = new Date(node.timestamp).toISOString().slice(0, 10);
    const list = byDay.get(day) || [];
    list.push(node);
    byDay.set(day, list);
  }

  const lines: string[] = [
    "flowchart LR",
    `  %% Timeline: ${sinceDate.toISOString().slice(0, 10)} to ${untilDate.toISOString().slice(0, 10)}`,
    `  %% ${filtered.length} decisions`,
    "",
  ];

  let prevDayId: string | null = null;
  for (const [day, nodes] of byDay) {
    const dayId = `day_${day.replace(/-/g, "")}`;
    lines.push(`  ${dayId}["${day}: ${nodes.length} decisions"]`);

    if (prevDayId) {
      lines.push(`  ${prevDayId} --> ${dayId}`);
    }

    // Show up to 3 most important nodes per day
    const importantNodes = nodes
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);

    for (const node of importantNodes) {
      lines.push(`  ${formatNodeLabel(node)}`);
      lines.push(`  ${dayId} --> ${node.id}`);
    }

    prevDayId = dayId;
  }

  // Styling
  lines.push("");
  lines.push("  classDef decision fill:#4ecdc4,stroke:#333,color:#000");
  lines.push("  classDef outcome fill:#ff6b6b,stroke:#333,color:#000");
  lines.push("  classDef context fill:#95afc0,stroke:#333,color:#000");
  lines.push("  classDef pattern fill:#f9ca24,stroke:#333,color:#000");

  for (const node of filtered.slice(0, 30)) {
    lines.push(`  class ${node.id} ${node.type}`);
  }

  return lines.join("\n");
}

// ============================================
// HELPERS
// ============================================

function parseSinceDate(since: string): Date {
  const match = since.match(/^(\d+)(d|h|m|w)$/);
  if (!match) {
    const d = new Date(since);
    if (!isNaN(d.getTime())) return d;
    return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  }
  const [, numStr, unit] = match;
  const num = parseInt(numStr, 10);
  const now = Date.now();
  switch (unit) {
    case "m": return new Date(now - num * 60 * 1000);
    case "h": return new Date(now - num * 60 * 60 * 1000);
    case "d": return new Date(now - num * 24 * 60 * 60 * 1000);
    case "w": return new Date(now - num * 7 * 24 * 60 * 60 * 1000);
    default: return new Date(now - 7 * 24 * 60 * 60 * 1000);
  }
}

// ============================================
// CLI INTERFACE
// ============================================

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
TraceVisualizer - Mermaid diagram generation for ContextGraph

Usage:
  bun TraceVisualizer.ts --trace <nodeId>           Decision chain flowchart
  bun TraceVisualizer.ts --trace <nodeId> --depth 5 With max depth
  bun TraceVisualizer.ts --overview --period month   High-level overview
  bun TraceVisualizer.ts --overview --period week    Weekly overview
  bun TraceVisualizer.ts --overview --period all     Full graph overview
  bun TraceVisualizer.ts --timeline --since 7d       Temporal timeline
  bun TraceVisualizer.ts --goal G25                  Goal-aligned decisions
  bun TraceVisualizer.ts --help                      Show this help

Output:
  Mermaid markdown to stdout. Pipe to a .md file for rendering.
  Example: bun TraceVisualizer.ts --overview > graph.md
`);
    process.exit(0);
  }

  const gm = createGraphManager();

  try {
    if (args.includes("--trace")) {
      const traceIdx = args.indexOf("--trace");
      const nodeId = args[traceIdx + 1];
      if (!nodeId) {
        console.error("Error: --trace requires a node ID");
        process.exit(1);
      }
      let depth = 5;
      const depthIdx = args.indexOf("--depth");
      if (depthIdx !== -1 && args[depthIdx + 1]) {
        depth = parseInt(args[depthIdx + 1], 10) || 5;
      }
      const mermaid = await generateMermaidTrace(gm, nodeId, depth);
      console.log(mermaid);
      return;
    }

    if (args.includes("--overview")) {
      let period: "week" | "month" | "all" = "month";
      const periodIdx = args.indexOf("--period");
      if (periodIdx !== -1 && args[periodIdx + 1]) {
        period = args[periodIdx + 1] as "week" | "month" | "all";
      }
      const mermaid = await generateOverview(gm, period);
      console.log(mermaid);
      return;
    }

    if (args.includes("--timeline")) {
      let since = "7d";
      const sinceIdx = args.indexOf("--since");
      if (sinceIdx !== -1 && args[sinceIdx + 1]) {
        since = args[sinceIdx + 1];
      }
      let until: string | undefined;
      const untilIdx = args.indexOf("--until");
      if (untilIdx !== -1 && args[untilIdx + 1]) {
        until = args[untilIdx + 1];
      }
      const mermaid = await generateTimeline(gm, since, until);
      console.log(mermaid);
      return;
    }

    if (args.includes("--goal")) {
      const goalIdx = args.indexOf("--goal");
      const goalId = args[goalIdx + 1];
      if (!goalId) {
        console.error("Error: --goal requires a goal ID");
        process.exit(1);
      }

      const decisions = await gm.decisionsByGoal(goalId);
      if (decisions.length === 0) {
        console.log(`flowchart TD\n  empty[No decisions aligned with ${goalId}]`);
        return;
      }

      const lines: string[] = [
        "flowchart TD",
        `  %% Decisions aligned with goal: ${goalId}`,
        `  %% ${decisions.length} decisions found`,
        "",
        `  ${goalId}(("${goalId}"))`,
        "",
      ];

      for (const node of decisions.slice(0, 20)) {
        lines.push(`  ${formatNodeLabel(node)}`);
        lines.push(`  ${goalId} -.->|goal aligned| ${node.id}`);
      }

      lines.push("");
      lines.push("  classDef decision fill:#4ecdc4,stroke:#333,color:#000");
      lines.push("  classDef outcome fill:#ff6b6b,stroke:#333,color:#000");
      lines.push("  classDef goal fill:#6c5ce7,stroke:#fff,color:#fff");
      lines.push(`  class ${goalId} goal`);
      for (const node of decisions.slice(0, 20)) {
        lines.push(`  class ${node.id} ${node.type}`);
      }

      console.log(lines.join("\n"));
      return;
    }

    // Default: show overview for the month
    const mermaid = await generateOverview(gm, "month");
    console.log(mermaid);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  runCli();
}
