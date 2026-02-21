#!/usr/bin/env bun
/**
 * ThrottleManager - Resource throttle configuration and enforcement
 *
 * Calculates throttle limits based on baseline vs current metrics,
 * writes throttle configs for agents to read, monitors compliance,
 * and auto-releases throttles when metrics normalize.
 *
 * Usage:
 *   import { createThrottleManager } from './ThrottleManager.ts';
 *   const manager = createThrottleManager();
 *   await manager.applyThrottle(agentId, config);
 *   manager.releaseThrottle(agentId, metric);
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { auditLog } from './AuditLogger.ts';

// ============================================================================
// Types
// ============================================================================

export interface ThrottleRule {
  metric: 'tokensPerMinute' | 'toolCallsPerMinute' | 'inferencesPerMinute';
  limit: number;
  startedAt: number;
  interventionId: string;
  releaseCondition: {
    metricUnder: number;
    sustainedForMs: number;
  };
}

export interface ThrottleConfig {
  agentId: string;
  throttles: ThrottleRule[];
  previousLimits: Record<string, number | null>;
  updatedAt: number;
}

export interface ThrottleApplication {
  agentId: string;
  metric: ThrottleRule['metric'];
  limit: number;
  interventionId: string;
  releaseCondition?: ThrottleRule['releaseCondition'];
}

export interface ThrottleResult {
  success: boolean;
  agentId: string;
  metric: string;
  appliedLimit?: number;
  previousLimit?: number | null;
  error?: string;
}

export interface ThrottleManager {
  applyThrottle(application: ThrottleApplication): ThrottleResult;
  releaseThrottle(agentId: string, metric: string): ThrottleResult;
  rollbackThrottle(agentId: string): ThrottleResult;
  getActiveThrottles(): ThrottleConfig[];
  getThrottleForAgent(agentId: string): ThrottleConfig | null;
  checkAutoRelease(agentId: string, currentMetrics: Record<string, number>): string[];
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = join(homedir(), '.claude');
const THROTTLES_DIR = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'throttles');
const STATE_DIR = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'state');

// ============================================================================
// Implementation
// ============================================================================

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function throttleFilePath(agentId: string): string {
  return join(THROTTLES_DIR, `${agentId}.json`);
}

function atomicWrite(filePath: string, data: unknown): void {
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  const { renameSync } = require('fs');
  renameSync(tmpPath, filePath);
}

function readThrottleConfig(agentId: string): ThrottleConfig | null {
  const path = throttleFilePath(agentId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

// Track when metrics started being normal (for auto-release)
const normalMetricStart = new Map<string, number>();

export function createThrottleManager(): ThrottleManager {
  return {
    applyThrottle(application: ThrottleApplication): ThrottleResult {
      ensureDir(THROTTLES_DIR);

      const { agentId, metric, limit, interventionId } = application;
      let config = readThrottleConfig(agentId);

      if (!config) {
        config = {
          agentId,
          throttles: [],
          previousLimits: {},
          updatedAt: Date.now(),
        };
      }

      // Check if throttle already exists for this metric
      const existingIdx = config.throttles.findIndex(t => t.metric === metric);
      const previousLimit = existingIdx >= 0 ? config.throttles[existingIdx].limit : null;

      // Store previous limit for rollback
      if (!(metric in config.previousLimits)) {
        config.previousLimits[metric] = previousLimit;
      }

      const rule: ThrottleRule = {
        metric,
        limit,
        startedAt: Date.now(),
        interventionId,
        releaseCondition: application.releaseCondition || {
          metricUnder: Math.floor(limit * 0.7),
          sustainedForMs: 300000,
        },
      };

      if (existingIdx >= 0) {
        config.throttles[existingIdx] = rule;
      } else {
        config.throttles.push(rule);
      }

      config.updatedAt = Date.now();
      atomicWrite(throttleFilePath(agentId), config);

      // Persist active throttles state
      this._persistActiveThrottles();

      auditLog({
        action: 'throttle_applied',
        details: { agentId, metric, limit, interventionId, previousLimit },
        success: true,
      });

      return {
        success: true,
        agentId,
        metric,
        appliedLimit: limit,
        previousLimit,
      };
    },

    releaseThrottle(agentId: string, metric: string): ThrottleResult {
      const config = readThrottleConfig(agentId);
      if (!config) {
        return { success: false, agentId, metric, error: `No throttle config for agent ${agentId}` };
      }

      const idx = config.throttles.findIndex(t => t.metric === metric);
      if (idx < 0) {
        return { success: false, agentId, metric, error: `No throttle for metric ${metric}` };
      }

      const released = config.throttles.splice(idx, 1)[0];
      config.updatedAt = Date.now();

      if (config.throttles.length === 0) {
        // Remove file entirely if no throttles remain
        const { unlinkSync } = require('fs');
        try { unlinkSync(throttleFilePath(agentId)); } catch { /* ok */ }
      } else {
        atomicWrite(throttleFilePath(agentId), config);
      }

      this._persistActiveThrottles();

      auditLog({
        action: 'throttle_released',
        details: { agentId, metric, releasedLimit: released.limit },
        success: true,
      });

      return { success: true, agentId, metric, appliedLimit: released.limit };
    },

    rollbackThrottle(agentId: string): ThrottleResult {
      const config = readThrottleConfig(agentId);
      if (!config) {
        return { success: false, agentId, metric: 'all', error: `No throttle config for agent ${agentId}` };
      }

      // Restore previous limits (remove all current throttles)
      const removedMetrics = config.throttles.map(t => t.metric);
      config.throttles = [];
      config.updatedAt = Date.now();

      const { unlinkSync } = require('fs');
      try { unlinkSync(throttleFilePath(agentId)); } catch { /* ok */ }

      this._persistActiveThrottles();

      auditLog({
        action: 'throttle_rollback',
        details: { agentId, removedMetrics, previousLimits: config.previousLimits },
        success: true,
      });

      return { success: true, agentId, metric: 'all', previousLimit: null };
    },

    getActiveThrottles(): ThrottleConfig[] {
      ensureDir(THROTTLES_DIR);
      const configs: ThrottleConfig[] = [];

      try {
        const files = readdirSync(THROTTLES_DIR).filter(f => f.endsWith('.json') && !f.endsWith('.tmp'));
        for (const file of files) {
          try {
            const config = JSON.parse(readFileSync(join(THROTTLES_DIR, file), 'utf-8'));
            if (config.throttles && config.throttles.length > 0) {
              configs.push(config);
            }
          } catch {
            // Skip malformed files
          }
        }
      } catch {
        // Directory might not exist yet
      }

      return configs;
    },

    getThrottleForAgent(agentId: string): ThrottleConfig | null {
      return readThrottleConfig(agentId);
    },

    checkAutoRelease(agentId: string, currentMetrics: Record<string, number>): string[] {
      const config = readThrottleConfig(agentId);
      if (!config) return [];

      const released: string[] = [];
      const now = Date.now();

      for (const throttle of config.throttles) {
        const currentValue = currentMetrics[throttle.metric];
        if (currentValue === undefined) continue;

        const key = `${agentId}:${throttle.metric}`;

        if (currentValue < throttle.releaseCondition.metricUnder) {
          // Metric is under threshold
          if (!normalMetricStart.has(key)) {
            normalMetricStart.set(key, now);
          }

          const normalDuration = now - normalMetricStart.get(key)!;
          if (normalDuration >= throttle.releaseCondition.sustainedForMs) {
            // Sustained normal — auto release
            this.releaseThrottle(agentId, throttle.metric);
            normalMetricStart.delete(key);
            released.push(throttle.metric);
          }
        } else {
          // Metric still elevated, reset normal timer
          normalMetricStart.delete(key);
        }
      }

      return released;
    },

    _persistActiveThrottles(): void {
      ensureDir(STATE_DIR);
      const active = this.getActiveThrottles();
      const summary = active.map(c => ({
        agentId: c.agentId,
        throttles: c.throttles.map(t => ({ metric: t.metric, limit: t.limit })),
      }));
      atomicWrite(join(STATE_DIR, 'active-throttles.json'), { active: summary, updatedAt: Date.now() });
    },
  } as ThrottleManager & { _persistActiveThrottles(): void };
}
