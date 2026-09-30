#!/usr/bin/env bun
/**
 * Backup.ts - Timestamped, verified zip backup of a Scrivener 3 .scriv project.
 *
 * MANDATORY precursor to ANY modification of a .scriv package (see SafetyRules.md).
 * Refuses to back up a project that appears open in Scrivener (lock file present)
 * unless --force is given — a mid-session copy can capture an inconsistent state.
 *
 * Backups default to ~/Documents/ScrivenerBackups/ — deliberately OUTSIDE ~/.claude,
 * whose git repo auto-commits its whole tree (manuscripts must not land in git).
 *
 * Usage:
 *   bun ~/.claude/skills/Content/Scrivener/Tools/Backup.ts <project.scriv> [options]
 *
 * Options:
 *   --out-dir <dir>   Backup destination (default: ~/Documents/ScrivenerBackups)
 *   --force           Back up even if a lock file is present (warns)
 *   --help            Show usage
 *
 * Exit codes: 0 = backup written and verified; 1 = error or verification failure.
 *
 * @author Kaya System
 * @version 1.0.0
 */

import { existsSync, mkdirSync, readdirSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";

function fail(msg: string): never {
  console.error(`\x1b[31mERROR:\x1b[0m ${msg}`);
  process.exit(1);
}

function countFilesOnDisk(dir: string): number {
  const proc = Bun.spawnSync(["find", dir, "-type", "f"]);
  if (proc.exitCode !== 0) fail(`find failed on ${dir}`);
  return proc.stdout.toString().split("\n").filter((l) => l.length > 0).length;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(`Usage: bun Backup.ts <project.scriv> [--out-dir <dir>] [--force]

Timestamped, verified zip backup of a Scrivener project.
Default destination: ~/Documents/ScrivenerBackups/`);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out-dir");
  const projectPath = positional[0];
  if (projectPath === undefined) fail("Missing <project.scriv> path");
  if (!existsSync(projectPath)) fail(`Path does not exist: ${projectPath}`);
  if (!projectPath.endsWith(".scriv")) fail(`Not a .scriv package: ${projectPath}`);

  const outIdx = args.indexOf("--out-dir");
  const outDir = outIdx >= 0 ? (args[outIdx + 1] ?? "") : join(homedir(), "Documents", "ScrivenerBackups");
  if (outDir.length === 0) fail("--out-dir requires a value");
  const force = args.includes("--force");

  const lockFiles = readdirSync(projectPath).filter((f) => /\.lock$/i.test(f));
  if (lockFiles.length > 0) {
    if (!force) {
      fail(
        `Lock file present (${lockFiles.join(", ")}) — project may be open in Scrivener. ` +
          `Close it first, or pass --force to back up anyway (risks an inconsistent copy).`
      );
    }
    console.error(`\x1b[33mWARN:\x1b[0m lock file present (${lockFiles.join(", ")}) — backing up anyway (--force).`);
  }

  mkdirSync(outDir, { recursive: true });
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const zipPath = join(outDir, `${basename(projectPath, ".scriv")}-backup-${stamp}.zip`);
  if (existsSync(zipPath)) fail(`Backup already exists: ${zipPath}`);

  const zipProc = Bun.spawnSync(["zip", "-r", "-q", zipPath, basename(projectPath)], {
    cwd: dirname(projectPath),
  });
  if (zipProc.exitCode !== 0) {
    fail(`zip failed (exit ${zipProc.exitCode}): ${zipProc.stderr.toString().slice(0, 500)}`);
  }

  // Verify 1: archive integrity
  const testProc = Bun.spawnSync(["unzip", "-t", "-q", zipPath]);
  if (testProc.exitCode !== 0) {
    fail(`Backup FAILED verification (unzip -t exit ${testProc.exitCode}): ${zipPath}`);
  }

  // Verify 2: file count parity (zip entries that are files vs files on disk)
  const listProc = Bun.spawnSync(["unzip", "-Z1", zipPath]);
  if (listProc.exitCode !== 0) fail(`unzip -Z1 failed on ${zipPath}`);
  const zipFileCount = listProc.stdout
    .toString()
    .split("\n")
    .filter((l) => l.length > 0 && !l.endsWith("/")).length;
  const diskFileCount = countFilesOnDisk(projectPath);
  if (zipFileCount !== diskFileCount) {
    fail(
      `Backup FAILED verification: zip has ${zipFileCount} files, project has ${diskFileCount}. ` +
        `(Project modified during backup?) Zip left at ${zipPath} for inspection.`
    );
  }

  console.log(`\x1b[32mOK:\x1b[0m backup written and verified (${zipFileCount} files)`);
  console.log(zipPath);
}

main();
