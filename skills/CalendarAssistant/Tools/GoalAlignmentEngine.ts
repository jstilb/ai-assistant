#!/usr/bin/env bun
/**
 * GoalAlignmentEngine.ts - Score Events Against Goals
 *
 * Matches event titles/descriptions against goal keywords to produce
 * alignment scores (0-100). Computes daily/weekly alignment scores
 * and tags events with matched goals.
 *
 * @module GoalAlignmentEngine
 */

import type {
  CalendarEvent,
  Goal,
  GoalAlignment,
  EventAlignment,
  Result,
  CalendarError,
} from "./types";
import { getActiveGoals } from "./GoalStore";

// ============================================
// SCORING
// ============================================

/**
 * Score an event against a single goal.
 * Uses keyword matching with weighted scoring.
 *
 * @param event - Calendar event to score
 * @param goal - Goal to match against
 * @returns Alignment score (0-100) and matched keywords
 */
function scoreEventGoal(event: CalendarEvent, goal: Goal): GoalAlignment {
  const eventText = `${event.title} ${event.description || ""}`.toLowerCase();
  const goalText = goal.title.toLowerCase();

  // Direct keyword matching
  const matchedKeywords: string[] = [];
  for (const keyword of goal.keywords) {
    if (eventText.includes(keyword)) {
      matchedKeywords.push(keyword);
    }
  }

  // Also check if goal title words appear in event
  const goalWords = goalText.split(/\s+/).filter((w) => w.length > 2);
  for (const word of goalWords) {
    if (eventText.includes(word) && !matchedKeywords.includes(word)) {
      matchedKeywords.push(word);
    }
  }

  // Calculate score based on match density
  let score = 0;
  if (matchedKeywords.length > 0) {
    const totalKeywords = new Set([...goal.keywords, ...goalWords]).size;
    const matchRatio = matchedKeywords.length / Math.max(totalKeywords, 1);
    score = Math.min(100, Math.round(matchRatio * 100 + matchedKeywords.length * 15));
  }

  return {
    goalId: goal.id,
    goalTitle: goal.title,
    score,
    matchedKeywords,
  };
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Score a single event against all active goals.
 *
 * @param event - Calendar event to analyze
 * @returns Event alignment with all goal scores
 */
export async function scoreEvent(
  event: CalendarEvent
): Promise<Result<EventAlignment, CalendarError>> {
  const goalsResult = await getActiveGoals();
  if (!goalsResult.success) return goalsResult;

  const goals = goalsResult.data;
  const alignments = goals
    .map((goal) => scoreEventGoal(event, goal))
    .filter((a) => a.score > 0)
    .sort((a, b) => b.score - a.score);

  const overallScore =
    alignments.length > 0
      ? Math.round(
          alignments.reduce((sum, a) => sum + a.score, 0) / alignments.length
        )
      : 0;

  return {
    success: true,
    data: {
      event,
      alignments,
      overallScore,
    },
  };
}

/**
 * Score multiple events and compute aggregate alignment.
 *
 * @param events - Array of calendar events
 * @returns Array of event alignments with aggregate score
 */
export async function scoreEvents(
  events: CalendarEvent[]
): Promise<
  Result<
    { alignments: EventAlignment[]; aggregateScore: number },
    CalendarError
  >
> {
  const goalsResult = await getActiveGoals();
  if (!goalsResult.success) return goalsResult;

  const goals = goalsResult.data;
  const alignments: EventAlignment[] = [];

  for (const event of events) {
    const eventAlignments = goals
      .map((goal) => scoreEventGoal(event, goal))
      .filter((a) => a.score > 0)
      .sort((a, b) => b.score - a.score);

    const overallScore =
      eventAlignments.length > 0
        ? Math.round(
            eventAlignments.reduce((sum, a) => sum + a.score, 0) /
              eventAlignments.length
          )
        : 0;

    alignments.push({ event, alignments: eventAlignments, overallScore });
  }

  const scoredEvents = alignments.filter((a) => a.overallScore > 0);
  const aggregateScore =
    events.length > 0
      ? Math.round(
          alignments.reduce((sum, a) => sum + a.overallScore, 0) /
            events.length
        )
      : 0;

  return {
    success: true,
    data: { alignments, aggregateScore },
  };
}

/**
 * Check if a proposed event title aligns with any goals.
 * Used during scheduling to provide alignment info.
 *
 * @param title - Proposed event title
 * @param description - Optional event description
 * @returns Goal alignments for the proposed event
 */
export async function checkAlignment(
  title: string,
  description?: string
): Promise<Result<GoalAlignment[], CalendarError>> {
  const goalsResult = await getActiveGoals();
  if (!goalsResult.success) return goalsResult;

  const fakeEvent: CalendarEvent = {
    id: "proposed",
    title,
    start: "",
    end: "",
    description,
    isAllDay: false,
    isRecurring: false,
  };

  const alignments = goalsResult.data
    .map((goal) => scoreEventGoal(fakeEvent, goal))
    .filter((a) => a.score > 0)
    .sort((a, b) => b.score - a.score);

  return { success: true, data: alignments };
}

/**
 * Generate a goal alignment report for a set of events.
 *
 * @param events - Events to analyze
 * @returns Formatted alignment report
 */
export async function generateAlignmentReport(
  events: CalendarEvent[]
): Promise<Result<string, CalendarError>> {
  const result = await scoreEvents(events);
  if (!result.success) return result;

  const { alignments, aggregateScore } = result.data;
  const lines: string[] = [];

  lines.push(`Goal Alignment Report`);
  lines.push(`=====================`);
  lines.push(`Overall Alignment: ${aggregateScore}%`);
  lines.push(`Events Analyzed: ${events.length}`);
  lines.push(
    `Aligned Events: ${alignments.filter((a) => a.overallScore > 0).length}`
  );
  lines.push(
    `Unaligned Events: ${alignments.filter((a) => a.overallScore === 0).length}`
  );
  lines.push(``);

  // Top aligned events
  const sorted = [...alignments].sort(
    (a, b) => b.overallScore - a.overallScore
  );
  lines.push(`Top Aligned Events:`);
  for (const ea of sorted.slice(0, 5)) {
    if (ea.overallScore > 0) {
      const goals = ea.alignments.map((a) => a.goalTitle).join(", ");
      lines.push(
        `  - "${ea.event.title}" (${ea.overallScore}%) -> ${goals}`
      );
    }
  }

  // Unaligned events
  const unaligned = sorted.filter((a) => a.overallScore === 0);
  if (unaligned.length > 0) {
    lines.push(``);
    lines.push(`Unaligned Events (consider reviewing):`);
    for (const ea of unaligned.slice(0, 5)) {
      lines.push(`  - "${ea.event.title}"`);
    }
  }

  return { success: true, data: lines.join("\n") };
}

// CLI interface
if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "check") {
    const title = args[1];
    if (!title) {
      console.error("Usage: GoalAlignmentEngine.ts check <event-title>");
      process.exit(1);
    }
    const result = await checkAlignment(title);
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`GoalAlignmentEngine - Event-Goal Alignment Scoring

Usage:
  bun run GoalAlignmentEngine.ts check "Event Title"

Score events against active goals using keyword matching.
`);
  }
}
