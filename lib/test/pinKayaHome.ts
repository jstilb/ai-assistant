/**
 * pinKayaHome.ts — shared bun-test harness helper for the KAYA_HOME-pinning
 * convention (memory: shared_process_test_home_pinning; F5 of the 2026-07
 * follow-ups plan).
 *
 * The three one-process pollution classes this convention guards against:
 *   1. env leak — a test file sets process.env.KAYA_HOME at module scope and
 *      never restores it, so every LATER file in the same bun process
 *      resolves paths against a (deleted) temp dir.
 *   2. KayaHome cache — lib/core/KayaHome.ts memoizes getKayaHome(), but the
 *      cache is env-keyed: it re-resolves automatically whenever the
 *      KAYA_HOME/KAYA_DIR pair set below changes, so pinning here is
 *      sufficient with no separate reset step.
 *   3. TaskDB singleton — TaskDB pins its DB path process-globally; a later
 *      file inherits a singleton bound to this file's (deleted) temp dir
 *      unless resetTaskDB({forgetPath:true}) runs on the way out.
 *
 * Usage (module scope, after static imports — ES-module hoisting runs all
 * static imports before any module code, so the pin takes effect for LAZY
 * path resolution; modules that freeze paths in import-time consts still
 * need their own handling and should NOT adopt this helper blindly):
 *
 *   const TEST_DIR = pinKayaHome("my-suite-");
 *   // ...optional per-suite extras, e.g. pre-creating <TEST_DIR>/MEMORY/QUEUES
 *
 *   afterAll(async () => {
 *     // ...suite-specific resets first (resetPipelineRepository(), etc.)
 *     await restoreKayaHome();
 *   });
 *
 * KAYA_DIR is pinned alongside KAYA_HOME because several path-resolvers
 * (NotificationService, InformationManager tools) read KAYA_DIR directly
 * with no KAYA_HOME fallback — pinning only one leaks live-tree writes.
 */

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

interface ActivePin {
  dir: string;
  originalHome: string | undefined;
  originalDir: string | undefined;
}

let _active: ActivePin | null = null;

/**
 * Create a fresh mkdtemp dir and point KAYA_HOME + KAYA_DIR at it so
 * subsequent lazy path resolution lands in the temp dir (KayaHome's
 * env-keyed cache picks up the change on its next call automatically).
 * Returns the temp dir path. Throws if a pin is already active in this
 * process (one suite's pin must be restored before another's begins —
 * bun runs test files sequentially in one process, so overlap means a
 * missing restoreKayaHome() somewhere).
 */
export function pinKayaHome(prefix = "kaya-test-"): string {
  if (_active) {
    throw new Error(
      `pinKayaHome: a pin is already active (${_active.dir}) — a previous suite is missing restoreKayaHome() in afterAll`
    );
  }
  const dir = mkdtempSync(join(tmpdir(), prefix));
  _active = {
    dir,
    originalHome: process.env.KAYA_HOME,
    originalDir: process.env.KAYA_DIR,
  };
  process.env.KAYA_HOME = dir;
  process.env.KAYA_DIR = dir;
  return dir;
}

/**
 * Undo pinKayaHome for the next file in a shared-process run: restore (or
 * delete) both env vars, drop any TaskDB singleton pinned to the temp dir
 * (soft dependency — LucidTasks may not be loaded or present; a fresh load
 * just resets cleanly), and remove the temp dir. No-op when nothing is
 * pinned.
 */
export async function restoreKayaHome(): Promise<void> {
  if (!_active) return;
  const { dir, originalHome, originalDir } = _active;
  _active = null;

  if (originalHome === undefined) delete process.env.KAYA_HOME;
  else process.env.KAYA_HOME = originalHome;
  if (originalDir === undefined) delete process.env.KAYA_DIR;
  else process.env.KAYA_DIR = originalDir;

  try {
    // Soft dependency: lib/test must not hard-couple to a skill, but the
    // TaskDB-singleton pollution class is real for every suite that touched
    // LucidTasks. resetTaskDB({forgetPath:true}) makes the next file
    // re-resolve its DB path from the restored env.
    const { resetTaskDB } = await import(
      "../../skills/Productivity/LucidTasks/Tools/TaskDB.ts"
    );
    resetTaskDB({ forgetPath: true });
  } catch {
    // intentionally silent: probing for an optional skill module — LucidTasks
    // absent in this checkout means there is no TaskDB singleton to reset.
  }

  rmSync(dir, { recursive: true, force: true });
}
