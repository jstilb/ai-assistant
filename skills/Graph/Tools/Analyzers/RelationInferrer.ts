#!/usr/bin/env bun
/**
 * RelationInferrer - Infer implicit edges in the DevGraph
 *
 * Detects relationships that aren't explicitly recorded:
 * - Temporal co-occurrence (nodes within same time window)
 * - File overlap (sessions/commits touching same files)
 * - Error-to-fix (error followed by commit touching same file)
 * - Learning attribution (learnings created during session)
 *
 * All inferred edges have weight < 1.0 to indicate confidence.
 *
 * @module Graph/RelationInferrer
 * @version 1.0.0
 */

import type { GraphNode, GraphEdge, GraphEdgeType, IngestionResult } from '../types';
import { createEdge } from '../types';
import { GraphEngine } from '../GraphEngine';
import { GraphPersistence, getGraphPersistence } from '../GraphPersistence';

// ============================================
// CONFIGURATION
// ============================================

const TEMPORAL_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MIN_WEIGHT = 0.3;
const FILE_OVERLAP_WEIGHT = 0.6;
const TEMPORAL_WEIGHT = 0.5;
const ERROR_FIX_WEIGHT = 0.8;
const LEARNING_WEIGHT = 0.7;

// ============================================
// RELATION INFERRER
// ============================================

export class RelationInferrer {
  private persistence: GraphPersistence;

  constructor(persistence?: GraphPersistence) {
    this.persistence = persistence || getGraphPersistence();
  }

  /**
   * Infer implicit edges and persist them.
   */
  async infer(): Promise<IngestionResult> {
    const startTime = Date.now();
    const result: IngestionResult = {
      source: 'inference',
      nodesAdded: 0,
      edgesAdded: 0,
      nodesSkipped: 0,
      edgesSkipped: 0,
      errors: [],
      duration: 0,
    };

    try {
      // Load the full graph
      const engine = this.persistence.loadIntoEngine();
      const inferredEdges: GraphEdge[] = [];

      // Run all inference strategies
      inferredEdges.push(...this.inferTemporalCoOccurrence(engine));
      inferredEdges.push(...this.inferFileOverlap(engine));
      inferredEdges.push(...this.inferErrorToFix(engine));
      inferredEdges.push(...this.inferLearningAttribution(engine));

      // Persist new edges
      const edgesAppended = this.persistence.appendEdges(inferredEdges);

      result.edgesAdded = edgesAppended;
      result.edgesSkipped = inferredEdges.length - edgesAppended;
    } catch (err) {
      result.errors.push(`Inference failed: ${err}`);
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  // ============================================
  // TEMPORAL CO-OCCURRENCE
  // ============================================

  /**
   * Nodes created within the same 1-hour window get a relates_to edge.
   * Only connects different node types to avoid noise.
   */
  private inferTemporalCoOccurrence(engine: GraphEngine): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const nodes = engine.getNodes();
    const seen = new Set<string>();

    // Sort by creation time
    const sorted = nodes
      .filter(n => n.created_at)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    for (let i = 0; i < sorted.length; i++) {
      const nodeA = sorted[i];
      const timeA = new Date(nodeA.created_at).getTime();

      for (let j = i + 1; j < sorted.length; j++) {
        const nodeB = sorted[j];
        const timeB = new Date(nodeB.created_at).getTime();

        // Stop if outside temporal window
        if (timeB - timeA > TEMPORAL_WINDOW_MS) break;

        // Only link different types
        if (nodeA.type === nodeB.type) continue;

        // Avoid duplicates
        const key = [nodeA.id, nodeB.id].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);

        // Calculate weight based on temporal proximity
        const timeDiff = timeB - timeA;
        const proximity = 1 - (timeDiff / TEMPORAL_WINDOW_MS);
        const weight = MIN_WEIGHT + (TEMPORAL_WEIGHT - MIN_WEIGHT) * proximity;

        edges.push(createEdge(
          'relates_to',
          nodeA.id,
          nodeB.id,
          Math.round(weight * 100) / 100,
          { source: 'inference:temporal', timeDiffMs: timeDiff },
        ));
      }

      // Cap inferred edges per run to prevent explosion
      if (edges.length > 500) break;
    }

    return edges;
  }

  // ============================================
  // FILE OVERLAP
  // ============================================

  /**
   * Sessions/commits that touch the same files get a relates_to edge.
   */
  private inferFileOverlap(engine: GraphEngine): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();

    // Build file -> modifier map
    const fileModifiers = new Map<string, string[]>();

