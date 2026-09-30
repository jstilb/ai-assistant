/**
 * Skills.ts — Shared types for skill configuration and invocation.
 *
 * Usage:
 *   import { SkillConfig, SkillInvocationResult } from 'lib/interfaces/Skills';
 */

export interface SkillConfig {
  /** Skill name (e.g., 'System', 'SkillAudit') */
  name: string;
  /** Path to the skill entry point */
  path?: string;
  /** Default timeout in ms */
  timeout?: number;
  /** Default model override */
  model?: string;
  /** Whether this skill requires network access */
  requiresNetwork?: boolean;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

export type SkillMapEntry = SkillConfig;

/** Map of skill names to their configs */
export type SkillMap = Record<string, SkillMapEntry>;

export interface SkillInvocationParams {
  skill: string;
  args?: string;
  timeout?: number;
  cwd?: string;
  model?: string;
}

export interface SkillInvocationResult {
  success: boolean;
  output?: string;
  error?: string;
  exitCode?: number;
  durationMs?: number;
}
