#!/usr/bin/env bun
/**
 * GraphVisualizer - Interactive Knowledge Graph Visualization
 *
 * Reads graph state from MEMORY/State/knowledge-graph.json and generates
 * a standalone HTML file with D3.js Canvas-based force-directed layout.
 * Handles 500+ nodes via Canvas rendering (not SVG DOM).
 *
 * CLI:
 *   bun GraphVisualizer.ts                              # Full graph, default 300 nodes
 *   bun GraphVisualizer.ts --folder "Statistics"        # Filter to folder
 *   bun GraphVisualizer.ts --tag "programming"          # Filter to tag
 *   bun GraphVisualizer.ts --cluster "cluster-id"       # Filter to cluster
 *   bun GraphVisualizer.ts --max-nodes 500              # Override node cap
 *   bun GraphVisualizer.ts --color-by cluster           # Color by cluster (default: folder)
 *   bun GraphVisualizer.ts --output /path/to/file.html  # Custom output path
 *   bun GraphVisualizer.ts --no-open                    # Don't auto-open browser
 *   bun GraphVisualizer.ts --include-tag-edges          # Include tag co-occurrence edges
 *   bun GraphVisualizer.ts --include-folder-edges       # Include folder co-membership edges
 */

import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { loadGraphState } from "./GraphBuilder";
import { loadSettings } from "../../../../lib/core/ConfigLoader";
import type { GraphState, GraphNode, GraphEdge, ConceptCluster, EdgeType } from "./types";

// ============================================
// CONSTANTS
// ============================================

const DEFAULT_STATE_PATH = join(
  process.env.HOME || "~",
  ".claude",
  "MEMORY",
  "State",
  "knowledge-graph.json"
);

const DEFAULT_OUTPUT_PATH = join(
  process.env.HOME || "~",
  "Downloads",
  "knowledge-graph-viz.html"
);

const DEFAULT_MAX_NODES = 300;
const DEFAULT_ALLOWED_EDGE_TYPES: EdgeType[] = ["wikilink", "embed"];

// ============================================
// TYPES
// ============================================

interface VisualizerOptions {
  statePath: string;
  outputPath: string;
  maxNodes: number;
  colorBy: "folder" | "cluster";
  folderFilter?: string;
  tagFilter?: string;
  clusterFilter?: string;
  allowedEdgeTypes: EdgeType[];
  autoOpen: boolean;
}

interface VizNode {
  id: string;
  title: string;
  folder: string;
  tags: string[];
  wordCount: number;
  connections: number;
  cluster?: string;
}

interface VizEdge {
  source: string;
  target: string;
  type: EdgeType;
  weight: number;
}

// ============================================
// ARGUMENT PARSING
// ============================================

