#!/usr/bin/env bun
/**
 * ============================================================================
 * Synthesizers.ts - Statistical aggregation for daily/weekly/monthly synthesis
 * ============================================================================
 *
 * PURPOSE:
 * Replaces stub synthesizers with real statistical aggregation from execution
 * history. Reads JSON sidecar reports from MEMORY/AUTOINFO/ to compute success
 * rates, duration trends, anomaly detection, and actionable recommendations.
 *
 * USAGE:
 *   import { dailySynthesize, weeklySynthesize, monthlySynthesize } from './Synthesizers';
 *
 *   const result = await dailySynthesize();
 *   // result.data = { insights: [...], trends: [...], anomalies: [...] }
 *
 * ============================================================================
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { z } from "zod";
import type { StepResult } from "../../../../lib/core/WorkflowExecutor";

// ============================================================================
// Types
// ============================================================================

export interface InsightsReport {
  insights: string[];
  trends: string[];
  anomalies: string[];
}

interface ReportData {
  tier: string;
  timestamp: string;
  completedAt: string;
  durationMs: number;
  success: boolean;
  steps: Array<{
    name: string;
    success: boolean;
    message?: string;
    metrics?: Record<string, number>;
  }>;
  metrics: Record<string, number>;
}

const ReportDataSchema = z.object({
  tier: z.string(),
  timestamp: z.string(),
  completedAt: z.string(),
  durationMs: z.number(),
  success: z.boolean(),
  steps: z.array(z.object({
    name: z.string(),
    success: z.boolean(),
    message: z.string().optional(),
    metrics: z.record(z.string(), z.number()).optional(),
  })),
  metrics: z.record(z.string(), z.number()),
});

// ============================================================================
// Helpers
// ============================================================================

const KAYA_DIR = process.env.KAYA_DIR || join(homedir(), ".claude");
const DEFAULT_AUTOINFO_DIR = join(KAYA_DIR, "MEMORY/AUTOINFO");

/**
 * Load JSON sidecar reports for a tier within a date range
 */
function loadReports(autoinfoDir: string, tier: string, daysBack: number): ReportData[] {
  const dir = join(autoinfoDir, tier);
  if (!existsSync(dir)) return [];

  const reports: ReportData[] = [];
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;

  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse();

  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), "utf-8");
      const parsed = ReportDataSchema.safeParse(JSON.parse(content));
      if (!parsed.success) continue;

      const data = parsed.data;
      if (data.timestamp) {
        const ts = new Date(data.timestamp).getTime();
        if (ts >= cutoff) {
          reports.push(data);
        }
      }
    } catch {
      // Skip malformed reports
    }
  }

  return reports;
}

/**
 * Compute mean of an array of numbers
 */
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Compute standard deviation
 */
function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Compute P95 of a sorted array
 */
function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

// ============================================================================
// Daily Synthesize
// ============================================================================

/**
 * DailySynthesize: Reads execution history, computes per-step success rate,
 * mean/P95 duration, flags anomalies >2sigma from 7-day rolling average.
 */
export async function dailySynthesize(autoinfoDir?: string): Promise<StepResult> {
  const dir = autoinfoDir || DEFAULT_AUTOINFO_DIR;
  const reports = loadReports(dir, "daily", 7);

  if (reports.length < 3) {
    return {
      success: true,
      message: "Daily synthesis: insufficient execution history",
      data: {
        insights: ["Insufficient execution history for trend analysis"],
        trends: [],
        anomalies: [],
      } as InsightsReport,
      metrics: { totalReports: reports.length },
    };
  }

  const insights: string[] = [];
  const trends: string[] = [];
  const anomalies: string[] = [];

  // Overall success rate
  const successCount = reports.filter((r) => r.success).length;
  const successRate = Math.round((successCount / reports.length) * 100);
  insights.push(`Overall success rate: ${successRate}% (${successCount}/${reports.length} runs)`);

  // Duration analysis
  const durations = reports.map((r) => r.durationMs);
  const avgDuration = mean(durations);
  const p95Duration = p95(durations);
  trends.push(`Mean duration: ${Math.round(avgDuration / 1000)}s, P95: ${Math.round(p95Duration / 1000)}s`);

  // Per-step success tracking
  const stepStats: Record<string, { successes: number; total: number; durations: number[] }> = {};

  for (const report of reports) {
    for (const step of report.steps || []) {
      if (!stepStats[step.name]) {
        stepStats[step.name] = { successes: 0, total: 0, durations: [] };
      }
      stepStats[step.name].total++;
      if (step.success) stepStats[step.name].successes++;
    }

    // Track overall duration per report for anomaly detection
  }

  // Report per-step reliability
  for (const [stepName, stats] of Object.entries(stepStats)) {
    const rate = Math.round((stats.successes / stats.total) * 100);
    if (rate < 100) {
      insights.push(`Step "${stepName}": ${rate}% success rate (${stats.successes}/${stats.total})`);
    }
    if (rate < 80) {
      anomalies.push(`Step "${stepName}" has low reliability (${rate}%)`);
    }
  }

  // Duration anomaly detection (>2 sigma from mean)
  const durationStdDev = stdDev(durations);
  if (durationStdDev > 0) {
    for (const report of reports) {
      const deviation = Math.abs(report.durationMs - avgDuration) / durationStdDev;
      if (deviation > 2) {
        const date = report.timestamp.split("T")[0];
        anomalies.push(
          `Duration anomaly on ${date}: ${Math.round(report.durationMs / 1000)}s (${deviation.toFixed(1)} sigma from mean)`
        );
      }
    }
  }

  // Trend: duration increasing or decreasing?
  if (reports.length >= 3) {
    const recentAvg = mean(durations.slice(0, 3));
    const olderAvg = mean(durations.slice(-3));
    if (olderAvg > 0) {
      const changePct = Math.round(((recentAvg - olderAvg) / olderAvg) * 100);
      if (Math.abs(changePct) > 10) {
        trends.push(
          changePct > 0
            ? `Duration trending UP: +${changePct}% over last 7 days`
            : `Duration trending DOWN: ${changePct}% over last 7 days`
        );
      } else {
        trends.push("Duration stable over last 7 days");
      }
    }
  }

  const report: InsightsReport = { insights, trends, anomalies };

  return {
    success: true,
    message: `Daily synthesis: ${reports.length} reports analyzed, ${anomalies.length} anomalies, ${successRate}% success rate`,
    data: report,
    metrics: {
      totalReports: reports.length,
      successRate,
      anomalyCount: anomalies.length,
      avgDurationMs: Math.round(avgDuration),
      p95DurationMs: Math.round(p95Duration),
    },
  };
}

