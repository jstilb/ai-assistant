#!/usr/bin/env bun
/**
 * KnowledgeSynthesizer - Unified multi-source knowledge synthesis engine
 *
 * Aggregates signals from ratings, sessions, voice events, and learnings
 * into actionable patterns. This is the intelligence layer on top of MemoryStore.
 *
 * Data Sources:
 * - MEMORY/LEARNING/SIGNALS/ratings.jsonl - User satisfaction signals
 * - MEMORY/VOICE/voice-events.jsonl - Voice notification patterns
 * - Session transcripts - Corrections, insights, errors
 * - MemoryStore entries - Hot/warm tier learnings
 * - MEMORY/WORK/audit.jsonl - AutonomousWork verification results
 * - MEMORY/WORK/transition-audit.jsonl - Work item state transitions
 *
 * Commands:
 *   --week         Synthesize last 7 days (default)
 *   --month        Synthesize last 30 days
 *   --all          Synthesize all available data
 *   --source       Specify sources: ratings,voice,sessions,memory,graph (comma-separated)
 *   --dry-run      Preview synthesis without writing
 *   --json         Output as JSON
 *
 * Examples:
 *   bun run KnowledgeSynthesizer.ts --week
 *   bun run KnowledgeSynthesizer.ts --month --source ratings,sessions
 *   bun run KnowledgeSynthesizer.ts --all --json
 */

import { parseArgs } from "util";
import { existsSync, mkdirSync, statSync, readdirSync } from "fs";
import * as path from "path";
import { z } from "zod";
import { memoryStore } from "../../../../lib/core/MemoryStore";
import { createStateManager } from "../../../../lib/core/StateManager";

// ============================================================================
// Configuration
// ============================================================================

const CLAUDE_DIR = path.join(process.env.HOME!, ".claude");
const MEMORY_DIR = path.join(CLAUDE_DIR, "MEMORY");
const LEARNING_DIR = path.join(MEMORY_DIR, "LEARNING");
const RATINGS_FILE = path.join(LEARNING_DIR, "SIGNALS", "ratings.jsonl");
const ESTIMATION_ACCURACY_FILE = path.join(LEARNING_DIR, "SIGNALS", "estimation-accuracy.jsonl");
const VOICE_EVENTS_FILE = path.join(MEMORY_DIR, "VOICE", "voice-events.jsonl");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");
const AUDIT_FILE = path.join(MEMORY_DIR, "WORK", "audit.jsonl");
const TRANSITION_AUDIT_FILE = path.join(MEMORY_DIR, "WORK", "transition-audit.jsonl");
const SYNTHESIS_OUTPUT_DIR = path.join(LEARNING_DIR, "SYNTHESIS");
const STATE_FILE = path.join(CLAUDE_DIR, "skills", "ContinualLearning", "State", "last-synthesis.json");

// ============================================================================
// Types
// ============================================================================

export interface Rating {
  timestamp: string;
  rating: number;
  session_id: string;
  source: "explicit" | "implicit";
  sentiment_summary: string;
  confidence: number;
  comment?: string;
}

export interface VoiceEvent {
  timestamp: string;
  session_id: string;
  message: string;
  character_count: number;
  voice_id: string;
  event_type: "success" | "failed";
  error?: string;
}

export interface SessionLearning {
  sessionId: string;
  timestamp: string;
  type: "correction" | "error" | "insight";
  content: string;
  context: string;
}

export interface AuditEntry {
  timestamp: string;
  itemId: string;
  itemTitle: string;
  verdict: "PASS" | "FAIL" | "NEEDS_REVIEW";
  concerns: string[];
  tiersExecuted: number[];
  verificationCost: number;
  iscRowSummary: string[];
  failureReason?: string;
  adversarialConcerns?: string[];
}

export interface TransitionAuditEntry {
  timestamp: string;
  itemId: string;
  action: string;
  from: string;
  to: string;
  reason?: string;
  tierData?: {
    tiers: Array<{ tier: number; verdict: string; confidence: number }>;
    selfReportedPassCount?: number;
  };
}

export interface Pattern {
  name: string;
  category: "frustration" | "success" | "behavior" | "preference" | "agent_observability";
  count: number;
  avgScore: number;
  examples: string[];
  trend: "increasing" | "decreasing" | "stable";
  lastSeen: string;
}

export interface SynthesisResult {
  timestamp: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  sources: string[];
  totalDataPoints: number;
  patterns: Pattern[];
  insights: string[];
  recommendations: string[];
  ratingsSummary?: {
    count: number;
    avgRating: number;
    trend: string;
  };
  voiceSummary?: {
    count: number;
    errorRate: number;
    peakHours: number[];
  };
  sessionsSummary?: {
    count: number;
    corrections: number;
    errors: number;
    insights: number;
  };
  auditSummary?: {
    total: number;
    passCount: number;
    failCount: number;
    needsReviewCount: number;
    passRate: number;
    totalCost: number;
    topConcerns: string[];
    retryEscalations: number;
    chronicallyFailingItems: string[];
  };
  estimationSummary?: {
    count: number;
    medianRatio: number;
    trend: "improving" | "worsening" | "stable";
  };
  _processedSessionIds?: string[]; // Internal — not persisted to synthesis output
}

export interface SynthesisState {
  lastRun: string;
  lastRatingsTimestamp: string;
  lastVoiceTimestamp: string;
  lastSessionsProcessed: string[];
  patternHistory: Record<string, number[]>; // pattern -> count history
}

// StateManager for last-synthesis.json
const SynthesisStateSchema = z.object({
  lastRun: z.string(),
  lastRatingsTimestamp: z.string(),
  lastVoiceTimestamp: z.string(),
  lastSessionsProcessed: z.array(z.string()),
  patternHistory: z.record(z.string(), z.array(z.number())),
});

const stateManager = createStateManager<SynthesisState>({
  path: STATE_FILE,
  schema: SynthesisStateSchema,
  defaults: {
    lastRun: "",
    lastRatingsTimestamp: "",
    lastVoiceTimestamp: "",
    lastSessionsProcessed: [],
    patternHistory: {},
  },
});

