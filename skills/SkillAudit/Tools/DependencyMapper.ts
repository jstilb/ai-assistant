#!/usr/bin/env bun
/**
 * DependencyMapper - Generate skill dependency graph
 *
 * Analyzes SKILL.md files to extract "Uses" and "Feeds Into"
 * relationships, generating a dependency map.
 *
 * Usage:
 *   bun run DependencyMapper.ts [--format json|markdown|mermaid]
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { SKILLS_DIR } from './constants';
import {
  getSkillDirectories,
  getSkillPath,
  safeReadFile,
  ensureMemoryDirectories,
} from './utils';

interface SkillNodeDependencies {
  name: string;
  uses: string[];
  feedsInto: string[];
}

/**
 * Extracted dependency information from a SKILL.md file.
 * This is the canonical implementation - import this in other tools.
 */
export interface SkillDependencies {
  uses: string[];
  feedsInto: string[];
  mcps: string[];
  externalDeps: string[];
}

/**
 * Extract dependency information from SKILL.md content.
 *
 * Canonical implementation used by DependencyMapper and SkillInventory.
 * Parses Uses, Feeds Into, and MCP sections from markdown content.
 */
export function extractDependenciesFromContent(content: string | null): SkillDependencies {
  const result: SkillDependencies = {
    uses: [],
    feedsInto: [],
    mcps: [],
    externalDeps: [],
  };

  if (!content) return result;

  // Extract "Uses" section
  const usesMatch = content.match(/###?\s*Uses\s*\n([\s\S]*?)(?=\n###?|\n---|\n##|$)/i);
  if (usesMatch) {
    const skillRefs = usesMatch[1].match(/\*\*([A-Za-z]+)\*\*/g);
    if (skillRefs) {
      result.uses = [...new Set(skillRefs.map(ref => ref.replace(/\*\*/g, '')))];
    }
  }

  // Extract "Feeds Into" section
  const feedsMatch = content.match(/###?\s*Feeds\s*Into\s*\n([\s\S]*?)(?=\n###?|\n---|\n##|$)/i);
  if (feedsMatch) {
    const skillRefs = feedsMatch[1].match(/\*\*([A-Za-z]+)\*\*/g);
    if (skillRefs) {
      result.feedsInto = [...new Set(skillRefs.map(ref => ref.replace(/\*\*/g, '')))];
    }
  }

  // Extract MCP references
  const mcpMatches = content.match(/mcp__[a-z_]+/gi);
  if (mcpMatches) {
    result.mcps = [...new Set(mcpMatches.map(m => m.toLowerCase()))];
  }

  // Extract MCPs Used section
  const mcpsSection = content.match(/###?\s*MCPs\s*Used\s*\n([\s\S]*?)(?=\n###?|\n---|\n##|$)/i);
  if (mcpsSection) {
    const mcpRefs = mcpsSection[1].match(/mcp__[a-z_]+/gi);
    if (mcpRefs) {
      result.mcps = [...new Set([...result.mcps, ...mcpRefs.map(m => m.toLowerCase())])];
    }
  }

  return result;
}

interface DependencyGraph {
  nodes: string[];
  edges: Array<{ from: string; to: string; type: 'uses' | 'feeds' }>;
  hubs: string[];
  leaves: string[];
  isolated: string[];
}

function extractNodeDependencies(skillPath: string, skillName: string): SkillNodeDependencies {
  const skillMdPath = join(skillPath, 'SKILL.md');
  const content = safeReadFile(skillMdPath);

  if (!content) {
    return { name: skillName, uses: [], feedsInto: [] };
  }

  // Use the canonical extractDependenciesFromContent and filter out self-references
  const deps = extractDependenciesFromContent(content);

  return {
    name: skillName,
    uses: deps.uses.filter(name => name !== skillName),
    feedsInto: deps.feedsInto.filter(name => name !== skillName),
  };
}

function buildGraph(dependencies: SkillNodeDependencies[]): DependencyGraph {
  const nodes = dependencies.map(d => d.name);
  const edges: Array<{ from: string; to: string; type: 'uses' | 'feeds' }> = [];

  // Count connections per node
  const inDegree: Record<string, number> = {};
  const outDegree: Record<string, number> = {};

  for (const node of nodes) {
    inDegree[node] = 0;
    outDegree[node] = 0;
  }

  for (const dep of dependencies) {
    for (const used of dep.uses) {
      edges.push({ from: dep.name, to: used, type: 'uses' });
      outDegree[dep.name]++;
      if (inDegree[used] !== undefined) {
        inDegree[used]++;
      }
    }
    for (const feeds of dep.feedsInto) {
      edges.push({ from: dep.name, to: feeds, type: 'feeds' });
      outDegree[dep.name]++;
      if (inDegree[feeds] !== undefined) {
        inDegree[feeds]++;
      }
    }
  }

  // Classify nodes
  const hubs: string[] = [];
  const leaves: string[] = [];
  const isolated: string[] = [];

  for (const node of nodes) {
    const totalConnections = (inDegree[node] || 0) + (outDegree[node] || 0);
    if (totalConnections === 0) {
      isolated.push(node);
    } else if (totalConnections >= 3) {
      hubs.push(node);
    } else if (outDegree[node] === 0 && inDegree[node] > 0) {
      leaves.push(node);
    }
  }

  return { nodes, edges, hubs, leaves, isolated };
}

function outputMarkdown(graph: DependencyGraph): void {
  console.log('# Skill Dependency Map\n');
  console.log(`Generated: ${new Date().toISOString()}\n`);

  console.log('## Summary\n');
  console.log(`- **Total skills:** ${graph.nodes.length}`);
  console.log(`- **Total connections:** ${graph.edges.length}`);
  console.log(`- **Hub skills (3+ connections):** ${graph.hubs.length}`);
  console.log(`- **Isolated skills (0 connections):** ${graph.isolated.length}`);
  console.log('');

  console.log('## Hub Skills\n');
  console.log('Skills with many connections (central to ecosystem):\n');
  for (const hub of graph.hubs) {
    const uses = graph.edges.filter(e => e.from === hub);
    const usedBy = graph.edges.filter(e => e.to === hub);
    console.log(`- **${hub}** - Uses ${uses.length}, Used by ${usedBy.length}`);
  }
  console.log('');

  console.log('## Isolated Skills\n');
  console.log('Skills with no declared dependencies:\n');
  for (const isolated of graph.isolated) {
    console.log(`- ${isolated}`);
  }
  console.log('');

  console.log('## All Dependencies\n');
  console.log('| From | To | Type |');
  console.log('|------|-----|------|');
  for (const edge of graph.edges) {
    console.log(`| ${edge.from} | ${edge.to} | ${edge.type} |`);
  }
}

function outputMermaid(graph: DependencyGraph): void {
  console.log('```mermaid');
  console.log('graph LR');

  // Style hub nodes
  for (const hub of graph.hubs) {
    console.log(`  ${hub}[["${hub}"]]`);
  }

  // Style isolated nodes
  for (const isolated of graph.isolated) {
    console.log(`  ${isolated}(("${isolated}"))`);
  }

  // Draw edges
  for (const edge of graph.edges) {
    const arrow = edge.type === 'uses' ? '-->' : '==>';
    console.log(`  ${edge.from} ${arrow} ${edge.to}`);
  }

  console.log('```');
}

function outputJson(graph: DependencyGraph): void {
  console.log(JSON.stringify(graph, null, 2));
}

function main(): void {
  const args = process.argv.slice(2);
  const formatArg = args.indexOf('--format');
  const format = formatArg >= 0 ? args[formatArg + 1] : 'markdown';

  // Ensure MEMORY directories exist
  ensureMemoryDirectories();

  // Get all skill directories using utility
  const skillDirs = getSkillDirectories();

  // Extract dependencies from each skill
  const dependencies: SkillNodeDependencies[] = [];

  for (const skillName of skillDirs) {
    const skillPath = getSkillPath(skillName);
    const deps = extractNodeDependencies(skillPath, skillName);
    dependencies.push(deps);
  }

  // Build graph
  const graph = buildGraph(dependencies);

  // Output in requested format
  switch (format) {
    case 'json':
      outputJson(graph);
      break;
    case 'mermaid':
      outputMermaid(graph);
      break;
    default:
      outputMarkdown(graph);
  }
}

main();
