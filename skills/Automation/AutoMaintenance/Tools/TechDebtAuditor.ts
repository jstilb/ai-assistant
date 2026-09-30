#!/usr/bin/env bun
/**
 * TechDebtAuditor — batched LLM scan of skills/, lib/, bin/, hooks/
 *
 * Enumerates target directories in small batches, reads each file's (truncated)
 * contents, calls inference() per batch to extract TechDebtAuditFinding[] from the
 * actual code, deduplicates against the registry
 * by location::category key, writes new items with source:"audit", and emits
 * a markdown report to MEMORY/AutoMaintenance/tech-debt/YYYY-MM-DD.md.
 *
 * Stub seam (production-inert when unset):
 *   KAYA_TECH_DEBT_STUB_FINDINGS=THROW   → throws Error("stub: forced failure")
 *   KAYA_TECH_DEBT_STUB_FINDINGS=<JSON array>            → parses findings from the JSON array
 *   KAYA_TECH_DEBT_STUB_FINDINGS={"findings":[...],"failedFiles":[...]}
 *                                         → simulates a partial batch failure (see
 *                                           AuditScanResult.failedBatches/failedFiles below)
 *   (unset)                              → uses real inference() path
 */

import { readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, relative, extname } from "path";
import { inference } from "../../../../lib/core/Inference.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { TechDebtRegistry, isValidScoreShape, type TechDebtScore, type TechDebtItem } from "./TechDebtRegistry.ts";

// ============================================================================
// Types
// ============================================================================

export interface TechDebtAuditFinding {
  location: string;   // file path relative to KAYA_HOME
  category: string;   // e.g. "complexity", "workaround", "reliability", "tech-debt"
  description: string;
  // In-batch scoring (S2) — the scan prompt asks the LLM to score each finding
  // alongside its description, so add() below can skip its own per-entry
  // inference call. Missing/partial/invalid shape (checked via
  // isValidScoreShape) is treated as score-less, not a reason to drop the
  // finding — see the registry.add() call site in scan() below.
  score?: TechDebtScore;
}

export interface AuditScanResult {
  newEntries: number;
  totalScanned: number;
  reportPath: string;
  scanIncomplete?: boolean;
  /** Number of batches whose inference call failed (distinct from scanIncomplete's systemic-throw path). Set only when > 0. */
  failedBatches?: number;
  /** Total batches attempted during this scan. Set alongside failedBatches. */
  totalBatches?: number;
  /** KAYA_HOME-relative paths of files whose batch failed inference — never scanned this run. Set alongside failedBatches. */
  failedFiles?: string[];
  /** Circuit breaker (S5, 401 auth-storm remediation) tripped — CIRCUIT_BREAKER_THRESHOLD
   *  consecutive batches each had a hard inference() failure (empty/error
   *  output — see scanBatch()), so the scan aborted before reaching every
   *  batch. Set only when the breaker actually tripped. */
  circuitBreakerTripped?: boolean;
  /** KAYA_HOME-relative paths of files in batches that were never even
   *  attempted because the circuit breaker aborted the scan — a SUBSET of
   *  failedFiles (which also includes files from batches that WERE attempted
   *  and failed). Set alongside circuitBreakerTripped. */
  circuitBreakerSkippedFiles?: string[];
}

// ============================================================================
// Constants
// ============================================================================

const SCAN_DIRS = ["skills", "lib", "bin", "hooks"];
// Batches carry truncated file CONTENTS (not just paths), so keep batches small to bound context.
const BATCH_SIZE = 6;
const MAX_LINES_PER_FILE = 200;
// Circuit breaker (S5, 401 auth-storm remediation): 3 consecutive batches
// each hitting a hard inference() failure (exit≠0/timeout/spawn error —
// InferenceResult.success:false, surfaced by scanBatch() as a non-empty
// failedFiles with no findings) means the outage is systemic (e.g. a dead
// auth token), not one flaky batch. Burning through the remaining ~480
// batches one-by-one just piles up the identical failure with zero chance of
// a real result — see MEMORY/daemon/cron/manifests/weekly-tech-debt.yaml
// (~490 scan batches/run) and the 2026-07-15 401 auth-storm investigation.
const CIRCUIT_BREAKER_THRESHOLD = 3;