// ============================================================================
// Trend Computation
// ============================================================================

/**
 * Compute the trend direction for a pattern from its historical counts.
 * Uses simple slope: (last - first) / count.
 * Requires at least 2 data points, otherwise returns "stable".
 */
function computeTrend(history: number[]): Pattern["trend"] {
  if (!history || history.length < 2) return "stable";

  const first = history[0];
  const last = history[history.length - 1];
  const slope = (last - first) / history.length;

  if (Math.abs(slope) < 0.5) return "stable";
  return slope > 0 ? "increasing" : "decreasing";
}

/**
 * Apply real trend data from patternHistory to consolidated patterns.
 * Reads state synchronously to get history, then computes slope for each pattern.
 */
async function applyTrends(patterns: Pattern[]): Promise<void> {
  const state = await stateManager.load();
  const history = state.patternHistory;

  for (const pattern of patterns) {
    const key = `${pattern.category}:${pattern.name}`;
    const patternHist = history[key];
    pattern.trend = computeTrend(patternHist ?? []);
  }
}

// ============================================================================
// Pattern Detection
// ============================================================================

const FRUSTRATION_PATTERNS: Record<string, RegExp> = {
  "Time/Performance Issues": /time|slow|delay|hang|wait|long|minutes|hours/i,
  "Incomplete Work": /incomplete|missing|partial|didn't finish|not done/i,
  "Wrong Approach": /wrong|incorrect|not what|misunderstand|mistake/i,
  "Over-engineering": /over-?engineer|too complex|unnecessary|bloat/i,
  "Tool/System Failures": /^(?!.*(?:fix|resolv|handl|repair|patch|correct|clean)).*(?:fail|error|broken|crash|bug|issue)/i,
  "Communication Problems": /unclear|confus|didn't ask|should have asked/i,
  "Repetitive Issues": /again|repeat|still|same problem/i,
};

const SUCCESS_PATTERNS: Record<string, RegExp> = {
  "Quick Resolution": /quick|fast|efficient|smooth/i,
  "Good Understanding": /understood|clear|exactly|perfect/i,
  "Proactive Help": /proactive|anticipat|helpful|above and beyond/i,
  "Clean Implementation": /clean|simple|elegant|well done/i,
  "Good Communication": /explain|understood|asked|clarif/i,
};

const BEHAVIOR_PATTERNS: Record<string, RegExp> = {
  "Morning Activity": /^(0[6-9]|1[01]):/,
  "Evening Activity": /^(1[8-9]|2[0-3]):/,
  "Coding Focus": /code|implement|fix|debug|test/i,
  "Research Focus": /research|explore|understand|learn/i,
  "Writing Focus": /write|draft|document|note/i,
};

export function detectPatterns(
  items: Array<{ text: string; score?: number; timestamp: string }>,
  patterns: Record<string, RegExp>,
  category: Pattern["category"]
): Pattern[] {
  const results: Map<string, { count: number; scores: number[]; examples: string[]; lastSeen: string }> = new Map();

  for (const item of items) {
    for (const [name, pattern] of Object.entries(patterns)) {
      if (pattern.test(item.text)) {
        const existing = results.get(name) || { count: 0, scores: [], examples: [], lastSeen: "" };
        existing.count++;
        if (item.score !== undefined) existing.scores.push(item.score);
        if (existing.examples.length < 3) existing.examples.push(item.text.slice(0, 100));
        if (item.timestamp > existing.lastSeen) existing.lastSeen = item.timestamp;
        results.set(name, existing);
      }
    }
  }

  return Array.from(results.entries())
    .map(([name, data]) => ({
      name,
      category,
      count: data.count,
      avgScore: data.scores.length > 0 ? data.scores.reduce((a, b) => a + b, 0) / data.scores.length : 0,
      examples: data.examples,
      trend: "stable" as const, // Will be calculated with historical data
      lastSeen: data.lastSeen,
    }))
    .sort((a, b) => b.count - a.count);
}

// ============================================================================
// Phase 7: Skill Insight Synthesis
// ============================================================================

/**
 * Synthesize cross-skill patterns from MemoryStore insights
 * Looks for insights emitted by skills via SkillIntegrationBridge
 */
async function synthesizeSkillInsights(since?: Date): Promise<Pattern[]> {
  try {
    // Search for skill-emitted insights and signals
    const insights = await memoryStore.search({
      type: ['insight', 'signal'],
      tags: ['pattern'],
      since,
      limit: 500,
    });

    if (insights.length === 0) return [];

    // Group by source skill
    const bySource = new Map<string, typeof insights>();
    for (const insight of insights) {
      // Extract skill name from source (e.g., "DevGraph/ContinualLearningBridge" -> "DevGraph")
      const skillName = insight.source?.split('/')[0] || 'unknown';
      const existing = bySource.get(skillName) || [];
      existing.push(insight);
      bySource.set(skillName, existing);
    }

    // Generate cross-skill patterns
    const patterns: Pattern[] = [];
    for (const [source, sourceInsights] of bySource) {
      if (sourceInsights.length >= 3) {
        patterns.push({
          name: `${source} activity trend`,
          category: 'behavior',
          count: sourceInsights.length,
          avgScore: 0,
          trend: 'stable',
          examples: sourceInsights.slice(0, 3).map(i => i.title),
          lastSeen: sourceInsights[0].timestamp,
        });
      }
    }

    return patterns;
  } catch (err) {
    console.error(`[KnowledgeSynthesizer] Failed to synthesize skill insights: ${err}`);
    return [];
  }
}

// ============================================================================
// Data Loaders
// ============================================================================

async function loadRatings(since?: Date): Promise<Rating[]> {
  if (!existsSync(RATINGS_FILE)) return [];

  const content = await Bun.file(RATINGS_FILE).text();
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as Rating;
      } catch {
        return null;
      }
    })
    .filter((r): r is Rating => r !== null)
    .filter((r) => !since || new Date(r.timestamp) >= since);
}

