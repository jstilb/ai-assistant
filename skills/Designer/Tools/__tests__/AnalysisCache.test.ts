/**
 * AnalysisCache.test.ts - Tests for StateManager-backed analysis caching
 *
 * Tests:
 * - Cache miss returns null
 * - Cache write and subsequent hit
 * - TTL expiry (expired entries return null)
 * - Different image hashes are independent
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createAnalysisCache, type AnalysisCacheEntry } from "../AnalysisCache.ts";
import { existsSync, rmSync } from "fs";

const TEST_CACHE_PATH = "/tmp/designer-test-analysis-cache.json";

describe("AnalysisCache", () => {
  beforeEach(() => {
    if (existsSync(TEST_CACHE_PATH)) rmSync(TEST_CACHE_PATH);
    if (existsSync(`${TEST_CACHE_PATH}.lock`)) rmSync(`${TEST_CACHE_PATH}.lock`);
  });

  afterEach(() => {
    if (existsSync(TEST_CACHE_PATH)) rmSync(TEST_CACHE_PATH);
    if (existsSync(`${TEST_CACHE_PATH}.lock`)) rmSync(`${TEST_CACHE_PATH}.lock`);
  });

  it("returns null on cache miss", async () => {
    const cache = createAnalysisCache(TEST_CACHE_PATH);
    const entry = await cache.get("abc123");
    expect(entry).toBeNull();
  });

  it("stores and retrieves cached analysis", async () => {
    const cache = createAnalysisCache(TEST_CACHE_PATH);
    const mockAnalysis: AnalysisCacheEntry = {
      imageHash: "abc123",
      analysis: { room_type: "living room", confidence: 0.9 },
      method: "gemini_vision",
      cachedAt: new Date().toISOString(),
      ttlDays: 7,
    };

    await cache.set("abc123", mockAnalysis);
    const retrieved = await cache.get("abc123");

    expect(retrieved).not.toBeNull();
    expect(retrieved!.imageHash).toBe("abc123");
    expect(retrieved!.analysis.room_type).toBe("living room");
  });

  it("returns null for expired entries", async () => {
    const cache = createAnalysisCache(TEST_CACHE_PATH);
    const expiredEntry: AnalysisCacheEntry = {
      imageHash: "expired123",
      analysis: { room_type: "bedroom", confidence: 0.7 },
      method: "claude_vision",
      cachedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), // 8 days ago
      ttlDays: 7,
    };

    await cache.set("expired123", expiredEntry);
    const retrieved = await cache.get("expired123");
    expect(retrieved).toBeNull();
  });

  it("isolates entries by image hash", async () => {
    const cache = createAnalysisCache(TEST_CACHE_PATH);

    await cache.set("hash-a", {
      imageHash: "hash-a",
      analysis: { room_type: "kitchen", confidence: 0.8 },
      method: "gemini_vision",
      cachedAt: new Date().toISOString(),
      ttlDays: 7,
    });

    await cache.set("hash-b", {
      imageHash: "hash-b",
      analysis: { room_type: "bathroom", confidence: 0.6 },
      method: "text_inference",
      cachedAt: new Date().toISOString(),
      ttlDays: 7,
    });

    const a = await cache.get("hash-a");
    const b = await cache.get("hash-b");
    expect(a!.analysis.room_type).toBe("kitchen");
    expect(b!.analysis.room_type).toBe("bathroom");
  });

  it("clears all entries", async () => {
    const cache = createAnalysisCache(TEST_CACHE_PATH);

    await cache.set("test1", {
      imageHash: "test1",
      analysis: { room_type: "den", confidence: 0.5 },
      method: "text_inference",
      cachedAt: new Date().toISOString(),
      ttlDays: 7,
    });

    await cache.clear();
    const result = await cache.get("test1");
    expect(result).toBeNull();
  });
});
