#!/usr/bin/env bun
/**
 * RedundancyDetector - Detect code duplication and workflow overlap
 *
 * Finds redundancy within and across skills:
 * - Code duplication in tools
 * - Workflow overlap within skill
 * - Trigger conflicts between skills
 *
 * Usage:
 *   bun run RedundancyDetector.ts <skill-name>         # Single skill
 *   bun run RedundancyDetector.ts --ecosystem          # Cross-skill analysis
 *   bun run RedundancyDetector.ts --json               # JSON output
 */

import { basename } from 'path';
import { RedundancyType, ImpactLevel, TRIGGER_OVERLAP_THRESHOLD, SCORING } from './constants';
import {
  getSkillDirectories,
  getSkillPath,
  getSkillFiles,
  safeReadFile,
  skillExists,
  extractTriggers,
  extractWorkflowTriggers,
  getDateString,
} from './utils';
import { collectInventory, collectAllInventories, type SkillInventory } from './SkillInventory';
import type { Finding, Recommendation, DimensionResult } from './report-builder';
import { buildDimensionResult } from './report-builder';

// ============================================================================
// Types
// ============================================================================

export interface Redundancy {
  type: RedundancyType;
  location: string;
  description: string;
  impact: ImpactLevel;
  recommendation: string;
  evidence: string[];
}

export interface RedundancyReport {
  skillName: string | null;
  analyzedAt: string;
  analysisType: 'single' | 'ecosystem';
  redundancies: Redundancy[];
  summary: {
    codeRedundancies: number;
    workflowRedundancies: number;
    toolRedundancies: number;
    triggerRedundancies: number;
    totalRedundancies: number;
    highImpact: number;
    mediumImpact: number;
    lowImpact: number;
  };
}

