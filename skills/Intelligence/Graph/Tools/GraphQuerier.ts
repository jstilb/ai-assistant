#!/usr/bin/env bun
/**
 * GraphQuerier - CLI entry point for DevGraph
 *
 * Commands:
 *   ingest --all              Ingest from all sources
 *   ingest --source git       Git commits only
 *   ingest --source sessions  Session logs only
 *   ingest --source traces    Agent traces only
 *   ingest --infer            Run relation inference
 *   stats                     Show graph statistics
 *   search "query"            Full-text search nodes
 *   search-semantic "query"   Semantic (vector) search nodes
 *   search-hybrid "query"     Semantic + BFS graph expansion
 *   top ["query"]             Rank most-connected nodes (entry points)
 *   by-goal <goal-id>         Find goal-aligned decisions
 *   trace --from <id>         Trace backward from a node
 *   neighbors --node <id>     Show N-hop neighbors
 *   path --from <a> --to <b>  Find shortest path
 *   list --type <type>        List nodes by type (supports --tags)
 *   --help                    Show help
 *
 * @module Graph/GraphQuerier
 * @version 1.1.0
 */

import { parseArgs } from 'util';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getKayaHome } from '../../../../lib/core/KayaHome.ts';
import type { GraphNodeType, IngestionResult, IngestionSource } from './types';
import { ALL_NODE_TYPES, ALL_EDGE_TYPES } from './types';
import { GraphEngine } from './GraphEngine';
import { GraphPersistence, getGraphPersistence } from './GraphPersistence';
import { EmbeddingQuerier } from './EmbeddingQuerier';
import { getEmbeddingEngine } from './EmbeddingEngine';
import { SessionIngester } from './Ingesters/SessionIngester';
import { TraceIngester } from './Ingesters/TraceIngester';
import { GitIngester } from './Ingesters/GitIngester';
import { DecisionIngester } from './Ingesters/DecisionIngester';
import { RelationInferrer } from './Analyzers/RelationInferrer';

// ============================================
// CLI PARSING
// ============================================

function showHelp(): void {
  console.log(`
Graph - Unified Knowledge Graph CLI

Usage:
  bun Tools/GraphQuerier.ts <command> [options]

Commands:
  ingest        Ingest data from sources into the graph
  stats         Show graph statistics
  search        Full-text search across node titles
  top           Rank most-connected nodes as graph entry points
  by-goal       Find decisions aligned with a TELOS goal
  trace         Trace backward from a node to find root cause
  neighbors     Show N-hop neighbors of a node
  path          Find shortest path between two nodes
  list          List nodes by type (supports --tags)
  components    Show connected components
  audit         Show full audit report for a workflow trace

Ingest Options:
  --all                  Ingest from all sources
  --source <name>        Ingest from a specific source: git, sessions, traces, decisions
  --infer                Run relation inference after ingestion

Query Options:
  --from <id>            Starting node ID (for trace, path)
  --to <id>              Target node ID (for path)
  --node <id>            Node ID (for neighbors)
  --depth <n>            Traversal depth (default: 3)
  --type <type>          Node type filter (for list)
  --tags <t1,t2>         Tag filter (for list)
  --since <duration>     Time filter: 1d, 7d, 30d, etc.
  --limit <n>            Max results (default: 50)
  --json                 Output as JSON
  --include-expired      search/trace only: include superseded (tombstoned)
                          nodes, which are excluded by default

Node types: ${ALL_NODE_TYPES.join(', ')}
Edge types: ${ALL_EDGE_TYPES.join(', ')}

Examples:
  bun Tools/GraphQuerier.ts ingest --all
  bun Tools/GraphQuerier.ts ingest --source decisions
  bun Tools/GraphQuerier.ts stats
  bun Tools/GraphQuerier.ts search "authentication"
  bun Tools/GraphQuerier.ts top
  bun Tools/GraphQuerier.ts top --type decision --limit 10
  bun Tools/GraphQuerier.ts top "worktree"
  bun Tools/GraphQuerier.ts by-goal G25
  bun Tools/GraphQuerier.ts trace --from error:001
  bun Tools/GraphQuerier.ts neighbors --node session:001 --depth 2
  bun Tools/GraphQuerier.ts path --from session:001 --to commit:abc
  bun Tools/GraphQuerier.ts list --type commit --since 7d
  bun Tools/GraphQuerier.ts list --type decision --tags security,api
  bun Tools/GraphQuerier.ts audit workflow-123
`);
}

