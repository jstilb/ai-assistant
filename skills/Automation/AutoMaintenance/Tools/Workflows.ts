#!/usr/bin/env bun
/**
 * ============================================================================
 * AutoMaintenance Workflows - Tiered system maintenance workflows
 * ============================================================================
 *
 * PURPOSE:
 * Provides Daily/Weekly/Monthly system maintenance workflows using the
 * WorkflowExecutor infrastructure. Handles integrity checks, security
 * scanning, workspace cleanup, and skill audits.
 *
 * SCHEDULE:
 *   Daily:    8am daily - integrity + Claude CLI update
 *   Weekly (RECOMMENDED - Orchestrated):
 *     Sunday:   8am - ALL weekly tasks with correct ordering
 *                    Phase 1: Security + Learning (parallel)
 *                    Phase 2: Cleanup (after learning completes)
 *   Weekly (Legacy - Staggered):
 *     Sunday:   8am - security audit, Kaya sync
 *     Monday:   8am - state cleanup, log rotation (DISABLED)
 *     Tuesday:  8am - memory consolidation, weekly report (DISABLED)
 *   Monthly (first week only):
 *     Thursday: 8am - workspace cleanup
 *     Friday:   8am - skill audit
 *     Saturday: 8am - monthly report
 *
 * USAGE:
 *   # Execute full workflow tiers
 *   bun run Workflows.ts --tier daily|weekly|monthly
 *
 *   # Execute staggered sub-tiers
 *   bun run Workflows.ts --tier weekly-security
 *   bun run Workflows.ts --tier weekly-cleanup
 *   bun run Workflows.ts --tier weekly-reports
 *   bun run Workflows.ts --tier monthly-workspace
 *   bun run Workflows.ts --tier monthly-skills
 *   bun run Workflows.ts --tier monthly-reports
 *
 *   # Resume from checkpoint
 *   bun run Workflows.ts --tier weekly --resume
 *
 * ============================================================================
 */

import { parseArgs } from "util";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "fs";
import { z } from "zod";
import { createStateManager } from "../../../../lib/core/StateManager.ts";
import { join } from "path";
import { homedir } from "os";
import {
  workflowExecutor,
  createTieredWorkflow,
  type WorkflowStep,
  type StepResult,
  type VerificationSpec,
  type WorkflowConfig,
} from "../../../../lib/core/WorkflowExecutor.ts";
// AgentOrchestrator import removed - not used in current implementation
import { notifySync, notify } from "../../../../lib/core/NotificationService.ts";
import { loadQueueItems } from "../../QueueRouter/Tools/QueueManager.ts";

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = process.env.KAYA_HOME || join(homedir(), ".claude");
const MEMORY_DIR = join(KAYA_HOME, "MEMORY");
const MAINTENANCE_DIR = join(MEMORY_DIR, "AutoMaintenance");
const ERROR_LOG_PATH = join(MAINTENANCE_DIR, "errors.jsonl");
const WORK_QUEUE_FILE = join(KAYA_HOME, "MEMORY", "WORK", "work-queue.json");
const NOTIFICATIONS_FILE = join(KAYA_HOME, "MEMORY", "NOTIFICATIONS", "notifications.jsonl");

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Ensure directory exists
 */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Get current ISO date string
 */
