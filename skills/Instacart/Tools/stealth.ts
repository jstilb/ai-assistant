/**
 * Stealth Module - Anti-detection patches and UA pool management
 *
 * Applies manual stealth patches via page.addInitScript() to avoid
 * bot detection. Manages UA pool selection and human-like delays.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const CONFIG_DIR = join(import.meta.dir, '..', 'config');

/**
 * Get a random user agent from the curated pool.
 * Falls back to a default Chrome UA if pool file is missing.
 */
export function getRandomUA(): string {
  try {
    const poolPath = join(CONFIG_DIR, 'ua-pool.json');
    const pool: string[] = JSON.parse(readFileSync(poolPath, 'utf-8'));

    if (pool.length === 0) {
      return getDefaultUA();
    }

    const index = Math.floor(Math.random() * pool.length);
    return pool[index];
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] [WARN] Stealth: Failed to load UA pool, using default.`,
      error instanceof Error ? error.message : String(error)
    );
    return getDefaultUA();
  }
}

function getDefaultUA(): string {
  return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
}

/**
 * Randomized viewport presets to vary the fingerprint.
 */
const VIEWPORT_PRESETS = [
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
];

/**
 * Get a random viewport from presets.
 */
export function getRandomViewport(): { width: number; height: number } {
  const index = Math.floor(Math.random() * VIEWPORT_PRESETS.length);
  return VIEWPORT_PRESETS[index];
}

/**
 * Apply stealth patches to a Playwright page via addInitScript.
 *
 * Patches:
 * 1. Removes navigator.webdriver
 * 2. Spoofs navigator.plugins (non-empty array)
 * 3. Spoofs navigator.languages
 * 4. Overrides chrome.runtime to appear non-automated
 */
export async function applyStealthPatches(
  page: { addInitScript(script: string): Promise<void> }
): Promise<void> {
  await page.addInitScript(`
    // Remove webdriver flag
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });

    // Spoof plugins array (empty array is a bot signal)
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        return [
          {
            0: { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' },
            description: 'Portable Document Format',
            filename: 'internal-pdf-viewer',
            length: 1,
            name: 'Chrome PDF Plugin',
          },
          {
            0: { type: 'application/pdf', suffixes: 'pdf', description: '' },
            description: '',
            filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
            length: 1,
            name: 'Chrome PDF Viewer',
          },
          {
            0: { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' },
            description: 'Native Client',
            filename: 'internal-nacl-plugin',
            length: 2,
            name: 'Native Client',
          },
        ];
      },
    });

    // Spoof languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });

    // Chrome runtime spoofing
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        connect: function() {},
        sendMessage: function() {},
      };
    }

    // Spoof permissions API query
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) => {
        if (parameters.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission });
        }
        return originalQuery(parameters);
      };
    }
  `);
}

/**
 * Generate a random delay between min and max milliseconds.
 * Used for human-like behavior between actions.
 */
export function randomDelay(
  minMs: number = Number(process.env.INSTACART_DELAY_MIN || '1500'),
  maxMs: number = Number(process.env.INSTACART_DELAY_MAX || '3500')
): number {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

/**
 * Wait for a random human-like delay.
 */
export async function humanDelay(
  page: { waitForTimeout(ms: number): Promise<void> }
): Promise<void> {
  const delay = randomDelay();
  await page.waitForTimeout(delay);
}
