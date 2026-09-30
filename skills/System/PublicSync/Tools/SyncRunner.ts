#!/usr/bin/env bun
/**
 * SyncRunner.ts - Full sync pipeline runner
 *
 * Orchestrates the complete PublicSync workflow:
 *   1. Clone/pull staging repo
 *   2. Walk source files, apply three-pass sanitization
 *   3. Copy sanitized files to staging
 *   4. Run safety validator (3 layers)
 *   5. Group by skill, generate commits
 *   6. Push to public GitHub
 *   7. Update sync-state.json with new hashes
 *
 * Usage:
 *   bun SyncRunner.ts --dry-run        Preview what would change
 *   bun SyncRunner.ts --auto           Run full sync (used by launchd)
 *   bun SyncRunner.ts --status         Show last sync info
 *   bun SyncRunner.ts --help
 *
 * @author Kaya System
 * @version 1.0.0
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "fs";
import { join, dirname } from "path";
import { execSync, execFileSync } from "child_process";
import { createStateManager } from "../../../../lib/core/StateManager";
import { defaultKayaHome } from "../../../../lib/core/KayaHome";
import { redactSecrets } from "../../../../lib/core/Redactor";
import { z } from "zod";

import {
  BlocklistFilter,
  SecretScanner,
  ContentTransformer,
  FileHashRegistry,
  SafetyValidator,
  SyncEngine,
  DEFAULT_TRANSFORM_CONFIG,
  loadBlocklistConfigFrom,
  walkAllowedFiles,
  pruneRegistry,
  logSyncOutcome,
  type BlocklistConfig,
  type StagedFile,
  type SyncOutcome,
} from "./SyncEngine";

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

const SOURCE_DIR = defaultKayaHome();
const STAGING_DIR = "/tmp/pai-public-staging";
const SKILL_DIR = join(SOURCE_DIR, "skills", "System", "PublicSync");

// Load GitHub token for HTTPS auth (SSH unavailable in launchd)
function loadGithubToken(): string | undefined {
  const secretsPath = join(defaultKayaHome(), "secrets.json");
  try {
    const secretsRaw = readFileSync(secretsPath, "utf-8");
    const secrets = JSON.parse(secretsRaw);
    const token = secrets.GITHUB_TOKEN;
    return typeof token === "string" && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}
function getRemoteUrl(token: string | undefined): string {
  // Test seam: point the whole pipeline at a local bare repo so the fresh /
  // prune / push flow can be exercised end-to-end without touching GitHub.
  // Never set in the launchd plist or SyncRunner.sh.
  const override = process.env.PUBLICSYNC_REMOTE_URL_OVERRIDE;
  if (override && override.length > 0) return override;
  if (token) {
    return `https://${token}@github.com/[user]/ai-assistant.git`;
  }
  // Fallback to SSH if no token (will fail in launchd but works interactively)
  return "git@github.com:[user]/ai-assistant.git";
}
const GITHUB_TOKEN = loadGithubToken();
// Passed to redactSecrets() at every git-output call site below so a failed
// clone/pull/push's stderr (e.g. `fatal: unable to access 'https://<token>@…'`)
// never reaches a log with the raw token in it — see lib/core/Redactor.ts.
const KNOWN_SECRETS: readonly string[] = GITHUB_TOKEN ? [GITHUB_TOKEN] : [];
const REMOTE_URL = getRemoteUrl(GITHUB_TOKEN);
const BLOCKLIST_CONFIG_PATH = join(SKILL_DIR, "State", "blocklist.yaml");
const SYNC_STATE_PATH = join(SKILL_DIR, "State", "sync-state.json");

// ─────────────────────────────────────────────────────────────
// Load blocklist config — FAIL-CLOSED (throws on missing/invalid yaml).
// Shared loader lives in SyncEngine.ts so FreshExport sees identical rules.
// ─────────────────────────────────────────────────────────────

function loadBlocklistConfig(): BlocklistConfig {
  return loadBlocklistConfigFrom(BLOCKLIST_CONFIG_PATH);
}

// ─────────────────────────────────────────────────────────────
// Load sync state — using StateManager for type-safe persistence
// ─────────────────────────────────────────────────────────────

const SyncStateSchema = z.object({
  lastSync: z.string().nullable(),
  lastSyncCommit: z.string().nullable(),
  hashes: z.record(z.string(), z.string()),
  version: z.string(),
});

type SyncState = z.infer<typeof SyncStateSchema>;

const syncStateManager = createStateManager<SyncState>({
  path: SYNC_STATE_PATH,
  schema: SyncStateSchema,
  defaults: { lastSync: null, lastSyncCommit: null, hashes: {}, version: "1.0.0" },
});

async function loadSyncState(): Promise<SyncState> {
  return syncStateManager.load();
}

async function saveSyncState(state: SyncState): Promise<void> {
  await syncStateManager.save(state);
}

// ─────────────────────────────────────────────────────────────
// Staging area management
// ─────────────────────────────────────────────────────────────

// Narrow an execFileSync throw (typed as `unknown`) down to its stderr/stdout
// text without `any` — Node/Bun attach these as string|Buffer properties on
// the thrown Error when `encoding` is set, but that shape isn't part of the
// declared Error type, so we read it defensively instead of asserting it.
//
// Deliberately NEVER reads `.message`: Node's execFileSync error message is
// `Command failed: git clone https://<token>@…` — the full argv, verbatim,
// including the token. Falling back to it (even through redactSecrets) would
// make the leak's prevention depend on every pattern/known-secret matching;
// reading only `.stderr`/`.stdout` (the subprocess's actual output, never the
// invoked command line) keeps that leak path structurally unreachable.
function extractOutput(err: unknown, field: "stderr" | "stdout"): string {
  if (err && typeof err === "object") {
    const value = (err as Record<string, unknown>)[field];
    if (typeof value === "string") return value;
    if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  }
  return "";
}

// Runs a git subcommand with captured (not inherited) stdio so any output —
// including a failed clone/pull/push's `fatal: unable to access
// 'https://<token>@…'` — passes through redactSecrets() before it can reach
// a log. Previously these three call sites used stdio:"inherit", which piped
// raw, unredacted git stderr straight to this process's own stderr. The
// thrown Error is built only from `label` + the redacted stderr — never from
// the caught error's own `.message` (see extractOutput above).
export function runGit(args: string[], label: string, knownSecrets: readonly string[] = KNOWN_SECRETS): string {
  let stdout: string;
  try {
    stdout = execFileSync("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (err) {
    const rawStderr = extractOutput(err, "stderr") || extractOutput(err, "stdout") || "(no output captured)";
    const redacted = redactSecrets(rawStderr, knownSecrets);
    process.stderr.write(redacted.endsWith("\n") ? redacted : `${redacted}\n`);
    throw new Error(`[SyncRunner] git ${label} failed: ${redacted}`);
  }
  if (stdout) process.stdout.write(redactSecrets(stdout, knownSecrets));
  return stdout;
}

/** True when the remote has a `main` branch (false for a freshly created, empty repo). */
function remoteHasMain(): boolean {
  const out = runGit(["ls-remote", "--heads", REMOTE_URL, "main"], "ls-remote");
  return out.trim().length > 0;
}

