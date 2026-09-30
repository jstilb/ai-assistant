#!/usr/bin/env bun
/**
 * IssueLearningBridge — feed issue-trace patterns into AgentMetacognition
 *
 * Mines the issue subgraph (see IssueTracer) for development-health patterns and
 * feeds them into the AgentMetacognition skill through BOTH of its real intake
 * channels:
 *
 *   1. MemoryStore insights  — `capture({ type: 'insight', ... })`. This is the
 *      exact contract the former Graph/ContinualLearningBridge used (deleted 2026-07-10); it is the
 *      established graph → AgentMetacognition path.
 *
 *   2. SIGNALS ledger        — appends a RawSignal to
 *      `MEMORY/LEARNING/SIGNALS/dev-issues.jsonl`. The file is durable raw
 *      data for LLM review (the deterministic wisdom-frame synthesis that
 *      consumed it was deleted 2026-07-09). Signals are emitted with
 *      source:'explicit' so they always pass the SignalQualityGate.
 *
 * Patterns detected:
 *   - recurring_issue       same issue (normalized title) reported 3+ times
 *   - issue_prone_file      a file accumulating 3+ issues
 *   - slow_resolution       resolved issues whose time-to-resolve exceeded a budget
 *   - stale_open_issue      high/critical issues open longer than the budget
 *   - regression            a file with a NEW issue opened after a prior resolution
 *   - unresolved_backlog    too many open high/critical issues right now
 *
 * Usage:
 *   bun IssueLearningBridge.ts --synthesize            Detect + feed AgentMetacognition
 *   bun IssueLearningBridge.ts --synthesize --json     JSON output
 *   bun IssueLearningBridge.ts --synthesize --since 30d Only consider issues since
 *   bun IssueLearningBridge.ts --synthesize --dry-run  Detect only, no writes
 *
 * @module IssueTrace/IssueLearningBridge
 * @version 1.0.0
 */

import { join } from 'path';
import { parseArgs } from 'util';
// cross-skill-allowed: IssueTrace writes issue/learning nodes into the knowledge graph by design
import { GraphPersistence, getGraphPersistence } from '../../Graph/Tools/GraphPersistence';
import { createMemoryStore, type MemoryStore } from '../../../../lib/core/MemoryStore';
import { getKayaHome } from '../../../../lib/core/KayaHome.ts';
// cross-skill-allowed: bridges issue outcomes into AgentMetacognition's signal ledger by design
import { SignalLedger } from '../../../Productivity/AgentMetacognition/Tools/SignalLedger';
import { IssueTracer, type IssueTrace, type IssueSeverity } from './IssueTracer';

// ============================================
// CONFIG
// ============================================

/** Default signal file for dev-issue signals under MEMORY/LEARNING/SIGNALS/. */
export const DEV_ISSUES_SIGNAL_FILE = 'dev-issues.jsonl';

const SLOW_RESOLUTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const STALE_OPEN_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const RECURRENCE_THRESHOLD = 3;
const FILE_ISSUE_THRESHOLD = 3;
const BACKLOG_THRESHOLD = 5;

// ============================================
// TYPES
// ============================================

export type IssuePatternType =
  | 'recurring_issue'
  | 'issue_prone_file'
  | 'slow_resolution'
  | 'stale_open_issue'
  | 'regression'
  | 'unresolved_backlog';

export interface IssueInsight {
  type: IssuePatternType;
  title: string;
  description: string;
  evidence: string[];
  severity: 'low' | 'medium' | 'high';
  tags: string[];
}

export interface SynthesisResult {
  patternsFound: number;
  captured: number;
  signalsEmitted: number;
  patternTypes: IssuePatternType[];
  insights: IssueInsight[];
}

// ============================================
// BRIDGE
// ============================================

export class IssueLearningBridge {
  private persistence: GraphPersistence;
  private memoryStore: MemoryStore;
  private signalsDir: string;
  private tracer: IssueTracer;

