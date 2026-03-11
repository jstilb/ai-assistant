#!/usr/bin/env bun
/**
 * TranscriptLogger.ts - JSONL structured transcript logging
 *
 * JSON-per-line (JSONL) logging with flush-on-write for crash safety.
 * Each event captures: timestamp, agent_id, tool_name, trigger_condition,
 * fault_type, fault_params, outcome.
 *
 * Usage:
 *   import { createTranscriptLogger } from "./TranscriptLogger.ts";
 *   const logger = createTranscriptLogger("/path/to/transcript.jsonl");
 *   logger.log({ timestamp: "...", agent_id: "...", ... });
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

// ============================================
// TYPES
// ============================================

export interface TranscriptEvent {
  timestamp: string;
  agent_id: string;
  tool_name: string;
  trigger_condition: string;
  fault_type: string;
  fault_params: Record<string, unknown>;
  outcome: string;
}

export interface TranscriptLogger {
  log(event: TranscriptEvent): void;
  getEventCount(): number;
  getPath(): string;
  readAll(): TranscriptEvent[];
}

// ============================================
// IMPLEMENTATION
// ============================================

class TranscriptLoggerImpl implements TranscriptLogger {
  private path: string;
  private eventCount = 0;

  constructor(path: string) {
    this.path = path;
    // Ensure directory exists
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  log(event: TranscriptEvent): void {
    // Serialize to single JSON line + newline
    const line = JSON.stringify(event) + "\n";

    // Flush-on-write: appendFileSync is synchronous, data hits disk immediately
    appendFileSync(this.path, line);
    this.eventCount++;
  }

  getEventCount(): number {
    return this.eventCount;
  }

  getPath(): string {
    return this.path;
  }

  readAll(): TranscriptEvent[] {
    if (!existsSync(this.path)) return [];

    const content = readFileSync(this.path, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    return lines.map((line) => JSON.parse(line) as TranscriptEvent);
  }
}

// ============================================
// FACTORY
// ============================================

export function createTranscriptLogger(path: string): TranscriptLogger {
  return new TranscriptLoggerImpl(path);
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "read": {
      const filePath = args[0];
      if (!filePath || !existsSync(filePath)) {
        console.error("Usage: read <transcript.jsonl>");
        process.exit(1);
      }
      const logger = createTranscriptLogger(filePath);
      const events = logger.readAll();
      console.log(JSON.stringify(events, null, 2));
      break;
    }

    case "count": {
      const filePath = args[0];
      if (!filePath || !existsSync(filePath)) {
        console.error("Usage: count <transcript.jsonl>");
        process.exit(1);
      }
      const content = readFileSync(filePath, "utf-8");
      const count = content.trim().split("\n").filter(Boolean).length;
      console.log(JSON.stringify({ path: filePath, events: count }));
      break;
    }

    default:
      console.log(`TranscriptLogger - JSONL structured transcript logging

Commands:
  read <transcript.jsonl>    Read and display all events
  count <transcript.jsonl>   Count events in transcript`);
      break;
  }
}
