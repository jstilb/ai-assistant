/**
 * SecurityAuditor.test.ts — E1 (secret-scan-honest)
 *
 * Root cause under test: the pre-E1 implementation had a bare `catch {}`
 * around the trufflehog invocation that swallowed ANY scan error (crash,
 * timeout, bad flag, missing binary at the resolved path) and reported it
 * identically to "0 secrets found". These tests assert that a genuine scan
 * failure is NEVER indistinguishable from a clean result: it must surface as
 * a distinct `scan_error` finding and page via FailureLog.recordFailure().
 *
 * Hermeticity: recordFailure() throws under NODE_ENV=test if KAYA_HOME
 * resolves to the live default (see lib/core/KayaHome.ts
 * assertNotLiveHomeUnderTest) — so every test pins KAYA_HOME/KAYA_DIR to a
 * mkdtemp sandbox and sets KAYA_ALERT_DRY_RUN=1 before importing the module
 * under test (env must be set before FailureLog/AlertGate resolve paths).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let sandbox: string;
let prevKayaHome: string | undefined;
let prevKayaDir: string | undefined;
let prevDryRun: string | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "security-auditor-test-"));
  prevKayaHome = process.env.KAYA_HOME;
  prevKayaDir = process.env.KAYA_DIR;
  prevDryRun = process.env.KAYA_ALERT_DRY_RUN;
  process.env.KAYA_HOME = sandbox;
  process.env.KAYA_DIR = sandbox;
  process.env.KAYA_ALERT_DRY_RUN = "1";
});

afterEach(() => {
  if (prevKayaHome === undefined) delete process.env.KAYA_HOME; else process.env.KAYA_HOME = prevKayaHome;
  if (prevKayaDir === undefined) delete process.env.KAYA_DIR; else process.env.KAYA_DIR = prevKayaDir;
  if (prevDryRun === undefined) delete process.env.KAYA_ALERT_DRY_RUN; else process.env.KAYA_ALERT_DRY_RUN = prevDryRun;
  if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
});

function today(): string {
  return new Date().toISOString().split("T")[0];
}

function reportPath(): string {
  return join(sandbox, "MEMORY", "security", `secret-scan-report-${today()}.jsonl`);
}

function failureLogPath(): string {
  return join(sandbox, "MEMORY", "MONITORING", "failure-log.jsonl");
}

function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

const AWS_LINE = JSON.stringify({
  DetectorName: "AWS",
  Verified: true,
  SourceMetadata: { Data: { Filesystem: { file: "skills/Foo/secret.ts", line: 12 } } },
  Raw: "AKIA_SHOULD_NEVER_APPEAR_IN_REPORT",
});
const GITHUB_LINE = JSON.stringify({
  DetectorName: "Github",
  Verified: true,
  SourceMetadata: { Data: { Filesystem: { file: "skills/Bar/config.ts", line: 3 } } },
  Raw: "ghp_SHOULD_NEVER_APPEAR_IN_REPORT",
});

describe("runSecurityAuditCheck", () => {
  it("trufflehog not installed — legitimate skip, no findings, no error", async () => {
    const { runSecurityAuditCheck } = await import("./SecurityAuditor");
    const findings = await runSecurityAuditCheck({ resolveBin: () => null });
    expect(findings).toEqual([]);
  });

  it("a genuine scan error is reported as scan_error, NEVER as '0 secrets'", async () => {
    const { runSecurityAuditCheck } = await import("./SecurityAuditor");
    const findings = await runSecurityAuditCheck({
      resolveBin: () => "/opt/homebrew/bin/trufflehog",
      runScan: () => {
        throw new Error("exit status 1: unrecognized flag");
      },
    });

    expect(findings.length).toBe(1);
    expect(findings[0].type).toBe("scan_error");
    expect(findings[0].finding).not.toContain("0 verified secrets");
    expect(findings[0].finding.toLowerCase()).toContain("unknown");
  });

  it("a genuine scan error pages via FailureLog.recordFailure (tier: page)", async () => {
    const { runSecurityAuditCheck } = await import("./SecurityAuditor");
    await runSecurityAuditCheck({
      resolveBin: () => "/opt/homebrew/bin/trufflehog",
      runScan: () => {
        throw new Error("exit status 2: binary not found");
      },
    });

    const records = readJsonl(failureLogPath());
    expect(records.length).toBeGreaterThan(0);
    const rec = records[records.length - 1];
    expect(rec.source).toBe("SecurityAuditor.secretScan");
    expect(rec.tier).toBe("page");
  });

  it("unparseable scan output is treated as a scan error, not a clean/partial count", async () => {
    const { runSecurityAuditCheck } = await import("./SecurityAuditor");
    const findings = await runSecurityAuditCheck({
      resolveBin: () => "/opt/homebrew/bin/trufflehog",
      runScan: () => "not valid json\n{also not json}",
    });

    expect(findings.length).toBe(1);
    expect(findings[0].type).toBe("scan_error");
  });

  it("clean scan (0 findings) reports no findings and still writes a report file", async () => {
    const { runSecurityAuditCheck } = await import("./SecurityAuditor");
    const findings = await runSecurityAuditCheck({
      resolveBin: () => "/opt/homebrew/bin/trufflehog",
      runScan: () => "",
    });

    expect(findings).toEqual([]);
    expect(existsSync(reportPath())).toBe(true);
    const lines = readJsonl(reportPath());
    expect(lines.length).toBe(1);
    expect(lines[0].type).toBe("summary");
    expect(lines[0].totalFindings).toBe(0);
  });

  it("dirty scan reports verified_secret with a per-detector breakdown in the message", async () => {
    const { runSecurityAuditCheck } = await import("./SecurityAuditor");
    const findings = await runSecurityAuditCheck({
      resolveBin: () => "/opt/homebrew/bin/trufflehog",
      runScan: () => `${AWS_LINE}\n${GITHUB_LINE}`,
    });

    expect(findings.length).toBe(1);
    expect(findings[0].type).toBe("verified_secret");
    expect(findings[0].count).toBe(2);
    expect(findings[0].finding).toContain("AWS");
    expect(findings[0].finding).toContain("Github");
  });

  it("passes an exclude-paths file whose worktrees exclusion is ANCHORED to the scan root", async () => {
    // Regression guard for a real bug found during E1 development: an
    // unanchored "(^|/)worktrees/" pattern matches the scan ROOT's own
    // ancestor path whenever the scan is run from inside a worktree checkout
    // (this repo's own convention: <repo-root>/.claude/worktrees/<name>),
    // silently excluding 100% of the scan (chunks:0 — a false "0 secrets"
    // clean result). The generated excludes file must anchor the worktrees
    // pattern with `^<scanTarget>/...` so it only ever matches NESTED sibling
    // worktrees, never the scan root itself.
    let capturedContent = "";
    const { runSecurityAuditCheck } = await import("./SecurityAuditor");
    await runSecurityAuditCheck({
      resolveBin: () => "/opt/homebrew/bin/trufflehog",
      runScan: (_bin, args) => {
        // Inspect the excludes file WHILE it still exists — the caller
        // deletes it in a `finally` block right after runScan returns (see
        // the "cleans up" test below), so it must be read from inside the
        // mock itself, not after runSecurityAuditCheck() has resolved.
        const flagIdx = args.indexOf("--exclude-paths");
        expect(flagIdx).toBeGreaterThanOrEqual(0);
        const excludesFilePath = args[flagIdx + 1];
        expect(existsSync(excludesFilePath)).toBe(true);
        capturedContent = readFileSync(excludesFilePath, "utf-8");
        return "";
      },
    });

    expect(capturedContent).toContain("node_modules");
    // Anchored to the resolved scan root (the pinned sandbox in this test) —
    // NOT a bare unanchored "(^|/)worktrees/" pattern.
    expect(capturedContent).toContain(`^${sandbox}/`);
    expect(capturedContent).toContain("worktrees/");
    expect(capturedContent).not.toMatch(/^\(\^\|\/\)worktrees\//m);
  });

  it("passes an exclude-paths file that excludes the secrets.json vault (N3 — vault-policy decision 2026-07-22)", async () => {
    // Regression guard for N3: the secrets.json vault at ~/.claude/secrets.json
    // is the INTENTIONAL secret store (see CLAUDE.md "Secrets and isolation").
    // Flagging its own contents is a false positive by design — 5 of 73
    // verified hits on the 07-19 scan were the vault itself. The generated
    // excludes file must contain a pattern that excludes secrets.json but
    // does NOT catch legitimately-scanned lookalike paths.
    let capturedContent = "";
    const { runSecurityAuditCheck } = await import("./SecurityAuditor");
    await runSecurityAuditCheck({
      resolveBin: () => "/opt/homebrew/bin/trufflehog",
      runScan: (_bin, args) => {
        const flagIdx = args.indexOf("--exclude-paths");
        const excludesFilePath = args[flagIdx + 1];
        capturedContent = readFileSync(excludesFilePath, "utf-8");
        return "";
      },
    });

    expect(capturedContent).toContain("(^|/)secrets\\.json$");

    // Extract the exact pattern line and verify it as a live JS RegExp —
    // matches the real vault's absolute path and a bare filename, but not a
    // lookalike path that should still be legitimately scanned.
    const patternLine = capturedContent
      .split("\n")
      .find((l) => l.trim() === "(^|/)secrets\\.json$");
    expect(patternLine).toBeDefined();
    const re = new RegExp(patternLine as string);

    expect(re.test("~/.claude/secrets.json")).toBe(true);
    expect(re.test("secrets.json")).toBe(true);
    expect(re.test("foo/mysecrets.json")).toBe(false);
    expect(re.test("secrets.json.md")).toBe(false);
  });

  it("cleans up the per-invocation excludes temp file after the scan", async () => {
    let capturedArgs: string[] = [];
    const { runSecurityAuditCheck } = await import("./SecurityAuditor");
    await runSecurityAuditCheck({
      resolveBin: () => "/opt/homebrew/bin/trufflehog",
      runScan: (_bin, args) => {
        capturedArgs = args;
        return "";
      },
    });

    const excludesFilePath = capturedArgs[capturedArgs.indexOf("--exclude-paths") + 1];
    expect(existsSync(excludesFilePath)).toBe(false);
  });

  it("per-finding report captures file/detector/line but NEVER the secret value", async () => {
    const { runSecurityAuditCheck } = await import("./SecurityAuditor");
    await runSecurityAuditCheck({
      resolveBin: () => "/opt/homebrew/bin/trufflehog",
      runScan: () => `${AWS_LINE}\n${GITHUB_LINE}`,
    });

    const raw = readFileSync(reportPath(), "utf-8");
    expect(raw).not.toContain("SHOULD_NEVER_APPEAR_IN_REPORT");

    const lines = readJsonl(reportPath());
    const summary = lines.find((l) => l.type === "summary");
    expect(summary?.totalFindings).toBe(2);
    const findingLines = lines.filter((l) => l.type === "finding");
    expect(findingLines.length).toBe(2);
    expect(findingLines.some((l) => l.detector === "AWS" && l.file === "skills/Foo/secret.ts" && l.line === 12)).toBe(true);
    expect(findingLines.some((l) => l.detector === "Github" && l.file === "skills/Bar/config.ts" && l.line === 3)).toBe(true);
  });
});
