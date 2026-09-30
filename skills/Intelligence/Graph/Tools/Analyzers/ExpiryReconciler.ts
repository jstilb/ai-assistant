#!/usr/bin/env bun
/**
 * ExpiryReconciler - Formalize `supersedes` edges into `valid_to` tombstones
 * (Slice C1 — context integrity)
 *
 * The graph has always recorded WHICH outcome superseded another (the
 * `supersedes` edge, written by DecisionIngester's rating-recovery
 * heuristic — a high-rated outcome (>=8) that follows a low-rated one (<4)
 * within 30 minutes). Until this slice, the superseded (target) node stayed
 * fully live: equally queryable, equally rankable, forever. This script
 * makes the dormant `valid_to` field on GraphNode live by walking every
 * `supersedes` edge and tombstoning its target — mechanical formalization
 * of a signal that already exists, not a new judgment call.
 *
 * Deliberately NOT run at ingest time (see DecisionIngester). The
 * supersedes heuristic is already a fuzzy judgment call; baking a silent,
 * invisible-by-default expiry action onto it would compound that into
 * something with real blast radius — an incorrectly-expired record
 * vanishes from search/embeddings/stats until a human notices it missing.
 * This script is standalone and re-runnable instead: every tombstoned id is
 * printed to stdout (auditable), it is idempotent (a record that already
 * has `valid_to` is left alone), and `--dry-run` lists what WOULD happen
 * without writing anything.
 *
 * Scope (Q2 of the design pass): only `outcome` nodes need this — GraphEdge
 * gets no validity field in this slice, and `supersedes` edges have only
 * ever been observed with `outcome` targets (verified against the live
 * store: 39/39 targets are type `outcome`).
 *
 * @module Graph/Analyzers/ExpiryReconciler
 * @version 1.0.0
 */

import { GraphPersistence, getGraphPersistence } from '../GraphPersistence';

export interface ExpiryReconcileResult {
  /** IDs tombstoned this run (or that WOULD be tombstoned, under --dry-run). */
  tombstonedIds: string[];
  /** supersedes edges whose target was already expired — idempotency skips. */
  alreadyExpired: number;
  /** supersedes edges whose target node id doesn't exist on disk. */
  missingTargets: number;
  dryRun: boolean;
}

export class ExpiryReconciler {
  private persistence: GraphPersistence;

  constructor(persistence?: GraphPersistence) {
    this.persistence = persistence || getGraphPersistence();
  }

  /**
   * Walk every `supersedes` edge and tombstone (valid_to) its target node —
   * the earlier, now-superseded fact — unless it's already expired.
   *
   * Purely mechanical: this does not decide what counts as "superseded"
   * (that judgment already happened when the `supersedes` edge was
   * created). It only formalizes an edge that already exists into a
   * validity window on the node it points at.
   */
  async reconcile(options: { dryRun?: boolean } = {}): Promise<ExpiryReconcileResult> {
    const dryRun = options.dryRun ?? false;

    // supersedes edges are source(high-rated) -> target(low-rated, i.e. the
    // superseded one) per DecisionIngester.createCrossSourceEdges().
    const edges = this.persistence.loadEdges('supersedes');
    // Default (include-expired) read — we need to see nodes ALREADY
    // tombstoned so re-runs can recognize them and skip (idempotency).
    const outcomeNodes = this.persistence.loadNodes('outcome');
    const nodeById = new Map(outcomeNodes.map(n => [n.id, n]));

    const tombstonedIds: string[] = [];
    let alreadyExpired = 0;
    let missingTargets = 0;
    // Multiple supersedes edges can point at the SAME target (17 unique
    // targets across 39 edges on the live store) — nodeById is a single
    // point-in-time snapshot that doesn't reflect a tombstone just written
    // earlier in this same loop, so without this set every edge sharing a
    // target would independently pass the `target.valid_to` check and write
    // its own redundant tombstone line. Tracked separately from the
    // cross-RUN idempotency check (target.valid_to, from disk) — this one
    // is WITHIN a single run.
    const handledThisRun = new Set<string>();

    for (const edge of edges) {
      const target = nodeById.get(edge.target);
      if (!target) {
        missingTargets++;
        console.error(
          `[ExpiryReconciler] supersedes edge ${edge.id} targets unknown node ${edge.target} — skipped`,
        );
        continue;
      }
      if (target.valid_to || handledThisRun.has(target.id)) {
        alreadyExpired++;
        continue;
      }

      if (dryRun) {
        tombstonedIds.push(target.id);
        handledThisRun.add(target.id);
        continue;
      }

      const validTo = new Date().toISOString();
      const ok = this.persistence.tombstoneNode('outcome', target.id, validTo, `supersedes:${edge.id}`);
      if (!ok) {
        // tombstoneNode() already wrote a stderr warning explaining why.
        missingTargets++;
        continue;
      }
      tombstonedIds.push(target.id);
      handledThisRun.add(target.id);
    }

    return { tombstonedIds, alreadyExpired, missingTargets, dryRun };
  }
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const dryRun = process.argv.includes('--dry-run');
  const reconciler = new ExpiryReconciler();

  console.log(`ExpiryReconciler${dryRun ? ' (--dry-run: no writes)' : ''}`);
  console.log('='.repeat(40));

  const result = await reconciler.reconcile({ dryRun });

  console.log(
    `supersedes edges: ${result.tombstonedIds.length + result.alreadyExpired + result.missingTargets} scanned, ` +
    `${result.alreadyExpired} already-expired, ${result.missingTargets} missing-target`,
  );
  console.log(
    `${dryRun ? 'Would tombstone' : 'Tombstoned'} ${result.tombstonedIds.length} outcome node(s):`,
  );
  for (const id of result.tombstonedIds) {
    console.log(`  ${id}`);
  }

  if (result.tombstonedIds.length === 0) {
    console.log('(nothing to do — every supersedes target is already expired or none exist)');
  }
}
