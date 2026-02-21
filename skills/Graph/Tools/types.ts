#!/usr/bin/env bun
/**
 * Unified Graph Type Definitions
 *
 * Merges DevGraph and ContextGraph into a single type system.
 * Core data model for the unified knowledge graph linking sessions,
 * commits, errors, decisions, goals, and all development artifacts.
 *
 * @module Graph/types
 * @version 2.0.0
 */

// ============================================
// NODE TYPES (13 total)
// ============================================

/**
 * Unified node types from both ContextGraph and DevGraph.
 *
 * Origin annotations:
 * - [DG] = DevGraph (development artifacts)
 * - [CG] = ContextGraph (decision intelligence)
 * - [BOTH] = Present in both original skills
 */
export type GraphNodeType =
  // From DevGraph (development artifacts)
  | 'session'        // [BOTH] Kaya session (conversation)
  | 'agent_trace'    // [DG] Agent workflow execution
  | 'error'          // [DG] Error encountered during work
  | 'commit'         // [DG] Git commit
  | 'learning'       // [DG] Captured learning/insight
  | 'skill_change'   // [DG] Skill file modification
  | 'file'           // [DG] Modified file
  | 'issue'          // [DG] Tracked problem/bug
  // From ContextGraph (decision intelligence)
  | 'decision'       // [BOTH] Architectural/design decision
  | 'outcome'        // [CG] Result of a decision (rating, sentiment)
  | 'context'        // [CG] Background info shaping decisions
  | 'pattern'        // [CG] Recurring pattern across decisions
  | 'goal';          // [CG] TELOS goal linkage anchor

export const ALL_NODE_TYPES: GraphNodeType[] = [
  'session', 'agent_trace', 'error', 'commit', 'learning',
  'skill_change', 'file', 'issue',
  'decision', 'outcome', 'context', 'pattern', 'goal',
];

// ============================================
// EDGE TYPES (19 total)
// ============================================

/**
 * Unified edge types from both skills.
 *
 * Origin annotations:
 * - [DG] = DevGraph (development relationships)
 * - [CG] = ContextGraph (decision relationships)
 * - [BOTH] = Present in both original skills
 */
export type GraphEdgeType =
  // From DevGraph (development relationships)
  | 'produced'       // [DG] Session -> artifact (e.g., session -> commit)
  | 'caused'         // [BOTH] Error origin / decision causality
  | 'fixed_by'       // [DG] Error -> commit resolution
  | 'learned_from'   // [DG] Insight origin (e.g., error -> learning)
  | 'references'     // [DG] General reference
  | 'depends_on'     // [DG] Dependency chain
  | 'blocks'         // [DG] Blocking relationship
  | 'modifies'       // [DG] File changes (e.g., commit -> file)
  | 'spawned'        // [DG] Agent creation (e.g., session -> agent_trace)
  | 'contains'       // [DG] Containment (e.g., session -> error)
  | 'implements'     // [DG] Implementation link (e.g., commit -> decision)
  | 'relates_to'     // [BOTH] Inferred similarity
  // From ContextGraph (decision relationships)
  | 'influenced'     // [CG] A shaped B (same-topic decisions across sessions)
  | 'preceded'       // [CG] Temporal ordering (within 1hr)
  | 'outcome_of'     // [CG] Links outcome to decision (rating within 5min)
  | 'context_for'    // [CG] Background for decision
  | 'pattern_member' // [CG] Decision belongs to pattern (weekly synthesis)
  | 'goal_aligned'   // [CG] Decision supports a goal (tag overlap with TELOS)
  | 'supersedes';    // [CG] Replaces earlier decision (correction follows error)

export const ALL_EDGE_TYPES: GraphEdgeType[] = [
  'produced', 'caused', 'fixed_by', 'learned_from', 'references',
  'depends_on', 'blocks', 'modifies', 'spawned', 'contains',
  'implements', 'relates_to',
  'influenced', 'preceded', 'outcome_of', 'context_for',
  'pattern_member', 'goal_aligned', 'supersedes',
];

// ============================================
// NODE INTERFACE
// ============================================

/**
 * A node in the unified graph.
 *
 * Design notes:
 * - Uses DevGraph's field names as canonical (more general)
 * - ContextGraph-specific fields (content, confidence, recordedAt)
 *   moved into metadata for CG-originated nodes
 * - Bi-temporal support: created_at vs valid_from
 *
 * Migration note: When converting ContextGraph's DecisionNode:
 * - DecisionNode.content -> GraphNode.metadata.content
 * - DecisionNode.confidence -> GraphNode.metadata.confidence
 * - DecisionNode.recordedAt -> GraphNode.metadata.recordedAt
 * - DecisionNode.timestamp -> GraphNode.valid_from
 */
