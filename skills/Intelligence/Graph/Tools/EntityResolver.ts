#!/usr/bin/env bun
/**
 * EntityResolver.ts - Semantic deduplication at ingestion time
 *
 * Before a new node is written to JSONL, this module:
 *   1. Computes embedding of candidate (title + tags)
 *   2. Queries the index for the nearest neighbor
 *   3. If cosine > 0.92 AND same type: returns existing node ID (skip write)
 *   4. If cosine > 0.80 AND cross-type: allows write, creates `relates_to` edge
 *
 * ISC row 5484: cosine > 0.92 same type returns existing node ID.
 * ISC row 5460: relates_to edges have metadata.source='entity-resolution', weight=score.
 *
 * If Path A (Graph Dedup) has not landed, this silently skips to ID-based dedup
 * (the embedding index may simply be empty or unavailable).
 *
 * @module Graph/EntityResolver
 * @version 1.0.0
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import type { GraphNode, GraphEdge } from './types';
import { createEdge } from './types';
import { EmbeddingEngine, knnSearch, buildNodeText, sha256 } from './EmbeddingEngine';
import { getSharedGraphDir } from '../../../../lib/core/KayaHome';

// ============================================
// CONSTANTS
// ============================================

const GRAPH_DIR = getSharedGraphDir();
const EMBEDDINGS_DIR = join(GRAPH_DIR, 'embeddings');
const INDEX_DB_PATH = join(EMBEDDINGS_DIR, 'index.db');

/** Threshold for same-type dedup: above this, skip write */
const SAME_TYPE_THRESHOLD = 0.92;

/** Threshold for cross-type relation: above this, create relates_to edge */
const CROSS_TYPE_THRESHOLD = 0.80;

// ============================================
// RESULT TYPES
// ============================================

export interface ResolveResult {
  /** The ID to use for this node (existing if deduplicated, candidate's own ID otherwise) */
  resolvedId: string;
  /** Whether the candidate was considered a duplicate of an existing node */
  isDuplicate: boolean;
  /** Cosine similarity score to the best match (0 if no match found) */
  matchScore: number;
  /** Optional edge to create (cross-type relation, or null) */
  relatesEdge: GraphEdge | null;
}

// ============================================
// ENTITY RESOLVER
// ============================================

export class EntityResolver {
  private engine: EmbeddingEngine;
  private db: Database | null = null;
  private available: boolean = false;
  private _dbPath: string;

  constructor(graphDir?: string) {
    const dir = graphDir ?? GRAPH_DIR;
    const embDir = join(dir, 'embeddings');
    this._dbPath = join(embDir, 'index.db');
    this.engine = new EmbeddingEngine(this._dbPath, dir);
  }

  /**
   * Initialize — open index.db if available.
   * Returns false (degraded mode) when index doesn't exist yet.
   */
  init(): boolean {
    if (!existsSync(this._dbPath)) {
      this.available = false;
      return false;
    }
    try {
      this.db = new Database(this._dbPath);
      this.available = true;
      return true;
    } catch {
      this.available = false;
      return false;
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  /**
   * Resolve a candidate node against the embedding index.
   *
   * Returns:
   * - { isDuplicate: true, resolvedId: existingId } — skip write, use existing ID
   * - { isDuplicate: false, relatesEdge: GraphEdge } — write node, also write edge
   * - { isDuplicate: false, relatesEdge: null } — write node normally
   */
  async resolve(candidate: GraphNode): Promise<ResolveResult> {
    const noMatch: ResolveResult = {
      resolvedId: candidate.id,
      isDuplicate: false,
      matchScore: 0,
      relatesEdge: null,
    };

    if (!this.available || !this.db) {
      // Graceful degradation — no embedding index available
      return noMatch;
    }

    let queryVec: Float32Array;
    try {
      queryVec = await this.engine.embedNode(candidate);
    } catch {
      return noMatch;
    }

    // Search across all types for closest match
    const candidates = knnSearch(this.db, queryVec, 5, undefined, CROSS_TYPE_THRESHOLD);

    if (candidates.length === 0) return noMatch;

    // Filter out the candidate's own ID
    const matches = candidates.filter(c => c.nodeId !== candidate.id);
    if (matches.length === 0) return noMatch;

    const best = matches[0];

    // Same-type dedup: cosine > 0.92
    if (best.nodeType === candidate.type && best.score > SAME_TYPE_THRESHOLD) {
      return {
        resolvedId: best.nodeId,
        isDuplicate: true,
        matchScore: best.score,
        relatesEdge: null,
      };
    }

    // Cross-type relation: cosine > 0.80
    if (best.score > CROSS_TYPE_THRESHOLD) {
      const edge = createEdge(
        'relates_to',
        candidate.id,
        best.nodeId,
        best.score, // weight = cosine score
        {
          source: 'entity-resolution',
          score: best.score,
        },
      );
      return {
        resolvedId: candidate.id,
        isDuplicate: false,
        matchScore: best.score,
        relatesEdge: edge,
      };
    }

    return noMatch;
  }

  /**
   * After a node is successfully written to JSONL, upsert its embedding
   * into the index so future candidates can match against it.
   */
  async indexNode(node: GraphNode): Promise<void> {
    if (!this.available) return;

    // Open engine's DB if not already open
    const engineOpened = this.engine.openDb();
    if (!engineOpened) return;

    try {
      const vec = await this.engine.embedNode(node);
      const text = buildNodeText(node);
      const hash = sha256(text);
      this.engine.upsertEmbedding(node.id, node.type, vec, hash);
    } catch {
      // Non-fatal — index will catch up on next incremental run
    }
  }
}

// ============================================
// SINGLETON
// ============================================

let _instance: EntityResolver | null = null;

export function getEntityResolver(): EntityResolver {
  if (!_instance) {
    _instance = new EntityResolver();
    _instance.init();
  }
  return _instance;
}

// ============================================
// CLI (for testing)
// ============================================

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const title = args[0] ?? 'Fix null pointer in session handler';
  const type = (args[1] ?? 'error') as GraphNode['type'];

  const resolver = new EntityResolver();
  const available = resolver.init();
  if (!available) {
    console.log('[EntityResolver] Index not available — run embed --build-all first');
    process.exit(0);
  }

  const candidateNode: GraphNode = {
    id: `${type}:test-${Date.now()}`,
    type,
    title,
    created_at: new Date().toISOString(),
    valid_from: new Date().toISOString(),
    tags: ['test'],
    metadata: {},
  };

  console.log(`Resolving: "${title}" (type: ${type})`);
  const result = await resolver.resolve(candidateNode);
  console.log(`Duplicate: ${result.isDuplicate}`);
  console.log(`Resolved ID: ${result.resolvedId}`);
  console.log(`Match score: ${result.matchScore.toFixed(4)}`);
  if (result.relatesEdge) {
    console.log(`Relates edge: ${result.relatesEdge.source} -> ${result.relatesEdge.target} (weight: ${result.relatesEdge.weight})`);
    console.log(`Edge metadata:`, result.relatesEdge.metadata);
  }

  resolver.close();
}
