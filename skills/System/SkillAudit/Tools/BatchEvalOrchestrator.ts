#!/usr/bin/env bun
/**
 * BatchEvalOrchestrator — Orchestrates batch skill evaluation across all phases.
 *
 * Phases:
 *   0: Build canonical registry (deduplicated skill list with tiers)
 *   1: Structural audit (deterministic 11-dimension tools)
 *   2: Trigger accuracy eval (RunLoop.py)
 *   3: Output quality eval (EvalSkill workflow)
 *   4: A/B comparison (CompareSkill, targeted)
 *   5: Aggregation & dashboard
 *
 * Usage:
 *   bun BatchEvalOrchestrator.ts --phase [0|1|2|3|4|5|all] [--parallel N] [--dry-run]
 *   bun BatchEvalOrchestrator.ts --phase 1 --batch-dir ~/.claude/MEMORY/SkillAudits/batch-eval-2026-03-13/
 *   bun BatchEvalOrchestrator.ts --phase 0 --json
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, basename, relative } from 'path';
import { SKILLS_DIR, SKILL_AUDITS_DIR } from './constants';
import type { DimensionName, HealthStatus } from './constants';
import { ensureDirectory, getTimestamp, getDateString } from './utils';
import { scoreStructure } from './StructuralScorer';
import { analyzeContextCost } from './ContextCostAnalyzer';
import { evaluateComplexity } from './ComplexityEvaluator';
import { checkConventions } from './ConventionChecker';
import { scoreIntegrationFitness } from './DependencyMapper';
import { scoreRedundancyForDim6, scoreDuplicationForDim7 } from './RedundancyDetector';
import { scoreContextRouting } from './TriggerAnalyzer';
import { verifyBehavior } from './BehaviorVerifier';
import { assessValidity } from './ValidityAssessor';
import type { DimensionResult } from './report-builder';
import {
  dimensionHealth,
  calculateOverallHealth,
  calculateOverallScore,
  emptyDimensionResult,
} from './report-builder';

// ============================================================================
// Types
// ============================================================================

type EvalTier = 'A' | 'B' | 'C' | 'D';
type SkillType = 'leaf' | 'router';
type PhaseStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

interface RegistryEntry {
  name: string;
  canonicalPath: string;       // relative to SKILLS_DIR, e.g. "Automation/AutonomousWork"
  type: SkillType;
  tier: EvalTier;
  alreadyEvaluated: boolean;
  category: string;
}

interface Registry {
  generatedAt: string;
  totalLeaf: number;
  totalRouter: number;
  duplicatesRemoved: string[];
  entries: RegistryEntry[];
}

interface SkillPhaseState {
  phase1: PhaseStatus;
  phase2: PhaseStatus;
  phase3: PhaseStatus;
  phase4: PhaseStatus;
}

interface OrchestratorState {
  startedAt: string;
  lastUpdated: string;
  batchDir: string;
  registry: Registry;
  skills: Record<string, SkillPhaseState>;
  phase5: PhaseStatus;
}

interface Phase1Result {
  skillName: string;
  canonicalPath: string;
  overallScore: number;
  overallHealth: HealthStatus;
  dimensions: Record<string, {
    score: number;
    health: HealthStatus;
    findingCount: number;
  }>;
  triage: 'RED' | 'YELLOW' | 'GREEN';
}

interface DashboardSkill {
  name: string;
  path: string;
  tier: EvalTier;
  type: SkillType;
  structural: { health: HealthStatus; score: number; dimensions: Record<string, number> } | null;
  trigger: { accuracy: number; improved: boolean } | null;
  output: { withSkill: number; baseline: number; delta: number } | null;
  compare: { winner: string; score: number } | null;
}

interface Dashboard {
  generatedAt: string;
  summary: { total: number; green: number; yellow: number; red: number };
  skills: DashboardSkill[];
  ecosystem: { triggerOverlaps: unknown[]; consolidationCandidates: string[] };
}

// ============================================================================
// Constants
// ============================================================================

const DUPLICATE_MAP: Record<string, string> = {
  'Browser': 'Development/Browser',
  'LucidTasks': 'Productivity/LucidTasks',
  'Prompting': 'Intelligence/Prompting',
  'QueueRouter': 'Automation/QueueRouter',
  'AutonomousWork': 'Automation/AutonomousWork',
};

const STANDALONE_DUPLICATES = new Set(Object.keys(DUPLICATE_MAP));

const CATEGORY_ROUTERS = new Set([
  'Agents', 'Automation', 'Commerce', 'Communication', 'Content',
  'Data', 'Development', 'Intelligence', 'Life', 'Productivity', 'System',
]);

const ALREADY_EVALUATED = new Set([
  'ContextManager', 'InformationManager', 'CalendarAssistant',
  'DailyBriefing', 'JobEngine', 'LucidTasks',
]);

const TIER_A: Set<string> = new Set([
  'Gmail', 'Telegram', 'VoiceInteraction', 'CommunityOutreach',
  'Instacart', 'Shopping', 'Apify', 'BrightData', 'WebAssessment',
]);

const TIER_B: Set<string> = new Set([
  'AutonomousWork', 'QueueRouter', 'ProactiveEngine', 'AutoMaintenance',
  'AutoInfoManager', 'AgentMonitor', 'GeminiSync', 'PublicSync',
]);

const TIER_D: Set<string> = new Set([
  'Simulation', 'SkillAudit', 'KayaUpgrade', 'SystemFlowchart',
  'ContentAggregator', 'Art', 'Browser', 'Canvas', 'CreateCLI',
  'CreateSkill', 'UIBuilder', 'UnixCLI',
]);

// ============================================================================
// Phase 0: Registry Building
// ============================================================================

function discoverAllSkills(): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  const seen = new Set<string>();

  function walkDir(dir: string, prefix: string): void {
    if (!existsSync(dir)) return;
    const items = readdirSync(dir, { withFileTypes: true });

    for (const item of items) {
      if (!item.isDirectory() || item.name.startsWith('.') || item.name.startsWith('_')) continue;
      if (item.name === 'Tools' || item.name === 'Workflows' || item.name === 'Server' ||
          item.name === 'Data' || item.name === 'data' || item.name === '__tests__' ||
          item.name === 'node_modules') continue;

      const relPath = prefix ? `${prefix}/${item.name}` : item.name;
      const fullPath = join(dir, item.name);
      const hasSkillMd = existsSync(join(fullPath, 'SKILL.md'));

      // Check if it has sub-skills (category)
      const subDirs = readdirSync(fullPath, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.') &&
          !['Tools', 'Workflows', 'Server', 'Data', 'data', '__tests__', 'node_modules'].includes(d.name));
      const hasSubSkills = subDirs.some(d => existsSync(join(fullPath, d.name, 'SKILL.md')));

      if (hasSkillMd) {
        const name = item.name;

        // Skip standalone duplicates — use canonical path instead
        if (!prefix && STANDALONE_DUPLICATES.has(name)) {
          return; // skip, canonical version is nested
        }

        if (seen.has(name)) continue;
        seen.add(name);

        const isRouter = CATEGORY_ROUTERS.has(name) && hasSubSkills;

        let tier: EvalTier = 'C';
        if (TIER_A.has(name)) tier = 'A';
        else if (TIER_B.has(name)) tier = 'B';
        else if (TIER_D.has(name)) tier = 'D';

        const category = prefix || name;

        entries.push({
          name,
          canonicalPath: relPath,
          type: isRouter ? 'router' : 'leaf',
          tier,
          alreadyEvaluated: ALREADY_EVALUATED.has(name),
          category: category.split('/')[0],
        });
      }

      // Recurse into subdirectories
      if (hasSubSkills) {
        walkDir(fullPath, relPath);
      }
    }
  }

  walkDir(SKILLS_DIR, '');
  return entries;
}

function buildRegistry(): Registry {
  const entries = discoverAllSkills();
  const leafEntries = entries.filter(e => e.type === 'leaf');
  const routerEntries = entries.filter(e => e.type === 'router');

  return {
    generatedAt: getTimestamp(),
    totalLeaf: leafEntries.length,
    totalRouter: routerEntries.length,
    duplicatesRemoved: Object.keys(DUPLICATE_MAP),
    entries,
  };
}

// ============================================================================
// Phase 1: Structural Audit
// ============================================================================

function runPhase1ForSkill(entry: RegistryEntry): Phase1Result {
  // The existing tools use top-level skill name via getSkillPath(name) = join(SKILLS_DIR, name)
  // For nested skills, we pass the canonical path (e.g., "Automation/AutonomousWork")
  const skillKey = entry.canonicalPath;

  const dimensions: Record<string, { score: number; health: HealthStatus; findingCount: number }> = {};

  // D2: Implementation Quality (StructuralScorer)
  const structural = scoreStructure(skillKey);
  if (structural) {
    dimensions.implementationQuality = {
      score: structural.score,
      health: structural.dimensionResult.health,
      findingCount: structural.dimensionResult.findings.length,
    };
  }

  // D5: Context Efficiency (ContextCostAnalyzer)
  const contextCost = analyzeContextCost(skillKey);
  if (contextCost) {
    dimensions.contextEfficiency = {
      score: contextCost.score,
      health: contextCost.dimensionResult.health,
      findingCount: contextCost.dimensionResult.findings.length,
    };
  }

  // D7: Refactoring Need (ConventionChecker)
  const conventions = checkConventions(skillKey);
  if (conventions) {
    dimensions.refactoringNeed = {
      score: conventions.score,
      health: conventions.dimensionResult.health,
      findingCount: conventions.dimensionResult.findings.length,
    };
  }

  // D9: Complexity + D11: Agent Balance (ComplexityEvaluator)
  const complexity = evaluateComplexity(skillKey);
  if (complexity) {
    dimensions.complexity = {
      score: complexity.complexityScore,
      health: complexity.complexityDimension.health,
      findingCount: complexity.complexityDimension.findings.length,
    };
    dimensions.agentBalance = {
      score: complexity.agentBalanceScore,
      health: complexity.agentBalanceDimension.health,
      findingCount: complexity.agentBalanceDimension.findings.length,
    };
  }

  // D3: Integration Fitness (DependencyMapper)
  const integration = scoreIntegrationFitness(skillKey);
  if (integration) {
    dimensions.integrationFitness = {
      score: integration.score,
      health: integration.health,
      findingCount: integration.findings.length,
    };
  }

  // D6: Code Hygiene (RedundancyDetector - dead code dimension)
  const codeHygiene = scoreRedundancyForDim6(skillKey);
  if (codeHygiene) {
    dimensions.codeHygiene = {
      score: codeHygiene.score,
      health: codeHygiene.health,
      findingCount: codeHygiene.findings.length,
    };
  }

  // D8: Context Routing (TriggerAnalyzer - synchronous wrapper)
  // scoreContextRouting is async, but we'll handle it
  dimensions.contextRouting = { score: 5, health: 'YELLOW', findingCount: 0 };

  // D1: Behavioral Fidelity (BehaviorVerifier)
  const behavior = verifyBehavior(skillKey);
  if (behavior) {
    dimensions.behavioralFidelity = {
      score: behavior.score,
      health: behavior.dimensionResult.health,
      findingCount: behavior.dimensionResult.findings.length,
    };
  }

  // D4: Skill Validity (ValidityAssessor)
  const validity = assessValidity(skillKey);
  if (validity) {
    dimensions.skillValidity = {
      score: validity.score,
      health: validity.dimensionResult.health,
      findingCount: validity.dimensionResult.findings.length,
    };
  }

  // Compute overall
  const scores = Object.values(dimensions).map(d => d.score);
  const avgScore = scores.length > 0
    ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
    : 5;

  const anyRed = scores.some(s => s < 3);
  const countBelow5 = scores.filter(s => s < 5).length;
  const countBelow6 = scores.filter(s => s < 6).length;

  let triage: 'RED' | 'YELLOW' | 'GREEN' = 'GREEN';
  if (anyRed || countBelow5 >= 3) triage = 'RED';
  else if (countBelow6 >= 2) triage = 'YELLOW';

  return {
    skillName: entry.name,
    canonicalPath: entry.canonicalPath,
    overallScore: avgScore,
    overallHealth: triage,
    dimensions,
    triage,
  };
}

async function runPhase1(
  registry: Registry,
  batchDir: string,
  dryRun: boolean
): Promise<Phase1Result[]> {
  const phase1Dir = join(batchDir, 'phase1-structural');
  ensureDirectory(phase1Dir);

  const leafSkills = registry.entries.filter(e => e.type === 'leaf');

  if (dryRun) {
    console.log(`\n## Phase 1: Structural Audit (dry-run)`);
    console.log(`Would evaluate ${leafSkills.length} leaf skills`);
    console.log(`Output: ${phase1Dir}/<SkillName>.json\n`);

    console.log('| # | Skill | Path | Tier |');
    console.log('|---|-------|------|------|');
    leafSkills.forEach((s, i) => {
      console.log(`| ${i + 1} | ${s.name} | ${s.canonicalPath} | ${s.tier} |`);
    });
    return [];
  }

  const results: Phase1Result[] = [];

  for (const entry of leafSkills) {
    try {
      const result = runPhase1ForSkill(entry);
      results.push(result);

      // Write individual result
      const outPath = join(phase1Dir, `${entry.name}.json`);
      writeFileSync(outPath, JSON.stringify(result, null, 2));

      const emoji = result.triage === 'RED' ? '🔴' : result.triage === 'YELLOW' ? '🟡' : '🟢';
      console.log(`  ${emoji} ${entry.name}: ${result.overallScore}/10 (${result.triage})`);
    } catch (err) {
      console.error(`  ❌ ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
      results.push({
        skillName: entry.name,
        canonicalPath: entry.canonicalPath,
        overallScore: 0,
        overallHealth: 'RED',
        dimensions: {},
        triage: 'RED',
      });
    }
  }

  // Also run TriggerAnalyzer async scoring for D8
  for (const result of results) {
    try {
      const d8 = await scoreContextRouting(result.canonicalPath);
      result.dimensions.contextRouting = {
        score: d8.score,
        health: d8.health,
        findingCount: d8.findings.length,
      };
    } catch {
      // Keep default
    }
  }

  // Summary
  const redCount = results.filter(r => r.triage === 'RED').length;
  const yellowCount = results.filter(r => r.triage === 'YELLOW').length;
  const greenCount = results.filter(r => r.triage === 'GREEN').length;

  console.log(`\n## Phase 1 Summary`);
  console.log(`  🔴 RED: ${redCount} | 🟡 YELLOW: ${yellowCount} | 🟢 GREEN: ${greenCount}`);
  console.log(`  Results: ${phase1Dir}/`);

  return results;
}

// ============================================================================
// Phase 2: Trigger Accuracy (generates execution plan)
// ============================================================================

interface Phase2Plan {
  batches: Array<{
    batchNum: number;
    skills: Array<{ name: string; canonicalPath: string; priority: string }>;
    iterations: number;
  }>;
  totalSkills: number;
  estimatedCost: string;
}

function planPhase2(
  registry: Registry,
  phase1Results: Phase1Result[],
  dryRun: boolean,
  batchDir: string
): Phase2Plan {
  const phase2Dir = join(batchDir, 'phase2-trigger');
  ensureDirectory(phase2Dir);

  const redSkills = new Set(phase1Results.filter(r => r.triage === 'RED').map(r => r.skillName));

  // All leaf skills + routers for trigger eval
  const allForTrigger = registry.entries.filter(e =>
    e.type === 'leaf' || e.type === 'router'
  );

  // Build batches of 5
  const batches: Phase2Plan['batches'] = [];
  let batchNum = 1;
  let currentBatch: Phase2Plan['batches'][0]['skills'] = [];

  // Priority: routers first, then RED, then rest
  const routers = allForTrigger.filter(e => e.type === 'router');
  const redLeaf = allForTrigger.filter(e => e.type === 'leaf' && redSkills.has(e.name));
  const rest = allForTrigger.filter(e => e.type === 'leaf' && !redSkills.has(e.name));

  const ordered = [...routers, ...redLeaf, ...rest];

  for (const entry of ordered) {
    const isGreen = !redSkills.has(entry.name) && entry.type === 'leaf';
    currentBatch.push({
      name: entry.name,
      canonicalPath: entry.canonicalPath,
      priority: entry.type === 'router' ? 'high' : redSkills.has(entry.name) ? 'high' : 'medium',
    });

    if (currentBatch.length >= 5) {
      batches.push({
        batchNum: batchNum++,
        skills: [...currentBatch],
        iterations: currentBatch.every(s => s.priority === 'medium') ? 3 : 5,
      });
      currentBatch = [];
    }
  }

  if (currentBatch.length > 0) {
    batches.push({
      batchNum: batchNum++,
      skills: currentBatch,
      iterations: 5,
    });
  }

  const plan: Phase2Plan = {
    batches,
    totalSkills: ordered.length,
    estimatedCost: `$${Math.round(ordered.length * 3.5)}-$${Math.round(ordered.length * 6)}`,
  };

  if (dryRun) {
    console.log(`\n## Phase 2: Trigger Accuracy (dry-run)`);
    console.log(`Would evaluate ${plan.totalSkills} skills in ${batches.length} batches`);
    console.log(`Estimated cost: ${plan.estimatedCost}\n`);
    console.log('| Batch | Skills | Iterations | Priority |');
    console.log('|-------|--------|------------|----------|');
    for (const batch of batches) {
      const names = batch.skills.map(s => s.name).join(', ');
      const priority = batch.skills[0]?.priority ?? 'medium';
      console.log(`| ${batch.batchNum} | ${names} | ${batch.iterations} | ${priority} |`);
    }
  }

  // Save plan
  writeFileSync(join(phase2Dir, 'plan.json'), JSON.stringify(plan, null, 2));
  return plan;
}

// ============================================================================
// Phase 3: Output Quality (generates execution plan)
// ============================================================================

interface Phase3Plan {
  batches: Array<{
    batchNum: number;
    skills: Array<{ name: string; canonicalPath: string; tier: EvalTier; evalType: string }>;
  }>;
  totalSkills: number;
  skippedAlreadyEval: string[];
  estimatedCost: string;
}

function planPhase3(
  registry: Registry,
  phase1Results: Phase1Result[],
  dryRun: boolean,
  batchDir: string
): Phase3Plan {
  const phase3Dir = join(batchDir, 'phase3-output');
  ensureDirectory(phase3Dir);

  const leafSkills = registry.entries.filter(e =>
    e.type === 'leaf' && !e.alreadyEvaluated
  );
  const skipped = registry.entries.filter(e => e.alreadyEvaluated).map(e => e.name);

  // Sort by triage priority (RED first)
  const redSkills = new Set(phase1Results.filter(r => r.triage === 'RED').map(r => r.skillName));
  const sorted = [...leafSkills].sort((a, b) => {
    const aRed = redSkills.has(a.name) ? 0 : 1;
    const bRed = redSkills.has(b.name) ? 0 : 1;
    return aRed - bRed;
  });

  const batches: Phase3Plan['batches'] = [];
  let batchNum = 1;
  let currentBatch: Phase3Plan['batches'][0]['skills'] = [];

  for (const entry of sorted) {
    const evalType = TIER_A.has(entry.name) ? 'planning_eval' : 'full_eval';
    currentBatch.push({
      name: entry.name,
      canonicalPath: entry.canonicalPath,
      tier: entry.tier,
      evalType,
    });

    if (currentBatch.length >= 3) {
      batches.push({ batchNum: batchNum++, skills: [...currentBatch] });
      currentBatch = [];
    }
  }

  if (currentBatch.length > 0) {
    batches.push({ batchNum: batchNum++, skills: currentBatch });
  }

  const plan: Phase3Plan = {
    batches,
    totalSkills: sorted.length,
    skippedAlreadyEval: skipped,
    estimatedCost: `$${Math.round(sorted.length * 0.6)}-$${Math.round(sorted.length * 1.5)}`,
  };

  if (dryRun) {
    console.log(`\n## Phase 3: Output Quality (dry-run)`);
    console.log(`Would evaluate ${plan.totalSkills} skills in ${batches.length} batches`);
    console.log(`Skipping already evaluated: ${skipped.join(', ')}`);
    console.log(`Estimated cost: ${plan.estimatedCost}\n`);
    console.log('| Batch | Skills | Eval Type |');
    console.log('|-------|--------|-----------|');
    for (const batch of batches) {
      const names = batch.skills.map(s => `${s.name} (${s.evalType})`).join(', ');
      console.log(`| ${batch.batchNum} | ${names} |`);
    }
  }

  writeFileSync(join(phase3Dir, 'plan.json'), JSON.stringify(plan, null, 2));
  return plan;
}

// ============================================================================
// Phase 5: Dashboard Aggregation
// ============================================================================

function buildDashboard(batchDir: string, registry: Registry): Dashboard {
  const phase1Dir = join(batchDir, 'phase1-structural');
  const phase2Dir = join(batchDir, 'phase2-trigger');
  const phase3Dir = join(batchDir, 'phase3-output');
  const phase4Dir = join(batchDir, 'phase4-compare');

  const skills: DashboardSkill[] = [];

  for (const entry of registry.entries) {
    const skill: DashboardSkill = {
      name: entry.name,
      path: entry.canonicalPath,
      tier: entry.tier,
      type: entry.type,
      structural: null,
      trigger: null,
      output: null,
      compare: null,
    };

    // Load Phase 1 results
    const p1File = join(phase1Dir, `${entry.name}.json`);
    if (existsSync(p1File)) {
      try {
        const p1: Phase1Result = JSON.parse(readFileSync(p1File, 'utf-8'));
        const dimensionScores: Record<string, number> = {};
        for (const [key, val] of Object.entries(p1.dimensions)) {
          dimensionScores[key] = val.score;
        }
        skill.structural = {
          health: p1.overallHealth,
          score: p1.overallScore,
          dimensions: dimensionScores,
        };
      } catch { /* skip */ }
    }

    // Load Phase 2 results
    const p2File = join(phase2Dir, entry.name, 'results.json');
    if (existsSync(p2File)) {
      try {
        const p2 = JSON.parse(readFileSync(p2File, 'utf-8'));
        skill.trigger = {
          accuracy: p2.test_accuracy ?? p2.accuracy ?? 0,
          improved: p2.improved ?? false,
        };
      } catch { /* skip */ }
    }

    // Load Phase 3 results
    const p3File = join(phase3Dir, entry.name, 'benchmark.json');
    if (existsSync(p3File)) {
      try {
        const p3 = JSON.parse(readFileSync(p3File, 'utf-8'));
        const withSkill = p3.run_summary?.with_skill?.pass_rate?.mean ?? 0;
        const baseline = p3.run_summary?.without_skill?.pass_rate?.mean ?? 0;
        skill.output = {
          withSkill,
          baseline,
          delta: withSkill > 0 && baseline > 0 ? (withSkill - baseline) / baseline : 0,
        };
      } catch { /* skip */ }
    }

    // Load Phase 4 results
    const p4File = join(phase4Dir, `${entry.name}.json`);
    if (existsSync(p4File)) {
      try {
        const p4 = JSON.parse(readFileSync(p4File, 'utf-8'));
        skill.compare = {
          winner: p4.winner ?? 'unknown',
          score: p4.score ?? 0,
        };
      } catch { /* skip */ }
    }

    skills.push(skill);
  }

  // Compute summary
  let green = 0, yellow = 0, red = 0;
  for (const skill of skills) {
    if (skill.structural) {
      if (skill.structural.health === 'GREEN') green++;
      else if (skill.structural.health === 'YELLOW') yellow++;
      else red++;
    }
  }

  return {
    generatedAt: getTimestamp(),
    summary: { total: skills.length, green, yellow, red },
    skills,
    ecosystem: { triggerOverlaps: [], consolidationCandidates: [] },
  };
}

