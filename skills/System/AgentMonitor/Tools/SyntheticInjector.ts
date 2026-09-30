/**
 * SyntheticInjector.ts — Synthetic Fault Injection for AgentMonitor
 *
 * Injects synthetic fault scenarios through the anomaly detection pipeline
 * to verify end-to-end chain correctness without real incidents.
 *
 * Usage:
 *   import { injectScenario } from './SyntheticInjector.ts';
 *   const report = await injectScenario('token_spike', 'offline');
 */

import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { AgentTrace } from './TraceCollector.ts';
import type { Anomaly } from './AnomalyDetector.ts';
import { createAnomalyDetector, deterministicRepetitionAssessor } from './AnomalyDetector.ts';
import { createInterventionManager, type InterventionResult } from './InterventionManager.ts';
import { getKayaHome } from '../../../../lib/core/KayaHome.ts';

// ============================================================================
// Types
// ============================================================================

export type ScenarioType =
  | 'token_spike'
  | 'error_burst'
  | 'infinite_loop'
  | 'message_flood'
  | 'communication_deadlock'
  | 'team_divergence'
  | 'orphaned_member'
  | 'high_load';

export type PipelineMode = 'offline' | 'live';

export interface InjectionReport {
  scenario: ScenarioType;
  tracesInjected: number;
  anomaliesDetected: Anomaly[];
  interventionsTriggered: InterventionResult[];
  chainComplete: boolean;
  durationMs: number;
  simulationSource: boolean;
  reportPath?: string;
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = getKayaHome();
const TRACES_DIR = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'traces');
const REPORTS_DIR = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'reports');

const SIM_SOURCE = 'simulation' as const;

// ============================================================================
// Trace Generators
// ============================================================================

function makeBaseTrace(workflowId: string, agentId: string, ts: number): AgentTrace {
  return {
    workflowId,
    agentId,
    timestamp: ts,
    eventType: 'tool_call',
    metadata: {},
    context: { source: SIM_SOURCE },
  };
}

function generateScenarioTraces(scenario: ScenarioType, count: number = 20): AgentTrace[] {
  const now = Date.now();
  const workflowId = `sim-${scenario}-${now}`;
  const traces: AgentTrace[] = [];

  switch (scenario) {
    case 'token_spike': {
      // Generate traces with very high token usage in a short window
      for (let i = 0; i < count; i++) {
        traces.push({
          ...makeBaseTrace(workflowId, 'agent-1', now + i * 10),
          metadata: { tokensUsed: 15000 + i * 1000 },
        });
      }
      break;
    }

    case 'error_burst': {
      // Generate error events across multiple workflow IDs to ensure the
      // minOccurrences policy threshold is reached.
      // Each workflowId fires one error_burst anomaly; with 3 workflows we
      // hit the minOccurrences: 3 policy requirement.
      const numWorkflows = Math.max(3, Math.ceil(count / 5));
      for (let w = 0; w < numWorkflows; w++) {
        const wfId = `${workflowId}-wf${w}`;
        for (let i = 0; i < 5; i++) {
          traces.push({
            ...makeBaseTrace(wfId, 'agent-1', now + w * 100 + i * 10),
            eventType: 'error',
            metadata: { errorMessage: `Simulated error burst event w${w}e${i}` },
          });
        }
      }
      break;
    }

    case 'infinite_loop': {
      // Repeat the same tool call many times
      for (let i = 0; i < count; i++) {
        traces.push({
          ...makeBaseTrace(workflowId, 'agent-1', now + i * 100),
          eventType: 'tool_call',
          metadata: { toolName: 'Read' },
        });
      }
      break;
    }

    case 'message_flood': {
      // One agent sending massive number of messages
      for (let i = 0; i < count; i++) {
        traces.push({
          ...makeBaseTrace(workflowId, 'agent-1', now + i * 100),
          eventType: 'team_message',
          metadata: {},
        });
      }
      break;
    }

    case 'communication_deadlock': {
      // Two agents both waiting for each other (simulated via pending messages)
      for (let i = 0; i < Math.floor(count / 2); i++) {
        traces.push({
          ...makeBaseTrace(workflowId, 'agent-1', now + i * 1000),
          eventType: 'team_message',
          metadata: {},
          context: { source: SIM_SOURCE, targetAgent: 'agent-2' },
        });
        traces.push({
          ...makeBaseTrace(workflowId, 'agent-2', now + i * 1000 + 1),
          eventType: 'team_message',
          metadata: {},
          context: { source: SIM_SOURCE, targetAgent: 'agent-1' },
        });
      }
      break;
    }

    case 'team_divergence': {
      // Some agents progress fast, some slow
      for (let i = 0; i < count; i++) {
        const agent = i % 2 === 0 ? 'agent-fast' : 'agent-slow';
        const progress = agent === 'agent-fast' ? i * 10 : i;
        traces.push({
          ...makeBaseTrace(workflowId, agent, now + i * 100),
          eventType: 'team_task_update',
          metadata: { iscCompletionRate: progress / count },
        });
      }
      break;
    }

    case 'orphaned_member': {
      // One agent goes silent for a long time
      traces.push({
        ...makeBaseTrace(workflowId, 'agent-orphaned', now - 600000), // 10 min ago
        eventType: 'start',
        metadata: {},
      });
      // Active agent keeps going
      for (let i = 0; i < count - 1; i++) {
        traces.push({
          ...makeBaseTrace(workflowId, 'agent-active', now + i * 100),
          metadata: {},
        });
      }
      break;
    }

    case 'high_load': {
      // High event rate — many events in a short window
      for (let i = 0; i < count; i++) {
        traces.push({
          ...makeBaseTrace(workflowId, `agent-${i % 5}`, now + i * 50), // every 50ms
          metadata: { tokensUsed: 100 },
        });
      }
      break;
    }
  }

  return traces;
}

