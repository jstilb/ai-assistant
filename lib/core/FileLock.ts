/**
 * FileLock — cross-process advisory lock backed by an O_EXCL lock file.
 *
 * acquire() creates `lockPath` atomically (openSync "wx") holding the
 * acquisition timestamp; if it already exists, it polls every 10ms, breaking
 * a stale lock older than 2× the timeout, and throws after `timeoutMs`.
 *
 * Shared by StateManager (per-state-file locks) and AutonomousWork's
 * Integrator (merge lock), formerly two copies of this class.
 */

import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

export class FileLock {
  private locked = false;

  /**
   * @param lockPath  - The lock file itself (e.g. `${stateFile}.lock`).
   * @param timeoutMs - Give up acquiring after this long.
   * @param label     - Prefix for the timeout error, e.g. "Integrator lock".
   */
  constructor(
    private readonly lockPath: string,
    private readonly timeoutMs: number,
    private readonly label = "Lock",
  ) {}

  async acquire(): Promise<void> {
    const startTime = Date.now();

    while (true) {
      // Attempt atomic lock creation: O_CREAT|O_EXCL fails if file exists
      let acquired = false;
      try {
        // openSync with 'wx' flag = O_WRONLY|O_CREAT|O_EXCL — fails atomically if exists
        const fd = openSync(this.lockPath, "wx");
        writeSync(fd, String(Date.now()));
        closeSync(fd);
        acquired = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          // Unexpected error (e.g., EACCES, ENOENT for parent dir) — rethrow
          throw new Error(`Lock file error at ${this.lockPath}: ${(err as Error).message}`);
        }
        // EEXIST: lock held by another process — check if stale
      }

      if (acquired) {
        this.locked = true;
        return;
      }

      // Lock exists: check if stale
      try {
        const lockTime = parseInt(readFileSync(this.lockPath, "utf-8"), 10);
        if (!Number.isNaN(lockTime) && Date.now() - lockTime > this.timeoutMs * 2) {
          // Stale lock — attempt removal. Another process may race us here;
          // if unlink succeeds, we loop back and try to acquire atomically.
          try {
            unlinkSync(this.lockPath);
          } catch {
            // intentionally silent: another process removed the stale lock first
          }
        }
      } catch {
        // intentionally silent: lock file vanished between EEXIST and this read — loop and retry
      }

      if (Date.now() - startTime > this.timeoutMs) {
        throw new Error(`${this.label} acquisition timeout after ${this.timeoutMs}ms`);
      }

      await Bun.sleep(10);
    }
  }

  async release(): Promise<void> {
    if (this.locked && existsSync(this.lockPath)) {
      try {
        unlinkSync(this.lockPath);
      } catch {
        // intentionally silent: lock may already have been cleaned up
      }
      this.locked = false;
    }
  }
}
