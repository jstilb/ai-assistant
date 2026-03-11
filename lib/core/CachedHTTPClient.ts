#!/usr/bin/env bun
/**
 * CachedHTTPClient - Unified HTTP Client for Kaya Infrastructure
 *
 * A production-grade HTTP client that consolidates scattered fetch calls across
 * Kaya skills with intelligent caching, retry logic, and request deduplication.
 *
 * Features:
 *   - Memory Cache: LRU cache for recent requests
 *   - Disk Cache: Persistent cache for offline/repeated access
 *   - Retry with Exponential Backoff: Configurable retry attempts
 *   - Content Hash Deduplication: Skip processing if content unchanged
 *   - Rate Limiting: Respect per-domain rate limits
 *   - Circuit Breaker: Stop calling failing endpoints temporarily
 *   - Request Deduplication: Coalesce concurrent identical requests
 *
 * Usage:
 *   import { httpClient, createHTTPClient } from './CachedHTTPClient.ts';
 *
 *   // Simple fetch with caching
 *   const response = await httpClient.fetch('https://api.example.com/data', {
 *     cache: 'disk',
 *     ttl: 3600,
 *     retry: 3
 *   });
 *
 *   // Hash-based change detection (PAIUpgrade pattern)
 *   const result = await httpClient.fetchWithHash(
 *     'https://blog.anthropic.com/feed',
 *     previousHash
 *   );
 *   if (result.changed) {
 *     processNewContent(result.data);
 *   }
 *
 * CLI Usage:
 *   bun run CachedHTTPClient.ts --url "https://..." --cache disk
 *   bun run CachedHTTPClient.ts --url "https://..." --hash
 *   bun run CachedHTTPClient.ts --stats
 *   bun run CachedHTTPClient.ts --clear
 *
 * @author Kaya System
 * @version 1.0.0
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

// ============================================================================
// Types & Interfaces
// ============================================================================

/**
 * Options for fetch requests
 */
export interface FetchOptions {
  /** Cache mode: 'memory' (LRU), 'disk' (persistent), or 'none' */
  cache?: 'memory' | 'disk' | 'none';
  /** Cache TTL in seconds */
  ttl?: number;
  /** Number of retry attempts */
  retry?: number;
  /** Backoff strategy for retries */
  backoff?: 'exponential' | 'linear' | 'fixed';
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Rate limit configuration */
  rateLimit?: { requests: number; perMs: number };
  /** Custom headers */
  headers?: Record<string, string>;
  /** HTTP method (default: GET). POST/PUT/PATCH requests skip caching. */
  method?: string;
  /** Request body for POST/PUT/PATCH requests */
  body?: string | ArrayBuffer | FormData;
}

/**
 * Result from hash-based fetch
 */
export interface HashFetchResult {
  /** Response body as text */
  data: string;
  /** Content hash (MD5) */
  hash: string;
  /** Whether content changed from previous hash */
  changed: boolean;
  /** Whether response was served from cache */
  cached: boolean;
  /** HTTP status code */
  status: number;
}

/**
 * Client configuration
 */
export interface ClientConfig {
  /** Directory for disk cache */
  cacheDir?: string;
  /** Default TTL in seconds */
  defaultTtl?: number;
  /** Maximum number of items in memory cache */
  maxCacheSize?: number;
  /** Default retry attempts */
  maxRetries?: number;
  /** User-Agent header */
  userAgent?: string;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  /** Number of cache hits */
  hits: number;
  /** Number of cache misses */
  misses: number;
  /** Current cache size (items in memory) */
  size: number;
}

/**
 * The CachedHTTPClient interface
 */
export interface CachedHTTPClient {
  /** Fetch URL and return Response (with caching) */
  fetch(url: string, options?: FetchOptions): Promise<Response>;
  /** Fetch URL and return text content */
  fetchText(url: string, options?: FetchOptions): Promise<string>;
  /** Fetch URL and parse JSON response */
  fetchJson<T>(url: string, options?: FetchOptions): Promise<T>;
  /** Fetch with content hash for change detection */
  fetchWithHash(url: string, previousHash?: string, options?: FetchOptions): Promise<HashFetchResult>;
  /** Clear cache (optionally by URL pattern) */
  clearCache(urlPattern?: string): void;
  /** Get cache statistics */
  getCacheStats(): CacheStats;
  /** Set rate limit for a domain */
  setRateLimit(domain: string, requests: number, perMs: number): void;
}

