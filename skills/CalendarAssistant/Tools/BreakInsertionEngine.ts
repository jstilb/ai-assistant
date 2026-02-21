#!/usr/bin/env bun
/**
 * BreakInsertionEngine.ts - Research-Backed Break Scheduling
 *
 * Analyzes schedule for consecutive work blocks without breaks and
 * inserts break events per selected framework:
 * - Pomodoro: 25 min work / 5 min break (15 min every 4 cycles)
 * - 52/17: 52 min work / 17 min break
 * - Custom: user-defined intervals
 *
 * Tracks which breaks user manually removes (don't re-insert those).
 * Warns if break coverage drops below 60%.
 *
 * @module BreakInsertionEngine
 */

import type {
  CalendarEvent,
  BreakConfig,
  BreakSuggestion,
  BreakAnalysis,
  BreakFramework,
  Result,
  CalendarError,
} from "./types";
import { BreakFramework as BF } from "./types";

// ============================================
// FRAMEWORK CONFIGS
// ============================================

const FRAMEWORK_CONFIGS: Record<BreakFramework, BreakConfig> = {
  [BF.Pomodoro]: {
    framework: BF.Pomodoro,
    workMinutes: 25,
    breakMinutes: 5,
    longBreakMinutes: 15,
    longBreakInterval: 4,
  },
  [BF.FiftyTwoSeventeen]: {
    framework: BF.FiftyTwoSeventeen,
    workMinutes: 52,
    breakMinutes: 17,
  },
  [BF.Custom]: {
    framework: BF.Custom,
    workMinutes: 50,
    breakMinutes: 10,
  },
};

/**
 * Get the configuration for a break framework.
 */
export function getFrameworkConfig(
  framework: BreakFramework,
  customConfig?: Partial<BreakConfig>
): BreakConfig {
  const base = FRAMEWORK_CONFIGS[framework];
  if (framework === BF.Custom && customConfig) {
    return { ...base, ...customConfig };
  }
  return base;
}

// ============================================
// BREAK ANALYSIS
// ============================================

/**
 * Analyze a schedule and suggest breaks per the selected framework.
 *
 * @param events - Current calendar events (sorted by start time)
 * @param config - Break framework configuration
 * @param removedBreaks - Break IDs that user previously removed (don't re-suggest)
 * @returns Break analysis with suggestions
 */
export function analyzeBreaks(
  events: CalendarEvent[],
  config: BreakConfig,
  removedBreaks: string[] = []
): BreakAnalysis {
  if (events.length === 0) {
    return {
      coverage: 100,
      suggestions: [],
      removedBreaks,
    };
  }

  // Sort events by start time
  const sorted = [...events].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );

  const suggestions: BreakSuggestion[] = [];
  let totalWorkMinutes = 0;
  let totalBreakMinutes = 0;
  let consecutiveWorkMinutes = 0;
  let cycleCount = 0;

  for (let i = 0; i < sorted.length; i++) {
    const event = sorted[i];
    const start = new Date(event.start);
    const end = new Date(event.end || event.start);
    const durationMinutes = Math.max(
      0,
      (end.getTime() - start.getTime()) / (1000 * 60)
    );

    // Check if this event IS a break
    const isBreak =
      event.title.toLowerCase().includes("break") ||
      event.title.toLowerCase().includes("rest") ||
      event.title.toLowerCase().includes("lunch");

    if (isBreak) {
      totalBreakMinutes += durationMinutes;
      consecutiveWorkMinutes = 0;
      continue;
    }

    totalWorkMinutes += durationMinutes;
    consecutiveWorkMinutes += durationMinutes;
    cycleCount++;

    // Check if we need a break after this event
    const needsBreak = consecutiveWorkMinutes >= config.workMinutes;

    if (needsBreak && i < sorted.length - 1) {
      const nextEvent = sorted[i + 1];
      const gapStart = end;
      const gapEnd = new Date(nextEvent.start);
      const gapMinutes =
        (gapEnd.getTime() - gapStart.getTime()) / (1000 * 60);

      // Determine break type
      const isLongBreak =
        config.longBreakInterval &&
        config.longBreakMinutes &&
        cycleCount % config.longBreakInterval === 0;

      const neededBreakMinutes = isLongBreak
        ? config.longBreakMinutes!
        : config.breakMinutes;

      if (gapMinutes >= neededBreakMinutes) {
        // There's room for a break in the gap
        const breakId = `break_${gapStart.toISOString()}`;

        // Skip if user previously removed this break
        if (!removedBreaks.includes(breakId)) {
          suggestions.push({
            start: gapStart.toISOString(),
            end: new Date(
              gapStart.getTime() + neededBreakMinutes * 60 * 1000
            ).toISOString(),
            type: isLongBreak ? "long" : "short",
            reason: isLongBreak
              ? `Long break after ${cycleCount} work cycles (${config.framework} framework)`
              : `${config.breakMinutes}-minute break after ${Math.round(consecutiveWorkMinutes)} minutes of work (${config.framework} framework)`,
          });
          totalBreakMinutes += neededBreakMinutes;
        }
        consecutiveWorkMinutes = 0;
      } else if (gapMinutes > 0 && gapMinutes < neededBreakMinutes) {
        // Gap exists but too short for a proper break
        const breakId = `break_${gapStart.toISOString()}`;
        if (!removedBreaks.includes(breakId)) {
          suggestions.push({
            start: gapStart.toISOString(),
            end: gapEnd.toISOString(),
            type: "short",
            reason: `${Math.round(gapMinutes)}-minute micro-break in available gap (${neededBreakMinutes} min recommended)`,
          });
          totalBreakMinutes += gapMinutes;
        }
        consecutiveWorkMinutes = 0;
      }
      // No gap = no break possible
    }
  }

  // Calculate coverage
  const totalScheduledMinutes = totalWorkMinutes + totalBreakMinutes;
  const coverage =
    totalScheduledMinutes > 0
      ? Math.round((totalBreakMinutes / totalScheduledMinutes) * 100)
      : 100;

  // Generate warning if coverage is low
  let warning: string | undefined;
  if (coverage < 60) {
    warning = `Break coverage is ${coverage}% (below 60% threshold). Consider adding more breaks or reducing consecutive work blocks.`;
  }

  return {
    coverage,
    suggestions,
    removedBreaks,
    warning,
  };
}

/**
 * Get break suggestions for a specific time range.
 *
 * @param events - Events in the time range
 * @param framework - Break framework to use
 * @param removedBreaks - Previously removed break IDs
 * @returns Array of break suggestions
 */
export function suggestBreaks(
  events: CalendarEvent[],
  framework: BreakFramework = BF.FiftyTwoSeventeen,
  removedBreaks: string[] = []
): BreakSuggestion[] {
  const config = getFrameworkConfig(framework);
  const analysis = analyzeBreaks(events, config, removedBreaks);
  return analysis.suggestions;
}

// CLI interface
if (import.meta.main) {
  console.log(`BreakInsertionEngine - Research-Backed Break Scheduling

Frameworks:
  pomodoro:  25 min work / 5 min break (15 min every 4 cycles)
  52-17:     52 min work / 17 min break
  custom:    User-defined intervals

Usage: Import and call analyzeBreaks() or suggestBreaks().
`);
}
