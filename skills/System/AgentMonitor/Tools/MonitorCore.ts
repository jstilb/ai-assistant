#!/usr/bin/env bun
/**
 * MonitorCore - Main CLI entry point for AgentMonitor
 *
 * evals-rebuild slice C2: the Phase-1 batch-evaluation pipeline (evaluate,
 * evaluate-all, retro commands; ErrorRateEvaluator/DecisionQualityEvaluator/
 * ResourceEfficiencyEvaluator/LatencyEvaluator/ComplianceEvaluator;
 * EvaluatorPipeline.ts; ReportGenerator.ts) is DELETED. ErrorRate and
 * DecisionQuality signal now live as Evals UseCases (see
 * skills/Intelligence/Evals/UseCases/AgentTraces/), run nightly via the
 * kaya-pipeline-nightly suite. ResourceEfficiency/Latency/Compliance had no
 * real signal (inputs structurally empty across the live trace corpus) and
 * are gone with no replacement. This file now orchestrates trace
 * collection + Phase 2 live monitoring only.
 *
 * CLI Usage:
 *   bun run MonitorCore.ts status
 *   bun run MonitorCore.ts watch [--no-dashboard] [--quiet]
 *   bun run MonitorCore.ts query --workflow <id> [--live]
 */

import { existsSync, readFileSync } from 'fs';
import { z } from 'zod';
import { getTracesForWorkflow, getAllTraceFiles, computeTraceStats, parseTraceLine } from './TraceCollector.ts';
import type { AgentTrace } from './TraceCollector.ts';
import { getBaselineSummary } from './BaselineManager.ts';
import { getRecentAlerts, ackAll } from './AlertManager.ts';
import { auditLog, getAuditStats } from './AuditLogger.ts';
import { startStreamingPipeline } from './StreamingPipeline.ts';
import { createApprovalManager } from './ApprovalManager.ts';
import { createInterventionManager, type InterventionConfig } from './InterventionManager.ts';
import { runThresholdReplay, selectTraceFilesByDateRange } from './ReplayEngine.ts';
import { injectScenario, type ScenarioType, type PipelineMode } from './SyntheticInjector.ts';
import { comparePolicies } from './PolicyComparator.ts';
import { resolveStaleAnomalies } from './AnomalyDetector.ts';

// ============================================================================
// Policy Config Loader with Zod validation (ISC 606, 607)
// ============================================================================

const PolicyConfigEntrySchema = z.object({
  name: z.string(),
  policy: z.record(z.string(), z.unknown()),
});

const PolicyConfigsSchema = z.array(PolicyConfigEntrySchema).min(2, 'compare-policies requires at least 2 configs');