async function loadVoiceEvents(since?: Date): Promise<VoiceEvent[]> {
  if (!existsSync(VOICE_EVENTS_FILE)) return [];

  const content = await Bun.file(VOICE_EVENTS_FILE).text();
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as VoiceEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is VoiceEvent => e !== null)
    .filter((e) => !since || new Date(e.timestamp) >= since);
}

async function loadSessionLearnings(
  since?: Date,
  alreadyProcessed?: Set<string>,
): Promise<SessionLearning[]> {
  const learnings: SessionLearning[] = [];
  const username = process.env.USER || require("os").userInfo().username;
  const projectDir = path.join(PROJECTS_DIR, `-Users-${username}--claude`);

  if (!existsSync(projectDir)) return [];

  const files = readdirSync(projectDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({
      name: f,
      path: path.join(projectDir, f),
      mtime: statSync(path.join(projectDir, f)).mtime,
    }))
    .filter((f) => !since || f.mtime >= since)
    .filter((f) => !alreadyProcessed || !alreadyProcessed.has(f.name.replace(".jsonl", "")))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    .slice(0, 20); // Process at most 20 recent sessions

  const CORRECTION_PATTERNS = [
    /actually,?\s+/i,
    /wait,?\s+/i,
    /no,?\s+i meant/i,
    /let me clarify/i,
    /that's not (quite )?right/i,
  ];

  const ERROR_PATTERNS = [/error:/i, /failed:/i, /exception:/i, /command failed/i];

  const INSIGHT_PATTERNS = [
    /learned that/i,
    /realized that/i,
    /discovered that/i,
    /key insight/i,
    /for next time/i,
  ];

  for (const file of files) {
    try {
      const content = await Bun.file(file.path).text();
      const lines = content.split("\n").filter((l) => l.trim());

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (!entry.message?.content) continue;

          const text =
            typeof entry.message.content === "string"
              ? entry.message.content
              : entry.message.content.map((c: any) => c.text || "").join(" ");

          if (text.length < 20) continue;

          const timestamp = entry.timestamp || new Date().toISOString();
          const sessionId = file.name.replace(".jsonl", "");

          if (entry.type === "user") {
            for (const pattern of CORRECTION_PATTERNS) {
              if (pattern.test(text)) {
                learnings.push({
                  sessionId,
                  timestamp,
                  type: "correction",
                  content: text.slice(0, 300),
                  context: "",
                });
                break;
              }
            }
          }

          if (entry.type === "assistant") {
            for (const pattern of ERROR_PATTERNS) {
              if (pattern.test(text)) {
                learnings.push({
                  sessionId,
                  timestamp,
                  type: "error",
                  content: text.slice(0, 300),
                  context: "",
                });
                break;
              }
            }

            for (const pattern of INSIGHT_PATTERNS) {
              if (pattern.test(text)) {
                learnings.push({
                  sessionId,
                  timestamp,
                  type: "insight",
                  content: text.slice(0, 300),
                  context: "",
                });
                break;
              }
            }
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // Skip files we can't read
    }
  }

  return learnings;
}

// ============================================================================
// Audit Data Loaders
// ============================================================================

export async function loadAuditEntries(since?: Date): Promise<AuditEntry[]> {
  if (!existsSync(AUDIT_FILE)) return [];

  const content = await Bun.file(AUDIT_FILE).text();
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as AuditEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is AuditEntry => e !== null)
    .filter((e) => !since || new Date(e.timestamp) >= since);
}

export async function loadTransitionEntries(since?: Date): Promise<TransitionAuditEntry[]> {
  if (!existsSync(TRANSITION_AUDIT_FILE)) return [];

  const content = await Bun.file(TRANSITION_AUDIT_FILE).text();
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as TransitionAuditEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is TransitionAuditEntry => e !== null)
    .filter((e) => !since || new Date(e.timestamp) >= since);
}

export interface EstimationAccuracyEntry {
  timestamp: string;
  taskTitle: string;
  estimatedMinutes: number;
  actualMinutes: number;
  ratio: number;
  source: "lucidtasks" | "workqueue";
}

export async function loadEstimationAccuracy(since?: Date): Promise<EstimationAccuracyEntry[]> {
  if (!existsSync(ESTIMATION_ACCURACY_FILE)) return [];

  const content = await Bun.file(ESTIMATION_ACCURACY_FILE).text();
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as EstimationAccuracyEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is EstimationAccuracyEntry => e !== null)
    .filter((e) => !since || new Date(e.timestamp) >= since);
}

/**
 * Calculate aggregate estimation accuracy stats from signal entries.
 */
export function calculateEstimationStats(entries: EstimationAccuracyEntry[]): {
  medianRatio: number;
  count: number;
  trend: "improving" | "worsening" | "stable";
} {
  if (entries.length === 0) return { medianRatio: 0, count: 0, trend: "stable" };

  const ratios = entries.map((e) => e.ratio).sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  const medianRatio = ratios.length % 2 !== 0 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2;

  // Trend: compare first half vs second half median
  let trend: "improving" | "worsening" | "stable" = "stable";
  if (entries.length >= 6) {
    const halfIdx = Math.floor(entries.length / 2);
    const firstHalf = entries.slice(0, halfIdx).map((e) => e.ratio);
    const secondHalf = entries.slice(halfIdx).map((e) => e.ratio);
    const firstMedian = firstHalf.sort((a, b) => a - b)[Math.floor(firstHalf.length / 2)]!;
    const secondMedian = secondHalf.sort((a, b) => a - b)[Math.floor(secondHalf.length / 2)]!;
    // Closer to 1.0 is improving
    const firstDist = Math.abs(firstMedian - 1);
    const secondDist = Math.abs(secondMedian - 1);
    if (secondDist < firstDist - 0.1) trend = "improving";
    else if (secondDist > firstDist + 0.1) trend = "worsening";
  }

  return { medianRatio: Math.round(medianRatio * 100) / 100, count: entries.length, trend };
}

// ============================================================================
// Synthesis Engine
// ============================================================================

