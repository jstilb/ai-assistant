#!/usr/bin/env bun
/**
 * PublicSync — index.ts
 *
 * Entry point for the PublicSync skill.
 * Mirrors the private ~/.claude/ codebase to the public [user]/ai-assistant GitHub repo.
 *
 * Usage:
 *   bun ~/.claude/skills/System/PublicSync/index.ts [command]
 *
 * Commands:
 *   sync        Run a full sync (equivalent to Tools/SyncRunner.ts --auto)
 *   dry-run     Preview what would be synced without pushing
 *   status      Show last sync info
 *   install     Install and activate the daily 2am launchd job
 *
 * @see Tools/SyncEngine.ts  — Core sanitization engine
 * @see Tools/SyncRunner.ts  — Full pipeline runner
 * @see Tools/LaunchdPlist.ts — launchd automation
 * @see State/sync-state.json — Incremental diff state (SHA-256 hash registry)
 * @see State/blocklist.yaml  — Configurable path exclusion rules
 */

export {
  BlocklistFilter,
  SecretScanner,
  ContentTransformer,
  FileHashRegistry,
  SafetyValidator,
  SyncEngine,
  DEFAULT_BLOCKLIST_CONFIG,
  DEFAULT_TRANSFORM_CONFIG,
  type BlocklistConfig,
  type ScanResult,
  type TransformResult,
  type TransformConfig,
  type HashRegistry,
  type ValidationLayerResult,
  type StagedFile,
  type ValidateOptions,
  type SyncEngineConfig,
  type SyncResult,
  type FileGroup,
  type SecretFinding,
} from "./Tools/SyncEngine";

// ─────────────────────────────────────────────────────────────
// CLI entry point — delegate to SyncRunner
// ─────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "help";

  const { execFileSync } = await import("child_process");
  const { join } = await import("path");
  const { homedir } = await import("os");

  const skillDir = join(homedir(), ".claude", "skills", "PublicSync");
  const syncRunner = join(skillDir, "Tools", "SyncRunner.ts");
  const launchdPlist = join(skillDir, "Tools", "LaunchdPlist.ts");

  switch (cmd) {
    case "sync":
      execFileSync("bun", [syncRunner, "--auto"], { stdio: "inherit" });
      break;
    case "dry-run":
      execFileSync("bun", [syncRunner, "--dry-run"], { stdio: "inherit" });
      break;
    case "status":
      execFileSync("bun", [syncRunner, "--status"], { stdio: "inherit" });
      break;
    case "install":
      execFileSync("bun", [launchdPlist, "install"], { stdio: "inherit" });
      break;
    default:
      console.log(`
PublicSync — Continuous Kaya-to-GitHub Sync

USAGE:
  bun index.ts <command>

COMMANDS:
  sync        Run a full sync to [user]/ai-assistant
  dry-run     Preview what would be synced (no push)
  status      Show last sync timestamp and file count
  install     Install the daily 2am launchd automation

EXAMPLES:
  bun index.ts dry-run     # Safe preview
  bun index.ts sync        # Full sync
  bun index.ts status      # Last sync info

DESCRIPTION:
  Three-pass sanitization pipeline:
    Pass 1: Path exclusion (blocklist.yaml)
    Pass 2: Secret pattern detection (sk-ant-, ghp_, etc.)
    Pass 3: Content transforms (path normalization)
  Safety validated by 3 independent layers before any push.
`);
      process.exit(0);
  }
}
