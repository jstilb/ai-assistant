#!/usr/bin/env bun
/**
 * TraceIngester - Consume AgentMonitor traces into the graph
 *
 * Reads from MEMORY/MONITORING/traces/*.jsonl and creates
 * agent_trace nodes linked to sessions and errors.
 *
 * @module DevGraph/TraceIngester
 * @version 1.0.0
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import type { DevNode, DevEdge, IngestionResult } from './types';
import { createNode, createEdge } from './types';
import { GraphPersistence, getGraphPersistence } from './GraphPersistence';

// ============================================
// CONSTANTS
// ============================================

const KAYA_HOME = join(homedir(), '.claude');
const TRACES_DIR = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'traces');

// ============================================
// TRACE EVENT (compatible with AgentMonitor's AgentTrace)
// ============================================

interface TraceEvent {
  workflowId: string;
  agentId: string;
  timestamp: number;
  eventType: string;
  metadata: {
    tokensUsed?: number;
    latencyMs?: number;
    toolName?: string;
    errorMessage?: string;
    iscCompletionRate?: number;
    [key: string]: unknown;
  };
  context: Record<string, unknown>;
}

// ============================================
// TRACE INGESTER
// ============================================

export class TraceIngester {
  private persistence: GraphPersistence;
  private tracesDir: string;

  constructor(persistence?: GraphPersistence, tracesDir?: string) {
    this.persistence = persistence || getGraphPersistence();
    this.tracesDir = tracesDir || TRACES_DIR;
  }

  /**
   * Ingest all traces from MEMORY/MONITORING/traces/ into the graph.
   */
  async ingest(): Promise<IngestionResult> {
    const startTime = Date.now();
    const result: IngestionResult = {
      source: 'traces',
      nodesAdded: 0,
      edgesAdded: 0,
      nodesSkipped: 0,
      edgesSkipped: 0,
      errors: [],
      duration: 0,
    };

    if (!existsSync(this.tracesDir)) {
      result.errors.push(`Traces directory not found: ${this.tracesDir}`);
      result.duration = Date.now() - startTime;
      return result;
    }

    const traceFiles = readdirSync(this.tracesDir)
      .filter(f => f.endsWith('.jsonl'));

    if (traceFiles.length === 0) {
      result.errors.push('No trace files found');
      result.duration = Date.now() - startTime;
      return result;
    }

    const allNodes: DevNode[] = [];
    const allEdges: DevEdge[] = [];

    for (const file of traceFiles) {
      try {
        const { nodes, edges } = this.parseTraceFile(file);
        allNodes.push(...nodes);
        allEdges.push(...edges);
      } catch (err) {
        result.errors.push(`Error parsing ${file}: ${err}`);
      }
    }

    // Persist
    const nodesAppended = this.persistence.appendNodes(allNodes);
    const edgesAppended = this.persistence.appendEdges(allEdges);

    result.nodesAdded = nodesAppended;
    result.nodesSkipped = allNodes.length - nodesAppended;
    result.edgesAdded = edgesAppended;
    result.edgesSkipped = allEdges.length - edgesAppended;
    result.duration = Date.now() - startTime;

    return result;
  }

  /**
   * Parse a single trace file into nodes and edges.
   */
  private parseTraceFile(fileName: string): { nodes: DevNode[]; edges: DevEdge[] } {
    const nodes: DevNode[] = [];
    const edges: DevEdge[] = [];
    const filePath = join(this.tracesDir, fileName);

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    // Group events by workflowId
    const workflows = new Map<string, TraceEvent[]>();

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as TraceEvent;
        if (!event.workflowId) continue;

        const existing = workflows.get(event.workflowId) || [];
        existing.push(event);
        workflows.set(event.workflowId, existing);
      } catch {
        // Skip malformed lines
      }
    }

    // Create nodes and edges per workflow
    for (const [workflowId, events] of workflows) {
      const firstEvent = events[0];
      const lastEvent = events[events.length - 1];

      // Create agent_trace node
      const traceId = `agent_trace:${workflowId}`;
      const startTs = new Date(firstEvent.timestamp).toISOString();
      const endTs = new Date(lastEvent.timestamp).toISOString();

      const hasError = events.some(e => e.eventType === 'error');
      const totalTokens = events.reduce((sum, e) => sum + (e.metadata.tokensUsed || 0), 0);
      const totalLatency = events.reduce((sum, e) => sum + (e.metadata.latencyMs || 0), 0);
      const toolCalls = events.filter(e => e.eventType === 'tool_call').length;

      const traceNode = createNode(
        'agent_trace',
        traceId,
        `Workflow ${workflowId.slice(0, 8)}`,
        {
          workflowId,
          agentId: firstEvent.agentId,
          eventCount: events.length,
          hasError,
          totalTokens,
          totalLatency,
          toolCalls,
          startTime: startTs,
          endTime: endTs,
        },
        hasError ? ['agent_trace', 'error'] : ['agent_trace'],
      );
      traceNode.valid_from = startTs;
      traceNode.created_at = startTs;

      nodes.push(traceNode);

      // Extract error nodes from error events
      for (const event of events) {
        if (event.eventType === 'error' && event.metadata.errorMessage) {
          const errorId = `error:trace:${workflowId}:${event.timestamp}`;
          const errorNode = createNode(
            'error',
            errorId,
            event.metadata.errorMessage.slice(0, 120),
            {
              fullMessage: event.metadata.errorMessage,
              workflowId,
              agentId: event.agentId,
              timestamp: event.timestamp,
            },
            ['error', 'agent_trace'],
          );
          const errorTs = new Date(event.timestamp).toISOString();
          errorNode.valid_from = errorTs;
          errorNode.created_at = errorTs;

          nodes.push(errorNode);

          // agent_trace -> contains -> error
          edges.push(createEdge('contains', traceId, errorId, 1.0, { source: 'trace-ingester' }));
        }
      }

      // Try to link trace to a session via file name or context
      // The trace file name itself might be the workflow ID
      const sessionRef = this.findSessionReference(events);
      if (sessionRef) {
        edges.push(createEdge('spawned', sessionRef, traceId, 0.9, { source: 'trace-ingester' }));
      }
    }

    return { nodes, edges };
  }

  /**
   * Try to find a session reference from trace events.
   * Looks for session IDs in event context.
   */
  private findSessionReference(events: TraceEvent[]): string | null {
    for (const event of events) {
      if (event.context) {
        const sessionId = event.context.sessionId as string | undefined;
        if (sessionId) {
          return `session:${sessionId}`;
        }
      }
    }
    return null;
  }
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  console.log('TraceIngester');
  console.log('=============\n');

  const ingester = new TraceIngester();
  const result = await ingester.ingest();

  console.log(`Source: ${result.source}`);
  console.log(`Nodes added: ${result.nodesAdded}`);
  console.log(`Nodes skipped: ${result.nodesSkipped}`);
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