// ============================================================================
// Internal Types
// ============================================================================

interface CacheEntry {
  data: string;
  timestamp: number;
  ttl: number;
  headers: Record<string, string>;
  status: number;
}

interface RateLimitBucket {
  tokens: number;
  lastRefill: number;
  maxTokens: number;
  refillRate: number; // tokens per ms
}

interface CircuitState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

// ============================================================================
// LRU Cache Implementation
// ============================================================================

class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    if (!this.cache.has(key)) return undefined;
    // Move to end (most recently used)
    const value = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Delete oldest (first) entry
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  keys(): IterableIterator<K> {
    return this.cache.keys();
  }
}

// ============================================================================
// HTTPClient Implementation
// ============================================================================

class HTTPClientImpl implements CachedHTTPClient {
  private config: Required<ClientConfig>;
  private memoryCache: LRUCache<string, CacheEntry>;
  private rateLimits: Map<string, RateLimitBucket> = new Map();
  private circuits: Map<string, CircuitState> = new Map();
  private inflightRequests: Map<string, Promise<Response>> = new Map();
  private stats = { hits: 0, misses: 0 };

  // Circuit breaker settings
  private readonly CIRCUIT_FAILURE_THRESHOLD = 5;
  private readonly CIRCUIT_RESET_TIMEOUT = 30000; // 30 seconds

  constructor(config: ClientConfig = {}) {
    const defaultCacheDir = join(homedir(), '.claude', '.cache', 'http');

    this.config = {
      cacheDir: config.cacheDir ?? defaultCacheDir,
      defaultTtl: config.defaultTtl ?? 300, // 5 minutes
      maxCacheSize: config.maxCacheSize ?? 1000,
      maxRetries: config.maxRetries ?? 3,
      userAgent: config.userAgent ?? 'Kaya-CachedHTTPClient/1.0'
    };

    this.memoryCache = new LRUCache(this.config.maxCacheSize);

    // Ensure cache directory exists
    if (!existsSync(this.config.cacheDir)) {
      mkdirSync(this.config.cacheDir, { recursive: true });
    }
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  async fetch(url: string, options: FetchOptions = {}): Promise<Response> {
    const method = options.method ?? 'GET';
    // Non-GET requests always bypass cache
    const cacheMode = (method === 'GET' || method === 'HEAD') ? (options.cache ?? 'memory') : 'none';
    const ttl = options.ttl ?? this.config.defaultTtl;
    const cacheKey = this.generateCacheKey(url, options.headers);

    // Check cache first
    if (cacheMode !== 'none') {
      const cached = this.getFromCache(cacheKey, cacheMode);
      if (cached && !this.isExpired(cached)) {
        this.stats.hits++;
        return this.createResponseFromCache(cached);
      }
    }

    // Check circuit breaker
    const domain = this.extractDomain(url);
    if (this.isCircuitOpen(domain)) {
      throw new Error(`Circuit breaker open for ${domain}`);
    }

    // Check rate limit
    await this.waitForRateLimit(domain);

    // Request deduplication - check for inflight request
    const inflightKey = `${url}:${JSON.stringify(options.headers ?? {})}`;
    if (this.inflightRequests.has(inflightKey)) {
      return this.inflightRequests.get(inflightKey)!.then(r => r.clone());
    }

    // Execute request with retry
    const requestPromise = this.executeWithRetry(url, options);
    this.inflightRequests.set(inflightKey, requestPromise);

    try {
      const response = await requestPromise;
      const clonedResponse = response.clone();

      // Cache successful response
      if (response.ok && cacheMode !== 'none') {
        const text = await clonedResponse.text();
        const entry: CacheEntry = {
          data: text,
          timestamp: Date.now(),
          ttl: ttl * 1000, // Convert to ms
          headers: Object.fromEntries(response.headers.entries()),
          status: response.status
        };
        this.setInCache(cacheKey, entry, cacheMode);
      }

      this.stats.misses++;
      this.recordSuccess(domain);

      return response;
    } catch (error) {
      this.recordFailure(domain);
      throw error;
    } finally {
      this.inflightRequests.delete(inflightKey);
    }
  }

  async fetchText(url: string, options: FetchOptions = {}): Promise<string> {
    const response = await this.fetch(url, options);
    return response.text();
  }

  async fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
    const response = await this.fetch(url, options);
    return response.json() as Promise<T>;
  }

