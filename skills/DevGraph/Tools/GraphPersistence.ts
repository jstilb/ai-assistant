#!/usr/bin/env bun
/**
 * GraphPersistence - JSONL-based file storage for DevGraph
 *
 * Append-only JSONL files per node/edge type.
 * Uses StateManager for meta.json persistence.
 * Deduplication via node/edge ID.
 * Incremental ingestion tracking.
 *
 * Storage layout:
 *   MEMORY/DEVGRAPH/
 *   +-- meta.json          (graph metadata via StateManager)
 *   +-- nodes/
 *   |   +-- session.jsonl
 *   |   +-- commit.jsonl
 *   |   +-- ...
 *   +-- edges/
 *       +-- produced.jsonl
 *       +-- modifies.jsonl
 *       +-- ...
 *
 * @module DevGraph/GraphPersistence
 * @version 1.0.0
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import { createStateManager } from '../../CORE/Tools/StateManager';
import type { DevNode, DevEdge, DevGraphState, DevNodeType, DevEdgeType } from './types';
import { ALL_NODE_TYPES, ALL_EDGE_TYPES, createEmptyGraphState } from './types';
import { GraphEngine } from './GraphEngine';

// ============================================
// CONSTANTS
// ============================================

const KAYA_HOME = join(homedir(), '.claude');
const DEVGRAPH_DIR = join(KAYA_HOME, 'MEMORY', 'DEVGRAPH');
const NODES_DIR = join(DEVGRAPH_DIR, 'nodes');
const EDGES_DIR = join(DEVGRAPH_DIR, 'edges');
const META_PATH = join(DEVGRAPH_DIR, 'meta.json');

// ============================================
// STATE SCHEMA
// ============================================

const DevGraphStateSchema = z.object({
  version: z.number(),
  lastIngested: z.string(),
  nodeCount: z.number(),
  edgeCount: z.number(),
  nodesByType: z.record(z.string(), z.number()),
  edgesByType: z.record(z.string(), z.number()),
});

// ============================================
// GRAPH PERSISTENCE
// ============================================

export class GraphPersistence {
  private baseDir: string;
  private nodesDir: string;
  private edgesDir: string;
  private metaPath: string;
  private stateManager: ReturnType<typeof createStateManager<DevGraphState>>;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || DEVGRAPH_DIR;
    this.nodesDir = join(this.baseDir, 'nodes');
    this.edgesDir = join(this.baseDir, 'edges');
    this.metaPath = join(this.baseDir, 'meta.json');

    this.stateManager = createStateManager<DevGraphState>({
      path: this.metaPath,
      schema: DevGraphStateSchema as z.ZodSchema<DevGraphState>,
      defaults: createEmptyGraphState,
    });

    this.ensureDirectories();
  }

  // ============================================
  // DIRECTORY SETUP
  // ============================================

  private ensureDirectories(): void {
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true });
    if (!existsSync(this.nodesDir)) mkdirSync(this.nodesDir, { recursive: true });
    if (!existsSync(this.edgesDir)) mkdirSync(this.edgesDir, { recursive: true });
  }

  // ============================================
  // FILE PATHS
  // ============================================

  private nodeFilePath(type: DevNodeType): string {
    return join(this.nodesDir, `${type}.jsonl`);
  }

  private edgeFilePath(type: DevEdgeType): string {
    return join(this.edgesDir, `${type}.jsonl`);
  }

  // ============================================
  // NODE OPERATIONS
  // ============================================

  /**
   * Append a node to its type-specific JSONL file.
   * Skips if a node with the same ID already exists in that file.
   * @returns true if appended, false if duplicate
   */
  appendNode(node: DevNode): boolean {
    const filePath = this.nodeFilePath(node.type);
    const existingIds = this.loadNodeIds(node.type);

    if (existingIds.has(node.id)) return false;

    const line = JSON.stringify(node) + '\n';
    appendFileSync(filePath, line);
    return true;
  }

  /**
   * Append multiple nodes, skipping duplicates.
   * @returns Count of nodes actually appended
   */
  appendNodes(nodes: DevNode[]): number {
    let count = 0;
    // Group by type for efficient dedup checking
    const byType = new Map<DevNodeType, DevNode[]>();
    for (const node of nodes) {
      const group = byType.get(node.type) || [];
      group.push(node);
      byType.set(node.type, group);
    }

    for (const [type, typeNodes] of byType) {
      const existingIds = this.loadNodeIds(type);
      const filePath = this.nodeFilePath(type);
      let batch = '';

      for (const node of typeNodes) {
        if (!existingIds.has(node.id)) {
          batch += JSON.stringify(node) + '\n';
          existingIds.add(node.id);
          count++;
        }
      }

      if (batch) {
        appendFileSync(filePath, batch);
      }
    }

    return count;
  }

  /**
   * Load all nodes of a given type from JSONL.
   */
  loadNodes(type: DevNodeType): DevNode[] {
    const filePath = this.nodeFilePath(type);
    if (!existsSync(filePath)) return [];

    const content = readFileSync(filePath, 'utf-8');
    const nodes: DevNode[] = [];

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        nodes.push(JSON.parse(line) as DevNode);
      } catch {
        // Skip malformed lines
      }
    }

    return nodes;
  }

  /**
   * Load all nodes of all types.
   */
  loadAllNodes(): DevNode[] {
    const all: DevNode[] = [];
    for (const type of ALL_NODE_TYPES) {
      all.push(...this.loadNodes(type));
    }
    return all;
  }

  /**
   * Load just the IDs of nodes of a given type (for dedup).
   */
  private loadNodeIds(type: DevNodeType): Set<string> {
    const filePath = this.nodeFilePath(type);
    if (!existsSync(filePath)) return new Set();

    const ids = new Set<string>();
    const content = readFileSync(filePath, 'utf-8');

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.id) ids.add(parsed.id);
      } catch {
        // Skip
      }
    }

    return ids;
  }

  // ============================================
  // EDGE OPERATIONS
  // ============================================

  /**
   * Append an edge to its type-specific JSONL file.
   * Skips if an edge with the same ID already exists.
   * @returns true if appended, false if duplicate
   */
  appendEdge(edge: DevEdge): boolean {
    const filePath = this.edgeFilePath(edge.type);
    const existingIds = this.loadEdgeIds(edge.type);

    if (existingIds.has(edge.id)) return false;

    const line = JSON.stringify(edge) + '\n';
    appendFileSync(filePath, line);
    return true;
  }

  /**
   * Append multiple edges, skipping duplicates.
   * @returns Count of edges actually appended
   */
  appendEdges(edges: DevEdge[]): number {
    let count = 0;
    const byType = new Map<DevEdgeType, DevEdge[]>();
    for (const edge of edges) {
      const group = byType.get(edge.type) || [];
      group.push(edge);
      byType.set(edge.type, group);
    }

    for (const [type, typeEdges] of byType) {
      const existingIds = this.loadEdgeIds(type);
      const filePath = this.edgeFilePath(type);
      let batch = '';

      for (const edge of typeEdges) {
        if (!existingIds.has(edge.id)) {
          batch += JSON.stringify(edge) + '\n';
          existingIds.add(edge.id);
          count++;
        }
      }

      if (batch) {
        appendFileSync(filePath, batch);
      }
    }

    return count;
  }

  /**
   * Load all edges of a given type from JSONL.
   */
  loadEdges(type: DevEdgeType): DevEdge[] {
    const filePath = this.edgeFilePath(type);
    if (!existsSync(filePath)) return [];

    const content = readFileSync(filePath, 'utf-8');
    const edges: DevEdge[] = [];

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        edges.push(JSON.parse(line) as DevEdge);
      } catch {
        // Skip malformed lines
      }
    }

    return edges;
  }

  /**
   * Load all edges of all types.
   */
  loadAllEdges(): DevEdge[] {
    const all: DevEdge[] = [];
    for (const type of ALL_EDGE_TYPES) {
      all.push(...this.loadEdges(type));
    }
    return all;
  }

  /**
   * Load just the IDs of edges of a given type (for dedup).
   */
  private loadEdgeIds(type: DevEdgeType): Set<string> {
    const filePath = this.edgeFilePath(type);
    if (!existsSync(filePath)) return new Set();

    const ids = new Set<string>();
    const content = readFileSync(filePath, 'utf-8');

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.id) ids.add(parsed.id);
      } catch {
        // Skip
      }
    }

    return ids;
  }

  // ============================================
  // GRAPH ENGINE HYDRATION
  // ============================================

  /**
   * Load all persisted data into a GraphEngine instance.
   * Rebuilds adjacency lists from JSONL files.
   */
  loadIntoEngine(engine?: GraphEngine): GraphEngine {
    const graph = engine || new GraphEngine();

    const nodes = this.loadAllNodes();
    const edges = this.loadAllEdges();

    graph.loadFromArrays(nodes, edges);

    return graph;
  }

  // ============================================
  // META STATE
  // ============================================

  /**
   * Load graph metadata.
   */
  async loadMeta(): Promise<DevGraphState> {
    return this.stateManager.load();
  }

  /**
   * Save graph metadata.
   */
  async saveMeta(state: DevGraphState): Promise<void> {
    return this.stateManager.save(state);
  }

  /**
   * Update graph metadata atomically.
   */
  async updateMeta(fn: (state: DevGraphState) => DevGraphState): Promise<DevGraphState> {
    return this.stateManager.update(fn);
  }

  /**
   * Recalculate and save meta.json from the actual JSONL files.
   */
  async rebuildMeta(): Promise<DevGraphState> {
    const state = createEmptyGraphState();

    for (const type of ALL_NODE_TYPES) {
      const nodes = this.loadNodes(type);
      state.nodesByType[type] = nodes.length;
      state.nodeCount += nodes.length;
    }

    for (const type of ALL_EDGE_TYPES) {
      const edges = this.loadEdges(type);
      state.edgesByType[type] = edges.length;
      state.edgeCount += edges.length;
    }

    state.lastIngested = new Date().toISOString();
    await this.saveMeta(state);
    return state;
  }

  /**
   * Get the base directory path.
   */
  getBaseDir(): string {
    return this.baseDir;
  }
}

