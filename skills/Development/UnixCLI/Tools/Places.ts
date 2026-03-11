#!/usr/bin/env bun
/**
 * Google Places CLI - Unix-style interface for location discovery
 *
 * Usage:
 *   kaya-cli places nearby <type>        - Find nearby places by type
 *   kaya-cli places search <query>       - Search places by name/query
 *   kaya-cli places hours <place_id>     - Get opening hours
 *   kaya-cli places details <place_id>   - Get full place details
 *   kaya-cli places types                - List available place types
 */

import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';
import { z } from 'zod';
import { httpClient } from '../../../../lib/core/CachedHTTPClient';
import { createStateManager } from '../../../../lib/core/StateManager';
import { maybeEncode } from '../../../../lib/core/ToonHelper';

const COLORS = {
  red: '\x1b[0;31m',
  green: '\x1b[0;32m',
  yellow: '\x1b[1;33m',
  blue: '\x1b[0;34m',
  cyan: '\x1b[0;36m',
  nc: '\x1b[0m'
};

const SECRETS_PATH = `${homedir()}/.claude/secrets.json`;

const PlacesSecretsSchema = z.object({
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
}).passthrough();

const placesSecretsManager = createStateManager({
  path: SECRETS_PATH,
  schema: PlacesSecretsSchema,
  defaults: {},
});

// Cache the API key after first load
let _cachedApiKey: string | null = null;

async function getApiKeyAsync(): Promise<string> {
  if (_cachedApiKey) return _cachedApiKey;

  if (!(await placesSecretsManager.exists())) {
    console.error(`${COLORS.red}Error:${COLORS.nc} secrets.json not found`);
    console.error(`Add GOOGLE_PLACES_API_KEY to ~/.claude/secrets.json`);
    process.exit(1);
  }

  const secrets = await placesSecretsManager.load();
  const key = secrets.GOOGLE_PLACES_API_KEY || secrets.GOOGLE_API_KEY;

  if (!key) {
    console.error(`${COLORS.red}Error:${COLORS.nc} GOOGLE_PLACES_API_KEY not found in secrets.json`);
    process.exit(1);
  }

  _cachedApiKey = key;
  return key;
}

// Keep sync version for backward compat (reads from cache or falls back to sync read)
function getApiKey(): string {
  if (_cachedApiKey) return _cachedApiKey;

  if (!existsSync(SECRETS_PATH)) {
    console.error(`${COLORS.red}Error:${COLORS.nc} secrets.json not found`);
    console.error(`Add GOOGLE_PLACES_API_KEY to ~/.claude/secrets.json`);
    process.exit(1);
  }

  const secrets = JSON.parse(readFileSync(SECRETS_PATH, 'utf-8'));
  const key = secrets.GOOGLE_PLACES_API_KEY || secrets.GOOGLE_API_KEY;

  if (!key) {
    console.error(`${COLORS.red}Error:${COLORS.nc} GOOGLE_PLACES_API_KEY not found in secrets.json`);
    process.exit(1);
  }

  _cachedApiKey = key;
  return key;
}

// Default location (can be overridden with --location)
async function getDefaultLocation(): Promise<{ lat: number; lng: number }> {
  // Try to get from IP geolocation as fallback
  try {
    const data = await httpClient.fetchJson<{ latitude: number; longitude: number }>(
      'https://ipapi.co/json/',
      { cache: 'memory', ttl: 3600, retry: 1 }
    );
    return { lat: data.latitude, lng: data.longitude };
  } catch {
    // Default to San Francisco
    return { lat: 37.7749, lng: -122.4194 };
  }
}

interface Place {
  place_id: string;
  name: string;
  vicinity?: string;
  formatted_address?: string;
  rating?: number;
  user_ratings_total?: number;
  opening_hours?: {
    open_now?: boolean;
    weekday_text?: string[];
  };
  formatted_phone_number?: string;
  website?: string;
  price_level?: number;
  types?: string[];
  geometry?: {
    location: { lat: number; lng: number };
  };
}

