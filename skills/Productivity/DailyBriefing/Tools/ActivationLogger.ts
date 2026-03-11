#!/usr/bin/env bun
/**
 * ActivationLogger.ts - Append-only JSONL logger for strategy activation events
 *
 * Logs nudges, responses, and skips for lead measure activation cron jobs.
 * Append-only design for safe concurrent writes.
 *
 * Usage:
 *   bun ActivationLogger.ts log <strategyId> <type> <message>
 *   bun ActivationLogger.ts query --since 24h [--strategy S0]
 */

import { existsSync, appendFileSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { parseArgs } from "util";

const KAYA_HOME = process.env.KAYA_DIR || join(process.env.HOME!, ".claude");
const ACTIVATION_DIR = join(KAYA_HOME, "MEMORY", "ACTIVATION");
const LOG_FILE = join(ACTIVATION_DIR, "activation-log.jsonl");

interface ActivationEntry {
  timestamp: string;
  strategyId: string;
  type: "nudge" | "response" | "skip";
  message: string;
  metadata?: Record<string, unknown>;
}

/**
 * Append a single entry to the JSONL log file.
 * Uses appendFileSync for atomic append — no read-modify-write.
 */
export function logActivation(
  strategyId: string,
  type: ActivationEntry["type"],
  message: string,
  metadata?: Record<string, unknown>
): ActivationEntry {
  if (!existsSync(ACTIVATION_DIR)) {
    mkdirSync(ACTIVATION_DIR, { recursive: true });
  }

  const entry: ActivationEntry = {
    timestamp: new Date().toISOString(),
    strategyId,
    type,
    message,
    ...(metadata ? { metadata } : {}),
  };

  appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  return entry;
}

/**
 * Query activation log entries with optional filters.
 */
export function queryActivations(options: {
  since?: string; // Duration like "24h", "7d", "1h"
  strategy?: string; // Filter by strategyId
}): ActivationEntry[] {
  if (!existsSync(LOG_FILE)) return [];

  const content = readFileSync(LOG_FILE, "utf-8").trim();
  if (!content) return [];

  const entries: ActivationEntry[] = content
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as ActivationEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is ActivationEntry => e !== null);

  let filtered = entries;

  // Filter by time
  if (options.since) {
    const sinceDate = parseDuration(options.since);
    if (sinceDate) {
      filtered = filtered.filter((e) => new Date(e.timestamp) >= sinceDate);
    }
  }

  // Filter by strategy
  if (options.strategy) {
    filtered = filtered.filter((e) => e.strategyId === options.strategy);
  }

  return filtered;
}

function parseDuration(duration: string): Date | null {
  const match = duration.match(/^(\d+)(h|d|m)$/);
  if (!match) return null;

  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  const now = new Date();

  switch (unit) {
    case "h":
      return new Date(now.getTime() - value * 60 * 60 * 1000);
    case "d":
      return new Date(now.getTime() - value * 24 * 60 * 60 * 1000);
    case "m":
      return new Date(now.getTime() - value * 60 * 1000);
    default:
      return null;
  }
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "log") {
    const strategyId = args[1];
    const type = args[2] as ActivationEntry["type"];
    const message = args.slice(3).join(" ");

    if (!strategyId || !type || !message) {
      console.error("Usage: bun ActivationLogger.ts log <strategyId> <type> <message>");
      console.error("  type: nudge | response | skip");
      process.exit(1);
    }

    if (!["nudge", "response", "skip"].includes(type)) {
      console.error("Invalid type. Must be: nudge, response, or skip");
      process.exit(1);
    }

    const entry = logActivation(strategyId, type, message);
    console.log("Logged:", JSON.stringify(entry, null, 2));
  } else if (command === "query") {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        since: { type: "string" },
        strategy: { type: "string" },
      },
    });

    const results = queryActivations({
      since: values.since,
      strategy: values.strategy,
    });

    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(`ActivationLogger — Append-only strategy activation log

Usage:
  bun ActivationLogger.ts log <strategyId> <type> <message>
  bun ActivationLogger.ts query [--since 24h] [--strategy S0]

Commands:
  log     Append an activation event
  query   Query activation history

Types:
  nudge     Scheduled reminder was delivered
  response  User responded to a nudge
  skip      User skipped/dismissed a nudge

Examples:
  bun ActivationLogger.ts log S0 nudge "Time for a boredom block"
  bun ActivationLogger.ts query --since 24h
  bun ActivationLogger.ts query --since 7d --strategy S6`);
  }
}
