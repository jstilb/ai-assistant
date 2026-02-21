#!/usr/bin/env bun
/**
 * ContextLearner.ts - Cross-session learning from context usage patterns
 *
 * Analyzes context-feedback.jsonl to detect patterns and recommend
 * profile tuning (e.g., files frequently loaded manually should be
 * added to the profile's recommended list).
 *
 * CLI: bun ContextLearner.ts --analyze
 * API: import { analyzeLearnings } from "./ContextLearner"
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { createStateManager } from '../../../skills/CORE/Tools/StateManager';
import { readFeedback, type ContextFeedback } from './FeedbackCollector';

const KAYA_DIR = process.env.KAYA_DIR || join(process.env.HOME!, '.claude');
const LEARNINGS_PATH = join(KAYA_DIR, 'MEMORY', 'STATE', 'context-learnings.json');
const PROFILES_PATH = join(KAYA_DIR, 'skills/ContextManager/config/profiles.json');

// Schema for learnings state
const FileAdjustmentSchema = z.object({
  path: z.string(),
  frequency: z.number(),
  sessions: z.number(),
  lastSeen: z.string(),
});

const ProfileAdjustmentSchema = z.object({
  shouldAdd: z.array(FileAdjustmentSchema).default([]),
  neverUsed: z.array(z.object({
    path: z.string(),
    lastUsed: z.string().nullable(),
    inProfileSince: z.string().optional(),
  })).default([]),
});

const LearningsSchema = z.object({
  lastAnalyzed: z.string(),
  totalSessionsAnalyzed: z.number().default(0),
  profileAdjustments: z.record(z.string(), ProfileAdjustmentSchema).default({}),
  insights: z.array(z.object({
    type: z.enum(['recommendation', 'observation', 'warning']),
    message: z.string(),
    timestamp: z.string(),
  })).default([]),
});

type Learnings = z.infer<typeof LearningsSchema>;

const stateManager = createStateManager({
  path: LEARNINGS_PATH,
  schema: LearningsSchema,
  defaults: () => ({
    lastAnalyzed: new Date().toISOString(),
    totalSessionsAnalyzed: 0,
    profileAdjustments: {},
    insights: [],
  }),
});

/**
 * Load profile configurations to know what's expected
 */
function loadProfileConfigs(): Record<string, { required: string[]; recommended: string[]; optional: string[] }> {
  if (!existsSync(PROFILES_PATH)) return {};
  const config = JSON.parse(readFileSync(PROFILES_PATH, 'utf-8'));
  const result: Record<string, { required: string[]; recommended: string[]; optional: string[] }> = {};
  for (const [name, profile] of Object.entries(config.profiles as Record<string, any>)) {
    result[name] = {
      required: profile.required || [],
      recommended: profile.recommended || [],
      optional: profile.optional || [],
    };
  }
  return result;
}

/**
 * Analyze feedback to detect patterns
 */