// Extensions/paths to skip — binary, generated, or data files
const SKIP_EXTENSIONS = new Set([".d.ts", ".map", ".lock", ".jsonl", ".json", ".db", ".png", ".jpg", ".jpeg", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".eot"]);
const SKIP_PATH_FRAGMENTS = ["dist/", "node_modules/", ".d.ts", "/.git/"];

// ============================================================================
// Helpers
// ============================================================================

function today(): string {
  return new Date().toISOString().split("T")[0]!;
}

function shouldSkip(filePath: string): boolean {
  const ext = extname(filePath);
  // .d.ts check (extname gives ".ts" for .d.ts)
  if (filePath.endsWith(".d.ts")) return true;
  if (SKIP_EXTENSIONS.has(ext)) return true;
  for (const fragment of SKIP_PATH_FRAGMENTS) {
    if (filePath.includes(fragment)) return true;
  }
  return false;
}

function collectFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
        files.push(...collectFiles(fullPath));
      } else if (entry.isFile()) {
        if (!shouldSkip(fullPath)) {
          files.push(fullPath);
        }
      }
    }
  } catch {
    // Skip unreadable directories
  }
  return files;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ============================================================================
// Stub seam
// ============================================================================

// Object form of the stub — simulates a partial batch failure (some findings
// came back, some files' batch failed inference) without needing real batching.
interface StubPartialFailure {
  findings: TechDebtAuditFinding[];
  failedFiles: string[];
}

