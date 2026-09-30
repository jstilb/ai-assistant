#!/usr/bin/env bun
/**
 * LiveDashboard - CLI dashboard for real-time agent monitoring
 *
 * Displays real-time metrics for concurrent agent workflows including:
 * - Active workflow status with health indicators
 * - Events per second throughput
 * - Anomaly alerts
 * - Per-agent resource consumption
 *
 * Supports 10+ concurrent agents and refreshes every 1 second.
 *
 * Usage:
 *   import { startDashboard } from './LiveDashboard.ts';
 *   startDashboard();
 */

import type { AgentTrace } from './TraceCollector.ts';
import type { Anomaly, WorkflowHealth } from './AnomalyDetector.ts';
import type { LiveWatcherStats } from './LiveTraceWatcher.ts';

// ============================================================================
// Types
// ============================================================================

interface DashboardState {
  watcherStats: LiveWatcherStats;
  workflowHealthMap: Map<string, WorkflowHealth>;
  activeAnomalies: Anomaly[];
  recentTraces: AgentTrace[];
  agentMetrics: Map<string, AgentMetrics>;
}

interface AgentMetrics {
  agentId: string;
  workflowId: string;
  totalTokens: number;
  toolCallCount: number;
  errorCount: number;
  lastActivity: number;
  latestTool: string | null;
}

export interface DashboardConfig {
  refreshIntervalMs: number;
  maxRecentTraces: number;
  maxAnomaliesDisplayed: number;
  compact: boolean;
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_DASHBOARD_CONFIG: DashboardConfig = {
  refreshIntervalMs: 1000,
  maxRecentTraces: 15,
  maxAnomaliesDisplayed: 10,
  compact: false,
};

// ============================================================================
// Dashboard Rendering
// ============================================================================

function clearScreen(): void {
  process.stdout.write('\x1b[2J\x1b[H');
}

function colorize(text: string, color: string): string {
  const colors: Record<string, string> = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    reset: '\x1b[0m',
  };
  return `${colors[color] || ''}${text}\x1b[0m`;
}

function statusColor(status: string): string {
  switch (status) {
    case 'healthy': return 'green';
    case 'warning': return 'yellow';
    case 'critical': return 'red';
    default: return 'dim';
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case 'healthy': return '[OK]';
    case 'warning': return '[!!]';
    case 'critical': return '[XX]';
    default: return '[??]';
  }
}

