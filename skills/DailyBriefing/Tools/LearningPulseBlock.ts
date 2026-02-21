#!/usr/bin/env bun
/**
 * LearningPulseBlock.ts - Learning patterns section for DailyBriefing
 *
 * Reads the latest ContinualLearning synthesis data and formats it as a
 * briefing section showing pattern trends, recommendations, and a
 * "pattern of the week" highlight.
 *
 * This block is optional -- if no synthesis data exists, it returns
 * a graceful empty result that doesn't break the briefing.
 */

import { join } from "path";
import type { BlockResult } from "./types.ts";

const KAYA_HOME = process.env.KAYA_DIR || join(process.env.HOME!, ".claude");
const LEARNING_PROVIDER_PATH = join(
  KAYA_HOME,
  "skills",
  "ContinualLearning",
  "Tools",
  "LearningContextProvider.ts"
);

export interface LearningPulseConfig {
  maxPatterns?: number;
  maxRecommendations?: number;
}

export async function execute(config: LearningPulseConfig = {}): Promise<BlockResult> {
  const { maxPatterns = 5, maxRecommendations = 3 } = config;

  try {
    // Dynamically import LearningContextProvider
    const { generateLearningContext } = await import(LEARNING_PROVIDER_PATH);
    const context = generateLearningContext();

    if (!context.markdown || context.patterns.length === 0) {
      return {
        blockName: "learningPulse",
        success: true,
        data: { empty: true },
        markdown: "",
        summary: "No learning data available",
      };
    }

    // Find "pattern of the week" -- the pattern with the most significant trend change
    const patternOfTheWeek = context.patterns.find(
      (p: { trend: string; count: number }) => p.trend === "increasing" && p.count >= 3
    ) || context.patterns[0];

    // Build markdown section
    let markdown = "## Learning Pulse\n\n";

    // Pattern of the week highlight
    if (patternOfTheWeek) {
      const trendIcon =
        patternOfTheWeek.trend === "increasing" ? "up" :
        patternOfTheWeek.trend === "decreasing" ? "down" : "stable";
      markdown += `**Pattern of the Week:** ${patternOfTheWeek.name} (${patternOfTheWeek.count}x, ${trendIcon})\n\n`;
    }

    // Staleness warning
    if (context.isStale) {
      markdown += `*Warning: Synthesis data is ${context.staleDays} days old.*\n\n`;
    }

    // Pattern trends table
    const patternsToShow = context.patterns.slice(0, maxPatterns);
    if (patternsToShow.length > 0) {
      markdown += "| Pattern | Count | Trend |\n";
      markdown += "|---------|-------|-------|\n";
      for (const p of patternsToShow) {
        const trendArrow =
          p.trend === "increasing" ? "^ increasing" :
          p.trend === "decreasing" ? "v decreasing" : "-> stable";
        markdown += `| ${p.name} | ${p.count}x | ${trendArrow} |\n`;
      }
      markdown += "\n";
    }

    // Recommendations
    const recsToShow = context.recommendations.slice(0, maxRecommendations);
    if (recsToShow.length > 0) {
      markdown += "**Recommendations:**\n";
      for (const rec of recsToShow) {
        markdown += `- ${rec}\n`;
      }
      markdown += "\n";
    }

    markdown += `_Last synthesis: ${context.date}_\n\n`;

    // Voice summary
    const voiceParts: string[] = [];
    if (patternOfTheWeek) {
      voiceParts.push(
        `Top learning pattern: ${patternOfTheWeek.name} at ${patternOfTheWeek.count} occurrences, trending ${patternOfTheWeek.trend}`
      );
    }

    return {
      blockName: "learningPulse",
      success: true,
      data: {
        patterns: patternsToShow,
        recommendations: recsToShow,
        patternOfTheWeek,
        staleDays: context.staleDays,
        isStale: context.isStale,
        lastSynthesisDate: context.date,
      },
      markdown,
      summary: voiceParts.join(". ") || "Learning patterns reviewed",
    };
  } catch (error) {
    // Graceful failure -- briefing continues without learning section
    return {
      blockName: "learningPulse",
      success: false,
      data: {},
      markdown: "",
      summary: "Learning pulse unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
