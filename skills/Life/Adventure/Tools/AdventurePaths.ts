/**
 * AdventurePaths.ts — path seam for the Adventure skill's vault + state files.
 *
 * Purpose: tests and canaries need to sandbox vault reads/writes and the
 * trips.json / packing-lists.json state into temp directories WITHOUT ever
 * touching Jm's live Obsidian vault or the live data files. Production code
 * calls these resolvers at the point of use so a test can set the env vars
 * below in a subprocess (or on `process.env` directly) before invoking a
 * function and get a fully isolated path.
 *
 * Constraint: every function MUST resolve its env var at CALL time, never
 * cache into a module-scope const. `bun test <dir>` runs every file in the
 * directory in ONE process, so a module-scope const would freeze whichever
 * env was active when the first test file loaded — silently pinning every
 * later file/test to that first value (see the shared-process-test-home-
 * pinning gotcha memory).
 *
 * @module AdventurePaths
 */

import { join } from "path";
import { homedir } from "os";

/** The Adventure skill's Obsidian vault directory (itineraries, date plans, packing docs). */
export function adventureVaultDir(): string {
  return process.env.ADVENTURE_VAULT_DIR ?? join(homedir(), "Desktop", "obsidian", "Adventure");
}

/** The trips.json state file path — single-owner state for the trip tracker. */
export function tripsStatePath(): string {
  return process.env.ADVENTURE_TRIPS_PATH ?? join(import.meta.dir, "..", "data", "trips.json");
}

/** The packing-lists.json state file path — single-owner state for packing lists. */
export function packingStatePath(): string {
  return process.env.ADVENTURE_PACKING_PATH ?? join(import.meta.dir, "..", "data", "packing-lists.json");
}