    for (const edge of engine.getEdges('modifies')) {
      const modifiers = fileModifiers.get(edge.target) || [];
      modifiers.push(edge.source);
      fileModifiers.set(edge.target, modifiers);
    }

    // Link modifiers of the same file
    for (const [fileId, modifiers] of fileModifiers) {
      if (modifiers.length < 2) continue;

      for (let i = 0; i < modifiers.length; i++) {
        for (let j = i + 1; j < modifiers.length; j++) {
          const key = [modifiers[i], modifiers[j]].sort().join('|');
          if (seen.has(key)) continue;
          seen.add(key);

          edges.push(createEdge(
            'relates_to',
            modifiers[i],
            modifiers[j],
            FILE_OVERLAP_WEIGHT,
            { source: 'inference:file-overlap', sharedFile: fileId },
          ));
        }
      }
    }

    return edges;
  }

  // ============================================
  // ERROR TO FIX
  // ============================================

  /**
   * If an error is followed by a commit touching the same file,
   * infer a fixed_by edge.
   */
  private inferErrorToFix(engine: GraphEngine): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();

    const errorNodes = engine.getNodes('error');
    const commitNodes = engine.getNodes('commit');

    if (errorNodes.length === 0 || commitNodes.length === 0) return edges;

    // Sort commits by time
    const sortedCommits = commitNodes
      .filter(c => c.created_at)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    for (const error of errorNodes) {
      const errorTime = new Date(error.created_at).getTime();

      // Find the error's associated files (via session -> modifies -> file)
      const errorFiles = new Set<string>();

      // Walk up from error to find session, then find files
      const backward = engine.traceBackward(error.id, 2, ['contains']);
      for (const { node } of backward) {
        if (node.type === 'session') {
          const sessionForward = engine.traceForward(node.id, 1, ['modifies']);
          for (const { node: fileNode } of sessionForward) {
            if (fileNode.type === 'file') {
              errorFiles.add(fileNode.id);
            }
          }
        }
      }

      // Find commits that came AFTER the error and touch the same files
      for (const commit of sortedCommits) {
        const commitTime = new Date(commit.created_at).getTime();
        if (commitTime <= errorTime) continue;
        if (commitTime - errorTime > 24 * 60 * 60 * 1000) break; // Within 24 hours

        // Check if commit touches any of the same files
        const commitFiles = engine.traceForward(commit.id, 1, ['modifies']);
        for (const { node: fileNode } of commitFiles) {
          if (errorFiles.has(fileNode.id)) {
            const key = `${error.id}|${commit.id}`;
            if (!seen.has(key)) {
              seen.add(key);
              edges.push(createEdge(
                'fixed_by',
                error.id,
                commit.id,
                ERROR_FIX_WEIGHT,
                { source: 'inference:error-fix', sharedFile: fileNode.id },
              ));
            }
          }
        }
      }
    }

    return edges;
  }

  // ============================================
  // LEARNING ATTRIBUTION
  // ============================================

  /**
   * Learnings created during a session get a learned_from edge.
   */
  private inferLearningAttribution(engine: GraphEngine): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();

    const sessionNodes = engine.getNodes('session');
    const learningNodes = engine.getNodes('learning');

    if (sessionNodes.length === 0 || learningNodes.length === 0) return edges;

    for (const session of sessionNodes) {
      const sessionTime = new Date(session.created_at).getTime();

      for (const learning of learningNodes) {
        const learningTime = new Date(learning.created_at).getTime();

        // Learning created within the session window (within 2 hours after session start)
        if (learningTime >= sessionTime && learningTime - sessionTime < 2 * 60 * 60 * 1000) {
          const key = `${session.id}|${learning.id}`;
          if (!seen.has(key)) {
            seen.add(key);
            edges.push(createEdge(
              'learned_from',
              learning.id,
              session.id,
              LEARNING_WEIGHT,
              { source: 'inference:learning-attribution' },
            ));
          }
        }
      }
    }

    return edges;
  }
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  console.log('RelationInferrer');
  console.log('================\n');

  const inferrer = new RelationInferrer();
  const result = await inferrer.infer();

  console.log(`Source: ${result.source}`);
  console.log(`Edges added: ${result.edgesAdded}`);
  console.log(`Edges skipped: ${result.edgesSkipped}`);
  console.log(`Duration: ${result.duration}ms`);

  if (result.errors.length > 0) {
    console.log(`\nErrors (${result.errors.length}):`);
    for (const err of result.errors) {
      console.log(`  - ${err}`);
    }
  }
}