// ============================================================================
// Weekly Synthesize
// ============================================================================

/**
 * WeeklySynthesize: Aggregates 7 daily reports into weekly trends.
 * Ranks steps by reliability, identifies patterns, generates recommendations.
 */
export async function weeklySynthesize(autoinfoDir?: string): Promise<StepResult> {
  const dir = autoinfoDir || DEFAULT_AUTOINFO_DIR;
  const dailyReports = loadReports(dir, "daily", 7);

  if (dailyReports.length === 0) {
    return {
      success: true,
      message: "Insufficient daily reports for weekly synthesis",
      data: { totalDailyReports: 0, recommendations: ["Run daily tier to generate data"] },
    };
  }

  // Overall success rate
  const successCount = dailyReports.filter((r) => r.success).length;
  const overallSuccessRate = Math.round((successCount / dailyReports.length) * 1000) / 10;

  // Per-step reliability ranking
  const stepStats: Record<string, { successes: number; total: number }> = {};

  for (const report of dailyReports) {
    for (const step of report.steps || []) {
      if (!stepStats[step.name]) {
        stepStats[step.name] = { successes: 0, total: 0 };
      }
      stepStats[step.name].total++;
      if (step.success) stepStats[step.name].successes++;
    }
  }

  const stepReliability = Object.entries(stepStats)
    .map(([step, stats]) => ({
      step,
      successRate: Math.round((stats.successes / stats.total) * 100),
      total: stats.total,
    }))
    .sort((a, b) => a.successRate - b.successRate);

  // Duration trend
  const durations = dailyReports.map((r) => r.durationMs);
  const avgDuration = mean(durations);

  // Generate recommendations
  const recommendations: string[] = [];

  const failingSteps = stepReliability.filter((s) => s.successRate < 90);
  if (failingSteps.length > 0) {
    const worst = failingSteps[0];
    recommendations.push(`Investigate "${worst.step}" - ${worst.successRate}% success rate over ${worst.total} runs`);
  }

  if (overallSuccessRate < 80) {
    recommendations.push("Overall reliability below 80% - review workflow configuration");
  }

  if (avgDuration > 120000) {
    recommendations.push(`Average duration ${Math.round(avgDuration / 1000)}s exceeds 2 minutes - consider parallelization`);
  }

  if (dailyReports.length < 5) {
    recommendations.push("Less than 5 daily reports available - data insufficient for reliable trends");
  }

  // Error pattern detection
  const errorPatterns: Record<string, number> = {};
  for (const report of dailyReports) {
    for (const step of report.steps || []) {
      if (!step.success && step.message) {
        // Extract error pattern (first 50 chars)
        const pattern = step.message.slice(0, 50);
        errorPatterns[pattern] = (errorPatterns[pattern] || 0) + 1;
      }
    }
  }

  const recurringErrors = Object.entries(errorPatterns)
    .filter(([, count]) => count >= 2)
    .map(([pattern, count]) => `"${pattern}" occurred ${count} times`);

  if (recurringErrors.length > 0) {
    recommendations.push(`Recurring errors detected: ${recurringErrors.join("; ")}`);
  }

  return {
    success: true,
    message: `Weekly synthesis: ${dailyReports.length} daily reports, ${overallSuccessRate}% success rate`,
    data: {
      totalDailyReports: dailyReports.length,
      overallSuccessRate,
      stepReliability,
      avgDurationMs: Math.round(avgDuration),
      recommendations,
      recurringErrors,
    },
    metrics: {
      totalDailyReports: dailyReports.length,
      overallSuccessRate,
      failingStepCount: failingSteps.length,
    },
  };
}