function getStubFindings(): TechDebtAuditFinding[] | StubPartialFailure | "THROW" | null {
  const stub = process.env.KAYA_TECH_DEBT_STUB_FINDINGS;
  if (stub === undefined) return null;
  if (stub === "THROW") return "THROW";
  try {
    const parsed = JSON.parse(stub);
    if (Array.isArray(parsed)) return parsed as TechDebtAuditFinding[];
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      Array.isArray((parsed as Record<string, unknown>)["findings"])
    ) {
      const obj = parsed as Record<string, unknown>;
      const failedFiles = Array.isArray(obj["failedFiles"]) ? (obj["failedFiles"] as string[]) : [];
      return { findings: obj["findings"] as TechDebtAuditFinding[], failedFiles };
    }
    throw new Error("KAYA_TECH_DEBT_STUB_FINDINGS must be a JSON array or a {findings, failedFiles} object");
  } catch (err) {
    throw new Error(`KAYA_TECH_DEBT_STUB_FINDINGS parse error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ============================================================================
// LLM scan helpers
// ============================================================================

// Distinguishes "inference failed for this batch" from "no findings" — a
// failed batch reports its own file paths (KAYA_HOME-relative, matching the
// `location` convention) so the caller can accumulate which files never got
// scanned instead of silently treating the batch as clean.
interface ScanBatchResult {
  findings: TechDebtAuditFinding[];
  failedFiles: string[];
}

async function scanBatch(files: string[], kayaHome: string): Promise<ScanBatchResult> {
  const failedFiles = files.map((f) => relative(kayaHome, f));

  // Read each file's (truncated) contents so the LLM analyzes REAL code, not just file names.
  const fileBlocks: string[] = [];
  for (const f of files) {
    const rel = relative(kayaHome, f);
    let content: string;
    try {
      content = readFileSync(f, "utf-8");
    } catch {
      continue; // skip unreadable files
    }
    const lines = content.split("\n");
    const truncated = lines.length > MAX_LINES_PER_FILE;
    const body = lines.slice(0, MAX_LINES_PER_FILE).join("\n");
    fileBlocks.push(
      `### ${rel}${truncated ? ` (first ${MAX_LINES_PER_FILE} of ${lines.length} lines)` : ""}\n\`\`\`\n${body}\n\`\`\``
    );
  }

  // No readable files at all — same as before, treated as "nothing to report"
  // rather than a failure (no inference call was even attempted).
  if (fileBlocks.length === 0) return { findings: [], failedFiles: [] };

  const systemPrompt = `You are a code quality analyst specializing in technical debt. You are given the CONTENTS of source files. Analyze the ACTUAL code for technical debt — e.g. TODO/FIXME/HACK markers, swallowed errors, missing/weak tests, workarounds, high complexity, duplication, unsafe casts, or reliability/correctness risks.

Return a JSON array of objects. Each object must have exactly these fields:
{
  "location": "<file path exactly as given in the ### header>",
  "category": "<one of: complexity, workaround, reliability, maintainability, performance, correctness, tech-debt>",
  "description": "<concise one-sentence description of the SPECIFIC debt found in the code>",
  "score": {
    "severity": <0-100, how severe is the technical harm>,
    "impact": <0-100, how much does this impact the codebase / product quality>,
    "effort": <0-100, how much effort is required to fix (100 = very high effort)>,
    "composite": <0-100, overall priority score (higher = should fix sooner)>
  }
}

Base every finding on evidence visible in the provided code — do NOT guess from file names. Return an empty array [] if no real debt is found. Return ONLY a valid JSON array.`;

  const userPrompt = `Analyze the following source files for technical debt:\n\n${fileBlocks.join("\n\n")}\n\nReturn a JSON array of TechDebtAuditFinding objects, each grounded in the code shown and scored on severity, impact, effort, and composite priority (0-100 each). Return [] if none.`;

  const result = await inference({
    systemPrompt,
    userPrompt,
    level: "standard",
    expectJson: true,
  });

  if (!result.success || result.parsed === undefined) {
    console.warn(`[TechDebtAuditor] batch inference failed: ${result.error ?? "no parsed output"} — ${failedFiles.length} file(s) unscanned`);
    return { findings: [], failedFiles };
  }

  if (!Array.isArray(result.parsed)) {
    console.warn(`[TechDebtAuditor] batch inference returned non-array: ${typeof result.parsed} — ${failedFiles.length} file(s) unscanned`);
    return { findings: [], failedFiles };
  }

  // Validate and normalize each finding
  const findings = (result.parsed as unknown[])
    .filter((item): item is TechDebtAuditFinding => {
      if (typeof item !== "object" || item === null) return false;
      const o = item as Record<string, unknown>;
      return (
        typeof o["location"] === "string" && o["location"].length > 0 &&
        typeof o["category"] === "string" && o["category"].length > 0 &&
        typeof o["description"] === "string" && o["description"].length > 0
      );
    });
  return { findings, failedFiles: [] };
}

// ============================================================================
// Report builder
// ============================================================================

