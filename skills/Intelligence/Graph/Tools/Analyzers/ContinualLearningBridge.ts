#!/usr/bin/env bun
/**
 * ContinualLearningBridge - Export graph insights to ContinualLearning
 *
 * Detects patterns in the Graph and captures them as learnings
 * in the MemoryStore for ContinualLearning to consume.
 *
 * Patterns detected:
 * - Recurring error clusters
 * - Files that frequently cause errors
 * - Sessions with high error density
 * - Commit patterns (frequent fixers, hot files)
 * - Decision patterns (recurring themes across decisions)
 * - Goal alignment trends (drift detection)
 * - Course corrections (high supersedes rate)
 * - Context shifts (low-confidence context clusters)
 *
 * @module Graph/ContinualLearningBridge
 * @version 1.1.0
 */

import { join } from 'path';
import { homedir } from 'os';
import { parseArgs } from 'util';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { GraphEngine } from '../GraphEngine';
import { GraphPersistence, getGraphPersistence } from '../GraphPersistence';
import { createMemoryStore, type MemoryStore } from '../../../../../lib/core/MemoryStore';

// ============================================
// TYPES
// ============================================

interface PatternInsight {
  type: 'error_cluster' | 'error_prone_file' | 'high_error_session' | 'hot_file' | 'fix_pattern'
    | 'decision_pattern' | 'goal_alignment_trend' | 'course_correction' | 'context_shift'
    | 'trace_failure_pattern' | 'trace_efficiency_trend' | 'file_failure_correlation';
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
  async synthesize(options?: { since?: string }): Promise<{ patternsFound: number; captured: number; patternTypes: string[] }> {
    const engine = this.persistence.loadIntoEngine();

    // If --since provided, filter the engine to only nodes after that date
    const sinceDate = options?.since ? new Date(options.since) : undefined;
    if (sinceDate && isNaN(sinceDate.getTime())) {
      throw new Error(`Invalid --since date: ${options!.since}`);
    }

    const patterns: PatternInsight[] = [];

    // Run all detectors
    patterns.push(...this.detectErrorClusters(engine, sinceDate));
    patterns.push(...this.detectErrorProneFiles(engine));
    patterns.push(...this.detectHighErrorSessions(engine));
    patterns.push(...this.detectHotFiles(engine));
    patterns.push(...this.detectDecisionPatterns(engine, sinceDate));
    patterns.push(...this.detectGoalAlignmentTrends(engine));
    patterns.push(...this.detectCourseCorrections(engine));
    patterns.push(...this.detectContextShifts(engine, sinceDate));
    patterns.push(...this.detectFailedTracePatterns(engine));
    patterns.push(...this.detectFileCorrelatedFailures(engine));
    patterns.push(...this.detectTraceEfficiencyTrends(engine));

    // Capture patterns as learnings
    let captured = 0;
    for (const pattern of patterns) {
      try {
        await this.memoryStore.capture({
          type: 'insight',
          category: pattern.type,
          title: pattern.title,
          content: this.formatInsight(pattern),
          tags: ['graph', 'pattern', ...pattern.tags],
          tier: 'warm',
          source: 'Graph/ContinualLearningBridge',
          metadata: {
            patternType: pattern.type,
            severity: pattern.severity,
            evidenceCount: pattern.evidence.length,
          },
        });
        captured++;
      } catch (err) {
        console.error(`Failed to capture pattern: ${pattern.title}: ${err}`);
      }
    }

    return { patternsFound: patterns.length, captured, patternTypes: [...new Set(patterns.map(p => p.type))] };
  }

  // ============================================
  // PATTERN DETECTORS
  // ============================================