export interface GraphNode {
  /** Unique identifier. Convention: "type:qualifier" (e.g., "commit:abc123") */
  id: string;
  /** Node type classification */
  type: GraphNodeType;
  /** Human-readable title */
  title: string;
  /** ISO timestamp of when this node was created in the graph */
  created_at: string;
  /** ISO timestamp of when this became relevant (bi-temporal support) */
  valid_from: string;
  /** ISO timestamp of when this stopped being relevant (soft delete) */
  valid_to?: string;
  /** Searchable tags */
  tags: string[];
  /** Type-specific data. CG's content/confidence/recordedAt live here. */
  metadata: Record<string, unknown>;
}

// ============================================
// EDGE INTERFACE
// ============================================

/**
 * An edge connecting two nodes in the unified graph.
 * Interface is identical between DevGraph and ContextGraph - no migration needed.
 */
export interface GraphEdge {
  /** Unique identifier */
  id: string;
  /** Source node ID */
  source: string;
  /** Target node ID */
  target: string;
  /** Edge type classification */
  type: GraphEdgeType;
  /** Confidence weight (0-1, where 1 = explicit/certain, <1 = inferred) */
  weight: number;
  /** ISO timestamp of edge creation */
  created_at: string;
  /** Additional edge metadata */
  metadata: Record<string, unknown>;
}

// ============================================
// GRAPH STATE
// ============================================

/**
 * Persisted graph metadata (meta.json via StateManager).
 *
 * Design note: Follows DevGraph's lighter pattern (counters only).
 * ContextGraph stored the entire graph in state (doesn't scale).
 * We store full data in per-type JSONL files, counters in meta.json.
 */
export interface GraphState {
  /** Schema version for migrations */
  version: number;
  /** ISO timestamp of last ingestion run */
  lastIngested: string;
  /** Total number of nodes */
  nodeCount: number;
  /** Total number of edges */
  edgeCount: number;
  /** Node counts by type */
  nodesByType: Record<GraphNodeType, number>;
  /** Edge counts by type */
  edgesByType: Record<GraphEdgeType, number>;
}

// ============================================
// HELPER FACTORIES
// ============================================

/**
 * Create an empty GraphState with all counters at zero.
 */
export function createEmptyGraphState(): GraphState {
  const nodesByType: Record<GraphNodeType, number> = {} as any;
  for (const t of ALL_NODE_TYPES) nodesByType[t] = 0;

  const edgesByType: Record<GraphEdgeType, number> = {} as any;
  for (const t of ALL_EDGE_TYPES) edgesByType[t] = 0;

  return {
    version: 1,
    lastIngested: '',
    nodeCount: 0,
    edgeCount: 0,
    nodesByType,
    edgesByType,
  };
}

/**
 * Create a GraphNode with sensible defaults.
 */
export function createNode(
  type: GraphNodeType,
  id: string,
  title: string,
  metadata: Record<string, unknown> = {},
  tags: string[] = [],
): GraphNode {
  const now = new Date().toISOString();
  return {
    id,
    type,
    title,
    created_at: now,
    valid_from: now,
    tags,
    metadata,
  };
}

/**
 * Create a GraphEdge with sensible defaults.
 */
export function createEdge(
  type: GraphEdgeType,
  source: string,
  target: string,
  weight: number = 1.0,
  metadata: Record<string, unknown> = {},
): GraphEdge {
  const id = `${type}:${source}->${target}`;
  return {
    id,
    source,
    target,
    type,
    weight,
    created_at: new Date().toISOString(),
    metadata,
  };
}

// ============================================
// INGESTION TYPES
// ============================================

/**
 * Result from an ingestion operation.
 */
export interface IngestionResult {
  source: string;
  nodesAdded: number;
  edgesAdded: number;
  nodesSkipped: number;
  edgesSkipped: number;
  errors: string[];
  duration: number;
}

/**
 * Common interface for all ingesters.
 */
export interface Ingester {
  ingest(options?: any): Promise<IngestionResult>;
}

/**
 * Sources available for ingestion.
 */
export type IngestionSource = 'git' | 'sessions' | 'traces' | 'decisions' | 'all';

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  console.log('Unified Graph Type Definitions');
  console.log('==============================');
  console.log(`Node types (${ALL_NODE_TYPES.length}): ${ALL_NODE_TYPES.join(', ')}`);
  console.log(`Edge types (${ALL_EDGE_TYPES.length}): ${ALL_EDGE_TYPES.join(', ')}`);
  console.log('\nRun with: bun skills/Graph/Tools/types.ts');
}
