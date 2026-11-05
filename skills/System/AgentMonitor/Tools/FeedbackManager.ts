#!/usr/bin/env bun
/**
 * FeedbackManager - Pattern-based corrective feedback for agents
 *
 * Detects error patterns and resource-use issues
 * in trace data, then generates structured feedback messages appended to
 * each agent's feedback file for optional consumption.
 *
 * Usage:
 *   import { createFeedbackManager } from './FeedbackManager.ts';
 *   const manager = createFeedbackManager();
 *   const feedback = manager.analyze(agentId, traces);
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTrace } from "./TraceCollector.ts";
import { auditLog } from "./AuditLogger.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { createAppendLog, type AppendLog } from "../../../../lib/core/AppendLog.ts";

// ============================================================================
// Types
// ============================================================================

export type FeedbackCategory =
  | "error_recovery"
  | "tool_efficiency"
  | "decision_quality"
  | "compliance"
  | "resource_optimization";

interface FeedbackMessage {
  timestamp: number;
  feedbackId: string;
  category: FeedbackCategory;
  severity: "info" | "warning";
  agentId: string;
  pattern: string;
  suggestion: string;
  evidence: Record<string, unknown>;
}

interface FeedbackManagerConfig {
  /** Min consecutive errors of same type before generating feedback */
  errorPatternThreshold: number;
  /** Cooldown between same feedback category (ms) */
  feedbackCooldownMs: number;
  /** Max feedback messages per agent per hour */
  maxFeedbackPerHour: number;
}

interface FeedbackResult {
  delivered: FeedbackMessage[];
  suppressed: number;
  reason?: string;
}

