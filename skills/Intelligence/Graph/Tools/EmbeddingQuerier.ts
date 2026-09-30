#!/usr/bin/env bun
/**
 * EmbeddingQuerier.ts - Semantic search, hybrid retrieval, and intent classification
 *
 * Builds on EmbeddingEngine for vector similarity and GraphEngine for BFS expansion.
 * All methods degrade gracefully to lexical fallback when the index is missing.
 *
 * @module Graph/EmbeddingQuerier
 * @version 1.0.0
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import type { GraphNode, GraphNodeType } from './types';
import { GraphPersistence } from './GraphPersistence';
import { GraphEngine } from './GraphEngine';
import { EmbeddingEngine, knnSearch, buildNodeText } from './EmbeddingEngine';
import { getSharedGraphDir } from '../../../../lib/core/KayaHome';

// ============================================
// CONSTANTS
// ============================================

const GRAPH_DIR = getSharedGraphDir();
const EMBEDDINGS_DIR = join(GRAPH_DIR, 'embeddings');
const INDEX_DB_PATH = join(EMBEDDINGS_DIR, 'index.db');

/** Default score threshold — below this, results are suppressed */
const DEFAULT_MIN_SCORE = 0.40;

/** Threshold below which intent classification falls back to Haiku */
const INTENT_FALLBACK_THRESHOLD = 0.50;

// ============================================
// RESULT TYPES
// ============================================

export interface SemanticSearchResult {
  node: GraphNode;
  score: number; // cosine similarity (0–1)
  source: 'semantic';
}

export interface HybridSearchResult {
  node: GraphNode;
  score: number;
  source: 'semantic' | 'graph-expansion';
  depth?: number;
  viaNodeId?: string;
}

export interface IntentClassificationResult {
  intent: string;
  confidence: number;
  nodeIds: string[];
}

export interface SemanticSearchOptions {
  type?: GraphNodeType;
  limit?: number;
  minScore?: number;
}

export interface HybridSearchOptions {
  type?: GraphNodeType;
  depth?: number;
  limit?: number;
  minScore?: number;
}

// ============================================
// EMBEDDING QUERIER
// ============================================

export class EmbeddingQuerier {
  private engine: EmbeddingEngine;
  private persistence: GraphPersistence;
  private db: Database | null = null;
  private indexAvailable: boolean = false;
  private _dbPath: string;

  constructor(graphDir?: string) {
    const dir = graphDir ?? GRAPH_DIR;
    const embDir = join(dir, 'embeddings');
    this._dbPath = join(embDir, 'index.db');
    this.persistence = new GraphPersistence(dir);
    this.engine = new EmbeddingEngine(this._dbPath, dir);
  }

  // ============================================
  // LIFECYCLE
  // ============================================

