#!/usr/bin/env bun
/**
 * PipelineIntegrity.ts — Pipeline visibility checker (Check 8 backbone)
 *
 * Subcommand: `check`
 *
 * FOUR CHECKS:
 *   1. Orphan specs — pipeline-generated spec files on disk whose Item ID has
 *      no row in pipeline.db (across ALL stages including archived). This is
 *      the exact "grilled spec fell off the pipeline" symptom.
 *
 *   2. Store integrity — delegates to PipelineRepository.integrity() and
 *      surfaces its errors/warnings.
 *
 *   3. Stuck-in-autonomous-stage — items in autonomous stages whose
 *      updated_at exceeds a per-stage threshold. Explicitly EXCLUDES
 *      needs-grilling (human-paced backlog) and all terminal stages.
 *
 *   4. Guard bypass ("wrote around the guard", slice A2) — items whose
 *      current pipeline_items.stage differs from their LATEST pipeline_events
 *      row's to_stage. Every legitimate write path (transition(), upsert())
 *      appends a matching event in the same tx, so a divergence means
 *      something mutated stage directly (raw SQL, a bug, a future script)
 *      without going through the audited path. Items with ZERO events are
 *      exempt — the event backfill epoch starts at slice A1, so pre-A1 rows
 *      have no history to compare against. This is the permanent tripwire
 *      for the A2 shadow-mode guard.
 *
 * Output:
 *   - A structured JSON report to stdout
 *   - A one-line machine-greppable summary: PIPELINE_ORPHANS(n) STUCK(n) STORE_ERRORS(n) GUARD_BYPASS(n)
 *   - Exit code 0 = all clean; non-zero = at least one problem found
 *
 * Alerting:
 *   - Uses AlertGate.send() with fingerprint = `count + oldest-age-bucket`
 *     so a WORSENING condition re-fires but a STABLE one stays quiet.
 *   - Respects KAYA_ALERT_DRY_RUN.
 *   - Suppressed by --no-alert flag (used by tests and watchdog).
 *
 * State isolation:
 *   - Reads KAYA_HOME at call time (not module load) — safe for tests that
 *     pin KAYA_HOME to a temp dir.
 *   - Never creates or modifies pipeline.db on the live path unless
 *     called without KAYA_HOME override.
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join, basename } from "path";
import { parseArgs } from "util";
import { getPipelineRepository, resetPipelineRepository } from "./PipelineRepository.ts";
import { defaultPipelineDbPath, getPipelineDb } from "./PipelineDB.ts";
import { sendAlert } from "../../../../lib/core/AlertGate.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

// ============================================================================
// Stuck-stage thresholds (milliseconds)
// Configurable at the top of the file.
// ============================================================================

/** Stages that may be stuck. Explicitly excludes needs-grilling (human-paced). */
const AUTONOMOUS_STAGES = [
  "researching",
  "generating-spec",
  "approved",
  "in-progress",
] as const;

type AutonomousStage = typeof AUTONOMOUS_STAGES[number];

const STUCK_THRESHOLDS_MS: Record<AutonomousStage, number> = {
  "researching":      6  * 60 * 60 * 1000,  // 6h
  "generating-spec":  6  * 60 * 60 * 1000,  // 6h
  "approved":         48 * 60 * 60 * 1000,  // 48h
  "in-progress":      24 * 60 * 60 * 1000,  // 24h
};

/** Age bucket labels for fingerprinting (coarse-grained so a stable state dedupes) */
function ageBucket(ageMs: number): string {
  const h = Math.floor(ageMs / (60 * 60 * 1000));
  if (h < 12) return "<12h";
  if (h < 24) return "<24h";
  if (h < 48) return "<48h";
  if (h < 96) return "<96h";
  return "96h+";
}

// ============================================================================
// Spec header parser
// ============================================================================

const ITEM_ID_RE = /^\*\*Item ID:\*\*\s*(\S+)/m;

/**
 * Parse the pipeline-generated Item ID from a spec file's content.
 * Returns null for old-format specs that don't have the header.
 */
function parseItemId(content: string): string | null {
  const m = ITEM_ID_RE.exec(content);
  return m ? (m[1] ?? null) : null;
}

// ============================================================================
// Report Types
// ============================================================================

export interface OrphanSpec {
  specPath: string;
  itemId: string;
}