function loadPolicyConfigs(filePath: string): Array<{ name: string; policy: unknown }> {
  if (!existsSync(filePath)) {
    throw new Error(`configs file does not exist: ${filePath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`configs file is not valid JSON: ${msg}`);
  }
  return PolicyConfigsSchema.parse(raw);
}

// ============================================================================
// Commands
// ============================================================================

async function showStatus(): Promise<void> {
  console.log('\nAgentMonitor Status');
  console.log('='.repeat(50));

  // Trace files
  const traceFiles = getAllTraceFiles();
  console.log(`\nTrace Files: ${traceFiles.length}`);
  if (traceFiles.length > 0) {
    console.log(`  Most recent: ${traceFiles.slice(0, 5).join(', ')}`);
  }

  // Baselines
  console.log('');
  console.log(await getBaselineSummary());

  // Recent alerts
  const alerts = getRecentAlerts(5);
  if (alerts.length > 0) {
    console.log('\nRecent Alerts:');
    for (const alert of alerts) {
      const time = new Date(alert.timestamp).toISOString().replace('T', ' ').slice(0, 19);
      console.log(`  [${alert.severity.toUpperCase()}] ${time} - ${alert.message.slice(0, 60)}`);
    }
  }

  // Audit stats
  const auditStats = getAuditStats();
  console.log(`\nAudit: ${auditStats.totalEvents} events, ${auditStats.errorCount} errors`);
}

// ============================================================================
// Phase 2: Live Monitoring Commands
// ============================================================================

async function watchLive(noDashboard: boolean, quiet: boolean): Promise<void> {
  if (!quiet) {
    console.log('\nStarting live agent monitoring...');
    console.log('Press Ctrl+C to stop.\n');
  }

  const pipeline = startStreamingPipeline({
    dashboard: !noDashboard,
    quiet,
    onAnomaly: (anomaly) => {
      if (!quiet && noDashboard) {
        const time = new Date(anomaly.detectedAt).toISOString().slice(11, 19);
        console.log(`[${time}] [${anomaly.severity.toUpperCase()}] ${anomaly.type}: ${anomaly.message}`);
      }
    },
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    pipeline.stop();
    const stats = pipeline.getStats();
    console.log('\n');
    console.log('Live monitoring stopped.');
    console.log(`  Traces processed: ${stats.tracesProcessed}`);
    console.log(`  Anomalies detected: ${stats.anomaliesDetected}`);
    console.log(`  Active workflows: ${stats.activeWorkflows}`);
    console.log(`  Uptime: ${((stats.uptimeMs) / 1000 / 60).toFixed(1)} minutes`);
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
}

async function queryWorkflow(workflowId: string, live: boolean): Promise<void> {
  console.log(`\nQuerying workflow: ${workflowId}`);
  console.log('='.repeat(50));

  // Historical data
  const traces = getTracesForWorkflow(workflowId);
  if (traces.length === 0 && !live) {
    console.error(`No traces found for workflow "${workflowId}"`);
    process.exit(1);
  }

  if (traces.length > 0) {
    const stats = computeTraceStats(traces);
    console.log('\nTrace Statistics:');
    console.log(`  Total traces: ${stats.totalTraces}`);
    console.log(`  Unique agents: ${stats.uniqueAgents}`);
    console.log(`  Event types: ${JSON.stringify(stats.eventTypeCounts)}`);
    if (stats.timeRange) {
      const durationMs = stats.timeRange.end - stats.timeRange.start;
      console.log(`  Duration: ${(durationMs / 1000).toFixed(1)}s`);
      console.log(`  Start: ${new Date(stats.timeRange.start).toISOString()}`);
      console.log(`  End: ${new Date(stats.timeRange.end).toISOString()}`);
    }

    // Recent tool calls
    const toolCalls = traces.filter(t => t.eventType === 'tool_call');
    if (toolCalls.length > 0) {
      const toolCounts = new Map<string, number>();
      for (const tc of toolCalls) {
        const name = tc.metadata.toolName || 'unknown';
        toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
      }
      console.log('\nTool Call Distribution:');
      const sorted = Array.from(toolCounts.entries()).sort((a, b) => b[1] - a[1]);
      for (const [name, count] of sorted.slice(0, 10)) {
        const bar = '='.repeat(Math.min(count, 30));
        console.log(`  ${name.padEnd(20)} ${count.toString().padStart(4)} ${bar}`);
      }
    }

    // Errors
    const errors = traces.filter(t => t.eventType === 'error');
    if (errors.length > 0) {
      console.log(`\nErrors (${errors.length}):`);
      for (const e of errors.slice(-5)) {
        const time = new Date(e.timestamp).toISOString().slice(11, 19);
        console.log(`  [${time}] ${e.metadata.errorMessage?.slice(0, 70) || 'Unknown error'}`);
      }
    }
  }

  if (live) {
    console.log('\nWatching for live updates... (Ctrl+C to stop)');
    const pipeline = startStreamingPipeline({
      dashboard: false,
      quiet: true,
      onTrace: (trace) => {
        if (trace.workflowId === workflowId) {
          const time = new Date(trace.timestamp).toISOString().slice(11, 19);
          const detail = trace.eventType === 'tool_call'
            ? `tool=${trace.metadata.toolName || 'unknown'}`
            : trace.eventType === 'error'
              ? `err=${trace.metadata.errorMessage?.slice(0, 40) || ''}`
              : '';
          console.log(`  [${time}] ${trace.eventType.padEnd(12)} ${trace.agentId.padEnd(15)} ${detail}`);
        }
      },
    });

    process.on('SIGINT', () => {
      pipeline.stop();
      process.exit(0);
    });

    await new Promise(() => {});
  }
}

// ============================================================================
// CLI Router
// ============================================================================

function printUsage(): void {
  console.log(`
AgentMonitor - Agent Workflow Monitoring & Evaluation (v3.0.0)

Usage:
  bun run MonitorCore.ts <command> [options]

Commands:
  status         Show monitoring status
  watch          Start live monitoring with real-time dashboard
  query          Query workflow data (historical + live)
  intervene      Manual intervention controls (approve/deny/list/emergency-stop/dry-run)
  resolve-stale-anomalies  Resolve anomalies older than 30 days or test workflows older than 7 days
  ack            Acknowledge alerts (requires --all flag)
  replay         Threshold replay engine (what-if anomaly detection)
  inject         Inject a synthetic scenario for testing
  compare-policies  Compare intervention policies against the same trace window

Options:
  watch:
    --no-dashboard      Run without terminal dashboard (log mode)
    --quiet             Suppress all console output

  query:
    --workflow <id>     Workflow identifier (required)
    --live              Also watch for live updates

  intervene:
    approve <id>        Approve pending intervention
    deny <id> [reason]  Deny pending intervention
    list-pending        List pending interventions
    emergency-stop      Emergency stop all interventions
    dry-run [on|off]    Toggle dry-run mode
  replay:
    --trace <file>      Single .jsonl trace file (or use --from/--to)
    --from <YYYY-MM-DD> Start date for trace file selection
    --to <YYYY-MM-DD>   End date for trace file selection
    --thresholds <file> JSON file with partial AnomalyDetectorConfig (required)
    --anomaly-filter <type> Restrict output to one anomaly type
  inject:
    --scenario <type>   Scenario type (token_spike|error_burst|infinite_loop|message_flood|communication_deadlock|team_divergence|orphaned_member|high_load)
    --pipeline <mode>   Pipeline mode: live or offline (default: offline)
    --count <n>         Number of synthetic traces (default: 20, max: 500)
  compare-policies:
    --trace <file>      Single .jsonl trace file (or use --from/--to)
    --from <YYYY-MM-DD> Start date for trace file selection
    --to <YYYY-MM-DD>   End date for trace file selection
    --configs <file>    JSON file with array of { name, policy } objects (required, min 2)

Examples:
  bun run MonitorCore.ts status
  bun run MonitorCore.ts watch
  bun run MonitorCore.ts watch --no-dashboard
  bun run MonitorCore.ts query --workflow my-workflow --live
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const command = args[0];
  const getArg = (name: string): string | undefined => {
    const idx = args.indexOf(name);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
  };

  switch (command) {
    case 'status': {
      await showStatus();
      break;
    }

    case 'watch': {
      const noDashboard = args.includes('--no-dashboard');
      const quiet = args.includes('--quiet');
      await watchLive(noDashboard, quiet);
      break;
    }

    case 'query': {
      const queryWorkflowId = getArg('--workflow');
      if (!queryWorkflowId) {
        console.error('Error: --workflow is required');
        process.exit(1);
      }
      const live = args.includes('--live');
      await queryWorkflow(queryWorkflowId, live);
      break;
    }

    case 'intervene': {
      const subcommand = args[1];
      switch (subcommand) {
        case 'approve': {
          const interventionId = args[2];
          if (!interventionId) {
            console.error('Error: intervention ID required');
            process.exit(1);
          }
          const approvalManager = createApprovalManager();
          await approvalManager.approveViaCLI(interventionId);
          console.log(JSON.stringify({ approved: true, interventionId }));
          break;
        }

        case 'deny': {
          const interventionId = args[2];
          const reason = args.slice(3).join(' ') || 'Manual denial';
          if (!interventionId) {
            console.error('Error: intervention ID required');
            process.exit(1);
          }
          const approvalManager = createApprovalManager();
          await approvalManager.denyViaCLI(interventionId, reason);
          console.log(JSON.stringify({ denied: true, interventionId, reason }));
          break;
        }

        case 'list-pending': {
          const approvalManager = createApprovalManager();
          const pending = await approvalManager.getPendingApprovals();
          console.log(JSON.stringify({ pending, count: pending.length }, null, 2));
          break;
        }

        case 'emergency-stop': {
          const interventionManager = createInterventionManager();
          await interventionManager.emergencyStop();
          console.log(JSON.stringify({ emergencyStop: true, message: 'All interventions halted' }));
          break;
        }

        case 'dry-run': {
          const mode = args[2];
          if (!mode || !['on', 'off'].includes(mode)) {
            console.error('Error: dry-run requires "on" or "off"');
            process.exit(1);
          }
          const interventionManager = createInterventionManager();
          interventionManager.setDryRun(mode === 'on');
          console.log(JSON.stringify({ dryRun: mode === 'on' }));
          break;
        }

        default: {
          console.error(`Unknown intervene subcommand: ${subcommand}`);
          console.error('Available: approve, deny, list-pending, emergency-stop, dry-run');
          process.exit(1);
        }
      }
      break;
    }

    case 'replay': {
      const traceFile = getArg('--trace');
      const fromDate = getArg('--from');
      const toDate = getArg('--to');
      const thresholdsFile = getArg('--thresholds');
      const anomalyFilter = getArg('--anomaly-filter');

      if (!thresholdsFile) {
        console.error('Error: --thresholds is required for replay command');
        process.exit(1);
      }

      if (!traceFile && (!fromDate || !toDate)) {
        console.error('Error: replay requires either --trace <file> or --from <date> --to <date>');
        process.exit(1);
      }

      if (traceFile === undefined && (fromDate === undefined || toDate === undefined)) {
        console.error('Error: --from and --to must both be provided when using date range');
        process.exit(1);
      }

      // Validate that file exists or date range selects files
      if (traceFile) {
        if (!existsSync(traceFile)) {
          console.error(`Error: trace file does not exist: ${traceFile}`);
          process.exit(1);
        }
      }

      const options: { fromDate?: string; toDate?: string; anomalyFilter?: string } = {};
      if (fromDate) options.fromDate = fromDate;
      if (toDate) options.toDate = toDate;
      if (anomalyFilter) options.anomalyFilter = anomalyFilter;

      const result = await runThresholdReplay(traceFile ?? '', thresholdsFile, options);
      console.log(JSON.stringify({
        traceCount: result.traceCount,
        detectionRateChange: result.detectionRateChange,
        wouldHaveCaught: result.wouldHaveCaught,
        wouldHaveMissed: result.wouldHaveMissed,
        falsePositives: result.falsePositives,
        reportPath: result.reportPath,
      }, null, 2));
      break;
    }

    case 'inject': {
      const scenario = getArg('--scenario') as ScenarioType | undefined;
      const pipeline = (getArg('--pipeline') ?? 'offline') as PipelineMode;
      const countStr = getArg('--count');
      const count = countStr ? Math.min(parseInt(countStr, 10), 500) : 20;

      const validScenarios: ScenarioType[] = [
        'token_spike', 'error_burst', 'infinite_loop', 'message_flood',
        'communication_deadlock', 'team_divergence', 'orphaned_member', 'high_load',
      ];
      const validPipelines: PipelineMode[] = ['live', 'offline'];

      if (!scenario || !validScenarios.includes(scenario)) {
        console.error(`Error: --scenario is required. Valid values: ${validScenarios.join(', ')}`);
        process.exit(1);
      }

      if (!validPipelines.includes(pipeline)) {
        console.error(`Error: --pipeline must be "live" or "offline"`);
        process.exit(1);
      }

      const report = await injectScenario(scenario, pipeline, count);
      console.log(JSON.stringify({
        scenario: report.scenario,
        tracesInjected: report.tracesInjected,
        anomaliesDetected: report.anomaliesDetected.length,
        interventionsTriggered: report.interventionsTriggered.length,
        chainComplete: report.chainComplete,
        durationMs: report.durationMs,
        reportPath: report.reportPath,
      }, null, 2));
      break;
    }

    case 'resolve-stale-anomalies': {
      console.log('\nResolving stale anomalies...');
      const count = await resolveStaleAnomalies();
      console.log(JSON.stringify({
        resolved: count,
        message: `Resolved ${count} stale anomalies (aged-out >30d or test workflows >7d)`,
      }, null, 2));
      break;
    }

    case 'ack': {
      const ackAllFlag = args.includes('--all');
      if (!ackAllFlag) {
        console.error('Error: --all flag required for ack command');
        process.exit(1);
      }
      const count = ackAll();
      console.log(JSON.stringify({
        acknowledged: count,
        message: `Acknowledged ${count} alerts`,
      }, null, 2));
      break;
    }

    case 'compare-policies': {
      const traceFile = getArg('--trace');
      const fromDate = getArg('--from');
      const toDate = getArg('--to');
      const configsFile = getArg('--configs');

      if (!configsFile) {
        console.error('Error: --configs is required for compare-policies command');
        process.exit(1);
      }

      if (!traceFile && (!fromDate || !toDate)) {
        console.error('Error: compare-policies requires either --trace <file> or --from <date> --to <date>');
        process.exit(1);
      }

      // ISC 606, 607: Load and validate configs file via typed loader with Zod validation
      let policyConfigs: Array<{ name: string; policy: unknown }>;
      try {
        policyConfigs = loadPolicyConfigs(configsFile);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`Error: --configs file validation failed: ${msg}`);
        process.exit(1);
      }

      // Load traces
      let traceLines: string[] = [];
      if (traceFile) {
        if (!existsSync(traceFile)) {
          console.error(`Error: trace file does not exist: ${traceFile}`);
          process.exit(1);
        }
        traceLines = readFileSync(traceFile, 'utf-8').split('\n').filter((l: string) => l.trim());
      } else if (fromDate && toDate) {
        const files = selectTraceFilesByDateRange(fromDate, toDate);
        if (files.length === 0) {
          console.error(`Error: date range ${fromDate}--${toDate} selected zero trace files`);
          process.exit(1);
        }
        for (const f of files) {
            traceLines.push(...readFileSync(f, 'utf-8').split('\n').filter((l: string) => l.trim()));
        }
      }

      // Delegate to TraceCollector's dual-format parser rather than forking
      // a second inline parser here — the previous version pushed any
      // object with a truthy workflowId through an unsafe `as AgentTrace`
      // cast, so new-format ({ts, category, payload}) lines silently fed
      // comparePolicies()/AnomalyDetector with `timestamp`/`eventType`/
      // `metadata` all `undefined` instead of being skipped.
      const traces: AgentTrace[] = [];
      for (const line of traceLines) {
        const trace = parseTraceLine(line);
        if (trace) traces.push(trace);
      }

      const results = await comparePolicies(traces, policyConfigs as Array<{ name: string; policy: InterventionConfig }>);
      console.log(JSON.stringify({
        policies: results.map(r => ({
          name: r.policyName,
          interventionsTriggered: r.interventionsTriggered,
          chainComplete: r.interventionsTriggered > 0,
        })),
        reportPath: results[0]?.reportPath,
      }, null, 2));
      break;
    }

    default: {
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
    }
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`Fatal error: ${errMsg}`);
    auditLog({
      action: 'error',
      details: { error: errMsg, command: process.argv.slice(2).join(' ') },
      success: false,
      errorMessage: errMsg,
    });
    process.exit(1);
  });
}
