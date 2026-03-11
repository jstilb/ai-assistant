#!/usr/bin/env bun
/**
 * IntegrationOpportunityFinder - Cross-reference skill against catalog and hook lifecycle
 *
 * Scores Dimension 3: Integration Fitness (inferential half).
 * Collects deterministic data about existing connections, hook references,
 * and hook lifecycle opportunities. The LLM evaluation layer uses this
 * structured output to complete the full inferential dimension scoring.
 *
 * Usage:
 *   bun run IntegrationOpportunityFinder.ts <skill-name>
 *   bun run IntegrationOpportunityFinder.ts Browser
 *   bun run IntegrationOpportunityFinder.ts Browser --json
 */

import { join, basename } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { SKILLS_DIR, SETTINGS_PATH, HOOKS_DIR, HOOK_EVENTS, EXPECTED_CONNECTIONS, SCORING } from './constants';
import { getSkillDirectories, getSkillPath, getSkillFiles, safeReadFile, skillExists } from './utils';
import { extractDependenciesFromContent } from './DependencyMapper';
import type { Finding, Recommendation, DimensionResult } from './report-builder';
import { buildDimensionResult } from './report-builder';

// ============================================================================
// Types
// ============================================================================

export interface IntegrationResult {
  skillName: string;
  score: number;
  dimensionResult: DimensionResult;
  details: {
    existingConnections: { uses: string[]; feedsInto: string[]; usedBy: string[] };
    hookReferences: string[];
    hookOpportunities: string[];
    totalExisting: number;
    totalPotential: number;
  };
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Build a reference map of all skills and their declared dependencies.
 * Returns a map of skillName -> { uses, feedsInto }.
 */
function buildSkillReferenceMap(): Map<string, { uses: string[]; feedsInto: string[] }> {
  const map = new Map<string, { uses: string[]; feedsInto: string[] }>();
  const allSkills = getSkillDirectories();

  for (const skillName of allSkills) {
    const skillMdPath = join(getSkillPath(skillName), 'SKILL.md');
    const content = safeReadFile(skillMdPath);
    const deps = extractDependenciesFromContent(content);
    map.set(skillName, { uses: deps.uses, feedsInto: deps.feedsInto });
  }

  return map;
}

/**
 * Find all skills that declare a dependency on the target skill.
 * Checks both "uses" and "feedsInto" declarations from other skills.
 */
function findUsedBySkills(targetSkill: string, referenceMap: Map<string, { uses: string[]; feedsInto: string[] }>): string[] {
  const usedBy: string[] = [];

  for (const [skillName, deps] of referenceMap) {
    if (skillName === targetSkill) continue;
    const refsTarget = deps.uses.includes(targetSkill) || deps.feedsInto.includes(targetSkill);
    if (refsTarget) {
      usedBy.push(skillName);
    }
  }

  return usedBy;
}

/**
 * Check settings.json for hook entries that reference the target skill.
 */
function findHookReferences(skillName: string): string[] {
  const references: string[] = [];
  const content = safeReadFile(SETTINGS_PATH);
  if (!content) return references;

  // Case-insensitive search for skill name in hooks sections
  const lowerSkill = skillName.toLowerCase();
  const lowerContent = content.toLowerCase();

  // Check if hooks section references this skill by name
  if (lowerContent.includes(lowerSkill)) {
    // Verify it's actually in a hooks-related context
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const hooks = parsed['hooks'];
      if (hooks && typeof hooks === 'object') {
        const hooksStr = JSON.stringify(hooks).toLowerCase();
        if (hooksStr.includes(lowerSkill)) {
          references.push('settings.json hooks section');
        }
      }
    } catch {
      // JSON parse failed — fall back to string search
      const hooksMatch = content.match(/"hooks"\s*:\s*\{[\s\S]*?\}/);
      if (hooksMatch && hooksMatch[0].toLowerCase().includes(lowerSkill)) {
        references.push('settings.json hooks section');
      }
    }
  }

  return references;
}

/**
 * Check hooks/ directory for shell scripts or config files referencing the skill.
 */
function findHooksDirReferences(skillName: string): string[] {
  const references: string[] = [];

  if (!existsSync(HOOKS_DIR)) return references;

  const lowerSkill = skillName.toLowerCase();

  try {
    const entries = readdirSync(HOOKS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const filePath = join(HOOKS_DIR, entry.name);
        const content = safeReadFile(filePath);
        if (content && content.toLowerCase().includes(lowerSkill)) {
          references.push(`hooks/${entry.name}`);
        }
      }
    }
  } catch {
    // Ignore read errors
  }

  return references;
}

