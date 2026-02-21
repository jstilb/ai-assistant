#!/usr/bin/env bun
/**
 * Pipeline.ts - Content Aggregation Pipeline Orchestrator
 *
 * Orchestrates the full content pipeline:
 *   1. Collect from enabled sources via CachedHTTPClient
 *   2. Deduplicate content items (URL, hash, title similarity)
 *   3. Score and filter by topic relevance
 *   4. Store to archive via StateManager
 *   5. Render digest and optionally deliver
 *
 * Uses Kaya infrastructure tools:
 *   - CachedHTTPClient for HTTP fetching (via ContentCollector)
 *   - StateManager for persistent storage (via ContentStore)
 *   - NotificationService for voice/push alerts
 *
 * CLI Usage:
 *   bun Pipeline.ts                       Run full pipeline
 *   bun Pipeline.ts --collect-only        Collect and store only
 *   bun Pipeline.ts --digest-only         Generate digest from stored items
 *   bun Pipeline.ts --all-sources         Force collect from ALL sources
 *   bun Pipeline.ts --dry-run             Preview without saving
 *   bun Pipeline.ts --json                JSON output
 *
 * @author Kaya System
 * @version 1.1.0
 */

import { collectAll } from "./ContentCollector.ts";
import { deduplicateContent } from "./ContentDeduplicator.ts";
import { scoreAndFilter } from "./TopicMatcher.ts";
import { storeItems, getRecentItems, logMetrics } from "./ContentStore.ts";
import { renderDigest, saveDigest } from "./DigestRenderer.ts";
import { getSourceTrustScores } from "./SourceManager.ts";
import { notifySync } from "../../../skills/CORE/Tools/NotificationService.ts";
import type { ContentItem, CollectionSummary } from "./types.ts";

// ============================================================================
// CLI Argument Parsing
// ============================================================================

const args = process.argv.slice(2);
const hasFlag = (name: string) => args.includes(name);
const getArg = (name: string): string | undefined => {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
};

const collectOnly = hasFlag("--collect-only");
const digestOnly = hasFlag("--digest-only");
const allSources = hasFlag("--all-sources");
const dryRun = hasFlag("--dry-run");
const jsonOutput = hasFlag("--json");
const minScore = parseInt(getArg("--min-score") || "20");

// ============================================================================
// ANSI Helpers
// ============================================================================

const ANSI = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

// ============================================================================
// Pipeline Result Types
// ============================================================================

interface PipelineResult {
  phase: "collect" | "dedupe" | "score" | "store" | "digest";
  collection?: CollectionSummary;
  dedupe?: {
    inputCount: number;
    uniqueCount: number;
    duplicatesRemoved: number;
  };
  scoring?: {
    inputCount: number;
    passedFilter: number;
    filteredOut: number;
    avgScore: number;
  };
  storage?: {
    stored: number;
    partitions: string[];
  };
  digest?: {
    itemCount: number;
    path?: string;
  };
  totalDurationMs: number;
  errors: string[];
}

// ============================================================================
// Pipeline Phases
// ============================================================================

/**
 * Phase 1: Collect content from sources
 */
async function phaseCollect(options: {
  allSources: boolean;
}): Promise<{ items: ContentItem[]; summary: CollectionSummary }> {
  const { items, summary } = await collectAll({
    dueOnly: !options.allSources,
  });

  return { items, summary };
}

/**
 * Phase 2: Deduplicate against existing content
 */
async function phaseDeduplicate(
  newItems: ContentItem[],
  trustScores: Map<string, number>
): Promise<{ unique: ContentItem[]; stats: { inputCount: number; uniqueCount: number; duplicatesRemoved: number } }> {
  // Load recent existing items for cross-dedup
  const existingItems = await getRecentItems(200);

  const { unique, stats } = deduplicateContent(
    newItems,
    existingItems,
    trustScores
  );

  return {
    unique,
    stats: {
      inputCount: stats.inputCount,
      uniqueCount: stats.uniqueCount,
      duplicatesRemoved: stats.inputCount - stats.uniqueCount,
    },
  };
}

/**
 * Phase 3: Score and filter by topic relevance
 */
function phaseScore(
  items: ContentItem[],
  trustScores: Map<string, number>,
  minScoreThreshold: number
): { scored: ContentItem[]; stats: { inputCount: number; passedFilter: number; filteredOut: number; avgScore: number } } {
  const scored = scoreAndFilter(items, undefined, trustScores, minScoreThreshold);

  const avgScore =
    scored.length > 0
      ? Math.round(scored.reduce((sum, i) => sum + i.relevanceScore, 0) / scored.length)
      : 0;

  return {
    scored,
    stats: {
      inputCount: items.length,
      passedFilter: scored.length,
      filteredOut: items.length - scored.length,
      avgScore,
    },
  };
}

/**
 * Phase 4: Store items to persistent archive
 */
async function phaseStore(
  items: ContentItem[]
): Promise<{ stored: number; partitions: string[] }> {
  const result = await storeItems(items);
  return result;
}

