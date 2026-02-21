#!/usr/bin/env bun
/**
 * ============================================================================
 * ConfigLoader - Unified Configuration Loader with SYSTEM/USER Tiering
 * ============================================================================
 *
 * PURPOSE:
 * Standardizes configuration loading across Kaya skills with proper tiering:
 *   USER config (highest priority) -> SYSTEM config -> Defaults (lowest priority)
 *
 * FEATURES:
 * - SYSTEM -> USER -> Defaults tiering
 * - Zod schema validation
 * - Environment variable fallbacks (KAYA_* prefix)
 * - Caching with configurable TTL
 * - Hot reload via file watching
 * - Full TypeScript type inference from schema
 * - Support for both JSON and YAML config files
 *
 * USAGE:
 *   // Simple settings load
 *   import { loadSettings } from './ConfigLoader';
 *   const settings = loadSettings();
 *
 *   // Tiered config with schema
 *   import { loadTieredConfig } from './ConfigLoader';
 *   import { z } from 'zod';
 *
 *   const BrowserSchema = z.object({
 *     browser: z.string(),
 *     headless: z.boolean(),
 *   });
 *
 *   const config = loadTieredConfig('browser', BrowserSchema, {
 *     browser: 'Chrome',
 *     headless: true,
 *   });
 *
 *   // Factory for repeated use with watching
 *   import { createConfigLoader } from './ConfigLoader';
 *
 *   const loader = createConfigLoader({
 *     key: 'browser',
 *     schema: BrowserSchema,
 *     defaults: { browser: 'Chrome', headless: true },
 *     watchChanges: true,
 *   });
 *
 *   loader.watch((config, changed) => {
 *     console.log('Config changed:', changed);
 *   });
 *
 * CLI:
 *   bun run ConfigLoader.ts --key settings --validate
 *   bun run ConfigLoader.ts --key browser --schema browser
 *   bun run ConfigLoader.ts --list
 *
 * TIERING:
 *   1. USER:    ~/.claude/skills/CORE/USER/config/{key}.{json,yaml}
 *   2. SYSTEM:  ~/.claude/skills/CORE/SYSTEM/config/{key}.{json,yaml}
 *   3. Defaults: Provided programmatically
 *
 * ============================================================================
 */

