#!/usr/bin/env bun
/**
 * DecisionIngester - Extract decision nodes from Kaya data sources
 *
 * Adapted from ContextGraph's DecisionExtractor to use GraphPersistence
 * instead of event-sourced GraphManager. Extracts decisions from:
 * 1. ratings.jsonl
 * 2. MEMORY/WORK/ directories
 * 3. MEMORY/LEARNING/ALGORITHM/ learnings
 * 4. context-feedback.jsonl
 * 5. current-isc.json
 *
 * @module Graph/Ingesters/DecisionIngester
 * @version 1.0.0
 */

import { GraphPersistence } from '../GraphPersistence';
import type { GraphNode, GraphEdge, IngestionResult, Ingester } from '../types';
import { createNode, createEdge } from '../types';
import { join } from 'path';
import { homedir } from 'os';
import { readFileSync, existsSync, readdirSync } from 'fs';

const KAYA_HOME = join(homedir(), '.claude');
const MEMORY_DIR = join(KAYA_HOME, 'MEMORY');

export class DecisionIngester implements Ingester {
  constructor(
    private persistence: GraphPersistence,
    private stateDir: string = join(KAYA_HOME, 'skills', 'Graph', 'State'),
  ) {}

  async ingest(options?: { since?: string; sources?: string[] }): Promise<IngestionResult> {
    const startTime = Date.now();
    const result: IngestionResult = {
      source: 'decisions',
      nodesAdded: 0,
      edgesAdded: 0,
      nodesSkipped: 0,
      edgesSkipped: 0,
      errors: [],
      duration: 0,
    };

    try {
      const allNodes: GraphNode[] = [];
      const allEdges: GraphEdge[] = [];

      // Extract from all sources
      const ratingsNodes = this.extractFromRatings(options?.since);
      allNodes.push(...ratingsNodes);

      const { nodes: workNodes, edges: workEdges } = this.extractFromWorkItems(options?.since);
      allNodes.push(...workNodes);
      allEdges.push(...workEdges);

      const { nodes: learningNodes, edges: learningEdges } = this.extractFromLearnings(options?.since);
      allNodes.push(...learningNodes);
      allEdges.push(...learningEdges);

      const { nodes: contextNodes, edges: contextEdges } = this.extractFromContextFeedback(options?.since);
      allNodes.push(...contextNodes);
      allEdges.push(...contextEdges);

      const { nodes: iscNodes, edges: iscEdges } = this.extractFromISC();
      allNodes.push(...iscNodes);
      allEdges.push(...iscEdges);

      // Create cross-source edges
      const crossEdges = this.createCrossSourceEdges(allNodes);
      allEdges.push(...crossEdges);

      // Persist all nodes and edges
      const nodesAdded = this.persistence.appendNodes(allNodes);
      result.nodesAdded += nodesAdded;
      result.nodesSkipped += allNodes.length - nodesAdded;

      const edgesAdded = this.persistence.appendEdges(allEdges);
      result.edgesAdded += edgesAdded;
      result.edgesSkipped += allEdges.length - edgesAdded;

    } catch (err) {
      result.errors.push(`DecisionIngester error: ${err}`);
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  private extractFromRatings(since?: string): GraphNode[] {
    const ratingsFile = join(MEMORY_DIR, 'LEARNING', 'SIGNALS', 'ratings.jsonl');
    if (!existsSync(ratingsFile)) return [];

    const nodes: GraphNode[] = [];
    const content = readFileSync(ratingsFile, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const rating = JSON.parse(line);

        // Create outcome node for each rating
        const node = createNode(
          'outcome',
          `ratings-${this.hashContent(rating.timestamp + rating.rating)}`,
          `Rating ${rating.rating}/10: ${rating.sentiment_summary || 'Session feedback'}`,
          {
            content: rating.sentiment_summary || '',
            confidence: 0.85,
            recordedAt: rating.timestamp,
            rating: rating.rating,
            session_id: rating.session_id,
            source: rating.source || 'ratings',
          },
          [`rating-${rating.rating}`, 'outcome'],
        );

        nodes.push(node);
      } catch (err) {
        // Skip malformed lines
      }
    }

    return nodes;
  }

  private extractFromWorkItems(since?: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const workDir = join(MEMORY_DIR, 'WORK');
    if (!existsSync(workDir)) return { nodes: [], edges: [] };

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    let entries: string[];
    try {
      entries = readdirSync(workDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      return { nodes: [], edges: [] };
    }

    for (const dirName of entries) {
      try {
        const ts = this.parseTimestamp(dirName);
        if (!ts) continue;
        if (since && ts < since) continue;

        // Derive slug from dir name: strip timestamp prefix
        const slugMatch = dirName.match(/^\d{8}-\d{6}_(.+)$/);
        const slug = slugMatch ? slugMatch[1] : dirName;
        const title = slug.replace(/-/g, ' ').slice(0, 80);

        // Read first .md file in the directory for content
        const dirPath = join(workDir, dirName);
        let mdContent = '';
        try {
          const files = readdirSync(dirPath).filter(f => f.endsWith('.md'));
          if (files.length > 0) {
            mdContent = readFileSync(join(dirPath, files[0]), 'utf-8').slice(0, 500);
          }
        } catch {
          // Directory unreadable or no .md files — proceed with empty content
        }

        const node = createNode(
          'decision',
          `work:${dirName}`,
          title,
          {
            content: mdContent,
            confidence: 0.70,
            source: 'work-items',
          },
          ['decision', 'work-item'],
        );
        node.valid_from = ts;

        nodes.push(node);
      } catch {
        // Skip malformed directory entries
      }
    }

    return { nodes, edges };
  }

  private extractFromLearnings(since?: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const algoDir = join(MEMORY_DIR, 'LEARNING', 'ALGORITHM');
    if (!existsSync(algoDir)) return { nodes: [], edges: [] };

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    // Recursively collect all .md files
    const mdFiles = this.collectMdFiles(algoDir);

    for (const filePath of mdFiles) {
      try {
        const fileName = filePath.split('/').pop() ?? '';
        const fileBase = fileName.replace(/\.md$/, '');

        // Parse date from filename: 2026-02-27-123639_LEARNING_...
        const dateMatch = fileBase.match(/^(\d{4}-\d{2}-\d{2})-(\d{6})/);
        let ts: string | null = null;
        if (dateMatch) {
          const [, datePart, timePart] = dateMatch;
          const h = timePart.slice(0, 2);
          const m = timePart.slice(2, 4);
          const s = timePart.slice(4, 6);
          ts = `${datePart}T${h}:${m}:${s}.000Z`;
        }

        if (since && ts && ts < since) continue;

        // Derive title: strip date prefix and LEARNING_ marker
        const titleRaw = fileBase
          .replace(/^\d{4}-\d{2}-\d{2}-\d{6}_LEARNING_/, '')
          .replace(/[-_]/g, ' ')
          .slice(0, 80);

        // Adjust confidence for sentiment/rating files
        const isSentiment = fileBase.includes('sentiment-rating') || fileBase.includes('rating-5');
        const confidence = isSentiment ? 0.80 : 0.75;

        let fileContent = '';
        try {
          fileContent = readFileSync(filePath, 'utf-8').slice(0, 500);
        } catch {
          // Unreadable file — skip content
        }

        const node = createNode(
          'learning',
          `learning:${fileBase}`,
          titleRaw,
          {
            content: fileContent,
            confidence,
            source: 'algorithm-learnings',
          },
          ['learning', 'algorithm'],
        );
        if (ts) node.valid_from = ts;

        nodes.push(node);
      } catch {
        // Skip malformed files
      }
    }

    return { nodes, edges };
  }

  private extractFromContextFeedback(since?: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const feedbackFile = join(MEMORY_DIR, 'LEARNING', 'SIGNALS', 'context-feedback.jsonl');
    if (!existsSync(feedbackFile)) return { nodes: [], edges: [] };

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    const content = readFileSync(feedbackFile, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const timestamp = (entry.timestamp ?? entry.created_at ?? '') as string;

        if (since && timestamp && timestamp < since) continue;

        const contextType = (entry.context_type ?? entry.type ?? 'feedback') as string;
        const title = `Context: ${contextType}`.slice(0, 80);

        const hasHighRating = typeof entry.rating === 'number' && entry.rating >= 8;
        const confidence = hasHighRating ? 0.65 : 0.60;

        const node = createNode(
          'context',
          `context:feedback:${this.hashContent(timestamp + JSON.stringify(entry))}`,
          title,
          {
            content: JSON.stringify(entry).slice(0, 500),
            confidence,
            source: 'context-feedback',
            ...entry,
          },
          ['context', 'feedback'],
        );
        if (timestamp) node.valid_from = timestamp;

        nodes.push(node);
      } catch {
        // Skip malformed lines
      }
    }

    return { nodes, edges };
  }

  private extractFromISC(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const iscFile = join(MEMORY_DIR, 'WORK', 'current-isc.json');
    if (!existsSync(iscFile)) return { nodes: [], edges: [] };

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(iscFile, 'utf-8'));
    } catch {
      return { nodes: [], edges: [] };
    }