// ============================================
// COMMAND: INGEST
// ============================================

/**
 * Success-marker write for the graph-daily-ingest catch-up reconciler
 * (alert-storm remediation Slice 5.2). bin/job-reconciler.ts decides catch-up
 * eligibility PURELY on desiredArtifact freshness (lib/cron/JobReconciler.ts)
 * — graph ingestion writes straight into the graph DB with no dated per-run
 * file, so there was nothing for the reconciler to check and sleep nights
 * silently skipped this job. Written only when commandIngest() reaches the
 * end without throwing — main()'s top-level `.catch()` handles anything that
 * throws above (a hard ingester/persistence failure) and exits 1, so a
 * thrown error never reaches this point and never gets marked "caught up."
 * Date uses the same LA-local en-CA convention job-reconciler.ts's
 * resolveArtifactPath() resolves the manifest's `{date}` token against, so
 * the two agree on "today" near UTC midnight.
 */
export function writeIngestSuccessMarker(totalNodes: number, totalEdges: number): void {
  try {
    const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const dir = join(getKayaHome(), 'MEMORY', 'GRAPH', 'ingest');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${date}.md`),
      `# Graph ingest — ${date}\n\nCompleted at ${new Date().toISOString()}: +${totalNodes} nodes, +${totalEdges} edges.\n`,
    );
  } catch {
    // Best-effort marker — a write failure here must not fail the ingest
    // itself, it only means the catch-up reconciler may re-run it needlessly.
  }
}

async function commandIngest(options: {
  all?: boolean;
  source?: string;
  infer?: boolean;
}): Promise<void> {
  const persistence = getGraphPersistence();
  const results: IngestionResult[] = [];

  const sources: IngestionSource[] = [];

  if (options.all) {
    sources.push('git', 'sessions', 'traces', 'decisions');
  } else if (options.source) {
    const validSources = ['git', 'sessions', 'traces', 'decisions'];
    if (!validSources.includes(options.source)) {
      console.error(`Invalid source: ${options.source}`);
      console.error(`Valid sources: ${validSources.join(', ')}`);
      process.exit(1);
    }
    sources.push(options.source as IngestionSource);
  }

  if (sources.length === 0 && !options.infer) {
    console.error('No source specified. Use --all, --source <name>, or --infer');
    process.exit(1);
  }

  for (const source of sources) {
    console.log(`Ingesting from ${source}...`);

    let result: IngestionResult;

    switch (source) {
      case 'git': {
        const ingester = new GitIngester(persistence);
        result = await ingester.ingest();
        break;
      }
      case 'sessions': {
        const ingester = new SessionIngester(persistence);
        result = await ingester.ingest();
        break;
      }
      case 'traces': {
        const ingester = new TraceIngester(persistence);
        result = await ingester.ingest();
        break;
      }
      case 'decisions': {
        const ingester = new DecisionIngester(persistence);
        result = await ingester.ingest();
        break;
      }
      default:
        continue;
    }

    results.push(result);
    console.log(`  Nodes: +${result.nodesAdded} (${result.nodesSkipped} skipped)`);
    console.log(`  Edges: +${result.edgesAdded} (${result.edgesSkipped} skipped)`);
    console.log(`  Duration: ${result.duration}ms`);

    if (result.errors.length > 0) {
      console.log(`  Warnings: ${result.errors.length}`);
      for (const err of result.errors.slice(0, 3)) {
        console.log(`    - ${err}`);
      }
    }
    console.log('');
  }

  // Run inference if requested or if --all
  if (options.infer || options.all) {
    console.log('Running relation inference...');
    const inferrer = new RelationInferrer(persistence);
    const inferResult = await inferrer.infer();
    results.push(inferResult);
    console.log(`  Edges inferred: +${inferResult.edgesAdded} (${inferResult.edgesSkipped} skipped)`);
    console.log(`  Duration: ${inferResult.duration}ms`);
    console.log('');
  }

  // Update meta
  await persistence.rebuildMeta();

  // Summary
  const totalNodes = results.reduce((sum, r) => sum + r.nodesAdded, 0);
  const totalEdges = results.reduce((sum, r) => sum + r.edgesAdded, 0);

  // Update embedding index for newly ingested nodes
  if (totalNodes > 0 || options.all) {
    console.log('Updating embedding index...');
    const embEngine = getEmbeddingEngine();
    embEngine.openDb();
    const embResult = await embEngine.buildIncremental();
    console.log(`  Embeddings: +${embResult.embedded} (${embResult.skipped} skipped)`);
    embEngine.close();
    console.log('');
  }

  console.log(`Ingestion complete: +${totalNodes} nodes, +${totalEdges} edges`);
  writeIngestSuccessMarker(totalNodes, totalEdges);
}

