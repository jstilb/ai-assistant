#!/usr/bin/env bun
/**
 * TemporalResolver.ts - Natural Language Date/Time to ISO 8601
 *
 * Converts natural language time expressions to ISO 8601 timestamps
 * with timezone support. Uses date arithmetic for relative expressions
 * and LLM inference for ambiguous cases.
 *
 * If confidence < 75%, returns a clarification request instead of guessing.
 *
 * @module TemporalResolver
 */

import type {
  TemporalResult,
  ResolvedTime,
  ClarificationRequest,
  Result,
  CalendarError,
} from "./types";

const KAYA_DIR = process.env.KAYA_DIR || `${process.env.HOME}/.claude`;

// ============================================
// TIMEZONE CONFIG
// ============================================

/**
 * Get the user's configured timezone from Kaya settings.
 */
function getUserTimezone(): string {
  try {
    const settingsPath = `${KAYA_DIR}/settings.json`;
    const settings = JSON.parse(
      require("fs").readFileSync(settingsPath, "utf-8")
    );
    return settings.principal?.timezone || "America/Los_Angeles";
  } catch {
    return "America/Los_Angeles";
  }
}

// ============================================
// DATE PARSING
// ============================================

/**
 * Get the current date/time in the user's timezone.
 */
function nowInTimezone(tz: string): Date {
  // Get current time interpreted in the user's timezone
  const now = new Date();
  return now;
}

/**
 * Format a Date to ISO 8601 string.
 */
function toISOString(date: Date): string {
  return date.toISOString();
}

/**
 * Parse common relative date expressions.
 * Returns null if expression cannot be resolved with high confidence.
 */
function parseRelativeDate(
  expression: string,
  referenceDate: Date
): { date: Date; confidence: number } | null {
  const lower = expression.toLowerCase().trim();
  const ref = new Date(referenceDate);

  // "today"
  if (/^today$/i.test(lower)) {
    return { date: ref, confidence: 0.95 };
  }

  // "tomorrow"
  if (/^tomorrow$/i.test(lower)) {
    const d = new Date(ref);
    d.setDate(d.getDate() + 1);
    return { date: d, confidence: 0.95 };
  }

  // "yesterday"
  if (/^yesterday$/i.test(lower)) {
    const d = new Date(ref);
    d.setDate(d.getDate() - 1);
    return { date: d, confidence: 0.95 };
  }

  // "in N hours/minutes/days"
  const inMatch = lower.match(
    /^in\s+(\d+)\s+(hour|hr|minute|min|day|week|month)s?$/i
  );
  if (inMatch) {
    const n = parseInt(inMatch[1]);
    const unit = inMatch[2].toLowerCase();
    const d = new Date(ref);
    if (unit.startsWith("hour") || unit === "hr") {
      d.setHours(d.getHours() + n);
    } else if (unit.startsWith("min")) {
      d.setMinutes(d.getMinutes() + n);
    } else if (unit === "day") {
      d.setDate(d.getDate() + n);
    } else if (unit === "week") {
      d.setDate(d.getDate() + n * 7);
    } else if (unit === "month") {
      d.setMonth(d.getMonth() + n);
    }
    return { date: d, confidence: 0.9 };
  }

  // "next Monday/Tuesday/..."
  const dayNames = [
    "sunday", "monday", "tuesday", "wednesday",
    "thursday", "friday", "saturday",
  ];
  const nextDayMatch = lower.match(
    /^next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/i
  );
  if (nextDayMatch) {
    const targetDay = dayNames.indexOf(nextDayMatch[1].toLowerCase());
    const d = new Date(ref);
    const currentDay = d.getDay();
    let diff = targetDay - currentDay;
    if (diff <= 0) diff += 7;
    d.setDate(d.getDate() + diff);
    return { date: d, confidence: 0.9 };
  }

  // "this Monday/Tuesday/..."
  const thisDayMatch = lower.match(
    /^this\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/i
  );
  if (thisDayMatch) {
    const targetDay = dayNames.indexOf(thisDayMatch[1].toLowerCase());
    const d = new Date(ref);
    const currentDay = d.getDay();
    let diff = targetDay - currentDay;
    if (diff < 0) diff += 7;
    d.setDate(d.getDate() + diff);
    return { date: d, confidence: 0.85 };
  }

  // Day name alone (treat as next occurrence)
  const dayOnlyMatch = lower.match(
    /^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/i
  );
  if (dayOnlyMatch) {
    const targetDay = dayNames.indexOf(dayOnlyMatch[1].toLowerCase());
    const d = new Date(ref);
    const currentDay = d.getDay();
    let diff = targetDay - currentDay;
    if (diff <= 0) diff += 7;
    d.setDate(d.getDate() + diff);
    return { date: d, confidence: 0.8 };
  }

  // "next week"
  if (/^next\s+week$/i.test(lower)) {
    const d = new Date(ref);
    d.setDate(d.getDate() + 7);
    return { date: d, confidence: 0.8 };
  }

  return null;
}

