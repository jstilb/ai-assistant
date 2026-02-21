#!/usr/bin/env bun
/**
 * ContinualLearningBridge - Export graph insights to ContinualLearning
 *
 * Detects patterns in the DevGraph and captures them as learnings
 * in the MemoryStore for ContinualLearning to consume.
 *
 * Patterns detected:
 * - Recurring error clusters
 * - Files that frequently cause errors
 * - Sessions with high error density
 * - Commit patterns (frequent fixers, hot files)
 *
 * @module DevGraph/ContinualLearningBridge
 * @version 1.0.0
 */

import { join } from 'path';
import { homedir } from 'os';
import { GraphEngine } from './GraphEngine';
import { GraphPersistence, getGraphPersistence } from './GraphPersistence';
import { createMemoryStore, type MemoryStore } from '../../CORE/Tools/MemoryStore';
import { emitEvalSignal, emitNotification } from '../../CORE/Tools/SkillIntegrationBridge';

// ============================================
// TYPES
// ============================================

interface PatternInsight {
  type: 'error_cluster' | 'error_prone_file' | 'high_error_session' | 'hot_file' | 'fix_pattern';
  title: string;
  description: string;
  evidence: string[];
  severity: 'low' | 'medium' | 'high';
  tags: string[];
}

// ============================================
// CONTINUAL LEARNING BRIDGE
// ============================================

export class ContinualLearningBridge {
  private persistence: GraphPersistence;
  private memoryStore: MemoryStore;

  constructor(persistence?: GraphPersistence, memoryStore?: MemoryStore) {
    this.persistence = persistence || getGraphPersistence();
    this.memoryStore = memoryStore || createMemoryStore();
  }

  /**
   * Run all pattern detection and export insights to ContinualLearning.
   */
  async synthesize(): Promise<{ patternsFound: number; captured: number }> {
    const engine = this.persistence.loadIntoEngine();
    const patterns: PatternInsight[] = [];

    // Run all detectors
    patterns.push(...this.detectErrorClusters(engine));
    patterns.push(...this.detectErrorProneFiles(engine));
    patterns.push(...this.detectHighErrorSessions(engine));
    patterns.push(...this.detectHotFiles(engine));

    // Capture patterns as learnings
    let captured = 0;
    for (const pattern of patterns) {
      try {
        await this.memoryStore.capture({
          type: 'insight',
          category: pattern.type,
          title: pattern.title,
          content: this.formatInsight(pattern),
          tags: ['devgraph', 'pattern', ...pattern.tags],
          tier: 'warm',
          source: 'DevGraph/ContinualLearningBridge',
          metadata: {
            patternType: pattern.type,
            severity: pattern.severity,
            evidenceCount: pattern.evidence.length,
          },
        });
        captured++;

        // Phase 4: Integration Backbone - Emit eval signals for high-severity patterns
        if (pattern.severity === 'high') {
          await emitEvalSignal({
            source: 'DevGraph',
            signalType: 'regression',
            description: pattern.description,
            category: pattern.type,
            severity: 'high',
            rawData: {
              evidence: pattern.evidence,
              title: pattern.title,
            },
          }).catch(err => console.error(`[DevGraph] Failed to emit eval signal: ${err}`));

          // Emit notification for high-severity patterns
          emitNotification(
            `DevGraph: ${pattern.title}`,
            { priority: 'high', agentName: 'DevGraph' }
          );
        }
      } catch (err) {
        console.error(`Failed to capture pattern: ${pattern.title}: ${err}`);
      }
    }

    return { patternsFound: patterns.length, captured };
  }

  // ============================================
  // PATTERN DETECTORS
  // ============================================

  /**
   * Detect recurring error messages that appear across multiple sessions.
   */
  private detectErrorClusters(engine: GraphEngine): PatternInsight[] {
    const patterns: PatternInsight[] = [];
    const errorNodes = engine.getNodes('error');

    if (errorNodes.length < 3) return patterns;

    // Group errors by title similarity
    const clusters = new Map<string, typeof errorNodes>();

    for (const error of errorNodes) {
      // Normalize: lowercase, strip numbers and specific paths
      const normalized = error.title
        .toLowerCase()
        .replace(/\d+/g, 'N')
        .replace(/\/[\w\-\.\/]+/g, '<path>')
        .slice(0, 60);

      const existing = clusters.get(normalized) || [];
      existing.push(error);
      clusters.set(normalized, existing);
    }

    for (const [pattern, errors] of clusters) {
      if (errors.length >= 3) {
        patterns.push({
          type: 'error_cluster',
          title: `Recurring error: ${errors[0].title.slice(0, 80)}`,
          description: `This error pattern has appeared ${errors.length} times across different sessions.`,
          evidence: errors.map(e => `${e.id}: ${e.title}`),
          severity: errors.length >= 5 ? 'high' : 'medium',
          tags: ['recurring-error'],
        });
      }
    }

    return patterns;
  }

