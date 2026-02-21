#!/usr/bin/env bun
/**
 * ChangeDetector - Monitor system for learning opportunities
 *
 * Tracks changes in:
 * - TELOS files (goals, missions, strategies)
 * - Skill definitions
 * - Memory entries
 * - System configuration
 *
 * Detects significant changes that represent learning opportunities
 * and triggers appropriate synthesis workflows.
 *
 * Commands:
 *   --scan            Scan for changes since last baseline
 *   --baseline        Create new baseline snapshot
 *   --watch           Watch for changes (continuous mode)
 *   --scope SCOPE     Limit scope: telos, skills, memory, all (default: all)
 *   --json            Output as JSON
 *
 * Examples:
 *   bun run ChangeDetector.ts --scan
 *   bun run ChangeDetector.ts --baseline
 *   bun run ChangeDetector.ts --scan --scope telos
 */

import { parseArgs } from "util";
import { existsSync, statSync, mkdirSync } from "fs";
import * as path from "path";
import { Glob } from "bun";
import { z } from "zod";
import { createStateManager, type StateManager } from "../../CORE/Tools/StateManager.ts";

// ============================================================================
// Configuration
// ============================================================================

const CLAUDE_DIR = path.join(process.env.HOME!, ".claude");
const STATE_FILE = path.join(CLAUDE_DIR, "skills", "ContinualLearning", "State", "change-baseline.json");
const TELOS_DIR = path.join(CLAUDE_DIR, "skills", "CORE", "USER", "TELOS");
const SKILLS_DIR = path.join(CLAUDE_DIR, "skills");
const MEMORY_DIR = path.join(CLAUDE_DIR, "MEMORY");
const MAX_BASELINE_SIZE_KB = 200;

// ============================================================================
// Types
// ============================================================================

export interface FileSnapshot {
  path: string;
  hash: string;
  size: number;
  modified: string;
}

export interface ChangeBaseline {
  timestamp: string;
  version: number;
  files: Record<string, FileSnapshot>;
}

export interface DetectedChange {
  path: string;
  type: "added" | "modified" | "deleted";
  category: "telos" | "skill" | "memory" | "config";
  significance: "high" | "medium" | "low";
  oldHash?: string;
  newHash?: string;
  sizeDelta?: number;
  reason: string;
}

export interface ChangeReport {
  timestamp: string;
  baselineTimestamp: string;
  changes: DetectedChange[];
  summary: {
    added: number;
    modified: number;
    deleted: number;
    highSignificance: number;
  };
  learningOpportunities: string[];
}

// ============================================================================
// State Management (using CORE StateManager)
// ============================================================================

const FileSnapshotSchema = z.object({
  path: z.string(),
  hash: z.string(),
  size: z.number(),
  modified: z.string(),
});

const ChangeBaselineSchema = z.object({
  timestamp: z.string(),
  version: z.number(),
  files: z.record(z.string(), FileSnapshotSchema),
});

const baselineStateManager: StateManager<ChangeBaseline> = createStateManager({
  path: STATE_FILE,
  schema: ChangeBaselineSchema,
  defaults: {
    timestamp: new Date().toISOString(),
    version: 1,
    files: {},
  },
  backupOnWrite: true, // Keep backup of baseline for recovery
});

// ============================================================================
// File Hashing
// ============================================================================

