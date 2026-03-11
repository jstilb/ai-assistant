#!/usr/bin/env bun
/**
 * WeatherMessenger.ts - Standalone weather delivery for Kaya
 *
 * Composes WeatherService + WeatherRecommender + delivery channels.
 * Delivers a rich, personalized morning weather message via Telegram
 * text and voice notification.
 *
 * Usage:
 *   bun WeatherMessenger.ts                    # Full delivery (Telegram + voice)
 *   bun WeatherMessenger.ts --dry-run          # Preview without sending
 *   bun WeatherMessenger.ts --text-only        # Telegram text only
 *   bun WeatherMessenger.ts --voice-only       # Voice only
 *   bun WeatherMessenger.ts --json             # Output raw data as JSON
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import { fetchWeatherReport } from "./WeatherService.ts";
import { getRecommendations } from "./WeatherRecommender.ts";
import type { WeatherReport, DayForecast, WeatherAlert } from "./WeatherService.ts";
import type { WeatherRecommendations } from "./WeatherRecommender.ts";

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = process.env.KAYA_DIR || join(homedir(), '.claude');
const WEATHER_LOG_DIR = join(KAYA_HOME, 'MEMORY', 'WEATHER');
const TELEGRAM_CLIENT = join(KAYA_HOME, 'skills', 'Telegram', 'Tools', 'TelegramClient.ts');
const NOTIFICATION_SERVICE = join(KAYA_HOME, 'skills', 'CORE', 'Tools', 'NotificationService.ts');
const DEFAULT_LOCATION = 'San Diego, CA';

// ============================================================================
// Telegram Message Formatting
// ============================================================================

function formatDayName(dateStr: string): string {
  const date = new Date(dateStr + 'T12:00:00');
  return date.toLocaleDateString('en-US', { weekday: 'short' });
}

function formatTelegramMessage(
  report: WeatherReport,
  recommendations: WeatherRecommendations | null,
): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });

  let msg = '';

  // Header
  msg += `${report.current.icon} *Weather for ${dateStr}*\n`;
  msg += `${report.location}\n\n`;

  // Current conditions
  msg += `*Right Now*\n`;
  msg += `${report.current.icon} ${report.current.tempF}°F`;
  if (report.current.feelsLikeF !== report.current.tempF) {
    msg += ` (feels like ${report.current.feelsLikeF}°F)`;
  }
  msg += `\n`;
  msg += `${report.current.condition}`;
  msg += ` · Humidity ${report.current.humidity}%`;
  if (report.current.windMph > 5) {
    msg += ` · Wind ${report.current.windMph}mph ${report.current.windDir}`;
  }
  msg += `\n`;
  if (report.current.uvIndex >= 3) {
    msg += `UV Index: ${report.current.uvIndex}`;
    if (report.current.uvIndex >= 8) msg += ' (Very High)';
    else if (report.current.uvIndex >= 6) msg += ' (High)';
    else if (report.current.uvIndex >= 3) msg += ' (Moderate)';
    msg += `\n`;
  }
  msg += `\n`;

  // Today's forecast
  msg += `*Today*\n`;
  msg += `High ${report.today.highF}°F / Low ${report.today.lowF}°F\n`;
  if (report.today.rainChancePct > 0) {
    msg += `🌧 Rain: ${report.today.rainChancePct}%\n`;
  }
  msg += `☀️ ${report.astronomy.sunrise} → 🌙 ${report.astronomy.sunset}\n`;
  msg += `\n`;

  // 3-day forecast
  if (report.forecast.length > 1) {
    msg += `*3-Day Outlook*\n`;
    for (const day of report.forecast) {
      const dayName = formatDayName(day.date);
      let line = `${day.icon} ${dayName}: ${day.highF}°F/${day.lowF}°F ${day.condition}`;
      if (day.rainChancePct >= 20) {
        line += ` (${day.rainChancePct}% rain)`;
      }
      msg += `${line}\n`;
    }
    msg += `\n`;
  }

  // Recommendations
  if (recommendations) {
    msg += `*What to Wear*\n`;
    msg += `👕 ${recommendations.clothing}\n\n`;
    msg += `*What to Do*\n`;
    msg += `🏃 ${recommendations.activities}\n`;

    if (recommendations.highlights.length > 0) {
      msg += `\n*Heads Up*\n`;
      for (const h of recommendations.highlights) {
        msg += `⚡ ${h}\n`;
      }
    }
    msg += `\n`;
  }

  // Alerts
  if (report.alerts.length > 0) {
    const severityEmoji: Record<string, string> = {
      extreme: '🔴',
      severe: '🟠',
      moderate: '🟡',
      minor: '🔵',
    };

    msg += `*⚠️ Weather Alerts*\n`;
    for (const alert of report.alerts) {
      const emoji = severityEmoji[alert.severity] || '⚠️';
      msg += `${emoji} *${alert.event}*: ${alert.headline}\n`;
    }
    msg += `\n`;
  }

  // Footer
  msg += `_Kaya Weather · ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' })}_`;

  return msg;
}

// ============================================================================
// Voice Summary Formatting
// ============================================================================

function formatVoiceSummary(
  report: WeatherReport,
  recommendations: WeatherRecommendations | null,
): string {
  const parts: string[] = [];

  // Opening
  parts.push(`Good morning Jm`);

  // Current conditions
  parts.push(`It's ${report.current.tempF} degrees and ${report.current.condition.toLowerCase()} in San Diego`);

  // Today's forecast
  parts.push(`High of ${report.today.highF} today`);

  // Rain mention (notable for SD)
  if (report.today.rainChancePct >= 20) {
    parts.push(`${report.today.rainChancePct} percent chance of rain`);
  }

  // Short recommendation
  if (recommendations) {
    // Extract just the first sentence of clothing
    const firstSentence = recommendations.clothing.split('.')[0];
    if (firstSentence && firstSentence.length < 60) {
      parts.push(firstSentence);
    }
  }

  // Alerts (brief)
  if (report.alerts.length > 0) {
    const topAlert = report.alerts[0];
    parts.push(`Weather alert: ${topAlert.event}`);
  }

  // Multi-day notable change
  if (report.forecast.length >= 2) {
    const tomorrow = report.forecast[1];
    const tempDrop = report.today.highF - tomorrow.highF;
    if (tempDrop >= 10) {
      parts.push(`Cooling off tomorrow, ${tomorrow.highF} degrees`);
    } else if (tempDrop <= -10) {
      parts.push(`Warming up tomorrow, ${tomorrow.highF} degrees`);
    }
    if (tomorrow.rainChancePct >= 40 && report.today.rainChancePct < 20) {
      parts.push(`Rain expected tomorrow`);
    }
  }

  // Keep under ~50 words
  let summary = parts.join('. ') + '.';

  // Trim if too long
  const words = summary.split(' ');
  if (words.length > 55) {
    summary = words.slice(0, 50).join(' ') + '.';
  }

  return summary;
}

// ============================================================================
// Delivery Functions
// ============================================================================

async function deliverTelegram(message: string): Promise<boolean> {
  try {
    if (!existsSync(TELEGRAM_CLIENT)) {
      console.error('Telegram client not found at:', TELEGRAM_CLIENT);
      return false;
    }

    // Use TelegramClient to send the message
    execSync(
      `bun "${TELEGRAM_CLIENT}" send "${message.replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`,
      { encoding: 'utf-8', timeout: 15000 }
    );

    console.log('Telegram message sent');
    return true;
  } catch (error) {
    console.error('Telegram delivery failed:', error instanceof Error ? error.message : error);
    return false;
  }
}

async function deliverVoice(summary: string): Promise<boolean> {
  try {
    const { notifySync } = await import(NOTIFICATION_SERVICE);
    notifySync(summary, { agentName: 'Kaya Weather' });
    console.log('Voice notification sent');
    return true;
  } catch (error) {
    console.error('Voice delivery failed:', error instanceof Error ? error.message : error);
    return false;
  }
}

// ============================================================================
// Logging
// ============================================================================

function logWeatherData(
  report: WeatherReport,
  recommendations: WeatherRecommendations | null,
  deliveryResults: { telegram: boolean; voice: boolean },
): void {
  try {
    if (!existsSync(WEATHER_LOG_DIR)) {
      mkdirSync(WEATHER_LOG_DIR, { recursive: true });
    }

    const date = new Date().toISOString().split('T')[0];
    const logPath = join(WEATHER_LOG_DIR, `${date}.json`);

    const logEntry = {
      date,
      timestamp: new Date().toISOString(),
      location: report.location,
      current: report.current,
      today: {
        highF: report.today.highF,
        lowF: report.today.lowF,
        condition: report.today.condition,
        rainChancePct: report.today.rainChancePct,
        uvIndex: report.today.uvIndex,
      },
      forecast: report.forecast.map(d => ({
        date: d.date,
        highF: d.highF,
        lowF: d.lowF,
        condition: d.condition,
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
      delivery: deliveryResults,
    };

    writeFileSync(logPath, JSON.stringify(logEntry, null, 2));
    console.log(`Weather log saved: ${logPath}`);
  } catch (error) {
    console.error('Failed to save weather log:', error instanceof Error ? error.message : error);
  }
}

// ============================================================================
// Main Orchestrator
// ============================================================================

interface MessengerOptions {
  location?: string;
  dryRun?: boolean;
  textOnly?: boolean;
  voiceOnly?: boolean;
  outputJson?: boolean;
  rulesOnly?: boolean;
}

export async function runWeatherMessenger(options: MessengerOptions = {}): Promise<{
  success: boolean;
  report: WeatherReport;
  recommendations: WeatherRecommendations | null;
  telegramMessage: string;
  voiceSummary: string;
  delivery: { telegram: boolean; voice: boolean };
}> {
  const location = options.location || DEFAULT_LOCATION;

  console.log(`Fetching weather for ${location}...\n`);

  // Step 1: Fetch weather data
  const report = await fetchWeatherReport(location);
  console.log(`Current: ${report.current.icon} ${report.current.tempF}°F, ${report.current.condition}`);
  console.log(`Today: H ${report.today.highF}°F / L ${report.today.lowF}°F\n`);

  // Step 2: Get recommendations
  let recommendations: WeatherRecommendations | null = null;
  try {
    recommendations = await getRecommendations(report, { rulesOnly: options.rulesOnly });
    console.log(`Recommendations (${recommendations.source}): ready\n`);
  } catch (error) {
    console.error('Recommendations failed, continuing without:', error instanceof Error ? error.message : error);
  }

  // Step 3: Format messages
  const telegramMessage = formatTelegramMessage(report, recommendations);
  const voiceSummary = formatVoiceSummary(report, recommendations);

  // Step 4: Deliver
  const delivery = { telegram: false, voice: false };

  if (options.dryRun) {
    console.log('=== DRY RUN MODE ===\n');
    console.log('--- TELEGRAM MESSAGE ---\n');
    console.log(telegramMessage);
    console.log('\n--- VOICE SUMMARY ---\n');
    console.log(voiceSummary);
    console.log(`\n(${voiceSummary.split(' ').length} words)`);
  } else if (options.outputJson) {
    // JSON output handled in main()
  } else {
    if (!options.voiceOnly) {
      console.log('Sending Telegram message...');
      delivery.telegram = await deliverTelegram(telegramMessage);
    }
    if (!options.textOnly) {
      console.log('Sending voice summary...');
      delivery.voice = await deliverVoice(voiceSummary);
    }
  }

  // Step 5: Log
  if (!options.dryRun && !options.outputJson) {
    logWeatherData(report, recommendations, delivery);
  }

  return {
    success: delivery.telegram || delivery.voice || options.dryRun || options.outputJson || false,
    report,
    recommendations,
    telegramMessage,
    voiceSummary,
    delivery,
  };
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
WeatherMessenger - Standalone morning weather delivery for Kaya

Usage:
  bun WeatherMessenger.ts                    Full delivery (Telegram + voice)
  bun WeatherMessenger.ts --dry-run          Preview without sending
  bun WeatherMessenger.ts --text-only        Telegram only (no voice)
  bun WeatherMessenger.ts --voice-only       Voice only (no Telegram)
  bun WeatherMessenger.ts --json             Output raw data as JSON
  bun WeatherMessenger.ts --rules-only       Skip AI, use rule-based recommendations

Options:
  --dry-run          Preview messages without delivering
  --text-only        Send Telegram message only
  --voice-only       Send voice summary only
  --json             Output structured JSON
  --rules-only       Use rule-based recommendations (no inference)
  --location <loc>   Override location (default: San Diego, CA)
  --help, -h         Show this help
`);
    return;
  }

  const locIdx = args.indexOf('--location');
  const location = locIdx !== -1 && args[locIdx + 1] ? args[locIdx + 1] : undefined;

  const options: MessengerOptions = {
    location,
    dryRun: args.includes('--dry-run'),
    textOnly: args.includes('--text-only'),
    voiceOnly: args.includes('--voice-only'),
    outputJson: args.includes('--json'),
    rulesOnly: args.includes('--rules-only'),
  };

  try {
    const result = await runWeatherMessenger(options);

    if (options.outputJson) {
      console.log(JSON.stringify({
        report: result.report,
        recommendations: result.recommendations,
        telegramMessage: result.telegramMessage,
        voiceSummary: result.voiceSummary,
        delivery: result.delivery,
      }, null, 2));
      return;
    }

    if (!options.dryRun) {
      console.log('\nDelivery results:');
      console.log(`  Telegram: ${result.delivery.telegram ? 'sent' : 'skipped/failed'}`);
      console.log(`  Voice: ${result.delivery.voice ? 'sent' : 'skipped/failed'}`);
    }

    console.log('\nWeather messenger complete.');
  } catch (error) {
    console.error('WeatherMessenger failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