interface CodeBlock {
  file: string;
  startLine: number;
  content: string;
  hash: string;
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Detect redundancies within a single skill
 */
export function detectSkillRedundancies(skillName: string): RedundancyReport | null {
  if (!skillExists(skillName)) {
    return null;
  }

  const redundancies: Redundancy[] = [];
  const files = getSkillFiles(skillName);

  // 1. Code duplication detection
  const codeRedundancies = detectCodeDuplication(skillName);
  redundancies.push(...codeRedundancies);

  // 2. Workflow overlap detection
  const workflowRedundancies = detectWorkflowOverlap(skillName);
  redundancies.push(...workflowRedundancies);

  // 3. Internal trigger conflicts
  const triggerRedundancies = detectInternalTriggerConflicts(skillName);
  redundancies.push(...triggerRedundancies);

  return createReport(skillName, 'single', redundancies);
}

/**
 * Detect redundancies across the entire skill ecosystem
 */
export function detectEcosystemRedundancies(): RedundancyReport {
  const redundancies: Redundancy[] = [];
  const inventories = collectAllInventories();

  // 1. Cross-skill trigger conflicts
  const triggerConflicts = detectTriggerConflicts(inventories);
  redundancies.push(...triggerConflicts);

  // 2. Duplicate tool implementations
  const toolDuplicates = detectCrossSkillToolDuplicates(inventories);
  redundancies.push(...toolDuplicates);

  // 3. Similar workflow patterns
  const workflowSimilarities = detectSimilarWorkflowPatterns(inventories);
  redundancies.push(...workflowSimilarities);

  return createReport(null, 'ecosystem', redundancies);
}

// ============================================================================
// Detection Functions
// ============================================================================

/**
 * Detect code duplication within a skill's tools
 */
export function detectCodeDuplication(skillName: string): Redundancy[] {
  const redundancies: Redundancy[] = [];
  const files = getSkillFiles(skillName);

  if (files.tools.length < 2) {
    return redundancies;
  }

  // Extract significant code blocks from each tool
  const blocksByTool: Map<string, CodeBlock[]> = new Map();

  for (const toolPath of files.tools) {
    const content = safeReadFile(toolPath);
    if (!content) continue;

    const blocks = extractSignificantBlocks(content, toolPath);
    blocksByTool.set(toolPath, blocks);
  }

  // Compare blocks across tools
  const toolPaths = Array.from(blocksByTool.keys());
  for (let i = 0; i < toolPaths.length; i++) {
    for (let j = i + 1; j < toolPaths.length; j++) {
      const blocksA = blocksByTool.get(toolPaths[i])!;
      const blocksB = blocksByTool.get(toolPaths[j])!;

      for (const blockA of blocksA) {
        for (const blockB of blocksB) {
          if (blockA.hash === blockB.hash && blockA.content.length > 100) {
            redundancies.push({
              type: 'code',
              location: `${basename(toolPaths[i])} & ${basename(toolPaths[j])}`,
              description: 'Duplicate code block found across tools',
              impact: blockA.content.length > 200 ? 'HIGH' : 'MEDIUM',
              recommendation: 'Extract shared logic into a common utility function',
              evidence: [
                `Block in ${basename(toolPaths[i])} around line ${blockA.startLine}`,
                `Block in ${basename(toolPaths[j])} around line ${blockB.startLine}`,
                `Size: ${blockA.content.length} characters`,
              ],
            });
          }
        }
      }
    }
  }

  return redundancies;
}

/**
 * Detect workflow overlap within a skill
 */
export function detectWorkflowOverlap(skillName: string): Redundancy[] {
  const redundancies: Redundancy[] = [];
  const files = getSkillFiles(skillName);

  if (files.workflows.length < 2) {
    return redundancies;
  }

  // Extract workflow characteristics
  interface WorkflowInfo {
    path: string;
    name: string;
    triggers: string[];
    phases: string[];
    tools: string[];
  }

  const workflows: WorkflowInfo[] = [];

  for (const workflowPath of files.workflows) {
    const content = safeReadFile(workflowPath);
    if (!content) continue;

    const name = basename(workflowPath, '.md');
    const triggers = extractWorkflowTriggers(content);
    const phases = extractPhases(content);
    const tools = extractToolReferences(content);

    workflows.push({ path: workflowPath, name, triggers, phases, tools });
  }

  // Compare workflows for overlap
  for (let i = 0; i < workflows.length; i++) {
    for (let j = i + 1; j < workflows.length; j++) {
      const wfA = workflows[i];
      const wfB = workflows[j];

      // Check trigger overlap
      const triggerOverlap = calculateSetOverlap(new Set(wfA.triggers), new Set(wfB.triggers));
      if (triggerOverlap > 50) {
        redundancies.push({
          type: 'workflow',
          location: `${wfA.name} & ${wfB.name}`,
          description: `Workflow trigger overlap: ${Math.round(triggerOverlap)}%`,
          impact: triggerOverlap > 70 ? 'HIGH' : 'MEDIUM',
          recommendation: 'Consider merging workflows or clarifying distinct purposes',
          evidence: [
            `${wfA.name} triggers: ${wfA.triggers.slice(0, 3).join(', ')}`,
            `${wfB.name} triggers: ${wfB.triggers.slice(0, 3).join(', ')}`,
          ],
        });
      }

      // Check phase structure similarity
      const phaseOverlap = calculateSetOverlap(new Set(wfA.phases), new Set(wfB.phases));
      if (phaseOverlap > 60 && wfA.phases.length >= 3) {
        redundancies.push({
          type: 'workflow',
          location: `${wfA.name} & ${wfB.name}`,
          description: `Workflow structure overlap: ${Math.round(phaseOverlap)}% similar phases`,
          impact: 'LOW',
          recommendation: 'Consider extracting shared phases into a base workflow',
          evidence: [
            `Shared phases: ${wfA.phases.filter(p => wfB.phases.includes(p)).join(', ')}`,
          ],
        });
      }
    }
  }

  return redundancies;
}

/**
 * Detect trigger conflicts between skills
 */
export function detectTriggerConflicts(inventories: SkillInventory[]): Redundancy[] {
  const redundancies: Redundancy[] = [];

  // Build trigger -> skills mapping
  const triggerMap: Map<string, string[]> = new Map();

  for (const inv of inventories) {
    for (const trigger of inv.triggers) {
      const normalized = trigger.toLowerCase().trim();
      if (!triggerMap.has(normalized)) {
        triggerMap.set(normalized, []);
      }
      triggerMap.get(normalized)!.push(inv.name);
    }
  }

  // Find triggers claimed by multiple skills
  for (const [trigger, skills] of triggerMap) {
    if (skills.length > 1) {
      redundancies.push({
        type: 'trigger',
        location: skills.join(', '),
        description: `Trigger "${trigger}" claimed by multiple skills`,
        impact: skills.length > 2 ? 'HIGH' : 'MEDIUM',
        recommendation: 'Clarify skill boundaries or consolidate skills',
        evidence: skills.map(s => `${s} claims trigger "${trigger}"`),
      });
    }
  }

  // Check Jaccard similarity between skill trigger sets
  for (let i = 0; i < inventories.length; i++) {
    for (let j = i + 1; j < inventories.length; j++) {
      const invA = inventories[i];
      const invB = inventories[j];

      if (invA.triggers.length === 0 || invB.triggers.length === 0) continue;

      const setA = new Set(invA.triggers.map(t => t.toLowerCase()));
      const setB = new Set(invB.triggers.map(t => t.toLowerCase()));
      const overlap = calculateSetOverlap(setA, setB);

      if (overlap >= TRIGGER_OVERLAP_THRESHOLD) {
        redundancies.push({
          type: 'trigger',
          location: `${invA.name} & ${invB.name}`,
          description: `High trigger overlap: ${Math.round(overlap)}% (threshold: ${TRIGGER_OVERLAP_THRESHOLD}%)`,
          impact: 'HIGH',
          recommendation: 'Consider consolidating these skills',
          evidence: [
            `${invA.name}: ${invA.triggers.slice(0, 3).join(', ')}`,
            `${invB.name}: ${invB.triggers.slice(0, 3).join(', ')}`,
          ],
        });
      }
    }
  }

  return redundancies;
}

/**
 * Detect duplicate tool implementations across skills
 */
function detectCrossSkillToolDuplicates(inventories: SkillInventory[]): Redundancy[] {
  const redundancies: Redundancy[] = [];

  // Build tool name -> skills mapping
  const toolMap: Map<string, string[]> = new Map();

  for (const inv of inventories) {
    const files = getSkillFiles(inv.name);
    for (const toolPath of files.tools) {
      const toolName = basename(toolPath, '.ts').toLowerCase();
      if (!toolMap.has(toolName)) {
        toolMap.set(toolName, []);
      }
      toolMap.get(toolName)!.push(inv.name);
    }
  }

  // Find duplicate tool names
  for (const [toolName, skills] of toolMap) {
    if (skills.length > 1) {
      redundancies.push({
        type: 'tool',
        location: skills.join(', '),
        description: `Tool "${toolName}" implemented in multiple skills`,
        impact: 'MEDIUM',
        recommendation: 'Consider moving to CORE/Tools for shared use',
        evidence: skills.map(s => `${s}/Tools/${toolName}.ts`),
      });
    }
  }

  return redundancies;
}

/**
 * Detect similar workflow patterns across skills
 */
function detectSimilarWorkflowPatterns(inventories: SkillInventory[]): Redundancy[] {
  const redundancies: Redundancy[] = [];

  // Build workflow name -> skills mapping
  const workflowMap: Map<string, string[]> = new Map();

  for (const inv of inventories) {
    const files = getSkillFiles(inv.name);
    for (const wfPath of files.workflows) {
      const wfName = basename(wfPath, '.md').toLowerCase();
      if (!workflowMap.has(wfName)) {
        workflowMap.set(wfName, []);
      }
      workflowMap.get(wfName)!.push(inv.name);
    }
  }

  // Find duplicate workflow names
  for (const [wfName, skills] of workflowMap) {
    if (skills.length > 1) {
      redundancies.push({
        type: 'workflow',
        location: skills.join(', '),
        description: `Workflow "${wfName}" exists in multiple skills`,
        impact: 'LOW',
        recommendation: 'Review for potential consolidation or shared abstraction',
        evidence: skills.map(s => `${s}/Workflows/${wfName}.md`),
      });
    }
  }

  return redundancies;
}

/**
 * Detect internal trigger conflicts within a skill
 */
function detectInternalTriggerConflicts(skillName: string): Redundancy[] {
  const redundancies: Redundancy[] = [];
  const files = getSkillFiles(skillName);

  // Build trigger -> workflows mapping
  const triggerMap: Map<string, string[]> = new Map();

  for (const wfPath of files.workflows) {
    const content = safeReadFile(wfPath);
    if (!content) continue;

    const wfName = basename(wfPath, '.md');
    const triggers = extractWorkflowTriggers(content);

    for (const trigger of triggers) {
      const normalized = trigger.toLowerCase().trim();
      if (!triggerMap.has(normalized)) {
        triggerMap.set(normalized, []);
      }
      triggerMap.get(normalized)!.push(wfName);
    }
  }

  // Find triggers claimed by multiple workflows
  for (const [trigger, workflows] of triggerMap) {
    if (workflows.length > 1 && trigger.length > 3) {
      redundancies.push({
        type: 'trigger',
        location: `${skillName}: ${workflows.join(', ')}`,
        description: `Internal trigger conflict: "${trigger}"`,
        impact: 'MEDIUM',
        recommendation: 'Clarify which workflow should handle this trigger',
        evidence: workflows.map(wf => `${wf} claims "${trigger}"`),
      });
    }
  }

  return redundancies;
}

// ============================================================================
// Helper Functions
// ============================================================================

function extractSignificantBlocks(content: string, filePath: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const lines = content.split('\n');

  // Find function definitions and significant code blocks
  let currentBlock: string[] = [];
  let blockStart = 0;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip imports and comments
    if (line.trim().startsWith('import ') || line.trim().startsWith('//')) {
      continue;
    }

    // Track brace depth for function blocks
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;

    if (braceDepth === 0 && opens > 0) {
      blockStart = i;
      currentBlock = [line];
    } else if (braceDepth > 0) {
      currentBlock.push(line);
    }

    braceDepth += opens - closes;

    if (braceDepth === 0 && currentBlock.length > 5) {
      const blockContent = currentBlock.join('\n');
      blocks.push({
        file: filePath,
        startLine: blockStart + 1,
        content: blockContent,
        hash: simpleHash(normalizeCode(blockContent)),
      });
      currentBlock = [];
    }
  }

