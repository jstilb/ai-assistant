#!/usr/bin/env bun
/**
 * ScheduleHealthReport.ts - Daily/Weekly Schedule Health Analysis
 *
 * Computes health metrics, schedule balance, goal alignment scoring,
 * and generates daily/weekly reports with actionable recommendations.
 *
 * @module ScheduleHealthReport
 */

import type { CalendarEvent } from "./types";

// ============================================
// TYPES
// ============================================

export interface HealthMetrics {
  totalEvents: number;
  totalScheduledMinutes: number;
  meetingCount: number;
  focusCount: number;
  breakCount: number;
  otherCount: number;
}

export interface ScheduleBalance {
  score: number; // 0-100
  meetingRatio: number;
  focusRatio: number;
  breakRatio: number;
  freeRatio: number;
}

export interface DailyReport {
  date: string;
  metrics: HealthMetrics;
  balance: ScheduleBalance;
  goalAlignmentScore: number;
  recommendations: string[];
  overallHealthScore: number;
}

export interface WeeklyTrends {
  avgHealthScore: number;
  avgMeetingRatio: number;
  avgFocusRatio: number;
  busiestDay: string;
  lightestDay: string;
}

export interface WeeklyReport {
  weekStartDate: string;
  dailyReports: DailyReport[];
  weeklyHealthScore: number;
  trends: WeeklyTrends;
  recommendations: string[];
}

// ============================================
// EVENT CLASSIFICATION
// ============================================

const MEETING_KEYWORDS = [
  "meeting", "standup", "stand-up", "sync", "1:1", "one-on-one",
  "call", "interview", "review", "retro", "planning", "grooming",
  "kickoff", "check-in", "catchup", "catch-up", "huddle", "scrum",
  "sprint", "demo", "presentation", "workshop", "all-hands", "town hall",
  "client", "stakeholder",
];

const FOCUS_KEYWORDS = [
  "focus", "deep work", "deep-work", "writing", "coding", "design",
  "research", "study", "learning", "reading", "concentration",
  "heads down", "heads-down", "solo", "individual", "creative",
  "project", "task", "work session", "build",
];

const BREAK_KEYWORDS = [
  "break", "lunch", "coffee", "walk", "gym", "exercise", "rest",
  "relax", "recharge", "personal", "errand", "appointment",
];

function classifyEvent(event: CalendarEvent): "meeting" | "focus" | "break" | "other" {
  const text = event.title.toLowerCase();

  for (const keyword of MEETING_KEYWORDS) {
    if (text.includes(keyword)) return "meeting";
  }
  for (const keyword of FOCUS_KEYWORDS) {
    if (text.includes(keyword)) return "focus";
  }
  for (const keyword of BREAK_KEYWORDS) {
    if (text.includes(keyword)) return "break";
  }

  return "other";
}

function getEventDurationMinutes(event: CalendarEvent): number {
  const start = new Date(event.start).getTime();
  const end = new Date(event.end || event.start).getTime();
  return Math.max(0, (end - start) / (1000 * 60));
}

// ============================================
// HEALTH METRICS
// ============================================

/**
 * Compute basic health metrics for a set of events.
 */
export function computeHealthMetrics(events: CalendarEvent[]): HealthMetrics {
  let meetingCount = 0;
  let focusCount = 0;
  let breakCount = 0;
  let otherCount = 0;
  let totalScheduledMinutes = 0;

  for (const event of events) {
    const category = classifyEvent(event);
    const duration = getEventDurationMinutes(event);
    totalScheduledMinutes += duration;

    switch (category) {
      case "meeting": meetingCount++; break;
      case "focus": focusCount++; break;
      case "break": breakCount++; break;
      case "other": otherCount++; break;
    }
  }

  return {
    totalEvents: events.length,
    totalScheduledMinutes,
    meetingCount,
    focusCount,
    breakCount,
    otherCount,
  };
}

// ============================================
// SCHEDULE BALANCE
// ============================================

// Ideal distribution targets (as ratios of total scheduled time)
const IDEAL_MEETING_RATIO = 0.30;
const IDEAL_FOCUS_RATIO = 0.40;
const IDEAL_BREAK_RATIO = 0.15;
const WORKING_DAY_MINUTES = 480; // 8 hours

/**
 * Compute schedule balance score measuring how close the day is to
 * an ideal meeting/focus/break distribution.
 */