// ============================================
// COMMAND: STATS
// ============================================

async function commandStats(jsonOutput: boolean): Promise<void> {
  const persistence = getGraphPersistence();
  const engine = persistence.loadIntoEngine();
  const stats = engine.getStats();

  if (jsonOutput) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  console.log('Graph Statistics');
  console.log('===================');
  console.log(`Total nodes: ${stats.nodeCount}`);
  console.log(`Total edges: ${stats.edgeCount}`);

  console.log('\nNodes by type:');
  for (const [type, count] of Object.entries(stats.nodesByType)) {
    if (count > 0) console.log(`  ${type}: ${count}`);
  }

  console.log('\nEdges by type:');
  for (const [type, count] of Object.entries(stats.edgesByType)) {
    if (count > 0) console.log(`  ${type}: ${count}`);
  }

  const components = engine.getConnectedComponents();
  console.log(`\nConnected components: ${components.length}`);
  if (components.length > 0 && components.length <= 10) {
    for (let i = 0; i < components.length; i++) {
      console.log(`  Component ${i + 1}: ${components[i].length} nodes`);
    }
  }
}

// ============================================
// COMMAND: TRACE
// ============================================

async function commandTrace(
  fromId: string,
  depth: number,
  jsonOutput: boolean,
  includeExpired: boolean,
): Promise<void> {
  const persistence = getGraphPersistence();
  // excludeExpired (Slice C1): trace is "what should Kaya act on now" —
  // a superseded outcome must stop surfacing here by default. --include-expired
  // is the forensic opt-out (IssueTracer itself stays unfiltered always —
  // this flag is scoped to this CLI command, not a change to that tool).
  const engine = persistence.loadIntoEngine(undefined, { excludeExpired: !includeExpired });

  if (!engine.hasNode(fromId)) {
    console.error(`Node not found: ${fromId}`);
    // Try to suggest similar IDs
    const allNodes = engine.getNodes();
    const suggestions = allNodes
      .filter(n => n.id.includes(fromId.split(':').pop() || ''))
      .slice(0, 5);
    if (suggestions.length > 0) {
      console.error('Did you mean:');
      for (const s of suggestions) {
        console.error(`  ${s.id} (${s.title})`);
      }
    }
    process.exit(1);
  }

  const results = engine.traceBackward(fromId, depth);

  if (jsonOutput) {
    console.log(JSON.stringify(results.map(r => ({
      id: r.node.id,
      type: r.node.type,
      title: r.node.title,
      depth: r.depth,
      created_at: r.node.created_at,
    })), null, 2));
    return;
  }

  const startNode = engine.getNode(fromId)!;
  console.log(`Tracing backward from: ${startNode.type}:${startNode.title}`);
  console.log(`Max depth: ${depth}`);
  console.log('---');

  if (results.length === 0) {
    console.log('No predecessors found.');
    return;
  }

  for (const r of results) {
    const indent = '  '.repeat(r.depth);
    console.log(`${indent}[depth=${r.depth}] ${r.node.type}: ${r.node.title}`);
    console.log(`${indent}         id: ${r.node.id}`);
    console.log(`${indent}         at: ${r.node.created_at}`);
  }
}

// ============================================
// COMMAND: NEIGHBORS
// ============================================

async function commandNeighbors(
  nodeId: string,
  depth: number,
  jsonOutput: boolean,
): Promise<void> {
  const persistence = getGraphPersistence();
  const engine = persistence.loadIntoEngine();

  if (!engine.hasNode(nodeId)) {
    console.error(`Node not found: ${nodeId}`);
    process.exit(1);
  }

  const results = engine.getNeighbors(nodeId, depth);

  if (jsonOutput) {
    console.log(JSON.stringify(results.map(r => ({
      id: r.node.id,
      type: r.node.type,
      title: r.node.title,
      depth: r.depth,
    })), null, 2));
    return;
  }

  const startNode = engine.getNode(nodeId)!;
  console.log(`Neighbors of: ${startNode.type}:${startNode.title}`);
  console.log(`Depth: ${depth}`);
  console.log('---');

  if (results.length === 0) {
    console.log('No neighbors found.');
    return;
  }

  for (const r of results) {
    const indent = '  '.repeat(r.depth);
    console.log(`${indent}[depth=${r.depth}] ${r.node.type}: ${r.node.title}`);
  }
}

