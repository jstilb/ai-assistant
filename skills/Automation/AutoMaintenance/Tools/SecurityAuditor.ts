/**
 * SecurityAuditor.ts — Security audit checks for AutoMaintenance.
 * Runs trufflehog secret scanning. Returns typed findings.
 *
 * FAILURE HANDLING (E1 — secret-scan-honest, 2026-07-07):
 * A trufflehog scan that crashes, times out, or emits unparseable output is
 * NOT the same thing as "0 secrets found". The pre-E1 implementation wrapped
 * the whole invocation in a bare `catch {}` that swallowed ANY scan error and
 * printed "0 verified secrets" regardless — turning a broken/crashed scanner
 * into a false all-clear delivered by the weekly-security alert. A genuine
 * scan error (non-zero exit, timeout, or output that fails to parse as
 * trufflehog JSON) now instead:
 *
 *   1. Calls FailureLog.recordFailure() with tier 'page' — an immediate,
 *      edge-triggered page through AlertGate (distinct from "trufflehog is
 *      simply not installed", which remains a silent, legitimate skip).
 *   2. Returns a distinct `scan_error` finding — never folded into the
 *      verified-secret count — so AlertManager.evaluate() classifies it
 *      CRITICAL on first occurrence (see AlertManager.ts).
 *   3. Appends a `scan_error` line to the per-finding report file so the
 *      forensic trail explains WHY no per-secret detail exists for that run.
 *
 * "unknown" must never render as "clean".
 */

import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { getCorrectPath } from "../../../../lib/core/PathEnv";
import { getKayaHome, kayaHomePath, assertNotLiveHomeUnderTest } from "../../../../lib/core/KayaHome.ts";
import { recordFailure } from "../../../../lib/core/FailureLog.ts";
import { createAppendLog } from "../../../../lib/core/AppendLog.ts";

const PathEnv = {
  resolve(bin: string): string | null {
    for (const dir of getCorrectPath().split(":")) {
      const p = join(dir, bin);
      if (existsSync(p)) return p;
    }
    return null;
  },
};

/**
 * BASE newline-separated regex excludes passed to trufflehog's
 * -x/--exclude-paths flag (kills scan noise/timeouts on node_modules/, .git/,
 * and Google Takeout extracts — see the file itself for why the worktrees
 * exclusion is NOT in this static file).
 */
const EXCLUDES_BASE_PATH = join(import.meta.dir, "secretscan-excludes.txt");

/** Escapes regex metacharacters so a literal path can be embedded in a regex. */
function escapeRegexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a per-invocation excludes file: the static base patterns
 * (node_modules/.git/Takeout) plus a worktrees exclusion ANCHORED to the
 * current scan root with `^`.
 *
 * WHY anchored, not a static "(^|/)worktrees/" line: this repo checks
 * worktree sessions out at <repo-root>/.claude/worktrees/<name>. An
 * unanchored pattern matches that substring wherever it occurs — including
 * as a PREFIX of the scan root's own path when the scan happens to be run
 * FROM WITHIN a worktree checkout (every engineering session in this repo
 * isolates into one). That silently excludes 100% of the scan (verified
 * empirically during E1 development: chunks:0, bytes:0, reported as a false
 * "0 secrets" clean run — precisely the failure class this slice exists to
 * kill). Anchoring with `^<scanTarget>/` means the pattern only ever matches
 * content NESTED below the scan root (e.g. a sibling worktree checked out
 * inside the tree being scanned), never the root's own ancestor path.
 *
 * Returns the temp file path; caller is responsible for deleting it
 * (see the `finally` block in runSecurityAuditCheck).
 */
