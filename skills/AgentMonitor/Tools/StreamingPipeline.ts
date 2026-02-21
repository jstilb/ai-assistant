#!/usr/bin/env bun
/**
 * StreamingPipeline - Real-time streaming evaluation pipeline
 *
 * Connects LiveTraceWatcher, AnomalyDetector, and LiveDashboard into
 * a unified streaming pipeline that processes traces as they arrive.
 *
 * This is the main orchestrator for Phase 2 live monitoring:
 * - Starts file watcher on traces directory
 * - Routes traces through anomaly detection
 * - Updates dashboard state
 * - Triggers alerts on threshold breaches
 *
 * Usage:
 *   import { startStreamingPipeline } from './StreamingPipeline.ts';
 *   const pipeline = await startStreamingPipeline({ dashboard: true });
 *   // ... later
 *   pipeline.stop();
 */

import type { AgentTrace } from './TraceCollector.ts';
import { createLiveWatcher, type LiveWatcher } from './LiveTraceWatcher.ts';
import { createAnomalyDetector, type AnomalyDetector, type AnomalyDetectorConfig } from './AnomalyDetector.ts';
import { createDashboardStateManager, startDashboardLoop, type DashboardConfig } from './LiveDashboard.ts';
import { createInterventionManager, type InterventionManager as IManager, type InterventionResult } from './InterventionManager.ts';
import { auditLog } from './AuditLogger.ts';

// ============================================================================
// Types
// ============================================================================

export interface StreamingPipelineConfig {
  /** Show live dashboard in terminal */
  dashboard: boolean;
  /** Dashboard configuration */
  dashboardConfig?: Partial<DashboardConfig>;
  /** Anomaly detector configuration */
  anomalyConfig?: Partial<AnomalyDetectorConfig>;
  /** Callback for each trace received */
  onTrace?: (trace: AgentTrace) => void;
  /** Callback for anomaly detection */
  onAnomaly?: (anomaly: import('./AnomalyDetector.ts').Anomaly) => void;
  /** Enable intervention system (pause/throttle/feedback on anomalies) */
  intervention?: boolean;
  /** Start in dry-run mode (log interventions without executing) */
  interventionDryRun?: boolean;
  /** Callback for intervention results */
  onIntervention?: (result: InterventionResult) => void;
  /** Whether to run in quiet mode (no console output besides dashboard) */
  quiet: boolean;
}

export interface StreamingPipeline {
  stop(): void;
  isRunning(): boolean;
  getStats(): StreamingPipelineStats;
}

