#!/usr/bin/env bun
/**
 * GraphManager.ts - Core graph operations for ContextGraph
 *
 * Event-sourced graph manager that persists all mutations to events.jsonl
 * and maintains a materialized index in context-graph.json via StateManager.
 *
 * Features:
 *   - Event-sourced: all mutations append to events.jsonl (source of truth)
 *   - Materialized index via StateManager for fast reads
 *   - rebuildGraph() replays events.jsonl to reconstruct state
 *   - BFS decision chain tracing
 *   - Full-text search across decision content
 *   - TELOS goal alignment queries
 *
 * CLI:
 *   bun skills/ContextGraph/Tools/GraphManager.ts --stats
 *   bun skills/ContextGraph/Tools/GraphManager.ts --rebuild
 *   bun skills/ContextGraph/Tools/GraphManager.ts --search "query"
 *   bun skills/ContextGraph/Tools/GraphManager.ts --trace <nodeId>
 *   bun skills/ContextGraph/Tools/GraphManager.ts --trace <nodeId> --depth 5
 *   bun skills/ContextGraph/Tools/GraphManager.ts --by-goal G25
 *   bun skills/ContextGraph/Tools/GraphManager.ts --node <nodeId>
 *   bun skills/ContextGraph/Tools/GraphManager.ts --help
 *
 * @module ContextGraph/GraphManager
 * @version 1.0.0
 */

import { join, dirname } from "path";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "fs";
import { createStateManager } from "../../CORE/Tools/StateManager";
import { z } from "zod";
import type {
  DecisionNode,
  DecisionEdge,
  DecisionNodeType,
  DecisionEdgeType,
  GraphEvent,
  ContextGraphState,
  TraceResult,
  GraphSearchResult,
  GraphStatsSummary,
} from "./types";

// ============================================
// CONSTANTS
// ============================================

const BASE_DIR = join(process.env.HOME!, ".claude");
const EVENTS_FILE = join(BASE_DIR, "MEMORY", "ContextGraph", "events.jsonl");
const STATE_FILE = join(BASE_DIR, "MEMORY", "State", "context-graph.json");
const SNAPSHOTS_DIR = join(BASE_DIR, "MEMORY", "ContextGraph", "snapshots");

// ============================================
// STATE SCHEMA
// ============================================

const nodeTypeValues: DecisionNodeType[] = [
  "decision",
  "context",
  "outcome",
  "pattern",
  "goal",
  "session",
];
const edgeTypeValues: DecisionEdgeType[] = [
  "caused",
  "influenced",
  "preceded",
  "outcome_of",
  "context_for",
  "pattern_member",
  "goal_aligned",
  "supersedes",
];

const ContextGraphStateSchema = z.object({
  nodeCount: z.number(),
  edgeCount: z.number(),
  nodesByType: z.record(z.string(), z.number()),
  edgesByType: z.record(z.string(), z.number()),
  lastCapture: z.string(),
  version: z.number(),
  nodes: z.record(z.string(), z.any()),
  edges: z.record(z.string(), z.any()),
  adjacency: z.record(z.string(), z.array(z.string())),
  reverseAdjacency: z.record(z.string(), z.array(z.string())),
});

function createDefaultState(): ContextGraphState {
  const nodesByType: Record<DecisionNodeType, number> = {} as any;
  for (const t of nodeTypeValues) nodesByType[t] = 0;

  const edgesByType: Record<DecisionEdgeType, number> = {} as any;
  for (const t of edgeTypeValues) edgesByType[t] = 0;

  return {
    nodeCount: 0,
    edgeCount: 0,
    nodesByType,
    edgesByType,
    lastCapture: "",
    version: 1,
    nodes: {},
    edges: {},
    adjacency: {},
    reverseAdjacency: {},
  };
}

// ============================================
// GRAPH MANAGER
// ============================================

export interface GraphManager {
  /** Append events to the event store and update materialized index */
  appendEvents(events: GraphEvent[]): Promise<void>;
  /** Rebuild graph state from events.jsonl */
  rebuildGraph(): Promise<ContextGraphState>;
  /** Get a node by ID */
  getNode(id: string): Promise<DecisionNode | null>;
  /** Get all edges connected to a node (both directions) */
  getEdges(nodeId: string): Promise<DecisionEdge[]>;
  /** BFS backward trace on causal edges */
  traceDecisionChain(nodeId: string, maxDepth?: number): Promise<TraceResult>;
  /** Find decisions linked to outcomes within a rating range */
  findDecisionsByOutcome(
    minRating: number,
    maxRating: number
  ): Promise<DecisionNode[]>;
  /** Find decisions aligned with a TELOS goal */
  decisionsByGoal(goalId: string): Promise<DecisionNode[]>;
  /** Full-text search across decision content */
  search(query: string): Promise<GraphSearchResult[]>;
  /** Get graph statistics */
  getStats(): Promise<GraphStatsSummary>;
  /** Load current state */
  loadState(): Promise<ContextGraphState>;
  /** Create a monthly snapshot */
  createSnapshot(period: string): Promise<string>;
}

