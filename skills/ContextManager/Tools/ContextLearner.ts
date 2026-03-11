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
import { createStateManager } from '../../../lib/core/StateManager';
import { readFeedback, type ContextFeedback } from './FeedbackCollector';

const KAYA_DIR = process.env.KAYA_DIR || join(process.env.HOME!, '.claude');
const LEARNINGS_PATH = join(KAYA_DIR, 'MEMORY', 'State', 'context-learnings.json');
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

const ProfileConfigSchema = z.object({
  tokenBudget: z.number(),
  description: z.string().default(''),
  required: z.array(z.string()).default([]),
  recommended: z.array(z.string()).default([]),
  optional: z.array(z.string()).default([]),
  excludes: z.array(z.string()).default([]),
});

const ProfilesConfigSchema = z.object({
  profiles: z.record(z.string(), ProfileConfigSchema),
});

const profilesState = createStateManager({
  path: PROFILES_PATH,
  schema: ProfilesConfigSchema,
  defaults: { profiles: {} },
  backupOnWrite: true,
});

/**
 * Load profile configurations to know what's expected
 */
async function loadProfileConfigs(): Promise<Record<string, { required: string[]; recommended: string[]; optional: string[] }>> {
  const config = await profilesState.load();
  const result: Record<string, { required: string[]; recommended: string[]; optional: string[] }> = {};
  for (const [name, profile] of Object.entries(config.profiles)) {
    result[name] = {
      required: profile.required,
      recommended: profile.recommended,
      optional: profile.optional,
    };
  }
  return result;
}

/**
 * Analyze feedback to detect patterns
 */
