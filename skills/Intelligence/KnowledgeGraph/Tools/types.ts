/**
 * KnowledgeGraph Type Definitions
 *
 * General-purpose knowledge graph abstraction with Obsidian vault as
 * the first implementation. Designed to support:
 *   1. Obsidian vault navigation (wikilinks, tags, folders)
 *   2. AI agent context graphs (node relevance, traversal)
 *   3. Personal learning knowledge graphs (prerequisites, gaps)
 *
 * These types are implementation-agnostic. The GraphBuilder creates
 * these from a specific source (Obsidian), but any document corpus
 * could populate the same structures.
 */

// ============================================
// CORE GRAPH PRIMITIVES
// ============================================

/**
 * A node in the knowledge graph. Represents a single document/note.
 * Source-agnostic: could come from Obsidian, a codebase, or any corpus.
 */
export interface GraphNode {
  /** Unique identifier - relative path from source root */
  id: string;
  /** Human-readable title (H1 heading or filename) */
  title: string;
  /** Parent folder/directory path */
  folder: string;
  /** Tags/labels assigned to this node */
  tags: string[];
  /** Sub-headings (H2+) representing sub-concepts */
  headings: string[];
  /** Word count of the node content */
  wordCount: number;
  /** Last modified timestamp (ISO 8601) */
  modified: string;
  /** IDs of nodes this node links TO (outgoing edges) */
  outLinks: string[];
  /** IDs of nodes that link TO this node (incoming edges) */
  inLinks: string[];
  /** IDs of embedded/transcluded nodes */
  embeds: string[];
  /** Alternative names for this node (from frontmatter aliases) */
  aliases: string[];
}

/**
 * An edge connecting two nodes in the graph.
 */
export interface GraphEdge {
  /** Source node ID */
  source: string;
  /** Target node ID */
  target: string;
  /** Type of connection */
  type: EdgeType;
  /** Connection strength (0-1 normalized) */
  weight: number;
  /** Optional surrounding context text for the link */
  context?: string;
}

/**
 * Types of edges in the knowledge graph.
 *   - wikilink: explicit [[link]] between notes
 *   - tag: shared tag membership
 *   - folder: co-location in same folder
 *   - semantic: inferred conceptual similarity
 *   - embed: transclusion/embedding reference
 */
export type EdgeType = 'wikilink' | 'tag' | 'folder' | 'semantic' | 'embed';

// ============================================
// GRAPH STATE (Persisted)
// ============================================

/**
 * Complete graph state, serializable to JSON for caching.
 */
export interface GraphState {
  /** Schema version for migration support */
  version: number;
  /** ISO timestamp of when graph was built */
  built: string;
  /** Hours before rebuild is recommended */
  ttl: number;
  /** All nodes in the graph */
  nodes: GraphNode[];
  /** All edges in the graph */
  edges: GraphEdge[];
  /** Detected concept clusters */
  clusters: ConceptCluster[];
  /** Aggregate statistics */
  stats: GraphStats;
}

// ============================================
// CLUSTERING
// ============================================

/**
 * A cluster of conceptually related nodes.
 * Detected by community detection algorithms on the link graph.
 */
export interface ConceptCluster {
  /** Unique cluster identifier */
  id: string;
  /** Human-readable cluster label (inferred from dominant tags/folders) */
  label: string;
  /** Node IDs belonging to this cluster */
  nodes: string[];
  /** Dominant tags in this cluster */
  tags: string[];
  /** Bridge notes connecting this cluster to others */
  bridgeNotes: string[];
  /** Internal connectivity ratio (0-1): edges / possible edges */
  density: number;
}

// ============================================
// STATISTICS
// ============================================

/**
 * Aggregate graph statistics for quick reporting.
 */
export interface GraphStats {
  totalNodes: number;
  totalEdges: number;
  orphanCount: number;
  brokenLinks: string[];
  avgConnections: number;
  mostConnected: string[];
  leastConnected: string[];
  clusterCount: number;
  /** Total tags with their counts */
  tagCounts: Record<string, number>;
  /** Folder distribution */
  folderCounts: Record<string, number>;
}

// ============================================
// SEMANTIC INDEX
// ============================================

