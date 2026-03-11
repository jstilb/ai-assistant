#!/usr/bin/env bun
/**
 * InterventionAuditor - Immutable intervention audit trail
 *
 * Logs all intervention actions to append-only JSONL, validates
 * log integrity, provides query interface and daily summaries.
 *
 * Usage:
 *   import { createInterventionAuditor } from './InterventionAuditor.ts';
 *   const auditor = createInterventionAuditor();
 *   auditor.logIntervention(entry);
 *   const results = auditor.query({ type: 'pause', date: '2026-02-05' });
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

// ============================================================================
// Types
// ============================================================================

export interface InterventionAuditEntry {
  interventionId: string;
  timestamp: number;
  workflowId: string;
  agentId?: string;
  type: 'pause' | 'throttle' | 'feedback' | 'resume' | 'emergency_stop';
  trigger: {
    anomaly?: string;
    severity?: 'warning' | 'critical';
    evidence?: Record<string, unknown>;
  };
  policy?: string;
  approval?: {
    required: boolean;
    status: 'pending' | 'approved' | 'denied' | 'timeout' | 'snoozed';
    approvedBy?: string;
    approvedAt?: number;
    decision?: string;
  };
  execution: {
    status: 'pending' | 'executing' | 'completed' | 'failed' | 'dry_run';
    startedAt?: number;
    completedAt?: number;
    error?: string;
  };
  outcome: {
    success: boolean;
    message: string;
    effectDuration?: number;
    rollback?: boolean;
  };
}

interface AuditQueryOptions {
  workflowId?: string;
  type?: InterventionAuditEntry['type'];
  date?: string;
  approved?: 'yes' | 'no' | 'all';
  limit?: number;
}

interface DailySummary {
  date: string;
  totalInterventions: number;
  byType: Record<string, number>;
  byWorkflow: Record<string, number>;
  approvalRate: number;
  successRate: number;
  avgResponseTimeMs: number;
}

interface InterventionAuditor {
  logIntervention(entry: InterventionAuditEntry): void;
  query(options: AuditQueryOptions): InterventionAuditEntry[];
  generateDailySummary(date?: string): DailySummary;
  validateIntegrity(): { valid: boolean; errors: string[] };
  getStats(): { total: number; byType: Record<string, number>; approvalRate: number };
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = join(homedir(), '.claude');
const AUDIT_DIR = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'audit');
const INTERVENTIONS_LOG = join(AUDIT_DIR, 'interventions.jsonl');
const SUMMARY_DIR = join(AUDIT_DIR, 'intervention-summary');
const INTEGRITY_FILE = join(AUDIT_DIR, 'interventions.sha256');

// ============================================================================
// Implementation
// ============================================================================

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function readAllEntries(): InterventionAuditEntry[] {
  if (!existsSync(INTERVENTIONS_LOG)) return [];

  const content = readFileSync(INTERVENTIONS_LOG, 'utf-8').trim();
  if (!content) return [];

  const entries: InterventionAuditEntry[] = [];
  for (const line of content.split('\n')) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

function dateStr(timestamp?: number): string {
  const d = timestamp ? new Date(timestamp) : new Date();
  return d.toISOString().split('T')[0];
}

export function createInterventionAuditor(): InterventionAuditor {
  return {
    logIntervention(entry: InterventionAuditEntry): void {
      ensureDir(AUDIT_DIR);

      const line = JSON.stringify(entry);
      appendFileSync(INTERVENTIONS_LOG, line + '\n', 'utf-8');

      // Update integrity hash
      const currentContent = existsSync(INTERVENTIONS_LOG)
        ? readFileSync(INTERVENTIONS_LOG, 'utf-8')
        : '';
      const hash = computeHash(currentContent);
      writeFileSync(INTEGRITY_FILE, hash, 'utf-8');
    },

    query(options: AuditQueryOptions): InterventionAuditEntry[] {
      let entries = readAllEntries();

      if (options.workflowId) {
        entries = entries.filter(e => e.workflowId === options.workflowId);
      }

      if (options.type) {
        entries = entries.filter(e => e.type === options.type);
      }

      if (options.date) {
        entries = entries.filter(e => dateStr(e.timestamp) === options.date);
      }

      if (options.approved === 'yes') {
        entries = entries.filter(e => e.approval?.status === 'approved');
      } else if (options.approved === 'no') {
        entries = entries.filter(e => e.approval?.status === 'denied' || e.approval?.status === 'timeout');
      }

      if (options.limit) {
        entries = entries.slice(-options.limit);
      }

      return entries;
    },

    generateDailySummary(date?: string): DailySummary {
      const targetDate = date || dateStr();
      const entries = readAllEntries().filter(e => dateStr(e.timestamp) === targetDate);

      const byType: Record<string, number> = {};
      const byWorkflow: Record<string, number> = {};
      let approvedCount = 0;
      let successCount = 0;
      let totalResponseTime = 0;
      let responseTimeCount = 0;

      for (const entry of entries) {
        byType[entry.type] = (byType[entry.type] || 0) + 1;
        byWorkflow[entry.workflowId] = (byWorkflow[entry.workflowId] || 0) + 1;

        if (entry.approval?.status === 'approved') approvedCount++;
        if (entry.outcome.success) successCount++;

        if (entry.approval?.approvedAt && entry.timestamp) {
          totalResponseTime += entry.approval.approvedAt - entry.timestamp;
          responseTimeCount++;
        }
      }

      const summary: DailySummary = {
        date: targetDate,
        totalInterventions: entries.length,
        byType,
        byWorkflow,
        approvalRate: entries.length > 0 ? approvedCount / entries.length : 0,
        successRate: entries.length > 0 ? successCount / entries.length : 0,
        avgResponseTimeMs: responseTimeCount > 0 ? totalResponseTime / responseTimeCount : 0,
      };

      // Save summary files
      ensureDir(SUMMARY_DIR);
      writeFileSync(join(SUMMARY_DIR, `${targetDate}.json`), JSON.stringify(summary, null, 2));

      const markdown = generateSummaryMarkdown(summary);
      writeFileSync(join(SUMMARY_DIR, `${targetDate}.md`), markdown);

      return summary;
    },

    validateIntegrity(): { valid: boolean; errors: string[] } {
      const errors: string[] = [];

      if (!existsSync(INTERVENTIONS_LOG)) {
        return { valid: true, errors: [] };
      }

      // Check hash
      if (existsSync(INTEGRITY_FILE)) {
        const storedHash = readFileSync(INTEGRITY_FILE, 'utf-8').trim();
        const currentContent = readFileSync(INTERVENTIONS_LOG, 'utf-8');
        const currentHash = computeHash(currentContent);

        if (storedHash !== currentHash) {
          errors.push(`Integrity check failed: stored hash ${storedHash.slice(0, 12)}... != current ${currentHash.slice(0, 12)}...`);
        }
      } else {
        errors.push('No integrity hash file found — cannot verify audit log');
      }

      // Check entry ordering (timestamps should be monotonically increasing)
      const entries = readAllEntries();
      for (let i = 1; i < entries.length; i++) {
        if (entries[i].timestamp < entries[i - 1].timestamp) {
          errors.push(`Out-of-order entry at index ${i}: ${entries[i].timestamp} < ${entries[i - 1].timestamp}`);
        }
      }

      // Check required fields
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (!e.interventionId) errors.push(`Entry ${i}: missing interventionId`);
        if (!e.timestamp) errors.push(`Entry ${i}: missing timestamp`);
        if (!e.workflowId) errors.push(`Entry ${i}: missing workflowId`);
        if (!e.type) errors.push(`Entry ${i}: missing type`);
        if (!e.execution) errors.push(`Entry ${i}: missing execution`);
        if (!e.outcome) errors.push(`Entry ${i}: missing outcome`);
      }

      return { valid: errors.length === 0, errors };
    },

    getStats(): { total: number; byType: Record<string, number>; approvalRate: number } {
      const entries = readAllEntries();
      const byType: Record<string, number> = {};
      let approvedCount = 0;

      for (const entry of entries) {
        byType[entry.type] = (byType[entry.type] || 0) + 1;
        if (entry.approval?.status === 'approved') approvedCount++;
      }

      return {
        total: entries.length,
        byType,
        approvalRate: entries.length > 0 ? approvedCount / entries.length : 0,
      };
    },
  };
}

// ============================================================================
// Markdown Report
// ============================================================================

function generateSummaryMarkdown(summary: DailySummary): string {
  const lines: string[] = [
    `# Intervention Summary — ${summary.date}`,
    '',
    `**Total Interventions:** ${summary.totalInterventions}`,
    `**Approval Rate:** ${(summary.approvalRate * 100).toFixed(1)}%`,
    `**Success Rate:** ${(summary.successRate * 100).toFixed(1)}%`,
    `**Avg Response Time:** ${(summary.avgResponseTimeMs / 1000).toFixed(1)}s`,
    '',
    '## By Type',
    '',
    '| Type | Count |',
    '|------|-------|',
  ];

  for (const [type, count] of Object.entries(summary.byType)) {
    lines.push(`| ${type} | ${count} |`);
  }

  lines.push('', '## By Workflow', '', '| Workflow | Count |', '|----------|-------|');
  for (const [wf, count] of Object.entries(summary.byWorkflow)) {
    lines.push(`| ${wf} | ${count} |`);
  }

  lines.push('');
  return lines.join('\n');
}

// ============================================================================
// CLI
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const auditor = createInterventionAuditor();

  if (args[0] === 'query') {
    const getArg = (name: string): string | undefined => {
      const idx = args.indexOf(name);
      return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
    };

    const results = auditor.query({
      workflowId: getArg('--workflow'),
      type: getArg('--type') as InterventionAuditEntry['type'] | undefined,
      date: getArg('--date'),
      approved: getArg('--approved') as 'yes' | 'no' | 'all' | undefined,
      limit: getArg('--limit') ? parseInt(getArg('--limit')!) : undefined,
    });

    if (args.includes('--json')) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log(`\nIntervention Audit — ${results.length} results\n`);
      console.log('| ID | Type | Workflow | Status | Outcome |');
      console.log('|----|------|----------|--------|---------|');
      for (const e of results) {
        console.log(`| ${e.interventionId.slice(0, 12)} | ${e.type} | ${e.workflowId.slice(0, 20)} | ${e.execution.status} | ${e.outcome.success ? 'OK' : 'FAIL'} |`);
      }
    }
  } else if (args[0] === 'summary') {
    const date = args[1];
    const summary = auditor.generateDailySummary(date);
    console.log(JSON.stringify(summary, null, 2));
  } else if (args[0] === 'validate') {
    const result = auditor.validateIntegrity();
    if (result.valid) {
      console.log('Audit log integrity: VALID');
    } else {
      console.log('Audit log integrity: INVALID');
      for (const err of result.errors) {
        console.log(`  - ${err}`);
      }
    }
  } else if (args[0] === 'stats') {
    const stats = auditor.getStats();
    console.log(JSON.stringify(stats, null, 2));
  } else {
    console.log('Usage: InterventionAuditor.ts <query|summary|validate|stats> [options]');
  }
}
