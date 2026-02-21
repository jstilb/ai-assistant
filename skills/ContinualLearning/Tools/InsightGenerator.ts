#!/usr/bin/env bun
/**
 * InsightGenerator - Generate actionable intelligence and briefings
 *
 * Produces:
 * - Daily intelligence summaries
 * - Weekly pattern reports
 * - Goal-connected insights
 * - Proactive recommendations
 *
 * Commands:
 *   --daily           Generate daily briefing
 *   --weekly          Generate weekly intelligence report
 *   --goal GOAL_ID    Generate goal-focused insights
 *   --topic TOPIC     Generate insights for a specific topic
 *   --json            Output as JSON
 *
 * Examples:
 *   bun run InsightGenerator.ts --daily
 *   bun run InsightGenerator.ts --weekly
 *   bun run InsightGenerator.ts --goal G28
 */

import { parseArgs } from "util";
import { existsSync, mkdirSync } from "fs";
import * as path from "path";
import { synthesize, type SynthesisResult } from "./KnowledgeSynthesizer";
import { connectToGoals, getGoal, loadTelosContext, type Goal } from "./GoalConnector";
import { detectChanges, loadBaseline } from "./ChangeDetector";
import { memoryStore } from "../../CORE/Tools/MemoryStore";

// ============================================================================
// Configuration
// ============================================================================

const CLAUDE_DIR = path.join(process.env.HOME!, ".claude");
const OUTPUT_DIR = path.join(CLAUDE_DIR, "MEMORY", "LEARNING", "INSIGHTS");

// ============================================================================
// Types
// ============================================================================

export interface DailyBriefing {
  date: string;
  greeting: string;
  quickStats: {
    sessionsYesterday: number;
    avgRating: number;
    topPattern: string;
    activeGoals: number;
  };
  highlights: string[];
  actionItems: string[];
  focusRecommendation: string;
  goalProgress: Array<{
    goalId: string;
    goalTitle: string;
    recentActivity: string;
  }>;
}

export interface WeeklyIntelligence {
  weekOf: string;
  summary: string;
  patternAnalysis: {
    emerging: string[];
    declining: string[];
    stable: string[];
  };
  goalConnections: Array<{
    goalId: string;
    goalTitle: string;
    insightCount: number;
    topInsight: string;
  }>;
  recommendations: string[];
  nextWeekFocus: string[];
}

export interface TopicInsight {
  topic: string;
  relevantGoals: Array<{ id: string; title: string; relevance: number }>;
  relatedLearnings: Array<{ title: string; date: string; summary: string }>;
  patterns: string[];
  recommendations: string[];
}

// ============================================================================
// Briefing Generators
// ============================================================================

export async function generateDailyBriefing(): Promise<DailyBriefing> {
  const today = new Date();
  const dateStr = today.toISOString().split("T")[0];

  // Get recent synthesis
  const synthesis = await synthesize({
    period: "week",
    sources: ["ratings", "sessions"],
    dryRun: true,
  });

  // Get TELOS context
  const telosContext = await loadTelosContext();
  const wigs = telosContext.goals.filter((g) => g.isWIG);

  // Get recent memory entries
  const recentLearnings = await memoryStore.search({
    type: "learning",
    since: new Date(Date.now() - 24 * 60 * 60 * 1000),
    limit: 5,
  });

  // Build briefing
  const briefing: DailyBriefing = {
    date: dateStr,
    greeting: getGreeting(),
    quickStats: {
      sessionsYesterday: synthesis.sessionsSummary?.count || 0,
      avgRating: synthesis.ratingsSummary?.avgRating || 0,
      topPattern: synthesis.patterns[0]?.name || "No patterns yet",
      activeGoals: wigs.length,
    },
    highlights: [],
    actionItems: [],
    focusRecommendation: "",
    goalProgress: [],
  };

  // Generate highlights from synthesis
  if (synthesis.insights.length > 0) {
    briefing.highlights = synthesis.insights.slice(0, 3);
  } else {
    briefing.highlights = ["No significant insights from yesterday's activity"];
  }

  // Generate action items from patterns
  const frustrations = synthesis.patterns.filter((p) => p.category === "frustration");
  if (frustrations.length > 0) {
    briefing.actionItems.push(
      `Address recurring issue: ${frustrations[0].name} (${frustrations[0].count} occurrences)`
    );
  }

  // Add action items from recommendations
  briefing.actionItems.push(...synthesis.recommendations.slice(0, 2));

  // Focus recommendation based on day of week and patterns
  briefing.focusRecommendation = generateFocusRecommendation(today, synthesis, wigs);

  // Goal progress from recent learnings
  for (const wig of wigs.slice(0, 3)) {
    const connections = await connectToGoals(wig.title, telosContext);
    const relatedLearnings: typeof recentLearnings = [];
    for (const l of recentLearnings) {
      const lConnections = await connectToGoals(l.content, telosContext);
      if (lConnections.some((c) => c.goalId === wig.id)) {
        relatedLearnings.push(l);
      }
    }

    briefing.goalProgress.push({
      goalId: wig.id,
      goalTitle: wig.title,
      recentActivity:
        relatedLearnings.length > 0
          ? `${relatedLearnings.length} related learning(s)`
          : "No recent activity",
    });
  }

  return briefing;
}