export async function synthesize(options: {
  period: "week" | "month" | "all";
  sources: string[];
  dryRun?: boolean;
}): Promise<SynthesisResult> {
  const now = new Date();
  let since: Date | undefined;

  if (options.period === "week") {
    since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (options.period === "month") {
    since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }

  const result: SynthesisResult = {
    timestamp: now.toISOString(),
    period: options.period,
    periodStart: since?.toISOString() || "all-time",
    periodEnd: now.toISOString(),
    sources: options.sources,
    totalDataPoints: 0,
    patterns: [],
    insights: [],
    recommendations: [],
  };

  const allPatterns: Pattern[] = [];

  // Process ratings
  if (options.sources.includes("ratings")) {
    const ratings = await loadRatings(since);
    result.totalDataPoints += ratings.length;

    if (ratings.length > 0) {
      const avgRating = ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length;
      result.ratingsSummary = {
        count: ratings.length,
        avgRating,
        trend: avgRating >= 7 ? "positive" : avgRating >= 5 ? "neutral" : "needs attention",
      };

      // Detect frustration patterns from low ratings
      const frustrationItems = ratings
        .filter((r) => r.rating <= 4)
        .map((r) => ({ text: r.sentiment_summary, score: r.rating, timestamp: r.timestamp }));

      const successItems = ratings
        .filter((r) => r.rating >= 7)
        .map((r) => ({ text: r.sentiment_summary, score: r.rating, timestamp: r.timestamp }));

      allPatterns.push(...detectPatterns(frustrationItems, FRUSTRATION_PATTERNS, "frustration"));
      allPatterns.push(...detectPatterns(successItems, SUCCESS_PATTERNS, "success"));
    }
  }

  // Process voice events
  if (options.sources.includes("voice")) {
    const voiceEvents = await loadVoiceEvents(since);
    result.totalDataPoints += voiceEvents.length;

    if (voiceEvents.length > 0) {
      const failures = voiceEvents.filter((e) => e.event_type === "failed");
      const hourlyDist: Record<number, number> = {};
      for (const e of voiceEvents) {
        const hour = new Date(e.timestamp).getHours();
        hourlyDist[hour] = (hourlyDist[hour] || 0) + 1;
      }
      const peakHours = Object.entries(hourlyDist)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([h]) => parseInt(h));

      result.voiceSummary = {
        count: voiceEvents.length,
        errorRate: failures.length / voiceEvents.length,
        peakHours,
      };

      // Detect behavior patterns from voice messages
      const behaviorItems = voiceEvents.map((e) => ({
        text: e.message,
        timestamp: e.timestamp,
      }));
      allPatterns.push(...detectPatterns(behaviorItems, BEHAVIOR_PATTERNS, "behavior"));
    }
  }

  // Process session learnings
  if (options.sources.includes("sessions")) {
    const state = await stateManager.load();
    const processedSet = new Set(state.lastSessionsProcessed);
    const learnings = await loadSessionLearnings(since, processedSet);
    result.totalDataPoints += learnings.length;

    // Track which sessions we processed this run
    const newSessionIds = [...new Set(learnings.map((l) => l.sessionId))];
    result._processedSessionIds = newSessionIds;

    if (learnings.length > 0) {
      result.sessionsSummary = {
        count: new Set(learnings.map((l) => l.sessionId)).size,
        corrections: learnings.filter((l) => l.type === "correction").length,
        errors: learnings.filter((l) => l.type === "error").length,
        insights: learnings.filter((l) => l.type === "insight").length,
      };

      // Corrections indicate frustration patterns
      const correctionItems = learnings
        .filter((l) => l.type === "correction")
        .map((l) => ({ text: l.content, timestamp: l.timestamp }));
      allPatterns.push(...detectPatterns(correctionItems, FRUSTRATION_PATTERNS, "frustration"));
    }
  }

  // Process MemoryStore entries
  if (options.sources.includes("memory")) {
    const entries = await memoryStore.search({
      type: "learning",
      since,
      limit: 100,
    });
    result.totalDataPoints += entries.length;

    const memoryItems = entries.map((e) => ({
      text: e.content,
      timestamp: e.timestamp,
    }));
    allPatterns.push(...detectPatterns(memoryItems, SUCCESS_PATTERNS, "preference"));

    // Phase 7: Integration Backbone - Synthesize skill insights from MemoryStore
    const skillPatterns = await synthesizeSkillInsights(since);
    allPatterns.push(...skillPatterns);
  }

  // Process graph-backed agent observability patterns
  if (options.sources.includes("graph")) {
    try {
      const graphPatterns = await memoryStore.search({
        type: ['insight'],
        tags: ['graph', 'pattern'],
        since,
        limit: 200,
      });
      result.totalDataPoints += graphPatterns.length;

      if (graphPatterns.length > 0) {
        // Separate by pattern type for targeted synthesis
        const traceFailures = graphPatterns.filter(p =>
          p.tags?.includes('trace-failure') || p.tags?.includes('trace_failure_pattern')
        );
        const fileCorrelations = graphPatterns.filter(p =>
          p.tags?.includes('file-failure-correlation') || p.tags?.includes('file_failure_correlation')
        );
        const efficiencyTrends = graphPatterns.filter(p =>
          p.tags?.includes('efficiency-regression') || p.tags?.includes('trace_efficiency_trend')
        );

        // Create observability patterns
        if (traceFailures.length > 0) {
          allPatterns.push({
            name: `Agent failure patterns (${traceFailures.length} detected)`,
            category: 'agent_observability',
            count: traceFailures.length,
            avgScore: 0,
            trend: 'stable',
            examples: traceFailures.slice(0, 3).map(p => p.title),
            lastSeen: traceFailures[0].timestamp,
          });
        }

        if (fileCorrelations.length > 0) {
          allPatterns.push({
            name: `Failure-correlated files (${fileCorrelations.length} files)`,
            category: 'agent_observability',
            count: fileCorrelations.length,
            avgScore: 3,
            trend: 'stable',
            examples: fileCorrelations.slice(0, 3).map(p => p.title),
            lastSeen: fileCorrelations[0].timestamp,
          });
        }

        if (efficiencyTrends.length > 0) {
          allPatterns.push({
            name: `Agent efficiency regressions (${efficiencyTrends.length} trends)`,
            category: 'agent_observability',
            count: efficiencyTrends.length,
            avgScore: 0,
            trend: 'stable',
            examples: efficiencyTrends.slice(0, 3).map(p => p.title),
            lastSeen: efficiencyTrends[0].timestamp,
          });
        }
      }
    } catch (err) {
      console.error(`[KnowledgeSynthesizer] Graph source failed: ${err}`);
    }
  }

  // Process audit entries (AutonomousWork verification results)
  if (options.sources.includes("audit")) {
    const auditEntries = await loadAuditEntries(since);
    result.totalDataPoints += auditEntries.length;

    if (auditEntries.length > 0) {
      const passCount = auditEntries.filter((e) => e.verdict === "PASS").length;
      const failCount = auditEntries.filter((e) => e.verdict === "FAIL").length;
      const needsReviewCount = auditEntries.filter((e) => e.verdict === "NEEDS_REVIEW").length;
      const totalCost = auditEntries.reduce((sum, e) => sum + e.verificationCost, 0);

      // Count concern frequency across all entries
      const concernCounts = new Map<string, number>();
      for (const entry of auditEntries) {
        for (const concern of entry.concerns) {
          const key = concern.slice(0, 80);
          concernCounts.set(key, (concernCounts.get(key) || 0) + 1);
        }
      }
      const topConcerns = Array.from(concernCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([concern, count]) => `${concern} (${count}x)`);

      // Find chronically failing items (2+ FAILs)
      const failCountByItem = new Map<string, { count: number; title: string }>();
      for (const entry of auditEntries.filter((e) => e.verdict === "FAIL")) {
        const existing = failCountByItem.get(entry.itemId) || { count: 0, title: entry.itemTitle };
        existing.count++;
        failCountByItem.set(entry.itemId, existing);
      }
      const chronicallyFailingItems = Array.from(failCountByItem.entries())
        .filter(([, data]) => data.count >= 2)
        .map(([id, data]) => `${data.title} (${data.count} failures)`);

      result.auditSummary = {
        total: auditEntries.length,
        passCount,
        failCount,
        needsReviewCount,
        passRate: auditEntries.length > 0 ? passCount / auditEntries.length : 0,
        totalCost,
        topConcerns,
        retryEscalations: 0, // Will be set from transitions if available
        chronicallyFailingItems,
      };

      // Convert audit entries to items for pattern detection
      const auditItems = auditEntries
        .filter((e) => e.concerns.length > 0)
        .map((e) => ({
          text: `${e.itemTitle}: ${e.concerns.join(", ")}`,
          score: e.verdict === "PASS" ? 8 : e.verdict === "FAIL" ? 2 : 5,
          timestamp: e.timestamp,
        }));
      allPatterns.push(...detectPatterns(auditItems, FRUSTRATION_PATTERNS, "frustration"));
    }
  }

  // Process transition audit entries (status changes, retry escalations)
  if (options.sources.includes("transitions")) {
    const transitionEntries = await loadTransitionEntries(since);
    result.totalDataPoints += transitionEntries.length;

    if (transitionEntries.length > 0) {
      // Count retry escalations (verification_set entries where verdict stays FAIL)
      const retryEscalations = transitionEntries.filter(
        (e) => e.action === "verification_set" && e.from === "FAIL" && e.to === "FAIL"
      ).length;

      // Update auditSummary if it exists
      if (result.auditSummary) {
        result.auditSummary.retryEscalations = retryEscalations;
      }

      // Convert transitions to behavior pattern items
      const transitionItems = transitionEntries.map((e) => ({
        text: `${e.action}: ${e.from} → ${e.to}${e.reason ? ` (${e.reason})` : ""}`,
        timestamp: e.timestamp,
      }));
      allPatterns.push(...detectPatterns(transitionItems, BEHAVIOR_PATTERNS, "behavior"));
    }
  }

  // Process estimation accuracy signals
  if (options.sources.includes("estimation")) {
    const estimationEntries = await loadEstimationAccuracy(since);
    result.totalDataPoints += estimationEntries.length;

    if (estimationEntries.length > 0) {
      const stats = calculateEstimationStats(estimationEntries);
      result.estimationSummary = {
        count: stats.count,
        medianRatio: stats.medianRatio,
        trend: stats.trend,
      };

      if (stats.medianRatio > 1.2) {
        allPatterns.push({
          name: `Estimation overestimation (${stats.medianRatio}x median ratio)`,
          category: "estimation",
          count: stats.count,
          avgScore: 0,
          trend: stats.trend === "improving" ? "improving" : "stable",
          examples: estimationEntries.slice(-3).map((e) => `${e.taskTitle}: est ${e.estimatedMinutes}m, actual ${e.actualMinutes}m`),
          lastSeen: estimationEntries[estimationEntries.length - 1]!.timestamp,
        });
      } else if (stats.medianRatio < 0.8) {
        allPatterns.push({
          name: `Estimation underestimation (${stats.medianRatio}x median ratio)`,
          category: "estimation",
          count: stats.count,
          avgScore: 0,
          trend: stats.trend === "improving" ? "improving" : "stable",
          examples: estimationEntries.slice(-3).map((e) => `${e.taskTitle}: est ${e.estimatedMinutes}m, actual ${e.actualMinutes}m`),
          lastSeen: estimationEntries[estimationEntries.length - 1]!.timestamp,
        });
      }
    }
  }

  // Consolidate patterns (merge duplicates, calculate overall trends)
  const patternMap = new Map<string, Pattern>();
  for (const p of allPatterns) {
    const key = `${p.category}:${p.name}`;
    const existing = patternMap.get(key);
    if (existing) {
      existing.count += p.count;
      existing.examples.push(...p.examples);
      existing.examples = existing.examples.slice(0, 3);
      if (p.lastSeen > existing.lastSeen) existing.lastSeen = p.lastSeen;
    } else {
      patternMap.set(key, { ...p });
    }
  }
  result.patterns = Array.from(patternMap.values()).sort((a, b) => b.count - a.count);

  // Apply real trend computation from pattern history
  await applyTrends(result.patterns);

  // Generate insights based on patterns
  result.insights = generateInsights(result);

  // Generate recommendations (inference-driven with static fallback)
  result.recommendations = await generateRecommendations(result);

  // Save synthesis result if not dry-run
  if (!options.dryRun) {
    await saveSynthesis(result);
    await updateState(result);
  }

  return result;
}