interface FeedbackManager {
  analyze(agentId: string, traces: AgentTrace[]): FeedbackResult;
  deliverFeedback(message: FeedbackMessage): boolean;
  getRecentFeedback(agentId: string, limit?: number): FeedbackMessage[];
  getFeedbackStats(): Record<string, { total: number; byCategory: Record<string, number> }>;
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = getKayaHome();
const FEEDBACK_DIR = join(KAYA_HOME, "MEMORY", "MONITORING", "feedback");

const DEFAULT_CONFIG: FeedbackManagerConfig = {
  errorPatternThreshold: 5,
  feedbackCooldownMs: 300000,
  maxFeedbackPerHour: 10,
};

// ============================================================================
// Feedback Templates
// ============================================================================

interface FeedbackTemplate {
  category: FeedbackCategory;
  pattern: string;
  detect: (traces: AgentTrace[]) => { match: boolean; evidence: Record<string, unknown> } | null;
  suggest: (evidence: Record<string, unknown>) => string;
}

const TEMPLATES: FeedbackTemplate[] = [
  {
    category: "error_recovery",
    pattern: "consecutive_file_errors",
    detect(traces) {
      const errors = traces.filter((t) => t.eventType === "error");
      const fileErrors = errors.filter(
        (t) =>
          (t.metadata.errorMessage || "").includes("not found") ||
          (t.metadata.errorMessage || "").includes("ENOENT") ||
          (t.metadata.errorMessage || "").includes("FileNotFound"),
      );
      if (fileErrors.length >= 3) {
        return {
          match: true,
          evidence: {
            errorType: "FileNotFoundError",
            occurrences: fileErrors.length,
            files: fileErrors.map((e) => e.metadata.errorMessage).slice(-5),
          },
        };
      }
      return null;
    },
    suggest: () => "Before calling ReadFile, verify file exists with Glob or ls to avoid FileNotFound errors.",
  },
  {
    category: "error_recovery",
    pattern: "consecutive_errors_same_type",
    detect(traces) {
      const errors = traces.filter((t) => t.eventType === "error");
      if (errors.length < 5) return null;
      const recent = errors.slice(-5);
      const types = recent.map((e) => (e.metadata.errorMessage || "").split(":")[0]);
      const allSame = types.every((t) => t === types[0]);
      if (allSame) {
        return {
          match: true,
          evidence: {
            errorType: types[0],
            occurrences: recent.length,
            messages: recent.map((e) => e.metadata.errorMessage).slice(-3),
          },
        };
      }
      return null;
    },
    suggest: (evidence) =>
      `Detected ${evidence.occurrences} consecutive "${evidence.errorType}" errors. Consider a different approach or checking preconditions before retrying.`,
  },
  {
    category: "resource_optimization",
    pattern: "high_token_usage",
    detect(traces) {
      const totalTokens = traces.reduce((sum, t) => sum + (t.metadata.tokensUsed || 0), 0);
      if (totalTokens > 200000) {
        return {
          match: true,
          evidence: { totalTokens, traceCount: traces.length },
        };
      }
      return null;
    },
    suggest: (evidence) =>
      `Total token usage is ${evidence.totalTokens}. Consider breaking the task into smaller sub-tasks or using the haiku model for simpler operations.`,
  },
];

// ============================================================================
// Implementation
// ============================================================================

let feedbackCounter = 0;

function generateFeedbackId(): string {
  return `fb_${Date.now()}_${++feedbackCounter}`;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function feedbackFilePath(agentId: string): string {
  return join(FEEDBACK_DIR, `${agentId}.jsonl`);
}

// ISC AppendLog seam: one path per agentId, instances cached and reused.
const feedbackLogs = new Map<string, AppendLog>();
function getFeedbackLog(agentId: string): AppendLog {
  let log = feedbackLogs.get(agentId);
  if (!log) {
    log = createAppendLog(feedbackFilePath(agentId));
    feedbackLogs.set(agentId, log);
  }
  return log;
}

export function createFeedbackManager(config?: Partial<FeedbackManagerConfig>): FeedbackManager {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Track cooldowns per agent per category
  const lastFeedback = new Map<string, number>();
  // Track hourly counts per agent
  const hourlyCount = new Map<string, { count: number; resetAt: number }>();

  function checkCooldown(agentId: string, category: FeedbackCategory): boolean {
    const key = `${agentId}:${category}`;
    const last = lastFeedback.get(key);
    if (last && Date.now() - last < cfg.feedbackCooldownMs) {
      return false;
    }
    return true;
  }

  function checkHourlyLimit(agentId: string): boolean {
    const now = Date.now();
    const entry = hourlyCount.get(agentId);
    if (!entry || now > entry.resetAt) {
      hourlyCount.set(agentId, { count: 0, resetAt: now + 3600000 });
      return true;
    }
    return entry.count < cfg.maxFeedbackPerHour;
  }

  function recordFeedback(agentId: string, category: FeedbackCategory): void {
    const key = `${agentId}:${category}`;
    lastFeedback.set(key, Date.now());
    const entry = hourlyCount.get(agentId);
    if (entry) entry.count++;
  }

  return {
    analyze(agentId: string, traces: AgentTrace[]): FeedbackResult {
      const delivered: FeedbackMessage[] = [];
      let suppressed = 0;

      for (const template of TEMPLATES) {
        const result = template.detect(traces);
        if (!result?.match) continue;

        // Check cooldown
        if (!checkCooldown(agentId, template.category)) {
          suppressed++;
          continue;
        }

        // Check hourly limit
        if (!checkHourlyLimit(agentId)) {
          suppressed++;
          continue;
        }

        const message: FeedbackMessage = {
          timestamp: Date.now(),
          feedbackId: generateFeedbackId(),
          category: template.category,
          severity: template.category === "compliance" ? "warning" : "info",
          agentId,
          pattern: template.pattern,
          suggestion: template.suggest(result.evidence),
          evidence: result.evidence,
        };

        if (this.deliverFeedback(message)) {
          delivered.push(message);
          recordFeedback(agentId, template.category);
        }
      }

      return { delivered, suppressed };
    },

    deliverFeedback(message: FeedbackMessage): boolean {
      ensureDir(FEEDBACK_DIR);

      try {
        getFeedbackLog(message.agentId).append(message);

        auditLog({
          action: "feedback_delivered",
          details: {
            feedbackId: message.feedbackId,
            agentId: message.agentId,
            category: message.category,
            pattern: message.pattern,
          },
          success: true,
        });

        return true;
      } catch (err) {
        auditLog({
          action: "feedback_delivery_failed",
          details: { agentId: message.agentId, error: String(err) },
          success: false,
          errorMessage: String(err),
        });
        return false;
      }
    },

    getRecentFeedback(agentId: string, limit: number = 20): FeedbackMessage[] {
      const path = feedbackFilePath(agentId);
      if (!existsSync(path)) return [];

      const content = readFileSync(path, "utf-8").trim();
      if (!content) return [];

      const lines = content.split("\n");
      const messages: FeedbackMessage[] = [];
      const start = Math.max(0, lines.length - limit);

      for (let i = start; i < lines.length; i++) {
        try {
          messages.push(JSON.parse(lines[i] ?? ""));
        } catch {
          // intentionally silent: torn or partial JSONL line
        }
      }

      return messages;
    },

    getFeedbackStats(): Record<string, { total: number; byCategory: Record<string, number> }> {
      ensureDir(FEEDBACK_DIR);
      const stats: Record<string, { total: number; byCategory: Record<string, number> }> = {};

      try {
        const { readdirSync } = require("node:fs");
        const files = readdirSync(FEEDBACK_DIR).filter((f: string) => f.endsWith(".jsonl"));

        for (const file of files) {
          const agentId = file.replace(".jsonl", "");
          const content = readFileSync(join(FEEDBACK_DIR, file), "utf-8").trim();
          if (!content) continue;

          const lines = content.split("\n");
          const byCategory: Record<string, number> = {};

          for (const line of lines) {
            try {
              const msg: FeedbackMessage = JSON.parse(line);
              byCategory[msg.category] = (byCategory[msg.category] || 0) + 1;
            } catch {
              // intentionally silent: torn or partial JSONL line
            }
          }

          stats[agentId] = {
            total: lines.length,
            byCategory,
          };
        }
      } catch {
        // intentionally silent: feedback dir not created yet
      }

      return stats;
    },
  };
}
