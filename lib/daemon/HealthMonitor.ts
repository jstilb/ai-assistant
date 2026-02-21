#!/usr/bin/env bun
/**
 * ============================================================================
 * HealthMonitor - Daemon health monitoring via EventBus
 * ============================================================================
 *
 * PURPOSE:
 * Subscribes to EventBus events and tracks daemon health status.
 * Detects degradation (consecutive failures) and unhealthy states
 * (components stopped).
 *
 * USAGE:
 *   const monitor = createHealthMonitor({ eventBus });
 *   monitor.start();
 *
 *   // Check health
 *   const health = monitor.getHealth();
 *   // { status: 'healthy', checks: {...}, failureRate: 0, ... }
 *
 * ============================================================================
 */

import type { EventBus, DaemonEvent } from '../messaging/EventBus';

// ============================================================================
// Types
// ============================================================================

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface HealthCheck {
  status: HealthStatus;
  uptime: number;
  checks: {
    cronManager: boolean;
    messageQueue: boolean;
    webSocket: boolean;
    stateStorage: boolean;
  };
  stats: {
    totalJobsRun: number;
    totalJobsFailed: number;
    consecutiveFailures: number;
    messagesProcessed: number;
    lastJobTime?: number;
    lastQueueProcessTime?: number;
  };
  timestamp: string;
}

export interface HealthMonitorConfig {
  /** EventBus to subscribe to */
  eventBus: EventBus;
  /** Consecutive failures before degraded status (default: 3) */
  degradedThreshold?: number;
  /** Consecutive failures before unhealthy status (default: 10) */
  unhealthyThreshold?: number;
  /** Stale check interval - if no events for this long, degrade (ms, default: 600000 = 10min) */
  staleThresholdMs?: number;
}

export interface HealthMonitor {
  /** Start monitoring */
  start(): void;
  /** Stop monitoring */
  stop(): void;
  /** Get current health status */
  getHealth(): HealthCheck;
  /** Manually set a check status */
  setCheck(check: keyof HealthCheck['checks'], status: boolean): void;
}

// ============================================================================
// Implementation
// ============================================================================

export function createHealthMonitor(config: HealthMonitorConfig): HealthMonitor {
  const {
    eventBus,
    degradedThreshold = 3,
    unhealthyThreshold = 10,
    staleThresholdMs = 600000,
  } = config;

  const startTime = Date.now();

  // Health check state
  const checks = {
    cronManager: true,
    messageQueue: true,
    webSocket: true,
    stateStorage: true,
  };

  // Stats
  let totalJobsRun = 0;
  let totalJobsFailed = 0;
  let consecutiveFailures = 0;
  let messagesProcessed = 0;
  let lastEventTime = Date.now();
  let lastJobTime: number | undefined;
  let lastQueueProcessTime: number | undefined;

  // Cleanup functions for event subscriptions
  const unsubscribers: (() => void)[] = [];
  let staleCheckInterval: Timer | null = null;

  function computeStatus(): HealthStatus {
    // Check for unhealthy conditions
    if (consecutiveFailures >= unhealthyThreshold) return 'unhealthy';
    if (!checks.cronManager || !checks.messageQueue) return 'unhealthy';

    // Check for degraded conditions
    if (consecutiveFailures >= degradedThreshold) return 'degraded';
    if (!checks.webSocket || !checks.stateStorage) return 'degraded';

    // Check for stale events
    if (Date.now() - lastEventTime > staleThresholdMs) return 'degraded';

    return 'healthy';
  }

  function handleEvent(event: DaemonEvent): void {
    lastEventTime = Date.now();

    switch (event.type) {
      case 'job.completed':
        totalJobsRun++;
        lastJobTime = event.timestamp;
        if (event.success) {
          consecutiveFailures = 0;
        } else {
          totalJobsFailed++;
          consecutiveFailures++;
        }
        break;

      case 'job.failed':
        totalJobsRun++;
        totalJobsFailed++;
        consecutiveFailures++;
        lastJobTime = event.timestamp;
        break;

      case 'job.started':
        lastJobTime = event.timestamp;
        break;

      case 'queue.processed':
        messagesProcessed += event.count;
        lastQueueProcessTime = event.timestamp;
        break;

      case 'daemon.health':
        // External health signal (e.g., from WebSocket or HTTP layer)
        break;
    }

    // Emit health status on significant changes
    const currentStatus = computeStatus();
    eventBus.emit({
      type: 'daemon.health',
      status: currentStatus,
      details: currentStatus !== 'healthy'
        ? `Consecutive failures: ${consecutiveFailures}, checks: ${JSON.stringify(checks)}`
        : undefined,
      timestamp: Date.now(),
    });
  }

  function start(): void {
    // Subscribe to all events
    unsubscribers.push(eventBus.on('job.completed', handleEvent));
    unsubscribers.push(eventBus.on('job.failed', handleEvent));
    unsubscribers.push(eventBus.on('job.started', handleEvent));
    unsubscribers.push(eventBus.on('queue.processed', handleEvent));

    // Periodic stale check
    staleCheckInterval = setInterval(() => {
      if (Date.now() - lastEventTime > staleThresholdMs) {
        eventBus.emit({
          type: 'daemon.health',
          status: 'degraded',
          details: `No events received for ${Math.floor((Date.now() - lastEventTime) / 1000)}s`,
          timestamp: Date.now(),
        });
      }
    }, Math.min(staleThresholdMs / 2, 60000));
  }

  function stop(): void {
    for (const unsub of unsubscribers) {
      unsub();
    }
    unsubscribers.length = 0;

    if (staleCheckInterval) {
      clearInterval(staleCheckInterval);
      staleCheckInterval = null;
    }
  }

  function getHealth(): HealthCheck {
    return {
      status: computeStatus(),
      uptime: Math.floor((Date.now() - startTime) / 1000),
      checks: { ...checks },
      stats: {
        totalJobsRun,
        totalJobsFailed,
        consecutiveFailures,
        messagesProcessed,
        lastJobTime,
        lastQueueProcessTime,
      },
      timestamp: new Date().toISOString(),
    };
  }

  function setCheck(check: keyof HealthCheck['checks'], status: boolean): void {
    checks[check] = status;
  }

  return { start, stop, getHealth, setCheck };
}
