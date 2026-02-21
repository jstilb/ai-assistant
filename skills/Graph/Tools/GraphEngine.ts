#!/usr/bin/env bun
/**
 * GraphEngine - In-memory graph with adjacency lists
 *
 * Pure TypeScript implementation with ZERO external graph dependencies.
 * Provides BFS/DFS traversal, shortest path, neighborhood queries,
 * filtered traversal, reverse traversal, and connected components.
 *
 * Usage:
 *   import { GraphEngine } from './GraphEngine';
 *   const engine = new GraphEngine();
 *   engine.addNode(node);
 *   engine.addEdge(edge);
 *   const neighbors = engine.getNeighbors('node-id', 2);
 *
 * @module Graph/GraphEngine
 * @version 1.0.0
 */

import type {
  GraphNode,
  GraphEdge,
  GraphEdgeType,
  GraphNodeType,
  GraphState,
} from './types';
import { ALL_NODE_TYPES, ALL_EDGE_TYPES, createEmptyGraphState } from './types';

// ============================================
// ADJACENCY LIST ENTRY
// ============================================

interface AdjacencyEntry {
  /** Target node ID */
  target: string;
  /** Edge ID */
  edgeId: string;
  /** Edge type */
  type: GraphEdgeType;
  /** Edge weight */
  weight: number;
}

// ============================================
// GRAPH ENGINE
// ============================================

export class GraphEngine {
  /** All nodes by ID */
  private nodes: Map<string, GraphNode> = new Map();
  /** All edges by ID */
  private edges: Map<string, GraphEdge> = new Map();
  /** Forward adjacency list: nodeId -> outgoing edges */
  private forward: Map<string, AdjacencyEntry[]> = new Map();
  /** Reverse adjacency list: nodeId -> incoming edges */
  private reverse: Map<string, AdjacencyEntry[]> = new Map();

  // ============================================
  // NODE OPERATIONS
  // ============================================

  /**
   * Add a node to the graph. Skips if node with same ID already exists.
   * @returns true if node was added, false if duplicate
   */
  addNode(node: GraphNode): boolean {
    if (this.nodes.has(node.id)) return false;
    this.nodes.set(node.id, node);
    if (!this.forward.has(node.id)) this.forward.set(node.id, []);
    if (!this.reverse.has(node.id)) this.reverse.set(node.id, []);
    return true;
  }

  /**
   * Get a node by ID.
   */
  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  /**
   * Check if a node exists.
   */
  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  /**
   * Get all nodes, optionally filtered by type.
   */
  getNodes(type?: GraphNodeType): GraphNode[] {
    const all = Array.from(this.nodes.values());
    if (type) return all.filter(n => n.type === type);
    return all;
  }

  /**
   * Get total node count.
   */
  get nodeCount(): number {
    return this.nodes.size;
  }

  // ============================================
  // EDGE OPERATIONS
  // ============================================

  /**
   * Add an edge to the graph. Skips if edge with same ID already exists.
   * @returns true if edge was added, false if duplicate
   */
  addEdge(edge: GraphEdge): boolean {
    if (this.edges.has(edge.id)) return false;
    this.edges.set(edge.id, edge);

    // Forward adjacency
    const fwd = this.forward.get(edge.source) || [];
    fwd.push({
      target: edge.target,
      edgeId: edge.id,
      type: edge.type,
      weight: edge.weight,
    });
    this.forward.set(edge.source, fwd);

    // Reverse adjacency
    const rev = this.reverse.get(edge.target) || [];
    rev.push({
      target: edge.source,
      edgeId: edge.id,
      type: edge.type,
      weight: edge.weight,
    });
    this.reverse.set(edge.target, rev);

    return true;
  }

  /**
   * Get an edge by ID.
   */
  getEdge(id: string): GraphEdge | undefined {
    return this.edges.get(id);
  }

  /**
   * Get all edges, optionally filtered by type.
   */
  getEdges(type?: GraphEdgeType): GraphEdge[] {
    const all = Array.from(this.edges.values());
    if (type) return all.filter(e => e.type === type);
    return all;
  }

  /**
   * Get total edge count.
   */
  get edgeCount(): number {
    return this.edges.size;
  }

