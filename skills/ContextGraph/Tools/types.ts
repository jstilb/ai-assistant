/**
 * ContextGraph Type Definitions
 *
 * Decision trace graph types for extracting decision points from Kaya data
 * and building queryable causal/temporal graphs.
 *
 * Design notes:
 * - Bi-temporal: each node has `timestamp` (when decision happened) and
 *   `recordedAt` (when it was extracted into the graph)
 * - Event-sourced: all mutations go through GraphEvent to events.jsonl
 * - Content-hashed: deduplication via SHA-256 content hashing
 *
 * @module ContextGraph/types
 * @version 1.0.0
 */

// ============================================
// NODE TYPES
// ============================================

/**
 * Classification of decision nodes.
 *
 * - decision: An explicit choice made (ISC rows, work items, learnings)
 * - context: Background info that shaped a decision (session metadata, effort)
 * - outcome: Result of a decision (ratings, sentiment)
 * - pattern: Recurring pattern detected across decisions (weekly synthesis)
 * - goal: TELOS goal linkage anchor
 * - session: Session anchor node grouping decisions within a session
 */
export type DecisionNodeType =
  | "decision"
  | "context"
  | "outcome"
  | "pattern"
  | "goal"
  | "session";

// ============================================
// EDGE TYPES
// ============================================

/**
 * Types of relationships between decision nodes.
 *
 * - caused: A directly led to B (ISC dependency chains)
 * - influenced: A shaped B (same-topic decisions across sessions)
 * - preceded: Temporal ordering (same session, within 1hr)
 * - outcome_of: Links outcome to decision (rating within 5min)
 * - context_for: Background for decision (session -> decisions in session)
 * - pattern_member: Decision belongs to pattern (weekly synthesis grouping)
 * - goal_aligned: Decision supports a goal (tag overlap with TELOS keywords)
 * - supersedes: Replaces earlier decision (correction follows error)
 */
export type DecisionEdgeType =
  | "caused"
  | "influenced"
  | "preceded"
  | "outcome_of"
  | "context_for"
  | "pattern_member"
  | "goal_aligned"
  | "supersedes";

// ============================================
// DECISION NODE
// ============================================

/**
 * A node in the decision graph representing a decision point,
 * context, outcome, pattern, goal, or session.
 */
export interface DecisionNode {
  /** Unique identifier (content-hash based) */
  id: string;
  /** Node classification */
  type: DecisionNodeType;
  /** Short descriptive title */
  title: string;
  /** Full content/description of the decision */
  content: string;
  /** When the decision actually happened (ISO 8601) */
  timestamp: string;
  /** When this node was extracted into the graph (ISO 8601) */
  recordedAt: string;
  /** Searchable tags */
  tags: string[];
  /** Additional metadata (source-specific) */
  metadata: Record<string, unknown>;
  /** Confidence score of the extraction (0-1) */
  confidence: number;
}

// ============================================
// DECISION EDGE
// ============================================

/**
 * A directed edge connecting two decision nodes.
 */
export interface DecisionEdge {
  /** Unique identifier */
  id: string;
  /** Source node ID */
  source: string;
  /** Target node ID */
  target: string;
  /** Relationship type */
  type: DecisionEdgeType;
  /** Connection strength (0-1) */
  weight: number;
  /** When this edge was created (ISO 8601) */
  created_at: string;
  /** Additional edge metadata */
  metadata: Record<string, unknown>;
}

// ============================================
// GRAPH EVENT (Event Sourcing)
// ============================================

/**
 * An event in the append-only event store (events.jsonl).
 * Source of truth for graph state reconstruction.
 */
export interface GraphEvent {
  /** Event type */
  type: "node_added" | "edge_added" | "node_updated";
  /** Event payload (the node or edge being added/updated) */
  payload: DecisionNode | DecisionEdge;
  /** When this event was recorded (ISO 8601) */
  timestamp: string;
}

// ============================================
// GRAPH STATE (Materialized Index)
// ============================================

/**
 * Materialized graph state persisted via StateManager.
 * Rebuilt from events.jsonl on demand.
 */