  constructor(opts?: { persistence?: GraphPersistence; memoryStore?: MemoryStore; signalsDir?: string }) {
    this.persistence = opts?.persistence || getGraphPersistence();
    this.memoryStore = opts?.memoryStore || createMemoryStore();
    this.signalsDir = opts?.signalsDir || join(getKayaHome(), 'MEMORY', 'LEARNING', 'SIGNALS');
    this.tracer = new IssueTracer(this.persistence);
  }

  /**
   * Detect issue patterns and feed them into AgentMetacognition.
   */
  async synthesize(opts?: { since?: string; dryRun?: boolean }): Promise<SynthesisResult> {
    const traces = this.tracer.listIssues(opts?.since ? { since: opts.since } : {});

    const insights: IssueInsight[] = [
      ...this.detectRecurringIssues(traces),
      ...this.detectIssueProneFiles(traces),
      ...this.detectSlowResolutions(traces),
      ...this.detectStaleOpenIssues(traces),
      ...this.detectRegressions(traces),
      ...this.detectUnresolvedBacklog(traces),
    ];

    let captured = 0;
    let signalsEmitted = 0;

    if (!opts?.dryRun) {
      const ledger = new SignalLedger(this.signalsDir);
      for (const insight of insights) {
        // Channel 1: MemoryStore insight (graph → AgentMetacognition contract)
        try {
          await this.memoryStore.capture({
            type: 'insight',
            category: insight.type,
            title: insight.title,
            content: this.formatInsight(insight),
            tags: ['graph', 'issue-trace', 'pattern', ...insight.tags],
            tier: 'warm',
            source: 'Intelligence/IssueTrace',
            metadata: {
              patternType: insight.type,
              severity: insight.severity,
              evidenceCount: insight.evidence.length,
            },
          });
          captured++;
        } catch (err) {
          console.error(`Failed to capture insight "${insight.title}": ${err}`);
        }

        // Channel 2: SIGNALS ledger (AgentMetacognition synthesis cursor pipeline)
        try {
          const signal = await ledger.append(
            {
              rating: this.insightToRating(insight),
              source: 'explicit', // always qualifies — dev-health signal, not a session rating
              sentiment_summary: this.insightToSummary(insight),
              session_id: 'issue-trace',
              timestamp: new Date().toISOString(),
              patternType: insight.type,
              severity: insight.severity,
            },
            DEV_ISSUES_SIGNAL_FILE,
          );
          if (signal) signalsEmitted++;
        } catch (err) {
          console.error(`Failed to emit signal for "${insight.title}": ${err}`);
        }
      }
    }

    return {
      patternsFound: insights.length,
      captured,
      signalsEmitted,
      patternTypes: [...new Set(insights.map(i => i.type))],
      insights,
    };
  }

  // ============================================
  // DETECTORS
  // ============================================

  /** Same issue (normalized title) reported 3+ times. */
  private detectRecurringIssues(traces: IssueTrace[]): IssueInsight[] {
    const out: IssueInsight[] = [];
    const clusters = new Map<string, IssueTrace[]>();
    for (const t of traces) {
      const key = normalizeTitle(t.issue.title);
      const arr = clusters.get(key) ?? [];
      arr.push(t);
      clusters.set(key, arr);
    }
    for (const [, group] of clusters) {
      if (group.length >= RECURRENCE_THRESHOLD) {
        const unresolved = group.filter(t => t.status !== 'resolved').length;
        out.push({
          type: 'recurring_issue',
          title: `Recurring issue: ${group[0].issue.title.slice(0, 70)}`,
          description: `This bug pattern has been reported ${group.length} times (${unresolved} still open). A durable fix or guardrail is likely needed rather than repeated patching.`,
          evidence: group.map(t => `${t.issue.id} [${t.status}]`),
          severity: group.length >= 5 ? 'high' : 'medium',
          tags: ['recurring-error', 'bug'],
        });
      }
    }
    return out;
  }