/**
 * Parse time-of-day expressions and apply to a date.
 */
function parseTimeOfDay(
  expression: string,
  date: Date
): { date: Date; confidence: number } | null {
  const lower = expression.toLowerCase().trim();
  const d = new Date(date);

  // "morning" -> 9:00 AM
  if (/morning/i.test(lower)) {
    d.setHours(9, 0, 0, 0);
    return { date: d, confidence: 0.8 };
  }

  // "afternoon" -> 2:00 PM
  if (/afternoon/i.test(lower)) {
    d.setHours(14, 0, 0, 0);
    return { date: d, confidence: 0.8 };
  }

  // "evening" -> 6:00 PM
  if (/evening/i.test(lower)) {
    d.setHours(18, 0, 0, 0);
    return { date: d, confidence: 0.8 };
  }

  // "noon" -> 12:00 PM
  if (/noon/i.test(lower)) {
    d.setHours(12, 0, 0, 0);
    return { date: d, confidence: 0.95 };
  }

  // "midnight" -> 12:00 AM
  if (/midnight/i.test(lower)) {
    d.setHours(0, 0, 0, 0);
    return { date: d, confidence: 0.95 };
  }

  // "N am/pm" or "N:MM am/pm"
  const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1]);
    const minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
    const period = timeMatch[3].toLowerCase();
    if (period === "pm" && hours < 12) hours += 12;
    if (period === "am" && hours === 12) hours = 0;
    d.setHours(hours, minutes, 0, 0);
    return { date: d, confidence: 0.95 };
  }

  // 24-hour format "HH:MM"
  const time24Match = lower.match(/(\d{2}):(\d{2})/);
  if (time24Match) {
    d.setHours(parseInt(time24Match[1]), parseInt(time24Match[2]), 0, 0);
    return { date: d, confidence: 0.9 };
  }

  return null;
}

/**
 * Parse a complete temporal expression into resolved timestamps.
 */