// ============================================
// COMMAND: PATH
// ============================================

async function commandPath(
  fromId: string,
  toId: string,
  jsonOutput: boolean,
): Promise<void> {
  const persistence = getGraphPersistence();
  const engine = persistence.loadIntoEngine();

  if (!engine.hasNode(fromId)) {
    console.error(`Source node not found: ${fromId}`);
    process.exit(1);
  }
  if (!engine.hasNode(toId)) {
    console.error(`Target node not found: ${toId}`);
    process.exit(1);
  }

  const path = engine.shortestPath(fromId, toId);

  if (jsonOutput) {
    console.log(JSON.stringify({ from: fromId, to: toId, path, length: path?.length || 0 }));
    return;
  }

  if (!path) {
    console.log(`No path found between ${fromId} and ${toId}`);
    return;
  }

  console.log(`Shortest path (${path.length - 1} hops):`);
  for (let i = 0; i < path.length; i++) {
    const node = engine.getNode(path[i]);
    const prefix = i === 0 ? 'START' : i === path.length - 1 ? 'END  ' : `     `;
    console.log(`  ${prefix} ${node?.type || '?'}: ${node?.title || path[i]}`);

    if (i < path.length - 1) {
      const edges = engine.findEdgesBetween(path[i], path[i + 1]);
      const reverseEdges = engine.findEdgesBetween(path[i + 1], path[i]);
      const allEdges = [...edges, ...reverseEdges];
      if (allEdges.length > 0) {
        console.log(`         --[${allEdges[0].type}]-->`);
      } else {
        console.log(`         --[?]-->`);
      }
    }
  }
}

// ============================================
// COMMAND: LIST
// ============================================

async function commandList(
  type: string,
  since: string | undefined,
  tags: string | undefined,
  limit: number,
  jsonOutput: boolean,
): Promise<void> {
  const persistence = getGraphPersistence();
  const engine = persistence.loadIntoEngine();

  let sinceDate: string | undefined;
  if (since) {
    const match = since.match(/^(\d+)([dhm])$/);
    if (match) {
      const amount = parseInt(match[1]);
      const unit = match[2];
      const ms = unit === 'd' ? amount * 86400000 :
                 unit === 'h' ? amount * 3600000 :
                 amount * 60000;
      sinceDate = new Date(Date.now() - ms).toISOString();
    }
  }

  const tagList = tags ? tags.split(',').map(t => t.trim()) : undefined;

  const nodes = engine.findNodes({
    type: type as GraphNodeType,
    since: sinceDate,
    tags: tagList,
  }).slice(0, limit);

  if (jsonOutput) {
    console.log(JSON.stringify(nodes.map(n => ({
      id: n.id,
      type: n.type,
      title: n.title,
      created_at: n.created_at,
      tags: n.tags,
    })), null, 2));
    return;
  }

  console.log(`Listing ${type} nodes${since ? ` (since ${since})` : ''}: ${nodes.length} found`);
  console.log('---');

  for (const node of nodes) {
    console.log(`  [${node.id}]`);
    console.log(`    ${node.title}`);
    console.log(`    Created: ${node.created_at}`);
    if (node.tags.length > 0) {
      console.log(`    Tags: ${node.tags.join(', ')}`);
    }
  }
}

// ============================================
// COMMAND: SEARCH-SEMANTIC
// ============================================