export async function generateWeeklyIntelligence(): Promise<WeeklyIntelligence> {
  const today = new Date();
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - 7);

  // Get weekly synthesis
  const synthesis = await synthesize({
    period: "week",
    sources: ["ratings", "voice", "sessions", "memory"],
    dryRun: true,
  });

  // Get TELOS context
  const telosContext = await loadTelosContext();

  // Get all learnings from the week
  const weeklyLearnings = await memoryStore.search({
    type: "learning",
    since: weekStart,
    limit: 50,
  });

  // Analyze patterns
  const patternAnalysis = analyzePatternTrends(synthesis);

  // Build goal connections
  const goalConnections: WeeklyIntelligence["goalConnections"] = [];
  for (const goal of telosContext.goals.filter((g) => g.isWIG)) {
    const relatedLearnings: typeof weeklyLearnings = [];
    for (const l of weeklyLearnings) {
      const connections = await connectToGoals(l.content, telosContext);
      if (connections.some((c) => c.goalId === goal.id)) {
        relatedLearnings.push(l);
      }
    }

    if (relatedLearnings.length > 0) {
      goalConnections.push({
        goalId: goal.id,
        goalTitle: goal.title,
        insightCount: relatedLearnings.length,
        topInsight: relatedLearnings[0].title,
      });
    }
  }

  // Generate recommendations
  const recommendations: string[] = [];

  // From pattern analysis
  if (patternAnalysis.emerging.length > 0) {
    recommendations.push(`Capitalize on emerging pattern: ${patternAnalysis.emerging[0]}`);
  }
  if (patternAnalysis.declining.length > 0) {
    recommendations.push(`Investigate declining pattern: ${patternAnalysis.declining[0]}`);
  }

  // From synthesis recommendations
  recommendations.push(...synthesis.recommendations);

  // Next week focus
  const nextWeekFocus = generateNextWeekFocus(synthesis, goalConnections);

  return {
    weekOf: weekStart.toISOString().split("T")[0],
    summary: `Week of ${weekStart.toISOString().split("T")[0]}: ${synthesis.totalDataPoints} data points analyzed across ${synthesis.sources.join(", ")}`,
    patternAnalysis,
    goalConnections,
    recommendations: [...new Set(recommendations)].slice(0, 5),
    nextWeekFocus,
  };
}

