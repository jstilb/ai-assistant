#!/usr/bin/env bun
/**
 * FeedbackManager - Pattern-based corrective feedback for agents
 *
 * Detects error patterns, tool inefficiencies, and decision quality issues
 * in trace data, then generates structured feedback messages appended to
 * each agent's feedback file for optional consumption.
 *
 * Usage:
 *   import { createFeedbackManager } from './FeedbackManager.ts';
 *   const manager = createFeedbackManager();
 *   const feedback = manager.analyze(agentId, traces);
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AgentTrace } from './TraceCollector.ts';
import { auditLog } from './AuditLogger.ts';

// ============================================================================
// Types
// ============================================================================

type FeedbackCategory =
  | 'error_recovery'
  | 'tool_efficiency'
  | 'decision_quality'
  | 'compliance'
  | 'resource_optimization';

interface FeedbackMessage {
  timestamp: number;
  feedbackId: string;
  category: FeedbackCategory;
  severity: 'info' | 'warning';
  agentId: string;
  pattern: string;
  suggestion: string;
  evidence: Record<string, unknown>;
}

interface FeedbackManagerConfig {
  /** Min consecutive errors of same type before generating feedback */
  errorPatternThreshold: number;
  /** Min redundant tool calls before efficiency feedback */
  toolRedundancyThreshold: number;
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

const KAYA_HOME = join(homedir(), '.claude');
const FEEDBACK_DIR = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'feedback');

const DEFAULT_CONFIG: FeedbackManagerConfig = {
  errorPatternThreshold: 5,
  toolRedundancyThreshold: 8,
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
    category: 'error_recovery',
    pattern: 'consecutive_file_errors',
    detect(traces) {
      const errors = traces.filter(t => t.eventType === 'error');
      const fileErrors = errors.filter(t =>
        (t.metadata.errorMessage || '').includes('not found') ||
        (t.metadata.errorMessage || '').includes('ENOENT') ||
        (t.metadata.errorMessage || '').includes('FileNotFound')
      );
      if (fileErrors.length >= 3) {
        return {
          match: true,
          evidence: {
            errorType: 'FileNotFoundError',
            occurrences: fileErrors.length,
            files: fileErrors.map(e => e.metadata.errorMessage).slice(-5),
          },
        };
      }
      return null;
    },
    suggest: () => 'Before calling ReadFile, verify file exists with Glob or ls to avoid FileNotFound errors.',
  },
  {
    category: 'error_recovery',
    pattern: 'consecutive_errors_same_type',
    detect(traces) {
      const errors = traces.filter(t => t.eventType === 'error');
      if (errors.length < 5) return null;
      const recent = errors.slice(-5);
      const types = recent.map(e => (e.metadata.errorMessage || '').split(':')[0]);
      const allSame = types.every(t => t === types[0]);
      if (allSame) {
        return {
          match: true,
          evidence: {
            errorType: types[0],
            occurrences: recent.length,
            messages: recent.map(e => e.metadata.errorMessage).slice(-3),
          },
        };
      }
      return null;
    },
    suggest: (evidence) => `Detected ${evidence.occurrences} consecutive "${evidence.errorType}" errors. Consider a different approach or checking preconditions before retrying.`,
  },
  {
    category: 'tool_efficiency',
    pattern: 'redundant_read_calls',
    detect(traces) {
      const reads = traces.filter(t => t.eventType === 'tool_call' && t.metadata.toolName === 'Read');
      if (reads.length < 5) return null;
      const fileCounts = new Map<string, number>();
      for (const r of reads) {
        const file = String(r.metadata.args?.file_path || 'unknown');
        fileCounts.set(file, (fileCounts.get(file) || 0) + 1);
      }
      const redundant = Array.from(fileCounts.entries()).filter(([, count]) => count >= 3);
      if (redundant.length > 0) {
        return {
          match: true,
          evidence: {
            redundantFiles: redundant.map(([file, count]) => ({ file, count })),
            totalReads: reads.length,
          },
        };
      }
      return null;
    },
    suggest: (evidence) => {
      const files = (evidence.redundantFiles as { file: string; count: number }[]);
      return `File "${files[0]?.file}" read ${files[0]?.count} times. Cache the content in memory instead of re-reading.`;
    },
  },
  {
    category: 'tool_efficiency',
    pattern: 'excessive_glob_patterns',
    detect(traces) {
      const globs = traces.filter(t => t.eventType === 'tool_call' && t.metadata.toolName === 'Glob');
      if (globs.length < 8) return null;
      return {
        match: true,
        evidence: {
          globCount: globs.length,
          patterns: globs.map(g => g.metadata.args?.pattern).slice(-5),
        },
      };
    },
    suggest: () => 'High number of Glob calls detected. Consider using the Explore agent for broad codebase searches instead of sequential Glob patterns.',
  },
  {
    category: 'resource_optimization',
    pattern: 'high_token_usage',
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
    suggest: (evidence) => `Total token usage is ${evidence.totalTokens}. Consider breaking the task into smaller sub-tasks or using the haiku model for simpler operations.`,
  },
  {
    category: 'compliance',
    pattern: 'missing_validation',
    detect(traces) {
      const writes = traces.filter(t =>
        t.eventType === 'tool_call' &&
        (t.metadata.toolName === 'Write' || t.metadata.toolName === 'Edit')
      );
      const reads = traces.filter(t =>
        t.eventType === 'tool_call' && t.metadata.toolName === 'Read'
      );
      // Check if writes happen without preceding reads
      if (writes.length > 3 && reads.length === 0) {
        return {
          match: true,
          evidence: { writeCount: writes.length, readCount: reads.length },
        };
      }
      return null;
    },
    suggest: () => 'Multiple file writes detected without any preceding reads. Kaya convention requires reading files before modifying them.',
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
        if (!result || !result.match) continue;

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
          severity: template.category === 'compliance' ? 'warning' : 'info',
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
        const path = feedbackFilePath(message.agentId);
        appendFileSync(path, JSON.stringify(message) + '\n', 'utf-8');

        auditLog({
          action: 'feedback_delivered',
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
          action: 'feedback_delivery_failed',
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

      const content = readFileSync(path, 'utf-8').trim();
      if (!content) return [];

      const lines = content.split('\n');
      const messages: FeedbackMessage[] = [];
      const start = Math.max(0, lines.length - limit);

      for (let i = start; i < lines.length; i++) {
        try {
          messages.push(JSON.parse(lines[i]));
        } catch {
          // Skip malformed lines
        }
      }

      return messages;
    },

    getFeedbackStats(): Record<string, { total: number; byCategory: Record<string, number> }> {
      ensureDir(FEEDBACK_DIR);
      const stats: Record<string, { total: number; byCategory: Record<string, number> }> = {};

      try {
        const { readdirSync } = require('fs');
        const files = readdirSync(FEEDBACK_DIR).filter((f: string) => f.endsWith('.jsonl'));

        for (const file of files) {
          const agentId = file.replace('.jsonl', '');
          const content = readFileSync(join(FEEDBACK_DIR, file), 'utf-8').trim();
          if (!content) continue;

          const lines = content.split('\n');
          const byCategory: Record<string, number> = {};

          for (const line of lines) {
            try {
              const msg: FeedbackMessage = JSON.parse(line);
              byCategory[msg.category] = (byCategory[msg.category] || 0) + 1;
            } catch {
              // Skip
            }
          }

          stats[agentId] = {
            total: lines.length,
            byCategory,
          };
        }
      } catch {
        // Feedback dir might not exist
      }

      return stats;
    },
  };
}