/**
 * Check settings.json mcpServers key for references to the skill.
 */
function findMcpReferences(skillName: string): string[] {
  const references: string[] = [];
  const content = safeReadFile(SETTINGS_PATH);
  if (!content) return references;

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const mcpServers = parsed['mcpServers'];
    if (mcpServers && typeof mcpServers === 'object') {
      const mcpStr = JSON.stringify(mcpServers).toLowerCase();
      if (mcpStr.includes(skillName.toLowerCase())) {
        references.push('settings.json mcpServers section');
      }
    }
  } catch {
    // Ignore parse failures
  }

  return references;
}

/**
 * Identify hook lifecycle events that could benefit this skill based on its purpose.
 * Analyzes SKILL.md content for patterns that suggest hook utility.
 */
function identifyHookOpportunities(skillName: string, existingHookRefs: string[]): string[] {
  const opportunities: string[] = [];

  // If hooks already exist, fewer new opportunities
  const hasHooks = existingHookRefs.length > 0;

  const skillMdPath = join(getSkillPath(skillName), 'SKILL.md');
  const content = safeReadFile(skillMdPath);
  if (!content) return opportunities;

  const lowerContent = content.toLowerCase();

  // SessionStart: skills about initialization, context loading, state setup
  if (!hasHooks && (
    lowerContent.includes('session') ||
    lowerContent.includes('context') ||
    lowerContent.includes('initialize') ||
    lowerContent.includes('startup')
  )) {
    opportunities.push('SessionStart — could auto-initialize context or load state');
  }

  // UserPromptSubmit: skills about routing, classification, or pre-processing
  if (!hasHooks && (
    lowerContent.includes('routing') ||
    lowerContent.includes('classif') ||
    lowerContent.includes('dispatch') ||
    lowerContent.includes('trigger')
  )) {
    opportunities.push('UserPromptSubmit — could pre-classify or enrich incoming prompts');
  }

  // PreToolUse / PostToolUse: skills about logging, validation, or audit
  if (
    lowerContent.includes('log') ||
    lowerContent.includes('audit') ||
    lowerContent.includes('validat') ||
    lowerContent.includes('monitor')
  ) {
    if (!hasHooks) {
      opportunities.push('PreToolUse / PostToolUse — could instrument tool calls for logging or validation');
    }
  }

  // Stop / SubagentStop: skills about persistence, summary, or notification
  if (
    lowerContent.includes('persist') ||
    lowerContent.includes('summar') ||
    lowerContent.includes('notif') ||
    lowerContent.includes('save') ||
    lowerContent.includes('write')
  ) {
    if (!hasHooks) {
      opportunities.push('Stop / SubagentStop — could persist state or send completion notifications');
    }
  }

  // SessionEnd: skills about cleanup, archival, or reporting
  if (!hasHooks && (
    lowerContent.includes('cleanup') ||
    lowerContent.includes('archive') ||
    lowerContent.includes('report') ||
    lowerContent.includes('memory')
  )) {
    opportunities.push('SessionEnd — could archive session state or write memory entries');
  }

  return opportunities;
}

/**
 * Identify CORE tools that this skill could leverage but doesn't reference.
 * Scans lib/core/ for shared utilities and checks if the skill imports them.
 */
function findMissedCoreToolIntegrations(skillName: string): string[] {
  const missed: string[] = [];
  const coreToolsDir = join(SKILLS_DIR, 'CORE', 'Tools');

  if (!existsSync(coreToolsDir)) return missed;

  // Collect CORE tool names
  let coreToolNames: string[];
  try {
    coreToolNames = readdirSync(coreToolsDir)
      .filter(f => f.endsWith('.ts'))
      .map(f => basename(f, '.ts'));
  } catch {
    return missed;
  }

  if (coreToolNames.length === 0) return missed;

  // Read all tool files in the target skill to check for CORE imports
  const files = getSkillFiles(skillName);
  let combinedContent = '';
  for (const toolPath of files.tools) {
    const content = safeReadFile(toolPath);
    if (content) combinedContent += content + '\n';
  }

  // Also check SKILL.md for references
  const skillMdPath = join(getSkillPath(skillName), 'SKILL.md');
  const skillMdContent = safeReadFile(skillMdPath);
  if (skillMdContent) combinedContent += skillMdContent;

  const lowerCombined = combinedContent.toLowerCase();

  // Key CORE tools that most skills should consider
  const highValueCoreTools = ['StateManager', 'NotificationService', 'CachedHTTPClient'];

  for (const coreTool of highValueCoreTools) {
    if (coreToolNames.includes(coreTool) && !lowerCombined.includes(coreTool.toLowerCase())) {
      // Check if this CORE tool would be relevant based on skill behavior
      if (coreTool === 'StateManager' && (lowerCombined.includes('json') || lowerCombined.includes('state'))) {
        missed.push(`../lib/core/${coreTool}.ts — skill handles JSON/state but doesn't use StateManager`);
      } else if (coreTool === 'NotificationService' && (lowerCombined.includes('notif') || lowerCombined.includes('alert'))) {
        missed.push(`../lib/core/${coreTool}.ts — skill has notification needs but doesn't use NotificationService`);
      } else if (coreTool === 'CachedHTTPClient' && lowerCombined.includes('fetch')) {
        missed.push(`../lib/core/${coreTool}.ts — skill makes HTTP requests but doesn't use CachedHTTPClient`);
      }
    }
  }

  return missed;
}