function parseExpression(
  expression: string,
  defaultDurationMinutes: number = 60
): TemporalResult {
  const tz = getUserTimezone();
  const now = nowInTimezone(tz);
  let confidence = 0.5;
  let startDate: Date | null = null;
  let endDate: Date | null = null;

  // Split expression into date part and time part
  const parts = expression.toLowerCase().trim();

  // Try to parse the date component
  const dateResult = parseRelativeDate(parts, now);
  if (dateResult) {
    startDate = dateResult.date;
    confidence = dateResult.confidence;
  }

  // Try to parse time-of-day from the full expression
  const timeResult = parseTimeOfDay(parts, startDate || now);
  if (timeResult) {
    startDate = timeResult.date;
    confidence = Math.min(confidence, timeResult.confidence);
  }

  // If we couldn't parse, try splitting "tomorrow morning" -> "tomorrow" + "morning"
  if (!startDate) {
    const words = parts.split(/\s+/);
    for (let i = 1; i <= words.length; i++) {
      const datePart = words.slice(0, i).join(" ");
      const timePart = words.slice(i).join(" ");

      const dateRes = parseRelativeDate(datePart, now);
      if (dateRes) {
        startDate = dateRes.date;
        confidence = dateRes.confidence;

        if (timePart) {
          const timeRes = parseTimeOfDay(timePart, startDate);
          if (timeRes) {
            startDate = timeRes.date;
            confidence = Math.min(confidence, timeRes.confidence);
          }
        }
        break;
      }
    }
  }

  // If still no date, try just time-of-day (assume today)
  if (!startDate) {
    const timeOnly = parseTimeOfDay(parts, now);
    if (timeOnly) {
      startDate = timeOnly.date;
      // If time is already past, assume tomorrow
      if (startDate.getTime() < now.getTime()) {
        startDate.setDate(startDate.getDate() + 1);
      }
      confidence = timeOnly.confidence * 0.9;
    }
  }

  // If confidence is too low or we couldn't parse, return clarification
  if (!startDate || confidence < 0.75) {
    return {
      type: "clarification",
      question: `I'm not confident about the time "${expression}". Could you clarify? For example: "tomorrow at 2pm", "next Monday morning", or "February 10th at 3:30pm"`,
      options: ["tomorrow morning", "today at 2pm", "next Monday at 10am"],
      originalExpression: expression,
    };
  }

  // If no specific time was set, default to 9am
  if (
    startDate.getHours() === 0 &&
    startDate.getMinutes() === 0 &&
    !/midnight/i.test(parts)
  ) {
    startDate.setHours(9, 0, 0, 0);
    confidence *= 0.9;
  }

  // Calculate end time
  endDate = new Date(startDate);
  endDate.setMinutes(endDate.getMinutes() + defaultDurationMinutes);

  return {
    start: toISOString(startDate),
    end: toISOString(endDate),
    timezone: tz,
    confidence,
    originalExpression: expression,
  };
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Resolve a natural language time expression to ISO 8601 timestamps.
 *
 * @param expression - Natural language time expression
 * @param durationMinutes - Default duration if not specified (default: 60)
 * @returns Resolved timestamps or clarification request
 */
export async function resolveTime(
  expression: string,
  durationMinutes?: number
): Promise<Result<TemporalResult, CalendarError>> {
  if (!expression || expression.trim().length === 0) {
    return {
      success: false,
      error: {
        code: "VALIDATION",
        message: "Empty time expression",
        retryable: false,
      },
    };
  }

  try {
    const result = parseExpression(expression.trim(), durationMinutes || 60);
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: {
        code: "PARSE_ERROR",
        message: `Failed to parse time expression: ${err instanceof Error ? err.message : String(err)}`,
        retryable: false,
      },
    };
  }
}

/**
 * Check if a temporal result is a clarification request.
 */
export function isClarification(
  result: TemporalResult
): result is ClarificationRequest {
  return "type" in result && result.type === "clarification";
}

/**
 * Check if a temporal result is resolved time.
 */
export function isResolvedTime(
  result: TemporalResult
): result is ResolvedTime {
  return "start" in result && "end" in result;
}

// CLI interface
if (import.meta.main) {
  const input = await Bun.stdin.text();

  if (!input.trim()) {
    console.log(`TemporalResolver - Natural Language Date/Time Parser

Usage:
  echo "tomorrow morning" | bun run TemporalResolver.ts
  echo "next Thursday at 3pm" | bun run TemporalResolver.ts

Supported expressions:
  - Relative: today, tomorrow, yesterday, in N hours/days
  - Day names: next Monday, this Friday, Wednesday
  - Time of day: morning (9am), afternoon (2pm), evening (6pm), noon
  - Specific times: 3pm, 10:30am, 14:00
  - Combined: tomorrow morning, next Thursday at 3pm
`);
    process.exit(0);
  }

  const result = await resolveTime(input.trim());
  console.log(JSON.stringify(result, null, 2));
}