// ============================================================================
// Report Writing
// ============================================================================

function writeInjectionReport(report: Omit<InjectionReport, 'reportPath'>): string {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(REPORTS_DIR, `inject-${ts}.md`);

  const lines: string[] = [
    `# Injection Report`,
    ``,
    `## Summary`,
    ``,
    `- **Scenario:** ${report.scenario}`,
    `- **Pipeline mode:** ${report.simulationSource ? 'offline' : 'live'}`,
    `- **Traces injected:** ${report.tracesInjected}`,
    `- **Anomalies detected:** ${report.anomaliesDetected.length}`,
    `- **Interventions triggered:** ${report.interventionsTriggered.length}`,
    `- **chainComplete:** ${report.chainComplete}`,
    `- **Duration:** ${report.durationMs}ms`,
    `- **Run at:** ${new Date().toISOString()}`,
    ``,
    `## Anomalies Detected`,
    ``,
    report.anomaliesDetected.length > 0
      ? report.anomaliesDetected.map(a =>
          `- **${a.type}** (${a.severity}): ${a.message}`
        ).join('\n')
      : '_No anomalies detected_',
    ``,
    `## Interventions Triggered`,
    ``,
    report.interventionsTriggered.length > 0
      ? report.interventionsTriggered.map(r =>
          `- **${r.type}** (dryRun: ${r.dryRun}): ${r.message}`
        ).join('\n')
      : '_No interventions triggered_',
    ``,
  ];

  writeFileSync(reportPath, lines.join('\n'), 'utf-8');
  return reportPath;
}

// ============================================================================
// Main Export
// ============================================================================

