#!/usr/bin/env bun
/**
 * Shared constants for SkillAudit tools
 *
 * Centralized path definitions and configuration to ensure
 * consistency across all SkillAudit tools.
 */

import { join } from 'path';

// Base directories
export const KAYA_HOME = process.env.HOME ? join(process.env.HOME, '.claude') : '';
export const SKILLS_DIR = join(KAYA_HOME, 'skills');
export const MEMORY_DIR = join(KAYA_HOME, 'MEMORY');
export const SKILL_AUDITS_DIR = join(MEMORY_DIR, 'SkillAudits');

// Index files
export const SKILL_INDEX_PATH = join(SKILLS_DIR, 'skill-index.json');

// Thresholds and configuration
export const TRIGGER_OVERLAP_THRESHOLD = 60; // % overlap to recommend consolidation
export const MIN_TRIGGER_OVERLAP_DISPLAY = 30; // % overlap to show in matrix
export const MAX_WORKFLOWS_IDEAL = 7; // More than this suggests over-abstraction
export const MIN_LINES_SUBSTANTIAL = 50; // Lines for a "substantial" skill
export const MAX_COMBINED_LINES = 150; // Combined lines threshold for merge recommendation

// Scoring weights
export const SCORING = {
  implementation: {
    missingTitleCase: -1,
    missingSkillMd: -3,
    missingFrontmatter: -1,
    missingCustomization: -0.5,
    missingVoiceNotification: -0.5,
    excessiveDepth: -1,
    missingDescription: -1,
    missingTriggers: -1,
    missingWorkflowTable: -0.5,
    missingExamples: -1,
    fewExamples: -0.5,
    noWorkflowsWithContent: -0.5,
  },
} as const;

// Gap level definitions
export type GapLevel = 'HIGH' | 'MEDIUM' | 'LOW';
export type RedundancyType = 'code' | 'workflow' | 'tool' | 'trigger';
export type ImpactLevel = 'HIGH' | 'MEDIUM' | 'LOW';
