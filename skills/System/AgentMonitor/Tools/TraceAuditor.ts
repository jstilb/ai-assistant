#!/usr/bin/env bun
/**
 * TraceAuditor - LLM-powered root cause analysis for failed agent workflows
 *
 * When a workflow scores < 70 (the passing threshold), this tool runs an LLM
 * judge on the full trace to produce a structured root-cause analysis.
 * Pattern: rule-based evaluators at 100%, LLM audit on failures only.
 *
 * @module AgentMonitor/TraceAuditor
 * @version 1.0.0
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parseArgs } from 'util';
import { execSync } from 'child_process';
import { getTracesForWorkflow, getAllTraceFiles } from './TraceCollector';
import { loadEvaluation, type PipelineResult } from './EvaluatorPipeline';
import { emitInsight } from '../../../../lib/core/SkillIntegrationBridge';
import type { AgentTrace } from './TraceCollector';

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = join(homedir(), '.claude');
const AUDITS_DIR = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'audits');
const EVALUATIONS_DIR = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'evaluations');
const INFERENCE_TOOL = join(KAYA_HOME, 'tools', 'Inference.ts');

// ============================================================================
// Types
// ============================================================================

interface TraceAudit {
  workflowId: string;
  overallScore: number;
  rootCause: string;
  failureCategory: 'tool_misuse' | 'infinite_loop' | 'error_cascade' | 'wrong_approach' | 'resource_waste' | 'unknown';
  decisionErrors: Array<{
    timestamp: number;
    description: string;
    betterAlternative: string;
  }>;
  graphContext?: {
    relatedSessions: string[];
    relatedFiles: string[];
    similarFailures: string[];
  };
  confidence: number;
}

// ============================================================================
// Trace Summary Builder
// ============================================================================

function buildTraceSummary(traces: AgentTrace[]): string {
  if (traces.length === 0) return 'No trace events found.';

  const lines: string[] = [];
  lines.push(`Total events: ${traces.length}`);

  const startTime = traces[0].timestamp;
  const endTime = traces[traces.length - 1].timestamp;
  lines.push(`Duration: ${((endTime - startTime) / 1000).toFixed(1)}s`);

  // Event type breakdown
  const eventCounts: Record<string, number> = {};
  for (const t of traces) {
    eventCounts[t.eventType] = (eventCounts[t.eventType] || 0) + 1;
  }
  lines.push(`Event types: ${Object.entries(eventCounts).map(([k, v]) => `${k}(${v})`).join(', ')}`);

  // Token usage
  const totalTokens = traces.reduce((s, t) => s + (t.metadata.tokensUsed || 0), 0);
  lines.push(`Total tokens: ${totalTokens}`);

  // Tool call chain
  const toolCalls = traces
    .filter(t => t.eventType === 'tool_call')
    .map(t => t.metadata.toolName || 'unknown');
  if (toolCalls.length > 0) {
    lines.push(`Tool chain: ${toolCalls.join(' -> ')}`);
  }

  // Errors
  const errors = traces.filter(t => t.eventType === 'error');
  if (errors.length > 0) {
    lines.push(`\nErrors (${errors.length}):`);
    for (const err of errors.slice(0, 5)) {
      lines.push(`  - ${err.metadata.errorMessage || 'Unknown error'}`);
    }
  }

  // ISC completion rates
  const iscRates = traces
    .filter(t => t.metadata.iscCompletionRate !== undefined)
    .map(t => t.metadata.iscCompletionRate!);
  if (iscRates.length > 0) {
    const avgIsc = iscRates.reduce((s, r) => s + r, 0) / iscRates.length;
    lines.push(`Avg ISC completion: ${(avgIsc * 100).toFixed(1)}%`);
  }

  // Timing gaps (pauses > 30s between events)
  const gaps: Array<{ afterEvent: number; durationSec: number }> = [];
  for (let i = 1; i < traces.length; i++) {
    const gap = (traces[i].timestamp - traces[i - 1].timestamp) / 1000;
    if (gap > 30) {
      gaps.push({ afterEvent: i - 1, durationSec: Math.round(gap) });
    }
  }
  if (gaps.length > 0) {
    lines.push(`\nTiming gaps > 30s: ${gaps.length}`);
    for (const g of gaps.slice(0, 3)) {
      lines.push(`  - ${g.durationSec}s pause after event #${g.afterEvent}`);
    }
  }

  return lines.join('\n');
}

// ============================================================================
// LLM Audit
// ============================================================================

async function runLLMAudit(
  workflowId: string,
  traceSummary: string,
  evaluation: PipelineResult | null,
): Promise<TraceAudit> {
  const evalContext = evaluation
    ? `\nEvaluation score: ${evaluation.overallScore}/100 (${evaluation.overallPassed ? 'PASSED' : 'FAILED'})
Evaluator findings:
${evaluation.allFindings.slice(0, 10).map(f => `- [${f.severity}] ${f.category}: ${f.message}`).join('\n')}`
    : '\nNo evaluation data available.';

  const prompt = `Analyze this agent workflow trace and identify the root cause of failure.

WORKFLOW: ${workflowId}

TRACE SUMMARY:
${traceSummary}
${evalContext}

Respond with a JSON object (no markdown, no code fences, just raw JSON) with this exact structure:
{
  "rootCause": "1-2 sentence root cause description",
  "failureCategory": "one of: tool_misuse, infinite_loop, error_cascade, wrong_approach, resource_waste, unknown",
  "decisionErrors": [
    {
      "timestamp": 0,
      "description": "what went wrong",
      "betterAlternative": "what should have been done"
    }
  ],
  "confidence": 0.0
}

Rules:
- Grade OUTCOMES and DECISIONS, not reasoning style
- failureCategory must be exactly one of the enum values
- confidence is 0.0-1.0
- Keep decisionErrors to max 3 entries
- Focus on actionable root causes`;

  try {
    const result = execSync(
      `echo ${JSON.stringify(prompt)} | bun "${INFERENCE_TOOL}" standard`,
      { encoding: 'utf-8', timeout: 60000, maxBuffer: 1024 * 1024 },
    );

    // Extract JSON from response
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return createFallbackAudit(workflowId, evaluation?.overallScore || 0);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      workflowId,
      overallScore: evaluation?.overallScore || 0,
      rootCause: parsed.rootCause || 'Unable to determine root cause',
      failureCategory: validateCategory(parsed.failureCategory),
      decisionErrors: Array.isArray(parsed.decisionErrors) ? parsed.decisionErrors.slice(0, 3) : [],
      confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
    };
  } catch (err) {
    console.error(`LLM audit failed: ${err}`);
    return createFallbackAudit(workflowId, evaluation?.overallScore || 0);
  }
}

function validateCategory(cat: string): TraceAudit['failureCategory'] {
  const valid: TraceAudit['failureCategory'][] = [
    'tool_misuse', 'infinite_loop', 'error_cascade', 'wrong_approach', 'resource_waste', 'unknown',
  ];
  return valid.includes(cat as TraceAudit['failureCategory']) ? cat as TraceAudit['failureCategory'] : 'unknown';
}

function createFallbackAudit(workflowId: string, score: number): TraceAudit {
  return {
    workflowId,
    overallScore: score,
    rootCause: 'LLM audit failed — manual review required',
    failureCategory: 'unknown',
    decisionErrors: [],
    confidence: 0,
  };
}

// ============================================================================
// Graph Context Enrichment (Phase 3A)
// ============================================================================

async function enrichWithGraphContext(audit: TraceAudit): Promise<TraceAudit> {
  try {
    const { getGraphPersistence } = await import('../../../Intelligence/Graph/Tools/GraphPersistence');
    const persistence = getGraphPersistence();
    const engine = persistence.loadIntoEngine();

    const traceId = `agent_trace:${audit.workflowId}`;
    if (!engine.hasNode(traceId)) return audit;

    // Backward trace: what session/commit/file led to this trace?
    const backward = engine.traceBackward(traceId, 3);
    const relatedSessions = backward
      .filter(r => r.node.type === 'session')
      .map(r => r.node.title)
      .slice(0, 5);

    // Files touched by this trace
    const forward = engine.traceForward(traceId, 1, ['modifies']);
    const relatedFiles = forward
      .filter(r => r.node.type === 'file')
      .map(r => r.node.title)
      .slice(0, 10);

    // Find other agent_traces with same failure category
    const otherTraces = engine.findNodes({ type: 'agent_trace', tags: [audit.failureCategory] });
    const similarFailures = otherTraces
      .filter(n => n.id !== traceId)
      .map(n => `${n.title} (${n.metadata.evaluationScore || '?'}/100)`)
      .slice(0, 5);

    // Find other traces touching the same files
    if (relatedFiles.length > 0) {
      for (const fileResult of forward.filter(r => r.node.type === 'file')) {
        const otherTracesForFile = engine.traceBackward(fileResult.node.id, 1, ['modifies']);
        for (const ot of otherTracesForFile) {
          if (ot.node.type === 'agent_trace' && ot.node.id !== traceId) {
            const failInfo = `${ot.node.title} (touches ${fileResult.node.title})`;
            if (!similarFailures.includes(failInfo)) {
              similarFailures.push(failInfo);
            }
          }
        }
      }
    }

    audit.graphContext = {
      relatedSessions: relatedSessions.slice(0, 5),
      relatedFiles: relatedFiles.slice(0, 10),
      similarFailures: similarFailures.slice(0, 5),
    };
  } catch (err) {
    console.error(`Graph enrichment failed (non-fatal): ${err}`);
  }

  return audit;
}

// ============================================================================
// Main Audit Function
// ============================================================================

export async function auditTrace(
  workflowId: string,
  evaluation?: PipelineResult | null,
): Promise<TraceAudit> {
  const traces = getTracesForWorkflow(workflowId);
  const evalData = evaluation ?? loadEvaluation(workflowId);

  const traceSummary = buildTraceSummary(traces);
  let audit = await runLLMAudit(workflowId, traceSummary, evalData);

  // Enrich with graph context
  audit = await enrichWithGraphContext(audit);

  // Save audit to disk
  if (!existsSync(AUDITS_DIR)) {
    mkdirSync(AUDITS_DIR, { recursive: true });
  }
  const auditPath = join(AUDITS_DIR, `${workflowId}-audit.json`);
  writeFileSync(auditPath, JSON.stringify(audit, null, 2), 'utf-8');

  // Emit insight
  emitInsight({
    source: 'AgentMonitor',
    type: 'learning',
    category: 'trace-audit',
    title: `Trace audit: ${workflowId} — ${audit.failureCategory}`,
    content: `Root cause: ${audit.rootCause}\nScore: ${audit.overallScore}/100\nCategory: ${audit.failureCategory}\nConfidence: ${audit.confidence}`,
    tags: ['agent-monitor', 'trace-audit', audit.failureCategory, workflowId],
    tier: 'warm',
    metadata: {
      workflowId,
      overallScore: audit.overallScore,
      failureCategory: audit.failureCategory,
      confidence: audit.confidence,
      decisionErrorCount: audit.decisionErrors.length,
      hasGraphContext: !!audit.graphContext,
    },
  });

  return audit;
}

export function loadAudit(workflowId: string): TraceAudit | null {
  const auditPath = join(AUDITS_DIR, `${workflowId}-audit.json`);
  if (!existsSync(auditPath)) return null;
  try {
    return JSON.parse(readFileSync(auditPath, 'utf-8'));
  } catch {
    return null;
  }
}

// ============================================================================
// Batch Mode
// ============================================================================

async function batchAudit(sinceHours: number): Promise<{ audited: number; skipped: number; errors: number }> {
  const sinceMs = Date.now() - sinceHours * 60 * 60 * 1000;
  let audited = 0, skipped = 0, errors = 0;

  if (!existsSync(EVALUATIONS_DIR)) return { audited, skipped, errors };

  const evalFiles = readdirSync(EVALUATIONS_DIR)
    .filter(f => f.endsWith('-eval.json'));

  for (const file of evalFiles) {
    try {
      const evalPath = join(EVALUATIONS_DIR, file);
      const evaluation: PipelineResult = JSON.parse(readFileSync(evalPath, 'utf-8'));

      // Skip if evaluation is too old
      if (evaluation.timestamp < sinceMs) {
        skipped++;
        continue;
      }

      // Skip if score >= 70 (passing)
      if (evaluation.overallScore >= 70) {
        skipped++;
        continue;
      }

      // Skip if already audited
      const workflowId = file.replace('-eval.json', '');
      const auditPath = join(AUDITS_DIR, `${workflowId}-audit.json`);
      if (existsSync(auditPath)) {
        skipped++;
        continue;
      }

      console.log(`Auditing ${workflowId} (score: ${evaluation.overallScore})...`);
      await auditTrace(workflowId, evaluation);
      audited++;
    } catch (err) {
      console.error(`Error auditing ${file}: ${err}`);
      errors++;
    }
  }

  return { audited, skipped, errors };
}

// ============================================================================
// CLI
// ============================================================================

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      workflow: { type: 'string' },
      batch: { type: 'boolean' },
      since: { type: 'string', default: '24h' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(`
TraceAuditor - LLM-powered root cause analysis for failed agent workflows

Usage:
  bun TraceAuditor.ts --workflow <id>              Audit a specific workflow
  bun TraceAuditor.ts --workflow <id> --json       Output as JSON
  bun TraceAuditor.ts --batch --since 24h          Audit all failed evaluations from last 24h
  bun TraceAuditor.ts --help                       Show help
`);
    process.exit(0);
  }

  if (values.batch) {
    const sinceMatch = (values.since || '24h').match(/^(\d+)h$/);
    const sinceHours = sinceMatch ? parseInt(sinceMatch[1]) : 24;

    console.log(`TraceAuditor - Batch Mode (since ${sinceHours}h ago)`);
    console.log('='.repeat(50));

    const result = await batchAudit(sinceHours);
    console.log(`\nResults: ${result.audited} audited, ${result.skipped} skipped, ${result.errors} errors`);
  } else if (values.workflow) {
    const audit = await auditTrace(values.workflow);

    if (values.json) {
      console.log(JSON.stringify(audit, null, 2));
    } else {
      console.log('TraceAuditor');
      console.log('============\n');
      console.log(`Workflow: ${audit.workflowId}`);
      console.log(`Score: ${audit.overallScore}/100`);
      console.log(`Root Cause: ${audit.rootCause}`);
      console.log(`Category: ${audit.failureCategory}`);
      console.log(`Confidence: ${(audit.confidence * 100).toFixed(0)}%`);

      if (audit.decisionErrors.length > 0) {
        console.log(`\nDecision Errors (${audit.decisionErrors.length}):`);
        for (const err of audit.decisionErrors) {
          console.log(`  - ${err.description}`);
          console.log(`    Better: ${err.betterAlternative}`);
        }
      }

      if (audit.graphContext) {
        console.log('\nGraph Context:');
        if (audit.graphContext.relatedSessions.length > 0) {
          console.log(`  Sessions: ${audit.graphContext.relatedSessions.join(', ')}`);
        }
        if (audit.graphContext.relatedFiles.length > 0) {
          console.log(`  Files: ${audit.graphContext.relatedFiles.join(', ')}`);
        }
        if (audit.graphContext.similarFailures.length > 0) {
          console.log(`  Similar failures: ${audit.graphContext.similarFailures.join(', ')}`);
        }
      }
    }
  } else {
    console.log('Use --workflow <id> or --batch. Use --help for more info.');
  }
}
