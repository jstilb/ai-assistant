#!/usr/bin/env bun
/**
 * LiveTraceWatcher - Real-time file watcher for trace JSONL files
 *
 * Monitors the traces directory for changes and emits new trace events
 * to registered callbacks within 500ms of file modification.
 *
 * Uses Bun's native file watcher for low-overhead observation.
 *
 * Usage:
 *   import { createLiveWatcher, LiveWatcherCallbacks } from './LiveTraceWatcher.ts';
 *   const watcher = createLiveWatcher({ onTrace: (trace) => { ... } });
 *   watcher.start();
 *   // ... later
 *   watcher.stop();
 */

import { watch, existsSync, readFileSync, mkdirSync, type FSWatcher } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import type { AgentTrace } from './TraceCollector.ts';
import { auditLog } from './AuditLogger.ts';

// ============================================================================
// Types
// ============================================================================

interface LiveWatcherCallbacks {
  onTrace: (trace: AgentTrace) => void;
  onError?: (error: Error) => void;
  onWorkflowStart?: (workflowId: string) => void;
  onWorkflowEnd?: (workflowId: string) => void;
}

export interface LiveWatcherStats {
  startedAt: number;
  tracesReceived: number;
  droppedTraces: number;
  activeWorkflows: Set<string>;
  lastTraceAt: number | null;
  eventsPerSecond: number;
}

export interface LiveWatcher {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  getStats(): LiveWatcherStats;
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME: string = join(homedir(), '.claude');
const TRACES_DIR: string = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'traces');

// ============================================================================
// Core Implementation
// ============================================================================

export function createLiveWatcher(callbacks: LiveWatcherCallbacks): LiveWatcher {
  let running = false;
  let fsWatcher: FSWatcher | null = null;
  const fileOffsets = new Map<string, number>();
  const stats: LiveWatcherStats = {
    startedAt: 0,
    tracesReceived: 0,
    droppedTraces: 0,
    activeWorkflows: new Set(),
    lastTraceAt: null,
    eventsPerSecond: 0,
  };

  // Sliding window for events/second calculation
  const recentTimestamps: number[] = [];
  const EPS_WINDOW_MS = 5000;

  function updateEventsPerSecond(): void {
    const now = Date.now();
    // Remove timestamps older than window
    while (recentTimestamps.length > 0 && recentTimestamps[0] < now - EPS_WINDOW_MS) {
      recentTimestamps.shift();
    }
    stats.eventsPerSecond = recentTimestamps.length / (EPS_WINDOW_MS / 1000);
  }

  function processNewLines(filePath: string): void {
    const fileName = basename(filePath);
    if (!fileName.endsWith('.jsonl')) return;

    const workflowId = fileName.replace('.jsonl', '');
    const currentOffset = fileOffsets.get(fileName) || 0;

    try {
      const content = readFileSync(filePath, 'utf-8');
      const newContent = content.slice(currentOffset);
      fileOffsets.set(fileName, content.length);

      if (!newContent.trim()) return;

      const lines = newContent.trim().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const trace = JSON.parse(line.trim()) as AgentTrace;
          if (!trace.workflowId || !trace.agentId || !trace.eventType) {
            stats.droppedTraces++;
            continue;
          }

          stats.tracesReceived++;
          stats.lastTraceAt = Date.now();
          stats.activeWorkflows.add(trace.workflowId);
          recentTimestamps.push(Date.now());
          updateEventsPerSecond();

          // Detect workflow lifecycle events
          if (trace.eventType === 'start' && callbacks.onWorkflowStart) {
            callbacks.onWorkflowStart(workflowId);
          }
          if (trace.eventType === 'completion' && callbacks.onWorkflowEnd) {
            callbacks.onWorkflowEnd(workflowId);
            stats.activeWorkflows.delete(workflowId);
          }

          callbacks.onTrace(trace);
        } catch {
          stats.droppedTraces++;
        }
      }
    } catch (error) {
      if (callbacks.onError) {
        callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  function initializeOffsets(): void {
    if (!existsSync(TRACES_DIR)) return;

    const files = Bun.spawnSync(['ls', TRACES_DIR]).stdout.toString().trim().split('\n');
    for (const file of files) {
      if (file.endsWith('.jsonl')) {
        const filePath = join(TRACES_DIR, file);
        try {
          const content = readFileSync(filePath, 'utf-8');
          fileOffsets.set(file, content.length);
        } catch {
          fileOffsets.set(file, 0);
        }
      }
    }
  }

  return {
    start(): void {
      if (running) return;

      // Ensure traces directory exists
      if (!existsSync(TRACES_DIR)) {
        mkdirSync(TRACES_DIR, { recursive: true });
      }

      // Initialize offsets to only read new content
      initializeOffsets();

      running = true;
      stats.startedAt = Date.now();
      stats.tracesReceived = 0;
      stats.droppedTraces = 0;
      stats.activeWorkflows = new Set();
      stats.lastTraceAt = null;

      // Watch directory for changes
      fsWatcher = watch(TRACES_DIR, { recursive: false }, (_eventType, filename) => {
        if (!filename || !running) return;
        const filePath = join(TRACES_DIR, filename);
        if (existsSync(filePath)) {
          processNewLines(filePath);
        }
      });

      auditLog({
        action: 'config_change',
        details: { event: 'live_watcher_started' },
        success: true,
      });
    },

    stop(): void {
      if (!running) return;
      running = false;

      if (fsWatcher) {
        fsWatcher.close();
        fsWatcher = null;
      }

      auditLog({
        action: 'config_change',
        details: {
          event: 'live_watcher_stopped',
          tracesReceived: stats.tracesReceived,
          droppedTraces: stats.droppedTraces,
          uptimeMs: Date.now() - stats.startedAt,
        },
        success: true,
      });
    },

    isRunning(): boolean {
      return running;
    },

    getStats(): LiveWatcherStats {
      updateEventsPerSecond();
      return { ...stats, activeWorkflows: new Set(stats.activeWorkflows) };
    },
  };
}
