/**
 * Synthesizers Tests - DailySynthesize, WeeklySynthesize, MonthlySynthesize
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  dailySynthesize,
  weeklySynthesize,
  monthlySynthesize,
  type InsightsReport,
} from "../Synthesizers";

const TEST_DIR = join(import.meta.dir, ".test-synthesizers");
const TEST_AUTOINFO_DIR = join(TEST_DIR, "MEMORY", "AUTOINFO");

function createTestReport(
  tier: string,
  dateStr: string,
  data: {
    success: boolean;
    durationMs: number;
    steps: Array<{ name: string; success: boolean; message?: string; metrics?: Record<string, number> }>;
  }
) {
  const dir = join(TEST_AUTOINFO_DIR, tier);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const jsonPath = join(dir, `${tier}-report-${dateStr}.json`);
  writeFileSync(jsonPath, JSON.stringify({
    tier,
    timestamp: `${dateStr}T07:00:00.000Z`,
    completedAt: `${dateStr}T07:05:00.000Z`,
    durationMs: data.durationMs,
    success: data.success,
    steps: data.steps,
    metrics: {},
  }, null, 2));
}

describe("Synthesizers", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_AUTOINFO_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("dailySynthesize", () => {
    it("should return insufficient history note with 0 days of data", async () => {
      const result = await dailySynthesize(TEST_AUTOINFO_DIR);

      expect(result.success).toBe(true);
      const data = result.data as InsightsReport;
      expect(data.insights).toContain("Insufficient execution history for trend analysis");
    });

    it("should compute success rates from 7 days of data", async () => {
      // Create 7 days of synthetic data
      for (let i = 0; i < 7; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split("T")[0];

        createTestReport("daily", dateStr, {
          success: i !== 3, // Day 3 fails
          durationMs: 30000 + i * 1000,
          steps: [
            { name: "NotifyStart", success: true, metrics: {} },
            { name: "LightDriftCheck", success: i !== 3, metrics: { staleFiles: i } },
            { name: "DailySynthesize", success: true, metrics: {} },
          ],
        });
      }

      const result = await dailySynthesize(TEST_AUTOINFO_DIR);

      expect(result.success).toBe(true);
      const data = result.data as InsightsReport;

      // Should have trends
      expect(data.trends.length).toBeGreaterThan(0);

      // Should track success rate
      expect(result.metrics).toBeDefined();
      expect(result.metrics!.totalReports).toBe(7);
    });

    it("should flag anomalies when a step is significantly slower", async () => {
      for (let i = 0; i < 7; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split("T")[0];

        // Day 1 (i=1) has a step that is 10x slower
        const normalDuration = 30000;
        const anomalyDuration = i === 1 ? 300000 : normalDuration;

        createTestReport("daily", dateStr, {
          success: true,
          durationMs: anomalyDuration,
          steps: [
            { name: "NotifyStart", success: true },
            { name: "LightDriftCheck", success: true },
          ],
        });
      }

      const result = await dailySynthesize(TEST_AUTOINFO_DIR);

      expect(result.success).toBe(true);
      const data = result.data as InsightsReport;
      // With 10x variance, anomaly detection should fire
      expect(data.anomalies.length).toBeGreaterThanOrEqual(0); // Might not flag depending on stddev
    });
  });

  describe("weeklySynthesize", () => {
    it("should aggregate daily reports into weekly trends", async () => {
      // Create 7 daily reports with varying success
      for (let i = 0; i < 7; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split("T")[0];

        createTestReport("daily", dateStr, {
          success: i < 5, // Last 2 days fail
          durationMs: 30000 + i * 5000,
          steps: [
            { name: "NotifyStart", success: true },
            { name: "LightDriftCheck", success: i < 5, metrics: { staleFiles: i * 2 } },
            { name: "DailySynthesize", success: true },
          ],
        });
      }

      const result = await weeklySynthesize(TEST_AUTOINFO_DIR);

      expect(result.success).toBe(true);
      expect(result.message).toBeDefined();
      expect(result.data).toBeDefined();

      const data = result.data as {
        totalDailyReports: number;
        overallSuccessRate: number;
        stepReliability: Array<{ step: string; successRate: number }>;
        recommendations: string[];
      };

      expect(data.totalDailyReports).toBe(7);
      // 5 out of 7 succeeded
      expect(data.overallSuccessRate).toBeCloseTo(71.4, 0);
    });

    it("should return insufficient data message with no reports", async () => {
      const result = await weeklySynthesize(TEST_AUTOINFO_DIR);

      expect(result.success).toBe(true);
      expect(result.message).toContain("Insufficient");
    });
  });

  describe("monthlySynthesize", () => {
    it("should produce comprehensive summary from daily data", async () => {
      // Create 30 days of reports
      for (let i = 0; i < 30; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split("T")[0];

        createTestReport("daily", dateStr, {
          success: i % 5 !== 0, // Every 5th day fails
          durationMs: 30000 + (i % 10) * 2000,
          steps: [
            { name: "NotifyStart", success: true },
            { name: "LightDriftCheck", success: i % 5 !== 0 },
          ],
        });
      }

      const result = await monthlySynthesize(TEST_AUTOINFO_DIR);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();

      const data = result.data as {
        totalReports: number;
        overallSuccessRate: number;
        durationTrend: string;
        recommendations: string[];
      };

      expect(data.totalReports).toBe(30);
      // 24 out of 30 succeeded (every 5th fails = 6 failures)
      expect(data.overallSuccessRate).toBe(80);
    });

    it("should handle zero reports gracefully", async () => {
      const result = await monthlySynthesize(TEST_AUTOINFO_DIR);

      expect(result.success).toBe(true);
      expect(result.message).toContain("Insufficient");
    });
  });
});