import { existsSync, readFileSync, watch as fsWatch, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';
import { z, type ZodSchema, type ZodTypeDef } from 'zod';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Options for creating a config loader factory
 */
export interface ConfigLoaderOptions<T> {
  /** Config key, e.g., "agents", "browser", "voice" */
  key: string;
  /** Zod schema for validation */
  schema: ZodSchema<T, ZodTypeDef, unknown>;
  /** Default values when no config found */
  defaults: T;
  /** Environment variable prefix, e.g., "KAYA" -> KAYA_VOICE_ID */
  envPrefix?: string;
  /** Cache TTL in milliseconds (0 = no expiry) */
  cacheTtlMs?: number;
  /** Enable file watching for hot reload */
  watchChanges?: boolean;
}

/**
 * Config loader instance with caching and watching
 */
export interface ConfigLoader<T> {
  /** Load config (uses cache if available) */
  load(): T;
  /** Load config asynchronously */
  loadAsync(): Promise<T>;
  /** Force reload from disk, bypassing cache */
  reload(): T;
  /** Get a specific config key */
  get<K extends keyof T>(key: K): T[K];
  /** Watch for config changes */
  watch(callback: (config: T, changedKeys: (keyof T)[]) => void): () => void;
  /** Get the path of the loaded config file (null if using defaults) */
  getPath(): string | null;
}

/**
 * Settings.json structure
 */
export interface Settings {
  daidentity?: {
    name?: string;
    fullName?: string;
    displayName?: string;
    voiceId?: string;
    color?: string;
    voice?: {
      stability?: number;
      similarity_boost?: number;
      style?: number;
      speed?: number;
      use_speaker_boost?: boolean;
      volume?: number;
    };
    startupCatchphrase?: string;
  };
  principal?: {
    name?: string;
    timezone?: string;
  };
  env?: Record<string, string>;
  techStack?: {
    terminal?: string;
    packageManager?: string;
    pythonPackageManager?: string;
    language?: string;
    browser?: string;
  };
  pai?: {
    repoUrl?: string;
    version?: string;
  };
  [key: string]: unknown;
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors?: z.ZodError;
  data?: unknown;
}

/**
 * Options for loadTieredConfig
 */
export interface TieredConfigOptions {
  /** Environment variable prefix */
  envPrefix?: string;
}

// ============================================================================
// INTERNAL STATE
// ============================================================================

// Test mode path override
let testPaiDir: string | null = null;

// Cache for settings.json
let settingsCache: Settings | null = null;
let settingsCacheTime: number = 0;

// Cache for tiered configs
const configCache = new Map<string, { data: unknown; time: number; path: string | null }>();

// Default cache TTL (5 minutes)
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

// ============================================================================
// PATH UTILITIES
// ============================================================================

/**
 * Get the Kaya directory
 */
function getKayaDir(): string {
  if (testPaiDir) return testPaiDir;
  return process.env.KAYA_DIR || join(homedir(), '.claude');
}

/**
 * Get the settings.json path
 */
function getSettingsPath(): string {
  return join(getKayaDir(), 'settings.json');
}

/**
 * Get the SYSTEM config directory
 */
function getSystemConfigDir(): string {
  return join(getKayaDir(), 'skills', 'CORE', 'SYSTEM', 'config');
}

/**
 * Get the USER config directory
 */
function getUserConfigDir(): string {
  return join(getKayaDir(), 'skills', 'CORE', 'USER', 'config');
}

// ============================================================================
// FILE UTILITIES
// ============================================================================

/**
 * Try to find a config file with various extensions
 */
function findConfigFile(dir: string, key: string): string | null {
  const extensions = ['.json', '.yaml', '.yml'];

  for (const ext of extensions) {
    const path = join(dir, `${key}${ext}`);
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

/**
 * Read and parse a config file (JSON or YAML)
 */
function readConfigFile(path: string): unknown {
  const content = readFileSync(path, 'utf-8');

  if (path.endsWith('.yaml') || path.endsWith('.yml')) {
    return parseYaml(content);
  }

  return JSON.parse(content);
}

/**
 * Get file modification time
 */
function getFileModTime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

// ============================================================================
// ENVIRONMENT VARIABLE UTILITIES
// ============================================================================

/**
 * Convert camelCase to SCREAMING_SNAKE_CASE
 */
function toScreamingSnake(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[.-]/g, '_')
    .toUpperCase();
}

/**
 * Get config value from environment variable
 */
function getEnvValue(key: string, prefix: string): string | undefined {
  const envKey = `${prefix}_${toScreamingSnake(key)}`;
  return process.env[envKey];
}

/**
 * Apply environment variable overrides to config
 */
function applyEnvOverrides<T extends Record<string, unknown>>(
  config: T,
  prefix: string
): T {
  const result = { ...config };

  for (const key of Object.keys(config)) {
    const envValue = getEnvValue(key, prefix);
    if (envValue !== undefined) {
      // Parse the value based on the current type
      const currentValue = config[key];

      if (typeof currentValue === 'boolean') {
        (result as Record<string, unknown>)[key] = envValue.toLowerCase() === 'true';
      } else if (typeof currentValue === 'number') {
        const parsed = parseFloat(envValue);
        if (!isNaN(parsed)) {
          (result as Record<string, unknown>)[key] = parsed;
        }
      } else if (Array.isArray(currentValue)) {
        // Try to parse as JSON array, fallback to comma-separated
        try {
          (result as Record<string, unknown>)[key] = JSON.parse(envValue);
        } catch {
          (result as Record<string, unknown>)[key] = envValue.split(',').map(s => s.trim());
        }
      } else {
        (result as Record<string, unknown>)[key] = envValue;
      }
    }
  }

  return result;
}

// ============================================================================
// CORE FUNCTIONS
// ============================================================================

/**
 * Load settings.json (cached)
 */
export function loadSettings(): Settings {
  const settingsPath = getSettingsPath();

  // Check cache validity
  if (settingsCache) {
    const fileModTime = getFileModTime(settingsPath);
    if (fileModTime <= settingsCacheTime) {
      return settingsCache;
    }
  }

  try {
    if (!existsSync(settingsPath)) {
      settingsCache = {};
      settingsCacheTime = Date.now();
      return settingsCache;
    }

    const content = readFileSync(settingsPath, 'utf-8');
    settingsCache = JSON.parse(content);
    settingsCacheTime = Date.now();
    return settingsCache!;
  } catch (error) {
    console.error('ConfigLoader: Failed to load settings.json:', error);
    settingsCache = {};
    settingsCacheTime = Date.now();
    return settingsCache;
  }
}

/**
 * Load a tiered configuration with schema validation
 *
 * Priority: USER -> SYSTEM -> env vars -> defaults
 */
export function loadTieredConfig<T>(
  key: string,
  schema: ZodSchema<T, ZodTypeDef, unknown>,
  defaults: T,
  options?: TieredConfigOptions
): T {
  const cacheKey = `tiered:${key}`;
  const cached = configCache.get(cacheKey);

  // Check USER config
  const userDir = getUserConfigDir();
  const userPath = findConfigFile(userDir, key);
  const userModTime = userPath ? getFileModTime(userPath) : 0;

  // Check SYSTEM config
  const systemDir = getSystemConfigDir();
  const systemPath = findConfigFile(systemDir, key);
  const systemModTime = systemPath ? getFileModTime(systemPath) : 0;

  // Check cache validity
  if (cached) {
    const cachedPath = cached.path;
    const cachedModTime = cachedPath ? getFileModTime(cachedPath) : 0;

    // If the file we loaded from hasn't changed, use cache
    if (cachedPath && cachedModTime <= cached.time) {
      return cached.data as T;
    }
    // If we were using defaults and no files exist now, use cache
    if (!cachedPath && !userPath && !systemPath) {
      return cached.data as T;
    }
  }

  let config: T = defaults;
  let loadedPath: string | null = null;

  // Try USER config first (highest priority)
  if (userPath) {
    try {
      const fileData = readConfigFile(userPath);
      const parsed = schema.safeParse(fileData);
      if (parsed.success) {
        config = parsed.data;
        loadedPath = userPath;
      } else {
        console.warn(`ConfigLoader: Validation failed for ${userPath}, using fallback`);
      }
    } catch (error) {
      console.warn(`ConfigLoader: Failed to read ${userPath}:`, error);
    }
  }

  // If no USER config, try SYSTEM config
  if (!loadedPath && systemPath) {
    try {
      const fileData = readConfigFile(systemPath);
      const parsed = schema.safeParse(fileData);
      if (parsed.success) {
        config = parsed.data;
        loadedPath = systemPath;
      } else {
        console.warn(`ConfigLoader: Validation failed for ${systemPath}, using fallback`);
      }
    } catch (error) {
      console.warn(`ConfigLoader: Failed to read ${systemPath}:`, error);
    }
  }

  // Apply environment variable overrides (only if using defaults or env is higher priority)
  if (!loadedPath && options?.envPrefix) {
    config = applyEnvOverrides(config as Record<string, unknown>, options.envPrefix) as T;
  }

  // Cache the result
  configCache.set(cacheKey, {
    data: config,
    time: Date.now(),
    path: loadedPath,
  });

  return config;
}

/**
 * Create a reusable config loader factory
 */
export function createConfigLoader<T>(
  options: ConfigLoaderOptions<T>
): ConfigLoader<T> {
  const { key, schema, defaults, envPrefix, cacheTtlMs = DEFAULT_CACHE_TTL_MS, watchChanges } = options;

  let cachedConfig: T | null = null;
  let cacheTime: number = 0;
  let loadedPath: string | null = null;
  let watchers: Array<(config: T, changedKeys: (keyof T)[]) => void> = [];
  let fsWatcher: ReturnType<typeof fsWatch> | null = null;

  const cacheKey = `tiered:${key}`;

  /**
   * Check if cache is valid
   */
  function isCacheValid(): boolean {
    if (!cachedConfig) return false;
    if (cacheTtlMs === 0) return true; // No expiry

    return Date.now() - cacheTime < cacheTtlMs;
  }

  /**
   * Load configuration
   */
  function load(): T {
    if (isCacheValid() && cachedConfig !== null) {
      return cachedConfig;
    }

    return reload();
  }

  /**
   * Reload configuration from disk
   */
  function reload(): T {
    // Clear the global cache for this key to force a fresh read
    configCache.delete(cacheKey);

    const config = loadTieredConfig(key, schema, defaults, { envPrefix });

    // Get the path that was loaded
    const cacheEntry = configCache.get(cacheKey);
    loadedPath = cacheEntry?.path ?? null;

    // Detect changes for watchers
    if (cachedConfig && watchers.length > 0) {
      const changedKeys = findChangedKeys(cachedConfig, config);
      if (changedKeys.length > 0) {
        for (const callback of watchers) {
          try {
            callback(config, changedKeys);
          } catch (error) {
            console.error('ConfigLoader: Watcher callback error:', error);
          }
        }
      }
    }

    cachedConfig = config;
    cacheTime = Date.now();

    return config;
  }

  /**
   * Find keys that changed between two configs
   */
  function findChangedKeys(oldConfig: T, newConfig: T): (keyof T)[] {
    const keys = new Set([
      ...Object.keys(oldConfig as object),
      ...Object.keys(newConfig as object),
    ]) as Set<keyof T>;

    const changed: (keyof T)[] = [];
    for (const key of keys) {
      if (JSON.stringify(oldConfig[key]) !== JSON.stringify(newConfig[key])) {
        changed.push(key);
      }
    }
    return changed;
  }

  /**
   * Get a specific config key
   */
  function get<K extends keyof T>(configKey: K): T[K] {
    return load()[configKey];
  }

  /**
   * Watch for config changes
   */
  function watch(callback: (config: T, changedKeys: (keyof T)[]) => void): () => void {
    watchers.push(callback);

    // Set up file watcher if enabled and not already watching
    if (watchChanges && !fsWatcher && loadedPath) {
      try {
        fsWatcher = fsWatch(loadedPath, (eventType) => {
          if (eventType === 'change') {
            reload();
          }
        });
      } catch (error) {
        console.warn('ConfigLoader: Failed to set up file watcher:', error);
      }
    }

    // Return unsubscribe function
    return () => {
      watchers = watchers.filter(w => w !== callback);
      if (watchers.length === 0 && fsWatcher) {
        fsWatcher.close();
        fsWatcher = null;
      }
    };
  }

  /**
   * Get the path of the loaded config file
   */
  function getPath(): string | null {
    return loadedPath;
  }

  /**
   * Load asynchronously
   */
  async function loadAsync(): Promise<T> {
    return load();
  }

  return {
    load,
    loadAsync,
    reload,
    get,
    watch,
    getPath,
  };
}

/**
 * Validate a config file against a schema
 */
export function validateConfigFile<T>(
  path: string,
  schema: ZodSchema<T, ZodTypeDef, unknown>
): ValidationResult {
  try {
    if (!existsSync(path)) {
      return { valid: false, errors: undefined };
    }

    const data = readConfigFile(path);
    const result = schema.safeParse(data);

    if (result.success) {
      return { valid: true, data: result.data };
    } else {
      return { valid: false, errors: result.error };
    }
  } catch (error) {
    return {
      valid: false,
      errors: new z.ZodError([
        {
          code: 'custom',
          path: [],
          message: `Failed to read file: ${error}`,
        },
      ]),
    };
  }
}

/**
 * Clear all caches
 */
export function clearAllCaches(): void {
  settingsCache = null;
  settingsCacheTime = 0;
  configCache.clear();
}

/**
 * Set test paths (for testing only)
 * @internal
 */
export function _setTestPaths(kayaDir: string | null): void {
  testPaiDir = kayaDir;
  clearAllCaches();
}

// ============================================================================
// CLI INTERFACE
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
ConfigLoader - Unified configuration loader with SYSTEM/USER tiering

Usage:
  bun run ConfigLoader.ts --key <key>              Load and display config
  bun run ConfigLoader.ts --key <key> --validate   Validate config against schema
  bun run ConfigLoader.ts --settings               Load settings.json
  bun run ConfigLoader.ts --list                   List available configs
  bun run ConfigLoader.ts --paths                  Show config paths

Options:
  --key <key>     Config key to load (e.g., browser, agents, voice)
  --validate      Validate config against built-in schema
  --json          Output as JSON (default)
  --yaml          Output as YAML
  --settings      Load settings.json
  --list          List available config files
  --paths         Show USER and SYSTEM config paths

Examples:
  bun run ConfigLoader.ts --settings
  bun run ConfigLoader.ts --key browser
  bun run ConfigLoader.ts --key browser --validate
  bun run ConfigLoader.ts --list
`);
    process.exit(0);
  }

  // --settings mode
  if (args.includes('--settings')) {
    const settings = loadSettings();
    console.log(JSON.stringify(settings, null, 2));
    process.exit(0);
  }

  // --paths mode
  if (args.includes('--paths')) {
    console.log('Kaya Directory:', getKayaDir());
    console.log('Settings Path:', getSettingsPath());
    console.log('SYSTEM Config:', getSystemConfigDir());
    console.log('USER Config:  ', getUserConfigDir());
    process.exit(0);
  }

  // --list mode
  if (args.includes('--list')) {
    const systemDir = getSystemConfigDir();
    const userDir = getUserConfigDir();

    console.log('Available configurations:\n');

    console.log('SYSTEM configs:');
    if (existsSync(systemDir)) {
      const { readdirSync } = await import('fs');
      const files = readdirSync(systemDir);
      for (const file of files) {
        console.log(`  - ${file}`);
      }
    } else {
      console.log('  (none)');
    }

    console.log('\nUSER configs:');
    if (existsSync(userDir)) {
      const { readdirSync } = await import('fs');
      const files = readdirSync(userDir);
      for (const file of files) {
        console.log(`  - ${file}`);
      }
    } else {
      console.log('  (none)');
    }

    process.exit(0);
  }

  // --key mode
  const keyIndex = args.indexOf('--key');
  if (keyIndex !== -1 && args[keyIndex + 1]) {
    const key = args[keyIndex + 1];
    const shouldValidate = args.includes('--validate');

    // For generic loading without a specific schema, use passthrough
    const genericSchema = z.any();

    if (shouldValidate) {
      // Try to find the config file
      const userPath = findConfigFile(getUserConfigDir(), key);
      const systemPath = findConfigFile(getSystemConfigDir(), key);
      const configPath = userPath || systemPath;

      if (!configPath) {
        console.error(`No config file found for key: ${key}`);
        process.exit(1);
      }

      const result = validateConfigFile(configPath, genericSchema);
      if (result.valid) {
        console.log(`Config '${key}' is valid`);
        console.log('\nLoaded from:', configPath);
        console.log('\nContent:');
        console.log(JSON.stringify(result.data, null, 2));
      } else {
        console.error(`Config '${key}' is invalid:`);
        console.error(result.errors);
        process.exit(1);
      }
    } else {
      const config = loadTieredConfig(key, genericSchema, {});
      const cacheEntry = configCache.get(`tiered:${key}`);

      console.log(`Config: ${key}`);
      console.log('Loaded from:', cacheEntry?.path || '(defaults)');
      console.log('\nContent:');
      console.log(JSON.stringify(config, null, 2));
    }

    process.exit(0);
  }

  console.error('No valid command specified. Use --help for usage.');
  process.exit(1);
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}