function parseArgs(): VisualizerOptions {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
GraphVisualizer - Interactive Knowledge Graph Visualization

Usage:
  bun GraphVisualizer.ts [options]

Options:
  --folder <name>          Filter to nodes in this folder (prefix match)
  --tag <name>             Filter to nodes with this tag
  --cluster <id>           Filter to nodes in this cluster
  --max-nodes <n>          Maximum nodes to display (default: ${DEFAULT_MAX_NODES})
  --color-by <mode>        Color nodes by "folder" or "cluster" (default: folder)
  --output <path>          Output HTML path (default: ~/Downloads/knowledge-graph-viz.html)
  --state <path>           Graph state file path
  --no-open                Don't auto-open in browser
  --include-tag-edges      Include tag co-occurrence edges
  --include-folder-edges   Include folder co-membership edges
  --help                   Show this help
`);
    process.exit(0);
  }

  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
  };

  const edgeTypes: EdgeType[] = [...DEFAULT_ALLOWED_EDGE_TYPES];
  if (args.includes("--include-tag-edges")) edgeTypes.push("tag");
  if (args.includes("--include-folder-edges")) edgeTypes.push("folder");

  return {
    statePath: getArg("--state") || DEFAULT_STATE_PATH,
    outputPath: getArg("--output") || DEFAULT_OUTPUT_PATH,
    maxNodes: parseInt(getArg("--max-nodes") || String(DEFAULT_MAX_NODES), 10),
    colorBy: (getArg("--color-by") as "folder" | "cluster") || "folder",
    folderFilter: getArg("--folder"),
    tagFilter: getArg("--tag"),
    clusterFilter: getArg("--cluster"),
    allowedEdgeTypes: edgeTypes,
    autoOpen: !args.includes("--no-open"),
  };
}

// ============================================
// GRAPH FILTERING
// ============================================

function filterGraph(
  state: GraphState,
  options: VisualizerOptions
): { nodes: VizNode[]; edges: VizEdge[]; clusters: ConceptCluster[] } {
  // Build cluster membership lookup
  const nodeToCluster = new Map<string, string>();
  for (const cluster of state.clusters) {
    for (const nodeId of cluster.nodes) {
      nodeToCluster.set(nodeId, cluster.id);
    }
  }

  // Start with all nodes
  let filteredNodes = [...state.nodes];

  // Apply folder filter (prefix match for subfolders)
  if (options.folderFilter) {
    const prefix = options.folderFilter.toLowerCase();
    filteredNodes = filteredNodes.filter(
      (n) => n.folder.toLowerCase() === prefix || n.folder.toLowerCase().startsWith(prefix + "/")
    );
  }

  // Apply tag filter (exact match)
  if (options.tagFilter) {
    const tag = options.tagFilter.toLowerCase();
    filteredNodes = filteredNodes.filter((n) => n.tags.includes(tag));
  }

  // Apply cluster filter
  if (options.clusterFilter) {
    const clusterNodeIds = new Set<string>();
    const cluster = state.clusters.find((c) => c.id === options.clusterFilter);
    if (!cluster) {
      console.error(`Cluster "${options.clusterFilter}" not found.`);
      console.error("Available clusters:", state.clusters.map((c) => `${c.id} (${c.label})`).join(", ") || "none");
      process.exit(1);
    }
    for (const nodeId of cluster.nodes) clusterNodeIds.add(nodeId);
    filteredNodes = filteredNodes.filter((n) => clusterNodeIds.has(n.id));
  }

  if (filteredNodes.length === 0) {
    console.error("No nodes match the applied filters.");
    process.exit(1);
  }

  // Compute connection counts (wikilink + embed only for ranking)
  const connectionCounts = new Map<string, number>();
  for (const node of filteredNodes) {
    connectionCounts.set(node.id, node.outLinks.length + node.inLinks.length);
  }

  // Sort by connections desc, take top maxNodes
  filteredNodes.sort(
    (a, b) => (connectionCounts.get(b.id) || 0) - (connectionCounts.get(a.id) || 0)
  );
  filteredNodes = filteredNodes.slice(0, options.maxNodes);

  const survivingIds = new Set(filteredNodes.map((n) => n.id));

  // Build VizNodes
  const vizNodes: VizNode[] = filteredNodes.map((n) => ({
    id: n.id,
    title: n.title,
    folder: n.folder || "(root)",
    tags: n.tags,
    wordCount: n.wordCount,
    connections: connectionCounts.get(n.id) || 0,
    cluster: nodeToCluster.get(n.id),
  }));

  // Filter edges: both endpoints must survive AND type must be allowed
  const allowedSet = new Set(options.allowedEdgeTypes);
  const vizEdges: VizEdge[] = state.edges
    .filter(
      (e) =>
        survivingIds.has(e.source) &&
        survivingIds.has(e.target) &&
        allowedSet.has(e.type)
    )
    .map((e) => ({
      source: e.source,
      target: e.target,
      type: e.type,
      weight: e.weight,
    }));

  // Keep clusters with 2+ surviving nodes
  const clusterNodeCounts = new Map<string, number>();
  for (const node of vizNodes) {
    if (node.cluster) {
      clusterNodeCounts.set(node.cluster, (clusterNodeCounts.get(node.cluster) || 0) + 1);
    }
  }
  const vizClusters = state.clusters.filter(
    (c) => (clusterNodeCounts.get(c.id) || 0) >= 2
  );

  return { nodes: vizNodes, edges: vizEdges, clusters: vizClusters };
}

// ============================================
// HTML GENERATION
// ============================================

function generateHTML(
  nodes: VizNode[],
  edges: VizEdge[],
  clusters: ConceptCluster[],
  options: VisualizerOptions
): string {
  const dataBlob = JSON.stringify({ nodes, edges, clusters });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Knowledge Graph Visualization</title>
<script src="https://d3js.org/d3.v7.min.js"></script>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #1a1a2e; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; overflow: hidden; }
canvas { display: block; }
#controls {
  position: fixed; top: 16px; left: 16px; z-index: 10;
  background: rgba(26, 26, 46, 0.92); border: 1px solid #533483; border-radius: 8px;
  padding: 12px 16px; min-width: 220px; backdrop-filter: blur(8px);
}
#controls h2 { font-size: 14px; color: #93b8fa; margin-bottom: 8px; }
#search {
  width: 100%; padding: 6px 10px; background: #16213e; border: 1px solid #533483;
  border-radius: 4px; color: #e0e0e0; font-size: 13px; outline: none;
}
#search:focus { border-color: #93b8fa; }
#search::placeholder { color: #6a6a8a; }
#legend { margin-top: 10px; max-height: 300px; overflow-y: auto; }
.legend-item {
  display: flex; align-items: center; gap: 6px; padding: 2px 0; cursor: pointer;
  font-size: 12px; opacity: 0.9;
}
.legend-item:hover { opacity: 1; }
.legend-item.dimmed { opacity: 0.3; }
.legend-swatch { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.legend-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 170px; }
#stats {
  position: fixed; bottom: 16px; left: 16px; z-index: 10;
  background: rgba(26, 26, 46, 0.92); border: 1px solid #533483; border-radius: 8px;
  padding: 10px 14px; font-size: 12px; backdrop-filter: blur(8px);
}
#stats span { color: #93b8fa; }
#tooltip {
  position: fixed; z-index: 20; display: none; pointer-events: none;
  background: rgba(22, 33, 62, 0.95); border: 1px solid #533483; border-radius: 6px;
  padding: 10px 14px; font-size: 12px; max-width: 300px; backdrop-filter: blur(8px);
}
#tooltip .tt-title { font-size: 14px; font-weight: 600; color: #93b8fa; margin-bottom: 4px; }
#tooltip .tt-row { margin: 2px 0; color: #b0b0c0; }
#tooltip .tt-label { color: #7a7a9a; }
</style>
</head>
<body>
<canvas id="graph"></canvas>

<div id="controls">
  <h2>Knowledge Graph</h2>
  <input id="search" type="text" placeholder="Search nodes..." autocomplete="off">
  <div id="legend"></div>
</div>

<div id="stats">
  <span id="node-count">0</span> nodes &middot;
  <span id="edge-count">0</span> edges &middot;
  <span id="cluster-count">0</span> clusters
</div>

<div id="tooltip">
  <div class="tt-title"></div>
  <div class="tt-folder tt-row"></div>
  <div class="tt-tags tt-row"></div>
  <div class="tt-words tt-row"></div>
  <div class="tt-connections tt-row"></div>
</div>

<script>
// === DATA ===
const DATA = ${dataBlob};
const colorBy = "${options.colorBy}";

// === SETUP ===
const canvas = document.getElementById('graph');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
let width = window.innerWidth;
let height = window.innerHeight;
canvas.width = width;
canvas.height = height;

// === COLOR SCALE ===
const categories = new Set();
DATA.nodes.forEach(n => {
  categories.add(colorBy === 'cluster' ? (n.cluster || 'unclustered') : n.folder);
});
const categoryArr = [...categories].sort();
const color = d3.scaleOrdinal(d3.schemeTableau10).domain(categoryArr);

// === NODE SIZE ===
const maxConn = Math.max(1, d3.max(DATA.nodes, d => d.connections));
const nodeRadius = d => 4 + (d.connections / maxConn) * 12;

// === LEGEND ===
const legendEl = document.getElementById('legend');
const hiddenCategories = new Set();

function buildLegend() {
  legendEl.innerHTML = '';
  categoryArr.forEach(cat => {
    const item = document.createElement('div');
    item.className = 'legend-item' + (hiddenCategories.has(cat) ? ' dimmed' : '');
    const count = DATA.nodes.filter(n => (colorBy === 'cluster' ? (n.cluster || 'unclustered') : n.folder) === cat).length;
    item.innerHTML = '<div class="legend-swatch" style="background:' + color(cat) + '"></div>' +
      '<span class="legend-label">' + cat + ' (' + count + ')</span>';
    item.addEventListener('click', () => {
      if (hiddenCategories.has(cat)) hiddenCategories.delete(cat);
      else hiddenCategories.add(cat);
      item.classList.toggle('dimmed');
      draw();
    });
    legendEl.appendChild(item);
  });
}
buildLegend();

// === STATS ===
document.getElementById('node-count').textContent = DATA.nodes.length;
document.getElementById('edge-count').textContent = DATA.edges.length;
document.getElementById('cluster-count').textContent = DATA.clusters.length;

// === SIMULATION ===
const nodeMap = new Map();
DATA.nodes.forEach(n => nodeMap.set(n.id, n));

const simNodes = DATA.nodes.map(d => ({ ...d }));
const simNodeMap = new Map();
simNodes.forEach(n => simNodeMap.set(n.id, n));

const simLinks = DATA.edges
  .filter(e => simNodeMap.has(e.source) && simNodeMap.has(e.target))
  .map(e => ({ source: e.source, target: e.target, type: e.type, weight: e.weight }));

const simulation = d3.forceSimulation(simNodes)
  .force('link', d3.forceLink(simLinks).id(d => d.id).distance(60).strength(d => d.weight * 0.3))
  .force('charge', d3.forceManyBody().strength(-80).distanceMax(400))
  .force('center', d3.forceCenter(width / 2, height / 2))
  .force('collision', d3.forceCollide().radius(d => nodeRadius(d) + 2))
  .alphaDecay(0.02)
  .on('tick', draw);

// === TRANSFORM (zoom/pan) ===
let transform = d3.zoomIdentity;
const zoom = d3.zoom()
  .scaleExtent([0.1, 8])
  .on('zoom', e => { transform = e.transform; draw(); });
d3.select(canvas).call(zoom);

// === INTERACTION STATE ===
let hoveredNode = null;
let selectedNode = null;
let searchTerm = '';
let dragNode = null;

// === QUADTREE FOR HIT TESTING ===
function findNode(mx, my) {
  const [x, y] = transform.invert([mx, my]);
  let found = null;
  let minDist = Infinity;
  for (const n of simNodes) {
    const r = nodeRadius(n);
    const dx = n.x - x;
    const dy = n.y - y;
    const dist = dx * dx + dy * dy;
    if (dist < (r + 4) * (r + 4) && dist < minDist) {
      minDist = dist;
      found = n;
    }
  }
  return found;
}

// === DRAW ===
function draw() {
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.translate(transform.x, transform.y);
  ctx.scale(transform.k, transform.k);

  const selectedNeighbors = new Set();
  if (selectedNode) {
    simLinks.forEach(l => {
      const sid = typeof l.source === 'object' ? l.source.id : l.source;
      const tid = typeof l.target === 'object' ? l.target.id : l.target;
      if (sid === selectedNode.id) selectedNeighbors.add(tid);
      if (tid === selectedNode.id) selectedNeighbors.add(sid);
    });
    selectedNeighbors.add(selectedNode.id);
  }

  const searchMatches = new Set();
  if (searchTerm) {
    const lower = searchTerm.toLowerCase();
    simNodes.forEach(n => {
      if (n.title.toLowerCase().includes(lower) || n.id.toLowerCase().includes(lower)) {
        searchMatches.add(n.id);
      }
    });
  }

  // Draw edges
  for (const link of simLinks) {
    const s = typeof link.source === 'object' ? link.source : simNodeMap.get(link.source);
    const t = typeof link.target === 'object' ? link.target : simNodeMap.get(link.target);
    if (!s || !t) continue;

    const sCat = colorBy === 'cluster' ? (s.cluster || 'unclustered') : s.folder;
    const tCat = colorBy === 'cluster' ? (t.cluster || 'unclustered') : t.folder;
    if (hiddenCategories.has(sCat) || hiddenCategories.has(tCat)) continue;

    let alpha = link.weight * 0.4;
    if (selectedNode) {
      alpha = selectedNeighbors.has(s.id) && selectedNeighbors.has(t.id) ? 0.6 : 0.04;
    }
    if (searchTerm) {
      alpha = searchMatches.has(s.id) || searchMatches.has(t.id) ? 0.6 : 0.04;
    }

    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(t.x, t.y);
    ctx.strokeStyle = 'rgba(147, 184, 250, ' + alpha + ')';
    ctx.lineWidth = link.type === 'tag' || link.type === 'folder' ? 0.5 : 1;
    if (link.type === 'embed') ctx.setLineDash([4, 4]);
    else ctx.setLineDash([]);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Draw nodes
  for (const node of simNodes) {
    const cat = colorBy === 'cluster' ? (node.cluster || 'unclustered') : node.folder;
    if (hiddenCategories.has(cat)) continue;

    const r = nodeRadius(node);
    let alpha = 1;
    if (selectedNode && !selectedNeighbors.has(node.id)) alpha = 0.1;
    if (searchTerm && !searchMatches.has(node.id)) alpha = 0.1;

    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    const c = d3.color(color(cat));
    ctx.fillStyle = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + alpha + ')';
    ctx.fill();

    if (node === hoveredNode || node === selectedNode) {
      ctx.strokeStyle = '#93b8fa';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Draw label for large or highlighted nodes
    if ((r > 8 || node === hoveredNode || node === selectedNode || (searchTerm && searchMatches.has(node.id))) && alpha > 0.3) {
      ctx.fillStyle = 'rgba(224, 224, 224, ' + alpha + ')';
      ctx.font = '10px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(node.title.slice(0, 30), node.x, node.y - r - 4);
    }
  }

  ctx.restore();
}

// === MOUSE EVENTS ===
canvas.addEventListener('mousemove', e => {
  const node = findNode(e.clientX, e.clientY);
  hoveredNode = node;
  canvas.style.cursor = node ? 'pointer' : 'default';

  if (node) {
    tooltip.style.display = 'block';
    tooltip.style.left = (e.clientX + 14) + 'px';
    tooltip.style.top = (e.clientY + 14) + 'px';
    tooltip.querySelector('.tt-title').textContent = node.title;
    tooltip.querySelector('.tt-folder').innerHTML = '<span class="tt-label">Folder:</span> ' + node.folder;
    tooltip.querySelector('.tt-tags').innerHTML = '<span class="tt-label">Tags:</span> ' + (node.tags.length ? node.tags.map(t => '#' + t).join(', ') : 'none');
    tooltip.querySelector('.tt-words').innerHTML = '<span class="tt-label">Words:</span> ' + node.wordCount.toLocaleString();
    tooltip.querySelector('.tt-connections').innerHTML = '<span class="tt-label">Connections:</span> ' + node.connections;
  } else {
    tooltip.style.display = 'none';
  }

  if (dragNode) {
    const [x, y] = transform.invert([e.clientX, e.clientY]);
    dragNode.fx = x;
    dragNode.fy = y;
    simulation.alpha(0.1).restart();
  }

  draw();
});

canvas.addEventListener('mousedown', e => {
  const node = findNode(e.clientX, e.clientY);
  if (node) {
    dragNode = node;
    dragNode.fx = node.x;
    dragNode.fy = node.y;
  }
});

canvas.addEventListener('mouseup', () => {
  if (dragNode) {
    dragNode.fx = null;
    dragNode.fy = null;
    dragNode = null;
    simulation.alpha(0.1).restart();
  }
});

canvas.addEventListener('click', e => {
  if (dragNode) return; // Ignore clicks during drag
  const node = findNode(e.clientX, e.clientY);
  if (node) {
    selectedNode = selectedNode === node ? null : node;
  } else {
    selectedNode = null;
  }
  draw();
});

// === SEARCH ===
document.getElementById('search').addEventListener('input', e => {
  searchTerm = e.target.value.trim();
  selectedNode = null;
  draw();
});

// === RESIZE ===
window.addEventListener('resize', () => {
  width = window.innerWidth;
  height = window.innerHeight;
  canvas.width = width;
  canvas.height = height;
  simulation.force('center', d3.forceCenter(width / 2, height / 2));
  simulation.alpha(0.3).restart();
});
</script>
</body>
</html>`;
}