export async function generateGoalInsights(goalId: string): Promise<TopicInsight | null> {
  const telosContext = await loadTelosContext();
  const goal = await getGoal(goalId, telosContext);

  if (!goal) return null;

  // Search for related learnings
  const learnings = await memoryStore.search({
    type: "learning",
    limit: 100,
  });

  // Filter to goal-relevant learnings
  const relatedLearnings: typeof learnings = [];
  for (const l of learnings) {
    const connections = await connectToGoals(l.content, telosContext);
    if (connections.some((c) => c.goalId === goalId)) {
      relatedLearnings.push(l);
    }
  }

  // Get patterns from synthesis
  const synthesis = await synthesize({
    period: "month",
    sources: ["ratings", "sessions"],
    dryRun: true,
  });

  // Find patterns related to this goal
  const goalPatterns: typeof synthesis.patterns = [];
  for (const p of synthesis.patterns) {
    const connections = await connectToGoals(p.name + " " + p.examples.join(" "), telosContext);
    if (connections.some((c) => c.goalId === goalId)) {
      goalPatterns.push(p);
    }
  }

  return {
    topic: goal.title,
    relevantGoals: [{ id: goal.id, title: goal.title, relevance: 1.0 }],
    relatedLearnings: relatedLearnings.slice(0, 10).map((l) => ({
      title: l.title,
      date: l.timestamp.split("T")[0],
      summary: l.content.slice(0, 150),
    })),
    patterns: goalPatterns.map((p) => `${p.name} (${p.count}x)`),
    recommendations: generateGoalRecommendations(goal, relatedLearnings.length, goalPatterns.length),
  };
}