export interface StuckItem {
  id: string;
  stage: string;
  title: string;
  updatedAt: string;
  ageMs: number;
  thresholdMs: number;
}

export interface GuardBypassItem {
  id: string;
  /** Current pipeline_items.stage */
  stage: string;
  /** to_stage of the item's latest pipeline_events row (by highest event id) */
  latestEventToStage: string;
}

export interface IntegrityCheckReport {
  checkedAt: string;
  orphanSpecs: OrphanSpec[];
  stuckItems: StuckItem[];
  storeErrors: string[];
  storeWarnings: string[];
  guardBypassItems: GuardBypassItem[];
  summary: string;          // machine-greppable one-liner
  ok: boolean;
}

// ============================================================================
// Check 1: Orphan specs
// ============================================================================

function checkOrphanSpecs(specsDir: string, dbPath: string): OrphanSpec[] {
  if (!existsSync(specsDir)) return [];

  // Load all pipeline IDs from the DB (all stages including archived)
  const repo = getPipelineRepository(dbPath);
  const allItems = repo.list({ includeArchived: true });
  const knownIds = new Set(allItems.map(i => i.id));

  // Also check spec_id field
  const knownSpecIds = new Set(
    allItems.flatMap(i => [i.spec_id].filter(Boolean))
  );

  const orphans: OrphanSpec[] = [];

  let files: string[];
  try {
    files = readdirSync(specsDir);
  } catch {
    return [];
  }

  for (const file of files) {
    if (!file.endsWith("-spec.md")) continue;

    const specPath = join(specsDir, file);
    let content: string;
    try {
      content = readFileSync(specPath, "utf-8");
    } catch {
      continue; // unreadable — skip
    }

    const itemId = parseItemId(content);
    if (!itemId) continue; // old-format spec without Item ID header — not an orphan

    // Check by primary item id AND by spec_id column
    if (!knownIds.has(itemId) && !knownSpecIds.has(itemId)) {
      orphans.push({ specPath, itemId });
    }
  }

  return orphans;
}

// ============================================================================
// Check 2: Store integrity (delegated)
// ============================================================================

function checkStoreIntegrity(dbPath: string): { errors: string[]; warnings: string[] } {
  const repo = getPipelineRepository(dbPath);
  const report = repo.integrity();
  return { errors: report.errors, warnings: report.warnings };
}

// ============================================================================
// Check 3: Stuck-in-autonomous-stage
// ============================================================================

function checkStuckItems(dbPath: string): StuckItem[] {
  const repo = getPipelineRepository(dbPath);
  const now = Date.now();

  const stuckItems: StuckItem[] = [];

  for (const stage of AUTONOMOUS_STAGES) {
    const threshold = STUCK_THRESHOLDS_MS[stage];
    const items = repo.list({ stage, includeArchived: false });

    for (const item of items) {
      const updatedAt = item.updated_at ?? item.created_at;
      const ageMs = now - new Date(updatedAt).getTime();

      if (ageMs > threshold) {
        stuckItems.push({
          id: item.id,
          stage: item.stage,
          title: item.title,
          updatedAt,
          ageMs,
          thresholdMs: threshold,
        });
      }
    }
  }

  return stuckItems;
}

// ============================================================================
// Check 4: Guard bypass ("wrote around the guard", slice A2)
// ============================================================================

/**
 * Flags items whose current pipeline_items.stage differs from their LATEST
 * pipeline_events row's to_stage (latest = highest autoincrement id for that
 * item_id). Every legitimate write path (transition(), upsert()) appends a
 * matching event in the same tx as the stage write, so a divergence means
 * some write mutated stage directly without going through that audited path.
 *
 * Items with ZERO pipeline_events rows are exempt (inner JOIN excludes them
 * naturally) — the event backfill epoch starts at slice A1, so pre-A1 rows
 * have no history to compare against.
 */
function checkGuardBypass(dbPath: string): GuardBypassItem[] {
  const pdb = getPipelineDb(dbPath);
  const rows = pdb.db.prepare(`
    SELECT p.id AS id, p.stage AS stage, e.to_stage AS latest_to_stage
    FROM pipeline_items p
    JOIN (
      SELECT item_id, to_stage, MAX(id) AS max_id
      FROM pipeline_events
      GROUP BY item_id
    ) e ON e.item_id = p.id
    WHERE p.stage != e.to_stage
  `).all() as Array<{ id: string; stage: string; latest_to_stage: string }>;

  return rows.map(r => ({ id: r.id, stage: r.stage, latestEventToStage: r.latest_to_stage }));
}

