#!/usr/bin/env bun
/**
 * WeatherBlock.ts - Enhanced weather block for DailyBriefing
 *
 * Uses WeatherService for rich data and optionally includes
 * recommendations from WeatherRecommender. Backward-compatible
 * with the BlockResult interface used by BriefingGenerator.
 *
 * Enhancements over v1:
 *   - Full 3-day forecast with condition icons
 *   - Sunrise/sunset and UV index
 *   - Optional clothing & activity recommendations
 *   - NWS weather alerts
 *   - Structured data in BlockResult.data for downstream consumers
 *
 * Usage:
 *   bun WeatherBlock.ts --test
 *   bun WeatherBlock.ts --test --no-recommendations
 */

import type { WeatherReport, DayForecast, WeatherAlert } from "./WeatherService.ts";
import type { WeatherRecommendations } from "./WeatherRecommender.ts";

// ============================================================================
// Types (shared from types.ts)
// ============================================================================

import type { BlockResult } from "./types.ts";
export type { BlockResult };

export interface WeatherBlockConfig {
  location?: string;
  includeForecast?: boolean;
  includeRecommendations?: boolean;
  include3DayForecast?: boolean;
  includeAlerts?: boolean;
}

// ============================================================================
// Formatting Helpers
// ============================================================================

function formatDayRow(day: DayForecast): string {
  const dateObj = new Date(day.date + 'T12:00:00');
  const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
  const rain = day.rainChancePct > 0 ? ` (${day.rainChancePct}% rain)` : '';
  return `| ${dayName} ${day.date.slice(5)} | ${day.icon} ${day.condition} | ${day.highF}°F | ${day.lowF}°F |${rain}`;
}

function formatAlertSection(alerts: WeatherAlert[]): string {
  if (alerts.length === 0) return '';

  const severityEmoji: Record<string, string> = {
    extreme: '🔴',
    severe: '🟠',
    moderate: '🟡',
    minor: '🔵',
  };

  let md = '\n### Weather Alerts\n\n';
  for (const alert of alerts) {
    const emoji = severityEmoji[alert.severity] || '⚠️';
    md += `${emoji} **${alert.event}** (${alert.severity})\n`;
    md += `${alert.headline}\n\n`;
  }
  return md;
}

// ============================================================================
// Block Execution
// ============================================================================