async function nearbySearch(type: string, location: { lat: number; lng: number }, radius = 5000) {
  const apiKey = getApiKey();
  const url = new URL('https://maps.googleapis.com/maps/api/place/nearbysearch/json');
  url.searchParams.set('location', `${location.lat},${location.lng}`);
  url.searchParams.set('radius', radius.toString());
  url.searchParams.set('type', type);
  url.searchParams.set('key', apiKey);

  const data = await httpClient.fetchJson<{ results: Place[]; status: string; error_message?: string }>(
    url.toString(),
    { cache: 'memory', ttl: 300, retry: 2 }
  );

  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(data.error_message || data.status);
  }

  return data.results || [];
}

async function textSearch(query: string, location?: { lat: number; lng: number }) {
  const apiKey = getApiKey();
  const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
  url.searchParams.set('query', query);
  url.searchParams.set('key', apiKey);

  if (location) {
    url.searchParams.set('location', `${location.lat},${location.lng}`);
    url.searchParams.set('radius', '10000');
  }

  const data = await httpClient.fetchJson<{ results: Place[]; status: string; error_message?: string }>(
    url.toString(),
    { cache: 'memory', ttl: 300, retry: 2 }
  );

  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(data.error_message || data.status);
  }

  return data.results || [];
}

async function getPlaceDetails(placeId: string) {
  const apiKey = getApiKey();
  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  url.searchParams.set('place_id', placeId);
  url.searchParams.set('fields', 'name,formatted_address,formatted_phone_number,opening_hours,website,rating,user_ratings_total,price_level,types,reviews,url');
  url.searchParams.set('key', apiKey);

  const data = await httpClient.fetchJson<{ result: Place & { reviews?: any[]; url?: string }; status: string; error_message?: string }>(
    url.toString(),
    { cache: 'memory', ttl: 600, retry: 2 }
  );

  if (data.status !== 'OK') {
    throw new Error(data.error_message || data.status);
  }

  return data.result;
}

const PLACE_TYPES = [
  'restaurant', 'cafe', 'bar', 'bakery', 'meal_takeaway',
  'grocery_or_supermarket', 'convenience_store', 'pharmacy', 'hospital', 'doctor',
  'gym', 'park', 'spa', 'hair_care', 'beauty_salon',
  'gas_station', 'car_repair', 'car_wash', 'parking',
  'bank', 'atm', 'post_office', 'laundry', 'hardware_store',
  'book_store', 'clothing_store', 'electronics_store', 'furniture_store',
  'movie_theater', 'museum', 'library', 'art_gallery', 'zoo',
  'lodging', 'airport', 'train_station', 'bus_station', 'subway_station'
];

function formatRating(rating?: number, total?: number): string {
  if (!rating) return '';
  const stars = '★'.repeat(Math.round(rating)) + '☆'.repeat(5 - Math.round(rating));
  return `${stars} ${rating}${total ? ` (${total})` : ''}`;
}

function formatPrice(level?: number): string {
  if (level === undefined) return '';
  return '$'.repeat(level + 1);
}