// ============================================================================
// Fingerprint computation
// ============================================================================

/**
 * Fingerprint for AlertGate dedup.
 * Format: "orphans=N,stuck=N,store_errors=N,oldest_orphan=<bucket>,oldest_stuck=<bucket>"
 *
 * Coarse age bucket means a STABLE condition (same counts, same ages) dedupes
 * and stays quiet. A WORSENING condition (count increases or age bucket advances)
 * produces a new fingerprint and re-fires.
 */
function buildFingerprint(report: IntegrityCheckReport): string {
  const oldestOrphan = report.orphanSpecs.length > 0 ? "<static>" : "none";
  const oldestStuck = report.stuckItems.length > 0
    ? ageBucket(Math.max(...report.stuckItems.map(s => s.ageMs)))
    : "none";

  return [
    `orphans=${report.orphanSpecs.length}`,
    `stuck=${report.stuckItems.length}`,
    `store_errors=${report.storeErrors.length}`,
    `guard_bypass=${report.guardBypassItems.length}`,
    `oldest_orphan=${oldestOrphan}`,
    `oldest_stuck=${oldestStuck}`,
  ].join(",");
}

// ============================================================================
// Main check function
// ============================================================================

export interface CheckOptions {
  /** Suppress AlertGate.send() calls. Used by tests and watchdog. */
  noAlert?: boolean;
  /** Override KAYA_HOME for isolation. Used by tests. */
  kayaHome?: string;
  /** Override pipeline.db path. */
  dbPath?: string;
  /** Override specs directory. */
  specsDir?: string;
}

export async function runCheck(opts: CheckOptions = {}): Promise<IntegrityCheckReport> {
  // Resolve paths at call time. The pipeline.db root is NOT under the kaya home —
  // defaultPipelineDbPath() resolves it as KAYA_HOME/.kaya (tests) or $HOME/.kaya (live),
  // which is a DIFFERENT root from getKayaHome() (KAYA_HOME or $HOME/.claude). Hand-rolling
  // join(home, ".kaya", ...) put the db under ~/.claude/.kaya in live runs (KAYA_HOME unset),
  // a non-existent file → every spec read as an orphan. Use the canonical resolver.
  const home = opts.kayaHome ?? getKayaHome();
  const dbPath = opts.dbPath ?? (opts.kayaHome
    ? join(opts.kayaHome, ".kaya", "runtime", "pipeline.db")
    : defaultPipelineDbPath());
  const specsDir = opts.specsDir ?? join(home, "plans", "Specs", "Queue");

  const checkedAt = new Date().toISOString();

  // Check 1: Orphan specs
  const orphanSpecs = checkOrphanSpecs(specsDir, dbPath);

  // Check 2: Store integrity
  const { errors: storeErrors, warnings: storeWarnings } = checkStoreIntegrity(dbPath);

  // Check 3: Stuck items
  const stuckItems = checkStuckItems(dbPath);

  // Check 4: Guard bypass ("wrote around the guard", slice A2)
  const guardBypassItems = checkGuardBypass(dbPath);

  const ok = orphanSpecs.length === 0 && storeErrors.length === 0 && stuckItems.length === 0
    && guardBypassItems.length === 0;

  // Machine-greppable summary line
  const summary = [
    `PIPELINE_ORPHANS(${orphanSpecs.length})`,
    `STUCK(${stuckItems.length})`,
    `STORE_ERRORS(${storeErrors.length})`,
    `GUARD_BYPASS(${guardBypassItems.length})`,
  ].join(" ");

  const report: IntegrityCheckReport = {
    checkedAt,
    orphanSpecs,
    stuckItems,
    storeErrors,
    storeWarnings,
    guardBypassItems,
    summary,
    ok,
  };

  // Alert (unless suppressed)
  if (!opts.noAlert && !ok) {
    const fingerprint = buildFingerprint(report);
    const messageParts: string[] = [`Pipeline integrity problem: ${summary}`];

    if (orphanSpecs.length > 0) {
      messageParts.push(`Orphan specs (${orphanSpecs.length}): ${orphanSpecs.slice(0, 3).map(o => o.itemId).join(", ")}`);
    }
    if (stuckItems.length > 0) {
      const oldest = stuckItems.reduce((a, b) => a.ageMs > b.ageMs ? a : b);
      messageParts.push(`Oldest stuck: ${oldest.id} in ${oldest.stage} for ${ageBucket(oldest.ageMs)}`);
    }
    if (storeErrors.length > 0) {
      messageParts.push(`Store errors (${storeErrors.length}): ${storeErrors.slice(0, 2).join("; ")}`);
    }
    if (guardBypassItems.length > 0) {
      messageParts.push(`Guard bypass (${guardBypassItems.length}): ${guardBypassItems.slice(0, 3).map(g => `${g.id} (${g.latestEventToStage}→${g.stage})`).join(", ")}`);
    }

    sendAlert(messageParts.join("\n"), {
      key: "pipeline-integrity",
      tier: "page",
      cooldownMs: 4 * 60 * 60 * 1000, // 4h cooldown
      fingerprint,
    });
  }

  return report;
}

