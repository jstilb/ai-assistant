#!/usr/bin/env bun
/**
 * Shared constants for SkillAudit v2 tools
 *
 * All weights, thresholds, paths, scoring deductions, and dimension definitions.
 * Single source of truth for the 11-dimension evaluation framework.
 */

import { join } from 'path';

// ============================================================================
// Base Directories
// ============================================================================

export const KAYA_HOME = process.env.HOME ? join(process.env.HOME, '.claude') : '';
export const SKILLS_DIR = join(KAYA_HOME, 'skills');
export const MEMORY_DIR = join(KAYA_HOME, 'MEMORY');
export const SKILL_AUDITS_DIR = join(MEMORY_DIR, 'SkillAudits');
export const LEARNING_DIR = join(MEMORY_DIR, 'LEARNING');
export const LEARNING_SYSTEM_DIR = join(LEARNING_DIR, 'SYSTEM');
export const SETTINGS_PATH = join(KAYA_HOME, 'settings.json');
export const HOOKS_DIR = join(KAYA_HOME, 'hooks');

// ============================================================================
// Thresholds and Configuration
// ============================================================================

export const TRIGGER_OVERLAP_THRESHOLD = 60; // % overlap to recommend consolidation
export const TRIGGER_OVERLAP_CONSOLIDATION = 40; // % overlap to flag as candidate
export const MIN_TRIGGER_OVERLAP_DISPLAY = 30; // % overlap to show in matrix
export const MAX_WORKFLOWS_IDEAL = 7; // More than this suggests over-abstraction
export const MIN_LINES_SUBSTANTIAL = 50; // Lines for a "substantial" skill
export const MAX_COMBINED_LINES = 150; // Combined lines threshold for merge recommendation
export const MAX_DESCRIPTION_TOKENS = 50; // Ideal max tokens for SKILL.md description
export const TOKEN_EXCESS_PENALTY_PER = 20; // Deduct per this many excess tokens
export const CODE_DUPLICATION_MIN_CHARS = 100; // Min chars for a significant duplicate block
export const EXPECTED_CONNECTIONS = 10; // Well-integrated skill baseline for scoring

// ============================================================================
// The 11 Dimensions
// ============================================================================

export type DimensionName =
  | 'behavioralFidelity'
  | 'implementationQuality'
  | 'integrationFitness'
  | 'skillValidity'
  | 'contextEfficiency'
  | 'codeHygiene'
  | 'refactoringNeed'
  | 'contextRouting'
  | 'complexity'
  | 'learningMemory'
  | 'agentBalance';

export type HealthStatus = 'GREEN' | 'YELLOW' | 'RED';
export type GapLevel = 'HIGH' | 'MEDIUM' | 'LOW';
export type RedundancyType = 'code' | 'workflow' | 'tool' | 'trigger';
export type ImpactLevel = 'HIGH' | 'MEDIUM' | 'LOW';
export type Priority = 'P1' | 'P2' | 'P3';
export type Effort = 'S' | 'M' | 'L';

export interface DimensionDefinition {
  number: number;
  name: string;
  key: DimensionName;
  weight: number;
  type: 'deterministic' | 'inferential' | 'hybrid';
  description: string;
}

export const DIMENSIONS: Record<DimensionName, DimensionDefinition> = {
  behavioralFidelity: {
    number: 1,
    name: 'Behavioral Fidelity',
    key: 'behavioralFidelity',
    weight: 0.15,
    type: 'inferential',
    description: 'How closely actual implementation matches documentation',
  },
  implementationQuality: {
    number: 2,
    name: 'Implementation Quality',
    key: 'implementationQuality',
    weight: 0.10,
    type: 'deterministic',
    description: 'CreateSkill compliance and structural quality',
  },
  integrationFitness: {
    number: 3,
    name: 'Integration Fitness',
    key: 'integrationFitness',
    weight: 0.10,
    type: 'hybrid',
    description: 'Dependency connections and missed integration opportunities',
  },
  skillValidity: {
    number: 4,
    name: 'Skill Validity',
    key: 'skillValidity',
    weight: 0.10,
    type: 'inferential',
    description: 'Whether skill is still needed, active, and unique',
  },
  contextEfficiency: {
    number: 5,
    name: 'Context Efficiency',
    key: 'contextEfficiency',
    weight: 0.08,
    type: 'deterministic',
    description: 'Token cost and trigger precision',
  },
  codeHygiene: {
    number: 6,
    name: 'Code Hygiene',
    key: 'codeHygiene',
    weight: 0.10,
    type: 'deterministic',
    description: 'Dead code, orphaned files, stale references',
  },
  refactoringNeed: {
    number: 7,
    name: 'Refactoring Need',
    key: 'refactoringNeed',
    weight: 0.08,
    type: 'deterministic',
    description: 'Convention violations and code duplication',
  },
  contextRouting: {
    number: 8,
    name: 'Context Routing',
    key: 'contextRouting',
    weight: 0.07,
    type: 'deterministic',
    description: 'Trigger overlap with other skills',
  },
  complexity: {
    number: 9,
    name: 'Complexity',
    key: 'complexity',
    weight: 0.07,
    type: 'hybrid',
    description: 'LOC vs value, unnecessary abstractions',
  },
  learningMemory: {
    number: 10,
    name: 'Learning & Memory',
    key: 'learningMemory',
    weight: 0.08,
    type: 'hybrid',
    description: 'Bidirectional learning integration with MEMORY system',
  },
  agentBalance: {
    number: 11,
    name: 'Agent Balance',
    key: 'agentBalance',
    weight: 0.07,
    type: 'inferential',
    description: 'Deterministic vs inferential boundary correctness',
  },
} as const;

