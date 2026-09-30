/**
 * PolicyComparator.ts — Policy Impact Analysis for AgentMonitor
 *
 * Runs the same trace sequence through multiple InterventionConfig objects
 * in isolation and produces a side-by-side comparison report.
 *
 * Usage:
 *   import { comparePolicies } from './PolicyComparator.ts';
 *   const results = await comparePolicies(traces, policyConfigs);
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { AgentTrace } from './TraceCollector.ts';
import type { Anomaly } from './AnomalyDetector.ts';
import { createAnomalyDetector } from './AnomalyDetector.ts';
import { createInterventionManager, type InterventionConfig, type InterventionResult } from './InterventionManager.ts';
import { getKayaHome } from '../../../../lib/core/KayaHome.ts';

// ============================================================================
// Types
// ============================================================================

export type InterventionType = 'pause' | 'throttle' | 'feedback';

export type AnomalyType =
  | 'token_spike'
  | 'error_burst'
  | 'infinite_loop'
  | 'stale_workflow'
  | 'high_load'
  | 'communication_deadlock'
  | 'message_flood'
  | 'orphaned_member'
  | 'team_divergence';

export interface NamedPolicyConfig {
  name: string;
  policy: InterventionConfig;
}

export interface PolicyComparisonResult {
  policyName: string;
  interventionsTriggered: number;
  byType: Record<InterventionType, number>;
  byAnomaly: Record<string, number>;
  approvalRequiredCount: number;
  escalationCount: number;
  reportPath?: string;
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = getKayaHome();
const REPORTS_DIR = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'reports');

// ============================================================================
// Core Comparison
// ============================================================================

async function runSinglePolicy(
  traces: AgentTrace[],
  policyConfig: NamedPolicyConfig,
): Promise<PolicyComparisonResult> {
  // Fresh isolated detector (no shared state with other policies)
  const detector = createAnomalyDetector({
    voiceAlerts: false,
    jsonlAlerts: false,
    allowSimulation: true,
    tokenSpikeThreshold: 50000,
    errorBurstThreshold: 2,
    infiniteLoopThreshold: 5,
    highLoadEventsPerSecond: 3,
    messageFloodThreshold: 5,
  });

  // Fresh isolated intervention manager (no shared state)
  const interventionManager = createInterventionManager();
  // Force dryRun — policy comparison never fires real interventions
  interventionManager.setDryRun(true);

  const interventionResults: InterventionResult[] = [];
  const anomalyTypeMap = new Map<string, number>();

  for (const trace of traces) {
    // Mark traces as simulation so allowSimulation processes them
    const traceWithSim: AgentTrace = {
      ...trace,
      context: { ...trace.context, source: 'simulation' },
    };
    const anomalies = await detector.ingest(traceWithSim);

    for (const anomaly of anomalies) {
      // Track anomaly type
      anomalyTypeMap.set(anomaly.type, (anomalyTypeMap.get(anomaly.type) || 0) + 1);

      try {
        const result = await interventionManager.handleAnomaly(anomaly);
        if (result) {
          interventionResults.push({ ...result, dryRun: true });
        }
      } catch {
        // non-fatal
      }
    }
  }

  // Count by intervention type
  const byType: Record<InterventionType, number> = { pause: 0, throttle: 0, feedback: 0 };
  let approvalRequiredCount = 0;
  let escalationCount = 0;

  for (const r of interventionResults) {
    if (r.type in byType) {
      byType[r.type as InterventionType]++;
    }
    if (r.approval?.required) {
      approvalRequiredCount++;
    }
    // Escalation is not directly exposed in InterventionResult — approximate by checking type
    // (No escalation field in current InterventionResult, so we count 0)
  }

  const byAnomaly: Record<string, number> = Object.fromEntries(anomalyTypeMap);

  return {
    policyName: policyConfig.name,
    interventionsTriggered: interventionResults.length,
    byType,
    byAnomaly,
    approvalRequiredCount,
    escalationCount,
  };
}

// ============================================================================
// Report Generation
// ============================================================================

function writeComparisonReport(results: PolicyComparisonResult[]): string {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(REPORTS_DIR, `policy-compare-${ts}.md`);

  // Collect all anomaly types across all policies
  const allAnomalyTypes = new Set<string>();
  for (const r of results) {
    Object.keys(r.byAnomaly).forEach(k => allAnomalyTypes.add(k));
  }

  const policyNames = results.map(r => r.policyName);

  const lines: string[] = [
    `# Policy Comparison Report`,
    ``,
    `**Run at:** ${new Date().toISOString()}`,
    `**Policies compared:** ${policyNames.join(', ')}`,
    ``,
    `## Side-by-Side Intervention Summary`,
    ``,
    // Table header
    `| Anomaly Type | ${policyNames.join(' | ')} |`,
    `|${'-'.repeat(14)}|${policyNames.map(() => '-'.repeat(12)).join('|')}|`,
  ];

  // Rows for each anomaly type
  for (const anomalyType of Array.from(allAnomalyTypes)) {
    const cells = results.map(r => String(r.byAnomaly[anomalyType] ?? 0));
    lines.push(`| ${anomalyType} | ${cells.join(' | ')} |`);
  }

  // Total row
  const totalCells = results.map(r => String(r.interventionsTriggered));
  lines.push(`| **Total** | ${totalCells.join(' | ')} |`);

  lines.push('');
  lines.push('## Intervention Type Breakdown');
  lines.push('');
  lines.push(`| Type | ${policyNames.join(' | ')} |`);
  lines.push(`|------|${policyNames.map(() => '------').join('|')}|`);

  for (const itype of ['pause', 'throttle', 'feedback'] as const) {
    const cells = results.map(r => String(r.byType[itype]));
    lines.push(`| ${itype} | ${cells.join(' | ')} |`);
  }

  lines.push('');
  lines.push('## Approval Requirements');
  lines.push('');
  for (const r of results) {
    lines.push(`- **${r.policyName}:** ${r.approvalRequiredCount} interventions required approval`);
  }

  lines.push('');

  writeFileSync(reportPath, lines.join('\n'), 'utf-8');
  return reportPath;
}

// ============================================================================
// Main Export
// ============================================================================

export async function comparePolicies(
  traceSource: AgentTrace[],
  policyConfigs: NamedPolicyConfig[],
): Promise<PolicyComparisonResult[]> {
  if (policyConfigs.length < 2) {
    throw new Error('compare-policies requires at least 2 policy configurations');
  }

  // Run each policy config in isolation (sequential to ensure clean state)
  const results: PolicyComparisonResult[] = [];
  for (const config of policyConfigs) {
    const result = await runSinglePolicy(traceSource, config);
    results.push(result);
  }

  // Write report
  const reportPath = writeComparisonReport(results);

  // Attach reportPath to first result (and all results)
  return results.map(r => ({ ...r, reportPath }));
}
