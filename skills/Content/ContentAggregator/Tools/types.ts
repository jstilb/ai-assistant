/**
 * types.ts - Shared data types for ContentAggregator
 *
 * Central type definitions and Zod schemas used across all tools.
 */

import { z } from "zod";

// ============================================================================
// Source Types
// ============================================================================

export const SourceTypeEnum = z.enum([
  "rss",
  "twitter",
  "youtube",
  "newsletter",
  "reddit",
  "hn",
  "blog",
  "podcast",
]);
export type SourceType = z.infer<typeof SourceTypeEnum>;

export const HealthStatusEnum = z.enum(["healthy", "degraded", "failing"]);
export type HealthStatus = z.infer<typeof HealthStatusEnum>;

export const ContentSourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: SourceTypeEnum,
  url: z.string().url(),
  enabled: z.boolean(),
  trustScore: z.number().min(0).max(100),
  topics: z.array(z.string()),
  pollInterval: z.number().min(1), // minutes
  lastPolled: z.string().optional(),
  lastContentHash: z.string().optional(),
  healthStatus: HealthStatusEnum,
  failureCount: z.number().min(0),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type ContentSource = z.infer<typeof ContentSourceSchema>;

export const SourceRegistrySchema = z.object({
  sources: z.array(ContentSourceSchema),
  lastUpdated: z.string(),
});
export type SourceRegistry = z.infer<typeof SourceRegistrySchema>;

// ============================================================================
// Content Types
// ============================================================================

export const ContentStatusEnum = z.enum([
  "new",
  "scored",
  "summarized",
  "delivered",
  "archived",
]);
export type ContentStatus = z.infer<typeof ContentStatusEnum>;

export const ContentItemSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  sourceType: SourceTypeEnum,
  title: z.string(),
  url: z.string(),
  canonicalUrl: z.string(),
  author: z.string(),
  publishedAt: z.string(),
  collectedAt: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  topics: z.array(z.string()),
  relevanceScore: z.number().min(0).max(100),
  goalAlignment: z.array(z.string()),
  contentHash: z.string(),
  summary: z.string(),
  status: ContentStatusEnum,
  deliveredVia: z.array(z.string()),
});
export type ContentItem = z.infer<typeof ContentItemSchema>;

export const ContentStoreStateSchema = z.object({
  items: z.array(ContentItemSchema),
  lastUpdated: z.string(),
  totalCollected: z.number(),
  totalDeduped: z.number(),
});
export type ContentStoreState = z.infer<typeof ContentStoreStateSchema>;

// ============================================================================
// Topic Profile Types
// ============================================================================

export const TopicPriorityEnum = z.enum(["high", "medium", "low"]);

export const TopicProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  keywords: z.array(z.string()),
  goalIds: z.array(z.string()),
  priority: TopicPriorityEnum,
  minRelevanceThreshold: z.number().min(0).max(100),
});
export type TopicProfile = z.infer<typeof TopicProfileSchema>;

// ============================================================================
// Collection Result Types
// ============================================================================

export interface CollectionResult {
  sourceId: string;
  sourceName: string;
  itemsFound: number;
  itemsNew: number;
  itemsDuplicate: number;
  error?: string;
  durationMs: number;
}

export interface CollectionSummary {
  totalSources: number;
  successfulSources: number;
  failedSources: number;
  totalItemsFound: number;
  totalNewItems: number;
  totalDuplicates: number;
  durationMs: number;
  results: CollectionResult[];
}

// ============================================================================
// Constants
// ============================================================================

export const KAYA_HOME = process.env.KAYA_DIR || `${process.env.HOME}/.claude`;
export const SOURCES_PATH = `${KAYA_HOME}/skills/Content/ContentAggregator/Tools/sources.json`;
export const CONTENT_STORE_DIR = `${KAYA_HOME}/MEMORY/CONTENT`;
export const DIGESTS_DIR = `${KAYA_HOME}/MEMORY/DIGESTS`;
export const METRICS_PATH = `${KAYA_HOME}/MEMORY/DIGESTS/metrics.jsonl`;
