#!/usr/bin/env bun
/**
 * ContentStore.ts - Persistent Content Archive
 *
 * Stores collected content items with date partitioning (monthly files).
 * Provides search by topic, source, date range, and keyword.
 * Uses StateManager for type-safe persistence.
 *
 * Storage: MEMORY/CONTENT/{YYYY-MM}.json (monthly partitions)
 *
 * CLI Usage:
 *   bun ContentStore.ts --recent [N]              Show N most recent items (default 20)
 *   bun ContentStore.ts --search "query"          Search by keyword
 *   bun ContentStore.ts --topic "ai"              Filter by topic
 *   bun ContentStore.ts --stats                   Show archive statistics
 *   bun ContentStore.ts --json                    JSON output
 */

import { createStateManager } from "../../../skills/CORE/Tools/StateManager.ts";
import { existsSync, mkdirSync, readdirSync, appendFileSync } from "fs";
import { join } from "path";
import {
  type ContentItem,
  type ContentStoreState,
  ContentStoreStateSchema,
  CONTENT_STORE_DIR,
  METRICS_PATH,
} from "./types.ts";

// ============================================================================
// Partition Management
// ============================================================================

function getPartitionKey(date?: string): string {
  const d = date ? new Date(date) : new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function getPartitionPath(partitionKey: string): string {
  return join(CONTENT_STORE_DIR, `${partitionKey}.json`);
}

function ensureStoreDir(): void {
  if (!existsSync(CONTENT_STORE_DIR)) {
    mkdirSync(CONTENT_STORE_DIR, { recursive: true });
  }
}

function getPartitionManager(partitionKey: string) {
  return createStateManager<ContentStoreState>({
    path: getPartitionPath(partitionKey),
    schema: ContentStoreStateSchema,
    defaults: {
      items: [],
      lastUpdated: "",
      totalCollected: 0,
      totalDeduped: 0,
    },
  });
}

// ============================================================================
// Store API
// ============================================================================

/**
 * Add items to the content store, partitioned by collection date
 */
export async function storeItems(items: ContentItem[]): Promise<{
  stored: number;
  partitions: string[];
}> {
  ensureStoreDir();

  // Group items by partition
  const byPartition = new Map<string, ContentItem[]>();
  for (const item of items) {
    const key = getPartitionKey(item.collectedAt);
    if (!byPartition.has(key)) byPartition.set(key, []);
    byPartition.get(key)!.push(item);
  }

  const partitions: string[] = [];
  let stored = 0;

  for (const [partitionKey, partitionItems] of byPartition) {
    const manager = getPartitionManager(partitionKey);
    await manager.update((state) => ({
      ...state,
      items: [...state.items, ...partitionItems],
      totalCollected: state.totalCollected + partitionItems.length,
    }));
    partitions.push(partitionKey);
    stored += partitionItems.length;
  }

  return { stored, partitions };
}

/**
 * Get recent items across all partitions
 */
export async function getRecentItems(limit = 20): Promise<ContentItem[]> {
  ensureStoreDir();

  const partitions = listPartitions();
  const allItems: ContentItem[] = [];

  // Read from most recent partitions first
  for (const partition of partitions.reverse()) {
    const manager = getPartitionManager(partition);
    const state = await manager.load();
    allItems.push(...state.items);

    if (allItems.length >= limit * 2) break; // Get enough to sort and slice
  }

  // Sort by publishedAt descending and return top N
  return allItems
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    .slice(0, limit);
}

/**
 * Get items collected today
 */
export async function getTodaysItems(): Promise<ContentItem[]> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const partition = getPartitionKey();
  const manager = getPartitionManager(partition);
  const state = await manager.load();

  return state.items.filter(
    (item) => item.collectedAt.slice(0, 10) === today
  );
}

/**
 * Get items that haven't been delivered yet
 */
export async function getUndeliveredItems(limit = 50): Promise<ContentItem[]> {
  const items = await getRecentItems(limit * 2);
  return items
    .filter((item) => item.status === "new" || item.status === "scored")
    .slice(0, limit);
}

/**
 * Search items by keyword in title and body
 */
