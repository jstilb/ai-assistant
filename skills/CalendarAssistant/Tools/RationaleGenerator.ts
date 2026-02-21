#!/usr/bin/env bun
/**
 * RationaleGenerator.ts - Template-Based Decision Explanations
 *
 * Phase 4: Enhanced with per-dimension scoring, expanded prohibited
 * phrase filter (including "I think" and "probably"), and structured
 * recommendation generation with human-readable explanations.
 *
 * Every scheduling action gets a human-readable rationale that:
 * - References at least one of: goal alignment, optimization rule,
 *   conflict resolution, or user preference
 * - Never uses prohibited phrases
 * - Includes per-dimension scoring breakdown when relevant
 *
 * @module RationaleGenerator
 */

import type {
  Rationale,
  RationaleDimension,
  GoalAlignment,
  SlotScore,
  Conflict,
  ParsedIntent,
  IntentType,
  BreakAnalysis,
} from "./types";
import { IntentType as IT } from "./types";

// ============================================
// PROHIBITED PHRASES
// ============================================

export const PROHIBITED_PHRASES = [
  "i think",
  "probably",
  "seems good",
  "this works",
  "should be fine",
  "looks okay",
  "no issues",
  "it's fine",
  "probably fine",
  "should work",
  "looks good",
  "might work",
  "maybe",
  "not sure",
  "i guess",
  "hopefully",
];

/**
 * Validate that a rationale does not contain prohibited phrases.
 *
 * @param text - Text to check
 * @returns Whether the text passes validation
 */
export function validateRationale(text: string): boolean {
  const lower = text.toLowerCase();
  return !PROHIBITED_PHRASES.some((phrase) => lower.includes(phrase));
}

// ============================================
// PER-DIMENSION SCORING
// ============================================

type DimensionKey =
  | "goalAlignment"
  | "timeOfDayPreference"
  | "calendarDensity"
  | "breakCoverageImpact";

const DIMENSION_NAMES: Record<DimensionKey, string> = {
  goalAlignment: "Goal Alignment",
  timeOfDayPreference: "Time-of-Day Preference",
  calendarDensity: "Calendar Density",
  breakCoverageImpact: "Break Coverage",
};

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

/**
 * Score a single dimension and generate an explanation.
 */
export function scoreDimension(
  dimension: DimensionKey,
  rawValue: number
): RationaleDimension {
  const score = clampScore(rawValue);
  const name = DIMENSION_NAMES[dimension];

  let explanation: string;
  switch (dimension) {
    case "goalAlignment":
      explanation =
        score >= 80
          ? `Strong goal alignment at ${score}% - this activity directly supports your objectives`
          : score >= 50
            ? `Moderate goal alignment at ${score}% - partially supports your objectives`
            : `Low goal alignment at ${score}% - consider whether this advances your goals`;
      break;

    case "timeOfDayPreference":
      explanation =
        score >= 80
          ? `Optimal time slot preference at ${score}% - matches your energy patterns`
          : score >= 50
            ? `Acceptable time preference at ${score}% - workable but not ideal`
            : `Suboptimal time preference at ${score}% - does not match your preferred schedule`;
      break;

    case "calendarDensity":
      explanation =
        score >= 70
          ? `Calendar has room at ${score}% density factor - day is manageable`
          : score >= 40
            ? `Calendar is moderately full at ${score}% density factor`
            : `Calendar is heavily dense at ${score}% density factor - day is very full`;
      break;

    case "breakCoverageImpact":
      explanation =
        score >= 80
          ? `Healthy break coverage at ${score}% - maintains productive rhythm`
          : score >= 50
            ? `Adequate break coverage at ${score}% - some break impact`
            : `Low break coverage at ${score}% - scheduling this may impact your break schedule`;
      break;
  }

  return { name, score, explanation };
}

// ============================================
// RATIONALE GENERATION
// ============================================

/**
 * Generate a rationale for a create/schedule action.
 */
export function generateCreateRationale(params: {
  intent: ParsedIntent;
  slotScore?: SlotScore;
  goalAlignments?: GoalAlignment[];
  conflicts?: Conflict[];
  breakAnalysis?: BreakAnalysis;
  preferenceNotes?: string[];
}): Rationale {
  const dimensions: RationaleDimension[] = [];
  const summaryParts: string[] = [];

  // Goal alignment dimension
  if (params.goalAlignments && params.goalAlignments.length > 0) {
    const topGoal = params.goalAlignments.reduce((a, b) =>
      a.score > b.score ? a : b
    );
    dimensions.push({
      name: "Goal Alignment",
      score: topGoal.score,
      explanation: `Aligned with goal "${topGoal.goalTitle}" (${topGoal.score}% match via keywords: ${topGoal.matchedKeywords.join(", ")})`,
    });
    summaryParts.push(
      `aligned with your goal "${topGoal.goalTitle}" (${topGoal.score}% alignment)`
    );
  }

  // Slot score dimensions
  if (params.slotScore) {
    dimensions.push(
      scoreDimension("timeOfDayPreference", params.slotScore.timeOfDayPreference)
    );
    dimensions.push(
      scoreDimension("calendarDensity", params.slotScore.calendarDensity)
    );
    dimensions.push(
      scoreDimension("breakCoverageImpact", params.slotScore.breakCoverageImpact)
    );
  }

  // Conflict information
  if (params.conflicts && params.conflicts.length > 0) {
    summaryParts.push(
      `${params.conflicts.length} conflict(s) detected and addressed`
    );
  }

  // Preference notes
  if (params.preferenceNotes && params.preferenceNotes.length > 0) {
    summaryParts.push(params.preferenceNotes.join("; "));
  }

  // Break analysis
  if (params.breakAnalysis) {
    if (params.breakAnalysis.coverage < 60) {
      summaryParts.push(
        `break coverage at ${params.breakAnalysis.coverage}% - consider adding breaks`
      );
    }
  }

  const title = params.intent.entities.title || "event";
  let summary = `Scheduled "${title}"`;
  if (summaryParts.length > 0) {
    summary += ` - ${summaryParts.join(". ")}`;
  } else {
    summary += " based on available calendar time and scheduling preferences";
  }

  // Validate and fix if needed
  if (!validateRationale(summary)) {
    summary = `Scheduled "${title}" per scheduling analysis and preference evaluation`;
  }

  return {
    summary,
    dimensions,
    recommendation: generateRecommendation(params),
  };
}