  /** A file accumulating 3+ issues. */
  private detectIssueProneFiles(traces: IssueTrace[]): IssueInsight[] {
    const out: IssueInsight[] = [];
    const byFile = new Map<string, IssueTrace[]>();
    for (const t of traces) {
      const file = t.issue.metadata.file as string | null;
      if (!file) continue;
      const arr = byFile.get(file) ?? [];
      arr.push(t);
      byFile.set(file, arr);
    }
    for (const [file, group] of byFile) {
      if (group.length >= FILE_ISSUE_THRESHOLD) {
        out.push({
          type: 'issue_prone_file',
          title: `Issue-prone file: ${file}`,
          description: `${file} has accumulated ${group.length} tracked issues. Consider adding tests, refactoring, or tightening its interface.`,
          evidence: group.map(t => `${t.issue.id}: ${t.issue.title.slice(0, 60)}`),
          severity: group.length >= 5 ? 'high' : 'medium',
          tags: ['error-prone', 'file-quality', 'bug'],
        });
      }
    }
    return out;
  }

  /** Resolved issues that took longer than the resolution budget. */
  private detectSlowResolutions(traces: IssueTrace[]): IssueInsight[] {
    const slow = traces.filter(
      t => t.status === 'resolved' && t.timeToResolveMs != null && t.timeToResolveMs > SLOW_RESOLUTION_MS,
    );
    if (slow.length === 0) return [];
    return [{
      type: 'slow_resolution',
      title: `Slow resolutions: ${slow.length} issue(s) over ${Math.round(SLOW_RESOLUTION_MS / 86400000)}d to fix`,
      description: `${slow.length} resolved issues exceeded the ${Math.round(SLOW_RESOLUTION_MS / 86400000)}-day resolution budget. Long fix latency often signals missing repro tooling or unclear ownership.`,
      evidence: slow.map(t => `${t.issue.id}: ${Math.round((t.timeToResolveMs ?? 0) / 86400000)}d`),
      severity: slow.length >= 3 ? 'high' : 'medium',
      tags: ['slow-fix', 'process'],
    }];
  }

  /** High/critical issues that have been open too long. */
  private detectStaleOpenIssues(traces: IssueTrace[]): IssueInsight[] {
    const now = Date.now();
    const stale = traces.filter(t => {
      if (t.status === 'resolved') return false;
      const sev = t.severity;
      if (sev !== 'high' && sev !== 'critical') return false;
      return now - new Date(t.openedAt).getTime() > STALE_OPEN_MS;
    });
    if (stale.length === 0) return [];
    return [{
      type: 'stale_open_issue',
      title: `Stale high-severity issues: ${stale.length} open > ${Math.round(STALE_OPEN_MS / 86400000)}d`,
      description: `${stale.length} high/critical issues have been open beyond ${Math.round(STALE_OPEN_MS / 86400000)} days without resolution. These are the most likely sources of compounding risk.`,
      evidence: stale.map(t => `${t.issue.id} [${t.severity}] opened ${t.openedAt.slice(0, 10)}`),
      severity: 'high',
      tags: ['stale', 'risk'],
    }];
  }

  /** A file with a new issue opened after an earlier resolution → regression loop. */
  private detectRegressions(traces: IssueTrace[]): IssueInsight[] {
    const out: IssueInsight[] = [];
    const byFile = new Map<string, IssueTrace[]>();
    for (const t of traces) {
      const file = t.issue.metadata.file as string | null;
      if (!file) continue;
      const arr = byFile.get(file) ?? [];
      arr.push(t);
      byFile.set(file, arr);
    }
    for (const [file, group] of byFile) {
      const resolved = group.filter(t => t.status === 'resolved' && t.resolvedAt);
      if (resolved.length === 0) continue;
      // >= not >: a reopen can land in the same millisecond as the resolution.
      // The resolving trace itself is excluded so it can't self-flag when an
      // issue is opened and resolved within one millisecond.
      const earliest = resolved.reduce(
        (min, t) => {
          const ts = new Date(t.resolvedAt as string).getTime();
          return ts < min.ts ? { ts, id: t.issue.id } : min;
        },
        { ts: Infinity, id: "" },
      );
      const reopened = group.filter(
        t => t.issue.id !== earliest.id && new Date(t.openedAt).getTime() >= earliest.ts,
      );
      if (reopened.length > 0) {
        out.push({
          type: 'regression',
          title: `Regression loop: ${file}`,
          description: `${file} had ${reopened.length} new issue(s) opened after a prior fix. The earlier resolution may have been incomplete or lacked a regression test.`,
          evidence: reopened.map(t => `${t.issue.id}: ${t.issue.title.slice(0, 60)}`),
          severity: reopened.length >= 2 ? 'high' : 'medium',
          tags: ['regression', 'bug', 'missing-test'],
        });
      }
    }
    return out;
  }