  return blocks;
}

function normalizeCode(code: string): string {
  return code
    .replace(/\s+/g, ' ')
    .replace(/['"`]/g, '"')
    .replace(/\/\/.*$/gm, '')
    .trim();
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

// extractWorkflowTriggers is imported from utils.ts

function extractPhases(content: string): string[] {
  const phases: string[] = [];
  const phaseMatches = content.match(/###?\s*Phase\s+\d+[^#\n]*/gi);

  if (phaseMatches) {
    for (const match of phaseMatches) {
      const phase = match.replace(/###?\s*/, '').trim();
      phases.push(phase);
    }
  }

  return phases;
}

function extractToolReferences(content: string): string[] {
  const tools: string[] = [];
  const toolMatches = content.match(/bun run.*\.ts|Tools\/\w+\.ts/gi);

  if (toolMatches) {
    for (const match of toolMatches) {
      const tool = match.match(/(\w+)\.ts/);
      if (tool) {
        tools.push(tool[1]);
      }
    }
  }

  return [...new Set(tools)];
}

function calculateSetOverlap<T>(setA: Set<T>, setB: Set<T>): number {
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size > 0 ? (intersection.size / union.size) * 100 : 0;
}

function createReport(skillName: string | null, analysisType: 'single' | 'ecosystem', redundancies: Redundancy[]): RedundancyReport {
  return {
    skillName,
    analyzedAt: new Date().toISOString(),
    analysisType,
    redundancies,
    summary: {
      codeRedundancies: redundancies.filter(r => r.type === 'code').length,
      workflowRedundancies: redundancies.filter(r => r.type === 'workflow').length,
      toolRedundancies: redundancies.filter(r => r.type === 'tool').length,
      triggerRedundancies: redundancies.filter(r => r.type === 'trigger').length,
      totalRedundancies: redundancies.length,
      highImpact: redundancies.filter(r => r.impact === 'HIGH').length,
      mediumImpact: redundancies.filter(r => r.impact === 'MEDIUM').length,
      lowImpact: redundancies.filter(r => r.impact === 'LOW').length,
    },
  };
}

// ============================================================================
// CLI Interface
// ============================================================================

function printReport(report: RedundancyReport): void {
  const title = report.skillName
    ? `# Redundancy Analysis: ${report.skillName}`
    : '# Ecosystem Redundancy Analysis';

  console.log(`${title}\n`);
  console.log(`**Analyzed:** ${report.analyzedAt}`);
  console.log(`**Analysis Type:** ${report.analysisType}\n`);

  console.log('## Summary\n');
  console.log(`- **Total Redundancies:** ${report.summary.totalRedundancies}`);
  console.log(`- **Code Duplications:** ${report.summary.codeRedundancies}`);
  console.log(`- **Workflow Overlaps:** ${report.summary.workflowRedundancies}`);
  console.log(`- **Tool Redundancies:** ${report.summary.toolRedundancies}`);
  console.log(`- **Trigger Conflicts:** ${report.summary.triggerRedundancies}`);
  console.log('');
  console.log(`**By Impact:**`);
  console.log(`- 🔴 High: ${report.summary.highImpact}`);
  console.log(`- 🟡 Medium: ${report.summary.mediumImpact}`);
  console.log(`- 🟢 Low: ${report.summary.lowImpact}`);
  console.log('');

  if (report.redundancies.length === 0) {
    console.log('No redundancies detected.\n');
    return;
  }

  // Group by impact
  const high = report.redundancies.filter(r => r.impact === 'HIGH');
  const medium = report.redundancies.filter(r => r.impact === 'MEDIUM');
  const low = report.redundancies.filter(r => r.impact === 'LOW');

  if (high.length > 0) {
    console.log('## 🔴 High Impact Redundancies\n');
    for (const r of high) {
      printRedundancy(r);
    }
  }

  if (medium.length > 0) {
    console.log('## 🟡 Medium Impact Redundancies\n');
    for (const r of medium) {
      printRedundancy(r);
    }
  }

  if (low.length > 0) {
    console.log('## 🟢 Low Impact Redundancies\n');
    for (const r of low) {
      printRedundancy(r);
    }
  }

  // Recommendations
  console.log('## Elimination Plan\n');
  console.log('### Quick Wins (High Impact, Address First)\n');
  let quickWins = 0;
  for (const r of high) {
    quickWins++;
    console.log(`${quickWins}. **${r.location}:** ${r.recommendation}`);
  }
  if (quickWins === 0) {
    console.log('No high-impact redundancies to address.\n');
  }
}

function printRedundancy(r: Redundancy): void {
  console.log(`### ${r.type.toUpperCase()}: ${r.location}\n`);
  console.log(`**Description:** ${r.description}\n`);
  console.log('**Evidence:**');
  for (const e of r.evidence) {
    console.log(`- ${e}`);
  }
  console.log('');
  console.log(`**Recommendation:** ${r.recommendation}\n`);
}

function main(): void {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const ecosystemMode = args.includes('--ecosystem');
  const skillName = args.find(a => !a.startsWith('--'));

  let report: RedundancyReport;

  if (ecosystemMode) {
    report = detectEcosystemRedundancies();
  } else if (skillName) {
    const result = detectSkillRedundancies(skillName);
    if (!result) {
      console.error(`Skill not found: ${skillName}`);
      process.exit(1);
    }
    report = result;
  } else {
    console.log('Usage: bun run RedundancyDetector.ts <skill-name>');
    console.log('       bun run RedundancyDetector.ts --ecosystem');
    console.log('       bun run RedundancyDetector.ts Browser --json');
    process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
}

// ============================================================================
// Scoring Function — Dimension 6: Code Hygiene (redundancy contribution)
// ============================================================================

/**
 * Score redundancy impact on Code Hygiene dimension.
 * Returns partial DimensionResult — DeadCodeDetector covers dead code half.
 */
export function scoreRedundancyForDim6(skillName: string): DimensionResult | null {
  const report = detectSkillRedundancies(skillName);
  if (!report) return null;

  let score = 10;
  const findings: Finding[] = [];
  const recommendations: Recommendation[] = [];

  // -1 per duplicate code block (treats duplication as hygiene issue)
  const codeRedundancies = report.redundancies.filter(r => r.type === 'code');
  for (const r of codeRedundancies) {
    score += SCORING.codeHygiene.unusedExport; // -0.5 per duplicate (lighter than Dim7)
    findings.push({
      description: `Duplicated code block in ${r.location} — hygiene debt`,
      severity: r.impact === 'HIGH' ? 'HIGH' : 'MEDIUM',
    });
  }

  // -0.5 per internal trigger conflict (maintenance debt)
  const triggerRedundancies = report.redundancies.filter(r => r.type === 'trigger');
  for (const r of triggerRedundancies) {
    score += SCORING.codeHygiene.staleReference; // -0.5
    findings.push({
      description: `Internal trigger conflict: ${r.description}`,
      severity: 'LOW',
    });
  }

  if (codeRedundancies.length > 0) {
    recommendations.push({
      action: `Eliminate ${codeRedundancies.length} duplicate code block(s) to reduce maintenance surface`,
      priority: 'P2',
      effort: 'M',
      impact: 'MEDIUM',
      dimension: 'codeHygiene',
    });
  }

  if (triggerRedundancies.length > 0) {
    recommendations.push({
      action: `Resolve ${triggerRedundancies.length} internal trigger conflict(s)`,
      priority: 'P3',
      effort: 'S',
      impact: 'LOW',
      dimension: 'codeHygiene',
    });
  }

  if (findings.length === 0) {
    findings.push({
      description: 'No redundancy-related hygiene issues detected',
      severity: 'LOW',
    });
  }

  return buildDimensionResult(score, findings, recommendations, true);
}

// ============================================================================
// Scoring Function — Dimension 7: Refactoring Need (partial — duplication half)
// ============================================================================

/**
 * Score code duplication and workflow overlap for Dimension 7: Refactoring Need.
 * Returns partial DimensionResult — ConventionChecker covers convention half.
 */
export function scoreDuplicationForDim7(skillName: string): DimensionResult | null {
  const report = detectSkillRedundancies(skillName);
  if (!report) return null;

  let score = 10;
  const findings: Finding[] = [];
  const recommendations: Recommendation[] = [];

  // -1 per duplicate code block (SCORING.refactoring.codeDuplication)
  const codeRedundancies = report.redundancies.filter(r => r.type === 'code');
  for (const r of codeRedundancies) {
    score += SCORING.refactoring.codeDuplication; // -1
    findings.push({
      description: `Code duplication: ${r.description} in ${r.location}`,
      severity: r.impact === 'HIGH' ? 'HIGH' : 'MEDIUM',
    });
  }

  // -0.5 per workflow overlap (SCORING.refactoring.inconsistentPattern)
  const workflowRedundancies = report.redundancies.filter(r => r.type === 'workflow');
  for (const r of workflowRedundancies) {
    score += SCORING.refactoring.inconsistentPattern; // -0.5
    findings.push({
      description: `Workflow overlap: ${r.description}`,
      severity: 'LOW',
    });
  }

  if (codeRedundancies.length > 0) {
    recommendations.push({
      action: `Extract ${codeRedundancies.length} duplicate code block(s) into shared utilities`,
      priority: 'P2',
      effort: 'M',
      impact: 'MEDIUM',
      dimension: 'refactoringNeed',
    });
  }

  if (workflowRedundancies.length > 0) {
    recommendations.push({
      action: `Review ${workflowRedundancies.length} workflow overlap(s) — consider merging or clarifying purpose`,
      priority: 'P3',
      effort: 'S',
      impact: 'LOW',
      dimension: 'refactoringNeed',
    });
  }

  if (findings.length === 0) {
    findings.push({
      description: 'No code duplication or workflow overlap detected',
      severity: 'LOW',
    });
  }

  return buildDimensionResult(score, findings, recommendations, true);
}

// Run CLI if executed directly
if (import.meta.main) {
  main();
}