function generateInsights(result: SynthesisResult): string[] {
  const insights: string[] = [];

  // Rating insights
  if (result.ratingsSummary) {
    if (result.ratingsSummary.avgRating >= 8) {
      insights.push(
        `Strong performance: ${result.ratingsSummary.avgRating.toFixed(1)}/10 average rating across ${result.ratingsSummary.count} sessions`
      );
    } else if (result.ratingsSummary.avgRating < 5) {
      insights.push(
        `Attention needed: ${result.ratingsSummary.avgRating.toFixed(1)}/10 average rating suggests recurring issues`
      );
    }
  }

  // Frustration pattern insights
  const frustrations = result.patterns.filter((p) => p.category === "frustration");
  if (frustrations.length > 0 && frustrations[0].count >= 3) {
    insights.push(
      `Top recurring issue: "${frustrations[0].name}" detected ${frustrations[0].count} times`
    );
  }

  // Success pattern insights
  const successes = result.patterns.filter((p) => p.category === "success");
  if (successes.length > 0 && successes[0].count >= 3) {
    insights.push(
      `Strength identified: "${successes[0].name}" consistently succeeds (${successes[0].count} occurrences)`
    );
  }

  // Agent Observability insights
  const observability = result.patterns.filter((p) => p.category === "agent_observability");
  if (observability.length > 0) {
    for (const pattern of observability) {
      insights.push(`Agent Observability: ${pattern.name}`);
    }
  }

  // Voice insights
  if (result.voiceSummary) {
    if (result.voiceSummary.errorRate > 0.3) {
      insights.push(
        `Voice system reliability concern: ${(result.voiceSummary.errorRate * 100).toFixed(0)}% failure rate`
      );
    }
    if (result.voiceSummary.peakHours.length > 0) {
      insights.push(`Peak usage hours: ${result.voiceSummary.peakHours.join(", ")}:00`);
    }
  }

  // Session insights
  if (result.sessionsSummary) {
    if (result.sessionsSummary.corrections > result.sessionsSummary.insights) {
      insights.push(
        `More corrections (${result.sessionsSummary.corrections}) than insights (${result.sessionsSummary.insights}) - consider asking more clarifying questions`
      );
    }
  }

  // Audit insights
  if (result.auditSummary) {
    const audit = result.auditSummary;
    if (audit.passRate < 0.7 && audit.total >= 5) {
      insights.push(
        `Autonomous work quality concern: ${(audit.passRate * 100).toFixed(0)}% pass rate across ${audit.total} verifications`
      );
    }
    if (audit.chronicallyFailingItems.length > 0) {
      insights.push(
        `Chronically failing items need manual intervention: ${audit.chronicallyFailingItems.join(", ")}`
      );
    }
    if (audit.topConcerns.length > 0) {
      const topConcern = audit.topConcerns[0];
      if (topConcern.includes("3x") || topConcern.includes("4x") || topConcern.includes("5x") || parseInt(topConcern.match(/\((\d+)x\)/)?.[1] || "0") >= 3) {
        insights.push(`Recurring verification concern: ${topConcern}`);
      }
    }
    if (audit.retryEscalations >= 5) {
      insights.push(
        `High retry escalation rate: ${audit.retryEscalations} verification retries that stayed FAIL — consider reviewing work item specs`
      );
    }
  }

  return insights;
}