/**
 * Generate a rationale for a modify/move action.
 */
export function generateModifyRationale(params: {
  intent: ParsedIntent;
  originalEvent: { title: string; start: string; end: string };
  goalAlignments?: GoalAlignment[];
  preferenceNotes?: string[];
}): Rationale {
  const dimensions: RationaleDimension[] = [];
  const summaryParts: string[] = [];

  if (params.goalAlignments && params.goalAlignments.length > 0) {
    const topGoal = params.goalAlignments.reduce((a, b) =>
      a.score > b.score ? a : b
    );
    dimensions.push({
      name: "Goal Alignment",
      score: topGoal.score,
      explanation: `Maintains alignment with goal "${topGoal.goalTitle}" (${topGoal.score}%)`,
    });
    summaryParts.push(`maintains goal alignment with "${topGoal.goalTitle}"`);
  }

  if (params.preferenceNotes && params.preferenceNotes.length > 0) {
    summaryParts.push(params.preferenceNotes.join("; "));
  }

  const action =
    params.intent.type === IT.Move ? "Rescheduled" : "Modified";
  let summary = `${action} "${params.originalEvent.title}"`;
  if (summaryParts.length > 0) {
    summary += ` - ${summaryParts.join(". ")}`;
  } else {
    summary += " per user request with preference-aware scheduling";
  }

  if (!validateRationale(summary)) {
    summary = `${action} "${params.originalEvent.title}" per explicit user request and scheduling analysis`;
  }

  return { summary, dimensions };
}

/**
 * Generate a rationale for a delete action.
 */
export function generateDeleteRationale(params: {
  eventTitle: string;
  isRecurring: boolean;
  confirmed: boolean;
}): Rationale {
  let summary = `Deleted "${params.eventTitle}" after explicit user confirmation`;
  if (params.isRecurring) {
    summary +=
      " (recurring event - this instance only unless specified otherwise)";
  }

  return {
    summary,
    dimensions: [
      {
        name: "Safety Verification",
        score: 100,
        explanation: "User explicitly confirmed deletion",
      },
    ],
  };
}

/**
 * Generate a rationale for a query action.
 */
export function generateQueryRationale(params: {
  queryType: string;
  resultCount: number;
}): Rationale {
  return {
    summary: `Retrieved ${params.resultCount} event(s) for ${params.queryType} query`,
    dimensions: [],
  };
}

/**
 * Generate optimization rationale.
 */
export function generateOptimizationRationale(params: {
  suggestionCount: number;
  goalAlignmentScore: number;
  breakCoverage: number;
  conflictCount: number;
}): Rationale {
  const dimensions: RationaleDimension[] = [
    {
      name: "Goal Alignment",
      score: params.goalAlignmentScore,
      explanation: `Current schedule alignment: ${params.goalAlignmentScore}%`,
    },
    {
      name: "Break Coverage",
      score: params.breakCoverage,
      explanation: `Break coverage: ${params.breakCoverage}% (${params.breakCoverage >= 85 ? "healthy" : params.breakCoverage >= 60 ? "adequate" : "needs improvement"})`,
    },
  ];

  let summary = `Schedule analysis complete: ${params.suggestionCount} optimization suggestion(s)`;
  if (params.conflictCount > 0) {
    summary += `, ${params.conflictCount} conflict(s) found`;
  }
  summary += `. Goal alignment at ${params.goalAlignmentScore}%, break coverage at ${params.breakCoverage}%`;

  return { summary, dimensions };
}

// ============================================
// HELPERS
// ============================================

function generateRecommendation(params: {
  slotScore?: SlotScore;
  breakAnalysis?: BreakAnalysis;
  conflicts?: Conflict[];
}): string | undefined {
  const recommendations: string[] = [];

  if (params.breakAnalysis && params.breakAnalysis.coverage < 60) {
    recommendations.push(
      "Consider inserting breaks to maintain productive energy levels"
    );
  }

  if (params.conflicts && params.conflicts.length > 0) {
    recommendations.push(
      "Review detected scheduling conflicts for resolution"
    );
  }

  if (params.slotScore && params.slotScore.calendarDensity < 0.3) {
    recommendations.push(
      "Day is heavily scheduled - consider deferring non-critical items"
    );
  }

  return recommendations.length > 0 ? recommendations.join(". ") : undefined;
}

// CLI interface
if (import.meta.main) {
  console.log(`RationaleGenerator - Decision Explanation Engine

Every scheduling action receives a human-readable rationale that:
  - References goal alignment, optimization rules, or user preferences
  - Never uses prohibited phrases (${PROHIBITED_PHRASES.length} blocked)
  - Includes per-dimension scoring breakdown

Prohibited phrases: ${PROHIBITED_PHRASES.join(", ")}

Usage: Import and call generate*Rationale() functions.
`);
}
