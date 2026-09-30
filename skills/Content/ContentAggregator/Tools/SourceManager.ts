#!/usr/bin/env bun
/**
 * SourceManager.ts - Content Source Registry Manager
 *
 * Manages the registry of content sources (RSS feeds, blogs, etc.).
 * Uses StateManager for type-safe persistence with Zod validation.
 * Uses shared types from types.ts for consistency across all tools.
 *
 * CLI Usage:
 *   bun SourceManager.ts list [--enabled] [--json]
 *   bun SourceManager.ts add --name "X" --url "Y" --type rss --topics "ai,tech"
 *   bun SourceManager.ts remove --id "source-id"
 *   bun SourceManager.ts enable --id "source-id"
 *   bun SourceManager.ts disable --id "source-id"
 *   bun SourceManager.ts --health
 *   bun SourceManager.ts --init
 *
 * @author Kaya System
 * @version 1.1.0
 */

import { createStateManager } from "../../../../lib/core/StateManager.ts";
import {
  type ContentSource,
  type SourceRegistry,
  SourceRegistrySchema,
  SOURCES_PATH,
} from "./types.ts";

// ============================================================================
// State Manager (uses shared Zod schema from types.ts)
// ============================================================================

const sourceState = createStateManager<SourceRegistry>({
  path: SOURCES_PATH,
  schema: SourceRegistrySchema,
  defaults: { sources: [], lastUpdated: "" },
});

// ============================================================================
// Auto-disable threshold
// ============================================================================

const AUTO_DISABLE_FAILURE_THRESHOLD = 5;

// ============================================================================
// Public API - All functions imported by ContentCollector.ts
// ============================================================================

/**
 * List all registered sources, optionally filtering to enabled-only.
 */
export async function listSources(enabledOnly = false): Promise<ContentSource[]> {
  const state = await sourceState.load();
  return enabledOnly ? state.sources.filter((s) => s.enabled) : state.sources;
}

/**
 * Add a new content source to the registry.
 */