export interface StreamingPipelineStats {
  startedAt: number;
  tracesProcessed: number;
  anomaliesDetected: number;
  activeAnomalies: number;
  activeWorkflows: number;
  eventsPerSecond: number;
  uptimeMs: number;
  interventionsTriggered: number;
  interventionsDryRun: boolean;
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: StreamingPipelineConfig = {
  dashboard: true,
  quiet: false,
};

// ============================================================================
// Implementation
// ============================================================================

export function startStreamingPipeline(config?: Partial<StreamingPipelineConfig>): StreamingPipeline {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const startedAt = Date.now();
  let tracesProcessed = 0;
  let anomaliesDetected = 0;
  let interventionsTriggered = 0;
  let running = true;

  // Create components
  const anomalyDetector = createAnomalyDetector(cfg.anomalyConfig);
  const dashboardManager = createDashboardStateManager();

  // Create intervention manager if enabled
  let interventionManager: IManager | null = null;
  if (cfg.intervention !== false) {
    interventionManager = createInterventionManager();
    if (cfg.interventionDryRun) {
      interventionManager.setDryRun(true);
    }
  }

  // Create live watcher with callbacks
  const watcher = createLiveWatcher({
    onTrace(trace: AgentTrace): void {
      if (!running) return;

      tracesProcessed++;

      // Route through anomaly detector
      const newAnomalies = anomalyDetector.ingest(trace);
      anomaliesDetected += newAnomalies.length;

      // Route anomalies through intervention system
      if (interventionManager && interventionManager.isEnabled()) {
        for (const anomaly of newAnomalies) {
          interventionManager.handleAnomaly(anomaly).then(result => {
            if (result) {
              interventionsTriggered++;
              if (cfg.onIntervention) {
                cfg.onIntervention(result);
              }
            }
          }).catch(err => {
            if (!cfg.quiet) {
              console.error(`[StreamingPipeline] Intervention error: ${err.message}`);
            }
          });
        }
      }

      // Update dashboard state
      dashboardManager.update(trace);
      dashboardManager.setWatcherStats(watcher.getStats());
      dashboardManager.setAnomalies(anomalyDetector.getActiveAnomalies());

      // Update workflow health for this workflow
      const health = anomalyDetector.getWorkflowHealth(trace.workflowId);
      dashboardManager.setWorkflowHealth(trace.workflowId, health);

      // Fire user callbacks
      if (cfg.onTrace) cfg.onTrace(trace);
      for (const anomaly of newAnomalies) {
        if (cfg.onAnomaly) cfg.onAnomaly(anomaly);
      }
    },

    onError(error: Error): void {
      if (!cfg.quiet) {
        console.error(`[StreamingPipeline] Error: ${error.message}`);
      }
      auditLog({
        action: 'error',
        details: { component: 'streaming_pipeline', error: error.message },
        success: false,
        errorMessage: error.message,
      });
    },

    onWorkflowStart(workflowId: string): void {
      if (!cfg.quiet && !cfg.dashboard) {
        console.log(`[StreamingPipeline] Workflow started: ${workflowId}`);
      }
    },

    onWorkflowEnd(workflowId: string): void {
      if (!cfg.quiet && !cfg.dashboard) {
        console.log(`[StreamingPipeline] Workflow completed: ${workflowId}`);
      }
    },
  });

  // Start watcher
  watcher.start();

  // Start dashboard if enabled
  let dashboardStopper: { stop: () => void } | null = null;
  if (cfg.dashboard) {
    dashboardStopper = startDashboardLoop(
      () => dashboardManager.getState(),
      cfg.dashboardConfig
    );
  } else if (!cfg.quiet) {
    console.log('[StreamingPipeline] Live monitoring started. Watching for traces...');
    console.log('[StreamingPipeline] Press Ctrl+C to stop.');
  }

  auditLog({
    action: 'config_change',
    details: {
      event: 'streaming_pipeline_started',
      dashboard: cfg.dashboard,
      anomalyConfig: cfg.anomalyConfig || 'defaults',
    },
    success: true,
  });

  // Periodic stale workflow check (every 30 seconds)
  const staleCheckInterval = setInterval(() => {
    if (!running) return;

    const now = Date.now();
    const state = dashboardManager.getState();
    for (const [workflowId, health] of state.workflowHealthMap) {
      if (health.lastTraceAt && now - health.lastTraceAt > (cfg.anomalyConfig?.staleWorkflowThresholdMs || 300000)) {
        // Mark as potentially stale - this is informational
        if (health.status !== 'unknown') {
          dashboardManager.setWorkflowHealth(workflowId, {
            ...health,
            status: 'warning',
          });
        }
      }
    }
  }, 30000);

  return {
    stop(): void {
      running = false;
      watcher.stop();
      if (dashboardStopper) dashboardStopper.stop();
      clearInterval(staleCheckInterval);

      auditLog({
        action: 'config_change',
        details: {
          event: 'streaming_pipeline_stopped',
          tracesProcessed,
          anomaliesDetected,
          uptimeMs: Date.now() - startedAt,
        },
        success: true,
      });
    },

    isRunning(): boolean {
      return running;
    },

    getStats(): StreamingPipelineStats {
      const watcherStats = watcher.getStats();
      return {
        startedAt,
        tracesProcessed,
        anomaliesDetected,
        activeAnomalies: anomalyDetector.getActiveAnomalies().length,
        activeWorkflows: watcherStats.activeWorkflows.size,
        eventsPerSecond: watcherStats.eventsPerSecond,
        uptimeMs: Date.now() - startedAt,
        interventionsTriggered,
        interventionsDryRun: interventionManager ? interventionManager.isDryRun() : false,
      };
    },
  };
}

// ============================================================================
// CLI Entry Point
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const noDashboard = args.includes('--no-dashboard');
  const quiet = args.includes('--quiet');

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
StreamingPipeline - Live agent monitoring

Usage:
  bun run StreamingPipeline.ts [options]

Options:
  --no-dashboard    Run without terminal dashboard (log mode)
  --quiet           Suppress console output
  --help            Show this help message
`);
    process.exit(0);
  }

  const pipeline = startStreamingPipeline({
    dashboard: !noDashboard,
    quiet,
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    pipeline.stop();
    const stats = pipeline.getStats();
    console.log('\n');
    console.log('Live monitoring stopped.');
    console.log(`Traces processed: ${stats.tracesProcessed}`);
    console.log(`Anomalies detected: ${stats.anomaliesDetected}`);
    console.log(`Uptime: ${((stats.uptimeMs) / 1000 / 60).toFixed(1)} minutes`);
    process.exit(0);
  });
}
