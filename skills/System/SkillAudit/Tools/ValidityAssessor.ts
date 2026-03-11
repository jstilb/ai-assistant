#!/usr/bin/env bun
/**
 * ValidityAssessor - Determine if a skill is still needed, active, and unique
 *
 * Scores Dimension 4: Skill Validity.
 * Gathers deterministic evidence of use, uniqueness, and deprecation markers.
 * The LLM evaluation layer uses this structured output to apply judgment about
 * whether the skill's purpose is still relevant and distinct.
 *
 * Usage:
 *   bun run ValidityAssessor.ts <skill-name>
 *   bun run ValidityAssessor.ts Browser
 *   bun run ValidityAssessor.ts Browser --json
 */

import { existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { SKILLS_DIR, MEMORY_DIR, SETTINGS_PATH, HOOKS_DIR, SCORING } from './constants';
import { getSkillDirectories, getSkillPath, getSkillFiles, safeReadFile, skillExists, extractTriggers } from './utils';
import { extractDependenciesFromContent } from './DependencyMapper';
import type { Finding, Recommendation, DimensionResult } from './report-builder';
import { buildDimensionResult } from './report-builder';

// ============================================================================
// Types
// ============================================================================

export interface ValidityResult {
  skillName: string;
  score: number;
  dimensionResult: DimensionResult;
  details: {
    referencedBySkills: string[];
    referencedInHooks: boolean;
    recentWorkSessions: number;
    uniqueTriggers: string[];
    sharedTriggers: string[];
    deprecationMarkers: string[];
    isDeprecated: boolean;
  };
}

// ============================================================================
// Evidence Collection
// ============================================================================

/**
 * Find all skills that declare a dependency on the target skill.
 */
function findReferencingSkills(targetSkill: string): string[] {
  const referencing: string[] = [];
  const allSkills = getSkillDirectories();

  for (const skillName of allSkills) {
    if (skillName === targetSkill) continue;

    const skillMdPath = join(getSkillPath(skillName), 'SKILL.md');
    const content = safeReadFile(skillMdPath);
    if (!content) continue;

    const deps = extractDependenciesFromContent(content);
    const refsTarget = deps.uses.includes(targetSkill) || deps.feedsInto.includes(targetSkill);

    // Also do a raw string check for mentions in the markdown
    const mentionsTarget = content.includes(`**${targetSkill}**`) || content.includes(`[${targetSkill}]`);

    if (refsTarget || mentionsTarget) {
      referencing.push(skillName);
    }
  }

  return referencing;
}

/**
 * Check settings.json and hooks/ directory for any reference to this skill.
 */
function checkHookReferences(skillName: string): boolean {
  const lowerSkill = skillName.toLowerCase();

  // Check settings.json
  const settingsContent = safeReadFile(SETTINGS_PATH);
  if (settingsContent && settingsContent.toLowerCase().includes(lowerSkill)) {
    try {
      const parsed = JSON.parse(settingsContent) as Record<string, unknown>;
      const hooks = parsed['hooks'];
      if (hooks && JSON.stringify(hooks).toLowerCase().includes(lowerSkill)) {
        return true;
      }
    } catch {
      // JSON parse failed — scope search to hooks key context only
      const hooksMatch = settingsContent.match(/"hooks"\s*:\s*\{[\s\S]*?\}/);
      if (hooksMatch && hooksMatch[0].toLowerCase().includes(lowerSkill)) {
        return true;
      }
    }
  }

  // Check hooks/ directory
  if (!existsSync(HOOKS_DIR)) return false;

  try {
    const entries = readdirSync(HOOKS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const content = safeReadFile(join(HOOKS_DIR, entry.name));
        if (content && content.toLowerCase().includes(lowerSkill)) {
          return true;
        }
      }
    }
  } catch {
    // Ignore
  }

  return false;
}

/**
 * Scan MEMORY/WORK/ for recent work sessions that mention this skill.
 * Checks the last 20 directories by modification order.
 */