export async function addSource(
  source: Omit<ContentSource, "id" | "healthStatus" | "failureCount">
): Promise<ContentSource> {
  const newSource: ContentSource = {
    ...source,
    id: `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    healthStatus: "healthy",
    failureCount: 0,
  };
  await sourceState.update((s) => ({
    ...s,
    sources: [...s.sources, newSource],
    lastUpdated: new Date().toISOString(),
  }));
  return newSource;
}

/**
 * Remove a source by ID.
 */
export async function removeSource(id: string): Promise<boolean> {
  let found = false;
  await sourceState.update((s) => {
    const filtered = s.sources.filter((src) => src.id !== id);
    found = filtered.length < s.sources.length;
    return { ...s, sources: filtered, lastUpdated: new Date().toISOString() };
  });
  return found;
}

/**
 * Get a single source by ID.
 */
export async function getSource(id: string): Promise<ContentSource | undefined> {
  const state = await sourceState.load();
  return state.sources.find((s) => s.id === id);
}

/**
 * Get all enabled sources that are due for polling based on their pollInterval.
 */
export async function getSourcesDueForPoll(now = new Date()): Promise<ContentSource[]> {
  const state = await sourceState.load();
  return state.sources.filter((source) => {
    if (!source.enabled) return false;
    if (!source.lastPolled) return true;

    const lastPollTime = new Date(source.lastPolled).getTime();
    const nowTime = now.getTime();
    const intervalMs = source.pollInterval * 60 * 1000;

    return nowTime - lastPollTime >= intervalMs;
  });
}

/**
 * Record that a source was polled, updating lastPolled timestamp and
 * optionally storing the content hash for change detection.
 */
export async function recordSourcePoll(id: string, contentHash?: string): Promise<void> {
  await sourceState.update((s) => ({
    ...s,
    sources: s.sources.map((src) =>
      src.id === id
        ? {
            ...src,
            lastPolled: new Date().toISOString(),
            lastContentHash: contentHash || src.lastContentHash,
          }
        : src
    ),
    lastUpdated: new Date().toISOString(),
  }));
}

/**
 * Record a successful collection, resetting failure count and health status.
 */
export async function recordSourceSuccess(id: string, contentHash?: string): Promise<void> {
  await sourceState.update((s) => ({
    ...s,
    sources: s.sources.map((src) =>
      src.id === id
        ? {
            ...src,
            healthStatus: "healthy" as const,
            failureCount: 0,
            lastContentHash: contentHash || src.lastContentHash,
          }
        : src
    ),
    lastUpdated: new Date().toISOString(),
  }));
}

/**
 * Record a collection failure. Increments failure count and updates health.
 * Auto-disables source after AUTO_DISABLE_FAILURE_THRESHOLD consecutive failures.
 * Returns whether the source was auto-disabled.
 */
export async function recordSourceFailure(
  id: string
): Promise<{ disabled: boolean }> {
  let disabled = false;

  await sourceState.update((s) => ({
    ...s,
    sources: s.sources.map((src) => {
      if (src.id !== id) return src;

      const newFailureCount = src.failureCount + 1;
      let healthStatus: "healthy" | "degraded" | "failing" = "healthy";
      let enabled = src.enabled;

      if (newFailureCount >= AUTO_DISABLE_FAILURE_THRESHOLD) {
        healthStatus = "failing";
        enabled = false;
        disabled = true;
      } else if (newFailureCount >= 3) {
        healthStatus = "failing";
      } else if (newFailureCount >= 1) {
        healthStatus = "degraded";
      }

      return {
        ...src,
        failureCount: newFailureCount,
        healthStatus,
        enabled,
      };
    }),
    lastUpdated: new Date().toISOString(),
  }));

  return { disabled };
}

/**
 * Enable a source by ID, resetting its failure count and health.
 */
export async function enableSource(id: string): Promise<boolean> {
  let found = false;
  await sourceState.update((s) => ({
    ...s,
    sources: s.sources.map((src) => {
      if (src.id !== id) return src;
      found = true;
      return { ...src, enabled: true, failureCount: 0, healthStatus: "healthy" as const };
    }),
    lastUpdated: new Date().toISOString(),
  }));
  return found;
}

/**
 * Disable a source by ID.
 */
export async function disableSource(id: string): Promise<boolean> {
  let found = false;
  await sourceState.update((s) => ({
    ...s,
    sources: s.sources.map((src) => {
      if (src.id !== id) return src;
      found = true;
      return { ...src, enabled: false };
    }),
    lastUpdated: new Date().toISOString(),
  }));
  return found;
}

/**
 * Get trust scores for all sources as a Map<sourceId, trustScore>.
 * Used by Pipeline for deduplication and scoring.
 */
export async function getSourceTrustScores(): Promise<Map<string, number>> {
  const state = await sourceState.load();
  const scores = new Map<string, number>();
  for (const src of state.sources) {
    scores.set(src.id, src.trustScore);
  }
  return scores;
}

// ============================================================================
// CLI Interface
// ============================================================================

const ANSI = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const hasFlag = (name: string) => args.includes(name);
  const getArg = (name: string): string | undefined => {
    const idx = args.indexOf(name);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
  };

  if (hasFlag("--help") || args.length === 0) {
    console.log(`
${ANSI.bold("SourceManager.ts")} - Content Source Registry

${ANSI.cyan("Commands:")}
  list [--enabled] [--json]    List all sources
  add --name "X" --url "Y"    Add a new source
    --type rss --topics "ai,tech" [--trust 80] [--interval 60]
  remove --id "source-id"     Remove a source
  enable --id "source-id"     Enable a source
  disable --id "source-id"    Disable a source

${ANSI.cyan("Options:")}
  --health                    Show source health summary
  --json                      JSON output
  --help                      Show this help
`);
    process.exit(0);
  }

  const jsonOutput = hasFlag("--json");
  const command = args[0];

  if (command === "add") {
    const name = getArg("--name");
    const url = getArg("--url");
    const type = getArg("--type") || "rss";
    const topics = (getArg("--topics") || "").split(",").filter(Boolean);
    const trustScore = parseInt(getArg("--trust") || "70");
    const pollInterval = parseInt(getArg("--interval") || "60");

    if (!name || !url) {
      console.error("Error: --name and --url are required");
      process.exit(1);
    }

    const source = await addSource({
      name,
      url,
      type: type as ContentSource["type"],
      enabled: true,
      trustScore,
      topics,
      pollInterval,
    });

    if (jsonOutput) {
      console.log(JSON.stringify(source, null, 2));
    } else {
      console.log(`${ANSI.green("Added")} ${source.name} (${source.id})`);
    }
  } else if (command === "remove") {
    const id = getArg("--id");
    if (!id) { console.error("Error: --id required"); process.exit(1); }
    const removed = await removeSource(id);
    console.log(removed ? `${ANSI.green("Removed")} ${id}` : `${ANSI.red("Not found:")} ${id}`);
  } else if (command === "enable") {
    const id = getArg("--id");
    if (!id) { console.error("Error: --id required"); process.exit(1); }
    const found = await enableSource(id);
    console.log(found ? `${ANSI.green("Enabled")} ${id}` : `${ANSI.red("Not found:")} ${id}`);
  } else if (command === "disable") {
    const id = getArg("--id");
    if (!id) { console.error("Error: --id required"); process.exit(1); }
    const found = await disableSource(id);
    console.log(found ? `${ANSI.yellow("Disabled")} ${id}` : `${ANSI.red("Not found:")} ${id}`);
  } else if (command === "list" || hasFlag("--health")) {
    const enabledOnly = hasFlag("--enabled");
    const sources = await listSources(enabledOnly);

    if (jsonOutput) {
      console.log(JSON.stringify(sources, null, 2));
    } else {
      console.log(ANSI.bold(`\nContent Sources (${sources.length} registered)\n`));
      for (const s of sources) {
        const status =
          s.healthStatus === "healthy"
            ? ANSI.green("OK")
            : s.healthStatus === "degraded"
              ? ANSI.yellow("WARN")
              : ANSI.red("FAIL");
        const enabled = s.enabled ? ANSI.green("enabled") : ANSI.red("disabled");
        console.log(`  ${status} ${s.name} [${s.topics.join(", ")}] - ${enabled}`);
        if (hasFlag("--health")) {
          console.log(`       URL: ${s.url}`);
          console.log(`       Poll: every ${s.pollInterval}m | Trust: ${s.trustScore} | Failures: ${s.failureCount}`);
          console.log(`       Last polled: ${s.lastPolled || "never"}`);
          console.log();
        }
      }

      if (!hasFlag("--health")) {
        const healthy = sources.filter((s) => s.healthStatus === "healthy").length;
        const degraded = sources.filter((s) => s.healthStatus === "degraded").length;
        const failing = sources.filter((s) => s.healthStatus === "failing").length;
        console.log(`\n  ${ANSI.green(String(healthy))} healthy  ${ANSI.yellow(String(degraded))} degraded  ${ANSI.red(String(failing))} failing\n`);
      }
    }
  } else {
    // Default: list sources
    const sources = await listSources();
    console.log(ANSI.bold(`Content Sources (${sources.length} registered)`));
    for (const s of sources) {
      const status =
        s.healthStatus === "healthy"
          ? ANSI.green("OK")
          : s.healthStatus === "degraded"
            ? ANSI.yellow("WARN")
            : ANSI.red("FAIL");
      console.log(`  ${status} ${s.name} [${s.topics.join(", ")}] - ${s.enabled ? "enabled" : "disabled"}`);
    }
  }
}
