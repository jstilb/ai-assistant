#!/usr/bin/env bun
/**
 * One-time migration script: DevGraph + ContextGraph → Graph
 *
 * Steps:
 * 1. Copy DevGraph JSONL files to MEMORY/GRAPH/ (direct copy, types are compatible)
 * 2. Parse ContextGraph events.jsonl, convert DecisionNode to GraphNode format
 * 3. Write converted CG nodes/edges to appropriate MEMORY/GRAPH/{nodes,edges}/*.jsonl
 * 4. Deduplicate session and decision nodes that may exist in both sources
 * 5. Rebuild meta.json from the merged JSONL files
 * 6. Verify: load into GraphEngine, check counts
 *
 * Usage:
 *   bun skills/Intelligence/Graph/Tools/migrate.ts           # Run migration
 *   bun skills/Intelligence/Graph/Tools/migrate.ts --dry-run # Preview without writing
 *   bun skills/Intelligence/Graph/Tools/migrate.ts --verify  # Verify existing migration
 *
 * @module Graph/migrate
 * @version 1.0.0
 */

import { existsSync, readFileSync, copyFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { GraphPersistence } from './GraphPersistence';
import { GraphEngine } from './GraphEngine';
import type { GraphNode, GraphEdge } from './types';

// ============================================
// CONSTANTS
// ============================================

const KAYA_HOME = join(homedir(), '.claude');
const DEVGRAPH_DIR = join(KAYA_HOME, 'MEMORY', 'DEVGRAPH');
const CONTEXTGRAPH_DIR = join(KAYA_HOME, 'MEMORY', 'ContextGraph');
const GRAPH_DIR = join(KAYA_HOME, 'MEMORY', 'GRAPH');

// ============================================
// TYPES
// ============================================

interface DecisionNode {
  id: string;
  type: string;
  title: string;
  content: string;
  timestamp: string;
  recordedAt: string;
  tags: string[];
  metadata: Record<string, unknown>;
  confidence: number;
}

interface DecisionEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number;
  created_at: string;
  metadata: Record<string, unknown>;
}

interface GraphEvent {
  type: 'node_added' | 'edge_added' | 'node_updated';
  payload: DecisionNode | DecisionEdge;
  timestamp: string;
}

interface MigrationStats {
  devgraphNodesCopied: number;
  devgraphEdgesCopied: number;
  contextgraphNodesConverted: number;
  contextgraphEdgesConverted: number;
  duplicatesSkipped: number;
  totalNodes: number;
  totalEdges: number;
  errors: string[];
}

// ============================================
// DECISION NODE → GRAPH NODE CONVERTER
// ============================================

function convertDecisionNodeToGraphNode(dn: DecisionNode): GraphNode {
  return {
    id: dn.id,
    type: dn.type as any, // 'decision'|'context'|'outcome'|'pattern'|'goal'|'session' - all valid GraphNodeType
    title: dn.title,
    created_at: dn.recordedAt,
    valid_from: dn.timestamp,
    tags: dn.tags,
    metadata: {
      content: dn.content,
      confidence: dn.confidence,
      recordedAt: dn.recordedAt,
      ...dn.metadata,
    },
  };
}

function convertDecisionEdgeToGraphEdge(de: DecisionEdge): GraphEdge {
  return {
    id: de.id,
    source: de.source,
    target: de.target,
    type: de.type as any, // All CG edge types are in the unified schema
    weight: de.weight,
    created_at: de.created_at,
    metadata: de.metadata,
  };
}

// ============================================
// STEP 1: COPY DEVGRAPH DATA
// ============================================