export interface ContextGraphState {
  /** Total number of nodes */
  nodeCount: number;
  /** Total number of edges */
  edgeCount: number;
  /** Node counts by type */
  nodesByType: Record<DecisionNodeType, number>;
  /** Edge counts by type */
  edgesByType: Record<DecisionEdgeType, number>;
  /** ISO timestamp of last extraction run */
  lastCapture: string;
  /** Schema version for migrations */
  version: number;
  /** All nodes indexed by ID */
  nodes: Record<string, DecisionNode>;
  /** All edges indexed by ID */
  edges: Record<string, DecisionEdge>;
  /** Adjacency list: nodeId -> array of edge IDs */
  adjacency: Record<string, string[]>;
  /** Reverse adjacency: nodeId -> array of edge IDs pointing TO this node */
  reverseAdjacency: Record<string, string[]>;
}

// ============================================
// EXTRACTION STATE
// ============================================

/**
 * Tracks the last extraction position for each data source.
 * Persisted in State/last-capture.json via StateManager.
 */
export interface ExtractionState {
  /** Per-source extraction cursors */
  sources: Record<string, SourceCursor>;
  /** ISO timestamp of last extraction run */
  lastRun: string;
  /** Total decisions extracted across all runs */
  totalExtracted: number;
}

/**
 * Extraction cursor for a single data source.
 */
export interface SourceCursor {
  /** Source name */
  name: string;
  /** Last processed timestamp (ISO 8601) */
  lastTimestamp: string;
  /** Last processed line number (for JSONL sources) */
  lastLine: number;
  /** Count of items extracted from this source */
  extracted: number;
}

// ============================================
// DATA SOURCE CONFIG
// ============================================

/**
 * Configuration for a data source to extract decisions from.
 */
export interface DataSourceConfig {
  /** Source identifier */
  name: string;
  /** File path or glob pattern */
  path: string;
  /** Source format */
  format: "jsonl" | "yaml-frontmatter" | "json" | "directory";
  /** Signal detection rules */
  signals: SignalRule[];
}

/**
 * A rule for detecting decision-worthy signals in data.
 */
export interface SignalRule {
  /** Rule name */
  name: string;
  /** Field to check */
  field: string;
  /** Condition operator */
  operator: "lte" | "gte" | "eq" | "delta_gte" | "contains" | "exists";
  /** Threshold or match value */
  value: number | string;
  /** What node type to create */
  nodeType: DecisionNodeType;
  /** Confidence for nodes created by this rule */
  confidence: number;
}

// ============================================
// EDGE RULE CONFIG
// ============================================

/**
 * Rule for automatic edge creation.
 */
export interface EdgeRule {
  /** Rule name */
  name: string;
  /** Edge type to create */
  edgeType: DecisionEdgeType;
  /** Condition for creating this edge */
  condition: EdgeCondition;
  /** Default weight for edges created by this rule */
  defaultWeight: number;
}

/**
 * Condition for automatic edge creation.
 */
export interface EdgeCondition {
  /** Type of condition */
  type: "temporal" | "session" | "tag_overlap" | "causal" | "correction";
  /** Maximum time delta in minutes (for temporal conditions) */
  maxDeltaMinutes?: number;
  /** Required same-field match */
  sameField?: string;
  /** Minimum tag overlap count */
  minTagOverlap?: number;
}

// ============================================
// UTILITY TYPES
// ============================================

/**
 * Result of a decision chain trace.
 */
export interface TraceResult {
  /** Root node the trace started from */
  root: DecisionNode;
  /** All nodes in the trace chain */
  chain: DecisionNode[];
  /** All edges connecting nodes in the chain */
  edges: DecisionEdge[];
  /** Maximum depth reached */
  depth: number;
}

/**
 * Search result from graph queries.
 */
export interface GraphSearchResult {
  /** Matching node */
  node: DecisionNode;
  /** Relevance score (0-1) */
  relevance: number;
  /** Which fields matched */
  matchedFields: string[];
}

/**
 * Graph statistics summary.
 */
export interface GraphStatsSummary {
  nodeCount: number;
  edgeCount: number;
  nodesByType: Record<DecisionNodeType, number>;
  edgesByType: Record<DecisionEdgeType, number>;
  lastCapture: string;
  oldestNode: string;
  newestNode: string;
  avgEdgesPerNode: number;
  topConnectedNodes: Array<{ id: string; title: string; connections: number }>;
}