async function commandSearchSemantic(
  query: string,
  type: string | undefined,
  limit: number,
  minScore: number,
  jsonOutput: boolean,
): Promise<void> {
  const querier = new EmbeddingQuerier();
  querier.init();

  const results = await querier.semanticSearch(query, {
    type: type as GraphNodeType | undefined,
    limit,
    minScore,
  });

  querier.close();

  if (jsonOutput) {
    console.log(JSON.stringify(results.map(r => ({
      id: r.node.id,
      type: r.node.type,
      title: r.node.title,
      score: r.score,
      source: r.source,
      tags: r.node.tags,
    })), null, 2));
    return;
  }

  console.log(`Semantic search results for "${query}": ${results.length} found`);
  console.log('---');

  for (const r of results) {
    console.log(`[${r.score.toFixed(2)}] ${r.node.type}: ${r.node.title}`);
    console.log(`       id: ${r.node.id}`);
    if (r.node.tags.length > 0) console.log(`       tags: ${r.node.tags.join(', ')}`);
    console.log(`       [source: ${r.source}]`);
    console.log('');
  }
}

// ============================================
// COMMAND: SEARCH-HYBRID
// ============================================

async function commandSearchHybrid(
  query: string,
  type: string | undefined,
  depth: number,
  limit: number,
  jsonOutput: boolean,
): Promise<void> {
  const querier = new EmbeddingQuerier();
  querier.init();

  const results = await querier.hybridSearch(query, {
    type: type as GraphNodeType | undefined,
    depth,
    limit,
  });

  querier.close();

  if (jsonOutput) {
    console.log(JSON.stringify(results.map(r => ({
      id: r.node.id,
      type: r.node.type,
      title: r.node.title,
      score: r.score,
      source: r.source,
      depth: r.depth,
      viaNodeId: r.viaNodeId,
      tags: r.node.tags,
    })), null, 2));
    return;
  }

  console.log(`Hybrid search results for "${query}": ${results.length} found`);
  console.log('---');

  for (const r of results) {
    const depthStr = r.depth !== undefined ? `, depth=${r.depth}` : '';
    const viaStr = r.viaNodeId ? `, via: ${r.viaNodeId}` : '';
    console.log(`[${r.score.toFixed(2)}] ${r.node.type}: ${r.node.title}`);
    console.log(`       id: ${r.node.id}`);
    if (r.node.tags.length > 0) console.log(`       tags: ${r.node.tags.join(', ')}`);
    console.log(`       [source: ${r.source}${depthStr}${viaStr}]`);
    console.log('');
  }
}

// ============================================
// COMMAND: SEARCH
// ============================================

async function commandSearch(
  query: string,
  limit: number,
  jsonOutput: boolean,
  includeExpired: boolean,
): Promise<void> {
  const persistence = getGraphPersistence();
  // excludeExpired (Slice C1): this is CLAUDE.md's primary documented
  // graph-lookup entrypoint ("query the graph before grepping") — a
  // superseded fact must stop competing here by default, or the slice's
  // headline guarantee only holds on the semantic-search layer nobody is
  // told to use. --include-expired is the forensic opt-out.
  const engine = persistence.loadIntoEngine(undefined, { excludeExpired: !includeExpired });

  const nodes = engine.findNodes({
    titleContains: query,
  }).slice(0, limit);

  if (jsonOutput) {
    console.log(JSON.stringify(nodes.map(n => ({
      id: n.id,
      type: n.type,
      title: n.title,
      created_at: n.created_at,
      tags: n.tags,
    })), null, 2));
    return;
  }

  console.log(`Search results for "${query}": ${nodes.length} found`);
  console.log('---');

  for (const node of nodes) {
    console.log(`  [${node.type}] ${node.id}`);
    console.log(`    ${node.title}`);
    console.log(`    Created: ${node.created_at}`);
    if (node.tags.length > 0) {
      console.log(`    Tags: ${node.tags.join(', ')}`);
    }
  }
}

// ============================================
// COMMAND: TOP
// ============================================

async function commandTop(
  query: string | undefined,
  type: string | undefined,
  limit: number,
  jsonOutput: boolean,
): Promise<void> {
  const persistence = getGraphPersistence();
  const engine = persistence.loadIntoEngine();

  const results = engine.getTopNodes({
    type: type as GraphNodeType | undefined,
    titleContains: query,
    limit,
  });

  if (jsonOutput) {
    console.log(JSON.stringify(results.map(r => ({
      id: r.node.id,
      type: r.node.type,
      title: r.node.title,
      degree: r.degree,
      inDegree: r.inDegree,
      outDegree: r.outDegree,
      tags: r.node.tags,
    })), null, 2));
    return;
  }

  const scope = [
    type ? `type=${type}` : null,
    query ? `matching "${query}"` : null,
  ].filter(Boolean).join(', ');

  console.log(`Top entry-point nodes${scope ? ` (${scope})` : ''}: ${results.length} found`);
  console.log('(ranked by connections — most-connected hubs are the best places to start a trace)');
  console.log('---');

  if (results.length === 0) {
    console.log('No connected nodes found. Try `ingest --all` to build edges, or widen the filter.');
    return;
  }

  for (const r of results) {
    console.log(`  [deg ${r.degree}  in ${r.inDegree} / out ${r.outDegree}] ${r.node.type}: ${r.node.title}`);
    console.log(`         id: ${r.node.id}`);
    if (r.node.tags.length > 0) {
      console.log(`         tags: ${r.node.tags.join(', ')}`);
    }
  }
}