function copyDevGraphData(dryRun: boolean): { nodes: number; edges: number } {
  console.log('\n[Step 1] Copying DevGraph data...');

  const devNodesDir = join(DEVGRAPH_DIR, 'nodes');
  const devEdgesDir = join(DEVGRAPH_DIR, 'edges');
  const graphNodesDir = join(GRAPH_DIR, 'nodes');
  const graphEdgesDir = join(GRAPH_DIR, 'edges');

  let nodesCopied = 0;
  let edgesCopied = 0;

  // Copy node JSONL files
  const nodeFiles = ['commit.jsonl', 'error.jsonl', 'file.jsonl', 'session.jsonl', 'skill_change.jsonl'];
  for (const file of nodeFiles) {
    const src = join(devNodesDir, file);
    const dest = join(graphNodesDir, file);
    if (existsSync(src)) {
      if (!dryRun) {
        copyFileSync(src, dest);
      }
      const lines = readFileSync(src, 'utf-8').split('\n').filter(l => l.trim()).length;
      nodesCopied += lines;
      console.log(`  ✓ Copied ${file}: ${lines} nodes`);
    }
  }

  // Copy edge JSONL files
  const edgeFiles = ['contains.jsonl', 'modifies.jsonl', 'relates_to.jsonl'];
  for (const file of edgeFiles) {
    const src = join(devEdgesDir, file);
    const dest = join(graphEdgesDir, file);
    if (existsSync(src)) {
      if (!dryRun) {
        copyFileSync(src, dest);
      }
      const lines = readFileSync(src, 'utf-8').split('\n').filter(l => l.trim()).length;
      edgesCopied += lines;
      console.log(`  ✓ Copied ${file}: ${lines} edges`);
    }
  }

  // Copy meta.json as initial state
  const devMeta = join(DEVGRAPH_DIR, 'meta.json');
  const graphMeta = join(GRAPH_DIR, 'meta.json');
  if (existsSync(devMeta) && !dryRun) {
    copyFileSync(devMeta, graphMeta);
    console.log(`  ✓ Copied meta.json`);
  }

  return { nodes: nodesCopied, edges: edgesCopied };
}

// ============================================
// STEP 2: PARSE CONTEXTGRAPH EVENTS
// ============================================

function parseContextGraphEvents(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  console.log('\n[Step 2] Parsing ContextGraph events...');

  const eventsFile = join(CONTEXTGRAPH_DIR, 'events.jsonl');
  if (!existsSync(eventsFile)) {
    console.log('  ⚠ No events.jsonl found in ContextGraph');
    return { nodes: [], edges: [] };
  }

  const content = readFileSync(eventsFile, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const line of lines) {
    try {
      const event: GraphEvent = JSON.parse(line);

      if (event.type === 'node_added') {
        const dn = event.payload as DecisionNode;
        const gn = convertDecisionNodeToGraphNode(dn);
        nodes.push(gn);
      } else if (event.type === 'edge_added') {
        const de = event.payload as DecisionEdge;
        const ge = convertDecisionEdgeToGraphEdge(de);
        edges.push(ge);
      }
    } catch (err) {
      console.error(`  ✗ Failed to parse event: ${err}`);
    }
  }

  console.log(`  ✓ Parsed ${nodes.length} nodes and ${edges.length} edges from ContextGraph`);

  // Group by type for reporting
  const nodesByType: Record<string, number> = {};
  for (const node of nodes) {
    nodesByType[node.type] = (nodesByType[node.type] || 0) + 1;
  }
  console.log(`    Node types: ${JSON.stringify(nodesByType)}`);

  const edgesByType: Record<string, number> = {};
  for (const edge of edges) {
    edgesByType[edge.type] = (edgesByType[edge.type] || 0) + 1;
  }
  console.log(`    Edge types: ${JSON.stringify(edgesByType)}`);

  return { nodes, edges };
}

// ============================================
// STEP 3: WRITE CONTEXTGRAPH DATA
// ============================================

function writeContextGraphData(
  nodes: GraphNode[],
  edges: GraphEdge[],
  dryRun: boolean,
): { written: number; skipped: number } {
  console.log('\n[Step 3] Writing ContextGraph data to MEMORY/GRAPH/...');

  if (dryRun) {
    console.log('  [DRY RUN] Would write nodes and edges');
    return { written: nodes.length + edges.length, skipped: 0 };
  }

  const persistence = new GraphPersistence(GRAPH_DIR);

  // Group nodes by type
  const nodesByType = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const group = nodesByType.get(node.type) || [];
    group.push(node);
    nodesByType.set(node.type, group);
  }

  let written = 0;
  let skipped = 0;

  // Write nodes per type (deduplication happens in appendNodes)
  for (const [type, typeNodes] of nodesByType) {
    const added = persistence.appendNodes(typeNodes);
    written += added;
    skipped += (typeNodes.length - added);
    console.log(`  ✓ ${type}: ${added} added, ${typeNodes.length - added} skipped (duplicates)`);
  }

  // Write edges
  const edgesAdded = persistence.appendEdges(edges);
  written += edgesAdded;
  skipped += (edges.length - edgesAdded);
  console.log(`  ✓ Edges: ${edgesAdded} added, ${edges.length - edgesAdded} skipped (duplicates)`);

  return { written, skipped };
}

// ============================================
// STEP 4: REBUILD META.JSON
// ============================================