export async function injectScenario(
  scenarioType: ScenarioType,
  pipelineMode: PipelineMode,
  count: number = 20,
): Promise<InjectionReport> {
  const startMs = Date.now();

  // Generate synthetic traces (all carry context.source: 'simulation')
  const traces = generateScenarioTraces(scenarioType, Math.min(count, 500));

  let anomaliesDetected: Anomaly[] = [];
  let interventionsTriggered: InterventionResult[] = [];

  if (pipelineMode === 'offline') {
    // Offline mode: push directly to fresh detector with allowSimulation: true.
    // Synthetic injection is hermetic: use the deterministic repetition assessor
    // (no live LLM in checkInfiniteLoop) and persistState:false (no writes to
    // active-anomalies.json / eval signals / notifications).
    const detector = createAnomalyDetector({
      voiceAlerts: false,
      jsonlAlerts: false,
      allowSimulation: true,
      repetitionAssessor: deterministicRepetitionAssessor,
      persistState: false,
      // Lower thresholds to trigger anomalies in small synthetic trace sets
      tokenSpikeThreshold: 50000,
      tokenSpikeWindowMs: 5000,
      errorBurstThreshold: 1,
      errorBurstWindowMs: 60000,
      infiniteLoopThreshold: 5,
      infiniteLoopWindow: 10,
      highLoadEventsPerSecond: 3,
      highLoadWindowMs: 5000,
      messageFloodThreshold: 5,
      messageFloodWindowMs: 60000,
      orphanedMemberThresholdMs: 300000,
      teamDivergenceRatio: 3.0,
    });

    // Force dryRun at construction (race-proof — survives the async config load)
    const interventionManager = createInterventionManager({ dryRun: true });

    for (const trace of traces) {
      const detected = await detector.ingest(trace);
      anomaliesDetected.push(...detected);

      // Run intervention for each detected anomaly
      for (const anomaly of detected) {
        try {
          const result = await interventionManager.handleAnomaly(anomaly);
          if (result) {
            interventionsTriggered.push({ ...result, dryRun: true });
          }
        } catch {
          // Intervention errors are non-fatal in injection runs
        }
      }
    }
  } else {
    // Live mode: write to temp file in traces dir, force interventionDryRun
    mkdirSync(TRACES_DIR, { recursive: true });
    const ts = Date.now();
    const tempFile = join(TRACES_DIR, `sim-${ts}-${scenarioType}.jsonl`);

    try {
      const jsonlContent = traces.map(t => JSON.stringify(t)).join('\n');
      writeFileSync(tempFile, jsonlContent, 'utf-8');

      // Process traces through offline detector with allowSimulation (live watcher
      // would skip simulation traces; we process them here in isolation). Hermetic:
      // deterministic repetition assessor + persistState:false (no live side effects).
      const detector = createAnomalyDetector({
        voiceAlerts: false,
        jsonlAlerts: false,
        allowSimulation: true,
        repetitionAssessor: deterministicRepetitionAssessor,
        persistState: false,
        tokenSpikeThreshold: 50000,
        errorBurstThreshold: 2,
        infiniteLoopThreshold: 5,
        highLoadEventsPerSecond: 3,
        messageFloodThreshold: 5,
      });

      // Force dryRun at construction (race-proof — survives the async config load)
      const interventionManager = createInterventionManager({ dryRun: true });

      for (const trace of traces) {
        const detected = await detector.ingest(trace);
        anomaliesDetected.push(...detected);

        for (const anomaly of detected) {
          try {
            const result = await interventionManager.handleAnomaly(anomaly);
            if (result) {
              interventionsTriggered.push({ ...result, dryRun: true });
            }
          } catch {
            // non-fatal
          }
        }
      }
    } finally {
      // Always clean up temp file (including on error)
      try {
        if (existsSync(tempFile)) {
          unlinkSync(tempFile);
        }
      } catch {
        // Best effort cleanup
      }
    }
  }

  const durationMs = Date.now() - startMs;
  const chainComplete = anomaliesDetected.length > 0 && interventionsTriggered.length > 0;

  const reportBase: Omit<InjectionReport, 'reportPath'> = {
    scenario: scenarioType,
    tracesInjected: traces.length,
    anomaliesDetected,
    interventionsTriggered,
    chainComplete,
    durationMs,
    simulationSource: true,
  };

  const reportPath = writeInjectionReport(reportBase);

  return { ...reportBase, reportPath };
}
