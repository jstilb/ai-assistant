#!/usr/bin/env bun
/**
 * CachedHTTPClient Tests
 *
 * Tests for the unified HTTP client with caching, retry, and deduplication.
 * Run: bun test CachedHTTPClient.test.ts
 *
 * TRANSPORT: every test below injects `fetchFn` (ClientConfig.fetchFn,
 * CachedHTTPClient.ts ~L114) with an in-process fake — no live network calls,
 * no `mock.module`, no mutation of `globalThis.fetch`. The caching, retry,
 * circuit-breaker, and dedup logic all sit ABOVE the transport call, so a
 * fake `fetchFn` exercises every one of those code paths deterministically.
 * `cacheDir` is a fresh `mkdtemp()` directory per test — nothing here ever
 * touches the real `~/.claude/.cache`. (One caveat: constructing a client
 * with zero config, as `createHTTPClient()` does in a couple of tests below,
 * has always used the real default cache dir as a `mkdir -p`-style side
 * effect of the constructor itself — CachedHTTPClient.ts ~L244; unrelated to
 * network flakiness and out of scope for this rewrite since it doesn't
 * touch CachedHTTPClient.ts.)
 *
 * The single exception is the opt-in live smoke test at the bottom, gated
 * behind KAYA_LIVE_HTTP_TESTS=1 and skipped by default.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  createHTTPClient,
  httpClient,
  type CachedHTTPClient,
} from './CachedHTTPClient.ts';

// ============================================================================
// Fake transport builders
// ============================================================================
//
// Each builder returns a `fetchFn` matching `typeof globalThis.fetch` plus a
// `calls` array so tests can assert exactly how many times (and with what
// init) the transport was actually invoked — this is the load-bearing proof
// that caching/dedup/retry/circuit-breaker logic is doing what it claims,
// strictly stronger than the old live tests could ever verify (they had no
// way to distinguish "served from cache" from "network happened to agree").

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

interface FakeFetch {
  fetchFn: typeof fetch;
  calls: CapturedCall[];
}

/** Normalizes any HeadersInit shape into a plain Record for assertions. */
function toHeaderRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

/** Always resolves with the same 200 JSON body. */
function fixedJsonFetch(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): FakeFetch {
  const calls: CapturedCall[] = [];
  const fetchFn: typeof fetch = async (input, requestInit) => {
    calls.push({ url: String(input), init: requestInit });
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json', ...init.headers },
    });
  };
  return { fetchFn, calls };
}

/** Always resolves with the same raw body/status — for non-JSON payloads. */
function fixedResponseFetch(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {}
): FakeFetch {
  const calls: CapturedCall[] = [];
  const fetchFn: typeof fetch = async (input, requestInit) => {
    calls.push({ url: String(input), init: requestInit });
    return new Response(body, {
      status: init.status ?? 200,
      headers: init.headers,
    });
  };
  return { fetchFn, calls };
}