function severityColor(severity: string): string {
  switch (severity) {
    case 'critical': return 'red';
    case 'warning': return 'yellow';
    default: return 'dim';
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1000000).toFixed(2)}M`;
}

function padRight(text: string, width: number): string {
  return text.slice(0, width).padEnd(width);
}

function renderDashboard(state: DashboardState, config?: Partial<DashboardConfig>): string {
  const cfg = { ...DEFAULT_DASHBOARD_CONFIG, ...config };
  const lines: string[] = [];
  const now = Date.now();
  const width = 80;

  // Header
  lines.push(colorize('=' .repeat(width), 'cyan'));
  lines.push(colorize('  AgentMonitor Live Dashboard', 'bold'));
  lines.push(colorize(`  ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`, 'dim'));
  lines.push(colorize('='.repeat(width), 'cyan'));

  // System Stats
  const stats = state.watcherStats;
  const uptime = stats.startedAt > 0 ? formatDuration(now - stats.startedAt) : 'N/A';
  lines.push('');
  lines.push(colorize('System Overview', 'bold'));
  lines.push(`  Uptime: ${uptime}  |  Events/sec: ${colorize(stats.eventsPerSecond.toFixed(1), stats.eventsPerSecond > 50 ? 'yellow' : 'green')}  |  Total traces: ${stats.tracesReceived}  |  Dropped: ${stats.droppedTraces > 0 ? colorize(String(stats.droppedTraces), 'red') : '0'}`);
  lines.push(`  Active workflows: ${colorize(String(stats.activeWorkflows.size), 'cyan')}  |  Active anomalies: ${state.activeAnomalies.length > 0 ? colorize(String(state.activeAnomalies.length), 'red') : colorize('0', 'green')}`);

  // Workflow Health Table
  lines.push('');
  lines.push(colorize('Workflow Health', 'bold'));

  if (state.workflowHealthMap.size === 0) {
    lines.push(colorize('  No active workflows. Waiting for traces...', 'dim'));
  } else {
    lines.push(`  ${padRight('Status', 8)} ${padRight('Workflow', 30)} ${padRight('Agents', 8)} ${padRight('Tokens', 10)} ${padRight('Errors', 8)} ${padRight('Tools', 8)} ${padRight('Last', 10)}`);
    lines.push(colorize('  ' + '-'.repeat(width - 4), 'dim'));

    const workflows = Array.from(state.workflowHealthMap.values())
      .sort((a, b) => {
        const statusOrder: Record<string, number> = { critical: 0, warning: 1, healthy: 2, unknown: 3 };
        return (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3);
      });

    for (const wf of workflows) {
      const icon = colorize(statusIcon(wf.status), statusColor(wf.status));
      const lastSeen = wf.lastTraceAt ? formatDuration(now - wf.lastTraceAt) + ' ago' : 'never';
      lines.push(
        `  ${icon}  ${padRight(wf.workflowId, 30)} ${padRight(String(wf.agentIds.length), 8)} ${padRight(formatTokens(wf.totalTokens), 10)} ${padRight(String(wf.errorCount), 8)} ${padRight(String(wf.toolCallCount), 8)} ${padRight(lastSeen, 10)}`
      );
    }
  }

  // Per-Agent Metrics
  if (state.agentMetrics.size > 0) {
    lines.push('');
    lines.push(colorize('Agent Activity', 'bold'));
    lines.push(`  ${padRight('Agent', 25)} ${padRight('Workflow', 20)} ${padRight('Tokens', 10)} ${padRight('Tools', 8)} ${padRight('Errors', 8)} ${padRight('Latest Tool', 15)}`);
    lines.push(colorize('  ' + '-'.repeat(width - 4), 'dim'));

    const agents = Array.from(state.agentMetrics.values())
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .slice(0, 15);

    for (const agent of agents) {
      const errorStr = agent.errorCount > 0 ? colorize(String(agent.errorCount), 'red') : '0';
      lines.push(
        `  ${padRight(agent.agentId, 25)} ${padRight(agent.workflowId.slice(0, 20), 20)} ${padRight(formatTokens(agent.totalTokens), 10)} ${padRight(String(agent.toolCallCount), 8)} ${padRight(errorStr, 8)} ${padRight(agent.latestTool || '-', 15)}`
      );
    }
  }

  // Active Anomalies
  if (state.activeAnomalies.length > 0) {
    lines.push('');
    lines.push(colorize('Active Anomalies', 'bold'));

    const displayed = state.activeAnomalies.slice(0, cfg.maxAnomaliesDisplayed);
    for (const anomaly of displayed) {
      const age = formatDuration(now - anomaly.detectedAt);
      const sev = colorize(`[${anomaly.severity.toUpperCase()}]`, severityColor(anomaly.severity));
      lines.push(`  ${sev} ${anomaly.type} | ${anomaly.workflowId} | ${anomaly.message.slice(0, 50)} (${age} ago)`);
    }

    if (state.activeAnomalies.length > cfg.maxAnomaliesDisplayed) {
      lines.push(colorize(`  ... and ${state.activeAnomalies.length - cfg.maxAnomaliesDisplayed} more`, 'dim'));
    }
  }

  // Recent Traces (compact view)
  if (!cfg.compact && state.recentTraces.length > 0) {
    lines.push('');
    lines.push(colorize('Recent Traces', 'bold'));

    const displayed = state.recentTraces.slice(-cfg.maxRecentTraces);
    for (const trace of displayed) {
      const time = new Date(trace.timestamp).toISOString().slice(11, 19);
      const type = padRight(trace.eventType, 12);
      const agent = padRight(trace.agentId, 15);
      const detail = trace.eventType === 'tool_call'
        ? (trace.metadata.toolName || '')
        : trace.eventType === 'error'
          ? colorize(trace.metadata.errorMessage?.slice(0, 30) || '', 'red')
          : '';
      lines.push(`  ${colorize(time, 'dim')} ${type} ${agent} ${detail}`);
    }
  }

  // Footer
  lines.push('');
  lines.push(colorize('-'.repeat(width), 'dim'));
  lines.push(colorize('  Press Ctrl+C to exit  |  q + Enter to quit', 'dim'));

  return lines.join('\n');
}

// ============================================================================
// Dashboard State Manager
// ============================================================================

export function createDashboardStateManager(): {
  update(trace: AgentTrace): void;
  setWatcherStats(stats: LiveWatcherStats): void;
  setAnomalies(anomalies: Anomaly[]): void;
  setWorkflowHealth(workflowId: string, health: WorkflowHealth): void;
  getState(): DashboardState;
} {
  const state: DashboardState = {
    watcherStats: {
      startedAt: Date.now(),
      tracesReceived: 0,
      droppedTraces: 0,
      activeWorkflows: new Set(),
      lastTraceAt: null,
      eventsPerSecond: 0,
    },
    workflowHealthMap: new Map(),
    activeAnomalies: [],
    recentTraces: [],
    agentMetrics: new Map(),
  };

  return {
    update(trace: AgentTrace): void {
      // Add to recent traces
      state.recentTraces.push(trace);
      if (state.recentTraces.length > 100) {
        state.recentTraces = state.recentTraces.slice(-100);
      }

      // Update agent metrics
      const agentKey = `${trace.workflowId}::${trace.agentId}`;
      const existing = state.agentMetrics.get(agentKey) || {
        agentId: trace.agentId,
        workflowId: trace.workflowId,
        totalTokens: 0,
        toolCallCount: 0,
        errorCount: 0,
        lastActivity: 0,
        latestTool: null,
      };

      existing.lastActivity = trace.timestamp;
      existing.totalTokens += trace.metadata.tokensUsed || 0;

      if (trace.eventType === 'tool_call') {
        existing.toolCallCount++;
        existing.latestTool = trace.metadata.toolName || null;
      }
      if (trace.eventType === 'error') {
        existing.errorCount++;
      }

      state.agentMetrics.set(agentKey, existing);
    },

    setWatcherStats(stats: LiveWatcherStats): void {
      state.watcherStats = stats;
    },

    setAnomalies(anomalies: Anomaly[]): void {
      state.activeAnomalies = anomalies;
    },

    setWorkflowHealth(workflowId: string, health: WorkflowHealth): void {
      state.workflowHealthMap.set(workflowId, health);
    },

    getState(): DashboardState {
      return state;
    },
  };
}

// ============================================================================
// Dashboard Runner
// ============================================================================

export function startDashboardLoop(
  getState: () => DashboardState,
  config?: Partial<DashboardConfig>
): { stop: () => void } {
  const cfg = { ...DEFAULT_DASHBOARD_CONFIG, ...config };
  let running = true;

  const interval = setInterval(() => {
    if (!running) return;
    clearScreen();
    const output = renderDashboard(getState(), cfg);
    process.stdout.write(output + '\n');
  }, cfg.refreshIntervalMs);

  // Handle 'q' + Enter to quit
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (data) => {
      const char = data.toString();
      if (char === 'q' || char === '\x03') { // q or Ctrl+C
        running = false;
        clearInterval(interval);
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.exit(0);
      }
    });
  }

  return {
    stop(): void {
      running = false;
      clearInterval(interval);
    },
  };
}