export async function analyzeLearnings(): Promise<Learnings> {
  const feedback = readFeedback();
  const profiles = await loadProfileConfigs();

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
      .filter(([path, data]) => data.count >= 2 && existsSync(join(KAYA_DIR, path))) // Only suggest if seen 2+ times and file exists
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

  // Rating-weighted insights: correlate session satisfaction with profile effectiveness
  const profileRatings: Record<string, number[]> = {};
  for (const entry of feedback) {
    if (entry.sessionRating !== undefined && entry.sessionRating !== null) {
      if (!profileRatings[entry.profile]) profileRatings[entry.profile] = [];
      profileRatings[entry.profile].push(entry.sessionRating);
    }
  }

  if (Object.keys(profileRatings).length > 0) {
    const profileSatisfaction: string[] = [];
    for (const [profile, ratings] of Object.entries(profileRatings)) {
      const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
      profileSatisfaction.push(`${profile}=${avg.toFixed(1)}`);

      if (avg < 5 && ratings.length >= 3) {
        insights.push({
          type: 'warning',
          message: `Profile "${profile}" has low avg satisfaction (${avg.toFixed(1)}/10 over ${ratings.length} sessions) — review recommended/required files`,
          timestamp: now,
        });
      }
    }

    insights.push({
      type: 'observation',
      message: `Per-profile satisfaction: ${profileSatisfaction.join(', ')}`,
      timestamp: now,
    });
  }

  // Detect profiles with bad outcomes + manual loads (strongest signal profile was wrong)
  for (const entry of feedback) {
    if (entry.sessionRating !== undefined && entry.sessionRating < 5 && entry.manualContextLoads > 0) {
      const profileName = entry.profile;
      const existing = insights.find(i => i.message.includes(`"${profileName}"`) && i.message.includes('manual loads in low-rated'));
      if (!existing) {
        insights.push({
          type: 'warning',
          message: `Profile "${profileName}" had manual loads in low-rated sessions — profile may be missing key files`,
          timestamp: now,
        });
      }
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

/**
 * Apply accumulated learnings to profiles.json
 *
 * Guard rails:
 * - Never modifies `required` files — only `recommended`
 * - Max 2 additions per profile per run
 * - Only applies if totalSessionsAnalyzed >= 20
 * - Writes backup before modifying
 */
export async function applyLearnings(): Promise<{ applied: boolean; changes: string[] }> {
  const learnings = await stateManager.load();
  const changes: string[] = [];

  if (learnings.totalSessionsAnalyzed < 20) {
    console.error(`[ContextLearner] Not enough data (${learnings.totalSessionsAnalyzed}/20 sessions) — skipping auto-apply`);
    return { applied: false, changes: ['Insufficient data (need 20+ sessions)'] };
  }

  const profilesConfig = await profilesState.load();

  let modified = false;

  for (const [profileName, adj] of Object.entries(learnings.profileAdjustments)) {
    const profile = profilesConfig.profiles?.[profileName];
    if (!profile) continue;

    const recommended: string[] = profile.recommended || [];

    // Add files seen in 3+ sessions (max 2 per profile per run)
    let added = 0;
    for (const file of (adj as z.infer<typeof ProfileAdjustmentSchema>).shouldAdd) {
      if (added >= 2) break;
      if (file.sessions >= 3 && !recommended.includes(file.path)) {
        recommended.push(file.path);
        changes.push(`Added "${file.path}" to ${profileName}.recommended (seen in ${file.sessions} sessions)`);
        added++;
        modified = true;
      }
    }

    // Remove never-used files from recommended (never touch required)
    for (const unused of (adj as z.infer<typeof ProfileAdjustmentSchema>).neverUsed) {
      const idx = recommended.indexOf(unused.path);
      if (idx !== -1) {
        recommended.splice(idx, 1);
        changes.push(`Removed "${unused.path}" from ${profileName}.recommended (never used)`);
        modified = true;
      }
    }

    profile.recommended = recommended;
  }

  if (modified) {
    await profilesState.save(profilesConfig);
    console.error(`[ContextLearner] Applied ${changes.length} changes to profiles.json`);
  } else {
    console.error('[ContextLearner] No changes to apply');
  }

  return { applied: modified, changes };
}

// ============================================================================
// Learning Cache (ISC 4506, 6584) — Pre-computed cache schema v2
// ============================================================================

const LEARNING_CACHE_PATH = join(KAYA_DIR, 'MEMORY', 'State', 'learning-cache.json');

/** Schema for a single profile entry in learning-cache.json */
interface LearningCacheProfile {
  session_count: number;
  avg_rating: number | null;
  rating_trend: 'improving' | 'declining' | 'stable' | 'insufficient_data';
  common_files: string[];
  recommendations: Array<{
    path: string;
    sessions: number;
    frequency: number;
    action: 'add' | 'remove';
  }>;
  low_rated_session_count: number;
}

/** Full learning-cache.json schema */
export interface LearningCacheJson {
  _version: 2;
  computed_at: string;
  total_entries_processed: number;
  profiles: Record<string, LearningCacheProfile>;
  trends: {
    today_avg: number | null;
    week_avg: number | null;
    month_avg: number | null;
    best_profile_this_week: string | null;
    worst_profile_this_week: string | null;
  };
  insights: Array<{
    type: 'recommendation' | 'observation' | 'warning';
    message: string;
    timestamp: string;
  }>;
}

/**
 * Read ratings.jsonl and compute trend averages (today/week/month).
 */
function computeRatingTrends(ratingsPath: string): {
  today_avg: number | null;
  week_avg: number | null;
  month_avg: number | null;
} {
  if (!existsSync(ratingsPath)) {
    return { today_avg: null, week_avg: null, month_avg: null };
  }

  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;
    const monthStart = todayStart - 29 * 24 * 60 * 60 * 1000;

    const lines = readFileSync(ratingsPath, 'utf-8').trim().split('\n').filter(Boolean);
    const todayRatings: number[] = [];
    const weekRatings: number[] = [];
    const monthRatings: number[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const rating = typeof entry.rating === 'number' ? entry.rating : null;
        if (rating === null) continue;
        const ts = new Date(entry.timestamp ?? 0).getTime();
        if (ts >= todayStart) todayRatings.push(rating);
        if (ts >= weekStart) weekRatings.push(rating);
        if (ts >= monthStart) monthRatings.push(rating);
      } catch { /* skip */ }
    }

    const avg = (arr: number[]) => arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length;

    return {
      today_avg: avg(todayRatings),
      week_avg: avg(weekRatings),
      month_avg: avg(monthRatings),
    };
  } catch {
    return { today_avg: null, week_avg: null, month_avg: null };
  }
}

/**
 * Write learning-cache.json from analyzeLearnings() output.
 * Schema version 2 with full trends and profile data.
 *
 * ISC 4506: _version: 2, computed_at updated
 * ISC 6584: trends.today_avg, week_avg, month_avg
 */
export async function writeLearningCache(): Promise<LearningCacheJson> {
  const learnings = await analyzeLearnings();
  const ratingsPath = join(KAYA_DIR, 'MEMORY', 'LEARNING', 'SIGNALS', 'ratings.jsonl');
  const trends = computeRatingTrends(ratingsPath);

  // Build per-profile entries
  const profiles: Record<string, LearningCacheProfile> = {};
  const feedback = readFeedback();

  // Compute per-profile stats from feedback + learnings
  const profileFeedbackMap: Record<string, ContextFeedback[]> = {};
  for (const entry of feedback) {
    if (!profileFeedbackMap[entry.profile]) profileFeedbackMap[entry.profile] = [];
    profileFeedbackMap[entry.profile].push(entry);
  }

  for (const [profileName, entries] of Object.entries(profileFeedbackMap)) {
    const ratedEntries = entries.filter(e => typeof e.sessionRating === 'number');
    const avgRating = ratedEntries.length > 0
      ? ratedEntries.reduce((s, e) => s + (e.sessionRating ?? 0), 0) / ratedEntries.length
      : null;

    // Determine trend from first half vs second half of sessions
    let ratingTrend: LearningCacheProfile['rating_trend'] = 'insufficient_data';
    if (ratedEntries.length >= 6) {
      const mid = Math.floor(ratedEntries.length / 2);
      const firstHalf = ratedEntries.slice(0, mid);
      const secondHalf = ratedEntries.slice(mid);
      const firstAvg = firstHalf.reduce((s, e) => s + (e.sessionRating ?? 0), 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((s, e) => s + (e.sessionRating ?? 0), 0) / secondHalf.length;
      const diff = secondAvg - firstAvg;
      if (diff > 0.5) ratingTrend = 'improving';
      else if (diff < -0.5) ratingTrend = 'declining';
      else ratingTrend = 'stable';
    }

    // Common files loaded in this profile
    const fileFreq: Record<string, number> = {};
    for (const entry of entries) {
      for (const f of entry.filesLoaded) {
        fileFreq[f] = (fileFreq[f] ?? 0) + 1;
      }
    }
    const common_files = Object.entries(fileFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([f]) => f);

    // Recommendations from learnings
    const adjData = learnings.profileAdjustments[profileName] as z.infer<typeof ProfileAdjustmentSchema> | undefined;
    const recommendations: LearningCacheProfile['recommendations'] = [];
    if (adjData) {
      for (const item of adjData.shouldAdd) {
        recommendations.push({
          path: item.path,
          sessions: item.sessions,
          frequency: item.frequency,
          action: 'add',
        });
      }
      for (const item of adjData.neverUsed) {
        recommendations.push({
          path: item.path,
          sessions: 0,
          frequency: 0,
          action: 'remove',
        });
      }
    }

    profiles[profileName] = {
      session_count: entries.length,
      avg_rating: avgRating,
      rating_trend: ratingTrend,
      common_files,
      recommendations,
      low_rated_session_count: ratedEntries.filter(e => (e.sessionRating ?? 10) <= 3).length,
    };
  }

  // Compute best/worst profile this week by avg rating
  const weekRatingsPerProfile: Record<string, number[]> = {};
  const weekStart = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const entry of feedback) {
    const ts = new Date(entry.timestamp).getTime();
    if (ts >= weekStart && typeof entry.sessionRating === 'number') {
      if (!weekRatingsPerProfile[entry.profile]) weekRatingsPerProfile[entry.profile] = [];
      weekRatingsPerProfile[entry.profile].push(entry.sessionRating);
    }
  }

  let bestProfile: string | null = null;
  let worstProfile: string | null = null;
  let bestAvg = -Infinity;
  let worstAvg = Infinity;

  for (const [profile, ratings] of Object.entries(weekRatingsPerProfile)) {
    if (ratings.length < 2) continue;
    const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
    if (avg > bestAvg) { bestAvg = avg; bestProfile = profile; }
    if (avg < worstAvg) { worstAvg = avg; worstProfile = profile; }
  }

  const cache: LearningCacheJson = {
    _version: 2,
    computed_at: new Date().toISOString(),
    total_entries_processed: feedback.length,
    profiles,
    trends: {
      today_avg: trends.today_avg,
      week_avg: trends.week_avg,
      month_avg: trends.month_avg,
      best_profile_this_week: bestProfile,
      worst_profile_this_week: worstProfile,
    },
    insights: learnings.insights,
  };

  // Ensure State directory exists
  const stateDir = join(KAYA_DIR, 'MEMORY', 'State');
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }

  writeFileSync(LEARNING_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
  console.error(`[ContextLearner] Cache written: ${feedback.length} entries processed → ${LEARNING_CACHE_PATH}`);
  return cache;
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const writeCache = args.includes('--write-cache');

  if (cmd === '--analyze' || writeCache) {
    console.error('Analyzing context feedback...\n');
    if (writeCache) {
      // Write full learning cache (ISC 4506, 6584)
      const cache = await writeLearningCache();
      console.log(JSON.stringify(cache, null, 2));
    } else {
      const learnings = await analyzeLearnings();
      console.log(JSON.stringify(learnings, null, 2));
    }
  } else if (cmd === '--apply') {
    console.error('Applying learnings to profiles...\n');
    const result = await applyLearnings();
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === '--status') {
    const learnings = await stateManager.load();
    console.log(JSON.stringify(learnings, null, 2));
  } else {
    console.log('Usage:');
    console.log('  bun ContextLearner.ts --analyze              Analyze feedback, generate learnings');
    console.log('  bun ContextLearner.ts --analyze --write-cache  Analyze AND write learning-cache.json');
    console.log('  bun ContextLearner.ts --write-cache          Write learning-cache.json (alias for above)');
    console.log('  bun ContextLearner.ts --apply                Apply learnings to profiles.json');
    console.log('  bun ContextLearner.ts --status               Show current learnings state');
  }
}