// ============================================
// BROWSER OPEN
// ============================================

function openInBrowser(filePath: string): void {
  let browser = "Safari";
  try {
    const settings = loadSettings();
    if (settings.techStack?.browser) {
      browser = settings.techStack.browser;
    }
  } catch {
    // Fall back to Safari
  }
  spawn("open", ["-a", browser, filePath], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

// ============================================
// MAIN
// ============================================

async function main() {
  const options = parseArgs();

  // Validate state file exists
  if (!existsSync(options.statePath)) {
    console.error(`Graph state not found at: ${options.statePath}`);
    console.error('Run "bun Tools/GraphBuilder.ts --rebuild" first.');
    process.exit(1);
  }

  // Validate cluster color mode
  const state = await loadGraphState(options.statePath);

  if (state.nodes.length === 0) {
    console.error("Graph state is empty. Run --rebuild first.");
    process.exit(1);
  }

  if (options.colorBy === "cluster" && state.clusters.length === 0) {
    console.warn("No clusters found, falling back to folder coloring.");
    console.warn('Run "bun Tools/ClusterAnalyzer.ts --analyze" to generate clusters.');
    options.colorBy = "folder";
  }

  // Check staleness
  const builtAt = new Date(state.built).getTime();
  const hoursOld = (Date.now() - builtAt) / (1000 * 60 * 60);
  if (hoursOld > state.ttl) {
    console.warn(`Graph state is ${hoursOld.toFixed(0)}h old (TTL: ${state.ttl}h). Consider rebuilding.`);
  }

  // Filter and prepare data
  const { nodes, edges, clusters } = filterGraph(state, options);

  console.log(`Filtered: ${nodes.length} nodes, ${edges.length} edges, ${clusters.length} clusters`);

  if (options.folderFilter) console.log(`  Folder filter: "${options.folderFilter}"`);
  if (options.tagFilter) console.log(`  Tag filter: "${options.tagFilter}"`);
  if (options.clusterFilter) console.log(`  Cluster filter: "${options.clusterFilter}"`);
  console.log(`  Edge types: ${options.allowedEdgeTypes.join(", ")}`);
  console.log(`  Color by: ${options.colorBy}`);

  // Generate HTML
  const html = generateHTML(nodes, edges, clusters, options);
  writeFileSync(options.outputPath, html, "utf-8");
  console.log(`\nVisualization written to: ${options.outputPath}`);

  // Open in browser
  if (options.autoOpen) {
    openInBrowser(options.outputPath);
    console.log("Opened in browser.");
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
