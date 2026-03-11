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
  skillExists,
  ensureMemoryDirectories,
} from './utils';
import type { Finding, Recommendation, DimensionResult } from './report-builder';
import { buildDimensionResult } from './report-builder';

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

export interface DependencyGraph {
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

// ============================================================================
// Scoring Function — Dimension 3: Integration Fitness (deterministic half)
// ============================================================================

/**
 * Score Integration Fitness for a skill based on dependency graph analysis.
 * Returns partial DimensionResult — IntegrationOpportunityFinder covers inferential half.
 */
export function scoreIntegrationFitness(skillName: string): DimensionResult | null {
  if (!skillExists(skillName)) {
    return null;
  }

  const skillMdPath = join(getSkillPath(skillName), 'SKILL.md');
  const content = safeReadFile(skillMdPath);
  const deps = extractDependenciesFromContent(content);

  // Scan all other skills to compute hub degree (incoming references)
  const allSkills = getSkillDirectories();
  let hubDegree = 0;

  for (const otherSkill of allSkills) {
    if (otherSkill === skillName) continue;
    const otherPath = join(getSkillPath(otherSkill), 'SKILL.md');
    const otherContent = safeReadFile(otherPath);
    const otherDeps = extractDependenciesFromContent(otherContent);
    if (otherDeps.uses.includes(skillName) || otherDeps.feedsInto.includes(skillName)) {
      hubDegree++;
    }
  }

  let score = 10;
  const findings: Finding[] = [];
  const recommendations: Recommendation[] = [];

  // -3 if isolated (zero uses + zero feedsInto)
  if (deps.uses.length === 0 && deps.feedsInto.length === 0) {
    score -= 3;
    findings.push({
      description: 'Skill declares no Uses or Feeds Into dependencies — isolated in graph',
      severity: 'HIGH',
    });

    // -2 if truly orphaned (also zero hub degree)
    if (hubDegree === 0) {
      score -= 2;
      findings.push({
        description: 'No other skill references this skill — truly orphaned in dependency graph',
        severity: 'HIGH',
      });
      recommendations.push({
        action: 'Declare Uses/Feeds Into in SKILL.md or investigate if skill should be deprecated',
        priority: 'P2',
        effort: 'S',
        impact: 'MEDIUM',
        dimension: 'integrationFitness',
      });
    }
  }

  // -1 if excessive hub (>8 incoming)
  if (hubDegree > 8) {
    score -= 1;
    findings.push({
      description: `Excessive hub degree: ${hubDegree} skills depend on this skill — risk of coupling`,
      severity: 'MEDIUM',
    });
    recommendations.push({
      action: 'Consider splitting responsibility — too many skills depend on this one',
      priority: 'P3',
      effort: 'M',
      impact: 'LOW',
      dimension: 'integrationFitness',
    });
  }

  // -0.5 if one-directional (has uses but no feedsInto, or vice versa)
  if (
    (deps.uses.length > 0 && deps.feedsInto.length === 0) ||
    (deps.uses.length === 0 && deps.feedsInto.length > 0)
  ) {
    score -= 0.5;
    findings.push({
      description: 'One-directional dependency: skill only uses or only feeds into other skills',
      severity: 'LOW',
    });
  }

  if (findings.length === 0) {
    findings.push({
      description: `Well-integrated: ${deps.uses.length} uses, ${deps.feedsInto.length} feeds into, ${hubDegree} incoming refs`,
      severity: 'LOW',
    });
  }

  return buildDimensionResult(score, findings, recommendations, true);
}

// Run CLI if executed directly
if (import.meta.main) {
  main();
}