// ============================================================================
// Scoring Deductions
// ============================================================================

export const SCORING = {
  // Dimension 2: Implementation Quality (deterministic)
  implementation: {
    missingSkillMd: -3,
    missingFrontmatter: -1,
    missingTitleCase: -1,
    missingDescription: -1,
    missingTriggers: -1,
    missingCustomization: -0.5,
    missingVoiceNotification: -0.5,
    missingWorkflowTable: -0.5,
    missingExamples: -1,
    fewExamples: -0.5,
    excessiveDepth: -1,
    noWorkflowsWithContent: -0.5,
  },

  // Dimension 1: Behavioral Fidelity (inferential)
  behavioralFidelity: {
    highGap: -2,
    mediumGap: -1,
    lowGap: -0.5,
  },

  // Dimension 3: Integration Fitness
  integrationFitness: {
    hookWeight: 2.0,
    bidirectionalDepWeight: 1.5,
    usesWeight: 1.0,
    usedByWeight: 0.5,
    mcpWeight: 1.0,
  },

  // Dimension 4: Skill Validity
  skillValidity: {
    deprecatedFloor: 1,
    baseline: 5,
    highRefBonus: 2,         // referencedBySkills >= 3
    highRefThreshold: 3,
    someRefBonus: 1,         // referencedBySkills >= 1
    hookRefBonus: 1,
    highUsageBonus: 2,       // recentWorkSessions >= 5
    highUsageThreshold: 5,
    someUsageBonus: 1,       // recentWorkSessions >= 2
    someUsageThreshold: 2,
    highUniquenessBonus: 1,  // uniquenessRatio >= 0.8
    highUniquenessThreshold: 0.8,
    lowUniquenessPenalty: -1, // uniquenessRatio < 0.3 && triggers >= 3
    lowUniquenessThreshold: 0.3,
    minTriggersForUniqueness: 3,
    noEvidencePenalty: -2,
  },

  // Dimension 5: Context Efficiency (deterministic)
  contextEfficiency: {
    perExcessTokens: -1,       // per 20 tokens over MAX_DESCRIPTION_TOKENS
    ambiguousTrigger: -1,      // per ambiguous trigger word
    falsePositiveTrigger: -2,  // per known false-positive-prone trigger
    missingUseWhen: -2,
  },

  // Dimension 6: Code Hygiene (deterministic)
  codeHygiene: {
    orphanedFile: -1,
    unusedExport: -0.5,
    staleReference: -0.5,
    unaddressedTodo: -0.5,
    deprecatedOutsideDir: -1,
    unreachableCode: -0.5,
  },

  // Dimension 7: Refactoring Need (deterministic)
  refactoring: {
    rawFetch: -2,
    rawJsonParse: -2,
    anyType: -1,
    tsIgnore: -1,
    codeDuplication: -1,      // per block >100 chars
    inconsistentPattern: -0.5,
  },

  // Dimension 8: Context Routing (deterministic)
  contextRouting: {
    highOverlap: -2,          // per skill with >60% overlap
    mediumOverlap: -1,        // per skill with >40% overlap
    missingUseWhen: -1,
    longDescription: -1,      // description >200 chars
  },

  // Dimension 9: Complexity (hybrid)
  complexity: {
    unnecessaryAbstraction: -1,
    tooManyWorkflows: -1,     // >7 workflows
    highLocSimplePurpose: -1, // >300 LOC with simple purpose
    overParameterized: -1,
  },

  // Dimension 10: Learning & Memory (hybrid)
  learningMemory: {
    noIntegrationWhereNeeded: -9,    // no integration when clearly should have
    writeOnlyOrReadOnly: -5,         // writes but doesn't read or vice versa
  },

  // Dimension 11: Agent Balance (inferential)
  agentBalance: {
    llmWhereRegexSuffices: -2,
    regexWhereJudgmentNeeded: -2,
    hookEligibleAsToolInstead: -1,
  },
} as const;

// ============================================================================
// Health Thresholds
// ============================================================================

export const HEALTH_THRESHOLDS = {
  // RED: Any dimension <3 OR >=3 dimensions below 5
  redAnyBelow: 3,
  redCountBelow5: 3,  // number of dimensions below 5 that triggers RED

  // YELLOW: >=2 dimensions below 6
  yellowCountBelow6: 2,

  // GREEN: All dimensions >=5 and <2 below 6
} as const;

// ============================================================================
// Known Ambiguous / False-Positive Trigger Words
// ============================================================================

export const AMBIGUOUS_TRIGGERS = [
  'help', 'show', 'get', 'run', 'check', 'list', 'find', 'make',
  'create', 'update', 'delete', 'add', 'remove', 'set', 'start', 'stop',
];

export const FALSE_POSITIVE_TRIGGERS = [
  'do', 'it', 'this', 'that', 'thing', 'stuff', 'work', 'use',
];

// ============================================================================
// Hook Lifecycle Events
// ============================================================================

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'SessionEnd',
] as const;

export type HookEvent = typeof HOOK_EVENTS[number];

// ============================================================================
// Convention Patterns (for ConventionChecker)
// ============================================================================

export const CONVENTION_VIOLATIONS = {
  rawFetch: /(?<!\.)fetch\s*\(/,
  rawJsonParseReadFile: /JSON\.parse\(\s*readFileSync/,
  anyType: /:\s*any\b/,
  tsIgnore: /@ts-ignore/,
  tsExpectError: /@ts-expect-error/,
  consoleError: /console\.error\(/,
} as const;

