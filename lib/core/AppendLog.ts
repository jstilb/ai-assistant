/**
 * AppendLog — Factory for append-only JSONL logs with rotation and retention.
 *
 * Usage:
 *   import { createAppendLog } from 'lib/core/AppendLog.ts';
 *
 *   const log = createAppendLog('/path/to/file.jsonl', {
 *     maxSizeMB: 5,         // rotate at 5 MB
 *     retentionDays: 90,    // delete files older than 90 days
 *     maxRotatedFiles: 5,   // keep at most 5 rotated files
 *   });
 *
 *   log.append({ event: 'foo', ts: Date.now() });  // atomic JSONL append
 *   log.rotate();                                   // force rotation now
 *   log.cleanup();                                  // enforce retention
 *   log.size();                                     // current file size in bytes
 *
 * Note: maxSizeMB takes precedence if both maxSizeMB and maxSizeBytes are provided.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'fs';
import { basename, dirname, join } from 'path';

export interface AppendLogOptions {
  /** Rotate when file exceeds this size in bytes. Default: 10 MB */
  maxSizeBytes?: number;
  /** Rotate when file exceeds this size in MB. Takes precedence over maxSizeBytes. Default: 10 */
  maxSizeMB?: number;
  /** Delete rotated files older than this many days. Default: 90 */
  retentionDays?: number;
  /** Keep at most this many rotated files (oldest deleted first). Default: 10 */
  maxRotatedFiles?: number;
  /** Encoding. Default: 'utf-8' */
  encoding?: BufferEncoding;
  /** Flush synchronously on each append. Default: true */
  flushOnAppend?: boolean;
  /**
   * File mode applied when the log file is CREATED (including re-creation
   * after rotation). Existing files keep their mode. Default: process umask.
   */
  fileMode?: number;
}

export interface AppendLogStats {
  lines: number;
  sizeBytes: number;
  rotatedFiles: number;
}

export interface AppendLog {
  /** Append a record as a single JSON line. Creates file + dirs if needed. */
  append<T extends object>(record: T): void;
  /** Append a raw string line (must not contain newlines). Adds \n if absent. */
  appendRaw(line: string): void;
  /** Convenience alias for append() — typed wrapper around append(JSON.stringify(obj)). */
  appendJson<T extends object>(obj: T): void;
  /**
   * Read the last N JSON lines from the active file, oldest first.
   * Returns an empty array if the file does not exist or has no valid
   * lines. Skips malformed lines silently. Mirrors the former standalone
   * JSONL-reader helper this module absorbed (S6 — one append-log seam).
   */
  readLastN<T = Record<string, unknown>>(n: number): T[];
  /** Rotate the current file now if it exceeds maxSizeBytes. Returns rotated file path or empty string if no rotation. */
  rotate(): string;
  /** Delete rotated files beyond retentionDays / maxRotatedFiles. Returns count of deleted files. */
  cleanup(): number;
  /**
   * Rotated sibling paths for this log, oldest first by embedded rotation
   * timestamp. Does NOT include the active file. Empty array if no rotation
   * has ever occurred. Callers that need full historical data (e.g. graph
   * readers merging rotated shards) should read these in order, then the
   * active file last, so the active file wins any id collisions.
   */
  rotatedPaths(): string[];
  /** Return size of the current (active) file in bytes. 0 if file does not exist. */
  size(): number;
  /** Absolute path to the active file. */
  readonly path: string;
  /** Live stats from the current file. */
  readonly stats: AppendLogStats;
}

/** Rotation file pattern: <basename>.<ISO-timestamp>.jsonl */
const ROTATION_PATTERN = /\.(\d{4}-\d{2}-\d{2}T[\d\-:.]+Z)\.jsonl$/;

function getRotationBase(filePath: string): string {
  // Strip .jsonl extension for rotation prefix
  if (filePath.endsWith('.jsonl')) {
    return filePath.slice(0, -'.jsonl'.length);
  }
  return filePath;
}

function listRotatedFiles(filePath: string): string[] {
  const dir = dirname(filePath);
  const base = basename(getRotationBase(filePath));
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(f => f.startsWith(base) && ROTATION_PATTERN.test(f))
      .map(f => join(dir, f));
  } catch {
    return [];
  }
}

/** Embedded rotation timestamp string, or '' if the filename doesn't match. */
function extractRotationTimestamp(filePath: string): string {
  const match = basename(filePath).match(ROTATION_PATTERN);
  return match ? match[1] : '';
}

/**
 * Sort rotated file paths oldest-first by their embedded ISO timestamp.
 * The timestamp format (colons/dots replaced with '-') is fixed-width and
 * lexicographically sortable in chronological order.
 */
function sortRotatedOldestFirst(paths: string[]): string[] {
  return [...paths].sort((a, b) =>
    extractRotationTimestamp(a).localeCompare(extractRotationTimestamp(b)),
  );
}

