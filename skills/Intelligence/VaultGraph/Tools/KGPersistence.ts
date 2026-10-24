#!/usr/bin/env bun
/**
 * KGPersistence - Knowledge Graph State Persistence
 *
 * Handles saving, loading, and TTL-aware refresh of graph state.
 * Extracted from GraphBuilder.ts to separate persistence concerns.
 */

import { existsSync } from "fs";
import { z } from "zod";
import { createStateManager } from "../../../../lib/core/StateManager";
import type { GraphState, GraphBuildOptions, GraphStats, GraphNode, GraphEdge } from "./types.ts";

// ============================================
// ZOD SCHEMAS
// ============================================

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
  tagCounts: z.record(z.string(), z.number()),
  folderCounts: z.record(z.string(), z.number()),
});

export const GraphStateSchema = z.object({
  version: z.number(),
  built: z.string(),
  ttl: z.number(),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  clusters: z.array(ConceptClusterSchema),
  stats: GraphStatsSchema,
});

// ============================================
// EMPTY STATE FACTORY
// ============================================

export function buildEmptyGraphState(): GraphState {
  return {
    version: 1,
    built: "",
    ttl: 24,
    nodes: [],
    edges: [],
    clusters: [],
    stats: {
      totalNodes: 0,
      totalEdges: 0,
      orphanCount: 0,
      brokenLinks: [],
      avgConnections: 0,
      mostConnected: [],
      leastConnected: [],
      clusterCount: 0,
      tagCounts: {},
      folderCounts: {},
    } as GraphStats,
  };
}

// ============================================
// SAVE
// ============================================

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

// ============================================
// LOAD
// ============================================

/**
 * Load graph state from disk. Returns null if file does not exist.
 * Caller should handle null by calling buildEmptyGraphState() or triggering rebuild.
 */
export async function loadGraphState(path: string): Promise<GraphState | null> {
  if (!existsSync(path)) {
    return null;
  }
  const manager = createStateManager({
    path,
    schema: GraphStateSchema as z.ZodSchema<GraphState>,
    defaults: buildEmptyGraphState(),
  });
  return await manager.load();
}

// ============================================
// TTL-AWARE LOAD OR REBUILD
// ============================================

/**
 * Load graph state with TTL check. If state is missing or older than ttl hours,
 * triggers a rebuild by calling the provided buildFn.
 *
 * @param statePath - Path to state JSON file
 * @param buildFn - Async function that builds and returns fresh GraphState
 * @param forceRebuild - Bypass TTL check and always rebuild
 */
export async function loadOrRebuildGraphState(
  statePath: string,
  buildFn: () => Promise<GraphState>,
  forceRebuild = false
): Promise<GraphState> {
  // Missing state: build fresh
  if (!existsSync(statePath)) {
    console.log("[KnowledgeGraph] No state file found. Building graph...");
    const freshState = await buildFn();
    await saveGraphState(freshState, statePath);
    return freshState;
  }

  const state = await loadGraphState(statePath);
  if (!state) {
    console.log("[KnowledgeGraph] State file unreadable. Building graph...");
    const freshState = await buildFn();
    await saveGraphState(freshState, statePath);
    return freshState;
  }

  const ttlHours = state.ttl ?? 24;
  const builtAt = state.built ? Date.parse(state.built) : 0;
  const ageHours = (Date.now() - builtAt) / 3_600_000;

  if (forceRebuild || ageHours > ttlHours) {
    console.log(
      `[KnowledgeGraph] State is ${ageHours.toFixed(1)}h old (TTL: ${ttlHours}h). Rebuilding...`
    );
    const freshState = await buildFn();
    await saveGraphState(freshState, statePath);
    return freshState;
  }

  return state;
}
