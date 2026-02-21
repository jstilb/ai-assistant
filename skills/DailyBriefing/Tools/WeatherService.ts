#!/usr/bin/env bun
/**
 * WeatherService.ts - Rich weather data layer for Kaya
 *
 * Wraps wttr.in JSON API and NWS alerts API to produce a unified WeatherReport
 * with current conditions, hourly breakdown, 3-day forecast, alerts, and astronomy.
 *
 * Usage:
 *   import { fetchWeatherReport } from './WeatherService.ts';
 *   const report = await fetchWeatherReport('your city');
 *
 * CLI:
 *   bun WeatherService.ts --test
 *   bun WeatherService.ts --test --location "Los Angeles, CA"
 *   bun WeatherService.ts --test --json
 */

import { join } from "path";
import { homedir } from "os";

// Use Kaya CachedHTTPClient for all external API calls
const CORE_TOOLS = join(homedir(), ".claude", "skills", "CORE", "Tools");
const { httpClient } = await import(join(CORE_TOOLS, "CachedHTTPClient.ts"));

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface CurrentConditions {
  tempF: number;
  feelsLikeF: number;
  humidity: number;
  windMph: number;
  windDir: string;
  uvIndex: number;
  condition: string;
  icon: string;
}

export interface HourlyForecast {
  time: string;       // "0900", "1200", etc.
  tempF: number;
  feelsLikeF: number;
  condition: string;
  rainChancePct: number;
  windMph: number;
  icon: string;
}

export interface DayForecast {
  date: string;        // "2026-02-04"
  highF: number;
  lowF: number;
  condition: string;
  rainChancePct: number;
  uvIndex: number;
  icon: string;
  hourly?: HourlyForecast[];
}

export interface WeatherAlert {
  event: string;
  severity: 'minor' | 'moderate' | 'severe' | 'extreme';
  headline: string;
  description: string;
  expires: string;
}

export interface WeatherReport {
  current: CurrentConditions;
  today: DayForecast;
  forecast: DayForecast[];
  alerts: WeatherAlert[];
  astronomy: { sunrise: string; sunset: string };
  location: string;
  fetchedAt: string;
}

// ============================================================================
// Condition to Emoji Mapping
// ============================================================================

const CONDITION_EMOJI: Record<string, string> = {
  'Sunny': '☀️',
  'Clear': '🌙',
  'Partly cloudy': '⛅',
  'Partly Cloudy': '⛅',
  'Cloudy': '☁️',
  'Overcast': '☁️',
  'Mist': '🌫️',
  'Fog': '🌫️',
  'Patchy rain possible': '🌦️',
  'Patchy rain nearby': '🌦️',
  'Light rain': '🌧️',
  'Light rain shower': '🌧️',
  'Moderate rain': '🌧️',
  'Heavy rain': '🌧️',
  'Light drizzle': '🌧️',
  'Patchy light drizzle': '🌧️',
  'Thundery outbreaks possible': '⛈️',
  'Moderate or heavy rain with thunder': '⛈️',
  'Patchy light rain with thunder': '⛈️',
  'Snow': '❄️',
  'Light snow': '❄️',
  'Heavy snow': '❄️',
  'Blowing snow': '❄️',
  'Blizzard': '🌨️',
  'Moderate or heavy snow showers': '🌨️',
  'Haze': '🌫️',
};

function getConditionEmoji(condition: string): string {
  if (CONDITION_EMOJI[condition]) return CONDITION_EMOJI[condition];

  // Fuzzy match
  const lower = condition.toLowerCase();
  if (lower.includes('sun') || lower.includes('clear')) return '☀️';
  if (lower.includes('cloud') || lower.includes('overcast')) return '☁️';
  if (lower.includes('rain') || lower.includes('drizzle')) return '🌧️';
  if (lower.includes('thunder') || lower.includes('storm')) return '⛈️';
  if (lower.includes('snow') || lower.includes('sleet')) return '❄️';
  if (lower.includes('fog') || lower.includes('mist') || lower.includes('haze')) return '🌫️';
  if (lower.includes('wind')) return '💨';

  return '🌤️';
}

// ============================================================================
// wttr.in API Types (partial, for what we use)
// ============================================================================

interface WttrCurrentCondition {
  temp_F: string;
  FeelsLikeF: string;
  humidity: string;
  windspeedMiles: string;
  winddir16Point: string;
  uvIndex: string;
  weatherDesc: Array<{ value: string }>;
}

interface WttrHourly {
  time: string;
  tempF: string;
  FeelsLikeF: string;
  weatherDesc: Array<{ value: string }>;
  chanceofrain: string;
  windspeedMiles: string;
  uvIndex: string;
}

interface WttrAstronomy {
  sunrise: string;
  sunset: string;
}

interface WttrWeatherDay {
  date: string;
  maxtempF: string;
  mintempF: string;
  uvIndex: string;
  hourly: WttrHourly[];
  astronomy: WttrAstronomy[];
}