  /**
   * Detect recurring error messages that appear across multiple sessions.
   */
  private detectErrorClusters(engine: GraphEngine, since?: Date): PatternInsight[] {
    const patterns: PatternInsight[] = [];
    let errorNodes = engine.getNodes('error');
    if (since) errorNodes = errorNodes.filter(n => new Date(n.created_at) >= since);

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

  /**
   * Detect recurring decision themes by grouping decisions that share 3+ tags.
   */
  private detectDecisionPatterns(engine: GraphEngine, since?: Date): PatternInsight[] {
    const patterns: PatternInsight[] = [];
    let decisionNodes = engine.getNodes('decision');
    if (since) decisionNodes = decisionNodes.filter(n => new Date(n.created_at) >= since);

    if (decisionNodes.length < 3) return patterns;

    // Build a map from tag-set fingerprint → decisions sharing those tags
    const tagGroupMap = new Map<string, { sharedTags: string[]; titles: string[] }>();

    for (let i = 0; i < decisionNodes.length; i++) {
      for (let j = i + 1; j < decisionNodes.length; j++) {
        const tagsA = decisionNodes[i].tags ?? [];
        const tagsB = decisionNodes[j].tags ?? [];
        const shared = tagsA.filter(t => tagsB.includes(t));

        if (shared.length >= 3) {
          const key = [...shared].sort().join('|');
          const existing = tagGroupMap.get(key) ?? { sharedTags: shared, titles: [] };

          if (!existing.titles.includes(decisionNodes[i].title)) {
            existing.titles.push(decisionNodes[i].title);
          }
          if (!existing.titles.includes(decisionNodes[j].title)) {
            existing.titles.push(decisionNodes[j].title);
          }
          tagGroupMap.set(key, existing);
        }
      }
    }

    for (const [, { sharedTags, titles }] of tagGroupMap) {
      const count = titles.length;
      if (count >= 3) {
        patterns.push({
          type: 'decision_pattern',
          title: `Decision pattern: ${sharedTags.join(', ')}`,
          description: `${count} decisions share tags [${sharedTags.join(', ')}], indicating a recurring theme`,
          evidence: titles,
          severity: count >= 5 ? 'high' : 'medium',
          tags: ['decision-pattern', ...sharedTags],
        });
      }
    }

    return patterns;
  }

  /**
   * Detect goal alignment drift: recent decisions with no goal_aligned edges.
   */
  private detectGoalAlignmentTrends(engine: GraphEngine): PatternInsight[] {
    const patterns: PatternInsight[] = [];
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    const recentDecisions = engine.findNodes({ type: 'decision', since: fourteenDaysAgo });

    if (recentDecisions.length === 0) return patterns;

    const goalAlignedEdges = engine.getEdges('goal_aligned');
    const alignedDecisionIds = new Set<string>([
      ...goalAlignedEdges.map(e => e.source),
      ...goalAlignedEdges.map(e => e.target),
    ]);

    const unalignedDecisions = recentDecisions.filter(d => !alignedDecisionIds.has(d.id));

    if (unalignedDecisions.length > 0 && goalAlignedEdges.filter(
      e => recentDecisions.some(d => d.id === e.source || d.id === e.target)
    ).length === 0) {
      patterns.push({
        type: 'goal_alignment_trend',
        title: `Goal alignment drift: ${recentDecisions.length} decisions with 0 goal alignment`,
        description: `${recentDecisions.length} decisions made in the last 14 days have no goal_aligned edges, suggesting drift from stated goals.`,
        evidence: recentDecisions.slice(0, 10).map(d => d.title),
        severity: 'high',
        tags: ['goal-drift', 'alignment'],
      });
    }

    return patterns;
  }

  /**
   * Detect high course-correction rate: 3+ supersedes edges in the last 7 days.
   */
  private detectCourseCorrections(engine: GraphEngine): PatternInsight[] {
    const patterns: PatternInsight[] = [];
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const supersededEdges = engine.getEdges('supersedes');
    const recentSupersedes = supersededEdges.filter(e => {
      return new Date(e.created_at) >= sevenDaysAgo;
    });

    if (recentSupersedes.length >= 3) {
      patterns.push({
        type: 'course_correction',
        title: `High correction rate: ${recentSupersedes.length} course corrections this week`,
        description: `Frequent corrections may indicate unstable decision-making or rapid learning`,
        evidence: recentSupersedes.slice(0, 10).map(e => `${e.source} → supersedes → ${e.target}`),
        severity: recentSupersedes.length >= 5 ? 'high' : 'medium',
        tags: ['course-correction', 'decision-quality'],
      });
    }

    return patterns;
  }

  /**
   * Detect low-confidence context clusters indicating context shifts.
   */
  private detectContextShifts(engine: GraphEngine, since?: Date): PatternInsight[] {
    const patterns: PatternInsight[] = [];
    let contextNodes = engine.getNodes('context');
    if (since) contextNodes = contextNodes.filter(n => new Date(n.created_at) >= since);

    if (contextNodes.length === 0) return patterns;

    const lowConfidence = contextNodes.filter(n => {
      const confidence = n.metadata?.confidence as number | undefined;
      return typeof confidence === 'number' && confidence < 0.5;
    });

    if (lowConfidence.length >= 5) {
      patterns.push({
        type: 'context_shift',
        title: `Context shift detected: ${lowConfidence.length} low-confidence contexts`,
        description: `${lowConfidence.length} context nodes have confidence < 0.5, suggesting significant uncertainty or a shift in operating context.`,
        evidence: lowConfidence.slice(0, 10).map(n => `${n.title} (confidence: ${n.metadata?.confidence ?? 'unknown'})`),
        severity: 'medium',
        tags: ['context-shift', 'uncertainty'],
      });
    }

    return patterns;
  }

  /**
   * Detect recurring failure categories across agent traces.
   * Groups failed agent_traces (evaluationScore < 70) by failureCategory from audit metadata.
   * Surfaces categories with 3+ occurrences.
   */
  private detectFailedTracePatterns(engine: GraphEngine): PatternInsight[] {
    const patterns: PatternInsight[] = [];
    const traceNodes = engine.getNodes('agent_trace');

    // Filter to failed traces
    const failedTraces = traceNodes.filter(n => {
      const score = n.metadata.evaluationScore as number | undefined;
      return typeof score === 'number' && score < 70;
    });

    if (failedTraces.length < 3) return patterns;

    // Group by failure category (from tags)
    const categoryGroups = new Map<string, typeof failedTraces>();
    const failureCategories = ['tool_misuse', 'infinite_loop', 'error_cascade', 'wrong_approach', 'resource_waste', 'unknown'];

    for (const trace of failedTraces) {
      for (const tag of trace.tags) {
        if (failureCategories.includes(tag)) {
          const group = categoryGroups.get(tag) || [];
          group.push(trace);
          categoryGroups.set(tag, group);
        }
      }
    }

    for (const [category, traces] of categoryGroups) {
      if (traces.length >= 3) {
        patterns.push({
          type: 'trace_failure_pattern',
          title: `Recurring agent failure: ${category} (${traces.length} workflows)`,
          description: `${traces.length} agent workflows failed with category "${category}". This pattern indicates a systemic issue.`,
          evidence: traces.slice(0, 5).map(t => `${t.title}: score ${t.metadata.evaluationScore}/100`),
          severity: traces.length >= 5 ? 'high' : 'medium',
          tags: ['trace-failure', category, 'agent-observability'],
        });
      }
    }

    return patterns;
  }

  /**
   * Detect files that correlate with agent failures.
   * Files that appear in 3+ failed agent_trace backward traversals are "toxic files".
   */
  private detectFileCorrelatedFailures(engine: GraphEngine): PatternInsight[] {
    const patterns: PatternInsight[] = [];
    const traceNodes = engine.getNodes('agent_trace');

    const failedTraces = traceNodes.filter(n => {
      const score = n.metadata.evaluationScore as number | undefined;
      return typeof score === 'number' && score < 70;
    });

    if (failedTraces.length < 3) return patterns;

    // Count how many failed traces touch each file
    const fileFailCount = new Map<string, { title: string; count: number; traces: string[] }>();

    for (const trace of failedTraces) {
      const filesForward = engine.traceForward(trace.id, 1, ['modifies']);
      for (const { node: fileNode } of filesForward) {
        if (fileNode.type === 'file') {
          const entry = fileFailCount.get(fileNode.id) || { title: fileNode.title, count: 0, traces: [] };
          entry.count++;
          entry.traces.push(trace.title);
          fileFailCount.set(fileNode.id, entry);
        }
      }
    }

    for (const [, data] of fileFailCount) {
      if (data.count >= 3) {
        patterns.push({
          type: 'file_failure_correlation',
          title: `Failure-correlated file: ${data.title} (${data.count} failed workflows)`,
          description: `${data.title} was touched by ${data.count} failed agent workflows. Consider adding tests or simplifying.`,
          evidence: data.traces.slice(0, 5),
          severity: data.count >= 5 ? 'high' : 'medium',
          tags: ['file-failure-correlation', 'agent-observability'],
        });
      }
    }

    return patterns;
  }

  /**
   * Detect efficiency trends across agent traces.
   * Compares average tokens/latency from last 7 days vs previous 7 days.
   * Surfaces significant regressions (>20% increase).
   */
  private detectTraceEfficiencyTrends(engine: GraphEngine): PatternInsight[] {
    const patterns: PatternInsight[] = [];
    const traceNodes = engine.getNodes('agent_trace');

    if (traceNodes.length < 5) return patterns;

    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const recentCutoff = new Date(now - sevenDaysMs);
    const previousCutoff = new Date(now - 2 * sevenDaysMs);

    const recent = traceNodes.filter(n => new Date(n.created_at) >= recentCutoff);
    const previous = traceNodes.filter(n => {
      const d = new Date(n.created_at);
      return d >= previousCutoff && d < recentCutoff;
    });

    if (recent.length < 3 || previous.length < 3) return patterns;

    // Compare average tokens
    const avgTokensRecent = recent.reduce((s, n) => s + (n.metadata.totalTokens as number || 0), 0) / recent.length;
    const avgTokensPrevious = previous.reduce((s, n) => s + (n.metadata.totalTokens as number || 0), 0) / previous.length;

    if (avgTokensPrevious > 0) {
      const tokenChange = (avgTokensRecent - avgTokensPrevious) / avgTokensPrevious;
      if (tokenChange > 0.2) {
        patterns.push({
          type: 'trace_efficiency_trend',
          title: `Token usage regression: +${(tokenChange * 100).toFixed(0)}% week-over-week`,
          description: `Average tokens per workflow increased from ${Math.round(avgTokensPrevious)} to ${Math.round(avgTokensRecent)} (${(tokenChange * 100).toFixed(0)}% increase).`,
          evidence: [
            `This week: ${recent.length} workflows, avg ${Math.round(avgTokensRecent)} tokens`,
            `Last week: ${previous.length} workflows, avg ${Math.round(avgTokensPrevious)} tokens`,
          ],
          severity: tokenChange > 0.5 ? 'high' : 'medium',
          tags: ['efficiency-regression', 'tokens', 'agent-observability'],
        });
      }
    }

    // Compare average latency
    const avgLatencyRecent = recent.reduce((s, n) => s + (n.metadata.totalLatency as number || 0), 0) / recent.length;
    const avgLatencyPrevious = previous.reduce((s, n) => s + (n.metadata.totalLatency as number || 0), 0) / previous.length;

    if (avgLatencyPrevious > 0) {
      const latencyChange = (avgLatencyRecent - avgLatencyPrevious) / avgLatencyPrevious;
      if (latencyChange > 0.2) {
        patterns.push({
          type: 'trace_efficiency_trend',
          title: `Latency regression: +${(latencyChange * 100).toFixed(0)}% week-over-week`,
          description: `Average latency per workflow increased from ${Math.round(avgLatencyPrevious)}ms to ${Math.round(avgLatencyRecent)}ms.`,
          evidence: [
            `This week: ${recent.length} workflows, avg ${Math.round(avgLatencyRecent)}ms`,
            `Last week: ${previous.length} workflows, avg ${Math.round(avgLatencyPrevious)}ms`,
          ],
          severity: latencyChange > 0.5 ? 'high' : 'medium',
          tags: ['efficiency-regression', 'latency', 'agent-observability'],
        });
      }
    }

    return patterns;
  }

  // ============================================
  // FORMATTING
  // ============================================

  /**
   * Refresh context/LearningsContext.md with live graph data.
   * Writes hot files, course corrections, and decision themes for ContextManager.
   */
  refreshGraphContext(): string {
    const engine = this.persistence.loadIntoEngine();
    const contextDir = join(homedir(), '.claude', 'context');
    const contextFile = join(contextDir, 'LearningsContext.md');

    if (!existsSync(contextDir)) {
      mkdirSync(contextDir, { recursive: true });
    }

    const today = new Date().toISOString().split('T')[0];

    // 1. Find top 5 hot files (most modifies edges, last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const modifyEdges = engine.getEdges('modifies');
    const recentModifies = modifyEdges.filter(e => new Date(e.created_at) >= thirtyDaysAgo);
    const fileModCount = new Map<string, { title: string; count: number }>();

    for (const edge of recentModifies) {
      const fileNode = engine.getNode(edge.target);
      if (!fileNode || fileNode.type !== 'file') continue;
      const entry = fileModCount.get(edge.target) || { title: fileNode.title, count: 0 };
      entry.count++;
      fileModCount.set(edge.target, entry);
    }

    const hotFiles = [...fileModCount.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5);

    // 2. Count recent supersedes (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const supersededEdges = engine.getEdges('supersedes');
    const recentSupersedes = supersededEdges.filter(e => new Date(e.created_at) >= sevenDaysAgo);

    // 3. Get decision pattern themes
    const decisionPatterns = this.detectDecisionPatterns(engine);
    const topThemes = decisionPatterns.slice(0, 3);

    // 4. Format compact markdown
    let md = `### Graph Insights (as of ${today})\n\n`;

    if (hotFiles.length > 0) {
      md += '**Hot Files (last 30d):**\n';
      for (const [, data] of hotFiles) {
        md += `- ${data.title} — ${data.count} modifications\n`;
      }
      md += '\n';
    }

    if (recentSupersedes.length > 0) {
      md += `**Course Corrections (last 7d):**\n`;
      md += `- ${recentSupersedes.length} decisions superseded`;
      if (recentSupersedes.length >= 5) md += ' — monitor for instability';
      md += '\n\n';
    }

    if (topThemes.length > 0) {
      md += '**Decision Themes:**\n';
      for (const theme of topThemes) {
        const tagList = theme.tags.filter(t => t !== 'decision-pattern').slice(0, 4).join(', ');
        md += `- [${tagList}] — ${theme.evidence.length} related decisions\n`;
      }
      md += '\n';
    }

    md += `_Graph: ${engine.nodeCount.toLocaleString()} nodes, ${engine.edgeCount.toLocaleString()} edges | Last refresh: ${today}_\n`;

    writeFileSync(contextFile, md, 'utf-8');
    return contextFile;
  }

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
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      synthesize: { type: 'boolean' },
      context: { type: 'boolean' },
      json: { type: 'boolean' },
      since: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(`
ContinualLearningBridge - Export Graph insights to ContinualLearning

Usage:
  bun ContinualLearningBridge.ts --synthesize          Run pattern detection and export
  bun ContinualLearningBridge.ts --synthesize --json   Output results as JSON
  bun ContinualLearningBridge.ts --synthesize --since <date>  Filter since date (ISO 8601)
  bun ContinualLearningBridge.ts --context             Refresh context/LearningsContext.md with graph insights
  bun ContinualLearningBridge.ts --help                Show help
`);
    process.exit(0);
  }

  if (values.synthesize) {
    const bridge = new ContinualLearningBridge();
    const result = await bridge.synthesize(values.since ? { since: values.since } : undefined);

    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('ContinualLearningBridge');
      console.log('======================\n');
      console.log(`Patterns found: ${result.patternsFound}`);
      console.log(`Patterns captured to MemoryStore: ${result.captured}`);
      if (result.patternTypes.length > 0) {
        console.log(`Pattern types: ${result.patternTypes.join(', ')}`);
      }
    }
  } else if (values.context) {
    const bridge = new ContinualLearningBridge();
    const filePath = bridge.refreshGraphContext();
    console.log(`Graph context written to: ${filePath}`);
  } else {
    console.log('Use --synthesize to run pattern detection');
    console.log('Use --context to refresh graph context file');
    console.log('Use --help for more info');
  }
}