/**
 * Generate contextual, data-driven fallback recommendations.
 * Used when inference fails. Unlike the old switch/case, these reference
 * actual pattern data (counts, trends, examples).
 */
function generateStaticRecommendations(frustrations: Pattern[]): string[] {
  const recommendations: string[] = [];

  for (const f of frustrations.slice(0, 3)) {
    const trendNote = f.trend === "increasing" ? " (getting worse)" : f.trend === "decreasing" ? " (improving)" : "";
    const exampleNote = f.examples.length > 0 ? ` — e.g., "${f.examples[0].slice(0, 60)}"` : "";

    switch (f.name) {
      case "Time/Performance Issues":
        recommendations.push(`Address time/performance issues (${f.count}x${trendNote}): set time expectations upfront and provide progress updates${exampleNote}`);
        break;
      case "Wrong Approach":
        recommendations.push(`Reduce wrong approaches (${f.count}x${trendNote}): ask clarifying questions before starting complex tasks${exampleNote}`);
        break;
      case "Over-engineering":
        recommendations.push(`Avoid over-engineering (${f.count}x${trendNote}): default to simpler solutions, add complexity only when justified${exampleNote}`);
        break;
      case "Communication Problems":
        recommendations.push(`Improve communication (${f.count}x${trendNote}): summarize understanding before implementation${exampleNote}`);
        break;
      case "Incomplete Work":
        recommendations.push(`Complete work fully (${f.count}x${trendNote}): break large tasks into smaller, completable units${exampleNote}`);
        break;
      case "Tool/System Failures":
        recommendations.push(`Mitigate tool failures (${f.count}x${trendNote}): try alternative approaches before retrying failed operations${exampleNote}`);
        break;
      case "Repetitive Issues":
        recommendations.push(`Break repetition cycle (${f.count}x${trendNote}): document root causes and apply permanent fixes${exampleNote}`);
        break;
      default:
        recommendations.push(`Address "${f.name}" pattern (${f.count}x${trendNote})${exampleNote}`);
        break;
    }
  }

  return recommendations;
}

