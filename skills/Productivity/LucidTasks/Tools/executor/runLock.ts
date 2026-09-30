/**
 * runLock.ts — PID-file-based run lock for the autonomous executor.
 *
 * Prevents concurrent executor poll runs from trampling each other.
 *
 * Lock file: <KAYA_HOME>/MEMORY/daemon/cron/logs/autonomous-executor.pid
 *
 * Semantics:
 *   - If the PID file does not exist → not locked, acquire returns true.
 *   - If the PID file exists and the stored PID is alive (kill -0 doesn't throw)
 *     → lock is HELD by another process, acquire returns false.
 *   - If the PID file exists but the stored PID is dead (ESRCH) → stale lock,
 *     remove the file and re-acquire.
 *   - On acquire: write own process.pid to the file and return true.
 *   - releaseLock: remove the file, but only if it still contains OUR PID
 *     (guards against releasing a lock we don't own after a stale-cleanup race).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { getKayaHome } from "../../../../../lib/core/KayaHome.ts";

function kayaHome(): string {
  return getKayaHome();
}

function lockPath(): string {
  const logDir = join(kayaHome(), "MEMORY/daemon/cron/logs");
  mkdirSync(logDir, { recursive: true });
  return join(logDir, "autonomous-executor.pid");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = process exists but we lack permission (still alive)
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

/**
 * Attempt to acquire the executor run lock.
 * Returns true if acquired (caller owns the lock).
 * Returns false if another live process holds the lock (caller should exit 0).
 */
export function acquireLock(): boolean {
  const path = lockPath();

  if (existsSync(path)) {
    const raw = readFileSync(path, "utf-8").trim();
    const pid = parseInt(raw, 10);

    if (!isNaN(pid) && isProcessAlive(pid)) {
      // Lock is held by a live process
      return false;
    }

    // Stale lock — remove it and proceed
    try {
      unlinkSync(path);
    } catch {
      // Another process may have cleaned it up between our check and unlink; ignore
    }
  }

  // Write our PID
  writeFileSync(path, process.pid.toString(), "utf-8");
  return true;
}

/**
 * Release the executor run lock.
 * Reads the PID file; only removes it if it still contains our own PID
 * (avoids removing a lock that another process acquired after a stale cleanup).
 */
export function releaseLock(): void {
  const path = lockPath();
  if (!existsSync(path)) return;

  try {
    const raw = readFileSync(path, "utf-8").trim();
    const pid = parseInt(raw, 10);
    if (pid === process.pid) {
      unlinkSync(path);
    }
  } catch {
    // If we can't read or unlink, nothing to do
  }
}
