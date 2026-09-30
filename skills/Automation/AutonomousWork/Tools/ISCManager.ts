/**
 * ISCManager.ts — Extracted from WorkOrchestrator.ts
 *
 * ISC 5: Unified ISC lifecycle — load, persist, markDone, resetToPending,
 *        classifyDisposition extracted from WorkOrchestrator god object.
 *
 * ISC 11: loadISC side effects removed — backfillDispositionsIfNeeded is now
 *         an explicit call, not a side effect of every load.
 *
 * ISC 19 (Bug 19 from spec Section 9): implements the required interface:
 *   load, persist, markDone, resetToPending, classifyDisposition
 *
 * The Map cache lives INSIDE ISCManager as a private field. External consumers
 * get rows via load() only. persist() writes to BOTH the internal Map AND
 * WorkItem.metadata.iscRows atomically — a single call guarantees both stores
 * are in sync.
 */

import type { WorkQueue } from "./WorkQueue.ts";
import type { ISCRow, ISCRowDisposition } from "./WorkOrchestrator.ts";

// ============================================================================
// ISCManager Class
// ============================================================================

export class ISCManager {
  /**
   * In-memory hot cache: itemId → ISCRow[].
   * Private — external consumers must use load()/persist() methods.
   */
  private cache: Map<string, ISCRow[]> = new Map();

  constructor(private queue?: WorkQueue) {}

  // --------------------------------------------------------------------------
  // Core lifecycle
  // --------------------------------------------------------------------------

  /**
   * Load ISC rows for an item.
   *
   * ISC 11 (side-effect fix): This method has NO side effects when rows already
   * have disposition set. If disposition is missing, call backfillDispositionsIfNeeded()
   * explicitly — it is NOT called from here automatically.
   *
   * Priority order: hot cache → metadata
   *
   * Returns empty array (never undefined) when no rows found.
   */
  load(itemId: string): ISCRow[] {
    // 1. Hot cache (no I/O)
    const cached = this.cache.get(itemId);
    if (cached) return cached;

    // 2. Metadata fallback (cold start)
    if (!this.queue) return [];

    const item = this.queue.getItem(itemId);
    const persisted = item?.metadata?.iscRows as ISCRow[] | undefined;
    if (persisted && Array.isArray(persisted)) {
      // Populate hot cache from metadata — NO side effects here (ISC 11)
      this.cache.set(itemId, persisted);
      return persisted;
    }

    return [];
  }

  /**
   * Persist ISC rows for an item.
   *
   * Atomic dual-write: updates both the internal Map cache AND
   * WorkItem.metadata.iscRows in a single call.
   */
  persist(itemId: string, rows: ISCRow[]): void {
    this.cache.set(itemId, rows);
    if (this.queue) {
      this.queue.setMetadata(itemId, { iscRows: rows });
    }
  }

  /**
   * Mark specified row IDs as DONE.
   * Only transitions rows that are currently PENDING.
   * Returns list of IDs that were actually transitioned.
   */
  markDone(itemId: string, rowIds: number[]): { success: boolean; transitioned: number[]; error?: string } {
    const rows = this.load(itemId);
    if (rows.length === 0) {
      return { success: false, transitioned: [], error: `No ISC rows found for ${itemId} — run prepare first` };
    }

    const transitioned: number[] = [];
    for (const rowId of rowIds) {
      const row = rows.find(r => r.id === rowId);
      if (row && row.status === "PENDING") {
        row.status = "DONE";
        transitioned.push(rowId);
      }
    }

    this.persist(itemId, rows);
    return { success: true, transitioned };
  }

  /**
   * Reset all DONE rows back to PENDING.
   * VERIFIED rows are NOT reset (they remain verified).
   */
  resetToPending(itemId: string): void {
    const rows = this.load(itemId);
    if (rows.length === 0) return;

    let changed = false;
    for (const row of rows) {
      if (row.status === "DONE") {
        row.status = "PENDING";
        if (row.verification) {
          row.verification.result = undefined;
        }
        changed = true;
      }
    }

    if (changed) {
      this.persist(itemId, rows);
    }
  }

  /**
   * Classify whether a row requires human action or can be automated.
   * Returns "human-required" for deployment/publishing/external actions.
   * Returns "automatable" for everything else.
   */
  classifyDisposition(row: ISCRow): "human-required" | "automatable" {
    return this._classifyRowDisposition(row.description);
  }

  /**
   * ISC 11: Explicit backfill for rows lacking disposition.
   * Call this explicitly from cold-start paths, NOT from load().
   *
   * Returns true if any rows were backfilled and persisted.
   */
  backfillDispositionsIfNeeded(itemId: string): boolean {
    const rows = this.load(itemId);
    if (rows.length === 0) return false;

    let backfilled = false;
    for (const row of rows) {
      if (!row.disposition) {
        row.disposition = this._classifyRowDisposition(row.description);
        backfilled = true;
      }
    }

    if (backfilled) {
      this.persist(itemId, rows);
    }

    return backfilled;
  }

  /**
   * ISC 603: Clear the hot cache for an item (forces next load to read from metadata).
   * This does NOT clear the metadata — only the in-memory cache.
   */
  clearCache(itemId: string): void {
    this.cache.delete(itemId);
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private _classifyRowDisposition(_description: string): ISCRowDisposition {
    // Default to automatable. The "human-required" decision is made upstream by
    // signals that carry ground truth the LLM emits or the producer fixes:
    //   - the comprehension LLM's per-row `humanRequired` flag (Rule 3: secret
    //     entry / account consent / physical-device / irreversible-destructive),
    //   - the native→human lock (`row.native` / native work surface).
    // generateISC applies both before falling through to this default. The old
    // keyword scanner (classifyHumanRequired) re-derived the same judgment from
    // the description text and could override the LLM — content interpretation
    // the LLM does better. Removed: trust the flag, fail loud if an automated
    // attempt hits a wall it genuinely can't pass.
    return "automatable";
  }
}

// classifyHumanRequired (the SECRET/CONSENT/PHYSICAL/DESTRUCTIVE keyword scanner)
// was removed in the determinism-residue cleanup. Those four gates are now the
// comprehension LLM's job (LLMSpecComprehension Rule 3), reinforced by the
// objective native→human lock. The keyword scanner second-guessed the LLM's
// per-row humanRequired flag from the same description text — content
// interpretation the LLM does better. See _classifyRowDisposition above.
