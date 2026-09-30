#!/usr/bin/env bun
/**
 * TechDebtRegistry — thin CRUD wrapper over MEMORY/QUEUES/tech-debt.jsonl
 *
 * Items are appended on first write; mutations (status updates, score writes)
 * rewrite the file atomically: read-all → mutate → write-all.
 * Dedup key: ${location.toLowerCase().trim()}::${category.toLowerCase().trim()}
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { kayaHomePath } from "../../../../lib/core/KayaHome.ts";
import { inference } from "../../../../lib/core/Inference.ts";

// ============================================================================
// Types
// ============================================================================

export interface TechDebtScore {
  severity: number | null;  // 0-100
  impact: number | null;    // 0-100
  effort: number | null;    // 0-100
  composite: number | null; // 0-100
}

export interface TechDebtItem {
  id: string;
  description: string;
  location: string;
  category: string;
  source: "manual" | "audit" | "self-report";
  score: TechDebtScore | null;
  status: "open" | "fixed" | "promoted";
  promotedItemId?: string;
  createdAt: string;
  updatedAt?: string;
}

// Result summary for rescoreNulls() — see the method doc below for the full
// contract (idempotency, incremental persistence, limit semantics).
export interface RescoreNullsResult {
  attempted: number;
  rescored: number;
  stillNull: number;
  /** Null-scored open items remaining AFTER this call (0 once the backlog is drained). */
  remainingNull: number;
}

// ============================================================================
// Score shape guard
// ============================================================================

// Exported so TechDebtAuditor.ts can validate scores that ride along with a
// scan finding (in-batch scoring, S2) before handing them to add() below —
// a finding whose score fields are missing/partial/invalid is treated as
// score-less rather than dropped outright.
export function isValidScoreShape(obj: unknown): obj is TechDebtScore {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  const isNullOrNumber = (v: unknown) => v === null || (typeof v === "number" && isFinite(v));
  return (
    "severity" in o && isNullOrNumber(o.severity) &&
    "impact" in o && isNullOrNumber(o.impact) &&
    "effort" in o && isNullOrNumber(o.effort) &&
    "composite" in o && isNullOrNumber(o.composite)
  );
}

// ============================================================================
// LLM scoring
// ============================================================================