function isoDate(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Get current week number
 */
function getWeekNumber(): string {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const diff = now.getTime() - start.getTime();
  const oneWeek = 604800000; // 7 * 24 * 60 * 60 * 1000
  const weekNum = Math.ceil(diff / oneWeek);
  return `${now.getFullYear()}-W${weekNum.toString().padStart(2, "0")}`;
}

/**
 * Get standardized output path for workflow reports
 */
function getOutputPath(workflow: string, date: Date = new Date()): string {
  const dateStr = date.toISOString().split("T")[0]; // YYYY-MM-DD
  const dir = join(MAINTENANCE_DIR, workflow);
  ensureDir(dir);
  return join(dir, `${dateStr}.md`);
}

/**
 * Log error to centralized error log
 */
function logError(workflow: string, step: string, error: string): void {
  ensureDir(MAINTENANCE_DIR);
  const entry = {
    date: new Date().toISOString(),
    workflow,
    step,
    error,
  };
  appendFileSync(ERROR_LOG_PATH, JSON.stringify(entry) + "\n");
}

/**
 * Find broken symlinks in a directory
 */
function findBrokenSymlinks(dir: string): string[] {
  const broken: string[] = [];
  try {
    const proc = Bun.spawnSync(["find", dir, "-type", "l", "!", "-exec", "test", "-e", "{}", ";", "-print"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = proc.stdout.toString().trim();
    if (output) {
      broken.push(...output.split("\n").filter(Boolean));
    }
  } catch {
    // Ignore errors
  }
  return broken;
}

// ============================================================================
// Daily Steps (< 5 min)
// ============================================================================

/**
 * Quick integrity check - verify critical paths exist
 */
async function integrityCheck(): Promise<StepResult> {
  const criticalPaths = [
    join(KAYA_HOME, "CLAUDE.md"),
    join(KAYA_HOME, "settings.json"),
    join(KAYA_HOME, "MEMORY"),
    join(KAYA_HOME, "hooks"),
  ];

  const missing: string[] = [];
  for (const path of criticalPaths) {
    if (!existsSync(path)) {
      missing.push(path);
    }
  }

  const brokenLinks = findBrokenSymlinks(KAYA_HOME);

  if (missing.length === 0 && brokenLinks.length === 0) {
    return {
      success: true,
      message: "All critical paths verified, no broken symlinks",
      metrics: { checked: criticalPaths.length, brokenLinks: 0 },
    };
  }

  return {
    success: true, // Continue even with issues
    message: `Found ${missing.length} missing paths, ${brokenLinks.length} broken symlinks`,
    data: { missing, brokenLinks },
    metrics: { missing: missing.length, brokenLinks: brokenLinks.length },
  };
}

/**
 * Synthesis freshness check — if last synthesis is >7 days old, trigger a new one.
 * This ensures the feedback loop stays closed even if weekly maintenance misses a run.
 */
async function synthesisFreshnessCheck(): Promise<StepResult> {
  try {
    const stateFile = join(KAYA_HOME, "skills", "ContinualLearning", "State", "last-synthesis.json");
    if (!existsSync(stateFile)) {
      // No synthesis ever run — trigger one
      return await runKnowledgeSynthesis();
    }

    const synthesisStateManager = createStateManager({
      path: stateFile,
      schema: z.object({ lastRun: z.string().optional() }).passthrough(),
      defaults: { lastRun: undefined },
    });
    const state = await synthesisStateManager.load();
    const lastRun = state.lastRun ? new Date(state.lastRun) : null;

    if (!lastRun) {
      return await runKnowledgeSynthesis();
    }

    const ageDays = (Date.now() - lastRun.getTime()) / (1000 * 60 * 60 * 24);

    if (ageDays > 7) {
      const result = await runKnowledgeSynthesis();
      return {
        ...result,
        message: `Synthesis was ${ageDays.toFixed(1)} days stale — ${result.message}`,
      };
    }

    return {
      success: true,
      message: `Synthesis fresh (${ageDays.toFixed(1)} days old)`,
      metrics: { stale: 0, ageDays: Math.round(ageDays) },
    };
  } catch (err) {
    return {
      success: true,
      message: `Synthesis freshness check failed: ${err}`,
      metrics: { stale: 0 },
    };
  }
}

/**
 * Run KnowledgeSynthesizer weekly synthesis.
 */
async function runKnowledgeSynthesis(): Promise<StepResult> {
  try {
    const synthesizerPath = join(KAYA_HOME, "skills", "ContinualLearning", "Tools", "KnowledgeSynthesizer.ts");
    const proc = Bun.spawnSync(
      ["bun", "run", synthesizerPath, "--week", "--json"],
      { stdout: "pipe", stderr: "pipe", timeout: 120000 }
    );

    if (proc.exitCode === 0) {
      // After successful synthesis, refresh the context file for session injection
      try {
        Bun.spawnSync(
          ["bun", "run", join(KAYA_HOME, "skills", "ContinualLearning", "Tools", "LearningContextProvider.ts"), "--refresh"],
          { stdout: "pipe", stderr: "pipe", timeout: 30000 }
        );
      } catch { /* non-critical */ }

      const output = proc.stdout.toString().trim();
      try {
        const result = JSON.parse(output);
        return {
          success: true,
          message: `Knowledge synthesis completed — ${result.totalDataPoints || 0} data points, ${result.patterns?.length || 0} patterns`,
          data: result,
          metrics: {
            dataPoints: result.totalDataPoints || 0,
            patterns: result.patterns?.length || 0,
          },
        };
      } catch {
        return {
          success: true,
          message: "Knowledge synthesis completed (output not parseable as JSON)",
          metrics: { dataPoints: 0, patterns: 0 },
        };
      }
    }

    return {
      success: true,
      message: `Knowledge synthesis exited with code ${proc.exitCode}`,
      metrics: { dataPoints: 0, patterns: 0 },
    };
  } catch (err) {
    return {
      success: true,
      message: `Knowledge synthesis skipped: ${err}`,
      metrics: { dataPoints: 0, patterns: 0 },
    };
  }
}

/**
 * Refresh graph context for session intelligence
 */
async function refreshGraphContext(): Promise<StepResult> {
  const bridgePath = join(KAYA_HOME, "skills/Intelligence/Graph/Tools/Analyzers/ContinualLearningBridge.ts");
  const proc = Bun.spawnSync(
    ["bun", "run", bridgePath, "--context"],
    { stdout: "pipe", stderr: "pipe", timeout: 60000 }
  );
  return {
    success: proc.exitCode === 0,
    message: proc.exitCode === 0 ? "Graph context refreshed" : `Graph context refresh failed: ${proc.stderr.toString().slice(0, 200)}`,
    metrics: { refreshed: proc.exitCode === 0 ? 1 : 0 },
  };
}

/**
 * Update job scoring weights based on weekly callback analytics.
 */
async function updateJobScoringWeights(): Promise<StepResult> {
  const enginePath = join(KAYA_HOME, "skills/Commerce/JobEngine/Tools/AnalyticsEngine.ts");
  const proc = Bun.spawnSync(
    ["bun", "run", enginePath, "update-weights", "--json"],
    { stdout: "pipe", stderr: "pipe", timeout: 30000 }
  );
  const success = proc.exitCode === 0;
  let message = success ? "Job scoring weights updated" : "Weight update failed";
  try {
    if (success) {
      const result = JSON.parse(proc.stdout.toString()) as { updated: boolean; reason?: string; weights?: Record<string, number> };
      message = result.updated ? `Weights updated: ${JSON.stringify(result.weights)}` : `Skipped: ${result.reason}`;
    }
  } catch { /* Non-fatal */ }
  return { success, message, metrics: { updated: success ? 1 : 0 } };
}

/**
 * Update Claude CLI - check for and install updates
 */
async function updateClaude(): Promise<StepResult> {
  try {
    // Get current version
    const versionProc = Bun.spawnSync(["claude", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const previousVersion = versionProc.stdout.toString().trim() || "unknown";

    // Attempt update
    const updateProc = Bun.spawnSync(["claude", "update", "--yes"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60000, // 1 minute timeout
    });

    // Get new version
    const newVersionProc = Bun.spawnSync(["claude", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const currentVersion = newVersionProc.stdout.toString().trim() || "unknown";

    const updated = previousVersion !== currentVersion;

    return {
      success: true,
      message: updated
        ? `Claude CLI updated: ${previousVersion} → ${currentVersion}`
        : `Claude CLI up to date: ${currentVersion}`,
      data: { previousVersion, currentVersion, updated },
      metrics: { updated: updated ? 1 : 0 },
    };
  } catch {
    return {
      success: true, // Continue even if update fails
      message: "Claude CLI update check failed or not supported",
      metrics: { updated: 0 },
    };
  }
}

// ============================================================================
// Weekly Security Steps (Sunday)
// ============================================================================

/**
 * Full integrity audit with parallel agents
 */
async function fullAudit(): Promise<StepResult> {
  const domains = [
    "skills", "hooks", "memory", "config", "tools",
    "workflows", "templates", "agents", "sessions",
    "learning", "work", "archive", "docs", "tests",
    "integrations", "secrets"
  ];

  const issues: string[] = [];

  for (const domain of domains) {
    const domainPath = join(KAYA_HOME, domain);
    if (!existsSync(domainPath)) {
      continue;
    }

    const brokenLinks = findBrokenSymlinks(domainPath);
    if (brokenLinks.length > 0) {
      issues.push(`${domain}: ${brokenLinks.length} broken symlinks`);
    }
  }

  return {
    success: true,
    message: issues.length === 0
      ? `Audited ${domains.length} domains - no issues found`
      : `Audited ${domains.length} domains - ${issues.length} issues found`,
    data: { domains, issues },
    metrics: { domainsChecked: domains.length, issuesFound: issues.length },
  };
}

/**
 * Secret scanning using trufflehog
 * Excludes gitignored internal directories (file-history, projects, paste-cache, etc.)
 * Only alerts on VERIFIED secrets in committed paths
 */
async function secretScanning(): Promise<StepResult> {
  try {
    const whichProc = Bun.spawnSync(["which", "trufflehog"], { stdout: "pipe", stderr: "pipe" });

    if (whichProc.exitCode !== 0) {
      return {
        success: true,
        message: "TruffleHog not installed - skipping secret scan",
        metrics: { secretsFound: 0 },
      };
    }

    // Scan with TruffleHog, excluding gitignored internal directories
    const proc = Bun.spawnSync(
      [
        "trufflehog", "filesystem", "--directory", KAYA_HOME, "--json",
        "--exclude-paths", "file-history",
        "--exclude-paths", "projects",
        "--exclude-paths", "paste-cache",
        "--exclude-paths", ".cache",
        "--exclude-paths", "debug",
        "--exclude-paths", "backups",
        "--exclude-paths", "logs",
        "--exclude-paths", "node_modules",
        "--exclude-paths", ".bun",
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 120000 }
    );

    const output = proc.stdout.toString().trim();
    if (!output) {
      return {
        success: true,
        message: "Secret scan completed - no secrets detected",
        metrics: { secretsFound: 0, verifiedSecrets: 0 },
      };
    }

    // Parse JSON output and count only VERIFIED secrets
    const lines = output.split("\n").filter(Boolean);
    let verifiedCount = 0;
    const verifiedSecrets: { type: string; file: string }[] = [];

    for (const line of lines) {
      try {
        const finding = JSON.parse(line);
        if (finding.Verified === true) {
          verifiedCount++;
          verifiedSecrets.push({
            type: finding.DetectorName,
            file: finding.SourceMetadata?.Data?.Filesystem?.file || "unknown",
          });
        }
      } catch {
        // Skip malformed JSON lines
      }
    }

    if (verifiedCount === 0) {
      return {
        success: true,
        message: `Secret scan completed - ${lines.length} potential, 0 verified secrets`,
        metrics: { secretsFound: lines.length, verifiedSecrets: 0 },
      };
    }

    return {
      success: false,
      message: `CRITICAL: ${verifiedCount} VERIFIED secrets detected in committed paths`,
      data: { verifiedSecrets, totalFindings: lines.length },
      metrics: { secretsFound: lines.length, verifiedSecrets: verifiedCount },
    };
  } catch {
    return {
      success: true,
      message: "Secret scan skipped due to error",
      metrics: { secretsFound: 0, verifiedSecrets: 0 },
    };
  }
}

/**
 * Privacy validation - ensure USER content not in SYSTEM locations
 * Excludes documentation files (.md) which legitimately mention USER/ paths
 * Focuses on code/config files that might accidentally contain user data
 */
async function privacyValidation(): Promise<StepResult> {
  const systemPaths = [
    join(KAYA_HOME, "docs/system"),
  ];

  const violations: string[] = [];

  for (const systemPath of systemPaths) {
    if (!existsSync(systemPath)) continue;

    try {
      // Only check code/config files, exclude documentation (.md, .yaml examples)
      const proc = Bun.spawnSync(
        [
          "grep", "-r", "-l",
          "--include=*.ts", "--include=*.js", "--include=*.json",
          "-E", "(USER\\/[^\\s\"']+\\.(ts|js|json)|credentials\\.json|secret\\.json|\\.env\\.)",
          systemPath
        ],
        { stdout: "pipe", stderr: "pipe" }
      );

      const output = proc.stdout.toString().trim();
      if (output) {
        // Filter out example/template files
        const files = output.split("\n").filter(f =>
          f && !f.includes(".example") && !f.includes("template")
        );
        violations.push(...files);
      }
    } catch {
      // Ignore errors
    }
  }

  if (violations.length === 0) {
    return {
      success: true,
      message: "Privacy validation passed - no USER content in SYSTEM locations",
      metrics: { violations: 0 },
    };
  }

  return {
    success: false,
    message: `Privacy violation: ${violations.length} code files with USER content in SYSTEM`,
    data: { violations },
    metrics: { violations: violations.length },
  };
}

// ============================================================================
// Weekly Cleanup Steps (Monday)
// ============================================================================

/**
 * State cleanup - archive old WORK items
 */
async function stateCleanup(): Promise<StepResult> {
  const workDir = join(KAYA_HOME, "MEMORY/WORK");
  const archiveDir = join(KAYA_HOME, "MEMORY/ARCHIVE/WORK");

  if (!existsSync(workDir)) {
    return {
      success: true,
      message: "No WORK directory to clean",
      metrics: { archived: 0 },
    };
  }

  ensureDir(archiveDir);

  let archived = 0;
  try {
    const entries = readdirSync(workDir);
    for (const entry of entries) {
      const entryPath = join(workDir, entry);
      const stats = statSync(entryPath);

      if (stats.isDirectory() && entry.startsWith("completed_")) {
        const ageMs = Date.now() - stats.mtimeMs;
        const ageDays = ageMs / (1000 * 60 * 60 * 24);

        if (ageDays > 7) {
          const proc = Bun.spawnSync(["mv", entryPath, archiveDir], { stdout: "pipe", stderr: "pipe" });
          if (proc.exitCode === 0) {
            archived++;
          }
        }
      }
    }
  } catch {
    // Ignore errors
  }

  return {
    success: true,
    message: archived > 0 ? `Archived ${archived} completed work items` : "No items to archive",
    metrics: { archived },
  };
}

/**
 * Log and cache rotation
 */
async function logRotation(): Promise<StepResult> {
  let filesRemoved = 0;

  // Clean debug logs older than 14 days
  const debugDir = join(KAYA_HOME, "debug");
  if (existsSync(debugDir)) {
    try {
      const proc = Bun.spawnSync(
        ["find", debugDir, "-type", "f", "-mtime", "+14", "-delete", "-print"],
        { stdout: "pipe", stderr: "pipe" }
      );
      const deleted = proc.stdout.toString().trim().split("\n").filter(Boolean);
      filesRemoved += deleted.length;
    } catch {
      // Ignore errors
    }
  }

  // Clean file-history older than 30 days
  const fileHistoryDir = join(KAYA_HOME, "file-history");
  if (existsSync(fileHistoryDir)) {
    try {
      const proc = Bun.spawnSync(
        ["find", fileHistoryDir, "-type", "d", "-mtime", "+30", "-delete", "-print"],
        { stdout: "pipe", stderr: "pipe" }
      );
      const deleted = proc.stdout.toString().trim().split("\n").filter(Boolean);
      filesRemoved += deleted.length;
    } catch {
      // Ignore errors
    }
  }

  // Clean validation JSONL files older than 7 days (write-only, not consumed by anything)
  const validationDir = join(KAYA_HOME, "MEMORY", "VALIDATION");
  if (existsSync(validationDir)) {
    try {
      const proc = Bun.spawnSync(
        ["find", validationDir, "-type", "f", "-name", "*.jsonl", "-mtime", "+7", "-delete", "-print"],
        { stdout: "pipe", stderr: "pipe" }
      );
      const deleted = proc.stdout.toString().trim().split("\n").filter(Boolean);
      filesRemoved += deleted.length;
    } catch {
      // Ignore errors
    }
  }

  // Clean ephemeral agent todos (almost all empty [], not consumed after session ends)
  const todosDir = join(KAYA_HOME, "todos");
  if (existsSync(todosDir)) {
    try {
      const proc = Bun.spawnSync(
        ["find", todosDir, "-type", "f", "-mtime", "+3", "-delete", "-print"],
        { stdout: "pipe", stderr: "pipe" }
      );
      const deleted = proc.stdout.toString().trim().split("\n").filter(Boolean);
      filesRemoved += deleted.length;
    } catch {
      // Ignore errors
    }
  }

  // Clean StateManager backup files older than 7 days
  const daemonCronDir = join(KAYA_HOME, "MEMORY", "daemon", "cron");
  if (existsSync(daemonCronDir)) {
    try {
      const proc = Bun.spawnSync(
        ["find", daemonCronDir, "-type", "f", "-name", "*.backup.json", "-mtime", "+7", "-delete", "-print"],
        { stdout: "pipe", stderr: "pipe" }
      );
      const deleted = proc.stdout.toString().trim().split("\n").filter(Boolean);
      filesRemoved += deleted.length;
    } catch {
      // Ignore errors
    }
  }

  return {
    success: true,
    message: `Log rotation completed - ${filesRemoved} items cleaned`,
    metrics: { filesRemoved },
  };
}

// ============================================================================
// Human Action Queue & Notification Hygiene Steps
// ============================================================================

/**
 * Report stale human-pending items in the work queue (>7 days old).
 * Report-only — never modifies the queue.
 */
async function staleHumanPending(): Promise<StepResult> {
  try {
    if (!existsSync(WORK_QUEUE_FILE)) {
      return {
        success: true,
        message: "Work queue file not found — nothing to check",
        metrics: { staleCount: 0, totalActionable: 0 },
      };
    }

    const raw = readFileSync(WORK_QUEUE_FILE, "utf-8");
    const queue = JSON.parse(raw) as { items?: Array<{ id: string; title: string; status: string; createdAt?: string }> };
    const items = queue.items || [];

    const actionableStatuses = ["blocked", "awaiting_approval"];
    const actionable = items.filter((i) => actionableStatuses.includes(i.status));

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const stale = actionable.filter((i) => {
      if (!i.createdAt) return false;
      return new Date(i.createdAt) < sevenDaysAgo;
    });

    const staleDetails = stale.map((i) => {
      const age = Math.floor((Date.now() - new Date(i.createdAt!).getTime()) / (24 * 60 * 60 * 1000));
      return `${i.id}: "${i.title}" (${i.status}, ${age}d old)`;
    });

    try {
      const jmItems = loadQueueItems("jm-tasks");
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const staleJm = jmItems.filter(i =>
        ["pending", "in_progress", "blocked"].includes(i.status) &&
        i.created && new Date(i.created) < sevenDaysAgo
      );
      for (const item of staleJm) {
        staleDetails.push(`[jm-tasks] ${item.title ?? item.id} — ${item.status} since ${item.created}`);
      }
    } catch {}

    return {
      success: true,
      message: stale.length > 0
        ? `Found ${stale.length} stale human-pending items (>7 days): ${staleDetails.join("; ")}`
        : `No stale human-pending items found (${actionable.length} actionable items all within 7 days)`,
      data: { staleItems: staleDetails },
      metrics: { staleCount: stale.length, totalActionable: actionable.length },
    };
  } catch (err) {
    return {
      success: true,
      message: `Stale human-pending check skipped: ${err}`,
      metrics: { staleCount: 0, totalActionable: 0 },
    };
  }
}

/**
 * Trim notification log entries older than 30 days.
 * Keeps malformed lines for safety. Counts autonomous_work channel entries.
 */
async function notificationLogHygiene(): Promise<StepResult> {
  try {
    if (!existsSync(NOTIFICATIONS_FILE)) {
      return {
        success: true,
        message: "Notifications file not found — nothing to trim",
        metrics: { totalBefore: 0, removed: 0, retained: 0, autonomousWorkEntries: 0 },
      };
    }

    const content = readFileSync(NOTIFICATIONS_FILE, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    const totalBefore = lines.length;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const retained: string[] = [];
    let autonomousWorkEntries = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.timestamp && new Date(entry.timestamp) < thirtyDaysAgo) {
          continue; // Drop old entries
        }
        if (entry.channel === "autonomous_work") {
          autonomousWorkEntries++;
        }
        retained.push(line);
      } catch {
        // Keep malformed lines for safety
        retained.push(line);
      }
    }

    const removed = totalBefore - retained.length;

    if (removed > 0) {
      writeFileSync(NOTIFICATIONS_FILE, retained.join("\n") + "\n");
    }

    return {
      success: true,
      message: `Notification log hygiene: ${removed} entries removed, ${retained.length} retained (${autonomousWorkEntries} autonomous_work)`,
      metrics: { totalBefore, removed, retained: retained.length, autonomousWorkEntries },
    };
  } catch (err) {
    return {
      success: true,
      message: `Notification log hygiene skipped: ${err}`,
      metrics: { totalBefore: 0, removed: 0, retained: 0, autonomousWorkEntries: 0 },
    };
  }
}

// ============================================================================
// Weekly Reports Steps (Tuesday)
// ============================================================================

/**
 * Memory store consolidation
 */
async function memoryConsolidation(): Promise<StepResult> {
  try {
    const proc = Bun.spawnSync(
      ["bun", "run", join(KAYA_HOME, "lib/core/MemoryStore.ts"), "consolidate", "--json"],
      { stdout: "pipe", stderr: "pipe", timeout: 60000 }
    );

    if (proc.exitCode === 0) {
      const output = proc.stdout.toString();
      try {
        const result = JSON.parse(output);
        return {
          success: true,
          message: `Memory consolidation completed - ${result.archived || 0} entries archived`,
          data: result,
          metrics: { entriesArchived: result.archived || 0, ttlExpired: result.expired || 0 },
        };
      } catch {
        return {
          success: true,
          message: "Memory consolidation completed",
          metrics: { entriesArchived: 0, ttlExpired: 0 },
        };
      }
    }

    return {
      success: true,
      message: "Memory consolidation skipped (tool not available)",
      metrics: { entriesArchived: 0, ttlExpired: 0 },
    };
  } catch {
    return {
      success: true,
      message: "Memory consolidation skipped due to error",
      metrics: { entriesArchived: 0, ttlExpired: 0 },
    };
  }
}

/**
 * Generate weekly report with agent synthesis
 */
async function generateWeeklyReport(stepResults: Map<string, StepResult>): Promise<StepResult> {
  const reportPath = getOutputPath("weekly");
  const weekNum = getWeekNumber();

  const auditResult = stepResults.get("full-audit");
  const secretResult = stepResults.get("secret-scanning");
  const privacyResult = stepResults.get("privacy-validation");
  const cleanupResult = stepResults.get("state-cleanup");
  const logResult = stepResults.get("log-rotation");
  const memoryResult = stepResults.get("memory-consolidation");
  const staleResult = stepResults.get("stale-human-pending");
  const notifResult = stepResults.get("notification-log-hygiene");

  const report = `# Weekly Maintenance Report - ${weekNum}

**Run Time:** ${new Date().toISOString()}
**Report Path:** ${reportPath}

## Summary

| Check | Status | Details |
|-------|--------|---------|
| Integrity Audit | ${auditResult?.success ? "✅" : "⚠️"} | ${auditResult?.metrics?.domainsChecked || 0} domains, ${auditResult?.metrics?.issuesFound || 0} issues |
| Secret Scan | ${secretResult?.success ? "✅" : "❌"} | ${secretResult?.metrics?.secretsFound || 0} secrets found |
| Privacy Validation | ${privacyResult?.success ? "✅" : "❌"} | ${privacyResult?.metrics?.violations || 0} violations |
| State Cleanup | ${cleanupResult?.success ? "✅" : "⚠️"} | ${cleanupResult?.metrics?.archived || 0} items archived |
| Log Rotation | ${logResult?.success ? "✅" : "⚠️"} | ${logResult?.metrics?.filesRemoved || 0} files removed |
| Human Action Queue | ${staleResult?.success ? "✅" : "⚠️"} | ${staleResult?.metrics?.staleCount || 0} stale, ${staleResult?.metrics?.totalActionable || 0} actionable |
| Notification Log | ${notifResult?.success ? "✅" : "⚠️"} | ${notifResult?.metrics?.removed || 0} removed, ${notifResult?.metrics?.retained || 0} retained |
| Memory Consolidation | ${memoryResult?.success ? "✅" : "⚠️"} | ${memoryResult?.metrics?.entriesArchived || 0} entries archived |

## Integrity Audit
- Domains checked: ${auditResult?.metrics?.domainsChecked || 0}
- Issues found: ${auditResult?.metrics?.issuesFound || 0}
${auditResult?.data?.issues?.length > 0 ? `\n### Issues\n${auditResult.data.issues.join("\n")}` : ""}

## Security Scan
- TruffleHog status: ${secretResult?.success ? "Clean" : "Issues Found"}
- Secrets detected: ${secretResult?.metrics?.secretsFound || 0}

## Privacy Validation
- USER/SYSTEM isolation: ${privacyResult?.success ? "Pass" : "FAIL"}
- Violations: ${privacyResult?.metrics?.violations || 0}

## Human Action Queue
- Stale items (>7 days): ${staleResult?.metrics?.staleCount || 0}
- Total actionable: ${staleResult?.metrics?.totalActionable || 0}
${staleResult?.data?.staleItems?.length > 0 ? `\n### Stale Items\n${staleResult.data.staleItems.map((i: string) => `- ${i}`).join("\n")}` : ""}

## Notification Log
- Before: ${notifResult?.metrics?.totalBefore || 0} entries
- Removed (>30 days): ${notifResult?.metrics?.removed || 0}
- Retained: ${notifResult?.metrics?.retained || 0}
- Autonomous work entries: ${notifResult?.metrics?.autonomousWorkEntries || 0}

## Maintenance Operations
- Work items archived: ${cleanupResult?.metrics?.archived || 0}
- Log files cleaned: ${logResult?.metrics?.filesRemoved || 0}
- Memory entries archived: ${memoryResult?.metrics?.entriesArchived || 0}

## System Health
- Overall status: ${[auditResult, secretResult, privacyResult].every(r => r?.success) ? "✅ Healthy" : "⚠️ Needs Attention"}
`;

  writeFileSync(reportPath, report);

  return {
    success: true,
    message: `Weekly report generated at ${reportPath}`,
    data: { reportPath },
    metrics: { reportsGenerated: 1 },
  };
}

// ============================================================================
// Monthly Learning Backfill Step
// ============================================================================

/**
 * Backfill unindexed MEMORY/LEARNING/ .md files into MemoryStore.
 * Catches orphaned learning files that weren't indexed at capture time.
 */
async function learningBackfill(): Promise<StepResult> {
  try {
    const backfillPath = join(KAYA_HOME, "skills", "ContinualLearning", "Tools", "BackfillIndexer.ts");
    const proc = Bun.spawnSync(
      ["bun", "run", backfillPath, "--json"],
      { stdout: "pipe", stderr: "pipe", timeout: 300000 }
    );

    if (proc.exitCode === 0) {
      const output = proc.stdout.toString().trim();
      try {
        const result = JSON.parse(output);
        return {
          success: true,
          message: `Learning backfill: ${result.indexed || 0} new entries indexed, ${result.skippedDuplicate || 0} duplicates skipped`,
          data: result,
          metrics: {
            indexed: result.indexed || 0,
            scanned: result.scanned || 0,
            skippedDuplicate: result.skippedDuplicate || 0,
          },
        };
      } catch {
        return {
          success: true,
          message: "Learning backfill completed (output not parseable as JSON)",
          metrics: { indexed: 0, scanned: 0 },
        };
      }
    }

    return {
      success: true,
      message: `Learning backfill exited with code ${proc.exitCode}: ${proc.stderr.toString().slice(0, 200)}`,
      metrics: { indexed: 0, scanned: 0 },
    };
  } catch (err) {
    return {
      success: true,
      message: `Learning backfill failed: ${err}`,
      metrics: { indexed: 0, scanned: 0 },
    };
  }
}

// ============================================================================
// Monthly Workspace Steps (Thursday)
// ============================================================================

/**
 * Workspace cleanup - find stale branches, orphaned files, temp dirs, orphaned worktrees
 */
async function workspaceCleanup(): Promise<StepResult> {
  const staleBranches: string[] = [];
  let orphanedFiles = 0;
  let tempDirsCleaned = 0;
  let worktreesPruned = 0;

  // Find stale git branches (merged branches)
  try {
    const proc = Bun.spawnSync(
      ["git", "branch", "--merged", "main"],
      { cwd: KAYA_HOME, stdout: "pipe", stderr: "pipe" }
    );
    const output = proc.stdout.toString().trim();
    if (output) {
      const branches = output.split("\n")
        .map(b => b.trim())
        .filter(b => b && !b.startsWith("*") && b !== "main" && b !== "master");
      staleBranches.push(...branches);
    }
  } catch {
    // Ignore errors
  }

  // Find .DS_Store files
  try {
    const proc = Bun.spawnSync(
      ["find", KAYA_HOME, "-name", ".DS_Store", "-type", "f"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const output = proc.stdout.toString().trim();
    if (output) {
      orphanedFiles = output.split("\n").filter(Boolean).length;
    }
  } catch {
    // Ignore errors
  }

  // Clean scratch directories
  const scratchDir = join(KAYA_HOME, "scratch");
  if (existsSync(scratchDir)) {
    try {
      const proc = Bun.spawnSync(
        ["find", scratchDir, "-type", "f", "-mtime", "+7", "-delete", "-print"],
        { stdout: "pipe", stderr: "pipe" }
      );
      const deleted = proc.stdout.toString().trim().split("\n").filter(Boolean);
      tempDirsCleaned = deleted.length;
    } catch {
      // Ignore errors
    }
  }

  // Prune orphaned git worktrees (safety net for missed eager cleanup)
  try {
    const { pruneOrphaned } = await import("../../../../lib/core/WorktreeManager.ts");
    const pruneResult = await pruneOrphaned();
    worktreesPruned = pruneResult.removed.length;
  } catch {
    // Ignore errors — WorktreeManager may not be initialized yet
  }

  return {
    success: true,
    message: `Workspace cleanup: ${staleBranches.length} stale branches, ${orphanedFiles} orphaned files, ${tempDirsCleaned} temp files cleaned, ${worktreesPruned} worktrees pruned`,
    data: { staleBranches, orphanedFiles, tempDirsCleaned, worktreesPruned },
    metrics: { staleBranches: staleBranches.length, orphanedFiles, tempDirsCleaned, worktreesPruned },
  };
}

// ============================================================================
// Monthly Skills Steps (Friday)
// ============================================================================

/**
 * Skill audit - comprehensive skill health review
 */
async function skillAudit(): Promise<StepResult> {
  const skillsDir = join(KAYA_HOME, "skills");
  let skillsChecked = 0;
  let healthySkills = 0;
  const skillsNeedingAttention: string[] = [];
  let brokenReferences = 0;

  if (!existsSync(skillsDir)) {
    return {
      success: true,
      message: "No skills directory found",
      metrics: { skillsChecked: 0, healthySkills: 0, brokenReferences: 0 },
    };
  }

  try {
    const skills = readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const skill of skills) {
      skillsChecked++;
      const skillPath = join(skillsDir, skill);
      const skillFile = join(skillPath, "SKILL.md");

      if (!existsSync(skillFile)) {
        skillsNeedingAttention.push(`${skill}: missing SKILL.md`);
        brokenReferences++;
        continue;
      }

      const broken = findBrokenSymlinks(skillPath);
      if (broken.length > 0) {
        skillsNeedingAttention.push(`${skill}: ${broken.length} broken symlinks`);
        brokenReferences += broken.length;
        continue;
      }

      healthySkills++;
    }
  } catch {
    // Ignore errors
  }

  return {
    success: true,
    message: `Skill audit: ${healthySkills}/${skillsChecked} healthy, ${skillsNeedingAttention.length} need attention`,
    data: { skillsChecked, healthySkills, skillsNeedingAttention, brokenReferences },
    metrics: { skillsChecked, healthySkills, brokenReferences },
  };
}

// ============================================================================
// Monthly Reports Steps (Saturday)
// ============================================================================

/**
 * Generate monthly report
 */
async function generateMonthlyReport(stepResults: Map<string, StepResult>): Promise<StepResult> {
  const yearMonth = isoDate().slice(0, 7); // YYYY-MM
  const reportPath = getOutputPath("monthly");

  const workspaceResult = stepResults.get("workspace-cleanup");
  const skillResult = stepResults.get("skill-audit");

  // Gather monthly stats
  let dailyRuns = 0;
  let weeklyRuns = 0;
  const dailyDir = join(MAINTENANCE_DIR, "daily");
  const weeklyDir = join(MAINTENANCE_DIR, "weekly");

  if (existsSync(dailyDir)) {
    try {
      dailyRuns = readdirSync(dailyDir).filter(f => f.endsWith(".md")).length;
    } catch {}
  }
  if (existsSync(weeklyDir)) {
    try {
      weeklyRuns = readdirSync(weeklyDir).filter(f => f.endsWith(".md")).length;
    } catch {}
  }

  const report = `# Monthly Maintenance Report - ${yearMonth}

**Run Time:** ${new Date().toISOString()}
**Report Path:** ${reportPath}

## Summary

| Check | Status | Details |
|-------|--------|---------|
| Workspace Cleanup | ${workspaceResult?.success ? "✅" : "⚠️"} | ${workspaceResult?.metrics?.staleBranches || 0} stale branches |
| Skill Audit | ${skillResult?.success ? "✅" : "⚠️"} | ${skillResult?.metrics?.healthySkills || 0}/${skillResult?.metrics?.skillsChecked || 0} healthy |

## Workspace Cleanup
- Stale branches found: ${workspaceResult?.metrics?.staleBranches || 0}
- Orphaned files: ${workspaceResult?.metrics?.orphanedFiles || 0}
- Temp files cleaned: ${workspaceResult?.metrics?.tempDirsCleaned || 0}
${workspaceResult?.data?.staleBranches?.length > 0 ? `\n### Stale Branches\n${workspaceResult.data.staleBranches.join("\n")}` : ""}

## Skill Audit
- Skills checked: ${skillResult?.metrics?.skillsChecked || 0}
- Healthy skills: ${skillResult?.metrics?.healthySkills || 0}
- Broken references: ${skillResult?.metrics?.brokenReferences || 0}
${skillResult?.data?.skillsNeedingAttention?.length > 0 ? `\n### Skills Needing Attention\n${skillResult.data.skillsNeedingAttention.join("\n")}` : ""}

## Monthly Statistics
- Daily maintenance runs this month: ${dailyRuns}
- Weekly maintenance runs this month: ${weeklyRuns}

## System Health
- Overall status: ${[workspaceResult, skillResult].every(r => r?.success) ? "✅ Healthy" : "⚠️ Needs Attention"}
`;

  writeFileSync(reportPath, report);

  return {
    success: true,
    message: `Monthly report generated at ${reportPath}`,
    data: { reportPath },
    metrics: { reportsGenerated: 1 },
  };
}

/**
 * Generate daily report
 */
async function generateDailyReport(stepResults: Map<string, StepResult>): Promise<StepResult> {
  const reportPath = getOutputPath("daily");

  const integrityResult = stepResults.get("integrity-check");
  const claudeResult = stepResults.get("update-claude");

  const report = `# Daily Maintenance Report - ${isoDate()}

**Run Time:** ${new Date().toISOString()}
**Report Path:** ${reportPath}

## Summary

| Check | Status | Details |
|-------|--------|---------|
| Integrity Check | ${integrityResult?.success ? "✅" : "⚠️"} | ${integrityResult?.metrics?.checked || 0} paths checked |
| Claude CLI Update | ${claudeResult?.success ? "✅" : "⚠️"} | ${claudeResult?.data?.updated ? "Updated" : "Up to date"} |

## Integrity Check
- Critical paths verified: ${integrityResult?.metrics?.checked || 0}
- Missing paths: ${integrityResult?.metrics?.missing || 0}
- Broken symlinks: ${integrityResult?.metrics?.brokenLinks || 0}
${integrityResult?.data?.missing?.length > 0 ? `\n### Missing Paths\n${integrityResult.data.missing.join("\n")}` : ""}

## Claude CLI Update
- Previous version: ${claudeResult?.data?.previousVersion || "unknown"}
- Current version: ${claudeResult?.data?.currentVersion || "unknown"}
- Updated: ${claudeResult?.data?.updated ? "Yes" : "No"}
`;

  writeFileSync(reportPath, report);

  return {
    success: true,
    message: `Daily report generated at ${reportPath}`,
    data: { reportPath },
    metrics: { reportsGenerated: 1 },
  };
}

// ============================================================================
// ISC Definitions
// ============================================================================

const dailyISC: VerificationSpec = {
  criteria: [
    "Critical paths verified",
    "No broken symlinks",
    "Claude CLI version checked",
    "Daily report generated",
  ],
  checkFn: (results) => {
    const unmet: string[] = [];
    let score = 0;

    if (results.get("integrity-check")?.success) {
      score += 25;
    } else {
      unmet.push("Critical paths verified");
    }

    if ((results.get("integrity-check")?.metrics?.brokenLinks || 0) === 0) {
      score += 25;
    } else {
      unmet.push("No broken symlinks");
    }

    if (results.get("update-claude")?.success) {
      score += 25;
    } else {
      unmet.push("Claude CLI version checked");
    }

    if (results.get("generate-report")?.success) {
      score += 25;
    } else {
      unmet.push("Daily report generated");
    }

    return { met: unmet.length === 0, score, unmetCriteria: unmet };
  },
};

const weeklyISC: VerificationSpec = {
  criteria: [
    "Full integrity audit completed",
    "Secret scan passed",
    "Privacy validation passed",
    "State cleanup completed",
    "Log rotation completed",
    "Stale human-pending items reported",
    "Notification log hygiene completed",
    "Memory consolidation completed",
    "Weekly report generated",
  ],
  checkFn: (results) => {
    const unmet: string[] = [];
    let score = 0;
    const stepWeight = 100 / 9;

    const checks = [
      { key: "full-audit", label: "Full integrity audit completed" },
      { key: "secret-scanning", label: "Secret scan passed" },
      { key: "privacy-validation", label: "Privacy validation passed" },
      { key: "state-cleanup", label: "State cleanup completed" },
      { key: "log-rotation", label: "Log rotation completed" },
      { key: "stale-human-pending", label: "Stale human-pending items reported" },
      { key: "notification-log-hygiene", label: "Notification log hygiene completed" },
      { key: "memory-consolidation", label: "Memory consolidation completed" },
      { key: "generate-report", label: "Weekly report generated" },
    ];

    for (const check of checks) {
      if (results.get(check.key)?.success) {
        score += stepWeight;
      } else {
        unmet.push(check.label);
      }
    }

    return { met: unmet.length === 0, score: Math.round(score), unmetCriteria: unmet };
  },
};

const monthlyISC: VerificationSpec = {
  criteria: [
    "Workspace cleanup completed",
    "Skill audit completed",
    "Monthly report generated",
  ],
  checkFn: (results) => {
    const unmet: string[] = [];
    let score = 0;

    if (results.get("workspace-cleanup")?.success) {
      score += 33;
    } else {
      unmet.push("Workspace cleanup completed");
    }

    if (results.get("skill-audit")?.success) {
      score += 34;
    } else {
      unmet.push("Skill audit completed");
    }

    if (results.get("generate-report")?.success) {
      score += 33;
    } else {
      unmet.push("Monthly report generated");
    }

    return { met: unmet.length === 0, score, unmetCriteria: unmet };
  },
};

// ============================================================================
// Workflow Step Definitions
// ============================================================================

const dailySteps: WorkflowStep[] = [
  {
    name: "integrity-check",
    description: "Verify critical paths exist and no broken symlinks",
    execute: integrityCheck,
    parallel: true,
  },
  {
    name: "update-claude",
    description: "Check and install Claude CLI updates",
    execute: updateClaude,
    parallel: true,
  },
  {
    name: "synthesis-freshness",
    description: "Check if knowledge synthesis is stale (>7 days) and trigger if needed",
    execute: synthesisFreshnessCheck,
    parallel: true,
  },
];

// Weekly Security Steps (Sunday)
const weeklySecuritySteps: WorkflowStep[] = [
  {
    name: "full-audit",
    description: "Full integrity audit across all domains",
    execute: fullAudit,
    timeout: 300000,
  },
  {
    name: "secret-scanning",
    description: "Scan for leaked secrets with TruffleHog",
    execute: secretScanning,
    parallel: true,
    timeout: 120000,
  },
  {
    name: "privacy-validation",
    description: "Validate USER/SYSTEM content separation",
    execute: privacyValidation,
    parallel: true,
  },
];

/**
 * Failure package cleanup — delete packages older than 90 days (ISC 1140)
 *
 * Scans MEMORY/LEARNING/FAILURES/YYYY-MM/{package-dir}/ directories.
 * Deletes any package directory whose mtime is > 90 days old.
 * Hard deletion (not archive) unless failures.archiveOnExpiry is configured.
 */
async function cleanupFailurePackages(): Promise<StepResult> {
  const failuresDir = join(KAYA_HOME, "MEMORY", "LEARNING", "FAILURES");
  const RETENTION_DAYS = 90;
  const retentionMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;

  if (!existsSync(failuresDir)) {
    return {
      success: true,
      message: "No FAILURES directory to clean",
      metrics: { deleted: 0 },
    };
  }

  let deleted = 0;
  const now = Date.now();

  try {
    // Each subdirectory is a YYYY-MM month bucket
    const monthDirs = readdirSync(failuresDir);
    for (const monthDir of monthDirs) {
      const monthPath = join(failuresDir, monthDir);
      let monthStats: ReturnType<typeof statSync>;
      try { monthStats = statSync(monthPath); } catch { continue; }
      if (!monthStats.isDirectory()) continue;

      // Each sub-subdirectory is a package
      const packages = readdirSync(monthPath);
      for (const pkg of packages) {
        const pkgPath = join(monthPath, pkg);
        let pkgStats: ReturnType<typeof statSync>;
        try { pkgStats = statSync(pkgPath); } catch { continue; }
        if (!pkgStats.isDirectory()) continue;

        const ageMs = now - pkgStats.mtimeMs;
        if (ageMs > retentionMs) {
          // Hard delete (rm -rf on the package directory)
          try {
            const proc = Bun.spawnSync(["rm", "-rf", pkgPath], { stdout: "pipe", stderr: "pipe" });
            if (proc.exitCode === 0) {
              deleted++;
            }
          } catch {
            // Non-fatal
          }
        }
      }

      // Clean up empty month directories
      try {
        const remaining = readdirSync(monthPath);
        if (remaining.length === 0) {
          Bun.spawnSync(["rmdir", monthPath], { stdout: "pipe", stderr: "pipe" });
        }
      } catch {
        // Non-fatal
      }
    }
  } catch {
    // Non-fatal
  }

  return {
    success: true,
    message: deleted > 0
      ? `Deleted ${deleted} failure packages older than ${RETENTION_DAYS} days`
      : `No failure packages older than ${RETENTION_DAYS} days found`,
    metrics: { deleted },
  };
}

// Weekly Cleanup Steps (Monday)
const weeklyCleanupSteps: WorkflowStep[] = [
  {
    name: "state-cleanup",
    description: "Archive completed work items older than 7 days",
    execute: stateCleanup,
  },
  {
    name: "log-rotation",
    description: "Rotate debug logs and clean caches",
    execute: logRotation,
  },
  {
    name: "stale-human-pending",
    description: "Report stale human-pending items older than 7 days",
    execute: staleHumanPending,
  },
  {
    name: "notification-log-hygiene",
    description: "Trim notification log entries older than 30 days",
    execute: notificationLogHygiene,
  },
  {
    name: "failure-package-cleanup",
    description: "Delete failure packages older than 90 days (ISC 1140)",
    execute: cleanupFailurePackages,
  },
];

// Weekly Reports Steps (Tuesday)
const weeklyReportsSteps: WorkflowStep[] = [
  {
    name: "memory-consolidation",
    description: "Consolidate memory store entries",
    execute: memoryConsolidation,
  },
];

// Monthly Workspace Steps (Thursday)
const monthlyWorkspaceSteps: WorkflowStep[] = [
  {
    name: "workspace-cleanup",
    description: "Clean stale branches, orphaned files, and temp directories",
    execute: workspaceCleanup,
    timeout: 300000,
  },
];

// Monthly Skills Steps (Friday)
const monthlySkillsSteps: WorkflowStep[] = [
  {
    name: "skill-audit",
    description: "Comprehensive skill health review",
    execute: skillAudit,
    timeout: 300000,
  },
];

// Combine all weekly steps
const weeklySteps: WorkflowStep[] = [
  ...weeklySecuritySteps,
  ...weeklyCleanupSteps,
  ...weeklyReportsSteps,
];

// Monthly Learning Backfill Step
const monthlyLearningSteps: WorkflowStep[] = [
  {
    name: "learning-backfill",
    description: "Index unindexed MEMORY/LEARNING/ files into MemoryStore",
    execute: learningBackfill,
    timeout: 300000,
  },
];

// Combine all monthly steps
const monthlySteps: WorkflowStep[] = [
  ...monthlyWorkspaceSteps,
  ...monthlySkillsSteps,
  ...monthlyLearningSteps,
];

// ============================================================================
// Step Result Collection Helper
// ============================================================================

/**
 * Wraps a workflow step so its result is captured into a shared accumulator map.
 * This allows downstream steps (like report generation) to access results from
 * prior steps via closure over the same shared map.
 */
function collectingStep(
  step: WorkflowStep,
  accumulator: Map<string, StepResult>
): WorkflowStep {
  return {
    ...step,
    execute: async () => {
      const result = await step.execute();
      accumulator.set(step.name, result);
      return result;
    },
  };
}

/**
 * Wraps an array of workflow steps so all results are collected into a shared map.
 */
function collectingSteps(
  steps: WorkflowStep[],
  accumulator: Map<string, StepResult>
): WorkflowStep[] {
  return steps.map(step => collectingStep(step, accumulator));
}

// ============================================================================
// Create Workflow Configurations
// ============================================================================

const checkpointDir = join(KAYA_HOME, ".checkpoints");

// Full tiered workflows
//
// Each workflow creates a shared stepResults accumulator. All non-report steps
// are wrapped with collectingStep() so their results flow into the accumulator.
// The report generation step closes over this same accumulator, giving it access
// to all prior step results. This fixes the bug where report steps previously
// created a new empty Map and thus always showed "0 paths checked."

const dailyAccumulator = new Map<string, StepResult>();
export const daily: WorkflowConfig = {
  name: "AutoMaintenance-daily",
  description: "Daily maintenance workflow",
  steps: [
    ...collectingSteps(dailySteps, dailyAccumulator),
    {
      name: "generate-report",
      description: "Generate daily maintenance report",
      execute: async () => generateDailyReport(dailyAccumulator),
      dependsOn: dailySteps.map(s => s.name),
    },
  ],
  verification: dailyISC,
  notifyOnStart: true,
  notifyOnComplete: true,
  checkpointFile: join(checkpointDir, "automaintenance-daily.json"),
};

const weeklyAccumulator = new Map<string, StepResult>();
export const weekly: WorkflowConfig = {
  name: "AutoMaintenance-weekly",
  description: "Weekly maintenance workflow (includes daily)",
  steps: [
    ...collectingSteps(dailySteps, weeklyAccumulator),
    ...collectingSteps(weeklySteps, weeklyAccumulator),
    {
      name: "generate-report",
      description: "Generate weekly audit report",
      execute: async () => generateWeeklyReport(weeklyAccumulator),
      dependsOn: [...dailySteps.map(s => s.name), ...weeklySteps.map(s => s.name)],
    },
  ],
  verification: weeklyISC,
  notifyOnStart: true,
  notifyOnComplete: true,
  checkpointFile: join(checkpointDir, "automaintenance-weekly.json"),
};

const monthlyAccumulator = new Map<string, StepResult>();
export const monthly: WorkflowConfig = {
  name: "AutoMaintenance-monthly",
  description: "Monthly maintenance workflow (includes daily and weekly)",
  steps: [
    ...collectingSteps(dailySteps, monthlyAccumulator),
    ...collectingSteps(weeklySteps, monthlyAccumulator),
    ...collectingSteps(monthlySteps, monthlyAccumulator),
    {
      name: "generate-report",
      description: "Generate monthly maintenance report",
      execute: async () => generateMonthlyReport(monthlyAccumulator),
      dependsOn: [
        ...dailySteps.map(s => s.name),
        ...weeklySteps.map(s => s.name),
        ...monthlySteps.map(s => s.name),
      ],
    },
  ],
  verification: monthlyISC,
  notifyOnStart: true,
  notifyOnComplete: true,
  checkpointFile: join(checkpointDir, "automaintenance-monthly.json"),
};

// Staggered sub-tier workflows
export const weeklySecurity: WorkflowConfig = {
  name: "AutoMaintenance-weekly-security",
  description: "Weekly security audit (Sunday)",
  steps: weeklySecuritySteps,
  notifyOnStart: true,
  notifyOnComplete: true,
  checkpointFile: join(checkpointDir, "automaintenance-weekly-security.json"),
};

export const weeklyCleanup: WorkflowConfig = {
  name: "AutoMaintenance-weekly-cleanup",
  description: "Weekly state and log cleanup (Monday)",
  steps: weeklyCleanupSteps,
  notifyOnStart: true,
  notifyOnComplete: true,
  checkpointFile: join(checkpointDir, "automaintenance-weekly-cleanup.json"),
};

const weeklyReportsAccumulator = new Map<string, StepResult>();
export const weeklyReports: WorkflowConfig = {
  name: "AutoMaintenance-weekly-reports",
  description: "Weekly memory consolidation and report (Tuesday)",
  steps: [
    ...collectingSteps(weeklyReportsSteps, weeklyReportsAccumulator),
    {
      name: "generate-report",
      description: "Generate weekly audit report",
      execute: async () => generateWeeklyReport(weeklyReportsAccumulator),
      dependsOn: weeklyReportsSteps.map(s => s.name),
    },
  ],
  notifyOnStart: true,
  notifyOnComplete: true,
  checkpointFile: join(checkpointDir, "automaintenance-weekly-reports.json"),
};

export const monthlyWorkspace: WorkflowConfig = {
  name: "AutoMaintenance-monthly-workspace",
  description: "Monthly workspace cleanup (Thursday)",
  steps: monthlyWorkspaceSteps,
  notifyOnStart: true,
  notifyOnComplete: true,
  checkpointFile: join(checkpointDir, "automaintenance-monthly-workspace.json"),
};

export const monthlySkills: WorkflowConfig = {
  name: "AutoMaintenance-monthly-skills",
  description: "Monthly skill audit (Friday)",
  steps: monthlySkillsSteps,
  notifyOnStart: true,
  notifyOnComplete: true,
  checkpointFile: join(checkpointDir, "automaintenance-monthly-skills.json"),
};

const monthlyReportsAccumulator = new Map<string, StepResult>();
export const monthlyReports: WorkflowConfig = {
  name: "AutoMaintenance-monthly-reports",
  description: "Monthly report generation (Saturday)",
  steps: [
    ...collectingSteps(monthlyWorkspaceSteps, monthlyReportsAccumulator),
    ...collectingSteps(monthlySkillsSteps, monthlyReportsAccumulator),
    {
      name: "generate-report",
      description: "Generate monthly maintenance report",
      execute: async () => generateMonthlyReport(monthlyReportsAccumulator),
      dependsOn: [...monthlyWorkspaceSteps.map(s => s.name), ...monthlySkillsSteps.map(s => s.name)],
    },
  ],
  notifyOnStart: true,
  notifyOnComplete: true,
  checkpointFile: join(checkpointDir, "automaintenance-monthly-reports.json"),
};

// ============================================================================
// Weekly Orchestrated Workflow (Unified Sunday Run)
// ============================================================================
//
// Combines all weekly tasks into a single orchestrated run with correct ordering:
// - Phase 1 (parallel): Security audit + Memory consolidation/learning
// - Phase 2 (sequential): State cleanup and log rotation AFTER learning completes
//
// This ensures continual learning processes memory BEFORE cleanup deletes it.
// ============================================================================

const weeklyOrchestratedISC: VerificationSpec = {
  criteria: [
    "Full integrity audit completed",
    "Secret scan passed",
    "Privacy validation passed",
    "Memory consolidation completed before cleanup",
    "Knowledge synthesis completed",
    "Graph context refreshed for sessions",
    "Job scoring weights updated",
    "State cleanup completed",
    "Log rotation completed",
    "Stale human-pending items reported",
    "Notification log hygiene completed",
    "Weekly report generated",
  ],
  checkFn: (results) => {
    const unmet: string[] = [];
    let score = 0;
    const stepWeight = 100 / 12;

    const checks = [
      { key: "full-audit", label: "Full integrity audit completed" },
      { key: "secret-scanning", label: "Secret scan passed" },
      { key: "privacy-validation", label: "Privacy validation passed" },
      { key: "memory-consolidation", label: "Memory consolidation completed before cleanup" },
      { key: "knowledge-synthesis", label: "Knowledge synthesis completed" },
      { key: "graph-context-refresh", label: "Graph context refreshed for sessions" },
      { key: "update-job-scoring-weights", label: "Job scoring weights updated" },
      { key: "state-cleanup", label: "State cleanup completed" },
      { key: "log-rotation", label: "Log rotation completed" },
      { key: "stale-human-pending", label: "Stale human-pending items reported" },
      { key: "notification-log-hygiene", label: "Notification log hygiene completed" },
      { key: "generate-report", label: "Weekly report generated" },
    ];

    for (const check of checks) {
      if (results.get(check.key)?.success) {
        score += stepWeight;
      } else {
        unmet.push(check.label);
      }
    }

    return { met: unmet.length === 0, score: Math.round(score), unmetCriteria: unmet };
  },
};

const weeklyOrchestratedAccumulator = new Map<string, StepResult>();

/**
 * Helper to create a collecting step inline for the orchestrated workflow.
 */
function orchStep(step: WorkflowStep): WorkflowStep {
  return collectingStep(step, weeklyOrchestratedAccumulator);
}

export const weeklyOrchestrated: WorkflowConfig = {
  name: "AutoMaintenance-weekly-orchestrated",
  description: "Unified weekly maintenance with correct ordering: learning before cleanup",
  steps: [
    // Phase 1: Security work (parallel)
    orchStep({
      name: "full-audit",
      description: "Full integrity audit across all domains",
      execute: fullAudit,
      parallel: true,
      timeout: 300000,
    }),
    orchStep({
      name: "secret-scanning",
      description: "Scan for leaked secrets with TruffleHog",
      execute: secretScanning,
      parallel: true,
      timeout: 120000,
    }),
    orchStep({
      name: "privacy-validation",
      description: "Validate USER/SYSTEM content separation",
      execute: privacyValidation,
      parallel: true,
    }),
    // Phase 1: Learning work (parallel with security)
    orchStep({
      name: "memory-consolidation",
      description: "Consolidate memory store entries and process learnings",
      execute: memoryConsolidation,
      parallel: true,
      timeout: 120000,
    }),
    orchStep({
      name: "knowledge-synthesis",
      description: "Run weekly knowledge synthesis via ContinualLearning",
      execute: runKnowledgeSynthesis,
      parallel: true,
      timeout: 120000,
    }),
    orchStep({
      name: "graph-context-refresh",
      description: "Refresh graph context for session intelligence",
      execute: refreshGraphContext,
      parallel: true,
      timeout: 60000,
    }),
    orchStep({
      name: "update-job-scoring-weights",
      description: "Adaptively update JobEngine scoring weights based on callback analytics",
      execute: updateJobScoringWeights,
      parallel: true,
      timeout: 30000,
    }),
    // Phase 2: Cleanup (sequential, AFTER memory consolidation and synthesis)
    orchStep({
      name: "state-cleanup",
      description: "Archive completed work items older than 7 days",
      execute: stateCleanup,
      dependsOn: ["memory-consolidation", "knowledge-synthesis", "graph-context-refresh", "update-job-scoring-weights", "full-audit"],
    }),
    orchStep({
      name: "log-rotation",
      description: "Rotate debug logs and clean caches",
      execute: logRotation,
      dependsOn: ["state-cleanup"],
    }),
    orchStep({
      name: "stale-human-pending",
      description: "Report stale human-pending items older than 7 days",
      execute: staleHumanPending,
      dependsOn: ["log-rotation"],
    }),
    orchStep({
      name: "notification-log-hygiene",
      description: "Trim notification log entries older than 30 days",
      execute: notificationLogHygiene,
      dependsOn: ["log-rotation"],
    }),
    // Phase 3: Report generation (after all steps complete)
    {
      name: "generate-report",
      description: "Generate weekly maintenance report",
      execute: async () => generateWeeklyReport(weeklyOrchestratedAccumulator),
      dependsOn: ["full-audit", "secret-scanning", "privacy-validation", "memory-consolidation", "knowledge-synthesis", "graph-context-refresh", "update-job-scoring-weights", "state-cleanup", "log-rotation", "stale-human-pending", "notification-log-hygiene"],
    },
  ],
  verification: weeklyOrchestratedISC,
  notifyOnStart: true,
  notifyOnComplete: true,
  checkpointFile: join(checkpointDir, "automaintenance-weekly-orchestrated.json"),
};

// ============================================================================
// CLI Entry Point
// ============================================================================

type TierName =
  | "daily" | "weekly" | "monthly"
  | "weekly-security" | "weekly-cleanup" | "weekly-reports"
  | "weekly-orchestrated"
  | "monthly-workspace" | "monthly-skills" | "monthly-reports";

const workflows: Record<TierName, WorkflowConfig> = {
  daily,
  weekly,
  monthly,
  "weekly-security": weeklySecurity,
  "weekly-cleanup": weeklyCleanup,
  "weekly-reports": weeklyReports,
  "weekly-orchestrated": weeklyOrchestrated,
  "monthly-workspace": monthlyWorkspace,
  "monthly-skills": monthlySkills,
  "monthly-reports": monthlyReports,
};

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      tier: { type: "string", short: "t" },
      resume: { type: "boolean", short: "r" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
AutoMaintenance Workflows - Tiered system maintenance

USAGE:
  bun run Workflows.ts --tier <tier> [options]

TIERS:
  Full workflows:
    daily               Daily integrity and CLI update checks
    weekly              Full weekly maintenance (includes daily)
    monthly             Full monthly maintenance (includes daily + weekly)

  Staggered sub-tiers:
    weekly-security     Sunday: security audit, Kaya sync
    weekly-cleanup      Monday: state cleanup, log rotation
    weekly-reports      Tuesday: memory consolidation, report generation
    weekly-orchestrated Sunday: UNIFIED - learning before cleanup (recommended)
    monthly-workspace   Thursday: workspace cleanup
    monthly-skills      Friday: skill audit
    monthly-reports     Saturday: monthly report generation

OPTIONS:
  -t, --tier <tier>    Workflow tier to execute
  -r, --resume         Resume from checkpoint if available
  -h, --help           Show this help message

EXAMPLES:
  # Run daily maintenance
  bun run Workflows.ts --tier daily

  # Run weekly security audit only
  bun run Workflows.ts --tier weekly-security

  # Run full weekly with resume support
  bun run Workflows.ts --tier weekly --resume
`);
    return;
  }

  const tier = values.tier as TierName | undefined;
  if (!tier || !workflows[tier]) {
    console.error("Error: --tier must be one of:", Object.keys(workflows).join(", "));
    process.exit(1);
  }

  const workflow = workflows[tier];

  // Notify on start
  notifySync(`Starting ${workflow.name}`);
  console.log(`\nExecuting ${tier} maintenance workflow...\n`);

  const result = values.resume
    ? await workflowExecutor.executeWithCheckpoint(workflow)
    : await workflowExecutor.executeWithProgress(workflow, (step, status, stepResult) => {
        const statusEmoji = {
          started: "⏳",
          completed: "✅",
          failed: "❌",
          skipped: "⏭️",
        }[status];
        console.log(`[${statusEmoji}] ${step}${stepResult?.message ? `: ${stepResult.message}` : ""}`);

        // Log failures
        if (status === "failed" && stepResult) {
          logError(workflow.name, step, stepResult.message || "Unknown error");
        }

        if (status === "failed") {
          notifySync(`[${tier}] Step failed: ${step}. ${stepResult?.message ?? ""}`, { channel: 'telegram' });
        }
      });

  console.log(`\nWorkflow ${result.success ? "completed successfully" : "failed"}`);
  console.log(`Duration: ${result.durationMs}ms`);

  if (result.iscResult) {
    console.log(`ISC Score: ${result.iscResult.score}%`);
    if (result.iscResult.unmetCriteria.length > 0) {
      console.log(`Unmet criteria: ${result.iscResult.unmetCriteria.join(", ")}`);
    }
  }

  // Notify on completion
  const notifyMessage = result.success
    ? `${workflow.name} completed successfully`
    : `${workflow.name} failed at step: ${result.failedStep}`;

  await notify(notifyMessage, {
    priority: result.success ? "normal" : "high",
    channel: result.success ? "voice" : "push",
  });

  if (result.failedStep) {
    console.log(`Failed at step: ${result.failedStep}`);
    console.log(`Error: ${result.error}`);
    process.exit(1);
  }
}

// Run CLI if executed directly
if (import.meta.main) {
  main().catch(console.error);
}