/**
 * Keyword-based concept index for a single node.
 * Uses TF-IDF style keyword extraction instead of embeddings
 * for simplicity and zero API cost.
 */
export interface ConceptIndex {
  /** Node ID */
  nodeId: string;
  /** Extracted keywords with their TF-IDF scores */
  keywords: KeywordScore[];
  /** Extracted key phrases (2-3 word combinations) */
  phrases: string[];
}

export interface KeywordScore {
  /** The keyword/term */
  term: string;
  /** TF-IDF score (higher = more distinctive to this document) */
  score: number;
}

/**
 * Complete semantic index state, persisted alongside graph state.
 */
export interface SemanticIndexState {
  version: number;
  built: string;
  /** Per-node concept indices */
  indices: ConceptIndex[];
  /** Global document frequency counts */
  documentFrequency: Record<string, number>;
  /** Total number of documents indexed */
  totalDocuments: number;
}

/**
 * A search result from the semantic index.
 */
export interface SearchResult {
  /** Node ID */
  nodeId: string;
  /** Node title */
  title: string;
  /** Folder path */
  folder: string;
  /** Relevance score (0-1 normalized) */
  score: number;
  /** Matched keywords */
  matchedTerms: string[];
  /** Matched phrases */
  matchedPhrases: string[];
}

// ============================================
// GAP DETECTION
// ============================================

/**
 * Types of knowledge gaps that can be detected.
 */
export type GapType =
  | 'orphan'        // No in/out links
  | 'broken_link'   // Referenced but nonexistent note
  | 'stub'          // < 100 words with no outlinks
  | 'thin_cluster'  // Cluster with < 3 notes
  | 'missing_topic' // Referenced in multiple notes but has no dedicated note
  | 'weak_bridge'   // Two clusters with only 1 connection;

/**
 * A detected knowledge gap.
 */
export interface KnowledgeGap {
  /** Gap type */
  type: GapType;
  /** Human-readable description */
  description: string;
  /** Severity: how impactful this gap is */
  severity: 'low' | 'medium' | 'high';
  /** Node IDs related to this gap */
  relatedNodes: string[];
  /** Suggested action to fill the gap */
  suggestion: string;
  /** TELOS goal IDs this gap relates to (if any) */
  telosGoals: string[];
}

/**
 * A template for creating a new note to fill a detected gap.
 */
export interface NoteTemplate {
  /** Suggested file path (relative to vault root) */
  path: string;
  /** Note title */
  title: string;
  /** Frontmatter tags */
  tags: string[];
  /** Template content */
  content: string;
  /** Gap this note addresses */
  gap: KnowledgeGap;
}

// ============================================
// GRAPH OPERATIONS
// ============================================

/**
 * Options for building the graph from a source.
 */
export interface GraphBuildOptions {
  /** Root directory to scan */
  rootPath: string;
  /** Folder prefixes to exclude */
  excludePrefixes: string[];
  /** File extensions to include */
  includeExtensions: string[];
  /** Whether to compute folder co-membership edges */
  includeFolderEdges: boolean;
  /** Whether to compute shared-tag edges */
  includeTagEdges: boolean;
}

/**
 * Options for traversing the graph.
 */
export interface TraversalOptions {
  /** Starting node ID */
  startNode: string;
  /** Maximum traversal depth */
  maxDepth: number;
  /** Edge types to traverse */
  edgeTypes: EdgeType[];
  /** Maximum nodes to return */
  maxNodes: number;
}

/**
 * Result of a graph traversal operation.
 */
export interface TraversalResult {
  /** Nodes found during traversal */
  nodes: GraphNode[];
  /** Edges connecting the traversed nodes */
  edges: GraphEdge[];
  /** Path from start to each discovered node */
  paths: Map<string, string[]>;
}

/**
 * Default graph build options for Obsidian vault.
 */
export const DEFAULT_OBSIDIAN_OPTIONS: GraphBuildOptions = {
  rootPath: '/Users/[user]/Desktop/obsidian',
  excludePrefixes: ['.', '_'],
  includeExtensions: ['.md'],
  includeFolderEdges: true,
  includeTagEdges: true,
};