function buildReport(opts: {
  date: string;
  newEntries: number;
  totalScanned: number;
  findings: TechDebtAuditFinding[];
  scanIncomplete: boolean;
  error?: string;
  failedBatches?: number;
  totalBatches?: number;
  failedFiles?: string[];
  // Circuit breaker (S5) — set only when the scan aborted early after 3
  // consecutive hard-failure batches.
  circuitBreakerTripped?: boolean;
  circuitBreakerSkippedFiles?: string[];
  // Top-N open-item ranking (reservoir visibility) — undefined only on the
  // scanIncomplete (systemic throw) path, where the registry may never have
  // been consulted; the section is omitted entirely in that case.
  topOpenItems?: TechDebtItem[];
  openCount?: number;
  totalCount?: number;
}): string {
  const { date, newEntries, totalScanned, findings, scanIncomplete, error, failedBatches, totalBatches, failedFiles, circuitBreakerTripped, circuitBreakerSkippedFiles, topOpenItems, openCount, totalCount } = opts;
  const degraded = !scanIncomplete && (failedBatches ?? 0) > 0;
  let r = `# Tech Debt Audit Report — ${date}\n\n`;

  // scan_incomplete (systemic throw — see the catch in scan()) takes
  // precedence over the batch-level degraded status below; the two paths are
  // mutually exclusive in practice (a systemic throw breaks the batch loop),
  // but precedence is made explicit here per spec.
  if (scanIncomplete) {
    r += `## Status: INCOMPLETE (scan_incomplete)\n\n`;
    if (error) r += `**Error:** ${error}\n\n`;
    r += `The audit scan did not complete successfully. Partial results below.\n\n`;
  } else if (circuitBreakerTripped) {
    const unscannedCount = failedFiles?.length ?? 0;
    r += `## Status: ABORTED — circuit breaker tripped (${unscannedCount} files unscanned)\n\n`;
    r += `3 consecutive batches each hit a hard inference() failure (empty/error output) — ` +
      `the scan aborted rather than burning through the remaining batches on a dead connection. ` +
      `${circuitBreakerSkippedFiles?.length ?? 0} file(s) were skipped entirely (never attempted).\n\n`;
  } else if (degraded) {
    const unscannedCount = failedFiles?.length ?? 0;
    r += `## Status: Degraded — ${failedBatches}/${totalBatches ?? "?"} batches failed (${unscannedCount} files unscanned)\n\n`;
  } else {
    r += `## Status: Complete\n\n`;
  }

  r += `## Summary\n\n`;
  r += `- Files scanned: ${totalScanned}\n`;
  r += `- New registry entries: ${newEntries}\n`;
  r += `- Total findings from scan: ${findings.length}\n\n`;

  // Reservoir visibility — the 2026-07-10 proving run left ~1,039/2,444 open
  // items permanently null-scored, and top()/autoPromoteTop() sort nulls
  // last, so more than 60% of the reservoir was invisible to ranking. This
  // section makes the current top-10 (and open/total counts) visible every
  // week regardless of whether nulls remain.
  if (topOpenItems !== undefined && openCount !== undefined && totalCount !== undefined) {
    r += `## Top open items\n\n`;
    r += `Open: ${openCount} / Total: ${totalCount}\n\n`;
    if (topOpenItems.length > 0) {
      r += `| Rank | Score | Location | Category | Description |\n`;
      r += `|------|-------|----------|----------|-------------|\n`;
      topOpenItems.forEach((item, i) => {
        const score = item.score?.composite;
        const scoreDisplay = score === null || score === undefined ? "—" : String(score);
        r += `| ${i + 1} | ${scoreDisplay} | \`${item.location}\` | ${item.category} | ${item.description} |\n`;
      });
      r += "\n";
    } else {
      r += `No open items.\n\n`;
    }
  }

  if (degraded && failedFiles && failedFiles.length > 0) {
    r += `## Unscanned Files (${failedFiles.length})\n\n`;
    for (const f of failedFiles) {
      r += `- \`${f}\`\n`;
    }
    r += "\n";
  }

  if (findings.length > 0) {
    r += `## Findings\n\n`;
    r += `| Location | Category | Description |\n`;
    r += `|----------|----------|-------------|\n`;
    for (const f of findings) {
      r += `| \`${f.location}\` | ${f.category} | ${f.description} |\n`;
    }
    r += "\n";
  }

  return r;
}

// ============================================================================
// TechDebtAuditor
// ============================================================================