export async function execute(config: WeatherBlockConfig = {}): Promise<BlockResult> {
  const {
    location = "San Diego, CA",
    includeForecast = true,
    includeRecommendations = true,
    include3DayForecast = true,
    includeAlerts = true,
  } = config;

  try {
    // Dynamic import to keep WeatherService as the source of truth
    const { fetchWeatherReport } = await import("./WeatherService.ts");

    let report: WeatherReport;
    try {
      report = await fetchWeatherReport(location);
    } catch (fetchError) {
      // If WeatherService fails completely, return a degraded block
      return {
        blockName: "weather",
        success: false,
        data: { location },
        markdown: `## Weather\n\nWeather data unavailable for ${location}.\n`,
        summary: "Weather unavailable",
        error: fetchError instanceof Error ? fetchError.message : String(fetchError),
      };
    }

    // Get recommendations if enabled
    let recommendations: WeatherRecommendations | null = null;
    if (includeRecommendations) {
      try {
        const { getRecommendations } = await import("./WeatherRecommender.ts");
        recommendations = await getRecommendations(report);
      } catch {
        // Recommendations are optional; skip on failure
      }
    }

    // --- Build Markdown ---
    let markdown = "## Weather\n\n";

    // Current conditions
    markdown += `**${location}:** ${report.current.icon} ${report.current.tempF}°F`;
    if (report.current.feelsLikeF !== report.current.tempF) {
      markdown += ` (feels like ${report.current.feelsLikeF}°F)`;
    }
    markdown += `, ${report.current.condition}\n`;

    // Today's high/low
    if (includeForecast) {
      markdown += `**Today:** High ${report.today.highF}°F, Low ${report.today.lowF}°F`;
      if (report.today.uvIndex >= 6) {
        markdown += ` | UV ${report.today.uvIndex} (high)`;
      }
      markdown += '\n';
      markdown += `**Sunrise:** ${report.astronomy.sunrise} | **Sunset:** ${report.astronomy.sunset}\n`;
    }

    // 3-day forecast table
    if (include3DayForecast && report.forecast.length > 0) {
      markdown += '\n### 3-Day Forecast\n\n';
      markdown += '| Day | Condition | High | Low |\n';
      markdown += '|-----|-----------|------|-----|\n';
      for (const day of report.forecast) {
        markdown += formatDayRow(day) + '\n';
      }
    }

    // Recommendations
    if (recommendations) {
      markdown += '\n### Recommendations\n\n';
      markdown += `**Clothing:** ${recommendations.clothing}\n`;
      markdown += `**Activities:** ${recommendations.activities}\n`;
      if (recommendations.highlights.length > 0) {
        markdown += '\n**Notable:**\n';
        for (const h of recommendations.highlights) {
          markdown += `- ${h}\n`;
        }
      }
    }

    // Alerts
    if (includeAlerts && report.alerts.length > 0) {
      markdown += formatAlertSection(report.alerts);
    }

    // --- Build Summary (backward-compatible, short) ---
    const summary = `${report.current.tempF}°F ${report.current.condition}`;

    // --- Build Data (rich, for downstream) ---
    const data: Record<string, unknown> = {
      location,
      current: {
        temp: `${report.current.tempF}°F`,
        tempF: report.current.tempF,
        feelsLikeF: report.current.feelsLikeF,
        condition: report.current.condition,
        icon: report.current.icon,
        humidity: report.current.humidity,
        windMph: report.current.windMph,
        windDir: report.current.windDir,
        uvIndex: report.current.uvIndex,
      },
      forecast: {
        high: `${report.today.highF}°F`,
        low: `${report.today.lowF}°F`,
        highF: report.today.highF,
        lowF: report.today.lowF,
      },
      forecast3Day: report.forecast.map(d => ({
        date: d.date,
        highF: d.highF,
        lowF: d.lowF,
        condition: d.condition,
        icon: d.icon,
        rainChancePct: d.rainChancePct,
      })),
      astronomy: report.astronomy,
      alerts: report.alerts,
      recommendations: recommendations ? {
        clothing: recommendations.clothing,
        activities: recommendations.activities,
        highlights: recommendations.highlights,
        source: recommendations.source,
      } : null,
      // Full report for WeatherMessenger or other consumers
      _fullReport: report,
    };

    return {
      blockName: "weather",
      success: true,
      data,
      markdown,
      summary,
    };
  } catch (error) {
    return {
      blockName: "weather",
      success: false,
      data: {},
      markdown: "## Weather\n\nFailed to load weather.\n",
      summary: "Weather error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
WeatherBlock - Enhanced weather block for DailyBriefing

Usage:
  bun WeatherBlock.ts --test                        Test with San Diego
  bun WeatherBlock.ts --test --no-recommendations   Skip AI recommendations
  bun WeatherBlock.ts --test --json                  Output as JSON

Options:
  --test                  Run a test
  --no-recommendations    Disable AI recommendations
  --json                  Output raw BlockResult as JSON
  --help, -h              Show this help
`);
    process.exit(0);
  }

  if (args.includes("--test") || args.includes("-t")) {
    const noRecs = args.includes("--no-recommendations");
    const outputJson = args.includes("--json");
    const location = args.find((a) => !a.startsWith("-")) || "San Diego, CA";

    execute({
      location,
      includeForecast: true,
      includeRecommendations: !noRecs,
      include3DayForecast: true,
      includeAlerts: true,
    })
      .then((result) => {
        if (outputJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log("=== Weather Block Test ===\n");
          console.log("Success:", result.success);
          console.log("\nMarkdown:\n", result.markdown);
          console.log("\nSummary:", result.summary);
          if (result.error) console.log("\nError:", result.error);
        }
      })
      .catch(console.error);
  } else {
    console.log("Usage: bun WeatherBlock.ts --test [--no-recommendations] [--json]");
  }
}