// ============================================
// SINGLETON
// ============================================

let _instance: GraphPersistence | null = null;

/**
 * Get the default GraphPersistence instance.
 */
export function getGraphPersistence(): GraphPersistence {
  if (!_instance) {
    _instance = new GraphPersistence();
  }
  return _instance;
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const persistence = getGraphPersistence();

  const args = process.argv.slice(2);

  if (args.includes('--rebuild-meta')) {
    console.log('Rebuilding meta.json from JSONL files...');
    const state = await persistence.rebuildMeta();
    console.log('Graph state:', JSON.stringify(state, null, 2));
  } else if (args.includes('--load')) {
    console.log('Loading graph into engine...');
    const engine = persistence.loadIntoEngine();
    const stats = engine.getStats();
    console.log(`Loaded ${stats.nodeCount} nodes, ${stats.edgeCount} edges`);
    console.log('Stats:', JSON.stringify(stats, null, 2));
  } else {
    console.log('GraphPersistence CLI');
    console.log('====================');
    console.log(`Base directory: ${persistence.getBaseDir()}`);
    console.log('');
    console.log('Usage:');
    console.log('  bun GraphPersistence.ts --rebuild-meta   Rebuild meta.json from JSONL');
    console.log('  bun GraphPersistence.ts --load           Load graph and show stats');
  }
}