export function createAppendLog(filePath: string, options: AppendLogOptions = {}): AppendLog {
  const maxSizeBytes =
    options.maxSizeMB !== undefined
      ? options.maxSizeMB * 1024 * 1024
      : (options.maxSizeBytes ?? 10 * 1024 * 1024);
  const retentionDays = options.retentionDays ?? 90;
  const maxRotatedFiles = options.maxRotatedFiles ?? 10;
  const encoding = options.encoding ?? 'utf-8';
  // appendFileSync applies `mode` only on create (O_CREAT) — exactly the
  // "applied when the file is created" contract fileMode documents.
  const writeOpts: import('fs').WriteFileOptions =
    options.fileMode !== undefined ? { encoding, mode: options.fileMode } : { encoding };

  let _dirEnsured = false;

  function ensureDir(): void {
    if (_dirEnsured) return;
    mkdirSync(dirname(filePath), { recursive: true });
    _dirEnsured = true;
  }

  function currentSize(): number {
    try {
      return existsSync(filePath) ? statSync(filePath).size : 0;
    } catch {
      return 0;
    }
  }

  function doRotate(): string {
    if (!existsSync(filePath)) return '';
    if (currentSize() === 0) return '';

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const rotatedPath = `${getRotationBase(filePath)}.${ts}.jsonl`;
    try {
      renameSync(filePath, rotatedPath);
      _dirEnsured = false; // file gone — re-ensure on next write
      doCleanup();
      return rotatedPath;
    } catch (err) {
      console.error('[AppendLog] rotation failed:', err);
      return '';
    }
  }

  function doCleanup(): number {
    const rotated = listRotatedFiles(filePath);
    const now = Date.now();
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
    let deleted = 0;

    // Delete files older than retentionDays
    const surviving: string[] = [];
    for (const f of rotated) {
      try {
        const mtime = statSync(f).mtimeMs;
        if (now - mtime > retentionMs) {
          unlinkSync(f);
          deleted++;
        } else {
          surviving.push(f);
        }
      } catch {
        surviving.push(f); // can't stat — keep
      }
    }

    // Delete oldest files beyond maxRotatedFiles
    if (surviving.length > maxRotatedFiles) {
      // Sort by mtime ascending (oldest first)
      const withMtime = surviving.map(f => {
        try {
          return { f, mtime: statSync(f).mtimeMs };
        } catch {
          return { f, mtime: 0 };
        }
      });
      withMtime.sort((a, b) => a.mtime - b.mtime);
      const toDelete = withMtime.slice(0, surviving.length - maxRotatedFiles);
      for (const { f } of toDelete) {
        try {
          unlinkSync(f);
          deleted++;
        } catch {
          // ignore
        }
      }
    }

    return deleted;
  }

  function countLines(): number {
    if (!existsSync(filePath)) return 0;
    try {
      const { readFileSync } = require('fs') as typeof import('fs');
      const content = readFileSync(filePath, 'utf-8');
      return content.split('\n').filter(l => l.trim().length > 0).length;
    } catch {
      return 0;
    }
  }

  return {
    get path(): string {
      return filePath;
    },

    get stats(): AppendLogStats {
      return {
        lines: countLines(),
        sizeBytes: currentSize(),
        rotatedFiles: listRotatedFiles(filePath).length,
      };
    },

    append<T extends object>(record: T): void {
      // Auto-rotate if over limit before writing
      if (currentSize() > maxSizeBytes) {
        doRotate();
      }
      ensureDir();
      // This write MUST throw on error — do not swallow
      appendFileSync(filePath, JSON.stringify(record) + '\n', writeOpts);
    },

    appendRaw(line: string): void {
      if (currentSize() > maxSizeBytes) {
        doRotate();
      }
      ensureDir();
      const toWrite = line.endsWith('\n') ? line : line + '\n';
      appendFileSync(filePath, toWrite, writeOpts);
    },

    appendJson<T extends object>(obj: T): void {
      this.append(obj);
    },

    readLastN<T = Record<string, unknown>>(n: number): T[] {
      if (!existsSync(filePath)) return [];
      try {
        const { readFileSync } = require('fs') as typeof import('fs');
        const content = readFileSync(filePath, encoding).trim();
        if (!content) return [];

        const lines = content.split('\n');
        const start = Math.max(0, lines.length - n);
        const results: T[] = [];

        for (let i = start; i < lines.length; i++) {
          try {
            results.push(JSON.parse(lines[i]) as T);
          } catch {
            // Skip malformed lines
          }
        }

        return results;
      } catch {
        return [];
      }
    },

    rotate(): string {
      return doRotate();
    },

    cleanup(): number {
      return doCleanup();
    },

    rotatedPaths(): string[] {
      return sortRotatedOldestFirst(listRotatedFiles(filePath));
    },

    size(): number {
      return currentSize();
    },
  };
}