  // ============================================
  // TRAVERSAL: BFS
  // ============================================

  /**
   * Breadth-first traversal from a starting node.
   * @param startId Starting node ID
   * @param maxDepth Maximum depth to traverse (default: Infinity)
   * @param edgeTypes Optional filter by edge types
   * @param direction 'forward' | 'reverse' | 'both'
   * @returns Array of { node, depth } in BFS order
   */
  bfs(
    startId: string,
    maxDepth: number = Infinity,
    edgeTypes?: GraphEdgeType[],
    direction: 'forward' | 'reverse' | 'both' = 'forward',
  ): Array<{ node: GraphNode; depth: number }> {
    const result: Array<{ node: GraphNode; depth: number }> = [];
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (visited.has(id) || depth > maxDepth) continue;
      visited.add(id);

      const node = this.nodes.get(id);
      if (node) result.push({ node, depth });

      if (depth >= maxDepth) continue;

      const neighbors = this.getAdjacent(id, direction, edgeTypes);
      for (const adj of neighbors) {
        if (!visited.has(adj.target)) {
          queue.push({ id: adj.target, depth: depth + 1 });
        }
      }
    }

    return result;
  }

  // ============================================
  // TRAVERSAL: DFS
  // ============================================

  /**
   * Depth-first traversal from a starting node.
   * @param startId Starting node ID
   * @param maxDepth Maximum depth to traverse (default: Infinity)
   * @param edgeTypes Optional filter by edge types
   * @param direction 'forward' | 'reverse' | 'both'
   * @returns Array of { node, depth } in DFS order
   */
  dfs(
    startId: string,
    maxDepth: number = Infinity,
    edgeTypes?: GraphEdgeType[],
    direction: 'forward' | 'reverse' | 'both' = 'forward',
  ): Array<{ node: GraphNode; depth: number }> {
    const result: Array<{ node: GraphNode; depth: number }> = [];
    const visited = new Set<string>();

    const visit = (id: string, depth: number) => {
      if (visited.has(id) || depth > maxDepth) return;
      visited.add(id);

      const node = this.nodes.get(id);
      if (node) result.push({ node, depth });

      if (depth >= maxDepth) return;

      const neighbors = this.getAdjacent(id, direction, edgeTypes);
      for (const adj of neighbors) {
        visit(adj.target, depth + 1);
      }
    };

    visit(startId, 0);
    return result;
  }

  // ============================================
  // SHORTEST PATH (BFS on unweighted)
  // ============================================

  /**
   * Find shortest path between two nodes using BFS.
   * Treats all edges as having equal weight (unweighted).
   * @returns Array of node IDs forming the path, or null if no path exists
   */
  shortestPath(
    fromId: string,
    toId: string,
    edgeTypes?: GraphEdgeType[],
  ): string[] | null {
    if (fromId === toId) return [fromId];
    if (!this.nodes.has(fromId) || !this.nodes.has(toId)) return null;

    const visited = new Set<string>();
    const parent = new Map<string, string>();
    const queue: string[] = [fromId];
    visited.add(fromId);

    while (queue.length > 0) {
      const current = queue.shift()!;

      const neighbors = this.getAdjacent(current, 'both', edgeTypes);
      for (const adj of neighbors) {
        if (visited.has(adj.target)) continue;
        visited.add(adj.target);
        parent.set(adj.target, current);

        if (adj.target === toId) {
          // Reconstruct path
          const path: string[] = [toId];
          let node = toId;
          while (node !== fromId) {
            node = parent.get(node)!;
            path.unshift(node);
          }
          return path;
        }

        queue.push(adj.target);
      }
    }

    return null; // No path found
  }

  // ============================================
  // NEIGHBORHOOD QUERIES
  // ============================================

  /**
   * Get N-hop neighbors of a node.
   * @param nodeId Starting node ID
   * @param depth Number of hops (default: 1)
   * @param edgeTypes Optional filter by edge types
   * @returns Array of neighbor nodes with their depth
   */
  getNeighbors(
    nodeId: string,
    depth: number = 1,
    edgeTypes?: GraphEdgeType[],
  ): Array<{ node: GraphNode; depth: number }> {
    return this.bfs(nodeId, depth, edgeTypes, 'both')
      .filter(r => r.node.id !== nodeId); // Exclude the starting node
  }

  // ============================================
  // REVERSE TRAVERSAL
  // ============================================

  /**
   * Trace backward from a node (what caused/produced X?).
   * Uses reverse adjacency list.
   * @param nodeId Starting node ID
   * @param depth Maximum depth to trace back
   * @param edgeTypes Optional filter by edge types
   * @returns Array of predecessor nodes
   */
  traceBackward(
    nodeId: string,
    depth: number = 3,
    edgeTypes?: GraphEdgeType[],
  ): Array<{ node: GraphNode; depth: number }> {
    return this.bfs(nodeId, depth, edgeTypes, 'reverse')
      .filter(r => r.node.id !== nodeId);
  }

  /**
   * Trace forward from a node (what did X produce/cause?).
   * @param nodeId Starting node ID
   * @param depth Maximum depth to trace forward
   * @param edgeTypes Optional filter by edge types
   * @returns Array of successor nodes
   */
  traceForward(
    nodeId: string,
    depth: number = 3,
    edgeTypes?: GraphEdgeType[],
  ): Array<{ node: GraphNode; depth: number }> {
    return this.bfs(nodeId, depth, edgeTypes, 'forward')
      .filter(r => r.node.id !== nodeId);
  }

  // ============================================
  // CONNECTED COMPONENTS
  // ============================================

  /**
   * Detect connected components in the graph.
   * Treats edges as undirected for component detection.
   * @returns Array of components, each being an array of node IDs
   */
  getConnectedComponents(): string[][] {
    const visited = new Set<string>();
    const components: string[][] = [];

    for (const nodeId of this.nodes.keys()) {
      if (visited.has(nodeId)) continue;

      const component: string[] = [];
      const queue: string[] = [nodeId];

      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);
        component.push(current);

        // Both directions for undirected component detection
        const neighbors = this.getAdjacent(current, 'both');
        for (const adj of neighbors) {
          if (!visited.has(adj.target)) {
            queue.push(adj.target);
          }
        }
      }

      if (component.length > 0) {
        components.push(component);
      }
    }

    return components;
  }

  // ============================================
  // FILTERED QUERIES
  // ============================================

  /**
   * Find nodes matching a filter.
   */
  findNodes(filter: {
    type?: GraphNodeType;
    tags?: string[];
    since?: string;
    until?: string;
    titleContains?: string;
  }): GraphNode[] {
    let results = Array.from(this.nodes.values());

    if (filter.type) {
      results = results.filter(n => n.type === filter.type);
    }

    if (filter.tags && filter.tags.length > 0) {
      results = results.filter(n =>
        filter.tags!.some(t => n.tags.includes(t))
      );
    }

    if (filter.since) {
      const since = new Date(filter.since).getTime();
      results = results.filter(n => new Date(n.created_at).getTime() >= since);
    }

    if (filter.until) {
      const until = new Date(filter.until).getTime();
      results = results.filter(n => new Date(n.created_at).getTime() <= until);
    }

    if (filter.titleContains) {
      const lower = filter.titleContains.toLowerCase();
      results = results.filter(n => n.title.toLowerCase().includes(lower));
    }

    return results;
  }

  /**
   * Find edges between two specific nodes.
   */
  findEdgesBetween(sourceId: string, targetId: string): GraphEdge[] {
    const fwd = this.forward.get(sourceId) || [];
    return fwd
      .filter(adj => adj.target === targetId)
      .map(adj => this.edges.get(adj.edgeId)!)
      .filter(Boolean);
  }

  // ============================================
  // STATISTICS
  // ============================================

  /**
   * Get graph statistics as a GraphState.
   */
  getStats(): GraphState {
    const state = createEmptyGraphState();

    state.nodeCount = this.nodes.size;
    state.edgeCount = this.edges.size;

    for (const node of this.nodes.values()) {
      state.nodesByType[node.type] = (state.nodesByType[node.type] || 0) + 1;
    }

    for (const edge of this.edges.values()) {
      state.edgesByType[edge.type] = (state.edgesByType[edge.type] || 0) + 1;
    }

    return state;
  }

  // ============================================
  // BULK LOAD
  // ============================================

  /**
   * Load nodes and edges from arrays (e.g., from JSONL files).
   * Returns counts of added vs skipped.
   */
  loadFromArrays(
    nodes: GraphNode[],
    edges: GraphEdge[],
  ): { nodesAdded: number; nodesSkipped: number; edgesAdded: number; edgesSkipped: number } {
    let nodesAdded = 0;
    let nodesSkipped = 0;
    let edgesAdded = 0;
    let edgesSkipped = 0;

    for (const node of nodes) {
      if (this.addNode(node)) nodesAdded++;
      else nodesSkipped++;
    }

    for (const edge of edges) {
      if (this.addEdge(edge)) edgesAdded++;
      else edgesSkipped++;
    }

    return { nodesAdded, nodesSkipped, edgesAdded, edgesSkipped };
  }

  /**
   * Clear all nodes and edges from the graph.
   */
  clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.forward.clear();
    this.reverse.clear();
  }

  // ============================================
  // INTERNAL HELPERS
  // ============================================

  /**
   * Get adjacent entries for a node in the specified direction.
   */
  private getAdjacent(
    nodeId: string,
    direction: 'forward' | 'reverse' | 'both',
    edgeTypes?: GraphEdgeType[],
  ): AdjacencyEntry[] {
    let entries: AdjacencyEntry[] = [];

    if (direction === 'forward' || direction === 'both') {
      entries = entries.concat(this.forward.get(nodeId) || []);
    }

    if (direction === 'reverse' || direction === 'both') {
      entries = entries.concat(this.reverse.get(nodeId) || []);
    }

    if (edgeTypes && edgeTypes.length > 0) {
      entries = entries.filter(e => edgeTypes.includes(e.type));
    }

    return entries;
  }
}

