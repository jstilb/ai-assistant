#!/usr/bin/env bun
/**
 * Weather.ts
 *
 * Weather CLI via wttr.in (zero dependencies)
 * Usage: kaya-cli weather [location] [options]
 */

import { parseArgs } from 'util';
import { httpClient } from '../../../../lib/core/CachedHTTPClient';

const HELP = `
Weather CLI - Current conditions and forecasts via wttr.in

Usage:
  kaya-cli weather [location] [options]

Arguments:
  location              City name or location (default: auto-detect)

Options:
  --forecast, -f        Show 3-day forecast
  --json, -j            Output as JSON
  --metric, -m          Use metric units (default)
  --imperial, -i        Use imperial units (Fahrenheit)
  --oneline, -1         One-line output
  --quiet, -q           Minimal output (temp only)
  --help, -h            Show this help

Examples:
  kaya-cli weather                          # Current location
  kaya-cli weather "San Francisco"          # Specific city
  kaya-cli weather "New York" --forecast    # 3-day forecast
  kaya-cli weather Tokyo --json             # JSON output
  kaya-cli weather --oneline                # Compact one-liner
  kaya-cli weather London --imperial        # Fahrenheit

Data Source: wttr.in (https://github.com/chubin/wttr.in)
`;

interface WeatherOptions {
  forecast: boolean;
  json: boolean;
  metric: boolean;
  imperial: boolean;
  oneline: boolean;
  quiet: boolean;
  help: boolean;
}

interface CurrentCondition {
  temp_C: string;
  temp_F: string;
  FeelsLikeC: string;
  FeelsLikeF: string;
  humidity: string;
  weatherDesc: Array<{ value: string }>;
  windspeedKmph: string;
  windspeedMiles: string;
  winddirDegree: string;
  winddir16Point: string;
  uvIndex: string;
  visibility: string;
  pressure: string;
  cloudcover: string;
}

interface WeatherForecast {
  date: string;
  maxtempC: string;
  maxtempF: string;
  mintempC: string;
  mintempF: string;
  sunHour: string;
  uvIndex: string;
  hourly: Array<{
    time: string;
    tempC: string;
    tempF: string;
    weatherDesc: Array<{ value: string }>;
    chanceofrain: string;
  }>;
}

interface WttrResponse {
  current_condition: CurrentCondition[];
  weather: WeatherForecast[];
  nearest_area: Array<{
    areaName: Array<{ value: string }>;
    country: Array<{ value: string }>;
    region: Array<{ value: string }>;
  }>;
}

async function fetchWeather(location: string, format: string = 'j1'): Promise<WttrResponse> {
  const encodedLocation = encodeURIComponent(location);
  const url = `https://wttr.in/${encodedLocation}?format=${format}`;

  return httpClient.fetchJson<WttrResponse>(url, {
    cache: 'memory',
    ttl: 600,
    retry: 2,
    headers: { 'User-Agent': 'kaya-cli/1.0 (weather)' },
  });
}

async function fetchWeatherText(location: string, format: string): Promise<string> {
  const encodedLocation = encodeURIComponent(location);
  const url = `https://wttr.in/${encodedLocation}?format=${encodeURIComponent(format)}`;

  return httpClient.fetchText(url, {
    cache: 'memory',
    ttl: 600,
    retry: 2,
    headers: { 'User-Agent': 'kaya-cli/1.0 (weather)' },
  });
}

function formatCurrentConditions(data: WttrResponse, useImperial: boolean): string {
  const current = data.current_condition[0];
  const area = data.nearest_area[0];
  const location = `${area.areaName[0].value}, ${area.country[0].value}`;

  const temp = useImperial ? `${current.temp_F}°F` : `${current.temp_C}°C`;
  const feelsLike = useImperial ? `${current.FeelsLikeF}°F` : `${current.FeelsLikeC}°C`;
  const wind = useImperial
    ? `${current.windspeedMiles} mph ${current.winddir16Point}`
    : `${current.windspeedKmph} km/h ${current.winddir16Point}`;

  const lines = [
    `📍 ${location}`,
    `🌡️  Temperature: ${temp} (feels like ${feelsLike})`,
    `☁️  Conditions: ${current.weatherDesc[0].value}`,
    `💨 Wind: ${wind}`,
    `💧 Humidity: ${current.humidity}%`,
    `👁️  Visibility: ${current.visibility} km`,
    `☀️  UV Index: ${current.uvIndex}`,
  ];

  return lines.join('\n');
}

function formatForecast(data: WttrResponse, useImperial: boolean): string {
  const lines: string[] = [];
  const area = data.nearest_area[0];
  const location = `${area.areaName[0].value}, ${area.country[0].value}`;

  lines.push(`📍 ${location} - 3-Day Forecast`);
  lines.push('');

  for (const day of data.weather) {
    const date = new Date(day.date);
    const dayName = date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

    const high = useImperial ? `${day.maxtempF}°F` : `${day.maxtempC}°C`;
    const low = useImperial ? `${day.mintempF}°F` : `${day.mintempC}°C`;

    // Get noon conditions for representative weather
    const noonHour = day.hourly.find(h => h.time === '1200') || day.hourly[4];
    const conditions = noonHour?.weatherDesc[0].value || 'Unknown';
    const rainChance = noonHour?.chanceofrain || '0';

    lines.push(`📅 ${dayName}`);
    lines.push(`   High: ${high} / Low: ${low}`);
    lines.push(`   ${conditions}`);
    if (parseInt(rainChance) > 20) {
      lines.push(`   🌧️  ${rainChance}% chance of rain`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      forecast: { type: 'boolean', short: 'f', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      metric: { type: 'boolean', short: 'm', default: true },
      imperial: { type: 'boolean', short: 'i', default: false },
      oneline: { type: 'boolean', short: '1', default: false },
      quiet: { type: 'boolean', short: 'q', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  const opts: WeatherOptions = {
    forecast: values.forecast as boolean,
    json: values.json as boolean,
    metric: values.metric as boolean,
    imperial: values.imperial as boolean,
    oneline: values.oneline as boolean,
    quiet: values.quiet as boolean,
    help: values.help as boolean,
  };

  if (opts.help) {
    console.log(HELP);
    process.exit(0);
  }

  // Location is any positional argument (may include spaces if quoted)
  const location = positionals.join(' ') || '';

  try {
    // One-line format
    if (opts.oneline) {
      const format = opts.imperial ? '%l:+%t+%C+%w' : '%l:+%t+%C+%w';
      const result = await fetchWeatherText(location, format);
      console.log(result.trim());
      return;
    }

    // Quiet format (temp only)
    if (opts.quiet) {
      const format = opts.imperial ? '%t' : '%t';
      const result = await fetchWeatherText(location, format);
      console.log(result.trim());
      return;
    }

    // Fetch full data
    const data = await fetchWeather(location);

    // JSON output
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    // Formatted output
    const useImperial = opts.imperial;

    if (opts.forecast) {
      console.log(formatForecast(data, useImperial));
    } else {
      console.log(formatCurrentConditions(data, useImperial));
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
