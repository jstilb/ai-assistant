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
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  copyFileSync,
  rmSync,
} from "fs";
import { join, relative, dirname, basename } from "path";
import { execSync, execFileSync } from "child_process";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";
import { createStateManager } from "../../../../lib/core/StateManager";
import { z } from "zod";

import {
  BlocklistFilter,
  SecretScanner,
  ContentTransformer,
  FileHashRegistry,
  SafetyValidator,
  SyncEngine,
  DEFAULT_BLOCKLIST_CONFIG,
  DEFAULT_TRANSFORM_CONFIG,
  type BlocklistConfig,
  type StagedFile,
} from "./SyncEngine";

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

const SOURCE_DIR = join(homedir(), ".claude");
const STAGING_DIR = "/tmp/pai-public-staging";
const SKILL_DIR = join(SOURCE_DIR, "skills", "System", "PublicSync");

// Load GitHub token for HTTPS auth (SSH unavailable in launchd)
function getRemoteUrl(): string {
  const secretsPath = join(homedir(), ".claude", "secrets.json");
  try {
    const secrets = JSON.parse(readFileSync(secretsPath, "utf-8"));
    const token = secrets.GITHUB_TOKEN;
    if (token) {
      return `https://${token}@github.com/[user]/ai-assistant.git`;
    }
  } catch {}
  // Fallback to SSH if no token (will fail in launchd but works interactively)
  return "git@github.com:[user]/ai-assistant.git";
}
const REMOTE_URL = getRemoteUrl();
const BLOCKLIST_CONFIG_PATH = join(SKILL_DIR, "State", "blocklist.yaml");
const SYNC_STATE_PATH = join(SKILL_DIR, "State", "sync-state.json");
const PLUGINS_BLOCKLIST_PATH = join(SOURCE_DIR, "plugins", "blocklist.json");

// ─────────────────────────────────────────────────────────────
// Zod schema for partial blocklist config (from blocklist.yaml)
// ─────────────────────────────────────────────────────────────

const PartialBlocklistConfigSchema = z.object({
  excludedDirs: z.array(z.string()).optional(),
  excludedFiles: z.array(z.string()).optional(),
  excludedSkills: z.array(z.string()).optional(),
  preserveReadmes: z.boolean().optional(),
  excludedStateDirs: z.boolean().optional(),
  additionalExcludedPaths: z.array(z.string()).optional(),
}).partial();

// ─────────────────────────────────────────────────────────────
// Load blocklist config
// ─────────────────────────────────────────────────────────────

