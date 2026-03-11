#!/usr/bin/env bun
/**
 * IntentClassifier.ts - Two-stage intent classification for ContextManager
 *
 * Stage A: Fast keyword match (<1ms, no inference)
 *   - Scans user prompt against routing.json keyword rules
 *   - Selects profile if top score >= 2x runner-up (high confidence)
 *
 * Stage B: Haiku inference fallback (~2-5s)
 *   - Uses Inference.ts at 'fast' level for ambiguous prompts
 *   - Returns profile + confidence + reasoning
 *
 * CLI: bun IntentClassifier.ts "user prompt here"
 * API: import { classifyIntent } from "./IntentClassifier"
 */

import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { z } from 'zod';
import { inference } from '../../../lib/core/Inference';
import { createStateManager } from '../../../lib/core/StateManager';
import { emitInsight } from '../../../lib/core/SkillIntegrationBridge';

const KAYA_DIR = process.env.KAYA_DIR || join(process.env.HOME!, '.claude');
const ROUTING_CONFIG_PATH = join(KAYA_DIR, 'skills/ContextManager/config/routing.json');
const CLASSIFICATION_STATE_PATH = join(KAYA_DIR, 'MEMORY/STATE/context-classification.json');

// Types
export interface ClassificationResult {
  profile: string;
  confidence: number;
  stage: 'keyword' | 'inference';
  reasoning?: string;
  scores?: Record<string, number>;
  timestamp: string;
}

interface RoutingRule {
  profile: string;
  keywords: string[];
  weight: number;
}

interface RoutingConfig {
  rules: RoutingRule[];
  confidenceThreshold: number;
  defaultProfile: string;
}

const RoutingRuleSchema = z.object({
  profile: z.string(),
  keywords: z.array(z.string()),
  weight: z.number().default(1.0),
});

const RoutingConfigSchema = z.object({
  rules: z.array(RoutingRuleSchema),
  confidenceThreshold: z.number().default(2.0),
  defaultProfile: z.string().default('general'),
});

const routingState = createStateManager({
  path: ROUTING_CONFIG_PATH,
  schema: RoutingConfigSchema,
  defaults: { rules: [], confidenceThreshold: 2.0, defaultProfile: 'general' },
});

// Cache routing config
let cachedConfig: RoutingConfig | null = null;

async function loadRoutingConfig(): Promise<RoutingConfig> {
  if (cachedConfig) return cachedConfig;
  cachedConfig = await routingState.load();
  return cachedConfig;
}

/**
 * Stage A: Fast keyword matching
 * Returns profile if confidence is high enough, null otherwise
 */
async function keywordMatch(prompt: string): Promise<{ profile: string; confidence: number; scores: Record<string, number> } | null> {
  const config = await loadRoutingConfig();
  const lowerPrompt = prompt.toLowerCase();
  const scores: Record<string, number> = {};

  for (const rule of config.rules) {
    let score = 0;
    for (const keyword of rule.keywords) {
      // Check for multi-word keywords as phrases
      if (keyword.includes(' ')) {
        if (lowerPrompt.includes(keyword.toLowerCase())) {
          score += 2 * rule.weight; // Phrase matches get bonus
        }
      } else {
        // Word boundary match for single keywords
        const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (regex.test(lowerPrompt)) {
          score += rule.weight;
        }
      }
    }
    scores[rule.profile] = score;
  }

  // Find top two scores
  const sorted = Object.entries(scores)
    .filter(([, s]) => s > 0)
    .sort(([, a], [, b]) => b - a);

  if (sorted.length === 0) return null;

  const [topProfile, topScore] = sorted[0];
  const runnerUpScore = sorted.length > 1 ? sorted[1][1] : 0;

  // Check confidence threshold: top must be >= threshold * runner-up
  if (runnerUpScore === 0 && topScore > 0) {
    // Only one profile matched - high confidence
    return { profile: topProfile, confidence: 1.0, scores };
  }

  if (topScore >= config.confidenceThreshold * runnerUpScore) {
    const confidence = runnerUpScore > 0 ? topScore / (topScore + runnerUpScore) : 1.0;
    return { profile: topProfile, confidence, scores };
  }

  // Not confident enough - return null to trigger Stage B
  return null;
}

/**
 * Stage B: Haiku inference fallback
 */
