#!/usr/bin/env bun
/**
 * AuditLogger.ts - Per-call logging for Designer API usage
 *
 * Logs each API call with timestamp, image hash, latency, cost, and outcome.
 * PII scrubbing removes file paths, emails, and user data from error messages.
 * No file paths beyond hashes, no email, no user preferences are stored.
 *
 * Usage:
 *   import { createAuditLogger, scrubPII } from './AuditLogger';
 *   const logger = createAuditLogger();
 *   logger.log({ image_hash: '...', api_name: 'claude_vision', ... });
 *
 * @module AuditLogger
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditEntry {
  timestamp: string;
  image_hash: string;
  api_name: string;
  latency_ms: number;
  cost: number;
  success: boolean;
  cache_hit: boolean;
  error_message?: string;
}

export interface AuditLogInput {
  image_hash: string;
  api_name: string;
  latency_ms: number;
  cost: number;
  success: boolean;
  cache_hit: boolean;
  error_message?: string;
}

export interface AuditLogger {
  log(entry: AuditLogInput): void;
  getEntries(): AuditEntry[];
  clear(): void;
}

// ---------------------------------------------------------------------------
// PII scrubbing
// ---------------------------------------------------------------------------

/**
 * Remove personally identifiable information from strings.
 * Strips: file paths, email addresses, home directories.
 */
export function scrubPII(text: string): string {
  if (!text) return text;

  let scrubbed = text;

  // Remove absolute file paths (Unix and macOS)
  // Matches /Users/xxx/..., /home/xxx/..., /tmp/xxx/...
  scrubbed = scrubbed.replace(/\/(?:Users|home)\/[^\s,;'")\]]+/g, "[PATH_REDACTED]");

  // Remove email addresses
  scrubbed = scrubbed.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[EMAIL_REDACTED]");

  // Remove Windows-style paths
  scrubbed = scrubbed.replace(/[A-Z]:\\(?:Users|Documents)[^\s,;'")\]]+/gi, "[PATH_REDACTED]");

  return scrubbed;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAuditLogger(): AuditLogger {
  const entries: AuditEntry[] = [];

  return {
    log(input: AuditLogInput): void {
      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        image_hash: input.image_hash,
        api_name: input.api_name,
        latency_ms: input.latency_ms,
        cost: input.cost,
        success: input.success,
        cache_hit: input.cache_hit,
        error_message: input.error_message ? scrubPII(input.error_message) : undefined,
      };

      entries.push(entry);
    },

    getEntries(): AuditEntry[] {
      return entries.map(e => ({ ...e }));
    },

    clear(): void {
      entries.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  console.log("AuditLogger - per-call logging for Designer API usage");
  console.log("");
  console.log("Usage (programmatic):");
  console.log("  import { createAuditLogger } from './AuditLogger';");
  console.log("  const logger = createAuditLogger();");
  console.log("  logger.log({ image_hash: 'abc', api_name: 'claude_vision', ... });");
}