/**
 * Main analysis function — collect all integration data and compute dimension score.
 */
export function findIntegrationOpportunities(skillName: string): IntegrationResult | null {
  if (!skillExists(skillName)) {
    return null;
  }

  // 1. Load this skill's declared dependencies
  const skillMdPath = join(getSkillPath(skillName), 'SKILL.md');
  const skillMdContent = safeReadFile(skillMdPath);
  const ownDeps = extractDependenciesFromContent(skillMdContent);

  // 2. Build full reference map and find used-by relationships
  const referenceMap = buildSkillReferenceMap();
  const usedBy = findUsedBySkills(skillName, referenceMap);

  // 3. Check hook references (settings.json + hooks/ directory)
  const settingsHookRefs = findHookReferences(skillName);
  const hooksDirRefs = findHooksDirReferences(skillName);
  const allHookRefs = [...settingsHookRefs, ...hooksDirRefs];

  // 4. Identify hook opportunities
  const hookOpportunities = identifyHookOpportunities(skillName, allHookRefs);

  // 4.5. Check MCP references in settings.json
  const mcpRefs = findMcpReferences(skillName);
  allHookRefs.push(...mcpRefs);

  // 4.6. Check for missed CORE tool integrations
  const missedCoreTools = findMissedCoreToolIntegrations(skillName);

  // 5. Compute weighted connection counts
  const W = SCORING.integrationFitness;

  // Identify bidirectional dependencies (appears in both Uses and usedBy)
  const usesSet = new Set(ownDeps.uses);
  const bidirectionalCount = usedBy.filter(s => usesSet.has(s)).length;
  const unidirectionalUsesCount = ownDeps.uses.length - bidirectionalCount;
  const unidirectionalUsedByCount = usedBy.length - bidirectionalCount;

  const weightedConnections =
    allHookRefs.length * W.hookWeight +
    bidirectionalCount * W.bidirectionalDepWeight +
    unidirectionalUsesCount * W.usesWeight +
    unidirectionalUsedByCount * W.usedByWeight +
    mcpRefs.length * W.mcpWeight;

  const existingConnections = ownDeps.uses.length + ownDeps.feedsInto.length + usedBy.length + allHookRefs.length;
  const totalSkills = referenceMap.size;
  const totalPotential = Math.max(
    (totalSkills - 1) * 2 + HOOK_EVENTS.length,
    1
  );

  // 6. Score: weighted ratio against expected baseline, floored at 1, capped at 10
  const avgWeight = 1.2; // approximate average weight across connection types
  const weightedPotential = EXPECTED_CONNECTIONS * avgWeight;
  const rawScore = (weightedConnections / weightedPotential) * 10;
  const score = Math.min(10, Math.max(1, Math.round(rawScore * 10) / 10));

  // 7. Build findings and recommendations
  const findings: Finding[] = [];
  const recommendations: Recommendation[] = [];

  if (existingConnections === 0) {
    findings.push({
      description: 'Skill has no declared connections to other skills or hooks',
      severity: 'HIGH',
    });
    recommendations.push({
      action: 'Declare Uses/Feeds Into relationships in SKILL.md and consider hook integration',
      priority: 'P2',
      effort: 'S',
      impact: 'MEDIUM',
      dimension: 'integrationFitness',
    });
  } else if (ownDeps.uses.length === 0 && ownDeps.feedsInto.length === 0) {
    findings.push({
      description: `Skill is referenced by ${usedBy.length} other skill(s) but declares no outbound connections`,
      severity: 'MEDIUM',
    });
    recommendations.push({
      action: 'Add Uses/Feeds Into sections to SKILL.md to document integration contracts',
      priority: 'P3',
      effort: 'S',
      impact: 'LOW',
      dimension: 'integrationFitness',
    });
  }

  if (allHookRefs.length === 0 && hookOpportunities.length > 0) {
    findings.push({
      description: `${hookOpportunities.length} hook lifecycle event(s) could benefit this skill but none are wired`,
      severity: 'LOW',
    });
    recommendations.push({
      action: `Evaluate hook integration: ${hookOpportunities[0]}`,
      priority: 'P3',
      effort: 'M',
      impact: 'LOW',
      dimension: 'integrationFitness',
    });
  }

  if (usedBy.length > 0 && ownDeps.feedsInto.length === 0) {
    findings.push({
      description: `${usedBy.length} skill(s) reference this skill but Feeds Into is undeclared: ${usedBy.join(', ')}`,
      location: `${skillName}/SKILL.md`,
      severity: 'LOW',
    });
    recommendations.push({
      action: `Add "### Feeds Into" section listing: ${usedBy.join(', ')}`,
      priority: 'P3',
      effort: 'S',
      impact: 'LOW',
      dimension: 'integrationFitness',
    });
  }

  if (missedCoreTools.length > 0) {
    findings.push({
      description: `${missedCoreTools.length} CORE tool(s) could be leveraged but are not referenced`,
      severity: 'MEDIUM',
    });
    for (const missed of missedCoreTools) {
      recommendations.push({
        action: `Consider using ${missed}`,
        priority: 'P3',
        effort: 'S',
        impact: 'MEDIUM',
        dimension: 'integrationFitness',
      });
    }
  }

  const dimensionResult = buildDimensionResult(score, findings, recommendations);

  return {
    skillName,
    score,
    dimensionResult,
    details: {
      existingConnections: {
        uses: ownDeps.uses,
        feedsInto: ownDeps.feedsInto,
        usedBy,
      },
      hookReferences: allHookRefs,
      hookOpportunities,
      totalExisting: existingConnections,
      totalPotential,
    },
  };
}