export async function searchItems(
  query: string,
  options: { topic?: string; limit?: number; months?: number } = {}
): Promise<ContentItem[]> {
  const { topic, limit = 20, months = 3 } = options;
  ensureStoreDir();

  const queryLower = query.toLowerCase();
  const partitions = listPartitions().slice(-months); // Last N months
  const results: ContentItem[] = [];

  for (const partition of partitions) {
    const manager = getPartitionManager(partition);
    const state = await manager.load();

    for (const item of state.items) {
      // Keyword match
      const matchesQuery =
        item.title.toLowerCase().includes(queryLower) ||
        item.body.toLowerCase().includes(queryLower) ||
        item.tags.some((t) => t.toLowerCase().includes(queryLower));

      // Topic filter
      const matchesTopic =
        !topic ||
        item.topics.includes(topic) ||
        item.tags.includes(topic);

      if (matchesQuery && matchesTopic) {
        results.push(item);
      }

      if (results.length >= limit) break;
    }

    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Get items by topic
 */
export async function getItemsByTopic(
  topic: string,
  limit = 20
): Promise<ContentItem[]> {
  ensureStoreDir();
  const topicLower = topic.toLowerCase();
  const partitions = listPartitions().slice(-3);
  const results: ContentItem[] = [];

  for (const partition of partitions.reverse()) {
    const manager = getPartitionManager(partition);
    const state = await manager.load();

    for (const item of state.items) {
      if (
        item.topics.some((t) => t.toLowerCase() === topicLower) ||
        item.tags.some((t) => t.toLowerCase() === topicLower)
      ) {
        results.push(item);
      }
      if (results.length >= limit) break;
    }
    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Update item status (e.g., mark as delivered)
 */
export async function updateItemStatus(
  itemId: string,
  status: ContentItem["status"],
  deliveredVia?: string
): Promise<boolean> {
  const partitions = listPartitions();

  for (const partition of partitions.reverse()) {
    const manager = getPartitionManager(partition);
    const state = await manager.load();
    const idx = state.items.findIndex((i) => i.id === itemId);

    if (idx !== -1) {
      await manager.update((s) => ({
        ...s,
        items: s.items.map((item) =>
          item.id === itemId
            ? {
                ...item,
                status,
                deliveredVia: deliveredVia
                  ? [...item.deliveredVia, deliveredVia]
                  : item.deliveredVia,
              }
            : item
        ),
      }));
      return true;
    }
  }

  return false;
}

/**
 * Get archive statistics
 */
export async function getArchiveStats(): Promise<{
  totalItems: number;
  partitions: number;
  partitionDetails: Array<{ key: string; items: number; collected: number; deduped: number }>;
  topicCounts: Record<string, number>;
  sourceCounts: Record<string, number>;
}> {
  ensureStoreDir();
  const partitions = listPartitions();
  let totalItems = 0;
  const topicCounts: Record<string, number> = {};
  const sourceCounts: Record<string, number> = {};
  const partitionDetails: Array<{ key: string; items: number; collected: number; deduped: number }> = [];

  for (const partition of partitions) {
    const manager = getPartitionManager(partition);
    const state = await manager.load();
    totalItems += state.items.length;

    partitionDetails.push({
      key: partition,
      items: state.items.length,
      collected: state.totalCollected,
      deduped: state.totalDeduped,
    });

    for (const item of state.items) {
      for (const tag of item.tags) {
        topicCounts[tag] = (topicCounts[tag] || 0) + 1;
      }
      sourceCounts[item.sourceId] = (sourceCounts[item.sourceId] || 0) + 1;
    }
  }

  return {
    totalItems,
    partitions: partitions.length,
    partitionDetails,
    topicCounts,
    sourceCounts,
  };
}

/**
 * Log collection metrics
 */
export async function logMetrics(metrics: Record<string, unknown>): Promise<void> {
  ensureStoreDir();
  const entry = {
    timestamp: new Date().toISOString(),
    ...metrics,
  };
  const line = JSON.stringify(entry) + "\n";

  const metricsDir = join(CONTENT_STORE_DIR, "..");
  if (!existsSync(metricsDir)) mkdirSync(metricsDir, { recursive: true });

  // Append to JSONL file instead of overwriting
  appendFileSync(METRICS_PATH, line, { mode: 0o644 });
}

// ============================================================================
// Internal Helpers
// ============================================================================

function listPartitions(): string[] {
  if (!existsSync(CONTENT_STORE_DIR)) return [];

  return readdirSync(CONTENT_STORE_DIR)
    .filter((f) => f.endsWith(".json") && /^\d{4}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(".json", ""))
    .sort();
}

// ============================================================================
// CLI Interface
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const hasFlag = (name: string) => args.includes(name);
  const getArg = (name: string): string | undefined => {
    const idx = args.indexOf(name);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
  };
  const jsonOutput = hasFlag("--json");

  if (hasFlag("--help") || args.length === 0) {
    console.log(`
ContentStore - Persistent Content Archive

Usage:
  bun ContentStore.ts --recent [N]              Show N most recent items (default 20)
  bun ContentStore.ts --today                   Show today's collected items
  bun ContentStore.ts --search "query"          Search by keyword
  bun ContentStore.ts --topic "ai"              Filter by topic
  bun ContentStore.ts --stats                   Show archive statistics
  bun ContentStore.ts --json                    JSON output
`);
    return;
  }

  if (hasFlag("--stats")) {
    const stats = await getArchiveStats();
    if (jsonOutput) {
      console.log(JSON.stringify(stats, null, 2));
    } else {
      console.log(`\n  Content Archive Statistics:`);
      console.log(`  -------------------------`);
      console.log(`  Total items:    ${stats.totalItems}`);
      console.log(`  Partitions:     ${stats.partitions}`);
      console.log();

      if (stats.partitionDetails.length > 0) {
        console.log("  Partitions:");
        for (const p of stats.partitionDetails) {
          console.log(`    ${p.key}: ${p.items} items (${p.collected} collected, ${p.deduped} deduped)`);
        }
        console.log();
      }

      const sortedTopics = Object.entries(stats.topicCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      if (sortedTopics.length > 0) {
        console.log("  Top topics:");
        for (const [topic, count] of sortedTopics) {
          console.log(`    ${topic}: ${count}`);
        }
        console.log();
      }
    }
    return;
  }

  if (hasFlag("--recent")) {
    const limit = parseInt(getArg("--recent") || "20");
    const items = await getRecentItems(limit);
    if (jsonOutput) {
      console.log(JSON.stringify(items, null, 2));
    } else {
      console.log(`\n  Recent items (${items.length}):\n`);
      for (const item of items) {
        const date = new Date(item.publishedAt).toLocaleDateString();
        console.log(`  [${date}] ${item.title}`);
        console.log(`    ${item.url}`);
        console.log(`    Tags: ${item.tags.join(", ")}`);
        console.log();
      }
    }
    return;
  }

  if (hasFlag("--today")) {
    const items = await getTodaysItems();
    if (jsonOutput) {
      console.log(JSON.stringify(items, null, 2));
    } else {
      console.log(`\n  Today's items (${items.length}):\n`);
      for (const item of items) {
        console.log(`  - ${item.title}`);
        console.log(`    ${item.url}`);
      }
      console.log();
    }
    return;
  }

  if (hasFlag("--search")) {
    const query = getArg("--search") || "";
    const topic = getArg("--topic");
    const items = await searchItems(query, { topic });
    if (jsonOutput) {
      console.log(JSON.stringify(items, null, 2));
    } else {
      console.log(`\n  Search results for "${query}" (${items.length}):\n`);
      for (const item of items) {
        console.log(`  - ${item.title}`);
        console.log(`    ${item.url}`);
      }
      console.log();
    }
    return;
  }

  if (hasFlag("--topic")) {
    const topic = getArg("--topic") || "";
    const items = await getItemsByTopic(topic);
    if (jsonOutput) {
      console.log(JSON.stringify(items, null, 2));
    } else {
      console.log(`\n  Items for topic "${topic}" (${items.length}):\n`);
      for (const item of items) {
        console.log(`  - ${item.title}`);
        console.log(`    ${item.url}`);
      }
      console.log();
    }
    return;
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