  /** Too many open high/critical issues right now. */
  private detectUnresolvedBacklog(traces: IssueTrace[]): IssueInsight[] {
    const openSevere = traces.filter(
      t => t.status !== 'resolved' && (t.severity === 'high' || t.severity === 'critical'),
    );
    if (openSevere.length < BACKLOG_THRESHOLD) return [];
    return [{
      type: 'unresolved_backlog',
      title: `High-severity backlog: ${openSevere.length} open`,
      description: `${openSevere.length} high/critical issues are currently unresolved (threshold ${BACKLOG_THRESHOLD}). Backlog growth at this severity tends to slow everything else down.`,
      evidence: openSevere.map(t => `${t.issue.id} [${t.severity}]`),
      severity: 'high',
      tags: ['backlog', 'risk'],
    }];
  }

  // ============================================
  // FORMAT / SIGNAL MAPPING
  // ============================================

  private formatInsight(insight: IssueInsight): string {
    let c = `## ${insight.title}\n\n`;
    c += `**Type:** ${insight.type}\n**Severity:** ${insight.severity}\n\n`;
    c += `${insight.description}\n\n### Evidence\n`;
    for (const e of insight.evidence.slice(0, 10)) c += `- ${e}\n`;
    if (insight.evidence.length > 10) c += `- ... and ${insight.evidence.length - 10} more\n`;
    return c;
  }

  /** Map insight severity to a 1-10 rating (lower = more frustration). */
  private insightToRating(insight: IssueInsight): number {
    return insight.severity === 'high' ? 2 : insight.severity === 'medium' ? 3 : 4;
  }

  /** Build a keyword-rich summary so downstream readers can categorize it. */
  private insightToSummary(insight: IssueInsight): string {
    return `Recurring development issue (${insight.type}): ${insight.title}. ${insight.description}`;
  }
}

/** Map an issue severity to a signal rating (exposed for callers/tests). */
export function severityToRating(severity: IssueSeverity): number {
  switch (severity) {
    case 'critical': return 1;
    case 'high': return 2;
    case 'medium': return 3;
    case 'low': return 4;
  }
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\d+/g, 'N')
    .replace(/[`'"]/g, '')
    .replace(/\/[\w\-.\/]+/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 70);
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      synthesize: { type: 'boolean' },
      json: { type: 'boolean' },
      since: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help || !values.synthesize) {
    console.log(`IssueLearningBridge — feed issue-trace patterns into AgentMetacognition

Usage:
  bun IssueLearningBridge.ts --synthesize            Detect patterns + feed AgentMetacognition
  bun IssueLearningBridge.ts --synthesize --json     JSON output
  bun IssueLearningBridge.ts --synthesize --since 30d Only issues opened since
  bun IssueLearningBridge.ts --synthesize --dry-run  Detect only (no writes)
`);
    process.exit(0);
  }

  const bridge = new IssueLearningBridge();
  const result = await bridge.synthesize({
    since: values.since,
    dryRun: values['dry-run'],
  });

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('IssueLearningBridge');
    console.log('===================\n');
    console.log(`Patterns found:      ${result.patternsFound}`);
    console.log(`Insights captured:   ${result.captured}`);
    console.log(`Signals emitted:     ${result.signalsEmitted}`);
    if (result.patternTypes.length) console.log(`Pattern types:       ${result.patternTypes.join(', ')}`);
    for (const i of result.insights) console.log(`  [${i.severity}] ${i.title}`);
  }
}