/** True when the staging clone has at least one commit on HEAD. */
function stagingHasCommits(): boolean {
  try {
    execFileSync("git", ["-C", STAGING_DIR, "rev-parse", "--verify", "-q", "HEAD"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Prepare /tmp/pai-public-staging.
 *
 * `fresh` (recreate flow): the old staging clone is discarded before cloning,
 * so history from a DELETED remote can never be rebased onto — and pushed
 * into — the recreated repo. If the remote is empty (no `main` yet) the
 * unborn branch is pinned to `main` so the first push creates `main`
 * regardless of the local init.defaultBranch.
 *
 * Otherwise (nightly flow): pull as before — but FAIL CLOSED if the remote no
 * longer has `main` while the staging clone still has history. That state
 * means the repo was recreated underneath us; the only safe move is --fresh.
 */
function ensureStagingRepo(fresh: boolean): void {
  const redactedRemote = REMOTE_URL.replace(/\/\/[^@]+@/, "//***@");
  if (fresh && existsSync(STAGING_DIR)) {
    console.log(`[SyncRunner] --fresh: discarding old staging clone ${STAGING_DIR}`);
    rmSync(STAGING_DIR, { recursive: true, force: true });
  }

  if (!existsSync(STAGING_DIR)) {
    console.log(`[SyncRunner] Cloning ${redactedRemote} → ${STAGING_DIR}`);
    runGit(["clone", REMOTE_URL, STAGING_DIR], "clone");
    if (!stagingHasCommits()) {
      // Empty remote: make sure the unborn branch is called `main`.
      runGit(["-C", STAGING_DIR, "symbolic-ref", "HEAD", "refs/heads/main"], "symbolic-ref");
      console.log("[SyncRunner] Remote is empty — first push will create `main` as a fresh baseline.");
    }
    return;
  }

  if (!remoteHasMain()) {
    throw new Error(
      "[SyncRunner] Remote has no `main` branch but the staging clone has history — the public repo was " +
        "recreated. Refusing to push stale history. Re-run with --fresh (discards staging + hash registry)."
    );
  }
  console.log(`[SyncRunner] Pulling latest from remote...`);
  runGit(["-C", STAGING_DIR, "pull", "--rebase", "--autostash"], "pull");
}

/**
 * Diff of everything staged in the index. `--cached` (not `diff HEAD`) so it
 * also works on an unborn HEAD — the first push into a recreated repo is
 * exactly when layer-1 validation matters most.
 */
// Throws on failure: an empty string here would silently skip the Layer 1
// secret scan (fail-open), and a --fresh diff carries every published file.
function getGitDiff(stagingDir: string): string {
  return execSync(`git -C "${stagingDir}" diff --cached`, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * Tracked paths in the staging clone that the CURRENT blocklist no longer
 * allows (or that no longer exist in the source). These are the "orphans" —
 * the sync historically never deleted anything, so files blocklisted after
 * they had already been published stayed on the mirror forever
 * (theme4 §4 follow-on; MEMORY/, KAYASECURITYSYSTEM/, Sheet-ID files).
 */
function listPruneCandidates(allowedFiles: ReadonlySet<string>): string[] {
  if (!existsSync(join(STAGING_DIR, ".git"))) return [];
  let tracked: string;
  try {
    tracked = execFileSync("git", ["-C", STAGING_DIR, "ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  return tracked
    .split("\0")
    .filter(Boolean)
    .filter((p) => !allowedFiles.has(p))
    .sort();
}

function freshBaselineMessage(fileCount: number): string {
  return `chore(publicsync): fresh public mirror baseline (${fileCount} files, fail-closed allowlist)`;
}

function pruneCommitMessage(pathCount: number): string {
  return `chore(publicsync): prune ${pathCount} path(s) no longer allowed by blocklist`;
}

// ─────────────────────────────────────────────────────────────
// Main sync pipeline
// ─────────────────────────────────────────────────────────────

interface RunOptions {
  dryRun: boolean;
  verbose: boolean;
  /**
   * Recreate flow: discard the staging clone and the SHA-256 hash registry,
   * treat every allowed file as changed, and land the whole export as ONE
   * baseline commit. Used once, right after the public repo is deleted and
   * recreated empty (Workflows/Recreate.md).
   */
  fresh: boolean;
}

async function runSync(opts: RunOptions): Promise<void> {
  const { dryRun, verbose, fresh } = opts;
  const startTime = Date.now();

  // Audit tracking
  const blockedDetails: SyncOutcome["blockedDetails"] = [];
  let filesScanned = 0;
  let filesBlocked = 0;
  let registryEntriesPruned = 0;

  console.log(
    `\n[PublicSync] Starting ${dryRun ? "DRY RUN" : "LIVE SYNC"}${fresh ? " (FRESH BASELINE)" : ""}...`
  );
  console.log(`  Source:  ${SOURCE_DIR}`);
  console.log(`  Staging: ${STAGING_DIR}`);
  console.log(`  Remote:  ${REMOTE_URL.replace(/\/\/[^@]+@/, "//***@")}\n`);

  // ── Load config and state ──────────────────────────────
  const blocklistConfig = loadBlocklistConfig();
  if (!blocklistConfig.allowedTopLevel?.length) {
    throw new Error(
      "[PublicSync] blocklist.yaml has no allowedTopLevel list — the mirror must be fail-closed. Refusing to sync."
    );
  }
  const syncState: SyncState = fresh
    ? { lastSync: null, lastSyncCommit: null, hashes: {}, version: "1.0.0" }
    : await loadSyncState();

  const filter = new BlocklistFilter(blocklistConfig);
  const scanner = new SecretScanner(blocklistConfig.blockedIdentifiers ?? []);
  const transformer = new ContentTransformer(DEFAULT_TRANSFORM_CONFIG);
  const validator = new SafetyValidator(blocklistConfig);
  const engine = new SyncEngine(
    {
      sourceDir: SOURCE_DIR,
      stagingDir: STAGING_DIR,
      remoteUrl: REMOTE_URL,
      blocklistConfigPath: BLOCKLIST_CONFIG_PATH,
      syncStatePath: SYNC_STATE_PATH,
      dryRun,
    },
    blocklistConfig
  );

  // ── Ensure staging repo exists ────────────────────────
  if (!dryRun) {
    ensureStagingRepo(fresh);
  }

  // ── Walk source files ─────────────────────────────────
  console.log("[PublicSync] Scanning source files...");
  const allFiles = walkAllowedFiles(SOURCE_DIR, filter);
  console.log(`  Found ${allFiles.length} allowed files.`);

  // ── Prune stale registry entries ─────────────────────
  const currentFileSet = new Set(allFiles);

  // ── Orphans: published paths the blocklist no longer allows ──
  // Dry-run reports them when a staging clone exists; live sync deletes them.
  const pruneCandidates = listPruneCandidates(currentFileSet);
  if (pruneCandidates.length > 0) {
    console.log(`  Orphan paths on mirror to prune: ${pruneCandidates.length}`);
    if (verbose || dryRun) {
      for (const p of pruneCandidates) console.log(`  - ${p}`);
    }
  } else if (dryRun && !existsSync(join(STAGING_DIR, ".git"))) {
    console.log("  (no staging clone present — orphan list unavailable in dry-run)");
  }
  const { pruned: prunedHashes, removedCount } = pruneRegistry(
    syncState.hashes,
    currentFileSet
  );
  registryEntriesPruned = removedCount;
  // Use pruned hashes for this run's incremental diff
  const prunedRegistry = FileHashRegistry.fromJSON(prunedHashes);
  if (removedCount > 0 && verbose) {
    console.log(`  Registry pruned: ${removedCount} stale entries removed`);
  }

  // ── Three-pass sanitization ───────────────────────────
  const changedFiles: Array<{ relativePath: string; content: string; absolutePath: string }> = [];
  let skippedUnchanged = 0;

  for (const relativePath of allFiles) {
    filesScanned++;
    const absolutePath = join(SOURCE_DIR, relativePath);

    let rawContent: string;
    try {
      rawContent = readFileSync(absolutePath, "utf8");
    } catch {
      continue; // Binary or unreadable file — skip
    }

    // Pass 2: Content transform (runs BEFORE secret scan so paths like
    // /Users/[user]/ are stripped before the scanner sees them)
    const transformResult = transformer.transform(rawContent);
    const finalContent = transformResult.content;

    // Pass 3: Secret scan on TRANSFORMED content — ABORT on detection
    const scanResult = scanner.scan(finalContent);
    if (scanResult.hasSecrets) {
      const finding = scanResult.findings[0];
      console.error(
        `  [BLOCKED] ${relativePath}: secret pattern "${finding.pattern}" at line ${finding.line}`
      );
      filesBlocked++;
      blockedDetails.push({
        path: relativePath,
        reason: "SECRET_PATTERN",
        patternName: finding.pattern,
      });
      const error = new Error(
        `SecretScanError: file "${relativePath}" contains secret pattern "${finding.pattern}" at line ${finding.line}. Sync aborted.`
      );
      error.name = "SecretScanError";
      // Log the outcome before throwing
      logSyncOutcome({
        ts: Date.now(),
        action: dryRun ? "dry-run" : "sync",
        success: false,
        filesScanned,
        filesSynced: 0,
        filesSkipped: skippedUnchanged,
        filesBlocked,
        blockedDetails,
        registryEntriesPruned,
        pushResult: "failed",
        pushError: error.message,
        durationMs: Date.now() - startTime,
      });
      throw error;
    }

    // Incremental diff — skip if unchanged
    const currentHash = FileHashRegistry.computeHash(finalContent);
    if (!prunedRegistry.hasChanged(relativePath, currentHash)) {
      skippedUnchanged++;
      continue;
    }

    changedFiles.push({
      relativePath,
      content: finalContent,
      absolutePath,
    });
  }

  console.log(`\n[PublicSync] Sanitization complete:`);
  console.log(`  Changed files:      ${changedFiles.length}`);
  console.log(`  Unchanged (skipped): ${skippedUnchanged}`);

  if (changedFiles.length === 0 && pruneCandidates.length === 0) {
    console.log("\n[PublicSync] No changes to sync. Repo is up to date.");
    logSyncOutcome({
      ts: Date.now(),
      action: dryRun ? "dry-run" : "sync",
      success: true,
      filesScanned,
      filesSynced: 0,
      filesSkipped: skippedUnchanged,
      filesBlocked,
      blockedDetails,
      registryEntriesPruned,
      pushResult: "skipped",
      durationMs: Date.now() - startTime,
    });
    return;
  }

  if (dryRun) {
    console.log("\n[DRY RUN] Files that would be synced:");
    for (const f of changedFiles) console.log(`  + ${f.relativePath}`);
    if (pruneCandidates.length > 0) {
      console.log(`\n[DRY RUN] ${pruneCandidates.length} orphan path(s) would be deleted from the mirror (listed above).`);
    }
    console.log("\n[DRY RUN] Commit messages that would be generated:");
    if (fresh) {
      console.log(`  ${freshBaselineMessage(changedFiles.length)}`);
    } else {
      if (pruneCandidates.length > 0) console.log(`  ${pruneCommitMessage(pruneCandidates.length)}`);
      const groups = engine.groupBySkill(changedFiles.map((f) => f.relativePath));
      for (const group of groups) {
        console.log(
          `  ${engine.generateCommitMessage(group.files.map(() => group.skill + "/" + group.files[0]))}`
        );
      }
    }
    logSyncOutcome({
      ts: Date.now(),
      action: "dry-run",
      success: true,
      filesScanned,
      filesSynced: changedFiles.length,
      filesSkipped: skippedUnchanged,
      filesBlocked,
      blockedDetails,
      registryEntriesPruned,
      pushResult: "dry-run",
      durationMs: Date.now() - startTime,
    });
    return;
  }

  // ── Copy files to staging ─────────────────────────────
  console.log("\n[PublicSync] Copying files to staging area...");
  const stagedFiles: StagedFile[] = [];

  for (const { relativePath, content, absolutePath } of changedFiles) {
    const destPath = join(STAGING_DIR, relativePath);
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, content, "utf8");
    stagedFiles.push({ relativePath, absolutePath: destPath });
  }

  // ── Prune orphans from the staging working tree ──────
  // Deleting the file is enough; `git add -A` below stages the removal.
  if (pruneCandidates.length > 0) {
    console.log(`[PublicSync] Pruning ${pruneCandidates.length} orphan path(s) from staging...`);
    for (const p of pruneCandidates) {
      rmSync(join(STAGING_DIR, p), { force: true });
    }
  }

  // ── Safety validation ────────────────────────────────
  console.log("[PublicSync] Running safety validator (3 layers)...");

  // Stage all changes in git (use -Af to override target repo's .gitignore)
  execSync(`git -C "${STAGING_DIR}" add -Af`, { stdio: "inherit" });

  const diff = getGitDiff(STAGING_DIR);

  const validationResult = await validator.validate({
    diff,
    stagedPaths: stagedFiles,
  });

  if (!validationResult.passed) {
    console.error(
      `\n[PublicSync] SAFETY CHECK FAILED (layer: ${validationResult.layer})`
    );
    console.error(`  Reason: ${validationResult.reason}`);
    if (validationResult.blockedPaths) {
      console.error("  Blocked paths:");
      for (const p of validationResult.blockedPaths)
        console.error(`    - ${p}`);
    }

    // Reset staging
    execSync(`git -C "${STAGING_DIR}" reset HEAD`, { stdio: "pipe" });

    logSyncOutcome({
      ts: Date.now(),
      action: "sync",
      success: false,
      filesScanned,
      filesSynced: 0,
      filesSkipped: skippedUnchanged,
      filesBlocked: filesBlocked + (validationResult.blockedPaths?.length ?? 0),
      blockedDetails,
      registryEntriesPruned,
      pushResult: "failed",
      pushError: validationResult.reason,
      durationMs: Date.now() - startTime,
    });

    process.exit(1);
  }

  console.log("  All 3 safety layers passed.");

  const commitMessages: string[] = [];

  if (fresh) {
    // ── Single baseline commit (everything is already staged) ──
    const commitMsg = freshBaselineMessage(changedFiles.length);
    execFileSync("git", ["-C", STAGING_DIR, "commit", "-q", "-m", commitMsg], { stdio: "inherit" });
    commitMessages.push(commitMsg);
    console.log(`  Committed: ${commitMsg}`);
  } else {
    // Unstage everything so per-group commits can stage selectively
    execSync(`git -C "${STAGING_DIR}" reset -q HEAD`, { stdio: "pipe" });

    // ── Prune commit first: deletions of no-longer-allowed paths ──
    if (pruneCandidates.length > 0) {
      const CHUNK = 500; // stay well under ARG_MAX
      for (let i = 0; i < pruneCandidates.length; i += CHUNK) {
        execFileSync(
          "git",
          ["-C", STAGING_DIR, "add", "-A", "--", ...pruneCandidates.slice(i, i + CHUNK)],
          { stdio: "pipe" }
        );
      }
      const commitMsg = pruneCommitMessage(pruneCandidates.length);
      execFileSync("git", ["-C", STAGING_DIR, "commit", "-q", "-m", commitMsg], { stdio: "inherit" });
      commitMessages.push(commitMsg);
      console.log(`  Committed: ${commitMsg}`);
    }
  }

  // ── Semantic commits by skill group ─────────────────
  const groups = fresh ? [] : engine.groupBySkill(changedFiles.map((f) => f.relativePath));
  if (groups.length > 0) console.log("\n[PublicSync] Committing by skill group...");

  for (const group of groups) {
    // Stage only this group's files (use -f to override target repo's .gitignore)
    for (const file of group.files) {
      try {
        execSync(`git -C "${STAGING_DIR}" add -f "${file}"`, { stdio: "pipe" });
      } catch {
        // File may not exist in staging (e.g., filtered by target .gitignore)
      }
    }

    // Check if anything was actually staged (files may be identical to HEAD)
    try {
      execSync(`git -C "${STAGING_DIR}" diff --cached --quiet`, { stdio: "pipe" });
      // Exit code 0 means no staged changes — skip this group
      continue;
    } catch {
      // Exit code 1 means there ARE staged changes — proceed to commit
    }

    const commitMsg = engine.generateCommitMessage(group.files);
    commitMessages.push(commitMsg);

    execSync(
      `git -C "${STAGING_DIR}" commit -m "${commitMsg.replace(/"/g, '\\"')}"`,
      { stdio: "inherit" }
    );
    console.log(`  Committed: ${commitMsg}`);
  }

  // ── Push to remote ───────────────────────────────────
  console.log("\n[PublicSync] Pushing to remote...");
  let pushResult: SyncOutcome["pushResult"] = "skipped";
  let pushError: string | undefined;

  try {
    // `-u` so the first push into a recreated (empty) repo creates and tracks
    // `main`; a no-op on every later run. Never `--force` — see Safety Rules.
    runGit(["-C", STAGING_DIR, "push", "-u", "origin", "main"], "push");
    pushResult = "success";
  } catch (err) {
    pushResult = "failed";
    pushError = err instanceof Error ? err.message : String(err);
    logSyncOutcome({
      ts: Date.now(),
      action: "sync",
      success: false,
      filesScanned,
      filesSynced: changedFiles.length,
      filesSkipped: skippedUnchanged,
      filesBlocked,
      blockedDetails,
      registryEntriesPruned,
      pushResult,
      pushError,
      durationMs: Date.now() - startTime,
    });
    throw err;
  }

  // ── Update sync state ────────────────────────────────
  const lastCommit = execSync(`git -C "${STAGING_DIR}" rev-parse HEAD`, {
    encoding: "utf8",
  }).trim();

  // Use pruned hashes as the new base, then add updated hashes
  const newHashes = { ...prunedHashes };
  for (const { relativePath, content } of changedFiles) {
    newHashes[relativePath] = FileHashRegistry.computeHash(content);
  }

  await saveSyncState({
    lastSync: new Date().toISOString(),
    lastSyncCommit: lastCommit,
    hashes: newHashes,
    version: "1.0.0",
  });

  logSyncOutcome({
    ts: Date.now(),
    action: "sync",
    success: true,
    filesScanned,
    filesSynced: changedFiles.length,
    filesSkipped: skippedUnchanged,
    filesBlocked,
    blockedDetails,
    registryEntriesPruned,
    pushResult,
    durationMs: Date.now() - startTime,
  });

  console.log(`\n[PublicSync] Sync complete.`);
  console.log(`  ${changedFiles.length} files synced`);
  console.log(`  ${commitMessages.length} commits pushed`);
  console.log(`  Last commit: ${lastCommit.slice(0, 12)}`);
  if (registryEntriesPruned > 0) {
    console.log(`  Registry pruned: ${registryEntriesPruned} stale entries removed`);
  }
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const isAuto = args.includes("--auto");
  const isFresh = args.includes("--fresh");
  const isStatus = args.includes("--status");
  const isVerbose = args.includes("--verbose") || args.includes("-v");
  const isHelp = args.includes("--help") || args.includes("-h");

  if (isHelp) {
    console.log(`
PublicSync SyncRunner

USAGE:
  bun SyncRunner.ts [options]

OPTIONS:
  --dry-run    Preview what would change without pushing
  --auto       Run full sync (used by launchd daily job)
  --fresh      Recreate flow (with --auto or --dry-run): discard the staging
               clone + hash registry and land the whole export as ONE baseline
               commit. Use once, right after the public repo is recreated
               EMPTY. See Workflows/Recreate.md.
  --status     Show last sync info
  --verbose    Show detailed output including blocked files
  --help, -h   Show this help

EXAMPLES:
  bun SyncRunner.ts --dry-run          # Preview changes
  bun SyncRunner.ts --auto             # Full sync (CI/launchd)
  bun SyncRunner.ts --auto --fresh     # First push into a recreated repo
  bun SyncRunner.ts --status           # Last sync info
`);
    process.exit(0);
  }

  if (isStatus) {
    loadSyncState().then((state) => {
      const trackedCount = Object.keys(state.hashes).length;
      console.log("\n[PublicSync] Sync Status:");
      console.log(`  Last sync:    ${state.lastSync ?? "never"}`);
      console.log(`  Last commit:  ${state.lastSyncCommit ?? "none"}`);
      console.log(`  Files tracked: ${trackedCount}`);
      logSyncOutcome({
        ts: Date.now(),
        action: "status",
        success: true,
        filesScanned: trackedCount,
        filesSynced: 0,
        filesSkipped: 0,
        filesBlocked: 0,
        blockedDetails: [],
        registryEntriesPruned: 0,
        durationMs: 0,
      });
      process.exit(0);
    }).catch(() => process.exit(1));
  } else if (isDryRun || isAuto) {
    runSync({ dryRun: isDryRun, verbose: isVerbose, fresh: isFresh }).catch((e) => {
      const name = e instanceof Error ? e.name : undefined;
      const message = e instanceof Error ? e.message : String(e);
      if (name === "SecretScanError") {
        console.error("[PublicSync] ABORTED:", redactSecrets(message, KNOWN_SECRETS));
      } else {
        console.error("[PublicSync] Fatal error:", redactSecrets(message, KNOWN_SECRETS));
      }
      process.exit(1);
    });
  } else {
    console.log("Use --dry-run, --auto, or --status. See --help for usage.");
    process.exit(1);
  }
}