  /**
   * Initialize the querier — open the DB if available.
   * Safe to call when index doesn't exist yet.
   */
  init(): boolean {
    if (!existsSync(this._dbPath)) {
      console.warn('[EmbeddingQuerier] No index.db found — semantic search unavailable, falling back to lexical');
      this.indexAvailable = false;
      return false;
    }
    try {
      this.db = new Database(this._dbPath, { readonly: true });
      this.indexAvailable = true;
      return true;
    } catch (err) {
      console.warn('[EmbeddingQuerier] Failed to open index.db:', err);
      this.indexAvailable = false;
      return false;
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  // ============================================
  // SEMANTIC SEARCH
  // ============================================

  /**
   * Semantic search: embed query, score against index, return top-K nodes.
   * Falls back to lexical titleContains search if index unavailable.
   */
  async semanticSearch(
    query: string,
    options: SemanticSearchOptions = {},
  ): Promise<SemanticSearchResult[]> {
    const limit = options.limit ?? 10;
    const minScore = options.minScore ?? DEFAULT_MIN_SCORE;

    // Graceful degradation path
    if (!this.indexAvailable || !this.db) {
      console.warn('[EmbeddingQuerier] Index unavailable — falling back to lexical search');
      return this._lexicalFallback(query, options.type, limit);
    }

    let queryVec: Float32Array;
    try {
      queryVec = await this.engine.embedText(query);
    } catch {
      console.warn('[EmbeddingQuerier] Embed failed — falling back to lexical search');
      return this._lexicalFallback(query, options.type, limit);
    }

    const candidates = knnSearch(this.db, queryVec, limit * 2, options.type, minScore);

    // Load actual nodes from persistence. excludeExpired (Slice C1): a
    // superseded outcome/decision must stop ranking/competing here — this
    // IS the candidate hydration for semantic search.
    const allNodes = this.persistence.loadAllNodes({ excludeExpired: true });
    const nodeMap = new Map<string, GraphNode>();
    for (const n of allNodes) nodeMap.set(n.id, n);

    const results: SemanticSearchResult[] = [];
    for (const c of candidates) {
      const node = nodeMap.get(c.nodeId);
      if (!node) continue;
      results.push({ node, score: c.score, source: 'semantic' });
    }

    // Sort descending, apply limit
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * Lexical fallback using GraphEngine.findNodes({ titleContains }).
   */
  private _lexicalFallback(
    query: string,
    type: GraphNodeType | undefined,
    limit: number,
  ): SemanticSearchResult[] {
    const graph = this.persistence.loadIntoEngine();
    const nodes = graph.findNodes({ titleContains: query, type }).slice(0, limit);
    return nodes.map(node => ({ node, score: 0, source: 'semantic' as const }));
  }

  // ============================================
  // HYBRID SEARCH
  // ============================================

  /**
   * Hybrid search: semantic seeds + BFS graph expansion.
   * Returns both semantic results and relational neighbors.
   */
  async hybridSearch(
    query: string,
    options: HybridSearchOptions = {},
  ): Promise<HybridSearchResult[]> {
    const depth = options.depth ?? 2;
    const limit = options.limit ?? 20;
    const minScore = options.minScore ?? DEFAULT_MIN_SCORE;

    // Get semantic seeds (top-10)
    const seeds = await this.semanticSearch(query, {
      type: options.type,
      limit: 10,
      minScore,
    });

    if (seeds.length === 0) return [];

    // Load graph engine for BFS expansion
    const graph = this.persistence.loadIntoEngine();

    const results = new Map<string, HybridSearchResult>();

    // Add seeds first
    for (const seed of seeds) {
      results.set(seed.node.id, {
        node: seed.node,
        score: seed.score,
        source: 'semantic',
      });
    }

    // BFS expand each seed
    for (const seed of seeds) {
      const neighbors = graph.getNeighbors(seed.node.id, depth);
      for (const { node, depth: d } of neighbors) {
        if (results.has(node.id)) continue; // already present
        results.set(node.id, {
          node,
          score: seed.score * (1 / (d + 1)), // distance-discounted score
          source: 'graph-expansion',
          depth: d,
          viaNodeId: seed.node.id,
        });
      }
    }

    // Sort: seeds first (by score desc), then expansions (by score desc)
    const all = Array.from(results.values());
    const semanticSeeds = all
      .filter(r => r.source === 'semantic')
      .sort((a, b) => b.score - a.score);
    const expansions = all
      .filter(r => r.source === 'graph-expansion')
      .sort((a, b) => b.score - a.score);

    return [...semanticSeeds, ...expansions].slice(0, limit);
  }

  // ============================================
  // INTENT CLASSIFICATION
  // ============================================

  /**
   * Classify intent using semantic similarity against decision/learning nodes.
   * Returns immediately when top score >= 0.50 (skips Haiku inference).
   * Falls back to { intent: 'ambiguous', confidence: 0 } when score < threshold.
   *
   * ISC row 7032: IntentClassifier calls this before calling Haiku.
   */
  async classifyIntent(query: string): Promise<IntentClassificationResult> {
    if (!this.indexAvailable || !this.db) {
      return { intent: 'ambiguous', confidence: 0, nodeIds: [] };
    }

    let queryVec: Float32Array;
    try {
      queryVec = await this.engine.embedText(query);
    } catch {
      return { intent: 'ambiguous', confidence: 0, nodeIds: [] };
    }

    // Search only decision and learning types. excludeExpired (Slice C1):
    // same candidate-hydration reasoning as semanticSearch() above.
    const graph = this.persistence.loadIntoEngine();
    const allNodes = this.persistence.loadAllNodes({ excludeExpired: true });
    const nodeMap = new Map<string, GraphNode>();
    for (const n of allNodes) nodeMap.set(n.id, n);

    // Score all decision + learning nodes
    const candidates: Array<{ nodeId: string; score: number; type: GraphNodeType }> = [];

    for (const type of ['decision', 'learning'] as GraphNodeType[]) {
      const typeCandidates = knnSearch(this.db, queryVec, 5, type, INTENT_FALLBACK_THRESHOLD);
      for (const c of typeCandidates) {
        candidates.push({ nodeId: c.nodeId, score: c.score, type });
      }
    }

    if (candidates.length === 0) {
      return { intent: 'ambiguous', confidence: 0, nodeIds: [] };
    }

    candidates.sort((a, b) => b.score - a.score);
    const top3 = candidates.slice(0, 3);
    const topScore = top3[0].score;

    if (topScore < INTENT_FALLBACK_THRESHOLD) {
      return { intent: 'ambiguous', confidence: topScore, nodeIds: top3.map(c => c.nodeId) };
    }

    // Classify by tag frequency in the neighborhood of the top node
    const intent = this._classifyByNeighborhood(top3[0].nodeId, graph);

    return {
      intent,
      confidence: topScore,
      nodeIds: top3.map(c => c.nodeId),
    };
  }

  /**
   * Classify intent by inspecting the neighborhood of the best-matching node.
   * Uses type distribution and tag frequency as the signal.
   */
  private _classifyByNeighborhood(nodeId: string, graph: GraphEngine): string {
    const node = graph.getNode(nodeId);
    if (!node) return 'development';

    // Use the node type as primary signal
    switch (node.type) {
      case 'decision': return 'development';
      case 'learning': return 'knowledge-lookup';
      case 'session': return 'development';
      case 'error': return 'development';
      case 'commit': return 'development';
      case 'outcome': return 'knowledge-lookup';
      case 'context': return 'knowledge-lookup';
      default: return 'development';
    }
  }
}

// ============================================
// SINGLETON
// ============================================

let _instance: EmbeddingQuerier | null = null;

export function getEmbeddingQuerier(): EmbeddingQuerier {
  if (!_instance) {
    _instance = new EmbeddingQuerier();
    _instance.init();
  }
  return _instance;
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const query = args[0];

  if (!query) {
    console.log('Usage: bun EmbeddingQuerier.ts "query" [--hybrid] [--intent]');
    process.exit(1);
  }

  const querier = new EmbeddingQuerier();
  querier.init();

  if (args.includes('--intent')) {
    const result = await querier.classifyIntent(query);
    console.log(JSON.stringify(result, null, 2));
  } else if (args.includes('--hybrid')) {
    const results = await querier.hybridSearch(query, { depth: 2, limit: 20 });
    for (const r of results) {
      const scoreStr = `[${r.score.toFixed(2)}]`;
      const depthStr = r.depth !== undefined ? ` depth=${r.depth}` : '';
      const viaStr = r.viaNodeId ? ` via:${r.viaNodeId}` : '';
      console.log(`${scoreStr} ${r.node.type}: ${r.node.title}`);
      console.log(`       id: ${r.node.id}`);
      console.log(`       tags: ${r.node.tags.join(', ')}`);
      console.log(`       [source: ${r.source}${depthStr}${viaStr}]`);
      console.log('');
    }
  } else {
    const results = await querier.semanticSearch(query, { limit: 10 });
    for (const r of results) {
      console.log(`[${r.score.toFixed(2)}] ${r.node.type}: ${r.node.title}`);
      console.log(`       id: ${r.node.id}`);
      console.log(`       tags: ${r.node.tags.join(', ')}`);
      console.log(`       [source: ${r.source}]`);
      console.log('');
    }
  }

  querier.close();
}