function loadBlocklistConfig(): BlocklistConfig {
  let config = { ...DEFAULT_BLOCKLIST_CONFIG };

  if (existsSync(BLOCKLIST_CONFIG_PATH)) {
    try {
      const raw = readFileSync(BLOCKLIST_CONFIG_PATH, "utf8");
      const rawParsed: unknown = parseYaml(raw);
      const parsed = PartialBlocklistConfigSchema.parse(rawParsed);

      if (parsed.excludedDirs) config.excludedDirs = parsed.excludedDirs;
      if (parsed.excludedFiles) config.excludedFiles = parsed.excludedFiles;
      if (parsed.excludedSkills) config.excludedSkills = parsed.excludedSkills;
      if (parsed.preserveReadmes !== undefined)
        config.preserveReadmes = parsed.preserveReadmes;
      if (parsed.excludedStateDirs !== undefined)
        config.excludedStateDirs = parsed.excludedStateDirs;
      if (parsed.additionalExcludedPaths)
        config.additionalExcludedPaths = parsed.additionalExcludedPaths;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(
        `[SyncRunner] Warning: could not parse blocklist.yaml: ${message}`
      );
    }
  }

  // Note: plugins/blocklist.json tracks installed plugins (not path exclusions).
  // We only check its existence for audit trail; no parsing needed.
  if (existsSync(PLUGINS_BLOCKLIST_PATH)) {
    // Plugin blocklist file detected — contents managed by plugin system
  }

  return config;
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
// Walk source directory
// ─────────────────────────────────────────────────────────────

function walkDir(
  dir: string,
  baseDir: string,
  filter: BlocklistFilter
): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relativePath = relative(baseDir, fullPath);

    if (!filter.isAllowed(relativePath)) continue;

    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, baseDir, filter));
    } else if (entry.isFile()) {
      results.push(relativePath);
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────
// Staging area management
// ─────────────────────────────────────────────────────────────

function ensureStagingRepo(): void {
  if (!existsSync(STAGING_DIR)) {
    console.log(`[SyncRunner] Cloning ${REMOTE_URL.replace(/\/\/[^@]+@/, "//***@")} → ${STAGING_DIR}`);
    execFileSync("git", ["clone", REMOTE_URL, STAGING_DIR], {
      stdio: "inherit",
    });
  } else {
    console.log(`[SyncRunner] Pulling latest from remote...`);
    execFileSync("git", ["-C", STAGING_DIR, "pull", "--rebase", "--autostash"], {
      stdio: "inherit",
    });
  }
}

function getGitDiff(stagingDir: string): string {
  try {
    return execSync(`git -C "${stagingDir}" diff HEAD`, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

function getStagedPaths(stagingDir: string): string[] {
  try {
    const output = execSync(
      `git -C "${stagingDir}" status --porcelain`,
      { encoding: "utf8" }
    );
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim());
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// Main sync pipeline
// ─────────────────────────────────────────────────────────────

interface RunOptions {
  dryRun: boolean;
  verbose: boolean;
}

async function runSync(opts: RunOptions): Promise<void> {
  const { dryRun, verbose } = opts;

  console.log(
    `\n[PublicSync] Starting ${dryRun ? "DRY RUN" : "LIVE SYNC"}...`
  );
  console.log(`  Source:  ${SOURCE_DIR}`);
  console.log(`  Staging: ${STAGING_DIR}`);
  console.log(`  Remote:  ${REMOTE_URL.replace(/\/\/[^@]+@/, "//***@")}\n`);

  // ── Load config and state ──────────────────────────────
  const blocklistConfig = loadBlocklistConfig();
  const syncState = await loadSyncState();
  const hashRegistry = FileHashRegistry.fromJSON(syncState.hashes);

  const filter = new BlocklistFilter(blocklistConfig);
  const scanner = new SecretScanner();
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
    ensureStagingRepo();
  }

  // ── Walk source files ─────────────────────────────────
  console.log("[PublicSync] Scanning source files...");
  const allFiles = walkDir(SOURCE_DIR, SOURCE_DIR, filter);
  console.log(`  Found ${allFiles.length} allowed files.`);

  // ── Three-pass sanitization ───────────────────────────
  const changedFiles: Array<{ relativePath: string; content: string; absolutePath: string }> = [];
  let skippedUnchanged = 0;

  for (const relativePath of allFiles) {
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
      const error = new Error(
        `SecretScanError: file "${relativePath}" contains secret pattern "${finding.pattern}" at line ${finding.line}. Sync aborted.`
      );
      error.name = "SecretScanError";
      throw error;
    }

    // Incremental diff — skip if unchanged
    const currentHash = FileHashRegistry.computeHash(finalContent);
    if (!hashRegistry.hasChanged(relativePath, currentHash)) {
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

  if (changedFiles.length === 0) {
    console.log("\n[PublicSync] No changes to sync. Repo is up to date.");
    return;
  }

  if (dryRun) {
    console.log("\n[DRY RUN] Files that would be synced:");
    for (const f of changedFiles) console.log(`  + ${f.relativePath}`);
    const groups = engine.groupBySkill(changedFiles.map((f) => f.relativePath));
    console.log("\n[DRY RUN] Commit messages that would be generated:");
    for (const group of groups) {
      console.log(
        `  ${engine.generateCommitMessage(group.files.map(() => group.skill + "/" + group.files[0]))}`
      );
    }
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

  // ── Safety validation ────────────────────────────────
  console.log("[PublicSync] Running safety validator (3 layers)...");

  // Stage all changes in git
  execSync(`git -C "${STAGING_DIR}" add -A`, { stdio: "inherit" });

  const diff = getGitDiff(STAGING_DIR);
  const stagedRelativePaths = getStagedPaths(STAGING_DIR);

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
    process.exit(1);
  }

  console.log("  All 3 safety layers passed.");

  // ── Semantic commits by skill group ─────────────────
  console.log("\n[PublicSync] Committing by skill group...");
  const groups = engine.groupBySkill(changedFiles.map((f) => f.relativePath));

  const commitMessages: string[] = [];

  for (const group of groups) {
    const commitMsg = engine.generateCommitMessage(group.files);
    commitMessages.push(commitMsg);

    // Stage only this group's files
    for (const file of group.files) {
      execSync(`git -C "${STAGING_DIR}" add "${file}"`, { stdio: "pipe" });
    }

    execSync(
      `git -C "${STAGING_DIR}" commit -m "${commitMsg.replace(/"/g, '\\"')}"`,
      { stdio: "inherit" }
    );
    console.log(`  Committed: ${commitMsg}`);
  }

  // ── Push to remote ───────────────────────────────────
  console.log("\n[PublicSync] Pushing to remote...");
  execSync(`git -C "${STAGING_DIR}" push origin main`, { stdio: "inherit" });

  // ── Update sync state ────────────────────────────────
  const lastCommit = execSync(`git -C "${STAGING_DIR}" rev-parse HEAD`, {
    encoding: "utf8",
  }).trim();

  const newHashes = { ...syncState.hashes };
  for (const { relativePath, content } of changedFiles) {
    newHashes[relativePath] = FileHashRegistry.computeHash(content);
  }

  await saveSyncState({
    lastSync: new Date().toISOString(),
    lastSyncCommit: lastCommit,
    hashes: newHashes,
    version: "1.0.0",
  });

  console.log(`\n[PublicSync] Sync complete.`);
  console.log(`  ${changedFiles.length} files synced`);
  console.log(`  ${commitMessages.length} commits pushed`);
  console.log(`  Last commit: ${lastCommit.slice(0, 12)}`);
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const isAuto = args.includes("--auto");
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
  --status     Show last sync info
  --verbose    Show detailed output including blocked files
  --help, -h   Show this help

EXAMPLES:
  bun SyncRunner.ts --dry-run          # Preview changes
  bun SyncRunner.ts --auto             # Full sync (CI/launchd)
  bun SyncRunner.ts --status           # Last sync info
`);
    process.exit(0);
  }

  if (isStatus) {
    loadSyncState().then((state) => {
      console.log("\n[PublicSync] Sync Status:");
      console.log(`  Last sync:    ${state.lastSync ?? "never"}`);
      console.log(`  Last commit:  ${state.lastSyncCommit ?? "none"}`);
      console.log(`  Files tracked: ${Object.keys(state.hashes).length}`);
      process.exit(0);
    }).catch(() => process.exit(1));
  } else if (isDryRun || isAuto) {
    runSync({ dryRun: isDryRun, verbose: isVerbose }).catch((e) => {
      const name = e instanceof Error ? e.name : undefined;
      const message = e instanceof Error ? e.message : String(e);
      if (name === "SecretScanError") {
        console.error("[PublicSync] ABORTED:", message);
      } else {
        console.error("[PublicSync] Fatal error:", message);
      }
      process.exit(1);
    });
  } else {
    console.log("Use --dry-run, --auto, or --status. See --help for usage.");
    process.exit(1);
  }
}
