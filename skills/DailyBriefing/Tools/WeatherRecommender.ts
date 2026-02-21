#!/usr/bin/env bun
/**
 * WeatherRecommender.ts - Actionable weather intelligence for Kaya
 *
 * Takes a WeatherReport and produces clothing + activity recommendations.
 * Uses Inference (fast/Haiku tier) with your city-specific context.
 * Falls back to rule-based recommendations if inference fails.
 *
 * Usage:
 *   import { getRecommendations } from './WeatherRecommender.ts';
 *   const recs = await getRecommendations(weatherReport);
 *
 * CLI:
 *   bun WeatherRecommender.ts --test
 *   bun WeatherRecommender.ts --test --rules-only
 */

import { join } from "path";
import { homedir } from "os";
import type { WeatherReport, CurrentConditions, DayForecast } from "./WeatherService.ts";

// ============================================================================
// Types
// ============================================================================

export interface WeatherRecommendations {
  clothing: string;
  activities: string;
  highlights: string[];
  source: 'inference' | 'rules';
}

// ============================================================================
// Rule-Based Fallback
// ============================================================================

/**
 * Generate rule-based recommendations without inference.
 * This is the fallback if the AI call fails.
 */
export function getRuleBasedRecommendations(report: WeatherReport): WeatherRecommendations {
  const { current, today, forecast } = report;
  const clothing: string[] = [];
  const activities: string[] = [];
  const highlights: string[] = [];

  const morningTemp = today.hourly?.find(h => h.time === '0900')?.tempF ?? current.tempF;
  const afternoonTemp = today.hourly?.find(h => h.time === '1500')?.tempF ?? today.highF;
  const delta = afternoonTemp - morningTemp;

  // --- Clothing Rules ---
  if (morningTemp < 55) {
    clothing.push('Jacket or warm layers this morning');
  } else if (morningTemp < 65) {
    clothing.push('Light layers for the morning');
  }

  if (afternoonTemp >= 75) {
    clothing.push('T-shirt weather by afternoon');
  } else if (afternoonTemp >= 65) {
    clothing.push('Comfortable in a long sleeve or light top');
  }

  if (delta >= 15) {
    clothing.push(`Big temperature swing today -- ${morningTemp}°F this morning to ${afternoonTemp}°F this afternoon. Dress in layers you can shed`);
  }

  // UV awareness
  const uvIndex = today.uvIndex || current.uvIndex;
  if (uvIndex >= 8) {
    clothing.push('UV is very high -- sunscreen, hat, and sunglasses are essential');
  } else if (uvIndex >= 6) {
    clothing.push('UV is elevated -- wear sunscreen if you are outside');
  }

  // Rain in your city is notable
  if (today.rainChancePct >= 50) {
    clothing.push('Rain is likely today -- grab an umbrella');
    highlights.push(`Rain in your city! ${today.rainChancePct}% chance today`);
  } else if (today.rainChancePct >= 20) {
    clothing.push('Slight chance of rain -- maybe keep an umbrella handy');
  }

  // Wind
  if (current.windMph >= 20) {
    clothing.push('Windy conditions -- a windbreaker would help');
  }

  // --- Activity Rules ---
  const isRainy = today.rainChancePct >= 50;
  const isCold = today.highF < 60;
  const isHot = today.highF >= 90;

  if (isRainy) {
    activities.push('Indoor day -- good for a coffee shop, gym, or catching up on reading');
  } else if (isHot) {
    activities.push('Hot day -- beach or pool time. Stay hydrated');
    activities.push('Best outdoor time is early morning or after 4pm');
  } else if (isCold) {
    activities.push('Cooler day for your city -- good for a hike or warm indoor activities');
  } else {
    activities.push('Great day to be outside -- walk, run, or hit the beach');
    if (uvIndex <= 5) {
      activities.push('UV is moderate -- comfortable for extended outdoor time');
    }
  }

  // Weekend vs weekday context
  const dayOfWeek = new Date().getDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  if (isWeekend && !isRainy) {
    activities.push('Weekend vibes -- farmers market, outdoor brunch, or exploring the neighborhood');
  }

  // --- Highlights ---
  // Check for notable changes in forecast
  if (forecast.length >= 2) {
    const tomorrow = forecast[1];
    const tempDrop = today.highF - tomorrow.highF;
    const tempRise = tomorrow.highF - today.highF;

    if (tempDrop >= 10) {
      highlights.push(`Temperature dropping ${tempDrop}°F tomorrow -- ${tomorrow.highF}°F high`);
    } else if (tempRise >= 10) {
      highlights.push(`Warming up ${tempRise}°F tomorrow -- ${tomorrow.highF}°F high`);
    }

    // Rain moving in
    if (tomorrow.rainChancePct >= 40 && today.rainChancePct < 20) {
      highlights.push(`Rain moving in tomorrow -- ${tomorrow.rainChancePct}% chance`);
    }
  }

  if (forecast.length >= 3) {
    const dayAfter = forecast[2];
    if (dayAfter.rainChancePct >= 40 && today.rainChancePct < 20) {
      highlights.push(`Rain possible ${dayAfter.date} -- ${dayAfter.rainChancePct}% chance`);
    }
  }

  // Default fallbacks
  if (clothing.length === 0) {
    clothing.push('Standard your city attire -- light and comfortable');
  }
  if (activities.length === 0) {
    activities.push('Another beautiful your city day -- enjoy it however you like');
  }

  return {
    clothing: clothing.join('. ') + '.',
    activities: activities.join('. ') + '.',
    highlights,
    source: 'rules',
  };
}