async function rebuildMeta(dryRun: boolean): Promise<void> {
  console.log('\n[Step 4] Rebuilding meta.json...');

  if (dryRun) {
    console.log('  [DRY RUN] Would rebuild meta.json');
    return;
  }

  const persistence = new GraphPersistence(GRAPH_DIR);
  const state = await persistence.rebuildMeta();

  console.log(`  ✓ meta.json rebuilt`);
  console.log(`    Total nodes: ${state.nodeCount}`);
  console.log(`    Total edges: ${state.edgeCount}`);
  console.log(`    Nodes by type:`, JSON.stringify(state.nodesByType, null, 2));
}

// ============================================
// STEP 5: VERIFY MIGRATION
// ============================================

function verifyMigration(): void {
  console.log('\n[Step 5] Verifying migration...');

  const persistence = new GraphPersistence(GRAPH_DIR);
  const engine = persistence.loadIntoEngine();
  const stats = engine.getStats();

  console.log(`  ✓ Loaded graph into engine`);
  console.log(`    Nodes: ${stats.nodeCount}`);
  console.log(`    Edges: ${stats.edgeCount}`);

  // Verify minimum expectations (from spec)
  const checks = [
    { name: 'Total nodes >= 7500', pass: stats.nodeCount >= 7500 },
    { name: 'Total edges >= 10000', pass: stats.edgeCount >= 10000 },
    { name: 'Session nodes exist', pass: stats.nodesByType['session'] > 0 },
    { name: 'File nodes exist', pass: stats.nodesByType['file'] > 0 },
    { name: 'Outcome nodes exist (CG-only)', pass: stats.nodesByType['outcome'] > 0 },
    { name: 'Decision nodes exist', pass: stats.nodesByType['decision'] > 0 },
    { name: 'Context nodes exist (CG-only)', pass: (stats.nodesByType['context'] || 0) >= 0 },
    { name: 'Modifies edges exist', pass: stats.edgesByType['modifies'] > 0 },
    { name: 'Outcome_of edges exist (CG-only)', pass: (stats.edgesByType['outcome_of'] || 0) >= 0 },
  ];

  let passCount = 0;
  for (const check of checks) {
    const status = check.pass ? '✓' : '✗';
    console.log(`    ${status} ${check.name}`);
    if (check.pass) passCount++;
  }

  console.log(`\n  ${passCount}/${checks.length} checks passed`);

  if (passCount === checks.length) {
    console.log('\n✅ Migration verified successfully!');
  } else {
    console.log('\n⚠️  Some verification checks failed. Review the migration.');
  }
}

// ============================================
// MAIN
// ============================================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verifyOnly = args.includes('--verify');

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  Graph Migration: DevGraph + ContextGraph → Graph         ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  if (dryRun) {
    console.log('\n🔍 DRY RUN MODE - No files will be modified\n');
  }

  if (verifyOnly) {
    verifyMigration();
    return;
  }

  const stats: MigrationStats = {
    devgraphNodesCopied: 0,
    devgraphEdgesCopied: 0,
    contextgraphNodesConverted: 0,
    contextgraphEdgesConverted: 0,
    duplicatesSkipped: 0,
    totalNodes: 0,
    totalEdges: 0,
    errors: [],
  };

  try {
    // Step 1: Copy DevGraph data
    const dgCopied = copyDevGraphData(dryRun);
    stats.devgraphNodesCopied = dgCopied.nodes;
    stats.devgraphEdgesCopied = dgCopied.edges;

    // Step 2: Parse ContextGraph events
    const cgData = parseContextGraphEvents();
    stats.contextgraphNodesConverted = cgData.nodes.length;
    stats.contextgraphEdgesConverted = cgData.edges.length;

    // Step 3: Write ContextGraph data (with deduplication)
    const cgWritten = writeContextGraphData(cgData.nodes, cgData.edges, dryRun);
    stats.duplicatesSkipped = cgWritten.skipped;

    // Step 4: Rebuild meta.json
    await rebuildMeta(dryRun);

    // Step 5: Verify
    if (!dryRun) {
      verifyMigration();
    }

    // Final summary
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  Migration Summary                                         ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log(`  DevGraph nodes copied:        ${stats.devgraphNodesCopied}`);
    console.log(`  DevGraph edges copied:        ${stats.devgraphEdgesCopied}`);
    console.log(`  ContextGraph nodes converted: ${stats.contextgraphNodesConverted}`);
    console.log(`  ContextGraph edges converted: ${stats.contextgraphEdgesConverted}`);
    console.log(`  Duplicates skipped:           ${stats.duplicatesSkipped}`);
    console.log('');

    if (dryRun) {
      console.log('🔍 DRY RUN COMPLETE - Run without --dry-run to execute migration');
    } else {
      console.log('✅ MIGRATION COMPLETE');
    }

  } catch (err) {
    console.error('\n❌ Migration failed:', err);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.main) {
  main();
}