export async function analyzeLearnings(): Promise<Learnings> {
  const feedback = readFeedback();
  const profiles = loadProfileConfigs();

  if (feedback.length === 0) {
    console.error('[ContextLearner] No feedback data to analyze');
    return stateManager.load();
  }

  const adjustments: Record<string, { shouldAdd: Map<string, { count: number; lastSeen: string }>; neverUsed: Set<string> }> = {};

  // Initialize adjustments for each profile
  for (const profileName of Object.keys(profiles)) {
    adjustments[profileName] = {
      shouldAdd: new Map(),
      neverUsed: new Set([
        ...profiles[profileName].recommended,
        ...profiles[profileName].optional,
      ]),
    };
  }

  // Analyze each session
  for (const entry of feedback) {
    const profileName = entry.profile;
    if (!adjustments[profileName]) continue;

    const profileConfig = profiles[profileName];
    if (!profileConfig) continue;

    const expectedFiles = new Set([
      ...profileConfig.required,
      ...profileConfig.recommended,
      ...profileConfig.optional,
    ]);

    // Track files that were loaded but not in the profile
    for (const loadedFile of entry.filesLoaded) {
      if (!expectedFiles.has(loadedFile)) {
        const existing = adjustments[profileName].shouldAdd.get(loadedFile);
        if (existing) {
          existing.count++;
          existing.lastSeen = entry.timestamp;
        } else {
          adjustments[profileName].shouldAdd.set(loadedFile, {
            count: 1,
            lastSeen: entry.timestamp,
          });
        }
      }

      // Remove from neverUsed if it was loaded
      adjustments[profileName].neverUsed.delete(loadedFile);
    }
  }

  // Build learnings state
  const profileAdjustments: Record<string, z.infer<typeof ProfileAdjustmentSchema>> = {};
  const insights: Learnings['insights'] = [];
  const now = new Date().toISOString();

  for (const [profileName, adj] of Object.entries(adjustments)) {
    const shouldAdd = Array.from(adj.shouldAdd.entries())
      .filter(([, data]) => data.count >= 2) // Only suggest if seen 2+ times
      .map(([path, data]) => ({
        path,
        frequency: data.count / feedback.filter(f => f.profile === profileName).length,
        sessions: data.count,
        lastSeen: data.lastSeen,
      }))
      .sort((a, b) => b.frequency - a.frequency);

    const neverUsed = Array.from(adj.neverUsed).map(path => ({
      path,
      lastUsed: null,
    }));

    if (shouldAdd.length > 0 || neverUsed.length > 0) {
      profileAdjustments[profileName] = { shouldAdd, neverUsed };

      if (shouldAdd.length > 0) {
        insights.push({
          type: 'recommendation',
          message: `Profile "${profileName}": Consider adding ${shouldAdd.map(f => f.path).join(', ')} to recommended files (loaded in ${shouldAdd[0].sessions}+ sessions)`,
          timestamp: now,
        });
      }

      if (neverUsed.length > 0) {
        insights.push({
          type: 'observation',
          message: `Profile "${profileName}": ${neverUsed.length} recommended/optional files were never loaded - consider removing: ${neverUsed.map(f => f.path).join(', ')}`,
          timestamp: now,
        });
      }
    }
  }

  // Check for profiles with high manual load counts
  const profileManualLoads: Record<string, number[]> = {};
  for (const entry of feedback) {
    if (!profileManualLoads[entry.profile]) profileManualLoads[entry.profile] = [];
    profileManualLoads[entry.profile].push(entry.manualContextLoads);
  }

  for (const [profile, loads] of Object.entries(profileManualLoads)) {
    const avgLoads = loads.reduce((a, b) => a + b, 0) / loads.length;
    if (avgLoads > 2) {
      insights.push({
        type: 'warning',
        message: `Profile "${profile}" has ${avgLoads.toFixed(1)} avg manual context loads per session - profile may need more recommended files`,
        timestamp: now,
      });
    }
  }

  // Check classification confidence
  const lowConfidence = feedback.filter(f => f.classificationConfidence < 0.5);
  if (lowConfidence.length > feedback.length * 0.3) {
    insights.push({
      type: 'warning',
      message: `${((lowConfidence.length / feedback.length) * 100).toFixed(0)}% of sessions had low classification confidence - consider adding more keywords to routing.json`,
      timestamp: now,
    });
  }

  const learnings: Learnings = {
    lastAnalyzed: now,
    totalSessionsAnalyzed: feedback.length,
    profileAdjustments,
    insights: insights.slice(0, 20), // Keep last 20 insights
  };

  await stateManager.save(learnings);
  return learnings;
}

// CLI
if (import.meta.main) {
  const cmd = process.argv[2];

  if (cmd === '--analyze') {
    console.error('Analyzing context feedback...\n');
    const learnings = await analyzeLearnings();
    console.log(JSON.stringify(learnings, null, 2));
  } else if (cmd === '--status') {
    const learnings = await stateManager.load();
    console.log(JSON.stringify(learnings, null, 2));
  } else {
    console.log('Usage:');
    console.log('  bun ContextLearner.ts --analyze   Analyze feedback and generate learnings');
    console.log('  bun ContextLearner.ts --status    Show current learnings state');
  }
}