/**
 * Create a GraphManager instance.
 */
export function createGraphManager(): GraphManager {
  // Ensure directories
  const eventsDir = dirname(EVENTS_FILE);
  if (!existsSync(eventsDir)) mkdirSync(eventsDir, { recursive: true });
  if (!existsSync(SNAPSHOTS_DIR)) mkdirSync(SNAPSHOTS_DIR, { recursive: true });

  const stateManager = createStateManager<ContextGraphState>({
    path: STATE_FILE,
    schema: ContextGraphStateSchema as any,
    defaults: createDefaultState,
    version: 1,
  });

  /**
   * Apply a single event to the state (in-memory mutation).
   */
  function applyEvent(state: ContextGraphState, event: GraphEvent): void {
    switch (event.type) {
      case "node_added": {
        const node = event.payload as DecisionNode;
        if (state.nodes[node.id]) return; // deduplicate
        state.nodes[node.id] = node;
        state.nodeCount++;
        state.nodesByType[node.type] =
          (state.nodesByType[node.type] || 0) + 1;
        // Initialize adjacency lists
        if (!state.adjacency[node.id]) state.adjacency[node.id] = [];
        if (!state.reverseAdjacency[node.id])
          state.reverseAdjacency[node.id] = [];
        break;
      }
      case "edge_added": {
        const edge = event.payload as DecisionEdge;
        if (state.edges[edge.id]) return; // deduplicate
        state.edges[edge.id] = edge;
        state.edgeCount++;
        state.edgesByType[edge.type] =
          (state.edgesByType[edge.type] || 0) + 1;
        // Update adjacency
        if (!state.adjacency[edge.source])
          state.adjacency[edge.source] = [];
        state.adjacency[edge.source].push(edge.id);
        if (!state.reverseAdjacency[edge.target])
          state.reverseAdjacency[edge.target] = [];
        state.reverseAdjacency[edge.target].push(edge.id);
        break;
      }
      case "node_updated": {
        const updated = event.payload as DecisionNode;
        if (state.nodes[updated.id]) {
          const oldType = (state.nodes[updated.id] as DecisionNode).type;
          if (oldType !== updated.type) {
            state.nodesByType[oldType] = Math.max(
              0,
              (state.nodesByType[oldType] || 0) - 1
            );
            state.nodesByType[updated.type] =
              (state.nodesByType[updated.type] || 0) + 1;
          }
          state.nodes[updated.id] = updated;
        }
        break;
      }
    }
  }

  return {
    async appendEvents(events: GraphEvent[]): Promise<void> {
      if (events.length === 0) return;

      // Append to events.jsonl
      const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
      appendFileSync(EVENTS_FILE, lines);

      // Update materialized index
      await stateManager.update((state) => {
        for (const event of events) {
          applyEvent(state, event);
        }
        state.lastCapture = new Date().toISOString();
        return state;
      });
    },

    async rebuildGraph(): Promise<ContextGraphState> {
      const freshState = createDefaultState();

      if (!existsSync(EVENTS_FILE)) {
        await stateManager.save(freshState);
        return freshState;
      }

      const content = readFileSync(EVENTS_FILE, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      let processedCount = 0;
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as GraphEvent;
          applyEvent(freshState, event);
          processedCount++;
        } catch {
          // Skip malformed lines
        }
      }

      freshState.lastCapture = new Date().toISOString();
      await stateManager.save(freshState);

      console.log(
        `Rebuilt graph from ${processedCount} events: ${freshState.nodeCount} nodes, ${freshState.edgeCount} edges`
      );
      return freshState;
    },

    async getNode(id: string): Promise<DecisionNode | null> {
      const state = await stateManager.load();
      return (state.nodes[id] as DecisionNode) || null;
    },

    async getEdges(nodeId: string): Promise<DecisionEdge[]> {
      const state = await stateManager.load();
      const edgeIds = new Set<string>();

      // Outgoing edges
      for (const eid of state.adjacency[nodeId] || []) {
        edgeIds.add(eid);
      }
      // Incoming edges
      for (const eid of state.reverseAdjacency[nodeId] || []) {
        edgeIds.add(eid);
      }

      return Array.from(edgeIds)
        .map((eid) => state.edges[eid] as DecisionEdge)
        .filter(Boolean);
    },

    async traceDecisionChain(
      nodeId: string,
      maxDepth: number = 10
    ): Promise<TraceResult> {
      const state = await stateManager.load();
      const rootNode = state.nodes[nodeId] as DecisionNode;

      if (!rootNode) {
        return { root: null as any, chain: [], edges: [], depth: 0 };
      }

      // BFS backward on causal edge types
      const causalTypes: DecisionEdgeType[] = [
        "caused",
        "influenced",
        "supersedes",
        "outcome_of",
      ];
      const visited = new Set<string>([nodeId]);
      const queue: Array<{ id: string; depth: number }> = [
        { id: nodeId, depth: 0 },
      ];
      const chainNodes: DecisionNode[] = [rootNode];
      const chainEdges: DecisionEdge[] = [];
      let maxReached = 0;

      while (queue.length > 0) {
        const { id, depth } = queue.shift()!;
        if (depth >= maxDepth) continue;
        maxReached = Math.max(maxReached, depth);

        // Follow reverse adjacency (edges pointing TO this node)
        const incomingEdgeIds = state.reverseAdjacency[id] || [];
        for (const eid of incomingEdgeIds) {
          const edge = state.edges[eid] as DecisionEdge;
          if (!edge || !causalTypes.includes(edge.type)) continue;

          const sourceId = edge.source;
          if (visited.has(sourceId)) continue;

          visited.add(sourceId);
          const sourceNode = state.nodes[sourceId] as DecisionNode;
          if (sourceNode) {
            chainNodes.push(sourceNode);
            chainEdges.push(edge);
            queue.push({ id: sourceId, depth: depth + 1 });
          }
        }

        // Also follow outgoing edges for forward traces
        const outgoingEdgeIds = state.adjacency[id] || [];
        for (const eid of outgoingEdgeIds) {
          const edge = state.edges[eid] as DecisionEdge;
          if (!edge || !causalTypes.includes(edge.type)) continue;

          const targetId = edge.target;
          if (visited.has(targetId)) continue;

          visited.add(targetId);
          const targetNode = state.nodes[targetId] as DecisionNode;
          if (targetNode) {
            chainNodes.push(targetNode);
            chainEdges.push(edge);
            queue.push({ id: targetId, depth: depth + 1 });
          }
        }
      }

      return {
        root: rootNode,
        chain: chainNodes,
        edges: chainEdges,
        depth: maxReached,
      };
    },

    async findDecisionsByOutcome(
      minRating: number,
      maxRating: number
    ): Promise<DecisionNode[]> {
      const state = await stateManager.load();
      const results: DecisionNode[] = [];

      // Find outcome nodes with ratings in range
      for (const node of Object.values(state.nodes) as DecisionNode[]) {
        if (node.type !== "outcome") continue;
        const rating = node.metadata?.rating as number | undefined;
        if (rating !== undefined && rating >= minRating && rating <= maxRating) {
          // Find decisions linked to this outcome via outcome_of edges
          const incomingEdgeIds = state.reverseAdjacency[node.id] || [];
          for (const eid of incomingEdgeIds) {
            const edge = state.edges[eid] as DecisionEdge;
            if (edge && edge.type === "outcome_of") {
              const decisionNode = state.nodes[
                edge.source
              ] as DecisionNode;
              if (decisionNode) results.push(decisionNode);
            }
          }

          // Also check outgoing edges where this outcome links to decisions
          const outgoingEdgeIds = state.adjacency[node.id] || [];
          for (const eid of outgoingEdgeIds) {
            const edge = state.edges[eid] as DecisionEdge;
            if (edge && edge.type === "outcome_of") {
              const decisionNode = state.nodes[
                edge.target
              ] as DecisionNode;
              if (decisionNode) results.push(decisionNode);
            }
          }
        }
      }

      // Deduplicate
      const seen = new Set<string>();
      return results.filter((n) => {
        if (seen.has(n.id)) return false;
        seen.add(n.id);
        return true;
      });
    },

    async decisionsByGoal(goalId: string): Promise<DecisionNode[]> {
      const state = await stateManager.load();
      const goalIdLower = goalId.toLowerCase();

      return (Object.values(state.nodes) as DecisionNode[]).filter((node) => {
        // Check tags
        if (node.tags.some((t) => t.toLowerCase().includes(goalIdLower)))
          return true;
        // Check metadata
        if (node.metadata?.goal === goalId) return true;
        if (
          Array.isArray(node.metadata?.goals) &&
          (node.metadata.goals as string[]).includes(goalId)
        )
          return true;
        // Check title and content
        if (node.title.toLowerCase().includes(goalIdLower)) return true;
        if (node.content.toLowerCase().includes(goalIdLower)) return true;
        return false;
      });
    },

    async search(query: string): Promise<GraphSearchResult[]> {
      const state = await stateManager.load();
      const queryLower = query.toLowerCase();
      const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 2);
      const results: GraphSearchResult[] = [];

      for (const node of Object.values(state.nodes) as DecisionNode[]) {
        const matchedFields: string[] = [];
        let score = 0;

        // Title match (highest weight)
        const titleLower = node.title.toLowerCase();
        if (titleLower.includes(queryLower)) {
          matchedFields.push("title");
          score += 1.0;
        } else {
          const titleTermMatches = queryTerms.filter((t) =>
            titleLower.includes(t)
          );
          if (titleTermMatches.length > 0) {
            matchedFields.push("title");
            score += 0.5 * (titleTermMatches.length / queryTerms.length);
          }
        }

        // Content match
        const contentLower = node.content.toLowerCase();
        if (contentLower.includes(queryLower)) {
          matchedFields.push("content");
          score += 0.7;
        } else {
          const contentTermMatches = queryTerms.filter((t) =>
            contentLower.includes(t)
          );
          if (contentTermMatches.length > 0) {
            matchedFields.push("content");
            score += 0.3 * (contentTermMatches.length / queryTerms.length);
          }
        }

        // Tag match
        const tagMatch = node.tags.some((t) =>
          t.toLowerCase().includes(queryLower)
        );
        if (tagMatch) {
          matchedFields.push("tags");
          score += 0.5;
        }

        if (matchedFields.length > 0) {
          results.push({
            node,
            relevance: Math.min(score, 1.0),
            matchedFields,
          });
        }
      }

      // Sort by relevance descending
      results.sort((a, b) => b.relevance - a.relevance);
      return results.slice(0, 50);
    },

    async getStats(): Promise<GraphStatsSummary> {
      const state = await stateManager.load();
      const nodes = Object.values(state.nodes) as DecisionNode[];

      // Find oldest/newest
      let oldest = "";
      let newest = "";
      if (nodes.length > 0) {
        const sorted = [...nodes].sort(
          (a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );
        oldest = sorted[0].timestamp;
        newest = sorted[sorted.length - 1].timestamp;
      }

      // Calculate avg edges per node
      const avgEdges =
        state.nodeCount > 0 ? (state.edgeCount * 2) / state.nodeCount : 0;

      // Top connected nodes
      const connectionCounts = new Map<string, number>();
      for (const nodeId of Object.keys(state.adjacency)) {
        const outgoing = (state.adjacency[nodeId] || []).length;
        const incoming = (state.reverseAdjacency[nodeId] || []).length;
        connectionCounts.set(nodeId, outgoing + incoming);
      }

      const topConnected = Array.from(connectionCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id, connections]) => ({
          id,
          title: (state.nodes[id] as DecisionNode)?.title || id,
          connections,
        }));

      return {
        nodeCount: state.nodeCount,
        edgeCount: state.edgeCount,
        nodesByType: state.nodesByType as Record<DecisionNodeType, number>,
        edgesByType: state.edgesByType as Record<DecisionEdgeType, number>,
        lastCapture: state.lastCapture,
        oldestNode: oldest,
        newestNode: newest,
        avgEdgesPerNode: Math.round(avgEdges * 100) / 100,
        topConnectedNodes: topConnected,
      };
    },

    async loadState(): Promise<ContextGraphState> {
      return stateManager.load();
    },

    async createSnapshot(period: string): Promise<string> {
      const state = await stateManager.load();
      const snapshotPath = join(SNAPSHOTS_DIR, `${period}.json`);

      if (!existsSync(SNAPSHOTS_DIR))
        mkdirSync(SNAPSHOTS_DIR, { recursive: true });

      const Bun = globalThis.Bun;
      await Bun.write(snapshotPath, JSON.stringify(state, null, 2));

      return snapshotPath;
    },
  };
}

