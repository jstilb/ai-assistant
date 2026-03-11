#!/usr/bin/env bun
import { parseArgs } from 'util';
import { getGraphPersistence } from '../GraphPersistence';
import type { GraphNode, GraphEdge, GraphNodeType, GraphEdgeType } from '../types';

// ---------------------------------------------------------------------------
// Mermaid ID / title helpers
// ---------------------------------------------------------------------------

function sanitizeId(raw: string): string {
  return raw.replace(/[:.\/\-@#\s]/g, '_');
}

function truncate(text: string, max = 40): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

/** Wrap title in the correct Mermaid shape for the node type. */
function nodeShape(node: GraphNode): string {
  const id = sanitizeId(node.id);
  const label = truncate(node.title);

  switch (node.type as GraphNodeType) {
    case 'session':      return `${id}[/"${label}"\\]`;
    case 'agent_trace':  return `${id}[/"${label}"/]`;
    case 'error':        return `${id}{{"${label}"}}`;
    case 'commit':       return `${id}[("${label}")]`;
    case 'learning':     return `${id}(["${label}"])`;
    case 'skill_change': return `${id}[["${label}"]]`;
    case 'file':         return `${id}["${label}"]`;
    case 'issue':        return `${id}{"${label}"}`;
    case 'decision':     return `${id}((("${label}")))`;
    case 'outcome':      return `${id}(("${label}"))`;
    case 'context':      return `${id}>"${label}"]`;
    case 'pattern':      return `${id}[\\/"${label}"/]`;
    case 'goal':         return `${id}{{"${label}"}}`;
    default:             return `${id}["${label}"]`;
  }
}

// ---------------------------------------------------------------------------
// Duration parser  ("7d" | "30d" | "24h" | "60m")
// ---------------------------------------------------------------------------

function parseSince(duration: string): Date {
  const match = duration.match(/^(\d+)([dhm])$/);
  if (!match) throw new Error(`Invalid duration: "${duration}". Use formats like 7d, 24h, 60m.`);
  const value = parseInt(match[1], 10);
  const unit = match[2] as 'd' | 'h' | 'm';
  const multipliers: Record<'d' | 'h' | 'm', number> = {
    d: 86_400_000,
    h: 3_600_000,
    m: 60_000,
  };
  return new Date(Date.now() - value * multipliers[unit]);
}

// ---------------------------------------------------------------------------
// Mode 1: --trace <node-id>
// Backward BFS from node, flowchart TD with edge labels.
// ---------------------------------------------------------------------------

function renderTrace(nodes: Array<{ node: GraphNode; depth: number }>, edges: GraphEdge[], rootId: string): string {
  const lines: string[] = ['flowchart TD'];

  const nodeIds = new Set(nodes.map(n => n.node.id));
  nodeIds.add(rootId);

  for (const { node } of nodes) {
    lines.push(`  ${nodeShape(node)}`);
  }

  for (const edge of edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      const src = sanitizeId(edge.source);
      const tgt = sanitizeId(edge.target);
      lines.push(`  ${src} -->|"${edge.type}"| ${tgt}`);
    }
  }

  return lines.join('\n');
}

async function modeTrace(nodeId: string): Promise<string> {
  const persistence = getGraphPersistence();
  const engine = await persistence.loadIntoEngine();

  const rootNode = engine.getNode(nodeId);
  if (!rootNode) throw new Error(`Node not found: ${nodeId}`);

  const traced = engine.traceBackward(nodeId, 5);
  const allNodes = [{ node: rootNode, depth: 0 }, ...traced];
  const allEdges = engine.getEdges();

  return renderTrace(allNodes, allEdges, nodeId);
}

// ---------------------------------------------------------------------------
// Mode 2: --session <id>
// Trace forward 2 hops via produced/contains/spawned.
// ---------------------------------------------------------------------------

async function modeSession(sessionId: string): Promise<string> {
  const persistence = getGraphPersistence();
  const engine = await persistence.loadIntoEngine();

  const rootNode = engine.getNode(sessionId);
  if (!rootNode) throw new Error(`Session node not found: ${sessionId}`);

  const forwardEdgeTypes: GraphEdgeType[] = ['produced', 'contains', 'spawned'];
  const traced = engine.traceForward(sessionId, 2, forwardEdgeTypes);
  const allNodes = [{ node: rootNode, depth: 0 }, ...traced];

  const nodeIds = new Set(allNodes.map(n => n.node.id));
  const allEdges = engine.getEdges();

  const lines: string[] = ['flowchart TD'];

  for (const { node } of allNodes) {
    lines.push(`  ${nodeShape(node)}`);
  }

  for (const edge of allEdges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target) && forwardEdgeTypes.includes(edge.type)) {
      const src = sanitizeId(edge.source);
      const tgt = sanitizeId(edge.target);
      lines.push(`  ${src} -->|"${edge.type}"| ${tgt}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Mode 3: --file <id>
// Trace backward via 'modifies' edges.
// ---------------------------------------------------------------------------

async function modeFile(fileId: string): Promise<string> {
  const persistence = getGraphPersistence();
  const engine = await persistence.loadIntoEngine();

  const rootNode = engine.getNode(fileId);
  if (!rootNode) throw new Error(`File node not found: ${fileId}`);

  const modifiesEdges: GraphEdgeType[] = ['modifies'];
  const traced = engine.traceBackward(fileId, 5, modifiesEdges);
  const allNodes = [{ node: rootNode, depth: 0 }, ...traced];

  const nodeIds = new Set(allNodes.map(n => n.node.id));
  const allEdges = engine.getEdges();

  const lines: string[] = ['flowchart TD'];

  for (const { node } of allNodes) {
    lines.push(`  ${nodeShape(node)}`);
  }

  for (const edge of allEdges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target) && edge.type === 'modifies') {
      const src = sanitizeId(edge.source);
      const tgt = sanitizeId(edge.target);
      lines.push(`  ${src} -->|"modifies"| ${tgt}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Mode 4: --errors --since <duration>
// Group error nodes by parent session, render clusters.
// ---------------------------------------------------------------------------

async function modeErrors(since: string): Promise<string> {
  const persistence = getGraphPersistence();
  const engine = await persistence.loadIntoEngine();

  const sinceDate = parseSince(since);
  const errorNodes = engine.findNodes({ type: 'session', since: sinceDate });
  // Actually find error type nodes:
  const errors = engine.findNodes({ type: 'error' as GraphNodeType, since: sinceDate });

  if (errors.length === 0) {
    return `flowchart TD\n  NO_ERRORS["No errors found since ${since}"]`;
  }

  const allEdges = engine.getEdges();
  const errorIds = new Set(errors.map(n => n.id));

  // Map error → parent session (via 'caused' or 'produced' edge in reverse)
  const sessionToErrors = new Map<string, GraphNode[]>();
  const orphanErrors: GraphNode[] = [];

  for (const error of errors) {
    const incomingEdges = allEdges.filter(e => e.target === error.id && (e.type === 'caused' || e.type === 'produced'));
    const parentSessions = incomingEdges
      .map(e => engine.getNode(e.source))
      .filter((n): n is GraphNode => n !== undefined && n.type === 'session');

    if (parentSessions.length > 0) {
      for (const sess of parentSessions) {
        if (!sessionToErrors.has(sess.id)) sessionToErrors.set(sess.id, []);
        sessionToErrors.get(sess.id)!.push(error);
      }
    } else {
      orphanErrors.push(error);
    }
  }

  const lines: string[] = ['flowchart TD'];
  let clusterIndex = 0;

  for (const [sessId, sessErrors] of sessionToErrors.entries()) {
    const session = engine.getNode(sessId);
    if (!session) continue;
    const clusterName = `cluster_${clusterIndex++}`;
    lines.push(`  subgraph ${clusterName}["Session: ${truncate(session.title, 35)}"]`);
    for (const err of sessErrors) {
      lines.push(`    ${nodeShape(err)}`);
    }
    lines.push('  end');
    const sessShape = nodeShape(session);
    lines.push(`  ${sessShape}`);
    for (const err of sessErrors) {
      lines.push(`  ${sanitizeId(sessId)} -->|"caused"| ${sanitizeId(err.id)}`);
    }
  }

  if (orphanErrors.length > 0) {
    lines.push('  subgraph cluster_orphans["Orphan Errors"]');
    for (const err of orphanErrors) {
      lines.push(`    ${nodeShape(err)}`);
    }
    lines.push('  end');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Mode 5: --timeline --since <duration>
// Group all nodes by day, render as subgraphs per day.
// ---------------------------------------------------------------------------

async function modeTimeline(since: string): Promise<string> {
  const persistence = getGraphPersistence();
  const engine = await persistence.loadIntoEngine();

  const sinceDate = parseSince(since);
  const allNodes = engine.findNodes({ since: sinceDate });

  if (allNodes.length === 0) {
    return `flowchart TD\n  NO_NODES["No nodes found since ${since}"]`;
  }

  // Group by day (YYYY-MM-DD)
  const byDay = new Map<string, GraphNode[]>();
  for (const node of allNodes) {
    const day = node.created_at.slice(0, 10); // ISO date prefix
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(node);
  }

  const sortedDays = Array.from(byDay.keys()).sort();

  const lines: string[] = ['flowchart TD'];

  for (const day of sortedDays) {
    const dayNodes = byDay.get(day)!;
    const subgraphId = `day_${day.replace(/-/g, '_')}`;
    lines.push(`  subgraph ${subgraphId}["${day}"]`);
    for (const node of dayNodes) {
      lines.push(`    ${nodeShape(node)}`);
    }
    lines.push('  end');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Mode 6: --goal <id>
// Follow 'goal_aligned' edges to find aligned decisions/outcomes.
// ---------------------------------------------------------------------------

async function modeGoal(goalId: string): Promise<string> {
  const persistence = getGraphPersistence();
  const engine = await persistence.loadIntoEngine();

  const rootNode = engine.getNode(goalId);
  if (!rootNode) throw new Error(`Goal node not found: ${goalId}`);

  const goalEdgeTypes: GraphEdgeType[] = ['goal_aligned'];
  const traced = engine.traceForward(goalId, 3, goalEdgeTypes);
  const allNodes = [{ node: rootNode, depth: 0 }, ...traced];

  const nodeIds = new Set(allNodes.map(n => n.node.id));
  const allEdges = engine.getEdges();

  const lines: string[] = ['flowchart TD'];

  for (const { node } of allNodes) {
    lines.push(`  ${nodeShape(node)}`);
  }

  for (const edge of allEdges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target) && edge.type === 'goal_aligned') {
      const src = sanitizeId(edge.source);
      const tgt = sanitizeId(edge.target);
      lines.push(`  ${src} -->|"goal_aligned"| ${tgt}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Mode 7: --overview --period <month|week>
// Pie chart of node type counts + cross-type edge stats as a second diagram.
// ---------------------------------------------------------------------------

async function modeOverview(period: string): Promise<string> {
  if (period !== 'month' && period !== 'week') {
    throw new Error(`Invalid period "${period}". Use "month" or "week".`);
  }

  const persistence = getGraphPersistence();
  const engine = await persistence.loadIntoEngine();

  const since = period === 'week' ? parseSince('7d') : parseSince('30d');
  const allNodes = engine.findNodes({ since });
  const allEdges = engine.getEdges();

  // Count by type
  const typeCounts = new Map<string, number>();
  for (const node of allNodes) {
    typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1);
  }

  // Pie chart
  const pieLines: string[] = [`pie title "Graph Composition (${period})"`];
  for (const [type, count] of typeCounts.entries()) {
    pieLines.push(`  "${type}" : ${count}`);
  }

  // Edge type counts (cross-type stats)
  const edgeCounts = new Map<string, number>();
  const nodeIdSet = new Set(allNodes.map(n => n.id));
  for (const edge of allEdges) {
    if (nodeIdSet.has(edge.source) || nodeIdSet.has(edge.target)) {
      edgeCounts.set(edge.type, (edgeCounts.get(edge.type) ?? 0) + 1);
    }
  }

  // Second diagram: edge stats as a bar-style flowchart (node per edge type, width via label)
  const edgeLines: string[] = ['flowchart LR', '  EDGE_STATS["Edge Type Statistics"]'];
  for (const [edgeType, count] of edgeCounts.entries()) {
    const safeId = `edge_${edgeType.replace(/-/g, '_')}`;
    edgeLines.push(`  ${safeId}["${edgeType}: ${count}"]`);
    edgeLines.push(`  EDGE_STATS --> ${safeId}`);
  }

  return [pieLines.join('\n'), '', edgeLines.join('\n')].join('\n');
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
MermaidVisualizer — Generate Mermaid diagrams from the property graph

USAGE:
  bun MermaidVisualizer.ts <mode> [options]

MODES:
  --trace <node-id>             BFS backward from node (predecessors chain)
  --session <id>                Trace what a session produced (forward 2 hops)
  --file <id>                   Trace what modified a file (backward via 'modifies')
  --errors --since <duration>   Error nodes since duration, grouped by session
  --timeline --since <duration> All nodes since duration, grouped by day
  --goal <id>                   Follow 'goal_aligned' edges from a goal node
  --overview --period <p>       Pie chart summary (period: month | week)

DURATION FORMAT:
  7d   = 7 days
  24h  = 24 hours
  60m  = 60 minutes

EXAMPLES:
  bun MermaidVisualizer.ts --trace session_abc123
  bun MermaidVisualizer.ts --session session_abc123
  bun MermaidVisualizer.ts --file file_src_index_ts
  bun MermaidVisualizer.ts --errors --since 7d
  bun MermaidVisualizer.ts --timeline --since 30d
  bun MermaidVisualizer.ts --goal goal_shipping_v2
  bun MermaidVisualizer.ts --overview --period week

OUTPUT:
  Valid Mermaid diagram syntax printed to stdout.
  Pipe to a file or render with any Mermaid-compatible tool.
`);
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      trace:    { type: 'string' },
      session:  { type: 'string' },
      file:     { type: 'string' },
      errors:   { type: 'boolean' },
      timeline: { type: 'boolean' },
      goal:     { type: 'string' },
      overview: { type: 'boolean' },
      since:    { type: 'string' },
      period:   { type: 'string' },
      help:     { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    printHelp();
    return;
  }

  let output: string;

  if (values.trace) {
    output = await modeTrace(values.trace);
  } else if (values.session) {
    output = await modeSession(values.session);
  } else if (values.file) {
    output = await modeFile(values.file);
  } else if (values.errors) {
    if (!values.since) throw new Error('--errors requires --since <duration>');
    output = await modeErrors(values.since);
  } else if (values.timeline) {
    if (!values.since) throw new Error('--timeline requires --since <duration>');
    output = await modeTimeline(values.since);
  } else if (values.goal) {
    output = await modeGoal(values.goal);
  } else if (values.overview) {
    const period = values.period ?? 'week';
    output = await modeOverview(period);
  } else {
    printHelp();
    return;
  }

  console.log(output);
}

if (import.meta.main) {
  main().catch(console.error);
}