interface WttrResponse {
  current_condition: WttrCurrentCondition[];
  weather: WttrWeatherDay[];
}

// ============================================================================
// NWS Alert API Types
// ============================================================================

interface NWSAlertFeature {
  properties: {
    event: string;
    severity: string;
    headline: string;
    description: string;
    expires: string;
  };
}

interface NWSAlertResponse {
  features: NWSAlertFeature[];
}

// ============================================================================
// WeatherService Implementation
// ============================================================================

const KAYA_HOME = process.env.KAYA_DIR || join(homedir(), '.claude');
const DEFAULT_LOCATION = 'your city';
const NWS_ZONE_SD = 'CAZ043';
const WTTR_TIMEOUT_MS = 12000;
const NWS_TIMEOUT_MS = 5000;

/**
 * Fetch weather data from wttr.in JSON API
 */
async function fetchWttrData(location: string): Promise<WttrResponse> {
  const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
  const response = await httpClient.fetch(url, {
    timeout: WTTR_TIMEOUT_MS,
    headers: { 'User-Agent': 'Kaya-WeatherService/1.0' },
    cache: 'memory',
    ttl: 900,  // 15 min cache for weather data
  });

  if (!response.ok) {
    throw new Error(`wttr.in returned HTTP ${response.status}`);
  }

  return response.json() as Promise<WttrResponse>;
}

/**
 * Fetch NWS alerts for your city zone
 */
async function fetchNWSAlerts(zone: string = NWS_ZONE_SD): Promise<WeatherAlert[]> {
  try {
    const url = `https://api.weather.gov/alerts/active?zone=${zone}`;
    const response = await httpClient.fetch(url, {
      timeout: NWS_TIMEOUT_MS,
      headers: {
        'User-Agent': 'Kaya-WeatherService/1.0 (contact@kaya.local)',
        'Accept': 'application/geo+json',
      },
      cache: 'memory',
      ttl: 300,  // 5 min cache for alerts
    });

    if (!response.ok) {
      console.error(`NWS API returned HTTP ${response.status}`);
      return [];
    }

    const data = await response.json() as NWSAlertResponse;

    if (!data.features || data.features.length === 0) {
      return [];
    }

    return data.features.map((feature) => {
      const props = feature.properties;
      const severityMap: Record<string, WeatherAlert['severity']> = {
        'Minor': 'minor',
        'Moderate': 'moderate',
        'Severe': 'severe',
        'Extreme': 'extreme',
      };

      return {
        event: props.event || 'Unknown',
        severity: severityMap[props.severity] || 'minor',
        headline: props.headline || '',
        description: (props.description || '').slice(0, 500),
        expires: props.expires || '',
      };
    });
  } catch (error) {
    // NWS is a nice-to-have; fail gracefully
    console.error('NWS alert fetch failed:', error instanceof Error ? error.message : error);
    return [];
  }
}

/**
 * Parse wttr.in hourly data into HourlyForecast array
 */
function parseHourly(wttrHourly: WttrHourly[]): HourlyForecast[] {
  return wttrHourly.map((h) => {
    const condition = h.weatherDesc?.[0]?.value || 'Unknown';
    return {
      time: h.time.padStart(4, '0'),
      tempF: parseInt(h.tempF, 10),
      feelsLikeF: parseInt(h.FeelsLikeF, 10),
      condition,
      rainChancePct: parseInt(h.chanceofrain, 10) || 0,
      windMph: parseInt(h.windspeedMiles, 10) || 0,
      icon: getConditionEmoji(condition),
    };
  });
}

/**
 * Parse wttr.in day data into DayForecast
 */