function buildExcludesFile(scanTarget: string): string {
  const base = readFileSync(EXCLUDES_BASE_PATH, "utf-8");
  const anchoredWorktreesExclude = `^${escapeRegexLiteral(scanTarget)}/(\\.claude/)?worktrees/`;
  const tmpPath = join(tmpdir(), `secretscan-excludes-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(tmpPath, `${base}\n${anchoredWorktreesExclude}\n`, "utf-8");
  return tmpPath;
}

export interface SecurityFinding {
  workflow: string;
  step: string;
  type: string;
  finding: string;
  verified?: boolean;
  count?: number;
}

/** One trufflehog JSON finding line, reduced to non-secret fields only. */
interface ParsedFinding {
  detector: string;
  file?: string;
  line?: number;
  verified?: boolean;
}

/**
 * Injectable seam for tests — avoids shelling out to the real trufflehog
 * binary. Production callers (Workflows.ts) call runSecurityAuditCheck()
 * with no args and get the real resolveBin/runScan below.
 */
export interface SecretScanDeps {
  resolveBin?: () => string | null;
  runScan?: (bin: string, args: string[]) => string;
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

/** Resolved fresh on every call (not a module-load-time constant) so it
 * always reflects whichever KAYA_HOME/KAYA_DIR is active right now — a test
 * that pins a fresh mkdtemp sandbox per-test would otherwise see a stale
 * path frozen at first module import (dynamic imports are cached). */
function reportPath(): string {
  return kayaHomePath("MEMORY", "security", `secret-scan-report-${today()}.jsonl`);
}

function parseTruffleHogLine(line: string): ParsedFinding {
  const parsed = JSON.parse(line) as {
    DetectorName?: unknown;
    Verified?: unknown;
    SourceMetadata?: { Data?: { Filesystem?: { file?: unknown; line?: unknown } } };
  };
  const fsData = parsed.SourceMetadata?.Data?.Filesystem;
  return {
    detector: typeof parsed.DetectorName === "string" ? parsed.DetectorName : "unknown",
    file: typeof fsData?.file === "string" ? fsData.file : undefined,
    line: typeof fsData?.line === "number" ? fsData.line : undefined,
    verified: typeof parsed.Verified === "boolean" ? parsed.Verified : undefined,
  };
}

/**
 * Writes the per-finding report: one `summary` line (always — so the report
 * file's mere existence is a reliable "the scan ran" signal even on a clean
 * day) followed by one `finding` line per detected secret. NEVER writes the
 * secret value itself — detector/file/line only.
 */
function writeFindingsReport(findings: ParsedFinding[]): Record<string, number> {
  assertNotLiveHomeUnderTest("SecurityAuditor.writeFindingsReport");
  const breakdown: Record<string, number> = {};
  for (const f of findings) breakdown[f.detector] = (breakdown[f.detector] ?? 0) + 1;

  const log = createAppendLog(reportPath(), { maxSizeBytes: Number.MAX_SAFE_INTEGER });
  const ts = new Date().toISOString();
  log.append({ ts, type: "summary", totalFindings: findings.length, breakdown });
  for (const f of findings) {
    log.append({ ts, type: "finding", detector: f.detector, file: f.file, line: f.line, verified: f.verified ?? true });
  }
  return breakdown;
}

/** Best-effort forensic line explaining why no per-finding detail exists for
 * this run. recordFailure() (called by the caller) is the durable/paging
 * signal — this is supplementary, so failures here must never throw. */
function writeErrorReportLine(reason: string): void {
  try {
    assertNotLiveHomeUnderTest("SecurityAuditor.writeErrorReportLine");
    createAppendLog(reportPath(), { maxSizeBytes: Number.MAX_SAFE_INTEGER }).append({
      ts: new Date().toISOString(),
      type: "scan_error",
      reason,
    });
  } catch {
    // Best-effort — recordFailure() already recorded the durable signal.
  }
}

function formatBreakdown(breakdown: Record<string, number>): string {
  return Object.entries(breakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([detector, count]) => `${count} ${detector}`)
    .join(", ");
}

/** A scan that failed to complete is UNKNOWN, not clean. Pages immediately
 * via FailureLog.recordFailure and emits a distinct scan_error finding —
 * never "0 secrets". */
function handleScanError(err: unknown, findings: SecurityFinding[]): void {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const trimmed = rawMessage.length > 300 ? `${rawMessage.slice(0, 300)}…` : rawMessage;
  const message = `Secret scan FAILED — result UNKNOWN, NOT verified clean: ${trimmed}`;

  recordFailure({
    source: "SecurityAuditor.secretScan",
    error: err,
    tier: "page",
    alertKey: "security-scan-error",
    alertMessage: message,
  });
  writeErrorReportLine(trimmed);
  findings.push({ workflow: "weekly-security", step: "secret-scan", type: "scan_error", finding: message });
  console.error(`✗ ${message}`);
}

export async function runSecurityAuditCheck(deps: SecretScanDeps = {}): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];
  const resolveBin = deps.resolveBin ?? (() => PathEnv.resolve("trufflehog"));
  // 900000 (15 min), raised from 300000 (2026-08-17): scan durations had
  // brushed the 5-min cap since July and finally ETIMEDOUT on 2026-08-16
  // (alerts.jsonl 32fdb0c0 — "result UNKNOWN, NOT verified clean"). Must
  // stay well under maintenance-weekly-security.yaml's outer job timeout
  // (1500000) or the outer SIGTERM kills the whole workflow with no
  // scan_error finding at all.
  const runScan = deps.runScan ?? ((bin, args) => execFileSync(bin, args, { encoding: "utf-8", timeout: 900000 }));

  const truffleHogPath = resolveBin();
  if (!truffleHogPath) {
    // Legitimate skip — trufflehog is simply not installed. Distinct from a
    // scan that WAS attempted and failed (handleScanError, below).
    console.log("⚠ trufflehog not found, skipping secret scan");
    return findings;
  }

  const scanTarget = getKayaHome();
  const excludesPath = buildExcludesFile(scanTarget);
  const args = ["filesystem", scanTarget, "--only-verified", "--json", "--exclude-paths", excludesPath];

  let rawOutput: string;
  try {
    try {
      rawOutput = runScan(truffleHogPath, args);
    } catch (err) {
      handleScanError(err, findings);
      return findings;
    }

    const lines = rawOutput.trim().split("\n").filter((l) => l.length > 0);
    const parsed: ParsedFinding[] = [];
    let parseErrors = 0;
    for (const line of lines) {
      try {
        parsed.push(parseTruffleHogLine(line));
      } catch {
        parseErrors++;
      }
    }

    if (parseErrors > 0) {
      // Any unparseable line means the output stream isn't trustworthy
      // end-to-end — a partial count would still be an unverified guess, not
      // a verified result. Treat the whole run as failed rather than
      // under-report.
      handleScanError(
        new Error(`trufflehog produced ${parseErrors} unparseable JSON line(s) out of ${lines.length}`),
        findings,
      );
      return findings;
    }

    return finishScan(parsed, findings);
  } finally {
    try {
      if (existsSync(excludesPath)) unlinkSync(excludesPath);
    } catch {
      // Best-effort cleanup — a leftover tmp file is harmless clutter, not a
      // correctness or security issue (it never contains secret values).
    }
  }
}

function finishScan(parsed: ParsedFinding[], findings: SecurityFinding[]): SecurityFinding[] {
  const breakdown = writeFindingsReport(parsed);

  if (parsed.length > 0) {
    const breakdownStr = formatBreakdown(breakdown);
    findings.push({
      workflow: "weekly-security",
      step: "secret-scan",
      type: "verified_secret",
      finding: `${parsed.length} verified secrets found (${breakdownStr})`,
      verified: true,
      count: parsed.length,
    });
    console.log(`✗ Secret scan complete (${parsed.length} verified secrets: ${breakdownStr})`);
  } else {
    console.log("✓ Secret scan complete (0 verified secrets)");
  }

  return findings;
}