// ============================================================================
// CLI Interface
// ============================================================================

function printReport(result: IntegrationResult): void {
  console.log(`# Integration Opportunity Analysis: ${result.skillName}\n`);
  console.log(`**Score:** ${result.score} / 10`);
  console.log(`**Health:** ${result.dimensionResult.health}\n`);

  const d = result.details;

  console.log('## Connection Map\n');
  console.log(`- **Uses:** ${d.existingConnections.uses.length > 0 ? d.existingConnections.uses.join(', ') : 'none'}`);
  console.log(`- **Feeds Into:** ${d.existingConnections.feedsInto.length > 0 ? d.existingConnections.feedsInto.join(', ') : 'none'}`);
  console.log(`- **Used By:** ${d.existingConnections.usedBy.length > 0 ? d.existingConnections.usedBy.join(', ') : 'none'}`);
  console.log(`- **Hook References:** ${d.hookReferences.length > 0 ? d.hookReferences.join(', ') : 'none'}`);
  console.log(`- **Existing Connections:** ${d.totalExisting}`);
  console.log(`- **Total Potential Connections:** ${d.totalPotential}`);
  console.log('');

  if (d.hookOpportunities.length > 0) {
    console.log('## Hook Opportunities\n');
    for (const opp of d.hookOpportunities) {
      console.log(`- ${opp}`);
    }
    console.log('');
  }

  if (result.dimensionResult.findings.length > 0) {
    console.log('## Findings\n');
    for (const finding of result.dimensionResult.findings) {
      const loc = finding.location ? ` (${finding.location})` : '';
      console.log(`- [${finding.severity}] ${finding.description}${loc}`);
    }
    console.log('');
  }

  if (result.dimensionResult.recommendations.length > 0) {
    console.log('## Recommendations\n');
    for (const rec of result.dimensionResult.recommendations) {
      console.log(`- [${rec.priority}] ${rec.action}`);
    }
    console.log('');
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const skillName = args.find(a => !a.startsWith('--'));

  if (!skillName) {
    console.log('Usage: bun run IntegrationOpportunityFinder.ts <skill-name>');
    console.log('       bun run IntegrationOpportunityFinder.ts Browser');
    console.log('       bun run IntegrationOpportunityFinder.ts Browser --json');
    process.exit(1);
  }

  const result = findIntegrationOpportunities(skillName);

  if (!result) {
    console.error(`Skill not found: ${skillName}`);
    process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printReport(result);
  }
}

// Run CLI if executed directly
if (import.meta.main) {
  main();
}