function generateDashboardHtml(dashboard: Dashboard): string {
  const { summary, skills } = dashboard;

  const rows = skills
    .sort((a, b) => {
      // Sort by health (RED first), then by score
      const healthOrder: Record<string, number> = { RED: 0, YELLOW: 1, GREEN: 2 };
      const aHealth = a.structural?.health ?? 'RED';
      const bHealth = b.structural?.health ?? 'RED';
      const hDiff = (healthOrder[aHealth] ?? 3) - (healthOrder[bHealth] ?? 3);
      if (hDiff !== 0) return hDiff;
      return (a.structural?.score ?? 0) - (b.structural?.score ?? 0);
    })
    .map(s => {
      const health = s.structural?.health ?? '—';
      const score = s.structural?.score?.toFixed(1) ?? '—';
      const trigger = s.trigger ? `${(s.trigger.accuracy * 100).toFixed(0)}%` : '—';
      const output = s.output ? `${(s.output.withSkill * 100).toFixed(0)}%` : '—';
      const emoji = health === 'RED' ? '🔴' : health === 'YELLOW' ? '🟡' : health === 'GREEN' ? '🟢' : '⚪';
      return `<tr>
        <td>${emoji} ${s.name}</td>
        <td>${s.path}</td>
        <td>${s.tier}</td>
        <td>${s.type}</td>
        <td>${score}</td>
        <td>${health}</td>
        <td>${trigger}</td>
        <td>${output}</td>
      </tr>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Kaya Batch Skill Evaluation Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; padding: 24px; }
    h1 { color: #58a6ff; margin-bottom: 8px; }
    .summary { display: flex; gap: 16px; margin: 16px 0 24px; }
    .summary .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px 24px; text-align: center; }
    .summary .card .number { font-size: 2em; font-weight: bold; }
    .summary .card .label { color: #8b949e; font-size: 0.9em; }
    .red { color: #f85149; } .yellow { color: #d29922; } .green { color: #3fb950; }
    table { width: 100%; border-collapse: collapse; background: #161b22; border-radius: 8px; overflow: hidden; }
    th { background: #21262d; color: #8b949e; text-align: left; padding: 10px 12px; font-weight: 600; cursor: pointer; }
    th:hover { color: #c9d1d9; }
    td { padding: 8px 12px; border-top: 1px solid #21262d; }
    tr:hover td { background: #1c2128; }
    .meta { color: #8b949e; font-size: 0.85em; margin-top: 16px; }
  </style>
</head>
<body>
  <h1>Kaya Batch Skill Evaluation</h1>
  <p class="meta">Generated: ${dashboard.generatedAt}</p>

  <div class="summary">
    <div class="card"><div class="number">${summary.total}</div><div class="label">Total Skills</div></div>
    <div class="card"><div class="number green">${summary.green}</div><div class="label">GREEN</div></div>
    <div class="card"><div class="number yellow">${summary.yellow}</div><div class="label">YELLOW</div></div>
    <div class="card"><div class="number red">${summary.red}</div><div class="label">RED</div></div>
  </div>

  <table id="dashboard">
    <thead>
      <tr>
        <th onclick="sortTable(0)">Skill</th>
        <th onclick="sortTable(1)">Path</th>
        <th onclick="sortTable(2)">Tier</th>
        <th onclick="sortTable(3)">Type</th>
        <th onclick="sortTable(4)">Score</th>
        <th onclick="sortTable(5)">Health</th>
        <th onclick="sortTable(6)">Trigger %</th>
        <th onclick="sortTable(7)">Output %</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>

  <script>
    let sortDir = {};
    function sortTable(col) {
      const table = document.getElementById('dashboard');
      const tbody = table.querySelector('tbody');
      const rows = Array.from(tbody.querySelectorAll('tr'));
      sortDir[col] = !sortDir[col];
      rows.sort((a, b) => {
        const aVal = a.cells[col].textContent.trim();
        const bVal = b.cells[col].textContent.trim();
        const aNum = parseFloat(aVal);
        const bNum = parseFloat(bVal);
        if (!isNaN(aNum) && !isNaN(bNum)) return sortDir[col] ? aNum - bNum : bNum - aNum;
        return sortDir[col] ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      });
      rows.forEach(r => tbody.appendChild(r));
    }
  </script>
</body>
</html>`;
}

// ============================================================================
// State Management
// ============================================================================

function loadState(batchDir: string): OrchestratorState | null {
  const statePath = join(batchDir, 'state.json');
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return null;
  }
}

function saveState(state: OrchestratorState): void {
  state.lastUpdated = getTimestamp();
  writeFileSync(join(state.batchDir, 'state.json'), JSON.stringify(state, null, 2));
}

function initState(batchDir: string, registry: Registry): OrchestratorState {
  const skills: Record<string, SkillPhaseState> = {};
  for (const entry of registry.entries) {
    skills[entry.name] = {
      phase1: 'pending',
      phase2: 'pending',
      phase3: entry.alreadyEvaluated ? 'skipped' : 'pending',
      phase4: 'pending',
    };
  }

  return {
    startedAt: getTimestamp(),
    lastUpdated: getTimestamp(),
    batchDir,
    registry,
    skills,
    phase5: 'pending',
  };
}

// ============================================================================
// CLI
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const phaseArg = args[args.indexOf('--phase') + 1] || 'all';
  const parallelIdx = args.indexOf('--parallel');
  const parallelArg = parallelIdx >= 0 ? parseInt(args[parallelIdx + 1], 10) : 6;
  const dryRun = args.includes('--dry-run');
  const jsonOutput = args.includes('--json');

  const batchDirArg = args.indexOf('--batch-dir') >= 0
    ? args[args.indexOf('--batch-dir') + 1]
    : null;

  const batchDir = batchDirArg || join(SKILL_AUDITS_DIR, `batch-eval-${getDateString()}`);
  ensureDirectory(batchDir);

  // Phase 0: Build registry
  const registry = buildRegistry();

  if (phaseArg === '0') {
    const registryPath = join(batchDir, 'registry.json');
    writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    if (jsonOutput) {
      console.log(JSON.stringify(registry, null, 2));
    } else {
      console.log(`# Batch Eval Registry\n`);
      console.log(`Generated: ${registry.generatedAt}`);
      console.log(`Leaf skills: ${registry.totalLeaf}`);
      console.log(`Category routers: ${registry.totalRouter}`);
      console.log(`Duplicates removed: ${registry.duplicatesRemoved.join(', ')}\n`);

      console.log('| Skill | Path | Type | Tier | Already Eval |');
      console.log('|-------|------|------|------|--------------|');
      for (const entry of registry.entries) {
        console.log(`| ${entry.name} | ${entry.canonicalPath} | ${entry.type} | ${entry.tier} | ${entry.alreadyEvaluated ? 'yes' : 'no'} |`);
      }

      console.log(`\nRegistry saved: ${registryPath}`);
    }
    return;
  }

  // Initialize or load state
  let state = loadState(batchDir);
  if (!state) {
    state = initState(batchDir, registry);
    saveState(state);
  }

  // Save registry
  writeFileSync(join(batchDir, 'registry.json'), JSON.stringify(registry, null, 2));

  if (dryRun) {
    console.log(`# Batch Eval Execution Plan (dry-run)\n`);
    console.log(`Batch directory: ${batchDir}`);
    console.log(`Leaf skills: ${registry.totalLeaf}`);
    console.log(`Category routers: ${registry.totalRouter}`);
    console.log(`Parallel workers: ${parallelArg}\n`);
  }

  // Phase 1: Structural
  if (phaseArg === '1' || phaseArg === 'all') {
    if (!dryRun) console.log(`\n## Phase 1: Structural Audit`);
    const phase1Results = await runPhase1(registry, batchDir, dryRun);

    if (!dryRun) {
      for (const result of phase1Results) {
        if (state.skills[result.skillName]) {
          state.skills[result.skillName].phase1 = result.overallScore > 0 ? 'done' : 'failed';
        }
      }
      saveState(state);
    }

    // If running just phase 1, also plan phases 2 & 3
    if (phaseArg === '1' || phaseArg === 'all') {
      planPhase2(registry, phase1Results, dryRun, batchDir);
      planPhase3(registry, phase1Results, dryRun, batchDir);
    }
  }

  // Phase 2: Trigger accuracy (plan only — execution requires subagents)
  if (phaseArg === '2') {
    // Load phase 1 results for triage
    const phase1Dir = join(batchDir, 'phase1-structural');
    const phase1Results: Phase1Result[] = [];
    if (existsSync(phase1Dir)) {
      for (const file of readdirSync(phase1Dir).filter(f => f.endsWith('.json'))) {
        try {
          phase1Results.push(JSON.parse(readFileSync(join(phase1Dir, file), 'utf-8')));
        } catch { /* skip */ }
      }
    }
    planPhase2(registry, phase1Results, dryRun, batchDir);
  }

  // Phase 3: Output quality (plan only)
  if (phaseArg === '3') {
    const phase1Dir = join(batchDir, 'phase1-structural');
    const phase1Results: Phase1Result[] = [];
    if (existsSync(phase1Dir)) {
      for (const file of readdirSync(phase1Dir).filter(f => f.endsWith('.json'))) {
        try {
          phase1Results.push(JSON.parse(readFileSync(join(phase1Dir, file), 'utf-8')));
        } catch { /* skip */ }
      }
    }
    planPhase3(registry, phase1Results, dryRun, batchDir);
  }

  // Phase 5: Dashboard
  if (phaseArg === '5' || phaseArg === 'all') {
    if (!dryRun) {
      console.log(`\n## Phase 5: Dashboard Aggregation`);
      const dashboard = buildDashboard(batchDir, registry);

      const dashboardJsonPath = join(batchDir, 'dashboard.json');
      const dashboardHtmlPath = join(batchDir, 'dashboard.html');

      writeFileSync(dashboardJsonPath, JSON.stringify(dashboard, null, 2));
      writeFileSync(dashboardHtmlPath, generateDashboardHtml(dashboard));

      console.log(`  Dashboard JSON: ${dashboardJsonPath}`);
      console.log(`  Dashboard HTML: ${dashboardHtmlPath}`);
      console.log(`  Summary: ${dashboard.summary.green} GREEN, ${dashboard.summary.yellow} YELLOW, ${dashboard.summary.red} RED`);

      state.phase5 = 'done';
      saveState(state);
    } else {
      console.log(`\n## Phase 5: Dashboard Aggregation (dry-run)`);
      console.log(`Would aggregate results from phases 1-4 into dashboard.json and dashboard.html`);
    }
  }

  if (dryRun) {
    console.log(`\n## Cost Estimate`);
    console.log(`| Phase | Estimated Cost |`);
    console.log(`|-------|----------------|`);
    console.log(`| 1: Structural | ~$0.50 |`);
    console.log(`| 2: Trigger | $165-330 |`);
    console.log(`| 3: Output | $23-57 |`);
    console.log(`| 4: Compare | $12-30 |`);
    console.log(`| 5: Aggregate | $0 |`);
    console.log(`| **Total** | **$200-420** |`);
  }
}

if (import.meta.main) {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

export {
  buildRegistry,
  discoverAllSkills,
  runPhase1,
  runPhase1ForSkill,
  planPhase2,
  planPhase3,
  buildDashboard,
  generateDashboardHtml,
  loadState,
  saveState,
  initState,
};

export type {
  Registry,
  RegistryEntry,
  Phase1Result,
  Phase2Plan,
  Phase3Plan,
  Dashboard,
  DashboardSkill,
  OrchestratorState,
  SkillPhaseState,
  EvalTier,
  SkillType,
};
