#!/usr/bin/env bun
/**
 * GraphInsightsBlock - Graph statistics for daily briefing
 *
 * Shows node/edge counts, staleness warning, and top node types.
 *
 * @module DailyBriefing/GraphInsightsBlock
 * @version 1.0.0
 */

import type { BlockResult } from './types.ts';
import { GraphPersistence, getGraphPersistence } from '../../../Intelligence/Graph/Tools/GraphPersistence';
import { ALL_NODE_TYPES } from '../../../Intelligence/Graph/Tools/types';

export async function execute(config: Record<string, unknown>): Promise<BlockResult> {
  try {
    const persistence = getGraphPersistence();
    const engine = persistence.loadIntoEngine();
    const stats = engine.getStats();
    const meta = await persistence.loadMeta();

    // Staleness check
    const lastIngested = meta.lastIngested ? new Date(meta.lastIngested) : null;
    const staleThresholdMs = 48 * 60 * 60 * 1000; // 48 hours
    const isStale = !lastIngested || (Date.now() - lastIngested.getTime() > staleThresholdMs);
    const staleDays = lastIngested
      ? Math.round((Date.now() - lastIngested.getTime()) / (24 * 60 * 60 * 1000))
      : null;

    // Top node types (sorted by count, non-zero)
    const topTypes = Object.entries(stats.nodesByType)
      .filter(([_, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    // Top edge types
    const topEdges = Object.entries(stats.edgesByType)
      .filter(([_, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    // Build markdown
    let md = '## Graph Insights\n\n';
    md += `| Metric | Value |\n|--------|-------|\n`;
    md += `| Total Nodes | ${stats.nodeCount.toLocaleString()} |\n`;
    md += `| Total Edges | ${stats.edgeCount.toLocaleString()} |\n`;
    md += `| Last Ingested | ${lastIngested ? lastIngested.toLocaleDateString() : 'Never'} |\n`;

    if (isStale) {
      md += `\n> **Warning:** Graph data is ${staleDays !== null ? `${staleDays} days` : ''} stale. Run \`bun GraphQuerier.ts ingest --all\`.\n`;
    }

    md += '\n**Top Node Types:**\n';
    for (const [type, count] of topTypes) {
      md += `- ${type}: ${count.toLocaleString()}\n`;
    }

    const summary = `Graph: ${stats.nodeCount.toLocaleString()} nodes, ${stats.edgeCount.toLocaleString()} edges${isStale ? ' (stale)' : ''}`;

    return {
      blockName: 'graphInsights',
      success: true,
      data: {
        nodeCount: stats.nodeCount,
        edgeCount: stats.edgeCount,
        lastIngested: meta.lastIngested,
        isStale,
        staleDays,
        topTypes: topTypes.map(([type, count]) => ({ type, count })),
        topEdges: topEdges.map(([type, count]) => ({ type, count })),
      },
      markdown: md,
      summary,
    };
  } catch (error) {
    return {
      blockName: 'graphInsights',
      success: false,
      data: {},
      markdown: '## Graph Insights\n\nGraph data unavailable.\n',
      summary: 'Graph unavailable',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