// ============================================
// COMMAND: BY-GOAL
// ============================================

async function commandByGoal(
  goalQuery: string,
  limit: number,
  jsonOutput: boolean,
): Promise<void> {
  const persistence = getGraphPersistence();
  const engine = persistence.loadIntoEngine();

  // Find goal nodes matching the query
  const goalNodes = engine.findNodes({
    type: 'goal',
    titleContains: goalQuery,
  });

  if (goalNodes.length === 0) {
    // Also try searching by tag
    const byTag = engine.findNodes({ type: 'goal', tags: [goalQuery] });
    if (byTag.length === 0) {
      console.error(`No goal nodes found matching "${goalQuery}"`);
      const allGoals = engine.getNodes('goal');
      if (allGoals.length > 0) {
        console.error('Available goals:');
        for (const g of allGoals.slice(0, 10)) {
          console.error(`  ${g.id}: ${g.title}`);
        }
      }
      process.exit(1);
    }
    goalNodes.push(...byTag);
  }

  // Traverse goal_aligned edges from each goal
  const alignedNodes: Array<{ node: typeof goalNodes[0]; depth: number; goalTitle: string }> = [];
  const seen = new Set<string>();

  for (const goal of goalNodes) {
    const aligned = engine.traceBackward(goal.id, 3, ['goal_aligned']);
    for (const r of aligned) {
      if (!seen.has(r.node.id)) {
        seen.add(r.node.id);
        alignedNodes.push({ ...r, goalTitle: goal.title });
      }
    }
    // Also check forward
    const forward = engine.traceForward(goal.id, 3, ['goal_aligned']);
    for (const r of forward) {
      if (!seen.has(r.node.id)) {
        seen.add(r.node.id);
        alignedNodes.push({ ...r, goalTitle: goal.title });
      }
    }
  }

  const results = alignedNodes.slice(0, limit);

  if (jsonOutput) {
    console.log(JSON.stringify(results.map(r => ({
      id: r.node.id,
      type: r.node.type,
      title: r.node.title,
      goalTitle: r.goalTitle,
      depth: r.depth,
    })), null, 2));
    return;
  }

  console.log(`Decisions aligned with goal "${goalQuery}": ${results.length} found`);
  console.log('---');

  for (const r of results) {
    console.log(`  [${r.node.type}] ${r.node.id}`);
    console.log(`    ${r.node.title}`);
    console.log(`    Aligned to: ${r.goalTitle}`);
  }
}

// ============================================
// COMMAND: COMPONENTS
// ============================================

async function commandComponents(jsonOutput: boolean): Promise<void> {
  const persistence = getGraphPersistence();
  const engine = persistence.loadIntoEngine();

  const components = engine.getConnectedComponents();

  if (jsonOutput) {
    console.log(JSON.stringify(components.map((c, i) => ({
      id: i + 1,
      size: c.length,
      nodes: c.slice(0, 10),
    })), null, 2));
    return;
  }

  console.log(`Connected Components: ${components.length}`);
  console.log('---');

  const sorted = components.sort((a, b) => b.length - a.length);
  for (let i = 0; i < Math.min(sorted.length, 20); i++) {
    const comp = sorted[i];
    console.log(`\n  Component ${i + 1} (${comp.length} nodes):`);
    for (const nodeId of comp.slice(0, 5)) {
      const node = engine.getNode(nodeId);
      if (node) {
        console.log(`    ${node.type}: ${node.title}`);
      }
    }
    if (comp.length > 5) {
      console.log(`    ... and ${comp.length - 5} more`);
    }
  }
}

// ============================================
// COMMAND: AUDIT
// ============================================