  /**
   * Detect files that frequently appear alongside errors.
   */
  private detectErrorProneFiles(engine: GraphEngine): PatternInsight[] {
    const patterns: PatternInsight[] = [];
    const fileErrorCount = new Map<string, { fileTitle: string; errorCount: number; errors: string[] }>();

    const errorNodes = engine.getNodes('error');

    for (const error of errorNodes) {
      // Trace backward to find associated files
      const backward = engine.traceBackward(error.id, 2);
      for (const { node } of backward) {
        if (node.type === 'session') {
          const forward = engine.traceForward(node.id, 1, ['modifies']);
          for (const { node: fileNode } of forward) {
            if (fileNode.type === 'file') {
              const entry = fileErrorCount.get(fileNode.id) || { fileTitle: fileNode.title, errorCount: 0, errors: [] };
              entry.errorCount++;
              entry.errors.push(error.title.slice(0, 60));
              fileErrorCount.set(fileNode.id, entry);
            }
          }
        }
      }
    }

    for (const [fileId, data] of fileErrorCount) {
      if (data.errorCount >= 3) {
        patterns.push({
          type: 'error_prone_file',
          title: `Error-prone file: ${data.fileTitle}`,
          description: `${data.fileTitle} has been associated with ${data.errorCount} errors. Consider adding tests or refactoring.`,
          evidence: data.errors.slice(0, 5),
          severity: data.errorCount >= 5 ? 'high' : 'medium',
          tags: ['error-prone', 'file-quality'],
        });
      }
    }

    return patterns;
  }

  /**
   * Detect sessions with high error density.
   */
  private detectHighErrorSessions(engine: GraphEngine): PatternInsight[] {
    const patterns: PatternInsight[] = [];
    const sessionNodes = engine.getNodes('session');

    for (const session of sessionNodes) {
      const forward = engine.traceForward(session.id, 1, ['contains']);
      const errors = forward.filter(r => r.node.type === 'error');

      if (errors.length >= 5) {
        patterns.push({
          type: 'high_error_session',
          title: `High-error session: ${session.title.slice(0, 60)}`,
          description: `Session had ${errors.length} errors. May indicate a problematic area.`,
          evidence: errors.map(e => e.node.title.slice(0, 60)),
          severity: errors.length >= 10 ? 'high' : 'medium',
          tags: ['session-quality', 'high-error'],
        });
      }
    }

    return patterns;
  }

  /**
   * Detect files that are frequently modified (hot files).
   */
  private detectHotFiles(engine: GraphEngine): PatternInsight[] {
    const patterns: PatternInsight[] = [];
    const fileModCount = new Map<string, { title: string; count: number; modifiers: string[] }>();

    const modifyEdges = engine.getEdges('modifies');

    for (const edge of modifyEdges) {
      const fileNode = engine.getNode(edge.target);
      if (!fileNode || fileNode.type !== 'file') continue;

      const entry = fileModCount.get(edge.target) || { title: fileNode.title, count: 0, modifiers: [] };
      entry.count++;
      entry.modifiers.push(edge.source);
      fileModCount.set(edge.target, entry);
    }

    for (const [fileId, data] of fileModCount) {
      if (data.count >= 5) {
        patterns.push({
          type: 'hot_file',
          title: `Hot file: ${data.title}`,
          description: `${data.title} has been modified ${data.count} times. High churn may indicate instability.`,
          evidence: [`Modified by ${data.modifiers.length} different sources`],
          severity: data.count >= 10 ? 'medium' : 'low',
          tags: ['hot-file', 'churn'],
        });
      }
    }

    return patterns;
  }

  // ============================================
  // FORMATTING
  // ============================================

  /**
   * Format a pattern insight into a human-readable string.
   */
  private formatInsight(pattern: PatternInsight): string {
    let content = `## ${pattern.title}\n\n`;
    content += `**Type:** ${pattern.type}\n`;
    content += `**Severity:** ${pattern.severity}\n\n`;
    content += `${pattern.description}\n\n`;
    content += `### Evidence\n`;
    for (const e of pattern.evidence.slice(0, 10)) {
      content += `- ${e}\n`;
    }
    if (pattern.evidence.length > 10) {
      content += `- ... and ${pattern.evidence.length - 10} more\n`;
    }
    return content;
  }
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
ContinualLearningBridge - Export DevGraph insights to ContinualLearning

Usage:
  bun ContinualLearningBridge.ts --synthesize   Run pattern detection and export
  bun ContinualLearningBridge.ts --help          Show help
`);
    process.exit(0);
  }

  if (args.includes('--synthesize')) {
    console.log('ContinualLearningBridge');
    console.log('======================\n');

    const bridge = new ContinualLearningBridge();
    const result = await bridge.synthesize();

    console.log(`Patterns found: ${result.patternsFound}`);
    console.log(`Patterns captured to MemoryStore: ${result.captured}`);
  } else {
    console.log('Use --synthesize to run pattern detection');
    console.log('Use --help for more info');
  }
}
