#!/usr/bin/env bun
/**
 * ConfigLoader.test.ts - Test suite for unified configuration loader
 *
 * Tests cover:
 * - SYSTEM -> USER -> Defaults tiering
 * - Zod schema validation
 * - Environment variable fallbacks
 * - Caching behavior
 * - File watching (hot reload)
 * - Type safety
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { z } from 'zod';

// Test directory setup
const TEST_DIR = join(tmpdir(), `config-loader-test-${Date.now()}`);
const SYSTEM_CONFIG_DIR = join(TEST_DIR, 'docs', 'system', 'config');
const USER_CONFIG_DIR = join(TEST_DIR, 'USER', 'config');
const SETTINGS_PATH = join(TEST_DIR, 'settings.json');

// Setup test environment
function setupTestEnvironment() {
  mkdirSync(SYSTEM_CONFIG_DIR, { recursive: true });
  mkdirSync(USER_CONFIG_DIR, { recursive: true });
}

// Cleanup test environment
function cleanupTestEnvironment() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

// Mock settings.json
const mockSettings = {
  daidentity: {
    name: 'TestAI',
    voiceId: 'test-voice-123',
  },
  principal: {
    name: 'TestUser',
    timezone: 'America/Los_Angeles',
  },
  techStack: {
    packageManager: 'bun',
    browser: 'Safari',
  },
};

// Test schemas
const BrowserConfigSchema = z.object({
  browser: z.string().default('Chrome'),
  headless: z.boolean().default(true),
  timeout: z.number().default(30000),
});

const AgentConfigSchema = z.object({
  traits: z.array(z.string()).default([]),
  defaultVoice: z.string().default('Daniel'),
  maxConcurrent: z.number().default(3),
});

const VoiceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  voiceId: z.string().optional(),
  stability: z.number().min(0).max(1).default(0.5),
  similarityBoost: z.number().min(0).max(1).default(0.75),
});

// ============================================================================
// TESTS
// ============================================================================

describe('ConfigLoader', () => {
  beforeEach(() => {
    setupTestEnvironment();
    // Write default settings.json
    writeFileSync(SETTINGS_PATH, JSON.stringify(mockSettings, null, 2));
  });

  afterEach(() => {
    cleanupTestEnvironment();
  });

  describe('loadSettings', () => {
    test('loads settings.json correctly', async () => {
      // Import after setup to use test paths
      const { loadSettings, _setTestPaths } = await import('./ConfigLoader');
      _setTestPaths?.(TEST_DIR);

      const settings = loadSettings();
      expect(settings.daidentity?.name).toBe('TestAI');
      expect(settings.principal?.name).toBe('TestUser');
    });

    test('returns empty object when settings.json is missing', async () => {
      rmSync(SETTINGS_PATH);
      const { loadSettings, _setTestPaths, clearAllCaches } = await import('./ConfigLoader');
      _setTestPaths?.(TEST_DIR);
      clearAllCaches?.();

      const settings = loadSettings();
      expect(settings).toEqual({});
    });

    test('caches settings on repeated calls', async () => {
      const { loadSettings, _setTestPaths } = await import('./ConfigLoader');
      _setTestPaths?.(TEST_DIR);

      const settings1 = loadSettings();
      const settings2 = loadSettings();
      expect(settings1).toBe(settings2); // Same reference = cached
    });
  });

  describe('loadTieredConfig', () => {
    test('returns defaults when no config files exist', async () => {
      const { loadTieredConfig, _setTestPaths } = await import('./ConfigLoader');
      _setTestPaths?.(TEST_DIR);

      const defaults = { browser: 'Chrome', headless: true, timeout: 30000 };
      const config = loadTieredConfig('browser', BrowserConfigSchema, defaults);

      expect(config.browser).toBe('Chrome');
      expect(config.headless).toBe(true);
    });

    test('loads from SYSTEM config when only SYSTEM exists', async () => {
      const systemConfig = { browser: 'Firefox', headless: false, timeout: 60000 };
      writeFileSync(
        join(SYSTEM_CONFIG_DIR, 'browser.json'),
        JSON.stringify(systemConfig)
      );

      const { loadTieredConfig, _setTestPaths, clearAllCaches } = await import('./ConfigLoader');
      _setTestPaths?.(TEST_DIR);
      clearAllCaches?.();

      const config = loadTieredConfig('browser', BrowserConfigSchema, { browser: 'Chrome', headless: true, timeout: 30000 });

      expect(config.browser).toBe('Firefox');
      expect(config.headless).toBe(false);
      expect(config.timeout).toBe(60000);
    });

    test('USER config overrides SYSTEM config', async () => {
      const systemConfig = { browser: 'Firefox', headless: false, timeout: 60000 };
      const userConfig = { browser: 'Safari', headless: true, timeout: 45000 };

      writeFileSync(
        join(SYSTEM_CONFIG_DIR, 'browser.json'),
        JSON.stringify(systemConfig)
      );
      writeFileSync(
        join(USER_CONFIG_DIR, 'browser.json'),
        JSON.stringify(userConfig)
      );

      const { loadTieredConfig, _setTestPaths, clearAllCaches } = await import('./ConfigLoader');
      _setTestPaths?.(TEST_DIR);
      clearAllCaches?.();

      const config = loadTieredConfig('browser', BrowserConfigSchema, { browser: 'Chrome', headless: true, timeout: 30000 });

      expect(config.browser).toBe('Safari');
      expect(config.timeout).toBe(45000);
    });

    test('supports YAML config files', async () => {
      const yamlContent = `
browser: Edge
headless: true
timeout: 20000
`;
      writeFileSync(join(SYSTEM_CONFIG_DIR, 'browser.yaml'), yamlContent);

      const { loadTieredConfig, _setTestPaths, clearAllCaches } = await import('./ConfigLoader');
      _setTestPaths?.(TEST_DIR);
      clearAllCaches?.();

      const config = loadTieredConfig('browser', BrowserConfigSchema, { browser: 'Chrome', headless: true, timeout: 30000 });

      expect(config.browser).toBe('Edge');
      expect(config.timeout).toBe(20000);
    });

    test('validates config against schema', async () => {
      const invalidConfig = { browser: 123, headless: 'not-a-boolean' }; // Invalid types
      writeFileSync(
        join(SYSTEM_CONFIG_DIR, 'browser.json'),
        JSON.stringify(invalidConfig)
      );

      const { loadTieredConfig, _setTestPaths, clearAllCaches } = await import('./ConfigLoader');
      _setTestPaths?.(TEST_DIR);
      clearAllCaches?.();

      // Should fall back to defaults on validation failure
      const config = loadTieredConfig('browser', BrowserConfigSchema, { browser: 'Chrome', headless: true, timeout: 30000 });

      expect(config.browser).toBe('Chrome'); // Fallback to default
    });
  });

  describe('Environment Variable Fallbacks', () => {
    test('reads from KAYA_* environment variables', async () => {
      process.env.KAYA_BROWSER = 'Brave';
      process.env.KAYA_HEADLESS = 'false';

      const { loadTieredConfig, _setTestPaths, clearAllCaches } = await import('./ConfigLoader');
      _setTestPaths?.(TEST_DIR);
      clearAllCaches?.();

      const config = loadTieredConfig(
        'browser',
        BrowserConfigSchema,
        { browser: 'Chrome', headless: true, timeout: 30000 },
        { envPrefix: 'KAYA' }
      );

      expect(config.browser).toBe('Brave');
      expect(config.headless).toBe(false);

      delete process.env.KAYA_BROWSER;
      delete process.env.KAYA_HEADLESS;
    });

    test('env vars have lower priority than config files', async () => {
      process.env.KAYA_BROWSER = 'Brave';
      const userConfig = { browser: 'Safari', headless: true, timeout: 45000 };
      writeFileSync(
        join(USER_CONFIG_DIR, 'browser.json'),
        JSON.stringify(userConfig)
      );

      const { loadTieredConfig, _setTestPaths, clearAllCaches } = await import('./ConfigLoader');
      _setTestPaths?.(TEST_DIR);
      clearAllCaches?.();

      const config = loadTieredConfig(
        'browser',
        BrowserConfigSchema,
        { browser: 'Chrome', headless: true, timeout: 30000 },
        { envPrefix: 'KAYA' }
      );

      expect(config.browser).toBe('Safari'); // File overrides env

      delete process.env.KAYA_BROWSER;
    });
  });

  describe('createConfigLoader Factory', () => {
    test('creates reusable loader instance', async () => {
      const systemConfig = { browser: 'Firefox', headless: false, timeout: 60000 };
      writeFileSync(
        join(SYSTEM_CONFIG_DIR, 'browser.json'),
        JSON.stringify(systemConfig)
      );

      const { createConfigLoader, _setTestPaths, clearAllCaches } = await import('./ConfigLoader');
      _setTestPaths?.(TEST_DIR);
      clearAllCaches?.();

      const loader = createConfigLoader({
        key: 'browser',
        schema: BrowserConfigSchema,
        defaults: { browser: 'Chrome', headless: true, timeout: 30000 },
      });

      const config = loader.load();
      expect(config.browser).toBe('Firefox');
    });

    test('get() returns specific key', async () => {
      const systemConfig = { browser: 'Firefox', headless: false, timeout: 60000 };
      writeFileSync(
        join(SYSTEM_CONFIG_DIR, 'browser.json'),
        JSON.stringify(systemConfig)
      );

      const { createConfigLoader, _setTestPaths, clearAllCaches } = await import('./ConfigLoader');
      _setTestPaths?.(TEST_DIR);
      clearAllCaches?.();

      const loader = createConfigLoader({
        key: 'browser',
        schema: BrowserConfigSchema,
        defaults: { browser: 'Chrome', headless: true, timeout: 30000 },
      });

      expect(loader.get('browser')).toBe('Firefox');
      expect(loader.get('headless')).toBe(false);
    });

    test('getPath() returns loaded config file path', async () => {
      const userConfig = { browser: 'Safari', headless: true, timeout: 45000 };
      writeFileSync(
        join(USER_CONFIG_DIR, 'browser.json'),
        JSON.stringify(userConfig)
      );

      const { createConfigLoader, _setTestPaths, clearAllCaches } = await import('./ConfigLoader');
      _setTestPaths?.(TEST_DIR);
      clearAllCaches?.();

      const loader = createConfigLoader({
        key: 'browser',
        schema: BrowserConfigSchema,
        defaults: { browser: 'Chrome', headless: true, timeout: 30000 },
      });

      loader.load();
      expect(loader.getPath()).toBe(join(USER_CONFIG_DIR, 'browser.json'));
    });

    test('reload() refreshes config from disk', async () => {
      const initialConfig = { browser: 'Firefox', headless: false, timeout: 60000 };
      writeFileSync(
        join(SYSTEM_CONFIG_DIR, 'browser.json'),
        JSON.stringify(initialConfig)
      );

      const { createConfigLoader, _setTestPaths, clearAllCaches } = await import('./ConfigLoader');
      _setTestPaths?.(TEST_DIR);
      clearAllCaches?.();

      const loader = createConfigLoader({
        key: 'browser',
        schema: BrowserConfigSchema,
        defaults: { browser: 'Chrome', headless: true, timeout: 30000 },
      });

      expect(loader.load().browser).toBe('Firefox');

      // Update config file
      const updatedConfig = { browser: 'Brave', headless: true, timeout: 90000 };
      writeFileSync(
        join(SYSTEM_CONFIG_DIR, 'browser.json'),
        JSON.stringify(updatedConfig)
      );

      // Should still return cached value
      expect(loader.load().browser).toBe('Firefox');

      // Reload should get new value
      expect(loader.reload().browser).toBe('Brave');
    });
  });

  describe('Caching', () => {
    test('respects cache TTL', async () => {
      const systemConfig = { browser: 'Firefox', headless: false, timeout: 60000 };
      writeFileSync(
        join(SYSTEM_CONFIG_DIR, 'browser.json'),
        JSON.stringify(systemConfig)
      );

      const { createConfigLoader, _setTestPaths, clearAllCaches } = await import('./ConfigLoader');
      _setTestPaths?.(TEST_DIR);
      clearAllCaches?.();

      const loader = createConfigLoader({
        key: 'browser',
        schema: BrowserConfigSchema,
        defaults: { browser: 'Chrome', headless: true, timeout: 30000 },
        cacheTtlMs: 100, // 100ms cache
      });

      expect(loader.load().browser).toBe('Firefox');

      // Update file
      writeFileSync(
        join(SYSTEM_CONFIG_DIR, 'browser.json'),
        JSON.stringify({ browser: 'Safari', headless: true, timeout: 45000 })
      );

      // Still cached
      expect(loader.load().browser).toBe('Firefox');

      // Wait for cache to expire
      await new Promise(resolve => setTimeout(resolve, 150));

      // Should reload automatically
      expect(loader.load().browser).toBe('Safari');
    });
  });

  describe('Type Safety', () => {
    test('infers types from schema', async () => {
      const { loadTieredConfig, _setTestPaths } = await import('./ConfigLoader');
      _setTestPaths?.(TEST_DIR);

      const config = loadTieredConfig(
        'voice',
        VoiceConfigSchema,
        { enabled: true, stability: 0.5, similarityBoost: 0.75 }
      );

      // TypeScript should infer these types correctly
      const enabled: boolean = config.enabled;
      const stability: number = config.stability;
      const voiceId: string | undefined = config.voiceId;

      expect(typeof enabled).toBe('boolean');
      expect(typeof stability).toBe('number');
    });
  });

  describe('Error Handling', () => {
    test('handles malformed JSON gracefully', async () => {
      writeFileSync(
        join(SYSTEM_CONFIG_DIR, 'browser.json'),
        '{ invalid json }'
      );

      const { loadTieredConfig, _setTestPaths, clearAllCaches } = await import('./ConfigLoader');
      _setTestPaths?.(TEST_DIR);
      clearAllCaches?.();

      // Should fall back to defaults
      const config = loadTieredConfig('browser', BrowserConfigSchema, { browser: 'Chrome', headless: true, timeout: 30000 });
      expect(config.browser).toBe('Chrome');
    });

    test('handles malformed YAML gracefully', async () => {
      writeFileSync(
        join(SYSTEM_CONFIG_DIR, 'browser.yaml'),
        'invalid: yaml: content: [unclosed'
      );

      const { loadTieredConfig, _setTestPaths, clearAllCaches } = await import('./ConfigLoader');
      _setTestPaths?.(TEST_DIR);
      clearAllCaches?.();

      // Should fall back to defaults
      const config = loadTieredConfig('browser', BrowserConfigSchema, { browser: 'Chrome', headless: true, timeout: 30000 });
      expect(config.browser).toBe('Chrome');
    });

    test('handles file permission errors gracefully', async () => {
      // This test verifies the error handling path exists
      // Actual permission testing would require running as different user
      const { loadTieredConfig, _setTestPaths } = await import('./ConfigLoader');
      _setTestPaths?.(TEST_DIR);

      // Non-existent path should fall back to defaults
      const config = loadTieredConfig(
        'nonexistent',
        BrowserConfigSchema,
        { browser: 'Chrome', headless: true, timeout: 30000 }
      );
      expect(config.browser).toBe('Chrome');
    });
  });
});

// ============================================================================
// RUNTIME CONFIG TESTS
// ============================================================================

const RUNTIME_CONFIG_DIR = join(TEST_DIR, 'MEMORY', 'State');
const RUNTIME_CONFIG_PATH = join(RUNTIME_CONFIG_DIR, 'runtime-config.json');

describe('Runtime Config Merge', () => {
  beforeEach(() => {
    mkdirSync(RUNTIME_CONFIG_DIR, { recursive: true });
    setupTestEnvironment();
    writeFileSync(SETTINGS_PATH, JSON.stringify(mockSettings, null, 2));
  });

  afterEach(() => {
    cleanupTestEnvironment();
  });

  test('runtime-config.json key overrides settings.json key', async () => {
    const runtimeOverrides = { rateLimits: { enabled: true, alertThreshold: 95, pauseThreshold: 99 } };
    writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(runtimeOverrides));

    // Write settings with rateLimits too
    const settingsWithRateLimits = { ...mockSettings, rateLimits: { enabled: true, alertThreshold: 80, pauseThreshold: 90 } };
    writeFileSync(SETTINGS_PATH, JSON.stringify(settingsWithRateLimits, null, 2));

    const { loadSettings, _setTestPaths, clearAllCaches } = await import('./ConfigLoader');
    _setTestPaths?.(TEST_DIR);
    clearAllCaches?.();

    const settings = loadSettings();
    const rl = settings.rateLimits as Record<string, unknown>;
    expect(rl.alertThreshold).toBe(95);
    expect(rl.pauseThreshold).toBe(99);
  });

  test('loadSettings returns settings-only data when runtime-config.json is missing', async () => {
    // No runtime-config.json written
    const { loadSettings, _setTestPaths, clearAllCaches } = await import('./ConfigLoader');
    _setTestPaths?.(TEST_DIR);
    clearAllCaches?.();

    const settings = loadSettings();
    expect(settings.daidentity?.name).toBe('TestAI');
    expect(settings.principal?.name).toBe('TestUser');
  });

  test('malformed runtime-config.json falls back to settings.json values', async () => {
    writeFileSync(RUNTIME_CONFIG_PATH, '{ invalid json !!!');

    const { loadSettings, _setTestPaths, clearAllCaches } = await import('./ConfigLoader');
    _setTestPaths?.(TEST_DIR);
    clearAllCaches?.();

    const settings = loadSettings();
    expect(settings.daidentity?.name).toBe('TestAI');
  });

  test('non-overlapping keys from both files appear in merged result', async () => {
    const runtimeOverrides = { learnerCache: { enabled: true, confidence_threshold: 0.9 } };
    writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(runtimeOverrides));

    const { loadSettings, _setTestPaths, clearAllCaches } = await import('./ConfigLoader');
    _setTestPaths?.(TEST_DIR);
    clearAllCaches?.();

    const settings = loadSettings();
    // From settings.json
    expect(settings.daidentity?.name).toBe('TestAI');
    // From runtime-config.json
    const learnerCache = settings.learnerCache as Record<string, unknown>;
    expect(learnerCache.enabled).toBe(true);
    expect(learnerCache.confidence_threshold).toBe(0.9);
  });
});

describe('loadRawSettings', () => {
  beforeEach(() => {
    mkdirSync(RUNTIME_CONFIG_DIR, { recursive: true });
    setupTestEnvironment();
    writeFileSync(SETTINGS_PATH, JSON.stringify(mockSettings, null, 2));
  });

  afterEach(() => {
    cleanupTestEnvironment();
  });

  test('returns only base file contents, ignoring runtime overrides', async () => {
    const settingsWithRateLimits = { ...mockSettings, rateLimits: { alertThreshold: 80 } };
    writeFileSync(SETTINGS_PATH, JSON.stringify(settingsWithRateLimits, null, 2));

    const runtimeOverrides = { rateLimits: { alertThreshold: 99 } };
    writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(runtimeOverrides));

    const { loadRawSettings, _setTestPaths, clearAllCaches } = await import('./ConfigLoader');
    _setTestPaths?.(TEST_DIR);
    clearAllCaches?.();

    const raw = loadRawSettings();
    const rl = raw.rateLimits as Record<string, unknown>;
    expect(rl.alertThreshold).toBe(80); // Raw, not overridden
  });
});

describe('writeRuntimeConfig', () => {
  beforeEach(() => {
    mkdirSync(RUNTIME_CONFIG_DIR, { recursive: true });
    setupTestEnvironment();
    writeFileSync(SETTINGS_PATH, JSON.stringify(mockSettings, null, 2));
  });

  afterEach(() => {
    cleanupTestEnvironment();
  });

  test('rejects immutable keys', async () => {
    const { writeRuntimeConfig, _setTestPaths, clearAllCaches } = await import('./ConfigLoader');
    _setTestPaths?.(TEST_DIR);
    clearAllCaches?.();

    expect(() => writeRuntimeConfig('permissions', { allow: ['Bash'] })).toThrow('not a mutable runtime key');
    expect(() => writeRuntimeConfig('hooks', {})).toThrow('not a mutable runtime key');
    expect(() => writeRuntimeConfig('daidentity', { name: 'Evil' })).toThrow('not a mutable runtime key');
    expect(() => writeRuntimeConfig('principal', { name: 'Other' })).toThrow('not a mutable runtime key');
    expect(() => writeRuntimeConfig('env', { EVIL: 'true' })).toThrow('not a mutable runtime key');
  });

  test('accepts mutable keys and writes valid JSON', async () => {
    const { writeRuntimeConfig, _setTestPaths, clearAllCaches } = await import('./ConfigLoader');
    _setTestPaths?.(TEST_DIR);
    clearAllCaches?.();

    writeRuntimeConfig('rateLimits', { enabled: true, alertThreshold: 85, pauseThreshold: 95 });

    // Verify file is valid JSON with correct content
    const { readFileSync } = await import('fs');
    const content = JSON.parse(readFileSync(RUNTIME_CONFIG_PATH, 'utf-8'));
    expect(content.rateLimits.alertThreshold).toBe(85);
    expect(content.rateLimits.pauseThreshold).toBe(95);
  });

  test('cache invalidation after write', async () => {
    const { loadSettings, writeRuntimeConfig, _setTestPaths, clearAllCaches } = await import('./ConfigLoader');
    _setTestPaths?.(TEST_DIR);
    clearAllCaches?.();

    // Initial load — no runtime overrides
    const before = loadSettings();
    expect(before.model).toBeUndefined();

    // Write runtime override
    writeRuntimeConfig('model', 'opus[1m]');

    // Next load should reflect the change
    const after = loadSettings();
    expect(after.model).toBe('opus[1m]');
  });

  test('preserves existing runtime keys when writing new ones', async () => {
    const { writeRuntimeConfig, _setTestPaths, clearAllCaches } = await import('./ConfigLoader');
    _setTestPaths?.(TEST_DIR);
    clearAllCaches?.();

    writeRuntimeConfig('rateLimits', { alertThreshold: 85 });
    writeRuntimeConfig('model', 'sonnet');

    const { readFileSync } = await import('fs');
    const content = JSON.parse(readFileSync(RUNTIME_CONFIG_PATH, 'utf-8'));
    expect(content.rateLimits.alertThreshold).toBe(85);
    expect(content.model).toBe('sonnet');
  });
});

describe('ALLOWED_RUNTIME_KEYS', () => {
  test('contains expected mutable keys', async () => {
    const { ALLOWED_RUNTIME_KEYS } = await import('./ConfigLoader');
    expect(ALLOWED_RUNTIME_KEYS.has('rateLimits')).toBe(true);
    // 'contextManager' was removed here: the ContextManager subsystem itself
    // was deleted in commit b950f0aa8 (refactor(contextmanager): Phase 4 —
    // delete the ContextManager subsystem, merged via 47dfc645d). It is the
    // only reference to 'contextManager' left anywhere in lib/ or hooks/
    // (verified via grep 2026-07-03), so asserting the key still exists in
    // ALLOWED_RUNTIME_KEYS was a stale expectation, not a code defect.
    // 'failures' replaces it as coverage of a live runtime key (read by
    // ExplicitRatingCapture.hook.ts via settings.failures.enabled).
    // 'wisdom' was removed 2026-07-09 for the same reason as 'contextManager':
    // the wisdom-frame synthesis subsystem was deleted and no settings file
    // ever defined the key.
    expect(ALLOWED_RUNTIME_KEYS.has('failures')).toBe(true);
    expect(ALLOWED_RUNTIME_KEYS.has('toon')).toBe(true);
    expect(ALLOWED_RUNTIME_KEYS.has('model')).toBe(true);
  });

  test('does not contain security-critical keys', async () => {
    const { ALLOWED_RUNTIME_KEYS } = await import('./ConfigLoader');
    expect(ALLOWED_RUNTIME_KEYS.has('permissions')).toBe(false);
    expect(ALLOWED_RUNTIME_KEYS.has('hooks')).toBe(false);
    expect(ALLOWED_RUNTIME_KEYS.has('daidentity')).toBe(false);
    expect(ALLOWED_RUNTIME_KEYS.has('principal')).toBe(false);
    expect(ALLOWED_RUNTIME_KEYS.has('env')).toBe(false);
  });
});

describe('CLI Interface', () => {
  test('validates config from command line', async () => {
    setupTestEnvironment();
    const configContent = { browser: 'Firefox', headless: true, timeout: 30000 };
    writeFileSync(
      join(SYSTEM_CONFIG_DIR, 'browser.json'),
      JSON.stringify(configContent)
    );

    // CLI test would be:
    // bun run ConfigLoader.ts --key browser --validate
    // For now, test the validation function directly
    const { validateConfigFile } = await import('./ConfigLoader');

    const result = validateConfigFile?.(
      join(SYSTEM_CONFIG_DIR, 'browser.json'),
      BrowserConfigSchema
    );

    expect(result?.valid).toBe(true);
    cleanupTestEnvironment();
  });
});
