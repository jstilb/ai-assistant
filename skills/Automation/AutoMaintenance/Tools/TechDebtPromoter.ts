#!/usr/bin/env bun
/**
 * TechDebtPromoter — auto-promote top-scored open tech debt items into spec-pipeline.
 *
 * Auto-promotion (autoPromoteTop) is capped at 2 in-flight items.
 * Manual promotion (promoteItem) bypasses the cap.
 *
 * ISC 6: autoPromoteTop selects highest-scored open item, attaches notes +
 *        researchGuidance, updates registry status to "promoted" + promotedItemId.
 *        Does NOT promote when ≥2 items already promoted with active pipeline links.
 *
 * ISC 7: promoteItem (used by `debt promote <id>`) bypasses the cap.
 */

import { join } from "path";
// cross-skill-allowed: TechDebtPromoter drives QueueRouter's QueueManager by design; QueueClient.enqueueItem adoption evaluated 2026-07-05 (F4) and REJECTED — this site needs list()×3 (in-flight reads), attachContext(), and queue-pinned add(), none of which the seam carries; splitting one op onto the seam while the import stays for the other three reduces nothing
import { QueueManager } from "../../QueueRouter/Tools/QueueManager.ts";
import { TechDebtRegistry, type TechDebtItem } from "./TechDebtRegistry.ts";
import { defaultKayaHome } from "../../../../lib/core/KayaHome.ts";

function getDebtFilePath(): string {
  // Always read KAYA_HOME fresh (uncached; defaultKayaHome() is the uncached,
  // env-independent fallback) so tests can override process.env.KAYA_HOME
  // between instances without calling _resetKayaHomeCache().
  const home = process.env.KAYA_HOME ?? defaultKayaHome();
  return join(home, "MEMORY", "QUEUES", "tech-debt.jsonl");
}

/** Statuses that indicate an item is still active in the pipeline (not terminal). */
const TERMINAL_STATUSES = new Set(["completed", "failed", "rejected", "archived"]);

export class TechDebtPromoter {
  private readonly qm: QueueManager;
  private readonly registry: TechDebtRegistry;

  constructor(qm?: QueueManager, registry?: TechDebtRegistry) {
    // Reset the cached KAYA_HOME so TechDebtRegistry picks up the current env var.
    // This is safe because we read process.env.KAYA_HOME directly in getDebtFilePath().
    this.qm = qm ?? new QueueManager();
    this.registry = registry ?? new TechDebtRegistry(getDebtFilePath());
  }

  /**
   * Returns the count of registry items with status "promoted" whose promotedItemId
   * is STILL ACTIVE in spec-pipeline, approvals, or approved-work queues
   * (live state — checks actual queue file contents, not just registry).
   */
  async getInFlightCount(): Promise<number> {
    // Collect all active item IDs from the three pipeline queues
    const [specItems, approvalItems, approvedItems] = await Promise.all([
      this.qm.list({ queue: "spec-pipeline" }).catch(() => []),
      this.qm.list({ queue: "approvals" }).catch(() => []),
      this.qm.list({ queue: "approved-work" }).catch(() => []),
    ]);

    const activeIds = new Set<string>();
    for (const item of [...specItems, ...approvalItems, ...approvedItems]) {
      if (!TERMINAL_STATUSES.has(item.status)) {
        activeIds.add(item.id);
      }
    }

    // Read all registry items (including promoted ones)
    const allItems = this.registry.all();
    let count = 0;
    for (const item of allItems) {
      if (item.status === "promoted" && item.promotedItemId && activeIds.has(item.promotedItemId)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Creates a spec-pipeline entry for the given tech debt item, attaches
   * notes + researchGuidance, then updates the registry item to status "promoted"
   * with promotedItemId set.
   *
   * Returns { promotedItemId } — the ID of the new spec-pipeline entry.
   */
  async promoteItem(
    itemId: string,
    opts?: { notes?: string; researchGuidance?: string }
  ): Promise<{ promotedItemId: string }> {
    const item = this.registry.getById(itemId);
    if (!item) {
      throw new Error(`TechDebtPromoter: item "${itemId}" not found in registry`);
    }

    const notes =
      opts?.notes ??
      `Tech debt item: ${item.description} (${item.category} in ${item.location})`;
    const researchGuidance =
      opts?.researchGuidance ??
      `Research best practices for resolving ${item.category} debt in ${item.location}`;

    // Create spec-pipeline entry
    const newPipelineId = await this.qm.add(
      {
        title: `Tech Debt: ${item.description}`,
        description: `Tech debt item from ${item.location}. Category: ${item.category}. ${item.description}`,
      },
      { queue: "spec-pipeline", source: "tech-debt-promoter" }
    );

    // Attach context (notes + researchGuidance) — this also moves item to "researching"
    await this.qm.attachContext(newPipelineId, notes, researchGuidance);

    // Update registry: status → promoted, set promotedItemId
    this.registry.promote(itemId, newPipelineId);

    return { promotedItemId: newPipelineId };
  }

  /**
   * Auto-promote the highest-scored open item.
   * Returns { promoted: false, reason } when the in-flight cap (≥2) is hit or no open items.
   * Returns { promoted: true, promotedItemId } on success.
   */
  async autoPromoteTop(): Promise<{
    promoted: boolean;
    reason?: string;
    promotedItemId?: string;
  }> {
    const inFlight = await this.getInFlightCount();
    if (inFlight >= 2) {
      const reason = `cap hit: ${inFlight} items in-flight`;
      console.log(`[TechDebtPromoter] ${reason}`);
      return { promoted: false, reason };
    }

    // Find highest-scored open item
    const topItems = this.registry.top(1);
    if (topItems.length === 0) {
      const reason = "no open items to promote";
      console.log(`[TechDebtPromoter] ${reason}`);
      return { promoted: false, reason };
    }

    const topItem = topItems[0]!;
    const { promotedItemId } = await this.promoteItem(topItem.id);
    return { promoted: true, promotedItemId };
  }
}