async function hashFile(filePath: string): Promise<string> {
  try {
    const content = await Bun.file(filePath).arrayBuffer();
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(new Uint8Array(content));
    return hasher.digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

async function getFileSnapshot(filePath: string): Promise<FileSnapshot | null> {
  try {
    const stat = statSync(filePath);
    return {
      path: filePath,
      hash: await hashFile(filePath),
      size: stat.size,
      modified: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Scope Definitions
// ============================================================================

interface ScopeConfig {
  patterns: string[];
  baseDir: string;
  category: DetectedChange["category"];
}

const SCOPES: Record<string, ScopeConfig> = {
  telos: {
    patterns: ["**/*.md"],
    baseDir: TELOS_DIR,
    category: "telos",
  },
  skills: {
    patterns: ["**/SKILL.md", "**/Workflows/*.md", "**/Tools/*.ts"],
    baseDir: SKILLS_DIR,
    category: "skill",
  },
  memory: {
    patterns: ["LEARNING/**/*.md", "LEARNING/**/*.jsonl", "entries/**/*.json"],
    baseDir: MEMORY_DIR,
    category: "memory",
  },
  config: {
    patterns: ["settings.json", "*.json"],
    baseDir: CLAUDE_DIR,
    category: "config",
  },
};

// ============================================================================
// Significance Rules
// ============================================================================

function determineSignificance(change: Partial<DetectedChange>): "high" | "medium" | "low" {
  const filePath = change.path || "";
  const fileName = path.basename(filePath).toLowerCase();

  // High significance
  if (change.category === "telos") {
    if (fileName.includes("goal") || fileName.includes("mission")) return "high";
    if (fileName.includes("strateg") || fileName.includes("challenge")) return "high";
  }
  if (change.category === "skill" && fileName === "skill.md") return "high";
  if (change.type === "deleted") return "high";

  // Medium significance
  if (change.category === "memory" && fileName.includes("synthesis")) return "medium";
  if (change.category === "skill" && filePath.includes("Workflows")) return "medium";
  if (change.sizeDelta && Math.abs(change.sizeDelta) > 1000) return "medium";

  // Low significance
  return "low";
}

function generateChangeReason(change: DetectedChange): string {
  const fileName = path.basename(change.path);

  switch (change.type) {
    case "added":
      if (change.category === "telos") return `New TELOS file: ${fileName}`;
      if (change.category === "skill") return `New skill component: ${fileName}`;
      if (change.category === "memory") return `New memory entry: ${fileName}`;
      return `New file: ${fileName}`;

    case "modified":
      if (change.sizeDelta) {
        const direction = change.sizeDelta > 0 ? "expanded" : "reduced";
        return `${fileName} ${direction} by ${Math.abs(change.sizeDelta)} bytes`;
      }
      return `${fileName} was updated`;

    case "deleted":
      return `${fileName} was removed`;

    default:
      return `Change in ${fileName}`;
  }
}

// ============================================================================
// Baseline Management (using CORE StateManager)
// ============================================================================

/**
 * Check baseline file size and warn if exceeds threshold
 */
export function checkBaselineSize(filePath: string = STATE_FILE): { sizeKB: number; overThreshold: boolean } {
  try {
    const stat = statSync(filePath);
    const sizeKB = Math.round(stat.size / 1024);
    const overThreshold = sizeKB >= MAX_BASELINE_SIZE_KB;
    if (overThreshold) {
      console.warn(
        `WARNING: Baseline file is ${sizeKB}KB (threshold: ${MAX_BASELINE_SIZE_KB}KB). ` +
        `Consider archiving old entries to reduce size.`
      );
    }
    return { sizeKB, overThreshold };
  } catch {
    return { sizeKB: 0, overThreshold: false };
  }
}

/**
 * Load baseline using CORE StateManager
 */
async function loadBaseline(): Promise<ChangeBaseline> {
  checkBaselineSize();
  return baselineStateManager.load();
}

/**
 * Save baseline using CORE StateManager
 */
async function saveBaseline(baseline: ChangeBaseline): Promise<void> {
  await baselineStateManager.save(baseline);
}

async function createBaseline(scopes: string[]): Promise<ChangeBaseline> {
  const baseline: ChangeBaseline = {
    timestamp: new Date().toISOString(),
    version: 1,
    files: {},
  };

  for (const scopeName of scopes) {
    const scope = SCOPES[scopeName];
    if (!scope || !existsSync(scope.baseDir)) continue;

    for (const pattern of scope.patterns) {
      const glob = new Glob(pattern);
      for await (const file of glob.scan({ cwd: scope.baseDir, onlyFiles: true })) {
        if (file.startsWith(".") || file.includes("/.")) continue;

        const filePath = path.join(scope.baseDir, file);
        const snapshot = await getFileSnapshot(filePath);
        if (snapshot) {
          baseline.files[filePath] = snapshot;
        }
      }
    }
  }

  return baseline;
}

// ============================================================================
// Change Detection
// ============================================================================

async function detectChanges(scopes: string[]): Promise<ChangeReport> {
  const baseline = await loadBaseline();
  const now = new Date().toISOString();

  const report: ChangeReport = {
    timestamp: now,
    baselineTimestamp: baseline?.timestamp || "never",
    changes: [],
    summary: { added: 0, modified: 0, deleted: 0, highSignificance: 0 },
    learningOpportunities: [],
  };

  if (!baseline || Object.keys(baseline.files).length === 0) {
    report.learningOpportunities.push("No baseline exists - run --baseline first");
    return report;
  }

  const currentFiles = new Map<string, FileSnapshot>();

  // Scan current state
  for (const scopeName of scopes) {
    const scope = SCOPES[scopeName];
    if (!scope || !existsSync(scope.baseDir)) continue;

    for (const pattern of scope.patterns) {
      const glob = new Glob(pattern);
      for await (const file of glob.scan({ cwd: scope.baseDir, onlyFiles: true })) {
        if (file.startsWith(".") || file.includes("/.")) continue;

        const filePath = path.join(scope.baseDir, file);
        const snapshot = await getFileSnapshot(filePath);
        if (snapshot) {
          currentFiles.set(filePath, snapshot);
        }
      }
    }
  }

  // Find added and modified files
  for (const [filePath, current] of currentFiles) {
    const old = baseline.files[filePath];

    if (!old) {
      // New file
      const category = determineCategory(filePath);
      const change: DetectedChange = {
        path: filePath,
        type: "added",
        category,
        significance: "low",
        newHash: current.hash,
        reason: "",
      };
      change.significance = determineSignificance(change);
      change.reason = generateChangeReason(change);
      report.changes.push(change);
      report.summary.added++;
    } else if (old.hash !== current.hash) {
      // Modified file
      const category = determineCategory(filePath);
      const sizeDelta = current.size - old.size;
      const change: DetectedChange = {
        path: filePath,
        type: "modified",
        category,
        significance: "low",
        oldHash: old.hash,
        newHash: current.hash,
        sizeDelta,
        reason: "",
      };
      change.significance = determineSignificance(change);
      change.reason = generateChangeReason(change);
      report.changes.push(change);
      report.summary.modified++;
    }
  }

  // Find deleted files
  for (const filePath of Object.keys(baseline.files)) {
    if (!currentFiles.has(filePath)) {
      const category = determineCategory(filePath);
      const change: DetectedChange = {
        path: filePath,
        type: "deleted",
        category,
        significance: "low",
        oldHash: baseline.files[filePath].hash,
        reason: "",
      };
      change.significance = determineSignificance(change);
      change.reason = generateChangeReason(change);
      report.changes.push(change);
      report.summary.deleted++;
    }
  }

  // Count high significance
  report.summary.highSignificance = report.changes.filter((c) => c.significance === "high").length;

  // Generate learning opportunities
  report.learningOpportunities = generateLearningOpportunities(report);

  return report;
}

function determineCategory(filePath: string): DetectedChange["category"] {
  if (filePath.includes(TELOS_DIR)) return "telos";
  if (filePath.includes(SKILLS_DIR)) return "skill";
  if (filePath.includes(MEMORY_DIR)) return "memory";
  return "config";
}

function generateLearningOpportunities(report: ChangeReport): string[] {
  const opportunities: string[] = [];

  // TELOS changes
  const telosChanges = report.changes.filter((c) => c.category === "telos");
  if (telosChanges.length > 0) {
    opportunities.push(
      `TELOS updated (${telosChanges.length} files) - Consider running goal alignment synthesis`
    );
  }

  // Skill changes
  const skillChanges = report.changes.filter((c) => c.category === "skill");
  if (skillChanges.some((c) => c.type === "added")) {
    opportunities.push("New skill added - Document capabilities and triggers");
  }

  // Memory changes
  const memoryChanges = report.changes.filter((c) => c.category === "memory");
  if (memoryChanges.length > 10) {
    opportunities.push("Significant memory activity - Consider pattern synthesis");
  }

  // High significance changes
  if (report.summary.highSignificance > 0) {
    opportunities.push(`${report.summary.highSignificance} high-significance changes detected`);
  }

  // Deletions
  if (report.summary.deleted > 0) {
    opportunities.push(`${report.summary.deleted} files deleted - Review for archival`);
  }

  return opportunities;
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      scan: { type: "boolean" },
      baseline: { type: "boolean" },
      watch: { type: "boolean" },
      scope: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`
ChangeDetector - Monitor system for learning opportunities

Usage:
  bun run ChangeDetector.ts --scan            Scan for changes
  bun run ChangeDetector.ts --baseline        Create new baseline
  bun run ChangeDetector.ts --scope SCOPE     Limit scope
  bun run ChangeDetector.ts --json            Output as JSON

Scopes: telos, skills, memory, config, all (default)

Examples:
  bun run ChangeDetector.ts --baseline
  bun run ChangeDetector.ts --scan --scope telos
  bun run ChangeDetector.ts --scan --json
`);
    process.exit(0);
  }

  const scopes =
    values.scope && values.scope !== "all"
      ? [values.scope]
      : Object.keys(SCOPES);

  if (values.baseline) {
    console.log(`📸 Creating baseline snapshot...`);
    const baseline = await createBaseline(scopes);
    await saveBaseline(baseline);

    if (values.json) {
      console.log(JSON.stringify(baseline, null, 2));
    } else {
      console.log(`   Files tracked: ${Object.keys(baseline.files).length}`);
      console.log(`   Scopes: ${scopes.join(", ")}`);
      console.log(`   Saved to: ${STATE_FILE}`);
      console.log(`\n✅ Baseline created`);
    }
    return;
  }

  if (values.scan) {
    const report = await detectChanges(scopes);

    if (values.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`🔍 Change Detection Report`);
      console.log(`   Baseline: ${report.baselineTimestamp}`);
      console.log(`   Scanned: ${report.timestamp}`);
      console.log(`   Scopes: ${scopes.join(", ")}`);
      console.log(``);

      if (report.changes.length === 0) {
        console.log(`✅ No changes detected since baseline`);
      } else {
        console.log(`📊 Summary:`);
        console.log(`   Added: ${report.summary.added}`);
        console.log(`   Modified: ${report.summary.modified}`);
        console.log(`   Deleted: ${report.summary.deleted}`);
        console.log(`   High significance: ${report.summary.highSignificance}`);
        console.log(``);

        // Show high significance changes
        const highChanges = report.changes.filter((c) => c.significance === "high");
        if (highChanges.length > 0) {
          console.log(`⚠️  High Significance Changes:`);
          for (const c of highChanges) {
            const icon = c.type === "added" ? "+" : c.type === "deleted" ? "-" : "~";
            console.log(`   ${icon} ${c.reason}`);
          }
          console.log(``);
        }

        // Show medium changes
        const mediumChanges = report.changes.filter((c) => c.significance === "medium");
        if (mediumChanges.length > 0) {
          console.log(`📝 Medium Significance Changes:`);
          for (const c of mediumChanges.slice(0, 5)) {
            console.log(`   ~ ${c.reason}`);
          }
          if (mediumChanges.length > 5) {
            console.log(`   ... and ${mediumChanges.length - 5} more`);
          }
          console.log(``);
        }

        // Show learning opportunities
        if (report.learningOpportunities.length > 0) {
          console.log(`💡 Learning Opportunities:`);
          for (const opp of report.learningOpportunities) {
            console.log(`   → ${opp}`);
          }
        }
      }
    }
    return;
  }

  if (values.watch) {
    console.log(`👁️  Watch mode not yet implemented`);
    console.log(`   Use scheduled scans via AutoMaintenance instead.`);
    return;
  }

  // Default: show status
  const baseline = await loadBaseline();
  console.log(`🔄 ChangeDetector`);
  console.log(`   Baseline: ${baseline.timestamp || "not created"}`);
  console.log(`   Files tracked: ${Object.keys(baseline.files).length}`);
  console.log(`\nUse --help for usage information.`);
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}

// Exports for library use
export { loadBaseline, createBaseline, detectChanges };