function countRecentWorkSessions(skillName: string): number {
  const workDir = join(MEMORY_DIR, 'WORK');
  if (!existsSync(workDir)) return 0;

  const lowerSkill = skillName.toLowerCase();
  let count = 0;

  try {
    const entries = readdirSync(workDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
      .reverse()
      .slice(0, 20); // Last 20 directories

    for (const dirName of entries) {
      // Check if the directory name itself mentions the skill
      if (dirName.toLowerCase().includes(lowerSkill)) {
        count++;
        continue;
      }

      // Check key files within the work session directory
      const sessionDir = join(workDir, dirName);
      const filesToCheck = ['THREAD.md', 'ISC.json', 'tasks.md'];

      let found = false;
      for (const fileName of filesToCheck) {
        if (found) break;
        const content = safeReadFile(join(sessionDir, fileName));
        if (content && content.toLowerCase().includes(lowerSkill)) {
          found = true;
        }
      }

      // Also scan tasks/ subdirectory if it exists
      if (!found) {
        const tasksDir = join(sessionDir, 'tasks');
        if (existsSync(tasksDir)) {
          try {
            const taskEntries = readdirSync(tasksDir, { withFileTypes: true });
            for (const taskEntry of taskEntries) {
              if (found) break;
              if (taskEntry.isDirectory()) {
                const threadPath = join(tasksDir, taskEntry.name, 'THREAD.md');
                const iscPath = join(tasksDir, taskEntry.name, 'ISC.json');
                for (const path of [threadPath, iscPath]) {
                  const content = safeReadFile(path);
                  if (content && content.toLowerCase().includes(lowerSkill)) {
                    found = true;
                    break;
                  }
                }
              }
            }
          } catch {
            // Ignore errors reading tasks subdirectory
          }
        }
      }

      if (found) count++;
    }
  } catch {
    // Ignore read errors
  }

  return count;
}

/**
 * Get all triggers claimed by a skill and compare against the full ecosystem.
 * Returns { uniqueTriggers, sharedTriggers }.
 */
function analyzeTriggerUniqueness(
  skillName: string
): { uniqueTriggers: string[]; sharedTriggers: string[] } {
  const skillMdPath = join(getSkillPath(skillName), 'SKILL.md');
  const ownContent = safeReadFile(skillMdPath);
  if (!ownContent) return { uniqueTriggers: [], sharedTriggers: [] };

  const ownTriggers = new Set(extractTriggers(ownContent).map(t => t.toLowerCase()));
  if (ownTriggers.size === 0) return { uniqueTriggers: [], sharedTriggers: [] };

  // Build ecosystem trigger map
  const triggerToSkills = new Map<string, string[]>();
  const allSkills = getSkillDirectories();

  for (const otherSkill of allSkills) {
    if (otherSkill === skillName) continue;
    const otherPath = join(getSkillPath(otherSkill), 'SKILL.md');
    const otherContent = safeReadFile(otherPath);
    if (!otherContent) continue;

    const otherTriggers = extractTriggers(otherContent).map(t => t.toLowerCase());
    for (const trigger of otherTriggers) {
      if (!triggerToSkills.has(trigger)) {
        triggerToSkills.set(trigger, []);
      }
      triggerToSkills.get(trigger)!.push(otherSkill);
    }
  }

  const uniqueTriggers: string[] = [];
  const sharedTriggers: string[] = [];

  for (const trigger of ownTriggers) {
    if (triggerToSkills.has(trigger)) {
      sharedTriggers.push(trigger);
    } else {
      uniqueTriggers.push(trigger);
    }
  }

  return { uniqueTriggers, sharedTriggers };
}

/**
 * Check for deprecation markers in the skill's name, directory, and content.
 */
function findDeprecationMarkers(skillName: string): string[] {
  const markers: string[] = [];

  // Check skill name itself
  if (skillName.toUpperCase().includes('DEPRECATED')) {
    markers.push('Skill name contains DEPRECATED');
  }

  // Check directory name pattern (e.g., _SkillName, SkillName_DEPRECATED)
  if (skillName.endsWith('_DEPRECATED') || skillName.startsWith('_')) {
    markers.push(`Directory name indicates deprecated state: ${skillName}`);
  }

  // Check SKILL.md content
  const skillMdPath = join(getSkillPath(skillName), 'SKILL.md');
  const content = safeReadFile(skillMdPath);
  if (content) {
    const lowerContent = content.toLowerCase();

    if (lowerContent.includes('deprecated')) {
      // Find the specific line for better context
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes('deprecated')) {
          markers.push(`SKILL.md line ${i + 1}: ${lines[i].trim().slice(0, 80)}`);
          break; // One marker per file is sufficient
        }
      }
    }

    if (lowerContent.includes('do not use') || lowerContent.includes('use instead')) {
      markers.push('SKILL.md contains "do not use" or "use instead" directive');
    }

    if (lowerContent.includes('merged into') || lowerContent.includes('replaced by')) {
      markers.push('SKILL.md indicates skill was merged or replaced');
    }
  }

  return markers;
}