  async fetchWithHash(
    url: string,
    previousHash?: string,
    options: FetchOptions = {}
  ): Promise<HashFetchResult> {
    const cacheMode = options.cache ?? 'memory';
    const ttl = options.ttl ?? this.config.defaultTtl;
    const cacheKey = this.generateCacheKey(url, options.headers);

    // Check cache first
    let cached: CacheEntry | null = null;
    let fromCache = false;

    if (cacheMode !== 'none') {
      cached = this.getFromCache(cacheKey, cacheMode);
      if (cached && !this.isExpired(cached)) {
        fromCache = true;
        this.stats.hits++;
      }
    }

    let data: string;
    let status: number;

    if (fromCache && cached) {
      data = cached.data;
      status = cached.status;
    } else {
      // Execute request
      const response = await this.fetch(url, { ...options, cache: 'none' });
      data = await response.text();
      status = response.status;

      // Cache the response
      if (response.ok && cacheMode !== 'none') {
        const entry: CacheEntry = {
          data,
          timestamp: Date.now(),
          ttl: ttl * 1000,
          headers: Object.fromEntries(response.headers.entries()),
          status
        };
        this.setInCache(cacheKey, entry, cacheMode);
      }
    }

    // Calculate hash
    const hash = this.hashContent(data);
    const changed = !previousHash || hash !== previousHash;

    return {
      data,
      hash,
      changed,
      cached: fromCache,
      status
    };
  }

  clearCache(urlPattern?: string): void {
    if (!urlPattern) {
      // Clear all
      this.memoryCache.clear();
      if (existsSync(this.config.cacheDir)) {
        const files = readdirSync(this.config.cacheDir);
        for (const file of files) {
          if (file.endsWith('.cache')) {
            rmSync(join(this.config.cacheDir, file));
          }
        }
      }
      return;
    }

    // Clear matching pattern
    const keysToDelete: string[] = [];
    for (const key of this.memoryCache.keys()) {
      if (key.includes(urlPattern)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.memoryCache.delete(key);
    }

    // Clear from disk
    if (existsSync(this.config.cacheDir)) {
      const files = readdirSync(this.config.cacheDir);
      for (const file of files) {
        if (file.endsWith('.cache')) {
          const filePath = join(this.config.cacheDir, file);
          try {
            const content = readFileSync(filePath, 'utf-8');
            const entry = JSON.parse(content);
            if (entry.url && entry.url.includes(urlPattern)) {
              rmSync(filePath);
            }
          } catch {
            // Ignore invalid cache files
          }
        }
      }
    }
  }

  getCacheStats(): CacheStats {
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      size: this.memoryCache.size
    };
  }

