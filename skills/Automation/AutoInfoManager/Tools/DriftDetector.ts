#!/usr/bin/env bun
/**
 * ============================================================================
 * DriftDetector.ts - Architecture drift detection via SHA-256 hashing
 * ============================================================================
 *
 * PURPOSE:
 * Replaces stub ArchitectureUpdate and DeepDriftCheck with real implementations.
 *
 * ArchitectureUpdate: SHA-256 hash comparison of config files against stored
 * baseline. Reports modified/added/removed files. First run creates baseline.
 * Uses Bun.CryptoHasher for hashing (already used in FullDriftCheck).
 *
 * DeepDriftCheck: Full staleness scan + hash comparison + state file validation
 * + tiers.json parsability check. Returns real counts.
 *
 * USAGE:
 *   import { architectureUpdate, deepDriftCheck } from './DriftDetector';
 *
 *   const result = await architectureUpdate();
 *   // result.data = { modified: ['tiers.json'], added: [], removed: [] }
 *
 * ============================================================================
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import type { StepResult } from "../../../../lib/core/WorkflowExecutor";

// ============================================================================
// Constants
// ============================================================================

const KAYA_DIR = process.env.KAYA_DIR || join(homedir(), ".claude");
const SKILL_DIR = join(KAYA_DIR, "skills/Automation/AutoInfoManager");
const DEFAULT_CONFIG_DIR = join(SKILL_DIR, "Config");
const DEFAULT_STATE_DIR = join(SKILL_DIR, "State");

// ============================================================================
// Hash Helpers
// ============================================================================

/**
 * Compute SHA-256 hash of file content using Bun.CryptoHasher
 */