function parseDayForecast(wttrDay: WttrWeatherDay, includeHourly: boolean = false): DayForecast {
  // Determine dominant condition from hourly data
  const conditions = wttrDay.hourly.map((h) => h.weatherDesc?.[0]?.value || 'Unknown');
  const conditionCounts: Record<string, number> = {};
  for (const c of conditions) {
    conditionCounts[c] = (conditionCounts[c] || 0) + 1;
  }
  const dominantCondition = Object.entries(conditionCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || 'Unknown';

  // Calculate max rain chance across all hours
  const maxRainChance = Math.max(
    ...wttrDay.hourly.map((h) => parseInt(h.chanceofrain, 10) || 0)
  );

  const forecast: DayForecast = {
    date: wttrDay.date,
    highF: parseInt(wttrDay.maxtempF, 10),
    lowF: parseInt(wttrDay.mintempF, 10),
    condition: dominantCondition,
    rainChancePct: maxRainChance,
    uvIndex: parseInt(wttrDay.uvIndex, 10) || 0,
    icon: getConditionEmoji(dominantCondition),
  };

  if (includeHourly) {
    forecast.hourly = parseHourly(wttrDay.hourly);
  }

  return forecast;
}

/**
 * Fetch a complete WeatherReport for a given location
 *
 * Combines wttr.in (current + forecast) with NWS alerts.
 * Gracefully degrades: if NWS fails, alerts are empty.
 */
export async function fetchWeatherReport(
  location: string = DEFAULT_LOCATION
): Promise<WeatherReport> {
  // Fetch wttr.in and NWS alerts in parallel
  const [wttrData, alerts] = await Promise.all([
    fetchWttrData(location),
    fetchNWSAlerts(),
  ]);

  const current = wttrData.current_condition[0];
  const todayWeather = wttrData.weather[0];
  const condition = current.weatherDesc?.[0]?.value || 'Unknown';

  // Build current conditions
  const currentConditions: CurrentConditions = {
    tempF: parseInt(current.temp_F, 10),
    feelsLikeF: parseInt(current.FeelsLikeF, 10),
    humidity: parseInt(current.humidity, 10),
    windMph: parseInt(current.windspeedMiles, 10),
    windDir: current.winddir16Point || 'N',
    uvIndex: parseInt(current.uvIndex, 10) || 0,
    condition,
    icon: getConditionEmoji(condition),
  };

  // Build today's forecast (with hourly)
  const today = parseDayForecast(todayWeather, true);

  // Build 3-day forecast
  const forecast = wttrData.weather.map((day) => parseDayForecast(day, false));

  // Extract astronomy data
  const astro = todayWeather.astronomy?.[0];
  const astronomy = {
    sunrise: astro?.sunrise || 'N/A',
    sunset: astro?.sunset || 'N/A',
  };

  return {
    current: currentConditions,
    today,
    forecast,
    alerts,
    astronomy,
    location,
    fetchedAt: new Date().toISOString(),
  };
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
WeatherService - Rich weather data layer for Kaya

Usage:
  bun WeatherService.ts --test                     Test with your city
  bun WeatherService.ts --test --location "NYC"    Test with custom location
  bun WeatherService.ts --test --json              Output raw JSON

Options:
  --test              Run a test fetch
  --location <loc>    Override location (default: your city)
  --json              Output as JSON instead of formatted
  --help, -h          Show this help
`);
    return;
  }

  if (args.includes('--test') || args.includes('-t')) {
    const locIdx = args.indexOf('--location');
    const location = locIdx !== -1 && args[locIdx + 1]
      ? args[locIdx + 1]
      : DEFAULT_LOCATION;

    const outputJson = args.includes('--json');

    console.log(`Fetching weather for: ${location}...\n`);

    try {
      const report = await fetchWeatherReport(location);

      if (outputJson) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      // Formatted output
      console.log('=== WeatherService Test ===\n');
      console.log(`Location: ${report.location}`);
      console.log(`Fetched:  ${report.fetchedAt}`);
      console.log();

      console.log('--- Current Conditions ---');
      console.log(`  ${report.current.icon} ${report.current.condition}`);
      console.log(`  Temperature: ${report.current.tempF}°F (feels like ${report.current.feelsLikeF}°F)`);
      console.log(`  Humidity: ${report.current.humidity}%`);
      console.log(`  Wind: ${report.current.windMph} mph ${report.current.windDir}`);
      console.log(`  UV Index: ${report.current.uvIndex}`);
      console.log();

      console.log('--- Today\'s Forecast ---');
      console.log(`  High: ${report.today.highF}°F  Low: ${report.today.lowF}°F`);
      console.log(`  Condition: ${report.today.icon} ${report.today.condition}`);
      console.log(`  Rain Chance: ${report.today.rainChancePct}%`);
      console.log(`  UV Index: ${report.today.uvIndex}`);
      if (report.today.hourly) {
        console.log(`  Hourly (${report.today.hourly.length} entries):`);
        for (const h of report.today.hourly.filter((_h, i) => i % 3 === 0)) {
          console.log(`    ${h.time}: ${h.tempF}°F ${h.icon} ${h.condition} (rain: ${h.rainChancePct}%)`);
        }
      }
      console.log();

      console.log('--- 3-Day Forecast ---');
      for (const day of report.forecast) {
        console.log(`  ${day.date}: ${day.icon} H ${day.highF}°F / L ${day.lowF}°F  ${day.condition}  Rain: ${day.rainChancePct}%`);
      }
      console.log();

      console.log('--- Astronomy ---');
      console.log(`  Sunrise: ${report.astronomy.sunrise}`);
      console.log(`  Sunset:  ${report.astronomy.sunset}`);
      console.log();

      if (report.alerts.length > 0) {
        console.log('--- Weather Alerts ---');
        for (const alert of report.alerts) {
          console.log(`  [${alert.severity.toUpperCase()}] ${alert.event}`);
          console.log(`    ${alert.headline}`);
          console.log(`    Expires: ${alert.expires}`);
        }
      } else {
        console.log('--- No Active Weather Alerts ---');
      }

    } catch (error) {
      console.error('WeatherService test failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  } else {
    console.log('Usage: bun WeatherService.ts --test [--location "City"] [--json]');
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