export function computeScheduleBalance(events: CalendarEvent[]): ScheduleBalance {
  if (events.length === 0) {
    return { score: 0, meetingRatio: 0, focusRatio: 0, breakRatio: 0, freeRatio: 0 };
  }

  let meetingMinutes = 0;
  let focusMinutes = 0;
  let breakMinutes = 0;
  let otherMinutes = 0;

  for (const event of events) {
    const category = classifyEvent(event);
    const duration = getEventDurationMinutes(event);

    switch (category) {
      case "meeting": meetingMinutes += duration; break;
      case "focus": focusMinutes += duration; break;
      case "break": breakMinutes += duration; break;
      case "other": otherMinutes += duration; break;
    }
  }

  const totalScheduled = meetingMinutes + focusMinutes + breakMinutes + otherMinutes;
  if (totalScheduled === 0) {
    return { score: 0, meetingRatio: 0, focusRatio: 0, breakRatio: 0, freeRatio: 0 };
  }

  const meetingRatio = meetingMinutes / totalScheduled;
  const focusRatio = focusMinutes / totalScheduled;
  const breakRatio = breakMinutes / totalScheduled;
  const freeRatio = Math.max(0, 1 - (totalScheduled / WORKING_DAY_MINUTES));

  // Score: how close each ratio is to ideal (lower deviation = higher score)
  const meetingDeviation = Math.abs(meetingRatio - IDEAL_MEETING_RATIO);
  const focusDeviation = Math.abs(focusRatio - IDEAL_FOCUS_RATIO);
  const breakDeviation = Math.abs(breakRatio - IDEAL_BREAK_RATIO);

  // Each deviation contributes to score reduction (max deviation ~1.0 per category)
  const avgDeviation = (meetingDeviation + focusDeviation + breakDeviation) / 3;
  const score = Math.round(Math.max(0, Math.min(100, (1 - avgDeviation * 2) * 100)));

  return {
    score,
    meetingRatio: Math.round(meetingRatio * 100) / 100,
    focusRatio: Math.round(focusRatio * 100) / 100,
    breakRatio: Math.round(breakRatio * 100) / 100,
    freeRatio: Math.round(freeRatio * 100) / 100,
  };
}

// ============================================
// GOAL ALIGNMENT SCORING
// ============================================

/**
 * Compute a goal alignment score for events against a set of goal keywords.
 * Returns 0-100 based on how many events match goal keywords.
 */
export function computeGoalAlignmentScore(
  events: CalendarEvent[],
  goalKeywords: string[]
): number {
  if (events.length === 0 || goalKeywords.length === 0) return 0;

  let matchedEvents = 0;
  let totalKeywordHits = 0;

  for (const event of events) {
    const text = `${event.title} ${event.description || ""}`.toLowerCase();
    let eventHits = 0;

    for (const keyword of goalKeywords) {
      if (text.includes(keyword.toLowerCase())) {
        eventHits++;
      }
    }

    if (eventHits > 0) {
      matchedEvents++;
      totalKeywordHits += eventHits;
    }
  }

  // Score combines event match ratio and keyword density
  const eventMatchRatio = matchedEvents / events.length;
  const keywordDensity = Math.min(1, totalKeywordHits / (events.length * goalKeywords.length));

  const score = Math.round((eventMatchRatio * 70 + keywordDensity * 30));
  return Math.min(100, score);
}

// ============================================
// RECOMMENDATIONS
// ============================================

function generateRecommendations(
  metrics: HealthMetrics,
  balance: ScheduleBalance
): string[] {
  const recommendations: string[] = [];

  // Meeting-heavy
  if (balance.meetingRatio > 0.50) {
    recommendations.push(
      `Meeting overload: ${Math.round(balance.meetingRatio * 100)}% of your day is meetings. Try to consolidate or decline low-priority ones.`
    );
  }

  // No focus time
  if (balance.focusRatio < 0.15 && metrics.totalEvents > 2) {
    recommendations.push(
      "Low focus time detected. Block dedicated deep work sessions to protect productive hours."
    );
  }

  // No breaks
  if (balance.breakRatio === 0 && metrics.totalScheduledMinutes > 180) {
    recommendations.push(
      "No breaks scheduled. Add at least one break per 90-minute work block to sustain productivity."
    );
  }

  // Overscheduled
  if (metrics.totalScheduledMinutes > WORKING_DAY_MINUTES * 0.9) {
    recommendations.push(
      `Overscheduled: ${metrics.totalScheduledMinutes} minutes committed. Leave buffer time for unexpected tasks.`
    );
  }

  // Too many events
  if (metrics.totalEvents > 8) {
    recommendations.push(
      `High event count (${metrics.totalEvents}). Context switching reduces productivity. Consider batching similar events.`
    );
  }

  return recommendations;
}

// ============================================
// REPORT GENERATION
// ============================================

/**
 * Generate a daily health report for a set of events.
 */