function showHelp() {
  console.log(`${COLORS.cyan}kaya-cli places${COLORS.nc} - Google Places CLI

${COLORS.blue}Usage:${COLORS.nc}
  kaya-cli places <command> [options]

${COLORS.blue}Commands:${COLORS.nc}
  ${COLORS.green}nearby${COLORS.nc} <type>             Find nearby places by type
  ${COLORS.green}search${COLORS.nc} <query>           Search places by name/description
  ${COLORS.green}hours${COLORS.nc} <place_id>         Get opening hours for a place
  ${COLORS.green}details${COLORS.nc} <place_id>       Get full details for a place
  ${COLORS.green}types${COLORS.nc}                    List available place types
  ${COLORS.green}help${COLORS.nc}                     Show this help

${COLORS.blue}Options:${COLORS.nc}
  --json                        Output as JSON
  --toon                        Output as TOON (token-efficient format for arrays)
  --location <lat,lng>          Override location (default: auto-detect)
  --radius <meters>             Search radius (default: 5000)
  --limit <n>                   Limit results

${COLORS.blue}Examples:${COLORS.nc}
  kaya-cli places nearby coffee
  kaya-cli places nearby restaurant --radius 1000
  kaya-cli places search "Blue Bottle Coffee"
  kaya-cli places search "thai food" --json
  kaya-cli places hours ChIJ...
  kaya-cli places details ChIJ... --json
  kaya-cli places types

${COLORS.blue}Common Types:${COLORS.nc}
  restaurant, cafe, bar, gym, park, pharmacy,
  gas_station, grocery_or_supermarket, hospital
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    process.exit(0);
  }

  const command = args[0];
  const jsonOutput = args.includes('--json');
  const toonOutput = args.includes('--toon');

  // Parse location override
  const locationIdx = args.indexOf('--location');
  let location: { lat: number; lng: number } | undefined;
  if (locationIdx >= 0 && args[locationIdx + 1]) {
    const [lat, lng] = args[locationIdx + 1].split(',').map(Number);
    location = { lat, lng };
  }

  // Parse radius
  const radiusIdx = args.indexOf('--radius');
  const radius = radiusIdx >= 0 ? parseInt(args[radiusIdx + 1]) : 5000;

  // Parse limit
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : 20;

  // Filter out options from args
  const filteredArgs = args.filter((a, i) => {
    if (a.startsWith('--')) return false;
    if (i > 0 && args[i - 1].startsWith('--')) return false;
    return true;
  });

  try {
    switch (command) {
      case 'nearby': {
        const type = filteredArgs[1];
        if (!type) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Place type required`);
          console.error(`Run 'kaya-cli places types' to see available types`);
          process.exit(1);
        }

        const loc = location || await getDefaultLocation();
        const places = await nearbySearch(type, loc, radius);
        const limited = places.slice(0, limit);

        if (toonOutput) {
          const result = maybeEncode(limited);
          console.log(result.data);
        } else if (jsonOutput) {
          console.log(JSON.stringify(limited, null, 2));
        } else {
          console.log(`${COLORS.cyan}Nearby ${type}:${COLORS.nc}\n`);
          limited.forEach((p, i) => {
            console.log(`${COLORS.green}${i + 1}. ${p.name}${COLORS.nc} ${formatPrice(p.price_level)}`);
            console.log(`   ${formatRating(p.rating, p.user_ratings_total)}`);
            console.log(`   ${p.vicinity || p.formatted_address}`);
            if (p.opening_hours?.open_now !== undefined) {
              const status = p.opening_hours.open_now
                ? `${COLORS.green}Open now${COLORS.nc}`
                : `${COLORS.red}Closed${COLORS.nc}`;
              console.log(`   ${status}`);
            }
            console.log(`   ID: ${p.place_id}\n`);
          });
        }
        break;
      }

      case 'search': {
        const query = filteredArgs.slice(1).join(' ');
        if (!query) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Search query required`);
          process.exit(1);
        }

        const loc = location || await getDefaultLocation();
        const places = await textSearch(query, loc);
        const limited = places.slice(0, limit);

        if (toonOutput) {
          const result = maybeEncode(limited);
          console.log(result.data);
        } else if (jsonOutput) {
          console.log(JSON.stringify(limited, null, 2));
        } else {
          console.log(`${COLORS.cyan}Search results for "${query}":${COLORS.nc}\n`);
          limited.forEach((p, i) => {
            console.log(`${COLORS.green}${i + 1}. ${p.name}${COLORS.nc} ${formatPrice(p.price_level)}`);
            console.log(`   ${formatRating(p.rating, p.user_ratings_total)}`);
            console.log(`   ${p.formatted_address}`);
            if (p.opening_hours?.open_now !== undefined) {
              const status = p.opening_hours.open_now
                ? `${COLORS.green}Open now${COLORS.nc}`
                : `${COLORS.red}Closed${COLORS.nc}`;
              console.log(`   ${status}`);
            }
            console.log(`   ID: ${p.place_id}\n`);
          });
        }
        break;
      }

      case 'hours': {
        const placeId = filteredArgs[1];
        if (!placeId) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Place ID required`);
          process.exit(1);
        }

        const details = await getPlaceDetails(placeId);

        if (jsonOutput) {
          console.log(JSON.stringify(details.opening_hours, null, 2));
        } else {
          console.log(`${COLORS.cyan}${details.name}${COLORS.nc}\n`);
          if (details.opening_hours?.weekday_text) {
            console.log(`${COLORS.blue}Hours:${COLORS.nc}`);
            details.opening_hours.weekday_text.forEach(day => {
              console.log(`  ${day}`);
            });
          } else {
            console.log('Hours not available');
          }
        }
        break;
      }

      case 'details': {
        const placeId = filteredArgs[1];
        if (!placeId) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Place ID required`);
          process.exit(1);
        }

        const details = await getPlaceDetails(placeId) as any;

        if (jsonOutput) {
          console.log(JSON.stringify(details, null, 2));
        } else {
          console.log(`${COLORS.cyan}${details.name}${COLORS.nc} ${formatPrice(details.price_level)}`);
          console.log(`${formatRating(details.rating, details.user_ratings_total)}\n`);

          console.log(`${COLORS.blue}Address:${COLORS.nc} ${details.formatted_address}`);
          if (details.formatted_phone_number) {
            console.log(`${COLORS.blue}Phone:${COLORS.nc} ${details.formatted_phone_number}`);
          }
          if (details.website) {
            console.log(`${COLORS.blue}Website:${COLORS.nc} ${details.website}`);
          }
          if (details.url) {
            console.log(`${COLORS.blue}Maps:${COLORS.nc} ${details.url}`);
          }

          if (details.opening_hours?.weekday_text) {
            console.log(`\n${COLORS.blue}Hours:${COLORS.nc}`);
            details.opening_hours.weekday_text.forEach((day: string) => {
              console.log(`  ${day}`);
            });
          }

          if (details.reviews?.length > 0) {
            console.log(`\n${COLORS.blue}Recent Reviews:${COLORS.nc}`);
            details.reviews.slice(0, 3).forEach((r: any) => {
              console.log(`  ${COLORS.green}${r.author_name}${COLORS.nc} - ${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}`);
              console.log(`  "${r.text?.slice(0, 150)}${r.text?.length > 150 ? '...' : ''}"\n`);
            });
          }
        }
        break;
      }

      case 'types': {
        if (jsonOutput) {
          console.log(JSON.stringify(PLACE_TYPES, null, 2));
        } else {
          console.log(`${COLORS.cyan}Available Place Types:${COLORS.nc}\n`);

          const categories: Record<string, string[]> = {
            'Food & Drink': ['restaurant', 'cafe', 'bar', 'bakery', 'meal_takeaway'],
            'Shopping': ['grocery_or_supermarket', 'convenience_store', 'clothing_store', 'electronics_store', 'book_store', 'furniture_store', 'hardware_store'],
            'Health': ['pharmacy', 'hospital', 'doctor', 'gym', 'spa'],
            'Services': ['bank', 'atm', 'post_office', 'laundry', 'hair_care', 'beauty_salon'],
            'Auto': ['gas_station', 'car_repair', 'car_wash', 'parking'],
            'Entertainment': ['movie_theater', 'museum', 'library', 'art_gallery', 'zoo', 'park'],
            'Travel': ['lodging', 'airport', 'train_station', 'bus_station', 'subway_station']
          };

          Object.entries(categories).forEach(([category, types]) => {
            console.log(`${COLORS.blue}${category}:${COLORS.nc}`);
            console.log(`  ${types.join(', ')}\n`);
          });
        }
        break;
      }

      default:
        console.error(`${COLORS.red}Error:${COLORS.nc} Unknown command: ${command}`);
        console.error(`Run 'kaya-cli places help' for usage`);
        process.exit(1);
    }
  } catch (error: any) {
    console.error(`${COLORS.red}Error:${COLORS.nc} ${error.message}`);
    process.exit(1);
  }
}

main();