/** Resolves with a different JSON body (incrementing counter) on every call. */
function uniqueBodyFetch(): FakeFetch {
  const calls: CapturedCall[] = [];
  let counter = 0;
  const fetchFn: typeof fetch = async (input, requestInit) => {
    calls.push({ url: String(input), init: requestInit });
    counter++;
    return new Response(JSON.stringify({ counter }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchFn, calls };
}

/** Echoes the request headers back as `{ headers: {...} }`, like a headers-inspection endpoint. */
function echoHeadersFetch(): FakeFetch {
  const calls: CapturedCall[] = [];
  const fetchFn: typeof fetch = async (input, requestInit) => {
    calls.push({ url: String(input), init: requestInit });
    return new Response(JSON.stringify({ headers: toHeaderRecord(requestInit?.headers) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchFn, calls };
}

/** Walks a fixed sequence of {status, body} responses, one per call, holding the last entry once exhausted. */
function sequencedFetch(responses: ReadonlyArray<{ status: number; body?: string }>): FakeFetch {
  const calls: CapturedCall[] = [];
  const fetchFn: typeof fetch = async (input, requestInit) => {
    calls.push({ url: String(input), init: requestInit });
    const index = Math.min(calls.length - 1, responses.length - 1);
    const step = responses[index];
    if (!step) throw new Error('sequencedFetch: no response configured');
    return new Response(step.body ?? '', {
      status: step.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchFn, calls };
}

/** Always rejects — simulates a network-level failure (DNS/connection reset), not an HTTP error status. */
function alwaysFailingFetch(message = 'simulated network failure'): FakeFetch {
  const calls: CapturedCall[] = [];
  const fetchFn: typeof fetch = async (input) => {
    calls.push({ url: String(input), init: undefined });
    throw new Error(message);
  };
  return { fetchFn, calls };
}

/**
 * Never resolves on its own. Only settles when the AbortSignal passed via
 * `init.signal` fires, rejecting with a real AbortError — mirroring how
 * native fetch behaves under an AbortController. executeWithRetry()
 * (CachedHTTPClient.ts ~L564-582) sets up exactly that controller/timeout
 * and relies on this contract to turn a hang into a timeout.
 */
function neverRespondingFetch(): FakeFetch {
  const calls: CapturedCall[] = [];
  const fetchFn: typeof fetch = (input, requestInit) => {
    calls.push({ url: String(input), init: requestInit });
    return new Promise<Response>((_resolve, reject) => {
      const signal = requestInit?.signal;
      if (!signal) return; // every real call site supplies one; nothing to hook otherwise
      if (signal.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
  };
  return { fetchFn, calls };
}

// ============================================================================
// Shared per-test isolation
// ============================================================================

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'cachedhttpclient-test-'));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('CachedHTTPClient', () => {
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
        cacheDir,
        defaultTtl: 300,
        maxCacheSize: 500,
        maxRetries: 5,
        userAgent: 'CustomAgent/1.0',
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
      const { fetchFn } = fixedJsonFetch({ ok: true });
      const client = createHTTPClient({ cacheDir, fetchFn });

      const response = await client.fetch('https://basic-fetch.fake/get', { cache: 'none' });
      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);
    });

    it('should cache responses in memory', async () => {
      const { fetchFn, calls } = uniqueBodyFetch();
      const client = createHTTPClient({ cacheDir, fetchFn });
      const url = 'https://memory-cache.fake/uuid';

      const response1 = await client.fetch(url, { cache: 'memory', ttl: 60 });
      const data1 = await response1.json();

      const response2 = await client.fetch(url, { cache: 'memory', ttl: 60 });
      const data2 = await response2.json();

      // Real proof of caching: the transport was invoked once, and the
      // second response is byte-identical (a live/uncached call to this
      // fake would return a different counter value each time).
      expect(calls.length).toBe(1);
      expect(data2).toEqual(data1);

      const stats = client.getCacheStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
    });

    it('should cache responses to disk', async () => {
      const url = 'https://disk-cache.fake/get';

      const { fetchFn: writeFetch, calls: writeCalls } = fixedJsonFetch({ from: 'origin' });
      const client1 = createHTTPClient({ cacheDir, fetchFn: writeFetch });
      await client1.fetch(url, { cache: 'disk', ttl: 60 });
      expect(writeCalls.length).toBe(1);

      // The disk cache file actually exists on disk, not just in memory.
      expect(existsSync(cacheDir)).toBe(true);
      const cacheFiles = readdirSync(cacheDir).filter((f) => f.endsWith('.cache'));
      expect(cacheFiles.length).toBe(1);

      // Real persistence proof: a brand-new client instance (fresh
      // in-memory cache) pointed at the SAME cacheDir must serve the
      // response straight from disk, without ever calling the transport.
      const readFetch: typeof fetch = async () => {
        throw new Error('fetchFn should not be called — expected a disk cache hit');
      };
      const client2 = createHTTPClient({ cacheDir, fetchFn: readFetch });
      const response = await client2.fetch(url, { cache: 'disk', ttl: 60 });

      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual({ from: 'origin' });
      expect(client2.getCacheStats().hits).toBe(1);
    });

    it('should bypass cache for non-GET requests', async () => {
      const { fetchFn, calls } = fixedJsonFetch({ accepted: true }, { status: 201 });
      const client = createHTTPClient({ cacheDir, fetchFn });
      const url = 'https://non-get-bypass.fake/resource';

      await client.fetch(url, { method: 'POST', cache: 'memory', body: 'payload-1' });
      await client.fetch(url, { method: 'POST', cache: 'memory', body: 'payload-2' });

      // Non-GET/HEAD requests force cacheMode to 'none' internally
      // (CachedHTTPClient.ts fetch() ~L270) regardless of the `cache`
      // option passed, so the transport must be hit both times.
      expect(calls.length).toBe(2);
      expect(client.getCacheStats().size).toBe(0);
    });

    it('should expire cached entries after TTL elapses', async () => {
      const { fetchFn, calls } = fixedJsonFetch({ ok: true });
      const client = createHTTPClient({ cacheDir, fetchFn });
      const url = 'https://ttl-expiry.fake/resource';

      let fakeNow = 1_700_000_000_000;
      const nowSpy = spyOn(Date, 'now').mockImplementation(() => fakeNow);
      try {
        await client.fetch(url, { cache: 'memory', ttl: 1 }); // 1s TTL
        expect(calls.length).toBe(1);

        // Still within the TTL window: served from cache, no new call.
        await client.fetch(url, { cache: 'memory', ttl: 1 });
        expect(calls.length).toBe(1);
        expect(client.getCacheStats().hits).toBe(1);

        // Advance the fake clock past the 1s TTL.
        fakeNow += 1_001;

        // Expired: must hit the transport again.
        await client.fetch(url, { cache: 'memory', ttl: 1 });
        expect(calls.length).toBe(2);
        expect(client.getCacheStats().misses).toBe(2);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('should handle timeout option', async () => {
      const { fetchFn } = neverRespondingFetch();
      const client = createHTTPClient({ cacheDir, fetchFn });

      // retry: 0 isolates pure timeout behavior from the retry loop
      // (covered separately under "Retry Logic" below).
      try {
        await client.fetch('https://timeout.fake/slow', {
          timeout: 100,
          retry: 0,
          cache: 'none',
        });
        expect(true).toBe(false); // should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain('timeout');
      }
    });

    it('should include custom headers', async () => {
      const { fetchFn } = echoHeadersFetch();
      const client = createHTTPClient({ cacheDir, fetchFn });

      const response = await client.fetch('https://custom-headers.fake/headers', {
        cache: 'none',
        headers: {
          'X-Custom-Header': 'test-value',
        },
      });
      const data = (await response.json()) as { headers: Record<string, string> };
      expect(data.headers['X-Custom-Header']).toBe('test-value');
    });
  });

  describe('fetchText()', () => {
    it('should fetch and return text content', async () => {
      const { fetchFn } = fixedResponseFetch('User-agent: *\nDisallow:', {
        headers: { 'content-type': 'text/plain' },
      });
      const client = createHTTPClient({ cacheDir, fetchFn });

      const text = await client.fetchText('https://fetch-text.fake/robots.txt', {
        cache: 'none',
      });
      expect(typeof text).toBe('string');
      expect(text).toContain('User-agent');
    });
  });

  describe('fetchJson()', () => {
    it('should fetch and parse JSON', async () => {
      interface IPResponse {
        origin: string;
      }
      const { fetchFn } = fixedJsonFetch({ origin: '203.0.113.5' });
      const client = createHTTPClient({ cacheDir, fetchFn });

      const data = await client.fetchJson<IPResponse>('https://fetch-json.fake/ip', {
        cache: 'none',
      });
      expect(data).toBeDefined();
      expect(typeof data.origin).toBe('string');
    });

    it('should throw on invalid JSON', async () => {
      const { fetchFn } = fixedResponseFetch('<html><body>not json</body></html>', {
        headers: { 'content-type': 'text/html' },
      });
      const client = createHTTPClient({ cacheDir, fetchFn });

      try {
        await client.fetchJson('https://invalid-json.fake/html', { cache: 'none' });
        expect(true).toBe(false); // should not reach here
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });

  describe('fetchWithHash()', () => {
    it('should return hash and changed status for new content', async () => {
      const { fetchFn, calls } = fixedJsonFetch({ id: 'static' });
      const client = createHTTPClient({ cacheDir, fetchFn });

      const result = await client.fetchWithHash('https://hash-new.fake/resource');

      expect(result.data).toBeDefined();
      expect(result.hash).toBeDefined();
      expect(typeof result.hash).toBe('string');
      expect(result.hash.length).toBeGreaterThan(0);
      expect(result.changed).toBe(true); // no previous hash
      expect(result.status).toBe(200);
      expect(calls.length).toBe(1);
    });

    it('should detect unchanged content with same hash', async () => {
      const { fetchFn, calls } = fixedResponseFetch('<html><body>static</body></html>', {
        headers: { 'content-type': 'text/html' },
      });
      const client = createHTTPClient({ cacheDir, fetchFn, defaultTtl: 60 });
      const url = 'https://hash-static.fake/page';

      const result1 = await client.fetchWithHash(url);
      const result2 = await client.fetchWithHash(url, result1.hash);

      expect(result2.changed).toBe(false);
      expect(result2.hash).toBe(result1.hash);
      // fetchWithHash defaults to cache:'memory' for its own bookkeeping
      // (CachedHTTPClient.ts ~L346), so the 2nd call is served from cache —
      // proof below that the transport was hit only once. Stronger than the
      // original, which relied on 2 real network round trips to a static
      // page happening to return identical bytes.
      expect(calls.length).toBe(1);
    });

    it('should detect changed content with different hash', async () => {
      const { fetchFn, calls } = uniqueBodyFetch();
      const client = createHTTPClient({ cacheDir, fetchFn });
      const url = 'https://hash-changing.fake/resource';

      // Both calls disable caching, matching the original test's intent of
      // forcing two independent fetches of content that changes each time.
      const result1 = await client.fetchWithHash(url, undefined, { cache: 'none' });
      const result2 = await client.fetchWithHash(url, result1.hash, { cache: 'none' });

      expect(result2.changed).toBe(true);
      expect(result2.hash).not.toBe(result1.hash);
      expect(calls.length).toBe(2);
    });

    it('should indicate cached status', async () => {
      const { fetchFn, calls } = fixedJsonFetch({ v: 1 });
      const client = createHTTPClient({ cacheDir, fetchFn });
      const url = 'https://hash-cached-flag.fake/resource';

      const result1 = await client.fetchWithHash(url, undefined, { cache: 'memory', ttl: 60 });
      expect(result1.cached).toBe(false);

      const result2 = await client.fetchWithHash(url, result1.hash, { cache: 'memory', ttl: 60 });
      expect(result2.cached).toBe(true);
      expect(calls.length).toBe(1);
    });
  });

  describe('clearCache()', () => {
    // clearCache() takes no arguments and clears everything. The former
    // optional urlPattern parameter was deleted 2026-07-05: cache keys are
    // content hashes and disk entries store no url field, so both pattern
    // branches were verified no-ops that no caller ever exercised.
    it('should clear all memory-cached entries', async () => {
      const { fetchFn } = fixedJsonFetch({ ok: true });
      const client = createHTTPClient({ cacheDir, fetchFn });

      await client.fetch('https://clear-all.fake/get', { cache: 'memory' });
      await client.fetch('https://clear-all.fake/ip', { cache: 'memory' });

      const statsBefore = client.getCacheStats();
      expect(statsBefore.size).toBe(2);

      client.clearCache();

      const statsAfter = client.getCacheStats();
      expect(statsAfter.size).toBe(0);
    });

    it('should clear disk-cached entries too', async () => {
      const { fetchFn, calls } = fixedJsonFetch({ ok: true });
      const client = createHTTPClient({ cacheDir, fetchFn });

      await client.fetch('https://clear-disk.fake/get', { cache: 'disk', ttl: 3600 });
      const cacheFilesBefore = readdirSync(cacheDir).filter(f => f.endsWith('.cache'));
      expect(cacheFilesBefore.length).toBe(1);

      client.clearCache();

      const cacheFilesAfter = readdirSync(cacheDir).filter(f => f.endsWith('.cache'));
      expect(cacheFilesAfter.length).toBe(0);
      expect(client.getCacheStats().size).toBe(0);

      // A refetch must hit the transport again — nothing served from cache.
      await client.fetch('https://clear-disk.fake/get', { cache: 'disk', ttl: 3600 });
      expect(calls.length).toBe(2);
    });
  });

  describe('getCacheStats()', () => {
    it('should return cache statistics', async () => {
      const client = createHTTPClient({ cacheDir });

      const stats = client.getCacheStats();

      expect(typeof stats.hits).toBe('number');
      expect(typeof stats.misses).toBe('number');
      expect(typeof stats.size).toBe('number');
      expect(stats.hits).toBeGreaterThanOrEqual(0);
      expect(stats.misses).toBeGreaterThanOrEqual(0);
      expect(stats.size).toBeGreaterThanOrEqual(0);
    });

    it('should track hits and misses', async () => {
      const { fetchFn } = fixedJsonFetch({ ok: true });
      const client = createHTTPClient({ cacheDir, fetchFn });
      const url = 'https://hits-misses.fake/get';

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
      const client = createHTTPClient({ cacheDir });
      expect(() => {
        client.setRateLimit('api.example.com', 60, 60000);
      }).not.toThrow();
    });
  });

  describe('Retry Logic', () => {
    it('should retry failed requests', async () => {
      const { fetchFn, calls } = fixedResponseFetch('', { status: 500 });
      const client = createHTTPClient({ cacheDir, fetchFn });

      // DISCOVERED BEHAVIOR: a persistent 5xx status is retried, but once
      // retries are exhausted the last (still-failing) Response is
      // RETURNED, not thrown (CachedHTTPClient.ts executeWithRetry
      // ~L590-598 — the retryable-status branch only `continue`s while
      // attempt < maxRetries; the final attempt falls through to a plain
      // `return response`). The original live test wrapped this in
      // try/catch expecting an exception the real implementation never
      // raises for this case, so its assertion lived inside a catch block
      // that was never entered — it silently verified nothing. Corrected
      // here to assert the actual contract.
      const response = await client.fetch('https://retry-persistent-5xx.fake/endpoint', {
        retry: 2,
        cache: 'none',
      });

      expect(response.status).toBe(500);
      expect(response.ok).toBe(false);
      expect(calls.length).toBe(3); // 1 initial attempt + 2 retries
    });

    it('should recover when a retry succeeds after a transient failure', async () => {
      const { fetchFn, calls } = sequencedFetch([
        { status: 500 },
        { status: 200, body: JSON.stringify({ recovered: true }) },
      ]);
      const client = createHTTPClient({ cacheDir, fetchFn });

      const response = await client.fetch('https://retry-recover.fake/endpoint', {
        retry: 1,
        backoff: 'linear',
        cache: 'none',
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ recovered: true });
      expect(calls.length).toBe(2); // 1 failing attempt + 1 successful retry
    });

    it('should retry on 429 and 403 like 5xx errors', async () => {
      for (const status of [429, 403]) {
        const { fetchFn, calls } = sequencedFetch([
          { status },
          { status: 200, body: JSON.stringify({ ok: true }) },
        ]);
        const client = createHTTPClient({ cacheDir, fetchFn });

        const response = await client.fetch(`https://retry-status-${status}.fake/endpoint`, {
          retry: 1,
          backoff: 'linear',
          cache: 'none',
        });

        expect(response.status).toBe(200);
        // Proves the first `status` response was retried rather than
        // returned immediately (which would leave calls.length at 1).
        expect(calls.length).toBe(2);
      }
    });

    it('should not retry non-retryable 4xx errors', async () => {
      const { fetchFn, calls } = fixedResponseFetch('not found', { status: 404 });
      const client = createHTTPClient({ cacheDir, fetchFn });

      const response = await client.fetch('https://no-retry-404.fake/endpoint', {
        retry: 3,
        cache: 'none',
      });

      expect(response.status).toBe(404);
      expect(calls.length).toBe(1); // no retries for a plain 404
    });

    it('should use exponential backoff', async () => {
      const { fetchFn, calls } = fixedResponseFetch('', { status: 503 });
      const client = createHTTPClient({ cacheDir, fetchFn });

      const start = Date.now();
      const response = await client.fetch('https://backoff.fake/endpoint', {
        retry: 2,
        backoff: 'exponential',
        cache: 'none',
      });
      const elapsed = Date.now() - start;

      // calculateBackoff() (CachedHTTPClient.ts ~L616) with 'exponential'
      // and a 100ms base waits 100ms after attempt 0 and 200ms after
      // attempt 1 — real wall-clock waits, so assert a lower bound with a
      // small tolerance rather than an exact figure.
      expect(response.status).toBe(503);
      expect(calls.length).toBe(3); // 1 initial + 2 retries
      expect(elapsed).toBeGreaterThanOrEqual(280);
    });
  });

  describe('Request Deduplication', () => {
    it('should deduplicate concurrent identical requests', async () => {
      let callCount = 0;
      const fetchFn: typeof fetch = async () => {
        callCount++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(JSON.stringify({ hit: callCount }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      const client = createHTTPClient({ cacheDir, fetchFn });
      const url = 'https://dedup.fake/delay';

      const [r1, r2, r3] = await Promise.all([
        client.fetch(url, { cache: 'none' }),
        client.fetch(url, { cache: 'none' }),
        client.fetch(url, { cache: 'none' }),
      ]);

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r3.ok).toBe(true);

      // Stronger than the original: proves only ONE underlying transport
      // call was made for 3 concurrent identical requests.
      expect(callCount).toBe(1);
    });
  });

  describe('Circuit Breaker', () => {
    it('should open circuit after repeated failures', async () => {
      const { fetchFn, calls } = alwaysFailingFetch();
      const client = createHTTPClient({ cacheDir, fetchFn });
      const url = 'https://circuit-open.fake/endpoint';

      // DISCOVERED BEHAVIOR: executeWithRetry() only throws when the
      // fetchFn itself rejects (network error / AbortError). A resolved
      // 5xx/429/403 Response is retried but, once retries are exhausted,
      // is returned rather than thrown (see "should retry failed requests"
      // above) — so recordFailure()/the circuit breaker (only reachable
      // from fetch()'s catch block, ~L323-325) can never trip on a plain
      // bad-status response. A throwing fetchFn (simulated network
      // failure) is required to exercise this path at all; a
      // status-based fake would never open the circuit no matter how many
      // times it's called.
      for (let i = 0; i < 5; i++) {
        await expect(client.fetch(url, { retry: 0, cache: 'none' })).rejects.toThrow();
      }
      expect(calls.length).toBe(5);

      // 6th call: circuit should now be open — fails fast, no transport call.
      await expect(client.fetch(url, { retry: 0, cache: 'none' })).rejects.toThrow(
        /circuit breaker open/i
      );
      expect(calls.length).toBe(5); // unchanged — proves fail-fast, no network attempt
    });

    it('should reset circuit after the reset timeout elapses', async () => {
      const { fetchFn, calls } = alwaysFailingFetch();
      const client = createHTTPClient({ cacheDir, fetchFn });
      const url = 'https://circuit-reset.fake/endpoint';

      let fakeNow = 2_000_000_000_000;
      const nowSpy = spyOn(Date, 'now').mockImplementation(() => fakeNow);
      try {
        for (let i = 0; i < 5; i++) {
          await expect(client.fetch(url, { retry: 0, cache: 'none' })).rejects.toThrow();
        }
        expect(calls.length).toBe(5);

        // Circuit is open: fails fast without calling the transport.
        await expect(client.fetch(url, { retry: 0, cache: 'none' })).rejects.toThrow(
          /circuit breaker open/i
        );
        expect(calls.length).toBe(5);

        // CIRCUIT_RESET_TIMEOUT is a hard-coded 30-second private constant
        // (CachedHTTPClient.ts ~L241), not configurable via ClientConfig —
        // fast-forward Date.now() instead of sleeping 30 real seconds.
        fakeNow += 30_001;

        // Half-open: the next call is actually attempted against the transport.
        await expect(client.fetch(url, { retry: 0, cache: 'none' })).rejects.toThrow();
        expect(calls.length).toBe(6); // transport was called again post-reset
      } finally {
        nowSpy.mockRestore();
      }
    });
  });
});

describe('Integration: PAIUpgrade Pattern', () => {
  it('should replicate PAIUpgrade blog checking pattern', async () => {
    const { fetchFn, calls } = fixedResponseFetch('<html><body>blog post</body></html>', {
      headers: { 'content-type': 'text/html' },
    });
    const client = createHTTPClient({ cacheDir, fetchFn, defaultTtl: 3600 });
    const url = 'https://pai-upgrade-blog.fake/feed';

    const previousHash = undefined; // No previous hash
    const result = await client.fetchWithHash(url, previousHash, { cache: 'disk', ttl: 3600 });

    if (result.changed) {
      expect(result.data).toContain('html');
    }

    const storedHash = result.hash;
    const result2 = await client.fetchWithHash(url, storedHash, { cache: 'disk', ttl: 3600 });

    expect(result2.changed).toBe(false);
    expect(result2.hash).toBe(storedHash);
    // Content is static and the 2nd call is served from the client's own
    // disk/memory cache — proof below that the transport was hit only once.
    expect(calls.length).toBe(1);
  });

  it('should handle batch URL checking efficiently', async () => {
    const { fetchFn, calls } = fixedJsonFetch({ ok: true });
    const client = createHTTPClient({ cacheDir, fetchFn, defaultTtl: 3600 });

    const urls = [
      'https://pai-batch.fake/get',
      'https://pai-batch.fake/ip',
      'https://pai-batch.fake/headers',
    ];

    const results = await Promise.all(
      urls.map((url) => client.fetchWithHash(url, undefined, { cache: 'memory' }))
    );

    expect(results).toHaveLength(3);
    results.forEach((result) => {
      expect(result.status).toBe(200);
      expect(result.hash).toBeDefined();
    });
    expect(calls.length).toBe(3); // one call per distinct URL, run in parallel
  });
});

// ============================================================================
// Opt-in live smoke test — the ONLY test in this file allowed to touch the
// real network. Skipped by default; set KAYA_LIVE_HTTP_TESTS=1 to run it.
// ============================================================================

it.skipIf(process.env.KAYA_LIVE_HTTP_TESTS !== '1')(
  'live smoke: real fetch round trip against httpbin [KAYA_LIVE_HTTP_TESTS=1 required — live network]',
  async () => {
    const client: CachedHTTPClient = createHTTPClient({ cacheDir }); // fetchFn defaults to real globalThis.fetch
    const response = await client.fetch('https://httpbin.org/get', { cache: 'none' });
    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    const data = (await response.json()) as { url?: string };
    expect(data).toBeDefined();
  },
  30000
);