/**
 * Generate adaptive recommendations using inference, with static fallback.
 * Calls Inference.ts fast (Haiku) to produce contextual, data-driven recommendations
 * that reference specific pattern data instead of generic advice.
 */
async function generateRecommendations(result: SynthesisResult): Promise<string[]> {
  const frustrations = result.patterns.filter((p) => p.category === "frustration");

  if (frustrations.length === 0) {
    return ["Continue current patterns - no major issues detected"];
  }

  // Prepare pattern data for inference
  const topFrustrations = frustrations.slice(0, 3).map((f) => ({
    name: f.name,
    count: f.count,
    trend: f.trend,
    examples: f.examples.slice(0, 2),
  }));

  const successes = result.patterns
    .filter((p) => p.category === "success")
    .slice(0, 2)
    .map((s) => ({ name: s.name, count: s.count }));

  try {
    const inferenceToolPath = path.join(CLAUDE_DIR, "lib", "core", "Inference.ts");

    const promptData = JSON.stringify({ frustrations: topFrustrations, successes });
    const systemPrompt = "You are a concise behavioral analyst. Generate exactly 2 specific, actionable recommendations based on the frustration patterns provided. Each recommendation must reference the actual pattern data (counts, trends). Keep each recommendation under 30 words. Output as a JSON array of 2 strings.";
    const userPrompt = `Frustration patterns detected in AI assistant interactions:\n${promptData}\n\nGenerate 2 recommendations that address the top issues.`;

    const proc = Bun.spawn(
      ["bun", inferenceToolPath, "--level", "fast", "--json", systemPrompt, userPrompt],
      { stdout: "pipe", stderr: "pipe", timeout: 20000 }
    );

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    if (proc.exitCode === 0 && output.trim()) {
      // Try to parse the inference output as JSON
      const parsed = JSON.parse(output.trim());
      // The inference tool with --json returns { success, output, parsed }
      const inferenceResult = parsed as { success: boolean; output: string; parsed?: unknown };

      if (inferenceResult.success && inferenceResult.parsed) {
        const recs = inferenceResult.parsed;
        if (Array.isArray(recs) && recs.length > 0 && recs.every((r) => typeof r === "string")) {
          return recs.slice(0, 2);
        }
      }

      // If parsed field didn't work, try parsing the output string directly
      if (inferenceResult.success && inferenceResult.output) {
        try {
          const directParsed = JSON.parse(inferenceResult.output);
          if (Array.isArray(directParsed) && directParsed.length > 0 && directParsed.every((r: unknown) => typeof r === "string")) {
            return (directParsed as string[]).slice(0, 2);
          }
        } catch {
          // Output wasn't valid JSON array, fall through to static
        }
      }
    }
  } catch (err) {
    console.error(`[KnowledgeSynthesizer] Inference failed, using static fallback: ${err}`);
  }

  // Fallback to improved pattern-specific static recommendations
  const staticRecs = generateStaticRecommendations(frustrations);
  return [...new Set(staticRecs)].slice(0, 2);
}

// ============================================================================
// Persistence
// ============================================================================

async function saveSynthesis(result: SynthesisResult): Promise<string> {
  const date = new Date().toISOString().split("T")[0];
  const outputDir = path.join(SYNTHESIS_OUTPUT_DIR, new Date().toISOString().slice(0, 7));

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const filename = `${date}-${result.period}-synthesis.md`;
  const filepath = path.join(outputDir, filename);

  const content = formatSynthesisReport(result);
  await Bun.write(filepath, content);

  // Also store in MemoryStore for indexing
  await memoryStore.capture({
    type: "insight",
    category: "SYNTHESIS",
    title: `${result.period} Knowledge Synthesis - ${date}`,
    content: JSON.stringify(result),
    tags: ["synthesis", result.period, ...result.patterns.slice(0, 5).map((p) => p.name.toLowerCase().replace(/\s+/g, "-"))],
    tier: "warm",
    source: "KnowledgeSynthesizer",
  });

  return filepath;
}

function formatSynthesisReport(result: SynthesisResult): string {
  const date = new Date().toISOString().split("T")[0];

  let content = `# Knowledge Synthesis Report

**Period:** ${result.period} (${result.periodStart} to ${result.periodEnd})
**Generated:** ${date}
**Data Points:** ${result.totalDataPoints}
**Sources:** ${result.sources.join(", ")}

---

## Key Insights

${result.insights.map((i, idx) => `${idx + 1}. ${i}`).join("\n")}

## Patterns Detected

`;

  const patternsByCategory = new Map<string, Pattern[]>();
  for (const p of result.patterns) {
    const list = patternsByCategory.get(p.category) || [];
    list.push(p);
    patternsByCategory.set(p.category, list);
  }

  for (const [category, patterns] of patternsByCategory) {
    content += `### ${category.charAt(0).toUpperCase() + category.slice(1)} Patterns

`;
    for (const p of patterns.slice(0, 5)) {
      content += `- **${p.name}** (${p.count}x)
`;
      if (p.examples.length > 0) {
        content += `  - Example: "${p.examples[0].slice(0, 80)}..."
`;
      }
    }
    content += "\n";
  }

  if (result.ratingsSummary) {
    content += `## Ratings Summary

| Metric | Value |
|--------|-------|
| Count | ${result.ratingsSummary.count} |
| Average | ${result.ratingsSummary.avgRating.toFixed(1)}/10 |
| Trend | ${result.ratingsSummary.trend} |

`;
  }

  if (result.voiceSummary) {
    content += `## Voice Summary

| Metric | Value |
|--------|-------|
| Events | ${result.voiceSummary.count} |
| Error Rate | ${(result.voiceSummary.errorRate * 100).toFixed(1)}% |
| Peak Hours | ${result.voiceSummary.peakHours.join(", ")}:00 |

`;
  }

  if (result.sessionsSummary) {
    content += `## Sessions Summary

| Metric | Value |
|--------|-------|
| Sessions | ${result.sessionsSummary.count} |
| Corrections | ${result.sessionsSummary.corrections} |
| Errors | ${result.sessionsSummary.errors} |
| Insights | ${result.sessionsSummary.insights} |

`;
  }

  if (result.auditSummary) {
    const audit = result.auditSummary;
    content += `## Autonomous Work Audit Summary

| Metric | Value |
|--------|-------|
| Total Verifications | ${audit.total} |
| Pass | ${audit.passCount} |
| Fail | ${audit.failCount} |
| Needs Review | ${audit.needsReviewCount} |
| Pass Rate | ${(audit.passRate * 100).toFixed(1)}% |
| Total Cost | $${audit.totalCost.toFixed(4)} |
| Retry Escalations | ${audit.retryEscalations} |

`;
    if (audit.topConcerns.length > 0) {
      content += `### Top Concerns\n\n${audit.topConcerns.map((c) => `- ${c}`).join("\n")}\n\n`;
    }
    if (audit.chronicallyFailingItems.length > 0) {
      content += `### Chronically Failing Items\n\n${audit.chronicallyFailingItems.map((i) => `- ${i}`).join("\n")}\n\n`;
    }
  }

  content += `## Recommendations

${result.recommendations.map((r, idx) => `${idx + 1}. ${r}`).join("\n")}

---

*Generated by KnowledgeSynthesizer | ContinualLearning Skill*
`;

  return content;
}