export function generateDailyReport(events: CalendarEvent[]): DailyReport {
  const metrics = computeHealthMetrics(events);
  const balance = computeScheduleBalance(events);
  const recommendations = generateRecommendations(metrics, balance);

  // Determine the date from events or use today
  const date = events.length > 0
    ? new Date(events[0].start).toISOString().split("T")[0]
    : new Date().toISOString().split("T")[0];

  // Overall health: weighted combination of balance score + reasonable total minutes
  const scheduledRatio = Math.min(1, metrics.totalScheduledMinutes / WORKING_DAY_MINUTES);
  const utilizationScore = scheduledRatio > 0.3 && scheduledRatio < 0.85 ? 80 : scheduledRatio > 0.85 ? 50 : 40;
  const overallHealthScore = Math.round(
    Math.max(0, Math.min(100, balance.score * 0.6 + utilizationScore * 0.4))
  );

  return {
    date,
    metrics,
    balance,
    goalAlignmentScore: 0, // requires goal keywords, computed separately
    recommendations,
    overallHealthScore,
  };
}

/**
 * Generate a weekly health report aggregating daily reports.
 */
export function generateWeeklyReport(events: CalendarEvent[]): WeeklyReport {
  if (events.length === 0) {
    return {
      weekStartDate: new Date().toISOString().split("T")[0],
      dailyReports: [],
      weeklyHealthScore: 0,
      trends: {
        avgHealthScore: 0,
        avgMeetingRatio: 0,
        avgFocusRatio: 0,
        busiestDay: "",
        lightestDay: "",
      },
      recommendations: [],
    };
  }

  // Group events by date
  const eventsByDate: Record<string, CalendarEvent[]> = {};
  for (const event of events) {
    const date = new Date(event.start).toISOString().split("T")[0];
    if (!eventsByDate[date]) eventsByDate[date] = [];
    eventsByDate[date].push(event);
  }

  // Generate daily reports
  const dailyReports: DailyReport[] = [];
  for (const [date, dayEvents] of Object.entries(eventsByDate).sort()) {
    const report = generateDailyReport(dayEvents);
    report.date = date; // ensure correct date
    dailyReports.push(report);
  }

  // Compute weekly aggregates
  const totalHealthScore = dailyReports.reduce((sum, r) => sum + r.overallHealthScore, 0);
  const avgHealthScore = dailyReports.length > 0
    ? Math.round(totalHealthScore / dailyReports.length) : 0;

  const avgMeetingRatio = dailyReports.length > 0
    ? dailyReports.reduce((sum, r) => sum + r.balance.meetingRatio, 0) / dailyReports.length
    : 0;

  const avgFocusRatio = dailyReports.length > 0
    ? dailyReports.reduce((sum, r) => sum + r.balance.focusRatio, 0) / dailyReports.length
    : 0;

  // Find busiest and lightest days
  const sortedByEvents = [...dailyReports].sort(
    (a, b) => b.metrics.totalEvents - a.metrics.totalEvents
  );
  const busiestDay = sortedByEvents[0]?.date || "";
  const lightestDay = sortedByEvents[sortedByEvents.length - 1]?.date || "";

  // Week start date
  const dates = Object.keys(eventsByDate).sort();
  const weekStartDate = dates[0] || new Date().toISOString().split("T")[0];

  // Weekly recommendations
  const weeklyRecommendations: string[] = [];
  if (avgMeetingRatio > 0.45) {
    weeklyRecommendations.push(
      "Meeting-heavy week overall. Consider designating a no-meeting day."
    );
  }
  if (avgFocusRatio < 0.2) {
    weeklyRecommendations.push(
      "Low focus time across the week. Block focus sessions at the start of each day."
    );
  }

  return {
    weekStartDate,
    dailyReports,
    weeklyHealthScore: avgHealthScore,
    trends: {
      avgHealthScore,
      avgMeetingRatio: Math.round(avgMeetingRatio * 100) / 100,
      avgFocusRatio: Math.round(avgFocusRatio * 100) / 100,
      busiestDay,
      lightestDay,
    },
    recommendations: weeklyRecommendations,
  };
}

// ============================================
// CLI INTERFACE
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "help" || !command) {
    console.log(`ScheduleHealthReport - Daily/Weekly Schedule Health Analysis

Usage:
  bun run ScheduleHealthReport.ts help          Show this help

Exports:
  computeHealthMetrics(events)          Basic event metrics
  computeScheduleBalance(events)        Balance score (0-100)
  computeGoalAlignmentScore(events, kw) Goal alignment score
  generateDailyReport(events)           Full daily report
  generateWeeklyReport(events)          Full weekly report
`);
  }
}