// ============================================
// CLI SELF-TEST
// ============================================

if (import.meta.main) {
  const { createNode, createEdge } = await import('./types');

  console.log('GraphEngine Self-Test');
  console.log('====================\n');

  const engine = new GraphEngine();

  // Add nodes
  const s1 = createNode('session', 'session:001', 'Build DevGraph skill');
  const e1 = createNode('error', 'error:001', 'TypeError in types.ts');
  const c1 = createNode('commit', 'commit:abc', 'feat: add types');
  const f1 = createNode('file', 'file:types.ts', 'Tools/types.ts');

  engine.addNode(s1);
  engine.addNode(e1);
  engine.addNode(c1);
  engine.addNode(f1);

  // Add edges
  engine.addEdge(createEdge('contains', s1.id, e1.id));
  engine.addEdge(createEdge('produced', s1.id, c1.id));
  engine.addEdge(createEdge('modifies', c1.id, f1.id));
  engine.addEdge(createEdge('fixed_by', e1.id, c1.id));

  // Test traversal
  console.log('Nodes:', engine.nodeCount);
  console.log('Edges:', engine.edgeCount);

  console.log('\nBFS from session:001 (depth 2):');
  for (const r of engine.bfs('session:001', 2)) {
    console.log(`  [depth=${r.depth}] ${r.node.type}: ${r.node.title}`);
  }

  console.log('\nTrace backward from error:001:');
  for (const r of engine.traceBackward('error:001', 2)) {
    console.log(`  [depth=${r.depth}] ${r.node.type}: ${r.node.title}`);
  }

  console.log('\nShortest path session:001 -> file:types.ts:');
  const path = engine.shortestPath('session:001', 'file:types.ts');
  console.log(`  Path: ${path?.join(' -> ') || 'none'}`);

  console.log('\nNeighbors of commit:abc (depth 1):');
  for (const r of engine.getNeighbors('commit:abc', 1)) {
    console.log(`  ${r.node.type}: ${r.node.title}`);
  }

  console.log('\nConnected components:', engine.getConnectedComponents().length);

  const stats = engine.getStats();
  console.log('\nStats:', JSON.stringify(stats, null, 2));

  console.log('\n[PASS] All GraphEngine operations completed successfully');
}