async function inferenceClassify(prompt: string, hasExistingSession: boolean): Promise<ClassificationResult> {
  const config = await loadRoutingConfig();
  const profileNames = config.rules.map(r => r.profile).join(', ');

  const systemPrompt = `You are a context routing classifier. Given a user prompt, classify which context profile best matches their intent.

Available profiles: ${profileNames}, general, conversational

Return ONLY valid JSON:
{
  "profile": "<profile name>",
  "confidence": <0.0-1.0>,
  "reasoning": "<brief explanation>"
}

Profile descriptions:
- development: Code, bugs, features, deployment, technical work
- life-coaching: Goals, challenges, strategies, personal progress, habits
- scheduling: Calendar, meetings, availability, time management
- task-management: LucidTasks tasks, deadlines, project tracking, work items
- knowledge-lookup: Notes, research, knowledge base queries
- general: Mixed intent or unclear
- conversational: Greetings, thanks, simple non-task chat`;

  const contextNote = hasExistingSession
    ? '\n\nContext: There is an existing session. Consider if this might be a topic change.'
    : '';

  try {
    const result = await inference({
      systemPrompt: systemPrompt + contextNote,
      userPrompt: prompt,
      level: 'fast',
      expectJson: true,
      timeout: 10000,
    });

    if (result.success && result.parsed) {
      const parsed = result.parsed as { profile: string; confidence: number; reasoning: string };
      return {
        profile: parsed.profile || config.defaultProfile,
        confidence: parsed.confidence || 0.5,
        stage: 'inference',
        reasoning: parsed.reasoning,
        timestamp: new Date().toISOString(),
      };
    }
  } catch (err) {
    console.error(`[IntentClassifier] Inference failed: ${err}`);
  }

  // Fallback to default
  return {
    profile: config.defaultProfile,
    confidence: 0.3,
    stage: 'inference',
    reasoning: 'Inference failed, using default profile',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Save classification result for reuse by other hooks
 */
function saveClassification(result: ClassificationResult): void {
  const dir = dirname(CLASSIFICATION_STATE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CLASSIFICATION_STATE_PATH, JSON.stringify(result, null, 2));
}

/**
 * Main classification function - two-stage approach
 */
export async function classifyIntent(
  prompt: string,
  hasExistingSession: boolean = false
): Promise<ClassificationResult> {
  // Stage A: Fast keyword match
  const keywordResult = await keywordMatch(prompt);

  if (keywordResult) {
    const result: ClassificationResult = {
      profile: keywordResult.profile,
      confidence: keywordResult.confidence,
      stage: 'keyword',
      scores: keywordResult.scores,
      timestamp: new Date().toISOString(),
    };
    saveClassification(result);
    console.error(`[IntentClassifier] Keyword match: ${result.profile} (confidence: ${result.confidence.toFixed(2)})`);

    // Phase 5: Integration Backbone - Emit insight after classification
    emitInsight({
      source: 'ContextManager',
      type: 'signal',
      category: 'classification',
      title: `Classified "${prompt.slice(0, 50)}..." as ${result.profile}`,
      content: `Profile: ${result.profile}, Method: ${result.stage}, Confidence: ${result.confidence}`,
      tags: ['contextmanager', 'classification', result.profile],
      tier: 'hot',
      ttl: 7 * 24 * 60 * 60, // 7 days
      metadata: {
        profile: result.profile,
        method: result.stage,
        confidence: result.confidence,
        scores: result.scores,
      },
    }).catch(err => console.error('[IntentClassifier] Failed to emit insight:', err));

    return result;
  }

  // Stage B: Haiku inference
  console.error('[IntentClassifier] Keyword match ambiguous, falling back to inference...');
  const result = await inferenceClassify(prompt, hasExistingSession);
  saveClassification(result);
  console.error(`[IntentClassifier] Inference: ${result.profile} (confidence: ${result.confidence.toFixed(2)})`);

  // Phase 5: Integration Backbone - Emit insight after inference classification
  emitInsight({
    source: 'ContextManager',
    type: 'signal',
    category: 'classification',
    title: `Classified "${prompt.slice(0, 50)}..." as ${result.profile}`,
    content: `Profile: ${result.profile}, Method: ${result.stage}, Confidence: ${result.confidence}, Reasoning: ${result.reasoning || 'N/A'}`,
    tags: ['contextmanager', 'classification', result.profile],
    tier: 'hot',
    ttl: 7 * 24 * 60 * 60, // 7 days
    metadata: {
      profile: result.profile,
      method: result.stage,
      confidence: result.confidence,
      reasoning: result.reasoning,
    },
  }).catch(err => console.error('[IntentClassifier] Failed to emit insight:', err));

  return result;
}

/**
 * Lightweight topic-change detection for subsequent messages
 * Returns new profile only if confident in a change
 */
export async function detectTopicChange(
  prompt: string,
  currentProfile: string
): Promise<{ changed: boolean; newProfile?: string; confidence?: number }> {
  const keywordResult = await keywordMatch(prompt);

  if (!keywordResult) {
    return { changed: false };
  }

  if (keywordResult.profile !== currentProfile && keywordResult.confidence > 0.7) {
    return {
      changed: true,
      newProfile: keywordResult.profile,
      confidence: keywordResult.confidence,
    };
  }

  return { changed: false };
}

// CLI
if (import.meta.main) {
  const prompt = process.argv.slice(2).join(' ');
  if (!prompt) {
    console.log('Usage: bun IntentClassifier.ts "user prompt here"');
    process.exit(1);
  }

  const result = await classifyIntent(prompt, false);
  console.log(JSON.stringify(result, null, 2));
}