  setRateLimit(domain: string, requests: number, perMs: number): void {
    this.rateLimits.set(domain, {
      tokens: requests,
      lastRefill: Date.now(),
      maxTokens: requests,
      refillRate: requests / perMs
    });
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private generateCacheKey(url: string, headers?: Record<string, string>): string {
    const sortedHeaders = headers ? JSON.stringify(Object.keys(headers).sort().reduce(
      (acc, key) => ({ ...acc, [key]: headers[key] }),
      {}
    )) : '';
    const input = `GET:${url}:${sortedHeaders}`;
    return this.hashContent(input);
  }

  private hashContent(content: string): string {
    // Use Bun's built-in hash if available, otherwise fallback
    if (typeof Bun !== 'undefined' && Bun.hash) {
      return Bun.hash(content).toString(16);
    }
    // Fallback to simple hash
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  private getFromCache(key: string, mode: 'memory' | 'disk'): CacheEntry | null {
    // Check memory first
    const memoryEntry = this.memoryCache.get(key);
    if (memoryEntry) {
      return memoryEntry;
    }

    // Check disk if requested
    if (mode === 'disk') {
      const diskPath = join(this.config.cacheDir, `${key}.cache`);
      if (existsSync(diskPath)) {
        try {
          const content = readFileSync(diskPath, 'utf-8');
          const entry = JSON.parse(content) as CacheEntry;
          // Also populate memory cache
          this.memoryCache.set(key, entry);
          return entry;
        } catch {
          // Invalid cache file, ignore
        }
      }
    }

    return null;
  }

  private setInCache(key: string, entry: CacheEntry, mode: 'memory' | 'disk'): void {
    // Always set in memory
    this.memoryCache.set(key, entry);

    // Also persist to disk if requested
    if (mode === 'disk') {
      const diskPath = join(this.config.cacheDir, `${key}.cache`);
      try {
        writeFileSync(diskPath, JSON.stringify(entry), 'utf-8');
      } catch (error) {
        console.warn(`Failed to write cache to disk: ${error}`);
      }
    }
  }

  private isExpired(entry: CacheEntry): boolean {
    return Date.now() - entry.timestamp > entry.ttl;
  }

  private createResponseFromCache(entry: CacheEntry): Response {
    const headers = new Headers(entry.headers);
    return new Response(entry.data, {
      status: entry.status,
      headers
    });
  }

  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  private async executeWithRetry(url: string, options: FetchOptions): Promise<Response> {
    const maxRetries = options.retry ?? this.config.maxRetries;
    const backoff = options.backoff ?? 'exponential';
    const timeout = options.timeout ?? 30000;
    const method = options.method ?? 'GET';
    // POST/PUT/PATCH requests are not retried by default to avoid side effects
    const effectiveMaxRetries = (method === 'GET' || method === 'HEAD') ? maxRetries : 0;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const fetchInit: RequestInit = {
          method,
          headers: {
            'User-Agent': this.config.userAgent,
            ...options.headers
          },
          signal: controller.signal,
        };

        if (options.body !== undefined) {
          fetchInit.body = options.body;
        }

        const response = await fetch(url, fetchInit);

        clearTimeout(timeoutId);

        // Don't retry on 4xx client errors (except 429 rate limit)
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          return response;
        }

        // Retry on 5xx server errors or 429 rate limit
        if (response.status >= 500 || response.status === 429) {
          lastError = new Error(`HTTP ${response.status}`);
          if (attempt < maxRetries) {
            await this.delay(this.calculateBackoff(attempt, backoff));
            continue;
          }
        }

        return response;
      } catch (error: any) {
        lastError = error;

        // Timeout handling
        if (error.name === 'AbortError') {
          lastError = new Error(`Request timeout after ${timeout}ms`);
        }

        if (attempt < maxRetries) {
          await this.delay(this.calculateBackoff(attempt, backoff));
        }
      }
    }