export async function generateTopicInsights(topic: string): Promise<TopicInsight> {
  const telosContext = await loadTelosContext();
  const goalConnections = await connectToGoals(topic, telosContext);

  // Search for related learnings
  const learnings = await memoryStore.search({
    fullText: topic,
    limit: 20,
  });

  // Get patterns
  const synthesis = await synthesize({
    period: "month",
    sources: ["ratings", "sessions"],
    dryRun: true,
  });

  const topicPatterns = synthesis.patterns.filter((p) =>
    p.examples.some((e) => e.toLowerCase().includes(topic.toLowerCase()))
  );

  return {
    topic,
    relevantGoals: goalConnections.slice(0, 5).map((c) => ({
      id: c.goalId,
      title: c.goalTitle,
      relevance: c.relevanceScore,
    })),
    relatedLearnings: learnings.slice(0, 10).map((l) => ({
      title: l.title,
      date: l.timestamp.split("T")[0],
      summary: l.content.slice(0, 150),
    })),
    patterns: topicPatterns.map((p) => `${p.name} (${p.count}x)`),
    recommendations: [],
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function generateFocusRecommendation(
  date: Date,
  synthesis: SynthesisResult,
  wigs: Goal[]
): string {
  const dayOfWeek = date.getDay();

  // Monday: Reset and plan
  if (dayOfWeek === 1) {
    return "Start of week: Review WIGs and set weekly intentions";
  }

  // Friday: Reflect
  if (dayOfWeek === 5) {
    return "End of week: Consolidate learnings and celebrate wins";
  }

  // Based on patterns
  if (synthesis.patterns.some((p) => p.category === "frustration" && p.count >= 3)) {
    const topFrustration = synthesis.patterns.find((p) => p.category === "frustration");
    return `Address recurring challenge: ${topFrustration?.name}`;
  }

  // Default: Focus on top WIG
  if (wigs.length > 0) {
    return `Focus on WIG: ${wigs[0].title}`;
  }

  return "Continue current momentum";
}

function analyzePatternTrends(synthesis: SynthesisResult): {
  emerging: string[];
  declining: string[];
  stable: string[];
} {
  // For now, categorize based on count thresholds
  // In a full implementation, this would compare to historical data
  return {
    emerging: synthesis.patterns
      .filter((p) => p.category === "success" && p.count >= 3)
      .map((p) => p.name)
      .slice(0, 3),
    declining: synthesis.patterns
      .filter((p) => p.category === "frustration" && p.count === 1)
      .map((p) => p.name)
      .slice(0, 3),
    stable: synthesis.patterns
      .filter((p) => p.count >= 2 && p.count <= 5)
      .map((p) => p.name)
      .slice(0, 3),
  };
}

function generateNextWeekFocus(
  synthesis: SynthesisResult,
  goalConnections: WeeklyIntelligence["goalConnections"]
): string[] {
  const focus: string[] = [];

  // Goals with most activity should continue
  if (goalConnections.length > 0) {
    focus.push(`Continue momentum on ${goalConnections[0].goalTitle}`);
  }

  // Address any high-count frustrations
  const frustrations = synthesis.patterns.filter(
    (p) => p.category === "frustration" && p.count >= 3
  );
  if (frustrations.length > 0) {
    focus.push(`Resolve: ${frustrations[0].name}`);
  }

  // Build on successes
  const successes = synthesis.patterns.filter((p) => p.category === "success" && p.count >= 2);
  if (successes.length > 0) {
    focus.push(`Reinforce: ${successes[0].name}`);
  }

  return focus.slice(0, 3);
}

function generateGoalRecommendations(
  goal: Goal,
  learningCount: number,
  patternCount: number
): string[] {
  const recommendations: string[] = [];

  if (learningCount === 0) {
    recommendations.push(`No learnings connected to ${goal.id} yet - focus on this goal`);
  } else if (learningCount < 3) {
    recommendations.push(`Build more insights around ${goal.title}`);
  } else {
    recommendations.push(`Good coverage on ${goal.id} - consider synthesis`);
  }

  if (patternCount > 0) {
    recommendations.push(`${patternCount} patterns identified - review for optimization`);
  }

  return recommendations;
}

// ============================================================================
// Output Formatting
// ============================================================================

function formatDailyBriefing(briefing: DailyBriefing): string {
  return `# Daily Briefing - ${briefing.date}

${briefing.greeting}, User!

## Quick Stats

| Metric | Value |
|--------|-------|
| Sessions Yesterday | ${briefing.quickStats.sessionsYesterday} |
| Avg Rating | ${briefing.quickStats.avgRating.toFixed(1)}/10 |
| Top Pattern | ${briefing.quickStats.topPattern} |
| Active WIGs | ${briefing.quickStats.activeGoals} |

## Highlights

${briefing.highlights.map((h) => `- ${h}`).join("\n")}

## Action Items

${briefing.actionItems.map((a) => `- [ ] ${a}`).join("\n")}

## Focus Recommendation

**${briefing.focusRecommendation}**

## Goal Progress

${briefing.goalProgress.map((g) => `- **${g.goalId}**: ${g.goalTitle} - ${g.recentActivity}`).join("\n")}

---
*Generated by InsightGenerator | ContinualLearning Skill*
`;
}

function formatWeeklyIntelligence(intel: WeeklyIntelligence): string {
  return `# Weekly Intelligence Report - ${intel.weekOf}

## Summary

${intel.summary}

## Pattern Analysis

### Emerging Patterns
${intel.patternAnalysis.emerging.map((p) => `- ↑ ${p}`).join("\n") || "- None detected"}

### Declining Patterns
${intel.patternAnalysis.declining.map((p) => `- ↓ ${p}`).join("\n") || "- None detected"}

### Stable Patterns
${intel.patternAnalysis.stable.map((p) => `- → ${p}`).join("\n") || "- None detected"}

## Goal Connections

${intel.goalConnections.map((g) => `- **${g.goalId}**: ${g.goalTitle} (${g.insightCount} insights)`).join("\n") || "No goal connections this week"}

## Recommendations

${intel.recommendations.map((r, i) => `${i + 1}. ${r}`).join("\n")}

## Next Week Focus

${intel.nextWeekFocus.map((f) => `- ${f}`).join("\n")}

---
*Generated by InsightGenerator | ContinualLearning Skill*
`;
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      daily: { type: "boolean" },
      weekly: { type: "boolean" },
      goal: { type: "string" },
      topic: { type: "string" },
      json: { type: "boolean" },
      save: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`
InsightGenerator - Generate actionable intelligence and briefings

Usage:
  bun run InsightGenerator.ts --daily         Daily briefing
  bun run InsightGenerator.ts --weekly        Weekly intelligence
  bun run InsightGenerator.ts --goal G28      Goal-focused insights
  bun run InsightGenerator.ts --topic TOPIC   Topic-focused insights
  bun run InsightGenerator.ts --save          Save output to file
  bun run InsightGenerator.ts --json          Output as JSON

Examples:
  bun run InsightGenerator.ts --daily
  bun run InsightGenerator.ts --weekly --json
  bun run InsightGenerator.ts --goal G28 --save
`);
    process.exit(0);
  }

  if (values.daily) {
    const briefing = await generateDailyBriefing();

    if (values.json) {
      console.log(JSON.stringify(briefing, null, 2));
    } else {
      const formatted = formatDailyBriefing(briefing);
      console.log(formatted);

      if (values.save) {
        const outputPath = path.join(OUTPUT_DIR, `${briefing.date}-daily.md`);
        if (!existsSync(OUTPUT_DIR)) {
          mkdirSync(OUTPUT_DIR, { recursive: true });
        }
        await Bun.write(outputPath, formatted);
        console.log(`\n✅ Saved to: ${outputPath}`);

        // Capture to MemoryStore for cross-skill searchability
        await memoryStore.capture({
          type: "insight",
          category: "DAILY_BRIEFING",
          title: `Daily Briefing - ${briefing.date}`,
          content: JSON.stringify(briefing),
          tags: ["briefing", "daily", briefing.date, ...(briefing.highlights.slice(0, 3))],
          tier: "warm",
          source: "InsightGenerator",
        });
      }
    }
    return;
  }

  if (values.weekly) {
    const intel = await generateWeeklyIntelligence();

    if (values.json) {
      console.log(JSON.stringify(intel, null, 2));
    } else {
      const formatted = formatWeeklyIntelligence(intel);
      console.log(formatted);

      if (values.save) {
        const outputPath = path.join(OUTPUT_DIR, `${intel.weekOf}-weekly.md`);
        if (!existsSync(OUTPUT_DIR)) {
          mkdirSync(OUTPUT_DIR, { recursive: true });
        }
        await Bun.write(outputPath, formatted);
        console.log(`\n✅ Saved to: ${outputPath}`);

        // Capture to MemoryStore for cross-skill searchability
        await memoryStore.capture({
          type: "insight",
          category: "WEEKLY_INTELLIGENCE",
          title: `Weekly Intelligence - ${intel.weekOf}`,
          content: JSON.stringify(intel),
          tags: ["briefing", "weekly", intel.weekOf, ...intel.patternAnalysis.emerging.slice(0, 3)],
          tier: "warm",
          source: "InsightGenerator",
        });
      }
    }
    return;
  }

  if (values.goal) {
    const insights = await generateGoalInsights(values.goal);

    if (!insights) {
      console.error(`Goal not found: ${values.goal}`);
      process.exit(1);
    }

    if (values.json) {
      console.log(JSON.stringify(insights, null, 2));
    } else {
      console.log(`🎯 Insights for ${values.goal}: ${insights.topic}\n`);
      console.log(`Related Learnings: ${insights.relatedLearnings.length}`);
      console.log(`Patterns: ${insights.patterns.length}`);
      console.log(`\nRecommendations:`);
      for (const rec of insights.recommendations) {
        console.log(`  - ${rec}`);
      }
    }
    return;
  }

  if (values.topic) {
    const insights = await generateTopicInsights(values.topic);

    if (values.json) {
      console.log(JSON.stringify(insights, null, 2));
    } else {
      console.log(`🔍 Insights for: "${values.topic}"\n`);
      console.log(`Relevant Goals: ${insights.relevantGoals.map((g) => g.id).join(", ") || "none"}`);
      console.log(`Related Learnings: ${insights.relatedLearnings.length}`);
      console.log(`Patterns: ${insights.patterns.length}`);
    }
    return;
  }

  // Default: show usage
  console.log(`💡 InsightGenerator`);
  console.log(`   Use --daily for daily briefing`);
  console.log(`   Use --weekly for weekly intelligence`);
  console.log(`   Use --goal <ID> for goal-focused insights`);
  console.log(`\nRun --help for full usage.`);
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}

// Exports
export { formatDailyBriefing, formatWeeklyIntelligence };