// ============================================================================
// Inference-Based Recommendations
// ============================================================================

/**
 * Build the inference prompt for weather recommendations
 */
function buildInferencePrompt(report: WeatherReport): { system: string; user: string } {
  const morningTemp = report.today.hourly?.find(h => h.time === '0900')?.tempF ?? report.current.tempF;
  const afternoonTemp = report.today.hourly?.find(h => h.time === '1500')?.tempF ?? report.today.highF;

  const system = `You are Kaya, a personal AI assistant providing weather recommendations for User who lives in your city. You know your city's climate well:
- Coastal Mediterranean climate, rarely rains (any rain is notable)
- Morning marine layer common (May Gray / June Gloom in late spring)
- Generally mild temperatures year-round
- UV can be high even when it does not feel hot
- User enjoys being outdoors: walks, runs, beach

Your job: Given weather data, produce CONCISE, ACTIONABLE clothing and activity recommendations in a friendly, conversational tone.

Rules:
- Keep clothing recommendation to 1-2 sentences max
- Keep activity recommendation to 1-2 sentences max
- Highlight any notable or unusual conditions for your city
- If there is a big morning-to-afternoon temperature delta (>15°F), mention layers
- If UV >= 6, mention sunscreen
- If any rain chance, definitely call it out (rare in SD)
- Be specific about temperatures, not vague

Respond in this exact JSON format:
{
  "clothing": "Your clothing recommendation here",
  "activities": "Your activity recommendation here",
  "highlights": ["Notable thing 1", "Notable thing 2"]
}`;

  const forecastSummary = report.forecast
    .map(d => `${d.date}: H ${d.highF}°F / L ${d.lowF}°F, ${d.condition}, Rain: ${d.rainChancePct}%`)
    .join('\n');

  const alertSummary = report.alerts.length > 0
    ? report.alerts.map(a => `[${a.severity}] ${a.event}: ${a.headline}`).join('\n')
    : 'None';

  const user = `Current conditions for your city:
- Temperature: ${report.current.tempF}°F (feels like ${report.current.feelsLikeF}°F)
- Condition: ${report.current.condition}
- Humidity: ${report.current.humidity}%
- Wind: ${report.current.windMph} mph ${report.current.windDir}
- UV Index: ${report.current.uvIndex}
- Morning temp (~9am): ${morningTemp}°F
- Afternoon temp (~3pm): ${afternoonTemp}°F

Today's forecast:
- High: ${report.today.highF}°F, Low: ${report.today.lowF}°F
- Condition: ${report.today.condition}
- Rain chance: ${report.today.rainChancePct}%
- UV Index: ${report.today.uvIndex}

3-Day forecast:
${forecastSummary}

Sunrise: ${report.astronomy.sunrise}, Sunset: ${report.astronomy.sunset}
Active alerts: ${alertSummary}

Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long' })}.
Generate clothing and activity recommendations.`;

  return { system, user };
}

