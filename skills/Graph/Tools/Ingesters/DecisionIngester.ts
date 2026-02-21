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
import { readFileSync, existsSync } from 'fs';

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
      // Extract from ratings.jsonl
      const ratingsNodes = this.extractFromRatings(options?.since);
      const added = this.persistence.appendNodes(ratingsNodes);
      result.nodesAdded += added;
      result.nodesSkipped += (ratingsNodes.length - added);

      // TODO: Add other extractors (work_items, learnings, context_feedback, isc)
      // For Phase 3, we're focusing on getting the infrastructure working
      // Full extraction can be added in a follow-up

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
