#!/usr/bin/env bun
/**
 * DevGraph Type Definitions
 *
 * Core data model for the development knowledge graph.
 * Defines node types, edge types, and graph state for
 * linking sessions, agent traces, errors, commits, learnings,
 * and skill changes.
 *
 * @module DevGraph/types
 * @version 1.0.0
 */

// ============================================
// NODE TYPES
// ============================================

/**
 * All supported node types in the development graph.
 *
 * - session: A Kaya session (conversation)
 * - agent_trace: An agent workflow execution
 * - error: An error encountered during work
 * - commit: A git commit
 * - learning: A captured learning/insight
 * - skill_change: A skill file modification
 * - file: A modified file
 * - decision: An architectural/design decision
 * - issue: A tracked problem/bug
 */
export type DevNodeType =
  | 'session'
  | 'agent_trace'
  | 'error'
  | 'commit'
  | 'learning'
  | 'skill_change'
  | 'file'
  | 'decision'
  | 'issue';

export const ALL_NODE_TYPES: DevNodeType[] = [
  'session', 'agent_trace', 'error', 'commit', 'learning',
  'skill_change', 'file', 'decision', 'issue',
];

// ============================================
// EDGE TYPES
// ============================================

/**
 * All supported edge types in the development graph.
 *
 * - produced: Session -> artifact (e.g., session -> commit)
 * - caused: Error origin (e.g., commit -> error)
 * - fixed_by: Error resolution (e.g., error -> commit)
 * - learned_from: Insight origin (e.g., error -> learning)
 * - references: General reference (e.g., session -> session)
 * - depends_on: Dependency chain (e.g., issue -> issue)
 * - blocks: Blocking relationship (e.g., error -> skill_change)
 * - modifies: File changes (e.g., commit -> file)
 * - spawned: Agent creation (e.g., session -> agent_trace)
 * - contains: Containment (e.g., session -> error)
 * - implements: Implementation link (e.g., commit -> decision)
 * - relates_to: Inferred similarity (e.g., learning -> learning)
 */
export type DevEdgeType =
  | 'produced'
  | 'caused'
  | 'fixed_by'
  | 'learned_from'
  | 'references'
  | 'depends_on'
  | 'blocks'
  | 'modifies'
  | 'spawned'
  | 'contains'
  | 'implements'
  | 'relates_to';

export const ALL_EDGE_TYPES: DevEdgeType[] = [
  'produced', 'caused', 'fixed_by', 'learned_from', 'references',
  'depends_on', 'blocks', 'modifies', 'spawned', 'contains',
  'implements', 'relates_to',
];

// ============================================
// NODE INTERFACE
// ============================================

/**
 * A node in the development knowledge graph.
 * All nodes have temporal properties for time-aware queries.
 */
export interface DevNode {
  /** Unique identifier (type-prefixed for readability, e.g., "commit:abc123") */
  id: string;
  /** Node type classification */
  type: DevNodeType;
  /** Human-readable title */
  title: string;
  /** ISO timestamp of when this node was created in the graph */
  created_at: string;
  /** ISO timestamp of when this became relevant */
  valid_from: string;
  /** ISO timestamp of when this stopped being relevant (soft delete) */
  valid_to?: string;
  /** Searchable tags */
  tags: string[];
  /** Type-specific data */
  metadata: Record<string, unknown>;
}

// ============================================
// EDGE INTERFACE
// ============================================

/**
 * An edge connecting two nodes in the development graph.
 * Edges carry a weight indicating confidence (0-1).
 */
export interface DevEdge {
  /** Unique identifier */
  id: string;
  /** Source node ID */
  source: string;
  /** Target node ID */
  target: string;
  /** Edge type classification */
  type: DevEdgeType;
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
 * Persisted graph metadata/state.
 * Managed by StateManager via meta.json.
 */
export interface DevGraphState {
  /** Schema version for migration support */
  version: number;
  /** ISO timestamp of last ingestion run */
  lastIngested: string;
  /** Total number of nodes in the graph */
  nodeCount: number;
  /** Total number of edges in the graph */
  edgeCount: number;
  /** Count of nodes by type */
  nodesByType: Record<DevNodeType, number>;
  /** Count of edges by type */
  edgesByType: Record<DevEdgeType, number>;
}

// ============================================
// HELPER FACTORIES
// ============================================

/**
 * Create an empty DevGraphState with all counters at zero.
 */
export function createEmptyGraphState(): DevGraphState {
  const nodesByType: Record<DevNodeType, number> = {} as any;
  for (const t of ALL_NODE_TYPES) nodesByType[t] = 0;

  const edgesByType: Record<DevEdgeType, number> = {} as any;
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
 * Create a DevNode with sensible defaults.
 */
export function createNode(
  type: DevNodeType,
  id: string,
  title: string,
  metadata: Record<string, unknown> = {},
  tags: string[] = [],
): DevNode {
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
 * Create a DevEdge with sensible defaults.
 */
export function createEdge(
  type: DevEdgeType,
  source: string,
  target: string,
  weight: number = 1.0,
  metadata: Record<string, unknown> = {},
): DevEdge {
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
 * Sources available for ingestion.
 */
export type IngestionSource = 'git' | 'sessions' | 'traces' | 'all';

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  console.log('DevGraph Type Definitions');
  console.log('========================');
  console.log(`Node types (${ALL_NODE_TYPES.length}): ${ALL_NODE_TYPES.join(', ')}`);
  console.log(`Edge types (${ALL_EDGE_TYPES.length}): ${ALL_EDGE_TYPES.join(', ')}`);
  console.log('\nRun with: bun skills/DevGraph/Tools/types.ts');
}