    throw lastError ?? new Error('Request failed');
  }

  private calculateBackoff(attempt: number, strategy: 'exponential' | 'linear' | 'fixed'): number {
    const baseDelay = 100; // 100ms base

    switch (strategy) {
      case 'exponential':
        return baseDelay * Math.pow(2, attempt);
      case 'linear':
        return baseDelay * (attempt + 1);
      case 'fixed':
      default:
        return baseDelay;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async waitForRateLimit(domain: string): Promise<void> {
    const bucket = this.rateLimits.get(domain);
    if (!bucket) return;

    // Refill tokens based on elapsed time
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    const tokensToAdd = elapsed * bucket.refillRate;
    bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;

    // Wait if no tokens available
    if (bucket.tokens < 1) {
      const waitTime = (1 - bucket.tokens) / bucket.refillRate;
      await this.delay(waitTime);
      bucket.tokens = 0;
    } else {
      bucket.tokens--;
    }
  }

  private isCircuitOpen(domain: string): boolean {
    const circuit = this.circuits.get(domain);
    if (!circuit) return false;

    if (circuit.isOpen) {
      // Check if we should try again (half-open state)
      if (Date.now() - circuit.lastFailure > this.CIRCUIT_RESET_TIMEOUT) {
        circuit.isOpen = false;
        circuit.failures = 0;
        return false;
      }
      return true;
    }

    return false;
  }

  private recordSuccess(domain: string): void {
    const circuit = this.circuits.get(domain);
    if (circuit) {
      circuit.failures = 0;
      circuit.isOpen = false;
    }
  }

  private recordFailure(domain: string): void {
    let circuit = this.circuits.get(domain);
    if (!circuit) {
      circuit = { failures: 0, lastFailure: 0, isOpen: false };
      this.circuits.set(domain, circuit);
    }

    circuit.failures++;
    circuit.lastFailure = Date.now();

    if (circuit.failures >= this.CIRCUIT_FAILURE_THRESHOLD) {
      circuit.isOpen = true;
    }
  }
}

// ============================================================================
// Factory Functions & Default Instance
// ============================================================================

/**
 * Create a new HTTP client with custom configuration
 */
export function createHTTPClient(config?: ClientConfig): CachedHTTPClient {
  return new HTTPClientImpl(config);
}

/**
 * Default HTTP client instance
 */
export const httpClient: CachedHTTPClient = createHTTPClient();

// ============================================================================
// CLI Interface
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
CachedHTTPClient - Unified HTTP Client for Kaya

Usage:
  bun run CachedHTTPClient.ts --url <url> [options]
  bun run CachedHTTPClient.ts --stats
  bun run CachedHTTPClient.ts --clear [pattern]

Options:
  --url <url>          URL to fetch
  --cache <mode>       Cache mode: memory, disk, none (default: memory)
  --ttl <seconds>      Cache TTL in seconds (default: 300)
  --hash               Use hash-based change detection
  --previous <hash>    Previous hash for change detection
  --retry <count>      Number of retries (default: 3)
  --timeout <ms>       Request timeout in milliseconds (default: 30000)
  --json               Output as JSON
  --stats              Show cache statistics
  --clear [pattern]    Clear cache (optionally matching pattern)

Examples:
  bun run CachedHTTPClient.ts --url "https://httpbin.org/get" --cache disk
  bun run CachedHTTPClient.ts --url "https://api.example.com" --hash --json
  bun run CachedHTTPClient.ts --stats
  bun run CachedHTTPClient.ts --clear "httpbin"
`);
    return;
  }

  // Parse arguments
  const getArg = (name: string): string | undefined => {
    const idx = args.indexOf(name);
    if (idx !== -1 && args[idx + 1]) {
      return args[idx + 1];
    }
    return undefined;
  };

  const hasFlag = (name: string): boolean => args.includes(name);

  // Handle --stats
  if (hasFlag('--stats')) {
    const stats = httpClient.getCacheStats();
    console.log('Cache Statistics:');
    console.log(`  Hits:   ${stats.hits}`);
    console.log(`  Misses: ${stats.misses}`);
    console.log(`  Size:   ${stats.size} items`);
    return;
  }

  // Handle --clear
  if (hasFlag('--clear')) {
    const pattern = getArg('--clear');
    httpClient.clearCache(pattern);
    console.log(pattern ? `Cleared cache matching "${pattern}"` : 'Cleared all cache');
    return;
  }

  // Handle --url
  const url = getArg('--url');
  if (!url) {
    console.error('Error: --url is required');
    process.exit(1);
  }

  const options: FetchOptions = {
    cache: (getArg('--cache') as 'memory' | 'disk' | 'none') || 'memory',
    ttl: parseInt(getArg('--ttl') ?? '300'),
    retry: parseInt(getArg('--retry') ?? '3'),
    timeout: parseInt(getArg('--timeout') ?? '30000')
  };

  const outputJson = hasFlag('--json');
  const useHash = hasFlag('--hash');
  const previousHash = getArg('--previous');

  try {
    if (useHash) {
      const result = await httpClient.fetchWithHash(url, previousHash, options);

      if (outputJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`URL:     ${url}`);
        console.log(`Status:  ${result.status}`);
        console.log(`Hash:    ${result.hash}`);
        console.log(`Changed: ${result.changed}`);
        console.log(`Cached:  ${result.cached}`);
        console.log(`---`);
        console.log(result.data.substring(0, 500) + (result.data.length > 500 ? '...' : ''));
      }
    } else {
      const response = await httpClient.fetch(url, options);
      const text = await response.text();

      if (outputJson) {
        console.log(JSON.stringify({
          url,
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: text.substring(0, 1000)
        }, null, 2));
      } else {
        console.log(`URL:    ${url}`);
        console.log(`Status: ${response.status}`);
        console.log(`---`);
        console.log(text.substring(0, 1000) + (text.length > 1000 ? '...' : ''));
      }
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

// Run CLI if executed directly
if (import.meta.main) {
  main();
}