async function updateState(result: SynthesisResult): Promise<void> {
  const stateDir = path.dirname(STATE_FILE);
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }

  // Load and update state using StateManager
  await stateManager.update((state) => {
    // Merge newly processed sessions with existing list, cap at 200 to prevent unbounded growth
    const mergedSessions = [
      ...new Set([...state.lastSessionsProcessed, ...(result._processedSessionIds || [])]),
    ].slice(-200);

    const updated = {
      ...state,
      lastRun: result.timestamp,
      lastRatingsTimestamp: result.periodEnd,
      lastSessionsProcessed: mergedSessions,
    };

    // Track pattern history for trend detection
    for (const p of result.patterns) {
      const key = `${p.category}:${p.name}`;
      const history = updated.patternHistory[key] || [];
      history.push(p.count);
      if (history.length > 10) history.shift(); // Keep last 10 data points
      updated.patternHistory[key] = history;
    }

    return updated;
  });
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      week: { type: "boolean" },
      month: { type: "boolean" },
      all: { type: "boolean" },
      source: { type: "string" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`
KnowledgeSynthesizer - Unified multi-source knowledge synthesis

Usage:
  bun run KnowledgeSynthesizer.ts --week       Synthesize last 7 days (default)
  bun run KnowledgeSynthesizer.ts --month      Synthesize last 30 days
  bun run KnowledgeSynthesizer.ts --all        Synthesize all available data
  bun run KnowledgeSynthesizer.ts --source X   Specify sources (comma-separated)
  bun run KnowledgeSynthesizer.ts --dry-run    Preview without writing
  bun run KnowledgeSynthesizer.ts --json       Output as JSON

Sources: ratings, voice, sessions, memory, audit, transitions (default: all)

Output: MEMORY/LEARNING/SYNTHESIS/YYYY-MM/YYYY-MM-DD-period-synthesis.md
`);
    process.exit(0);
  }

  const period: "week" | "month" | "all" = values.all ? "all" : values.month ? "month" : "week";
  const sources = values.source
    ? values.source.split(",").map((s) => s.trim())
    : ["ratings", "voice", "sessions", "memory", "graph", "audit", "transitions"];

  console.log(`🧠 Knowledge Synthesizer`);
  console.log(`   Period: ${period}`);
  console.log(`   Sources: ${sources.join(", ")}`);
  console.log(``);

  const result = await synthesize({
    period,
    sources,
    dryRun: values["dry-run"],
  });

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`📊 Synthesis Complete`);
    console.log(`   Data points: ${result.totalDataPoints}`);
    console.log(`   Patterns found: ${result.patterns.length}`);
    console.log(`   Insights: ${result.insights.length}`);
    console.log(``);

    if (result.insights.length > 0) {
      console.log(`💡 Key Insights:`);
      for (const insight of result.insights.slice(0, 3)) {
        console.log(`   - ${insight}`);
      }
      console.log(``);
    }

    if (result.recommendations.length > 0) {
      console.log(`📌 Recommendations:`);
      for (const rec of result.recommendations.slice(0, 3)) {
        console.log(`   - ${rec}`);
      }
    }

    if (!values["dry-run"]) {
      console.log(`\n✅ Synthesis saved to MEMORY/LEARNING/SYNTHESIS/`);
    } else {
      console.log(`\n🔍 DRY RUN - No files written`);
    }
  }
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}

// Export for library use
export { loadRatings, loadVoiceEvents, loadSessionLearnings, computeTrend };

// ============================================================================
// SkillInvoker Integration (2026-02-02)
// ============================================================================
//
// For enhanced pattern synthesis, this tool can be extended to use SkillInvoker
// with Fabric patterns and Prompting templates:
//
// import { invokeSkill } from '../../../../lib/core/SkillInvoker.ts';
//
// // Extract wisdom from synthesized learnings
// async function enhancedSynthesis(content: string): Promise<string> {
//   const wisdomResult = await invokeSkill({
//     skill: 'Fabric',
//     args: 'extract_wisdom',
//     timeout: 60000,
//   });
//   // Pipe content via stdin simulation or temp file
//   return wisdomResult.output || '';
// }
//
// // Generate intelligence briefing from Prompting template
// async function generateBriefing(synthesisData: SynthesisResult): Promise<string> {
//   const briefingResult = await invokeSkill({
//     skill: 'Prompting',
//     args: '--template Primitives/Briefing.hbs --data synthesis.yaml'
//   });
//   return briefingResult.output || '';
// }
//
// Integration Points:
// - generateInsights() → Fabric:extract_insights for deeper pattern extraction
// - generateRecommendations() → Fabric:analyze_claims for validation
// - formatSynthesisReport() → Prompting:Structure.hbs for consistent formatting
// - Session learnings → Fabric:extract_wisdom for actionable distillation