    let criteria: unknown[];
    if (Array.isArray(raw)) {
      criteria = raw;
    } else if (
      raw !== null &&
      typeof raw === 'object' &&
      'criteria' in (raw as Record<string, unknown>) &&
      Array.isArray((raw as Record<string, unknown>).criteria)
    ) {
      criteria = (raw as Record<string, unknown>).criteria as unknown[];
    } else {
      return { nodes: [], edges: [] };
    }

    for (const criterion of criteria) {
      try {
        const c = criterion as Record<string, unknown>;
        const keyForHash = (c.id ?? c.name ?? JSON.stringify(c)) as string;
        const nameStr = (c.name ?? c.description ?? 'Criterion') as string;
        const title = `ISC: ${nameStr}`.slice(0, 80);

        const node = createNode(
          'decision',
          `decision:isc:${this.hashContent(keyForHash)}`,
          title,
          {
            content: JSON.stringify(c).slice(0, 500),
            confidence: 0.80,
            source: 'isc',
          },
          ['decision', 'isc', 'criteria'],
        );

        nodes.push(node);
      } catch {
        // Skip malformed criteria
      }
    }

    return { nodes, edges };
  }

  /**
   * Create cross-source edges based on temporal and metadata relationships.
   */
  private createCrossSourceEdges(allNodes: GraphNode[]): GraphEdge[] {
    const edges: GraphEdge[] = [];

    const outcomeNodes = allNodes.filter(n => n.type === 'outcome');
    const decisionNodes = allNodes.filter(n => n.type === 'decision');
    const contextNodes = allNodes.filter(n => n.type === 'context');

    // 1. outcome_of: outcome -> decision created within 5 minutes
    for (const outcome of outcomeNodes) {
      const outcomeTs = new Date(outcome.valid_from).getTime();
      if (isNaN(outcomeTs)) continue;

      for (const decision of decisionNodes) {
        const decisionTs = new Date(decision.valid_from).getTime();
        if (isNaN(decisionTs)) continue;

        const diffMs = Math.abs(outcomeTs - decisionTs);
        if (diffMs <= 5 * 60 * 1000) {
          const edge = createEdge(
            'outcome_of',
            outcome.id,
            decision.id,
            0.8,
            { reason: 'temporal-proximity-5min' },
          );
          edges.push(edge);
        }
      }
    }

    // 2. context_for: context -> decision sharing session_id
    for (const ctx of contextNodes) {
      const ctxSession = ctx.metadata.session_id as string | undefined;
      if (!ctxSession) continue;

      for (const decision of decisionNodes) {
        const decSession = decision.metadata.session_id as string | undefined;
        if (decSession && decSession === ctxSession) {
          const edge = createEdge(
            'context_for',
            ctx.id,
            decision.id,
            0.6,
            { reason: 'shared-session-id', session_id: ctxSession },
          );
          edges.push(edge);
        }
      }
    }

    // 3. supersedes: high-rated outcome (>=8) -> low-rated outcome (<4) within 30 min
    const highRated = outcomeNodes.filter(n => typeof n.metadata.rating === 'number' && (n.metadata.rating as number) >= 8);
    const lowRated = outcomeNodes.filter(n => typeof n.metadata.rating === 'number' && (n.metadata.rating as number) < 4);

    for (const high of highRated) {
      const highTs = new Date(high.valid_from).getTime();
      if (isNaN(highTs)) continue;

      for (const low of lowRated) {
        const lowTs = new Date(low.valid_from).getTime();
        if (isNaN(lowTs)) continue;

        // High must come after low (within 30 min)
        const diffMs = highTs - lowTs;
        if (diffMs >= 0 && diffMs <= 30 * 60 * 1000) {
          const edge = createEdge(
            'supersedes',
            high.id,
            low.id,
            0.9,
            { reason: 'rating-recovery-within-30min' },
          );
          edges.push(edge);
        }
      }
    }

    return edges;
  }

  // ============================================
  // Helpers
  // ============================================

  private parseTimestamp(dirName: string): string | null {
    const match = dirName.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
    if (!match) return null;
    const [, year, month, day, hour, min, sec] = match;
    return `${year}-${month}-${day}T${hour}:${min}:${sec}.000Z`;
  }

  private collectMdFiles(dir: string): string[] {
    const results: string[] = [];
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...this.collectMdFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          results.push(fullPath);
        }
      }
    } catch {
      // Unreadable directory — return what we have
    }
    return results;
  }

  private hashContent(content: string): string {
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(content);
    return hasher.digest('hex').slice(0, 16);
  }
}

// CLI
if (import.meta.main) {
  const persistence = new GraphPersistence();
  const ingester = new DecisionIngester(persistence);

  console.log('Running DecisionIngester...');
  const result = await ingester.ingest();

  console.log('\nDecision Ingestion Result:');
  console.log(`  Nodes added: ${result.nodesAdded}`);
  console.log(`  Nodes skipped: ${result.nodesSkipped}`);
  console.log(`  Edges added: ${result.edgesAdded}`);
  console.log(`  Duration: ${result.duration}ms`);

  if (result.errors.length > 0) {
    console.log(`  Errors: ${result.errors.length}`);
    result.errors.forEach(e => console.log(`    - ${e}`));
  }
}
