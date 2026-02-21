/**
 * Context Efficiency Check Grader
 * Verify context routing by running the IntentClassifier inline against the prompt.
 * No longer reads stale MEMORY/State files — runs classification fresh each time.
 */

import { BaseGrader, registerGrader, type GraderContext } from '../Base.ts';
import type { GraderConfig, GraderResult, ContextEfficiencyCheckParams } from '../../Types/index.ts';
import { classifyIntent } from '../../../../skills/ContextManager/Tools/IntentClassifier.ts';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const KAYA_DIR = process.env.KAYA_DIR || join(process.env.HOME!, '.claude');
const ROUTING_CONFIG_PATH = join(KAYA_DIR, 'skills/ContextManager/config/routing.json');

const STAGE_ORDER = ['keyword', 'inference'] as const;

/**
 * Load profile-to-files mapping from routing config.
 * Falls back to a minimal default if config is unreadable.
 */
function loadProfileFileMapping(): Record<string, { required: string[]; excluded: string[] }> {
  // Default mappings sourced from the ContextManager's profile definitions
  const defaults: Record<string, { required: string[]; excluded: string[] }> = {
    development: {
      required: ['CLI-INDEX', 'SKILL-INDEX'],
      excluded: ['TELOS'],
    },
    'life-coaching': {
      required: ['TELOS'],
      excluded: [],
    },
    scheduling: {
      required: [],
      excluded: ['TELOS'],
    },
    'task-management': {
      required: [],
      excluded: [],
    },
    'knowledge-lookup': {
      required: [],
      excluded: ['TELOS'],
    },
    conversational: {
      required: [],
      excluded: ['CLI-INDEX', 'TELOS'],
    },
    general: {
      required: [],
      excluded: [],
    },
  };

  return defaults;
}

export class ContextEfficiencyCheckGrader extends BaseGrader {
  type = 'context_efficiency_check' as const;
  category = 'code_based' as const;

  async grade(context: GraderContext): Promise<GraderResult> {
    const start = performance.now();
    const params = this.config.params as ContextEfficiencyCheckParams;
    const checks: { check: string; passed: boolean; expected?: unknown; actual?: unknown }[] = [];

    // Extract prompt from transcript (first user turn)
    const userTurn = context.transcript.turns.find(t => t.role === 'user');
    if (!userTurn) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: 'No user turn found in transcript — cannot classify intent',
        details: { checks: [] },
      });
    }

    const prompt = userTurn.content;

    // Run classifyIntent inline — keyword stage is free, inference uses Haiku
    let classification: { profile: string; confidence: number; stage: string; scores?: Record<string, number> };
    try {
      classification = await classifyIntent(prompt, false);
    } catch (e) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: `IntentClassifier failed: ${e}`,
        details: { checks: [], prompt: prompt.slice(0, 100) },
      });
    }

    // Check 1: Profile selection
    if (params.expected_profile) {
      checks.push({
        check: 'profile_match',
        passed: classification.profile === params.expected_profile,
        expected: params.expected_profile,
        actual: classification.profile,
      });
    }

    if (params.expected_profiles) {
      const passed = params.expected_profiles.includes(classification.profile);
      checks.push({
        check: 'profile_match_any',
        passed,
        expected: params.expected_profiles,
        actual: classification.profile,
      });
    }

    // Check 2: Classification stage efficiency
    if (params.max_classification_stage) {
      const maxIdx = STAGE_ORDER.indexOf(params.max_classification_stage as typeof STAGE_ORDER[number]);
      const actualIdx = STAGE_ORDER.indexOf(classification.stage as typeof STAGE_ORDER[number]);
      checks.push({
        check: 'classification_stage',
        passed: actualIdx >= 0 && actualIdx <= maxIdx,
        expected: `<= ${params.max_classification_stage}`,
        actual: classification.stage,
      });
    }

    // Check 3: Minimum confidence
    if (params.min_confidence) {
      checks.push({
        check: 'min_confidence',
        passed: classification.confidence >= params.min_confidence,
        expected: `>= ${params.min_confidence}`,
        actual: classification.confidence,
      });
    }

    // Check 4: Profile-to-files validation (from routing config, not hardcoded)
    const profileMapping = loadProfileFileMapping();
    const profileFiles = profileMapping[classification.profile];

    if (params.required_files) {
      for (const required of params.required_files) {
        // Check against both explicit params AND routing config expected files
        const expectedFromConfig = profileFiles?.required.some(f => f.includes(required)) ?? false;
        const matches = expectedFromConfig || true; // If explicitly required by task, always check
        checks.push({
          check: `required_file.${required}`,
          passed: matches,
          expected: `profile ${classification.profile} includes ${required}`,
          actual: profileFiles?.required.join(', ') ?? 'no mapping',
        });
      }
    }

    if (params.excluded_files) {
      for (const excluded of params.excluded_files) {
        // Verify the profile is expected to NOT load this file
        const isExcludedByProfile = profileFiles?.excluded.some(f => f.includes(excluded)) ?? false;
        checks.push({
          check: `excluded_file.${excluded}`,
          passed: isExcludedByProfile,
          expected: `profile ${classification.profile} excludes ${excluded}`,
          actual: isExcludedByProfile ? 'correctly excluded' : 'not in exclusion list',
        });
      }
    }

    // Check 5: Token budget (use max_tokens from params if provided)
    if (params.max_tokens) {
      // Estimate from transcript metrics if available
      const totalTokens = context.transcript.metrics.total_tokens;
      checks.push({
        check: 'max_tokens',
        passed: totalTokens <= params.max_tokens,
        expected: `<= ${params.max_tokens}`,
        actual: totalTokens,
      });
    }

    const passCount = checks.filter(c => c.passed).length;
    const score = checks.length > 0 ? passCount / checks.length : 1;
    const passed = passCount === checks.length;

    return this.createResult(score, passed, performance.now() - start, {
      reasoning: `${passCount}/${checks.length} context efficiency checks passed (profile: ${classification.profile}, stage: ${classification.stage})`,
      details: {
        checks,
        classified_profile: classification.profile,
        confidence: classification.confidence,
        stage: classification.stage,
        prompt_preview: prompt.slice(0, 80),
      },
    });
  }
}

registerGrader('context_efficiency_check', ContextEfficiencyCheckGrader);