export class TechDebtAuditor {
  async scan(): Promise<AuditScanResult> {
    const kayaHome = getKayaHome();
    const reportDir = join(kayaHome, "MEMORY", "AutoMaintenance", "tech-debt");
    // Capture the run date ONCE and thread it through filename + header.
    // today() is UTC-based and used to be called separately at scan start
    // (filename) and render time (header), so a multi-hour run crossing UTC
    // midnight self-disagreed: the 07-10 proving run wrote 2026-07-10.md
    // with a "2026-07-11" header. Stub seam (production-inert when unset,
    // shape-validated): KAYA_TECH_DEBT_STUB_DATE lets tests inject a date
    // that provably reaches BOTH the filename and the header from this one
    // capture — a regression back to a second today() call at render time
    // shows up as header ≠ injected date.
    const stubDate = process.env.KAYA_TECH_DEBT_STUB_DATE;
    const runDate = stubDate !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(stubDate) ? stubDate : today();
    const reportPath = join(reportDir, `${runDate}.md`);

    // Ensure report directory exists
    if (!existsSync(reportDir)) {
      mkdirSync(reportDir, { recursive: true });
    }

    // Pass explicit path so registry doesn't use the cached kayaHome value
    const registryPath = join(kayaHome, "MEMORY", "QUEUES", "tech-debt.jsonl");
    const registry = new TechDebtRegistry(registryPath);

    // --- Stub seam ---
    const stub = getStubFindings();
    if (stub === "THROW") {
      // Degraded path: write minimal report, return scanIncomplete
      const report = buildReport({
        date: runDate,
        newEntries: 0,
        totalScanned: 0,
        findings: [],
        scanIncomplete: true,
        error: "stub: forced failure",
      });
      writeFileSync(reportPath, report, "utf-8");
      return { newEntries: 0, totalScanned: 0, reportPath, scanIncomplete: true };
    }

    let allFindings: TechDebtAuditFinding[] = [];
    let totalScanned = 0;
    let scanIncomplete = false;
    let scanError: string | undefined;
    // Batch-level degradation — distinct from scanIncomplete (systemic throw,
    // below). A batch that fails inference is recorded here instead of being
    // silently treated as "no findings"; the loop continues to the next batch.
    let failedBatches = 0;
    let totalBatches = 0;
    let failedFiles: string[] = [];
    // Circuit breaker (S5) — set only when it actually trips.
    let circuitBreakerTripped = false;
    let circuitBreakerSkippedFiles: string[] = [];

    if (stub !== null && Array.isArray(stub)) {
      // Stub findings provided — use them directly instead of calling inference()
      allFindings = stub;
      totalScanned = stub.length;
    } else if (stub !== null) {
      // Object-form stub — simulates a partial batch failure as a single batch.
      allFindings = stub.findings;
      totalScanned = stub.findings.length + stub.failedFiles.length;
      totalBatches = 1;
      if (stub.failedFiles.length > 0) {
        failedBatches = 1;
        failedFiles = [...stub.failedFiles];
      }
    } else {
      // Real inference path: collect files, batch them, call LLM per batch
      try {
        const allFiles: string[] = [];
        for (const dir of SCAN_DIRS) {
          const fullDir = join(kayaHome, dir);
          allFiles.push(...collectFiles(fullDir));
        }
        totalScanned = allFiles.length;

        const batches = chunk(allFiles, BATCH_SIZE);
        totalBatches = batches.length;
        let consecutiveHardFailures = 0;
        for (let i = 0; i < batches.length; i++) {
          const batch = batches[i]!;
          try {
            const batchResult = await scanBatch(batch, kayaHome);
            allFindings.push(...batchResult.findings);
            if (batchResult.failedFiles.length > 0) {
              failedBatches++;
              failedFiles.push(...batchResult.failedFiles);
              consecutiveHardFailures++;
            } else {
              consecutiveHardFailures = 0;
            }

            if (consecutiveHardFailures >= CIRCUIT_BREAKER_THRESHOLD) {
              const skippedBatches = batches.slice(i + 1);
              const skippedFiles = skippedBatches.flat().map((f) => relative(kayaHome, f));
              circuitBreakerTripped = true;
              circuitBreakerSkippedFiles = skippedFiles;
              failedBatches += skippedBatches.length;
              failedFiles.push(...skippedFiles);
              // ONE summary naming the streak and everything skipped — no
              // silent cap. This is the sole console line the breaker emits.
              console.error(
                `[TechDebtAuditor] CIRCUIT BREAKER: ${consecutiveHardFailures} consecutive hard spawn failures ` +
                `(batch ${i + 1}/${totalBatches}) — aborting scan. ${skippedBatches.length} batch(es) / ` +
                `${skippedFiles.length} file(s) skipped, never scanned this run: ${skippedFiles.join(', ')}`
              );
              break;
            }
          } catch (err) {
            console.warn(`[TechDebtAuditor] batch scan error:`, err instanceof Error ? err.message : String(err));
            scanIncomplete = true;
            scanError = err instanceof Error ? err.message : String(err);
            break;
          }
        }
      } catch (err) {
        scanIncomplete = true;
        scanError = err instanceof Error ? err.message : String(err);
        console.error("[TechDebtAuditor] scan failed:", scanError);
      }
    }

    // Add findings to registry (handles dedup internally). In-batch scoring
    // (S2): a finding whose score rode along from the scan prompt AND passes
    // isValidScoreShape is forwarded so add() skips its own per-entry
    // scoreTechDebtItem() inference call — this is the single funnel for ALL
    // three finding sources (real scanBatch(), stub array, stub object form),
    // so score validation only needs to live here, not duplicated per source.
    // Score-less/invalid-score findings fall through to add()'s existing
    // per-entry fallback — no new failure mode.
    let newEntries = 0;
    for (const finding of allFindings) {
      try {
        const score = finding.score !== undefined && isValidScoreShape(finding.score)
          ? finding.score
          : undefined;
        const { isDuplicate } = await registry.add({
          description: finding.description,
          location: finding.location,
          category: finding.category,
          source: "audit",
          ...(score !== undefined ? { score } : {}),
        });
        if (!isDuplicate) {
          newEntries++;
        }
      } catch (err) {
        console.warn("[TechDebtAuditor] registry.add failed:", err instanceof Error ? err.message : String(err));
      }
    }

    // Reservoir visibility (post-scan state — reflects this run's new entries
    // too) — smallest diff: reuse the registry instance already in scope
    // rather than adding new registry methods for combined stats.
    const topOpenItems = registry.top(10);
    const openCount = registry.list().length;
    const totalCount = registry.all().length;

    // Write report
    const report = buildReport({
      date: runDate,
      newEntries,
      totalScanned,
      findings: allFindings,
      scanIncomplete,
      error: scanError,
      failedBatches,
      totalBatches,
      failedFiles,
      circuitBreakerTripped,
      circuitBreakerSkippedFiles,
      topOpenItems,
      openCount,
      totalCount,
    });
    writeFileSync(reportPath, report, "utf-8");

    return {
      newEntries,
      totalScanned,
      reportPath,
      ...(scanIncomplete ? { scanIncomplete } : {}),
      ...(failedBatches > 0 ? { failedBatches, totalBatches, failedFiles } : {}),
      ...(circuitBreakerTripped ? { circuitBreakerTripped, circuitBreakerSkippedFiles } : {}),
    };
  }
}

// ============================================================================
// CLI entrypoint
// ============================================================================

if (import.meta.main) {
  const auditor = new TechDebtAuditor();
  auditor.scan()
    .then((result) => {
      console.log(`[TechDebtAuditor] Scan complete.`);
      console.log(`  New entries: ${result.newEntries}`);
      console.log(`  Total scanned: ${result.totalScanned}`);
      console.log(`  Report: ${result.reportPath}`);
      if (result.scanIncomplete) {
        console.error("[TechDebtAuditor] WARNING: scan was incomplete");
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error("[TechDebtAuditor] Fatal:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
