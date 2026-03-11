#!/usr/bin/env bun
/**
 * MonitorCore - Main CLI entry point for AgentMonitor
 *
 * Orchestrates trace collection, evaluation pipeline, report generation,
 * baseline updates, alerting, and live monitoring for agent workflows.
 *
 * CLI Usage:
 *   bun run MonitorCore.ts evaluate --workflow <workflowId>
 *   bun run MonitorCore.ts evaluate-all --date 2026-02-05
 *   bun run MonitorCore.ts status
 *   bun run MonitorCore.ts retro --work-dir <MEMORY/WORK/dir>
 *   bun run MonitorCore.ts watch [--no-dashboard] [--quiet]
 *   bun run MonitorCore.ts query --workflow <id> [--live]
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getTracesForWorkflow, getTracesForDate, getAllTraceFiles, computeTraceStats } from './TraceCollector.ts';
import { runPipeline, loadConfig, loadEvaluation } from './EvaluatorPipeline.ts';
import { generateMarkdownReport, saveReport } from './ReportGenerator.ts';
import { updateBaseline, getBaselineSummary } from './BaselineManager.ts';
import { processAlerts, getRecentAlerts } from './AlertManager.ts';
import { parseSessionLog, listWorkDirs } from './SessionLogParser.ts';
import { auditLog, getAuditStats } from './AuditLogger.ts';
import { startStreamingPipeline } from './StreamingPipeline.ts';
import { createApprovalManager } from './ApprovalManager.ts';
import { createInterventionManager } from './InterventionManager.ts';

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME: string = join(homedir(), '.claude');
const EVALUATIONS_DIR: string = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'evaluations');

// ============================================================================
// Commands
// ============================================================================

async function evaluateWorkflow(workflowId: string): Promise<void> {
  console.log(`\nEvaluating workflow: ${workflowId}`);
  console.log('='.repeat(50));

  // Collect traces
  const traces = getTracesForWorkflow(workflowId);
  if (traces.length === 0) {
    console.error(`No traces found for workflow "${workflowId}"`);
    console.error(`Expected at: MEMORY/MONITORING/traces/${workflowId}.jsonl`);
    process.exit(1);
  }

  console.log(`Found ${traces.length} traces`);

  // Run pipeline
  const config = loadConfig();
  const result = await runPipeline(workflowId, traces, config);

  // Update baselines
  if (config.baselines.autoUpdateBaselines) {
    updateBaseline(traces, config.baselines);
  }

  // Generate report
  const { markdownPath } = saveReport(result);

  // Process alerts
  const alerts = processAlerts(result, config.alerts);

  // Output summary
  console.log('');
  console.log(`Overall Score: ${result.overallScore}/100 ${result.overallPassed ? 'PASSED' : 'FAILED'}`);
  console.log('');
  console.log('Evaluator Scores:');
  for (const evalResult of result.evaluatorResults) {
    const bar = '='.repeat(Math.floor(evalResult.score / 5)) + '-'.repeat(20 - Math.floor(evalResult.score / 5));
    console.log(`  ${evalResult.name.padEnd(20)} ${evalResult.score.toString().padStart(3)}/100 [${bar}]`);
  }

  const criticalCount = result.allFindings.filter(f => f.severity === 'critical').length;
  const warningCount = result.allFindings.filter(f => f.severity === 'warning').length;

  console.log('');
  console.log(`Findings: ${criticalCount} critical, ${warningCount} warnings`);
  console.log(`Recommendations: ${result.allRecommendations.length}`);

  if (alerts.length > 0) {
    console.log(`Alerts generated: ${alerts.length}`);
  }

  console.log('');
  console.log(`Report: ${markdownPath}`);
}

async function evaluateAll(dateStr: string): Promise<void> {
  console.log(`\nEvaluating all workflows for ${dateStr}`);
  console.log('='.repeat(50));

  const tracesByWorkflow = getTracesForDate(dateStr);

  if (tracesByWorkflow.size === 0) {
    console.log('No workflow traces found for this date.');

    // Also check for work directories that might need retro analysis
    const workDirs = listWorkDirs(20).filter(d => d.startsWith(dateStr.replace(/-/g, '')));
    if (workDirs.length > 0) {
      console.log(`\nFound ${workDirs.length} work directories that could be retroactively analyzed:`);
      for (const dir of workDirs) {
        console.log(`  ${dir}`);
      }
      console.log('\nUse: bun run MonitorCore.ts retro --work-dir MEMORY/WORK/<dir>');
    }
    return;
  }

  console.log(`Found ${tracesByWorkflow.size} workflows\n`);

  const config = loadConfig();
  const results: { workflowId: string; score: number; passed: boolean }[] = [];

  for (const [workflowId, traces] of tracesByWorkflow) {
    console.log(`Evaluating ${workflowId} (${traces.length} traces)...`);
    const result = await runPipeline(workflowId, traces, config);

    if (config.baselines.autoUpdateBaselines) {
      updateBaseline(traces, config.baselines);
    }

    saveReport(result);
    processAlerts(result, config.alerts);

    results.push({
      workflowId,
      score: result.overallScore,
      passed: result.overallPassed,
    });
  }

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('Summary:');
  console.log('');
  console.log('| Workflow | Score | Status |');
  console.log('|----------|-------|--------|');
  for (const r of results) {
    console.log(`| ${r.workflowId.slice(0, 40).padEnd(40)} | ${r.score.toString().padStart(3)}/100 | ${r.passed ? 'PASS' : 'FAIL'} |`);
  }

  const avgScore = Math.round(results.reduce((s, r) => s + r.score, 0) / results.length);
  const passRate = Math.round((results.filter(r => r.passed).length / results.length) * 100);

  console.log('');
  console.log(`Average Score: ${avgScore}/100`);
  console.log(`Pass Rate: ${passRate}%`);
}

async function showStatus(): Promise<void> {
  console.log('\nAgentMonitor Status');
  console.log('='.repeat(50));

  // Recent evaluations
  const evalFiles = existsSync(EVALUATIONS_DIR)
    ? readdirSync(EVALUATIONS_DIR).filter(f => f.endsWith('-eval.json')).sort().reverse().slice(0, 10)
    : [];

  if (evalFiles.length > 0) {
    console.log('\nRecent Evaluations:');
    console.log('');
    console.log('| Workflow | Score | Status | Date |');
    console.log('|----------|-------|--------|------|');

    for (const file of evalFiles) {
      const workflowId = file.replace('-eval.json', '');
      const evalResult = loadEvaluation(workflowId);
      if (evalResult) {
        const date = new Date(evalResult.timestamp).toISOString().split('T')[0];
        console.log(`| ${workflowId.slice(0, 30).padEnd(30)} | ${evalResult.overallScore.toString().padStart(3)}/100 | ${evalResult.overallPassed ? 'PASS' : 'FAIL'} | ${date} |`);
      }
    }
  } else {
    console.log('\nNo evaluations yet. Run: bun run MonitorCore.ts evaluate --workflow <id>');
  }

  // Trace files
  const traceFiles = getAllTraceFiles();
  console.log(`\nTrace Files: ${traceFiles.length}`);
  if (traceFiles.length > 0) {
    console.log(`  Most recent: ${traceFiles.slice(0, 5).join(', ')}`);
  }

  // Baselines
  console.log('');
  console.log(getBaselineSummary());

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

  // Work directories available for retro
  const workDirs = listWorkDirs(5);
  if (workDirs.length > 0) {
    console.log('\nRecent Work Dirs (available for retro):');
    for (const dir of workDirs) {
      console.log(`  ${dir}`);
    }
  }
}

async function retroAnalysis(workDir: string): Promise<void> {
  console.log(`\nRetrospective Analysis: ${workDir}`);
  console.log('='.repeat(50));

  // Parse session log
  const session = parseSessionLog(workDir);
  if (session.traces.length === 0) {
    console.error('No traces could be extracted from this session log.');
    console.error('The directory may be empty or contain no parseable content.');
    process.exit(1);
  }

  console.log(`Parsed ${session.traces.length} traces from ${session.metadata.files.length} files`);
  console.log(`Lines processed: ${session.metadata.lineCount}`);

  // Run pipeline
  const config = loadConfig();
  const result = await runPipeline(session.workflowId, session.traces, config);

  // Generate report
  const { markdownPath } = saveReport(result);

  // Process alerts
  processAlerts(result, config.alerts);

  // Output
  console.log('');
  console.log(`Overall Score: ${result.overallScore}/100 ${result.overallPassed ? 'PASSED' : 'FAILED'}`);
  console.log('');

  for (const evalResult of result.evaluatorResults) {
    console.log(`  ${evalResult.name.padEnd(20)} ${evalResult.score.toString().padStart(3)}/100`);
  }

  const criticalFindings = result.allFindings.filter(f => f.severity === 'critical');
  if (criticalFindings.length > 0) {
    console.log('\nCritical Findings:');
    for (const f of criticalFindings) {
      console.log(`  - ${f.message}`);
    }
  }

  if (result.allRecommendations.length > 0) {
    console.log('\nRecommendations:');
    for (const rec of result.allRecommendations.slice(0, 5)) {
      console.log(`  - ${rec}`);
    }
  }

  console.log(`\nReport: ${markdownPath}`);
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

    // Check for existing evaluation
    const evalResult = loadEvaluation(workflowId);
    if (evalResult) {
      console.log('\nLast Evaluation:');
      console.log(`  Score: ${evalResult.overallScore}/100 ${evalResult.overallPassed ? 'PASSED' : 'FAILED'}`);
      console.log(`  Date: ${new Date(evalResult.timestamp).toISOString()}`);
      for (const e of evalResult.evaluatorResults) {
        console.log(`  ${e.name.padEnd(20)} ${e.score.toString().padStart(3)}/100`);
      }
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
AgentMonitor - Agent Workflow Monitoring & Evaluation (v2.0.0)

Usage:
  bun run MonitorCore.ts <command> [options]

Commands:
  evaluate       Evaluate a specific workflow (batch mode)
  evaluate-all   Evaluate all workflows for a date (batch mode)
  status         Show monitoring status and recent evaluations
  retro          Retrospective analysis of a MEMORY/WORK/ session
  watch          Start live monitoring with real-time dashboard
  query          Query workflow data (historical + live)
  intervene      Manual intervention controls (approve/deny/list/emergency-stop/dry-run)

Options:
  evaluate:
    --workflow <id>     Workflow identifier (required)

  evaluate-all:
    --date <YYYY-MM-DD> Date to evaluate (required)

  retro:
    --work-dir <path>   Path to MEMORY/WORK/ directory (required)

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

Examples:
  bun run MonitorCore.ts evaluate --workflow my-workflow-123
  bun run MonitorCore.ts evaluate-all --date 2026-02-05
  bun run MonitorCore.ts status
  bun run MonitorCore.ts retro --work-dir MEMORY/WORK/20260205-080013_tasks-daily
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
    case 'evaluate': {
      const workflowId = getArg('--workflow');
      if (!workflowId) {
        console.error('Error: --workflow is required');
        process.exit(1);
      }
      await evaluateWorkflow(workflowId);
      break;
    }

    case 'evaluate-all': {
      const dateStr = getArg('--date');
      if (!dateStr) {
        console.error('Error: --date is required (format: YYYY-MM-DD)');
        process.exit(1);
      }
      await evaluateAll(dateStr);
      break;
    }

    case 'status': {
      await showStatus();
      break;
    }

    case 'retro': {
      const workDir = getArg('--work-dir');
      if (!workDir) {
        console.error('Error: --work-dir is required');
        process.exit(1);
      }
      await retroAnalysis(workDir);
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
          await approvalManager.approve(interventionId);
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
          await approvalManager.deny(interventionId, reason);
          console.log(JSON.stringify({ denied: true, interventionId, reason }));
          break;
        }

        case 'list-pending': {
          const approvalManager = createApprovalManager();
          const pending = await approvalManager.listPending();
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