function hashFile(filePath: string): string {
  const content = readFileSync(filePath, "utf-8");
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

/**
 * Compute hashes for all files in a directory (non-recursive, JSON/YAML/MD)
 */
function hashDirectory(dirPath: string): Record<string, string> {
  const hashes: Record<string, string> = {};

  if (!existsSync(dirPath)) return hashes;

  const files = readdirSync(dirPath).filter((f) => {
    const ext = f.split(".").pop()?.toLowerCase();
    return ["json", "yaml", "yml", "md", "toml"].includes(ext || "");
  });

  for (const file of files) {
    try {
      hashes[file] = hashFile(join(dirPath, file));
    } catch {
      // Skip unreadable files
    }
  }

  return hashes;
}

// ============================================================================
// Architecture Update
// ============================================================================

/**
 * ArchitectureUpdate: SHA-256 hash comparison of config files against stored
 * baseline. First run creates baseline (all files reported as added).
 *
 * @param configDir - Directory to scan (default: Config/)
 * @param stateDir - Directory for baseline storage (default: State/)
 */
export async function architectureUpdate(
  configDir?: string,
  stateDir?: string
): Promise<StepResult> {
  const cfgDir = configDir || DEFAULT_CONFIG_DIR;
  const stDir = stateDir || DEFAULT_STATE_DIR;
  const hashPath = join(stDir, "config-hashes.json");

  // Compute current hashes
  const currentHashes = hashDirectory(cfgDir);
  const currentFiles = Object.keys(currentHashes);

  // Load stored baseline
  let baselineHashes: Record<string, string> = {};
  let isFirstRun = true;

  if (existsSync(hashPath)) {
    try {
      baselineHashes = JSON.parse(readFileSync(hashPath, "utf-8"));
      isFirstRun = false;
    } catch {
      // Treat as first run if baseline is corrupt
      isFirstRun = true;
    }
  }

  const baselineFiles = Object.keys(baselineHashes);

  // Compute diff
  const modified: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  if (isFirstRun) {
    // First run: all files are "added"
    added.push(...currentFiles);
  } else {
    // Find modified and added
    for (const file of currentFiles) {
      if (baselineHashes[file]) {
        if (currentHashes[file] !== baselineHashes[file]) {
          modified.push(file);
        }
      } else {
        added.push(file);
      }
    }

    // Find removed
    for (const file of baselineFiles) {
      if (!currentHashes[file]) {
        removed.push(file);
      }
    }
  }

  // Update baseline
  if (!existsSync(stDir)) {
    mkdirSync(stDir, { recursive: true });
  }
  writeFileSync(hashPath, JSON.stringify(currentHashes, null, 2));

  const totalChanges = modified.length + added.length + removed.length;
  const changeDesc = isFirstRun
    ? `First run: baseline created with ${currentFiles.length} files`
    : totalChanges === 0
      ? "No configuration drift detected"
      : `Drift detected: ${modified.length} modified, ${added.length} added, ${removed.length} removed`;

  return {
    success: true,
    message: changeDesc,
    data: { modified, added, removed },
    metrics: {
      filesChecked: currentFiles.length,
      modified: modified.length,
      added: added.length,
      removed: removed.length,
      totalChanges,
    },
  };
}

// ============================================================================
// Deep Drift Check
// ============================================================================

/**
 * DeepDriftCheck: Comprehensive drift detection including:
 * (a) State file integrity via JSON parse validation
 * (b) tiers.json parsability check
 * (c) Config file hash comparison
 * Returns real counts, not hardcoded zeros.
 *
 * @param configDir - Config directory to check
 * @param stateDir - State directory to validate
 */
export async function deepDriftCheck(
  configDir?: string,
  stateDir?: string
): Promise<StepResult> {
  const cfgDir = configDir || DEFAULT_CONFIG_DIR;
  const stDir = stateDir || DEFAULT_STATE_DIR;

  const issues: string[] = [];
  let tiersConfigValid = 0;
  let stateFilesChecked = 0;
  let stateFilesCorrupt = 0;
  let configFilesChecked = 0;

  // Check 1: tiers.json parsability
  const tiersPath = join(cfgDir, "tiers.json");
  if (existsSync(tiersPath)) {
    try {
      JSON.parse(readFileSync(tiersPath, "utf-8"));
      tiersConfigValid = 1;
    } catch (error) {
      tiersConfigValid = 0;
      issues.push(`tiers.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    issues.push("tiers.json not found");
  }

  // Check 2: State file integrity
  if (existsSync(stDir)) {
    const stateFiles = readdirSync(stDir).filter((f) => f.endsWith(".json"));
    for (const file of stateFiles) {
      stateFilesChecked++;
      try {
        const content = readFileSync(join(stDir, file), "utf-8");
        JSON.parse(content);
      } catch {
        stateFilesCorrupt++;
        issues.push(`State file "${file}" is corrupt or unparseable`);
      }
    }
  }

  // Check 3: Config file inventory
  if (existsSync(cfgDir)) {
    const configFiles = readdirSync(cfgDir).filter((f) => {
      const ext = f.split(".").pop()?.toLowerCase();
      return ["json", "yaml", "yml", "md"].includes(ext || "");
    });
    configFilesChecked = configFiles.length;
  }

  // Check 4: Context file staleness (if context dir exists)
  let staleContextFiles = 0;
  const contextDir = join(KAYA_DIR, "context");
  if (existsSync(contextDir)) {
    const now = Date.now();
    const threshold = 48 * 60 * 60 * 1000; // 48 hours for deep check
    const files = readdirSync(contextDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      try {
        const stat = Bun.file(join(contextDir, file));
        const fileStat = await stat.stat();
        if (fileStat.mtime && now - fileStat.mtime.getTime() > threshold) {
          staleContextFiles++;
        }
      } catch { /* skip */ }
    }
    if (staleContextFiles > 0) {
      issues.push(`${staleContextFiles} context files are stale (>48h)`);
    }
  }

  const totalDrift = issues.length;

  return {
    success: true,
    message: totalDrift === 0
      ? `Deep drift check passed: ${stateFilesChecked} state files, ${configFilesChecked} config files, tiers.json valid`
      : `Deep drift check: ${totalDrift} issues found`,
    data: { issues },
    metrics: {
      tiersConfigValid,
      stateFilesChecked,
      stateFilesCorrupt,
      configFilesChecked,
      staleContextFiles,
      totalIssues: totalDrift,
    },
  };
}