// ============================================================================
// Scoring
// ============================================================================

/**
 * Compute validity score from collected evidence.
 *
 * Scoring heuristic:
 *   10:   active + unique + frequently referenced
 *   7–9:  active but some trigger overlap
 *   4–6:  rarely referenced but unique purpose
 *   1–3:  appears absorbed/deprecated or shelf-ware
 */
function computeValidityScore(
  referencedBySkills: string[],
  referencedInHooks: boolean,
  recentWorkSessions: number,
  uniqueTriggers: string[],
  sharedTriggers: string[],
  isDeprecated: boolean
): number {
  const V = SCORING.skillValidity;

  if (isDeprecated) return V.deprecatedFloor;

  let score = V.baseline;

  // Evidence of active use
  if (referencedBySkills.length >= V.highRefThreshold) score += V.highRefBonus;
  else if (referencedBySkills.length >= 1) score += V.someRefBonus;

  if (referencedInHooks) score += V.hookRefBonus;

  if (recentWorkSessions >= V.highUsageThreshold) score += V.highUsageBonus;
  else if (recentWorkSessions >= V.someUsageThreshold) score += V.someUsageBonus;

  // Trigger uniqueness
  const totalTriggers = uniqueTriggers.length + sharedTriggers.length;
  if (totalTriggers > 0) {
    const uniquenessRatio = uniqueTriggers.length / totalTriggers;
    if (uniquenessRatio >= V.highUniquenessThreshold) score += V.highUniquenessBonus;
    else if (uniquenessRatio < V.lowUniquenessThreshold && totalTriggers >= V.minTriggersForUniqueness) score += V.lowUniquenessPenalty;
  }

  // No evidence of use at all
  if (
    referencedBySkills.length === 0 &&
    !referencedInHooks &&
    recentWorkSessions === 0
  ) {
    score += V.noEvidencePenalty;
  }

  return Math.min(10, Math.max(1, score));
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Assess the validity of a skill — is it still needed, active, and unique?
 */
export function assessValidity(skillName: string): ValidityResult | null {
  if (!skillExists(skillName)) {
    return null;
  }

  // 1. Evidence collection
  const referencedBySkills = findReferencingSkills(skillName);
  const referencedInHooks = checkHookReferences(skillName);
  const recentWorkSessions = countRecentWorkSessions(skillName);
  const { uniqueTriggers, sharedTriggers } = analyzeTriggerUniqueness(skillName);
  const deprecationMarkers = findDeprecationMarkers(skillName);
  const isDeprecated = deprecationMarkers.length > 0;

  // 2. Score
  const score = computeValidityScore(
    referencedBySkills,
    referencedInHooks,
    recentWorkSessions,
    uniqueTriggers,
    sharedTriggers,
    isDeprecated
  );

  // 3. Findings and recommendations
  const findings: Finding[] = [];
  const recommendations: Recommendation[] = [];

  if (isDeprecated) {
    findings.push({
      description: `Skill has ${deprecationMarkers.length} deprecation marker(s): ${deprecationMarkers[0]}`,
      location: `${skillName}/SKILL.md`,
      severity: 'HIGH',
    });
    recommendations.push({
      action: 'Archive or delete this skill — it is marked deprecated',
      priority: 'P1',
      effort: 'S',
      impact: 'HIGH',
      dimension: 'skillValidity',
    });
  }

  if (!isDeprecated && referencedBySkills.length === 0 && recentWorkSessions === 0 && !referencedInHooks) {
    findings.push({
      description: 'Skill has no references from other skills, hooks, or recent work sessions',
      severity: 'HIGH',
    });
    recommendations.push({
      action: 'Investigate whether this skill is actively used. Consider deprecating if unused.',
      priority: 'P2',
      effort: 'S',
      impact: 'MEDIUM',
      dimension: 'skillValidity',
    });
  }

  if (!isDeprecated && sharedTriggers.length > 0 && uniqueTriggers.length === 0) {
    findings.push({
      description: `All ${sharedTriggers.length} trigger(s) are shared with other skills — no unique routing identity`,
      severity: 'MEDIUM',
    });
    recommendations.push({
      action: 'Add distinct USE WHEN triggers that differentiate this skill from overlapping skills',
      priority: 'P2',
      effort: 'S',
      impact: 'MEDIUM',
      dimension: 'skillValidity',
    });
  }

  if (!isDeprecated && recentWorkSessions === 0 && referencedBySkills.length === 0) {
    findings.push({
      description: 'No evidence of recent use in MEMORY/WORK sessions',
      severity: 'LOW',
    });
  }

  if (!isDeprecated && score >= 7 && referencedBySkills.length >= 2) {
    // Healthy skill — note it
    findings.push({
      description: `Actively used skill referenced by ${referencedBySkills.length} other skill(s) with ${recentWorkSessions} recent work session(s)`,
      severity: 'LOW',
    });
  }

  const dimensionResult = buildDimensionResult(score, findings, recommendations);

  return {
    skillName,
    score,
    dimensionResult,
    details: {
      referencedBySkills,
      referencedInHooks,
      recentWorkSessions,
      uniqueTriggers,
      sharedTriggers,
      deprecationMarkers,
      isDeprecated,
    },
  };
}

// ============================================================================
// CLI Interface
// ============================================================================

function printReport(result: ValidityResult): void {
  console.log(`# Validity Assessment: ${result.skillName}\n`);
  console.log(`**Score:** ${result.score} / 10`);
  console.log(`**Health:** ${result.dimensionResult.health}`);
  console.log(`**Deprecated:** ${result.details.isDeprecated ? 'YES' : 'No'}\n`);

  const d = result.details;

  console.log('## Evidence Summary\n');
  console.log(`- **Referenced By Skills:** ${d.referencedBySkills.length > 0 ? d.referencedBySkills.join(', ') : 'none'}`);
  console.log(`- **Referenced In Hooks:** ${d.referencedInHooks ? 'yes' : 'no'}`);
  console.log(`- **Recent Work Sessions (last 20):** ${d.recentWorkSessions}`);
  console.log(`- **Unique Triggers:** ${d.uniqueTriggers.length} (${d.uniqueTriggers.slice(0, 5).join(', ') || 'none'})`);
  console.log(`- **Shared Triggers:** ${d.sharedTriggers.length} (${d.sharedTriggers.slice(0, 5).join(', ') || 'none'})`);
  console.log('');

  if (d.deprecationMarkers.length > 0) {
    console.log('## Deprecation Markers\n');
    for (const marker of d.deprecationMarkers) {
      console.log(`- ${marker}`);
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
    console.log('Usage: bun run ValidityAssessor.ts <skill-name>');
    console.log('       bun run ValidityAssessor.ts Browser');
    console.log('       bun run ValidityAssessor.ts Browser --json');
    process.exit(1);
  }

  const result = assessValidity(skillName);

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