// ============================================
// CLI INTERFACE
// ============================================

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
GraphManager - ContextGraph core operations

Usage:
  bun GraphManager.ts --stats                    Show graph statistics
  bun GraphManager.ts --rebuild                  Rebuild graph from events.jsonl
  bun GraphManager.ts --search "query"           Search decisions
  bun GraphManager.ts --trace <nodeId>           Trace decision chain
  bun GraphManager.ts --trace <nodeId> --depth N Set max trace depth (default: 10)
  bun GraphManager.ts --by-goal G25             Find decisions by goal
  bun GraphManager.ts --node <nodeId>            Get node details
  bun GraphManager.ts --snapshot <period>        Create snapshot (e.g., 2026-02)
  bun GraphManager.ts --help                     Show this help

Output:
  All commands output JSON by default.
`);
    process.exit(0);
  }

  const gm = createGraphManager();

  try {
    if (args.includes("--rebuild")) {
      console.log("Rebuilding graph from events.jsonl...");
      const state = await gm.rebuildGraph();
      console.log(
        JSON.stringify(
          {
            status: "rebuilt",
            nodeCount: state.nodeCount,
            edgeCount: state.edgeCount,
          },
          null,
          2
        )
      );
      return;
    }

    if (args.includes("--stats")) {
      const stats = await gm.getStats();
      console.log(JSON.stringify(stats, null, 2));
      return;
    }

    if (args.includes("--search")) {
      const searchIdx = args.indexOf("--search");
      const query = args[searchIdx + 1];
      if (!query) {
        console.error("Error: --search requires a query string");
        process.exit(1);
      }
      const results = await gm.search(query);
      console.log(
        JSON.stringify(
          {
            query,
            resultCount: results.length,
            results: results.map((r) => ({
              id: r.node.id,
              title: r.node.title,
              type: r.node.type,
              relevance: r.relevance,
              matchedFields: r.matchedFields,
              timestamp: r.node.timestamp,
            })),
          },
          null,
          2
        )
      );
      return;
    }

    if (args.includes("--trace")) {
      const traceIdx = args.indexOf("--trace");
      const nodeId = args[traceIdx + 1];
      if (!nodeId) {
        console.error("Error: --trace requires a node ID");
        process.exit(1);
      }

      let maxDepth = 10;
      const depthIdx = args.indexOf("--depth");
      if (depthIdx !== -1 && args[depthIdx + 1]) {
        maxDepth = parseInt(args[depthIdx + 1], 10) || 10;
      }

      const trace = await gm.traceDecisionChain(nodeId, maxDepth);
      if (!trace.root) {
        console.error(`Node not found: ${nodeId}`);
        process.exit(1);
      }

      console.log(
        JSON.stringify(
          {
            rootNode: trace.root.id,
            rootTitle: trace.root.title,
            chainLength: trace.chain.length,
            edgeCount: trace.edges.length,
            maxDepth: trace.depth,
            chain: trace.chain.map((n) => ({
              id: n.id,
              title: n.title,
              type: n.type,
              timestamp: n.timestamp,
            })),
          },
          null,
          2
        )
      );
      return;
    }

    if (args.includes("--by-goal")) {
      const goalIdx = args.indexOf("--by-goal");
      const goalId = args[goalIdx + 1];
      if (!goalId) {
        console.error("Error: --by-goal requires a goal ID");
        process.exit(1);
      }

      const decisions = await gm.decisionsByGoal(goalId);
      console.log(
        JSON.stringify(
          {
            goalId,
            resultCount: decisions.length,
            decisions: decisions.map((n) => ({
              id: n.id,
              title: n.title,
              type: n.type,
              timestamp: n.timestamp,
              tags: n.tags,
            })),
          },
          null,
          2
        )
      );
      return;
    }

    if (args.includes("--node")) {
      const nodeIdx = args.indexOf("--node");
      const nodeId = args[nodeIdx + 1];
      if (!nodeId) {
        console.error("Error: --node requires a node ID");
        process.exit(1);
      }

      const node = await gm.getNode(nodeId);
      if (!node) {
        console.error(`Node not found: ${nodeId}`);
        process.exit(1);
      }

      const edges = await gm.getEdges(nodeId);
      console.log(
        JSON.stringify(
          {
            node,
            edges: edges.map((e) => ({
              id: e.id,
              type: e.type,
              source: e.source,
              target: e.target,
              weight: e.weight,
            })),
          },
          null,
          2
        )
      );
      return;
    }

    if (args.includes("--snapshot")) {
      const snapIdx = args.indexOf("--snapshot");
      const period = args[snapIdx + 1] || new Date().toISOString().slice(0, 7);
      const path = await gm.createSnapshot(period);
      console.log(JSON.stringify({ status: "snapshot_created", path }, null, 2));
      return;
    }

    // Default: show stats
    const stats = await gm.getStats();
    console.log(JSON.stringify(stats, null, 2));
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  }
}

// Run CLI if executed directly
if (import.meta.main) {
  runCli();
}
