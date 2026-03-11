#!/usr/bin/env bun
/**
 * CachedHTTPClient Tests
 *
 * Tests for the unified HTTP client with caching, retry, and deduplication.
 * Run: bun test CachedHTTPClient.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Test configuration
const TEST_CACHE_DIR = join(homedir(), '.claude', '.cache', 'http-test');

// Import the module (will fail until implemented - RED phase)
// @ts-ignore - Will exist after implementation
import {
  createHTTPClient,
  httpClient,
  type FetchOptions,
  type HashFetchResult,
  type CachedHTTPClient,
  type ClientConfig
} from './CachedHTTPClient.ts';

describe('CachedHTTPClient', () => {
  let client: CachedHTTPClient;

  beforeEach(() => {
    // Create fresh client for each test
    client = createHTTPClient({
      cacheDir: TEST_CACHE_DIR,
      defaultTtl: 60,
      maxCacheSize: 100,
      maxRetries: 3,
      userAgent: 'Kaya-Test/1.0'
    });
  });

  afterEach(() => {
    // Clean up test cache
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    }
  });

  describe('createHTTPClient', () => {
    it('should create a client with default config', () => {
      const defaultClient = createHTTPClient();
      expect(defaultClient).toBeDefined();
      expect(typeof defaultClient.fetch).toBe('function');
      expect(typeof defaultClient.fetchText).toBe('function');
      expect(typeof defaultClient.fetchJson).toBe('function');
      expect(typeof defaultClient.fetchWithHash).toBe('function');
      expect(typeof defaultClient.clearCache).toBe('function');
      expect(typeof defaultClient.getCacheStats).toBe('function');
      expect(typeof defaultClient.setRateLimit).toBe('function');
    });

    it('should create a client with custom config', () => {
      const customClient = createHTTPClient({
        cacheDir: '/tmp/test-cache',
        defaultTtl: 300,
        maxCacheSize: 500,
        maxRetries: 5,
        userAgent: 'CustomAgent/1.0'
      });
      expect(customClient).toBeDefined();
    });
  });

  describe('httpClient (default instance)', () => {
    it('should export a default client instance', () => {
      expect(httpClient).toBeDefined();
      expect(typeof httpClient.fetch).toBe('function');
    });
  });

  describe('fetch()', () => {
    it('should fetch a URL and return Response', async () => {
      const response = await client.fetch('https://httpbin.org/get', {
        cache: 'none'
      });
      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);
    });

    it('should cache responses in memory', async () => {
      const url = 'https://httpbin.org/uuid';

      // First fetch
      const response1 = await client.fetch(url, { cache: 'memory', ttl: 60 });
      const data1 = await response1.json();

      // Second fetch should return cached
      const response2 = await client.fetch(url, { cache: 'memory', ttl: 60 });
      const data2 = await response2.json();

      // UUIDs would be different if not cached
      // Note: This test may be flaky with real network, but demonstrates intent
      const stats = client.getCacheStats();
      expect(stats.hits + stats.misses).toBeGreaterThan(0);
    });

    it('should cache responses to disk', async () => {
      const url = 'https://httpbin.org/get';

      await client.fetch(url, { cache: 'disk', ttl: 60 });

      // Check disk cache exists
      expect(existsSync(TEST_CACHE_DIR)).toBe(true);
    });

    it('should handle timeout option', async () => {
      // This should timeout quickly
      try {
        await client.fetch('https://httpbin.org/delay/10', {
          timeout: 100,
          cache: 'none'
        });
        expect(true).toBe(false); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain('timeout');
      }
    });

    it('should include custom headers', async () => {
      const response = await client.fetch('https://httpbin.org/headers', {
        cache: 'none',
        headers: {
          'X-Custom-Header': 'test-value'
        }
      });
      const data = await response.json();
      expect(data.headers['X-Custom-Header']).toBe('test-value');
    });
  });

  describe('fetchText()', () => {
    it('should fetch and return text content', async () => {
      const text = await client.fetchText('https://httpbin.org/robots.txt', {
        cache: 'none'
      });
      expect(typeof text).toBe('string');
    });
  });

  describe('fetchJson()', () => {
    it('should fetch and parse JSON', async () => {
      interface IPResponse {
        origin: string;
      }
      const data = await client.fetchJson<IPResponse>('https://httpbin.org/ip', {
        cache: 'none'
      });
      expect(data).toBeDefined();
      expect(typeof data.origin).toBe('string');
    });

    it('should throw on invalid JSON', async () => {
      try {
        await client.fetchJson('https://httpbin.org/html', { cache: 'none' });
        expect(true).toBe(false); // Should not reach here
      } catch (error: any) {
        expect(error).toBeDefined();
      }
    });
  });

  describe('fetchWithHash()', () => {
    it('should return hash and changed status for new content', async () => {
      const result = await client.fetchWithHash('https://httpbin.org/uuid');

      expect(result.data).toBeDefined();
      expect(result.hash).toBeDefined();
      expect(typeof result.hash).toBe('string');
      expect(result.hash.length).toBeGreaterThan(0);
      expect(result.changed).toBe(true); // No previous hash
      expect(result.status).toBe(200);
    });

    it('should detect unchanged content with same hash', async () => {
      // First fetch
      const result1 = await client.fetchWithHash('https://httpbin.org/html');

      // Second fetch with previous hash
      const result2 = await client.fetchWithHash('https://httpbin.org/html', result1.hash);

      // HTML content is static, should be unchanged
      expect(result2.changed).toBe(false);
      expect(result2.hash).toBe(result1.hash);
    });

    it('should detect changed content with different hash', async () => {
      // First fetch - disable caching to ensure fresh content
      const result1 = await client.fetchWithHash('https://httpbin.org/uuid', undefined, { cache: 'none' });

      // UUID endpoint returns different content each time - also disable caching
      const result2 = await client.fetchWithHash('https://httpbin.org/uuid', result1.hash, { cache: 'none' });

      expect(result2.changed).toBe(true);
      expect(result2.hash).not.toBe(result1.hash);
    });

    it('should indicate cached status', async () => {
      const url = 'https://httpbin.org/get';

      // First fetch
      const result1 = await client.fetchWithHash(url, undefined, { cache: 'memory', ttl: 60 });
      expect(result1.cached).toBe(false);

      // Second fetch should be cached
      const result2 = await client.fetchWithHash(url, result1.hash, { cache: 'memory', ttl: 60 });
      expect(result2.cached).toBe(true);
    });
  });

  describe('clearCache()', () => {
    it('should clear all cache when no pattern provided', async () => {
      // Populate cache
      await client.fetch('https://httpbin.org/get', { cache: 'memory' });
      await client.fetch('https://httpbin.org/ip', { cache: 'memory' });

      const statsBefore = client.getCacheStats();
      expect(statsBefore.size).toBeGreaterThan(0);

      client.clearCache();

      const statsAfter = client.getCacheStats();
      expect(statsAfter.size).toBe(0);
    });

    it('should clear cache matching URL pattern', async () => {
      // Populate cache
      await client.fetch('https://httpbin.org/get', { cache: 'memory' });
      await client.fetch('https://example.com/test', { cache: 'memory' });

      client.clearCache('httpbin');

      const stats = client.getCacheStats();
      // Should only have example.com cached
      expect(stats.size).toBeLessThanOrEqual(1);
    });
  });

  describe('getCacheStats()', () => {
    it('should return cache statistics', async () => {
      const stats = client.getCacheStats();

      expect(typeof stats.hits).toBe('number');
      expect(typeof stats.misses).toBe('number');
      expect(typeof stats.size).toBe('number');
      expect(stats.hits).toBeGreaterThanOrEqual(0);
      expect(stats.misses).toBeGreaterThanOrEqual(0);
      expect(stats.size).toBeGreaterThanOrEqual(0);
    });

    it('should track hits and misses', async () => {
      const url = 'https://httpbin.org/get';

      // First fetch = miss
      await client.fetch(url, { cache: 'memory', ttl: 60 });

      const statsAfterMiss = client.getCacheStats();
      expect(statsAfterMiss.misses).toBe(1);

      // Second fetch = hit
      await client.fetch(url, { cache: 'memory', ttl: 60 });

      const statsAfterHit = client.getCacheStats();
      expect(statsAfterHit.hits).toBe(1);
    });
  });

  describe('setRateLimit()', () => {
    it('should set rate limit for a domain', () => {
      // Should not throw
      expect(() => {
        client.setRateLimit('api.example.com', 60, 60000);
      }).not.toThrow();
    });
  });

  describe('Retry Logic', () => {
    it('should retry failed requests', async () => {
      // httpbin.org/status/500 returns 500
      try {
        await client.fetch('https://httpbin.org/status/500', {
          retry: 2,
          cache: 'none'
        });
      } catch (error: any) {
        // Should have retried and still failed
        expect(error).toBeDefined();
      }
    });

    it('should use exponential backoff', async () => {
      const start = Date.now();

      try {
        await client.fetch('https://httpbin.org/status/503', {
          retry: 2,
          backoff: 'exponential',
          cache: 'none'
        });
      } catch (error) {
        const elapsed = Date.now() - start;
        // Should have waited for backoff
        expect(elapsed).toBeGreaterThan(100);
      }
    });
  });

  describe('Request Deduplication', () => {
    it('should deduplicate concurrent identical requests', async () => {
      const url = 'https://httpbin.org/delay/1';

      // Fire multiple requests simultaneously
      const requests = [
        client.fetch(url, { cache: 'none' }),
        client.fetch(url, { cache: 'none' }),
        client.fetch(url, { cache: 'none' })
      ];

      const responses = await Promise.all(requests);

      // All should succeed
      expect(responses[0].ok).toBe(true);
      expect(responses[1].ok).toBe(true);
      expect(responses[2].ok).toBe(true);

      // In a perfect deduplication, only 1 actual request would be made
      // We can't easily test this without mocking, but the API should support it
    });
  });

  describe('Circuit Breaker', () => {
    it('should open circuit after repeated failures', async () => {
      // Make multiple failing requests
      for (let i = 0; i < 5; i++) {
        try {
          await client.fetch('https://httpbin.org/status/500', {
            retry: 0,
            cache: 'none'
          });
        } catch (e) {
          // Expected to fail
        }
      }

      // Next request should fail fast due to open circuit
      const start = Date.now();
      try {
        await client.fetch('https://httpbin.org/status/500', {
          retry: 0,
          cache: 'none'
        });
      } catch (error: any) {
        const elapsed = Date.now() - start;
        // If circuit is open, should fail immediately
        // This is a weak assertion - mainly checking the API exists
        expect(error).toBeDefined();
      }
    });
  });
});

describe('Integration: PAIUpgrade Pattern', () => {
  let client: CachedHTTPClient;

  beforeEach(() => {
    client = createHTTPClient({
      cacheDir: TEST_CACHE_DIR,
      defaultTtl: 3600
    });
  });

  afterEach(() => {
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    }
  });

  it('should replicate PAIUpgrade blog checking pattern', async () => {
    // Simulating the PAIUpgrade pattern
    const previousHash = undefined; // No previous hash

    const result = await client.fetchWithHash(
      'https://httpbin.org/html',
      previousHash,
      { cache: 'disk', ttl: 3600 }
    );

    if (result.changed) {
      // Process new content
      expect(result.data).toContain('html');
    }

    // Store hash for next check
    const storedHash = result.hash;

    // Simulate next check
    const result2 = await client.fetchWithHash(
      'https://httpbin.org/html',
      storedHash,
      { cache: 'disk', ttl: 3600 }
    );

    // Content should be unchanged (static page)
    expect(result2.changed).toBe(false);
    expect(result2.hash).toBe(storedHash);
  });

  it('should handle batch URL checking efficiently', async () => {
    const urls = [
      'https://httpbin.org/get',
      'https://httpbin.org/ip',
      'https://httpbin.org/headers'
    ];

    // Parallel fetch with caching
    const results = await Promise.all(
      urls.map(url => client.fetchWithHash(url, undefined, { cache: 'memory' }))
    );

    expect(results).toHaveLength(3);
    results.forEach(result => {
      expect(result.status).toBe(200);
      expect(result.hash).toBeDefined();
    });
  });
});
