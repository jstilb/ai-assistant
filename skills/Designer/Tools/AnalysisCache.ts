#!/usr/bin/env bun
/**
 * AnalysisCache.ts - StateManager-backed caching for room analysis results
 *
 * Caches room analysis results keyed by image SHA-256 hash with configurable TTL.
 * Uses CORE StateManager for atomic persistence with schema validation.
 *
 * Usage:
 *   import { createAnalysisCache } from './AnalysisCache';
 *   const cache = createAnalysisCache();
 *   await cache.set('sha256hash', entry);
 *   const cached = await cache.get('sha256hash');
 *
 * @module AnalysisCache
 */

import { z } from "zod";
import { createStateManager, type StateManager } from "../../CORE/Tools/StateManager.ts";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnalysisCacheEntry {
  imageHash: string;
  analysis: Record<string, unknown>;
  method: string;
  cachedAt: string;
  ttlDays: number;
}

export interface AnalysisCache {
  get(imageHash: string): Promise<AnalysisCacheEntry | null>;
  set(imageHash: string, entry: AnalysisCacheEntry): Promise<void>;
  clear(): Promise<void>;
  size(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Schema -- uses array storage to avoid Zod v4 record key issues
// ---------------------------------------------------------------------------

const CacheEntrySchema = z.object({
  imageHash: z.string(),
  analysis: z.any(),
  method: z.string(),
  cachedAt: z.string(),
  ttlDays: z.number().default(7),
});

const CacheStateSchema = z.object({
  entries: z.array(CacheEntrySchema).default([]),
  lastUpdated: z.string(),
});

type CacheState = z.infer<typeof CacheStateSchema>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PATH = join(
  process.env.HOME || "",
  ".claude/skills/Designer/data/analysis-cache.json",
);

const DEFAULT_TTL_DAYS = 7;

// ---------------------------------------------------------------------------
// TTL check
// ---------------------------------------------------------------------------

function isExpired(entry: AnalysisCacheEntry): boolean {
  const cachedTime = new Date(entry.cachedAt).getTime();
  const ttlMs = (entry.ttlDays || DEFAULT_TTL_DAYS) * 24 * 60 * 60 * 1000;
  return Date.now() - cachedTime > ttlMs;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAnalysisCache(cachePath?: string): AnalysisCache {
  const path = cachePath || DEFAULT_PATH;

  const stateManager: StateManager<CacheState> = createStateManager({
    path,
    schema: CacheStateSchema,
    defaults: { entries: [], lastUpdated: new Date().toISOString() },
    backupOnWrite: false,
  });

  return {
    async get(imageHash: string): Promise<AnalysisCacheEntry | null> {
      const state = await stateManager.load();
      const entry = state.entries.find((e) => e.imageHash === imageHash);
      if (!entry) return null;

      // Cast from Zod-parsed type to our interface
      const cacheEntry: AnalysisCacheEntry = {
        imageHash: entry.imageHash,
        analysis: entry.analysis as Record<string, unknown>,
        method: entry.method,
        cachedAt: entry.cachedAt,
        ttlDays: entry.ttlDays,
      };

      if (isExpired(cacheEntry)) {
        // Lazily remove expired entries
        await stateManager.update((s) => ({
          ...s,
          entries: s.entries.filter((e) => e.imageHash !== imageHash),
          lastUpdated: new Date().toISOString(),
        }));
        return null;
      }
      return cacheEntry;
    },

    async set(imageHash: string, entry: AnalysisCacheEntry): Promise<void> {
      await stateManager.update((state) => ({
        ...state,
        entries: [
          ...state.entries.filter((e) => e.imageHash !== imageHash),
          entry,
        ],
        lastUpdated: new Date().toISOString(),
      }));
    },

    async clear(): Promise<void> {
      await stateManager.save({
        entries: [],
        lastUpdated: new Date().toISOString(),
      });
    },

    async size(): Promise<number> {
      const state = await stateManager.load();
      return state.entries.length;
    },
  };
}