export async function scoreTechDebtItem(params: {
  description: string;
  location: string;
  category: string;
}): Promise<TechDebtScore | null> {
  // Deterministic test seam — production-inert when KAYA_TECH_DEBT_STUB_SCORE is unset.
  const stubEnv = process.env.KAYA_TECH_DEBT_STUB_SCORE;
  if (stubEnv !== undefined) {
    const parsed = parseInt(stubEnv, 10);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
      const composite = parsed;
      const severity = Math.min(100, composite);
      const impact = Math.min(100, composite);
      const effort = Math.max(0, 100 - composite);
      return { severity, impact, effort, composite };
    }
    // Unparseable/out-of-range: fall through to real inference path.
  }

  const systemPrompt = `You are a technical debt analyst. Given a tech debt item, return a JSON object with exactly these fields:
{
  "severity": <0-100, how severe is the technical harm>,
  "impact": <0-100, how much does this impact the codebase / product quality>,
  "effort": <0-100, how much effort is required to fix (100 = very high effort)>,
  "composite": <0-100, overall priority score (higher = should fix sooner)>
}
Return ONLY valid JSON, nothing else.`;

  const userPrompt = `Tech debt item:
Description: ${params.description}
Location: ${params.location}
Category: ${params.category}

Score this item on severity, impact, effort, and composite priority (0-100 each).`;

  try {
    const result = await inference({
      systemPrompt,
      userPrompt,
      level: "standard",
      expectJson: true,
    });

    if (!result.success || result.parsed === undefined) {
      console.warn("[TechDebtRegistry] scoring inference failed:", result.error ?? "no parsed output");
      return null;
    }

    if (!isValidScoreShape(result.parsed)) {
      console.warn("[TechDebtRegistry] scoring returned unexpected shape:", JSON.stringify(result.parsed));
      return null;
    }

    return result.parsed;
  } catch (err) {
    console.warn("[TechDebtRegistry] scoring threw:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ============================================================================
// Registry
// ============================================================================

export class TechDebtRegistry {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? kayaHomePath("MEMORY/QUEUES/tech-debt.jsonl");
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private ensureFile(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (!existsSync(this.filePath)) {
      writeFileSync(this.filePath, "", "utf-8");
    }
  }

  private readAll(): TechDebtItem[] {
    this.ensureFile();
    const raw = readFileSync(this.filePath, "utf-8").trim();
    if (!raw) return [];
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as TechDebtItem;
        } catch {
          console.warn("[TechDebtRegistry] skipping malformed JSONL line:", line.slice(0, 80));
          return null;
        }
      })
      .filter((item): item is TechDebtItem => item !== null);
  }

  private writeAll(items: TechDebtItem[]): void {
    this.ensureFile();
    const content = items.map((item) => JSON.stringify(item)).join("\n");
    writeFileSync(this.filePath, content ? content + "\n" : "", "utf-8");
  }

  private dedupKey(location: string, category: string): string {
    return `${location.toLowerCase().trim()}::${category.toLowerCase().trim()}`;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Add a new tech debt item.
   * Returns the existing item (unchanged) if the dedup key matches an open entry.
   * Returns the new item after writing if it's unique.
   *
   * If `params.score` is a valid TechDebtScore (e.g. a scan finding that came
   * back pre-scored from TechDebtAuditor's in-batch scoring — S2), it is used
   * as-is and the per-entry scoreTechDebtItem() inference call is skipped
   * entirely. Otherwise falls back to scoreTechDebtItem() as before.
   */
  async add(params: {
    description: string;
    location: string;
    category: string;
    source?: TechDebtItem["source"];
    score?: TechDebtScore;
  }): Promise<{ item: TechDebtItem; isDuplicate: boolean }> {
    const items = this.readAll();
    const key = this.dedupKey(params.location, params.category);

    const existing = items.find(
      (i) => i.status === "open" && this.dedupKey(i.location, i.category) === key
    );
    if (existing) {
      return { item: existing, isDuplicate: true };
    }

    const score = params.score !== undefined && isValidScoreShape(params.score)
      ? params.score
      : await scoreTechDebtItem({
          description: params.description,
          location: params.location,
          category: params.category,
        });

    const newItem: TechDebtItem = {
      id: crypto.randomUUID(),
      description: params.description,
      location: params.location,
      category: params.category,
      source: params.source ?? "manual",
      score,
      status: "open",
      createdAt: new Date().toISOString(),
    };

    items.push(newItem);
    this.writeAll(items);

    return { item: newItem, isDuplicate: false };
  }

  /** Return all items regardless of status. */
  all(): TechDebtItem[] {
    return this.readAll();
  }

  /** Return all open items. */
  list(): TechDebtItem[] {
    return this.readAll().filter((i) => i.status === "open");
  }

  /** Return top-N open items sorted by composite score descending (nulls last). */
  top(n: number = 10): TechDebtItem[] {
    const open = this.list();
    return open
      .sort((a, b) => {
        const ac = a.score?.composite ?? -1;
        const bc = b.score?.composite ?? -1;
        return bc - ac;
      })
      .slice(0, n);
  }

  /** Set the status of an item to 'fixed'. Returns updated item or null if not found. */
  resolve(id: string): TechDebtItem | null {
    const items = this.readAll();
    const idx = items.findIndex((i) => i.id === id);
    if (idx === -1) return null;

    const updated: TechDebtItem = {
      ...items[idx]!,
      status: "fixed",
      updatedAt: new Date().toISOString(),
    };
    items[idx] = updated;
    this.writeAll(items);
    return updated;
  }

  /** Find an item by id. Returns null if not found. */
  getById(id: string): TechDebtItem | null {
    const items = this.readAll();
    return items.find((i) => i.id === id) ?? null;
  }

  /**
   * Set the status of an item to 'promoted' and record the spec-pipeline entry ID.
   * Returns the updated item, or null if not found.
   */
  promote(id: string, promotedItemId: string): TechDebtItem | null {
    const items = this.readAll();
    const idx = items.findIndex((i) => i.id === id);
    if (idx === -1) return null;

    const updated: TechDebtItem = {
      ...items[idx]!,
      status: "promoted",
      promotedItemId,
      updatedAt: new Date().toISOString(),
    };
    items[idx] = updated;
    this.writeAll(items);
    return updated;
  }

  /**
   * Backfill scores for OPEN items whose score is null or fails
   * isValidScoreShape (e.g. a partial/invalid shape from a prior failed
   * scoring pass — the 2026-07-10 proving run left ~1,039/2,444 items this
   * way, and top()/autoPromoteTop() sort nulls last, so they were never
   * being ranked at all).
   *
   * Idempotent: the candidate list is computed fresh from disk at the start
   * of each call, so items that fail scoring THIS call stay null and are
   * simply re-attempted on the NEXT call — there is no per-item "give up"
   * state. Already-scored items and non-open items are never touched (they
   * are excluded from the candidate list up front, not skipped mid-loop).
   *
   * `limit` bounds how many items are ATTEMPTED this call (default:
   * unlimited — attempt every eligible item). Progress is persisted after
   * EVERY successful score (not batched at the end), so a call interrupted
   * partway through — expected, since the live backlog is large enough to
   * span multiple usage windows — keeps whatever progress it made.
   */
  async rescoreNulls(limit?: number): Promise<RescoreNullsResult> {
    const candidateIds = this.readAll()
      .filter((i) => i.status === "open" && !isValidScoreShape(i.score))
      .map((i) => i.id);
    const targetIds = limit !== undefined ? candidateIds.slice(0, limit) : candidateIds;

    let attempted = 0;
    let rescored = 0;
    let stillNull = 0;

    for (const id of targetIds) {
      attempted++;
      // Score from a cheap point read; the read-modify-write below happens
      // AFTER the (slow, awaited) inference call returns, so the stale-
      // snapshot window is microseconds — the same magnitude as add()'s and
      // resolve()'s pre-existing RMW window. Holding one snapshot across the
      // whole run instead was proven (adversarial verification, 2026-07-11)
      // to clobber a concurrent add() outright during a long live rescore.
      const target = this.getById(id);
      if (!target || target.status !== "open" || isValidScoreShape(target.score)) {
        continue; // vanished, closed, or scored by another writer mid-run
      }
      const score = await scoreTechDebtItem({
        description: target.description,
        location: target.location,
        category: target.category,
      });
      if (score !== null) {
        const items = this.readAll();
        const idx = items.findIndex((i) => i.id === id);
        if (idx === -1) continue; // vanished while we were scoring
        items[idx] = { ...items[idx]!, score, updatedAt: new Date().toISOString() };
        this.writeAll(items); // incremental persistence — survives interruption mid-run
        rescored++;
      } else {
        stillNull++;
      }
    }

    const remainingNull = this.readAll().filter(
      (i) => i.status === "open" && !isValidScoreShape(i.score)
    ).length;

    return { attempted, rescored, stillNull, remainingNull };
  }
}