async function commandAudit(
  workflowId: string,
  jsonOutput: boolean,
): Promise<void> {
  const persistence = getGraphPersistence();
  const engine = persistence.loadIntoEngine();

  const traceId = `agent_trace:${workflowId}`;

  if (!engine.hasNode(traceId)) {
    console.error(`No agent_trace node found for workflow: ${workflowId}`);
    console.error('Run "bun Tools/GraphQuerier.ts ingest --source traces" first');
    process.exit(1);
  }

  const traceNode = engine.getNode(traceId)!;

  // Backward trace: causal chain
  const backward = engine.traceBackward(traceId, 3);

  // Forward trace: files touched
  const forwardFiles = engine.traceForward(traceId, 1, ['modifies']);
  const files = forwardFiles.filter(r => r.node.type === 'file');

  // Other traces touching same files
  const relatedTraces: Array<{ traceTitle: string; file: string; score?: number }> = [];
  for (const fileResult of files) {
    const otherTraces = engine.traceBackward(fileResult.node.id, 1, ['modifies']);
    for (const ot of otherTraces) {
      if (ot.node.type === 'agent_trace' && ot.node.id !== traceId) {
        relatedTraces.push({
          traceTitle: ot.node.title,
          file: fileResult.node.title,
          score: ot.node.metadata.evaluationScore as number | undefined,
        });
      }
    }
  }

  // Optional AgentMonitor integration — dynamic import with graceful degradation
  interface TraceAuditResult {
    workflowId: string;
    overallScore: number;
    rootCause: string;
    failureCategory: string;
    decisionErrors: Array<{ timestamp: number; description: string; betterAlternative: string }>;
    confidence: number;
  }
  let audit: TraceAuditResult | null = null;
  try {
    // cross-skill-allowed: dynamic import for trace-audit queries with graceful degradation, deliberate
    const agentMonitor = await import('../../../System/AgentMonitor/Tools/TraceAuditor.ts') as {
      loadAudit: (id: string) => TraceAuditResult | null;
    };
    audit = agentMonitor.loadAudit(workflowId);
  } catch {
    // AgentMonitor not available — audit runs without LLM analysis
  }

  if (jsonOutput) {
    console.log(JSON.stringify({
      workflowId,
      traceNode: {
        id: traceNode.id,
        title: traceNode.title,
        metadata: traceNode.metadata,
        tags: traceNode.tags,
      },
      causalChain: backward.map(r => ({
        id: r.node.id,
        type: r.node.type,
        title: r.node.title,
        depth: r.depth,
      })),
      filesTouched: files.map(r => r.node.title),
      relatedTraces,
      audit: audit || null,
    }, null, 2));
    return;
  }

  console.log('Workflow Audit Report');
  console.log('====================\n');
  console.log(`Workflow: ${workflowId}`);
  console.log(`Events: ${traceNode.metadata.eventCount}`);
  console.log(`Tokens: ${traceNode.metadata.totalTokens}`);
  console.log(`Has errors: ${traceNode.metadata.hasError}`);

  if (traceNode.metadata.evaluationScore !== undefined) {
    console.log(`Evaluation: ${traceNode.metadata.evaluationScore}/100 (${traceNode.metadata.evaluationPassed ? 'PASS' : 'FAIL'})`);
  }

  if (backward.length > 0) {
    console.log('\nCausal Chain (backward trace):');
    for (const r of backward) {
      const indent = '  '.repeat(r.depth);
      console.log(`${indent}[depth=${r.depth}] ${r.node.type}: ${r.node.title}`);
    }
  }

  if (files.length > 0) {
    console.log('\nFiles Touched:');
    for (const f of files) {
      console.log(`  ${f.node.title}`);
    }
  }

  if (relatedTraces.length > 0) {
    console.log('\nRelated Traces (same files):');
    for (const rt of relatedTraces) {
      console.log(`  ${rt.traceTitle} (via ${rt.file})${rt.score !== undefined ? ` — score: ${rt.score}/100` : ''}`);
    }
  }

  if (audit) {
    console.log('\nLLM Audit:');
    console.log(`  Root Cause: ${audit.rootCause}`);
    console.log(`  Category: ${audit.failureCategory}`);
    console.log(`  Confidence: ${(audit.confidence * 100).toFixed(0)}%`);
    if (audit.decisionErrors.length > 0) {
      console.log(`  Decision Errors:`);
      for (const err of audit.decisionErrors) {
        console.log(`    - ${err.description}`);
      }
    }
  }
}