// ============================================================================
// Monthly Synthesize
// ============================================================================

/**
 * MonthlySynthesize: Comprehensive 30-day summary with trends, growth metrics,
 * and actionable recommendations.
 */
export async function monthlySynthesize(autoinfoDir?: string): Promise<StepResult> {
  const dir = autoinfoDir || DEFAULT_AUTOINFO_DIR;
  const reports = loadReports(dir, "daily", 30);

  if (reports.length === 0) {
    return {
      success: true,
      message: "Insufficient data for monthly synthesis",
      data: { totalReports: 0, recommendations: ["Run daily tiers to accumulate data"] },
    };
  }

  // Overall metrics
  const successCount = reports.filter((r) => r.success).length;
  const overallSuccessRate = Math.round((successCount / reports.length) * 100);

  // Duration analysis
  const durations = reports.map((r) => r.durationMs);
  const avgDuration = mean(durations);
  const totalDurationMs = durations.reduce((a, b) => a + b, 0);

  // Duration trend: compare first half to second half
  const halfIndex = Math.floor(reports.length / 2);
  const firstHalfDurations = durations.slice(halfIndex);
  const secondHalfDurations = durations.slice(0, halfIndex);
  const firstHalfAvg = mean(firstHalfDurations);
  const secondHalfAvg = mean(secondHalfDurations);

  let durationTrend = "stable";
  if (firstHalfAvg > 0) {
    const changePct = ((secondHalfAvg - firstHalfAvg) / firstHalfAvg) * 100;
    if (changePct > 15) durationTrend = "increasing";
    else if (changePct < -15) durationTrend = "decreasing";
  }

  // Per-step analysis
  const stepStats: Record<string, { successes: number; total: number }> = {};
  for (const report of reports) {
    for (const step of report.steps || []) {
      if (!stepStats[step.name]) {
        stepStats[step.name] = { successes: 0, total: 0 };
      }
      stepStats[step.name].total++;
      if (step.success) stepStats[step.name].successes++;
    }
  }

  const stepReliability = Object.entries(stepStats)
    .map(([step, stats]) => ({
      step,
      successRate: Math.round((stats.successes / stats.total) * 100),
    }))
    .sort((a, b) => a.successRate - b.successRate);

  // Failure frequency analysis
  const failedDays = reports.filter((r) => !r.success).length;
  const failureRate = Math.round((failedDays / reports.length) * 100);

  // Weekly breakdown
  const weeklyBuckets: Record<string, { success: number; total: number }> = {};
  for (const report of reports) {
    const date = new Date(report.timestamp);
    const weekStart = new Date(date);
    weekStart.setDate(date.getDate() - date.getDay());
    const weekKey = weekStart.toISOString().split("T")[0];

    if (!weeklyBuckets[weekKey]) weeklyBuckets[weekKey] = { success: 0, total: 0 };
    weeklyBuckets[weekKey].total++;
    if (report.success) weeklyBuckets[weekKey].success++;
  }

  const weeklyTrend = Object.entries(weeklyBuckets).map(([week, stats]) => ({
    week,
    successRate: Math.round((stats.success / stats.total) * 100),
  }));

  // Recommendations
  const recommendations: string[] = [];

  if (overallSuccessRate < 90) {
    recommendations.push(`Monthly success rate ${overallSuccessRate}% is below 90% target`);
  }

  const chronicallyFailing = stepReliability.filter((s) => s.successRate < 80);
  if (chronicallyFailing.length > 0) {
    recommendations.push(
      `Steps with chronic failures: ${chronicallyFailing.map((s) => `${s.step} (${s.successRate}%)`).join(", ")}`
    );
  }

  if (durationTrend === "increasing") {
    recommendations.push("Execution duration is trending upward - review for performance regressions");
  }

  if (reports.length < 20) {
    recommendations.push(`Only ${reports.length} reports in 30 days - expected ~30 for daily tier`);
  }

  return {
    success: true,
    message: `Monthly synthesis: ${reports.length} reports over 30 days, ${overallSuccessRate}% success rate`,
    data: {
      totalReports: reports.length,
      overallSuccessRate,
      failureRate,
      avgDurationMs: Math.round(avgDuration),
      totalDurationMs,
      durationTrend,
      stepReliability,
      weeklyTrend,
      recommendations,
    },
    metrics: {
      totalReports: reports.length,
      overallSuccessRate,
      failureRate,
      avgDurationMs: Math.round(avgDuration),
    },
  };
}