// ============================================================================
// CLI entry
// ============================================================================

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "no-alert": { type: "boolean" },
      json:       { type: "boolean", short: "j" },
      help:       { type: "boolean", short: "h" },
      "kaya-home": { type: "string" },
      "db-path":   { type: "string" },
      "specs-dir": { type: "string" },
    },
    allowPositionals: true,
  });

  const cmd = positionals[0];

  if (values.help || !cmd) {
    console.log(`
PipelineIntegrity — Pipeline visibility checker

Commands:
  check      Run all three integrity checks and report

Options:
  --no-alert       Suppress AlertGate.send() (used by tests / watchdog)
  --json, -j       Output full JSON report to stdout
  --kaya-home <p>  Override KAYA_HOME (isolation for tests)
  --db-path <p>    Override pipeline.db path
  --specs-dir <p>  Override specs directory
  -h, --help       Show this help

Exit codes:
  0  All checks clean
  1  One or more problems found (orphans / stuck / store errors)

Machine-greppable summary line:
  PIPELINE_ORPHANS(n) STUCK(n) STORE_ERRORS(n)
`);
    process.exit(0);
  }

  if (cmd !== "check") {
    console.error(`Unknown command: ${cmd}. Use 'check'.`);
    process.exit(1);
  }

  // If --kaya-home was passed, point KAYA_HOME at it — getKayaHome()'s
  // env-keyed cache (see KayaHome.ts) picks up the change on its next call.
  if (values["kaya-home"]) {
    process.env.KAYA_HOME = values["kaya-home"];
  }

  const report = await runCheck({
    noAlert: values["no-alert"] ?? false,
    kayaHome: values["kaya-home"],
    dbPath: values["db-path"],
    specsDir: values["specs-dir"],
  });

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(report.summary);
    if (!report.ok) {
      if (report.orphanSpecs.length > 0) {
        console.log(`\nOrphan specs (${report.orphanSpecs.length}):`);
        for (const o of report.orphanSpecs) {
          console.log(`  ${o.itemId}  ${o.specPath}`);
        }
      }
      if (report.stuckItems.length > 0) {
        console.log(`\nStuck items (${report.stuckItems.length}):`);
        for (const s of report.stuckItems) {
          const ageH = Math.floor(s.ageMs / (60 * 60 * 1000));
          console.log(`  ${s.id}  stage=${s.stage}  age=${ageH}h  "${s.title.slice(0, 50)}"`);
        }
      }
      if (report.storeErrors.length > 0) {
        console.log(`\nStore errors (${report.storeErrors.length}):`);
        for (const e of report.storeErrors) {
          console.log(`  ${e}`);
        }
      }
      if (report.storeWarnings.length > 0) {
        console.log(`\nStore warnings (${report.storeWarnings.length}):`);
        for (const w of report.storeWarnings) {
          console.log(`  ${w}`);
        }
      }
      if (report.guardBypassItems.length > 0) {
        console.log(`\nGuard bypass (${report.guardBypassItems.length}):`);
        for (const g of report.guardBypassItems) {
          console.log(`  ${g.id}  stage=${g.stage}  latest_event_to_stage=${g.latestEventToStage}`);
        }
      }
    }
  }

  process.exit(report.ok ? 0 : 1);
}

if (import.meta.main) {
  main().catch(err => {
    console.error(`[PipelineIntegrity] Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