// ============================================
// MAIN
// ============================================

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      all: { type: 'boolean' },
      source: { type: 'string' },
      infer: { type: 'boolean' },
      from: { type: 'string' },
      to: { type: 'string' },
      node: { type: 'string' },
      depth: { type: 'string' },
      type: { type: 'string' },
      tags: { type: 'string' },
      since: { type: 'string' },
      limit: { type: 'string' },
      'min-score': { type: 'string' },
      json: { type: 'boolean' },
      'include-expired': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    showHelp();
    process.exit(0);
  }

  const command = positionals[0];
  const depth = values.depth ? parseInt(values.depth) : 3;
  const limit = values.limit ? parseInt(values.limit) : 50;
  const minScore = values['min-score'] ? parseFloat(values['min-score']) : 0.40;
  const jsonOutput = values.json || false;
  // Slice C1 (context integrity): search/trace exclude expired (tombstoned)
  // nodes by default — this flag opts back into forensic include-everything.
  const includeExpired = values['include-expired'] || false;

  switch (command) {
    case 'ingest':
      await commandIngest({
        all: values.all,
        source: values.source,
        infer: values.infer,
      });
      break;

    case 'stats':
      await commandStats(jsonOutput);
      break;

    case 'search': {
      const query = positionals[1];
      if (!query) {
        console.error('Usage: search "query"');
        process.exit(1);
      }
      await commandSearch(query, limit, jsonOutput, includeExpired);
      break;
    }

    case 'search-semantic': {
      const query = positionals[1];
      if (!query) {
        console.error('Usage: search-semantic "query" [--type <type>] [--limit N] [--min-score 0.65]');
        process.exit(1);
      }
      await commandSearchSemantic(query, values.type, limit, minScore, jsonOutput);
      break;
    }

    case 'search-hybrid': {
      const query = positionals[1];
      if (!query) {
        console.error('Usage: search-hybrid "query" [--type <type>] [--depth N] [--limit N]');
        process.exit(1);
      }
      await commandSearchHybrid(query, values.type, depth, limit, jsonOutput);
      break;
    }

    case 'top': {
      // Optional positional query filters the top nodes by title substring.
      await commandTop(positionals[1], values.type, limit, jsonOutput);
      break;
    }

    case 'by-goal': {
      const goalQuery = positionals[1];
      if (!goalQuery) {
        console.error('Usage: by-goal <goal-id-or-title>');
        process.exit(1);
      }
      await commandByGoal(goalQuery, limit, jsonOutput);
      break;
    }

    case 'trace':
      if (!values.from) {
        console.error('--from <id> is required for trace');
        process.exit(1);
      }
      await commandTrace(values.from, depth, jsonOutput, includeExpired);
      break;

    case 'neighbors':
      if (!values.node) {
        console.error('--node <id> is required for neighbors');
        process.exit(1);
      }
      await commandNeighbors(values.node, depth, jsonOutput);
      break;

    case 'path':
      if (!values.from || !values.to) {
        console.error('--from <id> and --to <id> are required for path');
        process.exit(1);
      }
      await commandPath(values.from, values.to, jsonOutput);
      break;

    case 'list':
      if (!values.type) {
        console.error('--type <type> is required for list');
        console.error(`Valid types: ${ALL_NODE_TYPES.join(', ')}`);
        process.exit(1);
      }
      await commandList(values.type, values.since, values.tags, limit, jsonOutput);
      break;

    case 'components':
      await commandComponents(jsonOutput);
      break;

    case 'audit': {
      const workflowQuery = positionals[1] || values.from;
      if (!workflowQuery) {
        console.error('Usage: audit <workflow-id> or audit --from <workflow-id>');
        process.exit(1);
      }
      await commandAudit(workflowQuery, jsonOutput);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

// Guarded (alert-storm remediation Slice 5.2 test support): this file is only
// ever invoked as a direct CLI script (`bun GraphQuerier.ts ingest --all` —
// see MEMORY/daemon/cron/manifests/graph-daily-ingest.yaml's execute
// config; grep confirms no other module imports from this file). Guarding
// with import.meta.main changes nothing for that real path (still true when
// run directly) but makes writeIngestSuccessMarker() importable/testable in
// isolation without the import itself parsing argv and calling process.exit.
if (import.meta.main) {
  main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}