/**
 * Get recommendations using inference (fast tier / Haiku)
 */
async function getInferenceRecommendations(report: WeatherReport): Promise<WeatherRecommendations | null> {
  try {
    const { inference } = await import(
      join(homedir(), '.claude', 'skills', 'CORE', 'Tools', 'Inference.ts')
    );

    const { system, user } = buildInferencePrompt(report);

    const result = await inference({
      systemPrompt: system,
      userPrompt: user,
      level: 'fast',
      expectJson: true,
      timeout: 15000,
    });

    if (result.success && result.parsed) {
      const parsed = result.parsed as {
        clothing?: string;
        activities?: string;
        highlights?: string[];
      };

      return {
        clothing: parsed.clothing || 'Check the weather and dress accordingly.',
        activities: parsed.activities || 'Enjoy your day!',
        highlights: parsed.highlights || [],
        source: 'inference',
      };
    }

    console.error('Inference did not return valid JSON:', result.error || 'unknown error');
    return null;
  } catch (error) {
    console.error('Inference failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Get weather recommendations for a WeatherReport.
 *
 * Tries inference first (fast/Haiku), falls back to rule-based if that fails.
 * Set rulesOnly=true to skip inference entirely.
 */
export async function getRecommendations(
  report: WeatherReport,
  options: { rulesOnly?: boolean } = {}
): Promise<WeatherRecommendations> {
  // If rules only, skip inference
  if (options.rulesOnly) {
    return getRuleBasedRecommendations(report);
  }

  // Try inference first
  const inferenceResult = await getInferenceRecommendations(report);
  if (inferenceResult) {
    return inferenceResult;
  }

  // Fallback to rules
  console.log('Falling back to rule-based recommendations');
  return getRuleBasedRecommendations(report);
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
WeatherRecommender - Actionable weather intelligence for Kaya

Usage:
  bun WeatherRecommender.ts --test                 Test with live weather data
  bun WeatherRecommender.ts --test --rules-only    Test rule-based fallback only
  bun WeatherRecommender.ts --test --json           Output as JSON

Options:
  --test              Run a test with live your city weather
  --rules-only        Use only rule-based recommendations (skip inference)
  --json              Output as JSON
  --help, -h          Show this help
`);
    return;
  }

  if (args.includes('--test') || args.includes('-t')) {
    const rulesOnly = args.includes('--rules-only');
    const outputJson = args.includes('--json');

    console.log('Fetching weather data for recommendations...\n');

    try {
      const { fetchWeatherReport } = await import('./WeatherService.ts');
      const report = await fetchWeatherReport('your city');

      console.log(`Current: ${report.current.tempF}°F, ${report.current.condition}`);
      console.log(`Today: H ${report.today.highF}°F / L ${report.today.lowF}°F\n`);

      const recs = await getRecommendations(report, { rulesOnly });

      if (outputJson) {
        console.log(JSON.stringify(recs, null, 2));
        return;
      }

      console.log(`=== Weather Recommendations (${recs.source}) ===\n`);
      console.log(`Clothing: ${recs.clothing}`);
      console.log();
      console.log(`Activities: ${recs.activities}`);
      if (recs.highlights.length > 0) {
        console.log();
        console.log('Highlights:');
        for (const h of recs.highlights) {
          console.log(`  - ${h}`);
        }
      }
    } catch (error) {
      console.error('Test failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  } else {
    console.log('Usage: bun WeatherRecommender.ts --test [--rules-only] [--json]');
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