/**
 * Phase 5: Render digest from scored items
 */
async function phaseDigest(
  items: ContentItem[],
  save: boolean
): Promise<{ markdown: string; path?: string }> {
  const markdown = renderDigest(items, {
    showScores: true,
    maxPerTopic: 5,
  });

  let path: string | undefined;
  if (save) {
    path = await saveDigest(markdown);
  }

  return { markdown, path };
}

// ============================================================================
// Pipeline Orchestrator
// ============================================================================

async function runPipeline(): Promise<PipelineResult> {
  const startTime = Date.now();
  const result: PipelineResult = {
    phase: "collect",
    totalDurationMs: 0,
    errors: [],
  };

  try {
    // Load trust scores upfront (used by dedupe and scoring)
    const trustScores = await getSourceTrustScores();

    // ---- Phase 1: Collect ----
    let items: ContentItem[] = [];

    if (!digestOnly) {
      result.phase = "collect";
      if (!jsonOutput) {
        console.log(ANSI.bold("\n  Phase 1: Collecting content..."));
      }

      try {
        const { items: collected, summary } = await phaseCollect({ allSources });
        items = collected;
        result.collection = summary;

        if (!jsonOutput) {
          console.log(`    Sources polled: ${summary.totalSources}`);
          console.log(`    Successful: ${ANSI.green(String(summary.successfulSources))}`);
          if (summary.failedSources > 0) {
            console.log(`    Failed: ${ANSI.red(String(summary.failedSources))}`);
          }
          console.log(`    Raw items: ${summary.totalNewItems}`);
          console.log(`    Duration: ${summary.durationMs}ms`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Collection failed: ${msg}`);
        if (!jsonOutput) {
          console.log(`    ${ANSI.red("ERROR")}: ${msg}`);
        }
      }

      // ---- Phase 2: Deduplicate ----
      if (items.length > 0) {
        result.phase = "dedupe";
        if (!jsonOutput) {
          console.log(ANSI.bold("\n  Phase 2: Deduplicating..."));
        }

        try {
          const { unique, stats } = await phaseDeduplicate(items, trustScores);
          items = unique;
          result.dedupe = stats;

          if (!jsonOutput) {
            console.log(`    Input: ${stats.inputCount} items`);
            console.log(`    Unique: ${ANSI.green(String(stats.uniqueCount))}`);
            if (stats.duplicatesRemoved > 0) {
              console.log(`    Duplicates removed: ${ANSI.yellow(String(stats.duplicatesRemoved))}`);
            }
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          result.errors.push(`Deduplication failed: ${msg}`);
          if (!jsonOutput) {
            console.log(`    ${ANSI.red("ERROR")}: ${msg}`);
          }
        }
      }

      // ---- Phase 3: Score & Filter ----
      if (items.length > 0) {
        result.phase = "score";
        if (!jsonOutput) {
          console.log(ANSI.bold("\n  Phase 3: Scoring & filtering..."));
        }

        try {
          const { scored, stats } = phaseScore(items, trustScores, minScore);
          items = scored;
          result.scoring = stats;

          if (!jsonOutput) {
            console.log(`    Input: ${stats.inputCount} items`);
            console.log(`    Passed filter: ${ANSI.green(String(stats.passedFilter))} (min score: ${minScore})`);
            if (stats.filteredOut > 0) {
              console.log(`    Filtered out: ${ANSI.dim(String(stats.filteredOut))}`);
            }
            console.log(`    Avg relevance: ${stats.avgScore}`);
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          result.errors.push(`Scoring failed: ${msg}`);
          if (!jsonOutput) {
            console.log(`    ${ANSI.red("ERROR")}: ${msg}`);
          }
        }
      }

      // ---- Phase 4: Store ----
      if (items.length > 0 && !dryRun) {
        result.phase = "store";
        if (!jsonOutput) {
          console.log(ANSI.bold("\n  Phase 4: Storing to archive..."));
        }

        try {
          const stored = await phaseStore(items);
          result.storage = stored;

          if (!jsonOutput) {
            console.log(`    Stored: ${ANSI.green(String(stored.stored))} items`);
            console.log(`    Partitions: ${stored.partitions.join(", ")}`);
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          result.errors.push(`Storage failed: ${msg}`);
          if (!jsonOutput) {
            console.log(`    ${ANSI.red("ERROR")}: ${msg}`);
          }
        }
      } else if (dryRun && items.length > 0) {
        if (!jsonOutput) {
          console.log(ANSI.bold("\n  Phase 4: " + ANSI.yellow("SKIPPED (dry run)")));
        }
      }

      if (collectOnly) {
        result.totalDurationMs = Date.now() - startTime;
        return result;
      }
    }

    // ---- Phase 5: Generate Digest ----
    if (!collectOnly) {
      result.phase = "digest";

      // If digest-only, load items from store
      if (digestOnly) {
        items = await getRecentItems(50);
        if (!jsonOutput) {
          console.log(ANSI.bold(`\n  Loaded ${items.length} items from archive`));
        }
      }

      if (items.length > 0) {
        if (!jsonOutput) {
          console.log(ANSI.bold("\n  Phase 5: Generating digest..."));
        }

        try {
          const { markdown, path } = await phaseDigest(items, !dryRun);
          result.digest = {
            itemCount: items.length,
            path,
          };

          if (!jsonOutput) {
            if (path) {
              console.log(`    Saved to: ${ANSI.cyan(path)}`);
            }
            console.log(`    Items in digest: ${items.length}`);
            console.log();

            // Print the digest for preview
            if (dryRun || hasFlag("--preview")) {
              console.log(ANSI.dim("--- Digest Preview ---"));
              console.log(markdown);
              console.log(ANSI.dim("--- End Preview ---"));
            }
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          result.errors.push(`Digest generation failed: ${msg}`);
          if (!jsonOutput) {
            console.log(`    ${ANSI.red("ERROR")}: ${msg}`);
          }
        }
      } else {
        if (!jsonOutput) {
          console.log(ANSI.bold("\n  Phase 5: " + ANSI.dim("No items for digest")));
        }
      }
    }

    result.totalDurationMs = Date.now() - startTime;

    // Log metrics
    if (!dryRun) {
      await logMetrics({
        pipeline: "full",
        collected: result.collection?.totalNewItems || 0,
        deduped: result.dedupe?.duplicatesRemoved || 0,
        scored: result.scoring?.passedFilter || 0,
        stored: result.storage?.stored || 0,
        digestItems: result.digest?.itemCount || 0,
        durationMs: result.totalDurationMs,
        errors: result.errors.length,
      }).catch(() => {}); // Non-blocking metrics
    }

    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Pipeline error: ${msg}`);
    result.totalDurationMs = Date.now() - startTime;
    return result;
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

if (args.includes("--help")) {
  console.log(`
${ANSI.bold("Pipeline.ts")} - Content Aggregation Pipeline

${ANSI.cyan("Usage:")}
  bun Pipeline.ts [options]

${ANSI.cyan("Modes:")}
  (default)          Full pipeline: collect -> dedupe -> score -> store -> digest
  --collect-only     Collect, dedupe, score, and store only (no digest)
  --digest-only      Generate digest from already-stored items only
  --all-sources      Force collect from ALL sources (not just due ones)

${ANSI.cyan("Options:")}
  --dry-run          Preview without saving to disk
  --preview          Show digest preview in terminal
  --min-score <N>    Minimum relevance score to keep (default: 20)
  --json             JSON output
  --help             Show this help

${ANSI.cyan("Examples:")}
  bun Pipeline.ts                          Full pipeline
  bun Pipeline.ts --collect-only           Just collect and store
  bun Pipeline.ts --digest-only --preview  Generate digest from stored items
  bun Pipeline.ts --all-sources --dry-run  Preview all sources without saving
`);
  process.exit(0);
}

if (import.meta.main) {
  const mode = digestOnly ? "digest-only" : collectOnly ? "collect-only" : "full";

  if (!jsonOutput) {
    console.log(ANSI.bold("\n  Content Aggregation Pipeline"));
    console.log(`  Mode: ${ANSI.cyan(mode)}`);
    if (dryRun) console.log(`  ${ANSI.yellow("DRY RUN - no changes will be saved")}`);
    if (allSources) console.log(`  ${ANSI.cyan("Collecting from ALL sources (ignoring poll schedule)")}`);
  }

  // Send voice notification
  notifySync(`Running content pipeline in ${mode} mode`);

  const result = await runPipeline();

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    // Summary
    console.log(ANSI.bold("\n  Pipeline Complete"));
    console.log(`  ${"=".repeat(40)}`);
    console.log(`  Duration: ${result.totalDurationMs}ms`);
    if (result.collection) {
      console.log(`  Sources: ${result.collection.successfulSources}/${result.collection.totalSources}`);
    }
    if (result.dedupe) {
      console.log(`  Deduped: ${result.dedupe.uniqueCount} unique (${result.dedupe.duplicatesRemoved} removed)`);
    }
    if (result.scoring) {
      console.log(`  Scored: ${result.scoring.passedFilter} passed (avg: ${result.scoring.avgScore})`);
    }
    if (result.storage) {
      console.log(`  Stored: ${result.storage.stored} items`);
    }
    if (result.digest) {
      console.log(`  Digest: ${result.digest.itemCount} items`);
      if (result.digest.path) {
        console.log(`  Path: ${result.digest.path}`);
      }
    }
    if (result.errors.length > 0) {
      console.log(`  ${ANSI.red(`Errors: ${result.errors.length}`)}`);
      for (const err of result.errors) {
        console.log(`    - ${err}`);
      }
    }
    console.log();
  }

  // Voice notification with summary
  const itemCount = result.storage?.stored || result.digest?.itemCount || 0;
  if (itemCount > 0) {
    notifySync(`Pipeline complete. ${itemCount} items processed.`);
  }

  process.exit(result.errors.length > 0 ? 1 : 0);
}
