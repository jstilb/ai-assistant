#!/usr/bin/env bun
/**
 * HealthCheck - Dependency health validation for CalendarAssistant
 *
 * Checks Google Calendar API reachability, StateManager writability,
 * and Inference.ts responsiveness. Returns structured health status.
 *
 * Usage:
 *   bun run HealthCheck.ts
 *   import { checkHealth } from './HealthCheck.ts';
 *   const status = await checkHealth();
 */

import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

// ============================================================================
// Types
// ============================================================================

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface DependencyHealth {
  name: string;
  status: HealthStatus;
  latencyMs: number;
  message: string;
}

export interface HealthCheckResult {
  status: HealthStatus;
  timestamp: string;
  dependencies: {
    calendar: DependencyHealth;
    state: DependencyHealth;
    inference: DependencyHealth;
  };
  uptime?: number;
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = join(homedir(), '.claude');
const STATE_TEST_FILE = join(KAYA_HOME, 'state', 'calendar-assistant', '.health-check-test');
const INFERENCE_TOOL = join(KAYA_HOME, 'tools', 'Inference.ts');

// ============================================================================
// Checks
// ============================================================================

async function checkCalendarAPI(): Promise<DependencyHealth> {
  const start = Date.now();
  try {
    // Try to list 1 event via gcalcli to verify OAuth and API access
    execSync('gcalcli list --nocolor 2>&1 | head -1', { timeout: 10000, encoding: 'utf-8' });
    return {
      name: 'Google Calendar API',
      status: 'healthy',
      latencyMs: Date.now() - start,
      message: 'Calendar API reachable',
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const status: HealthStatus = errMsg.includes('403') || errMsg.includes('401') ? 'unhealthy' : 'degraded';
    return {
      name: 'Google Calendar API',
      status,
      latencyMs: Date.now() - start,
      message: errMsg.includes('403') ? 'Calendar access denied. Re-authenticate with: pai calendar auth'
        : errMsg.includes('401') ? 'OAuth token expired. Re-authenticate with: pai calendar auth'
          : `Calendar API error: ${errMsg.slice(0, 80)}`,
    };
  }
}

async function checkStateManager(): Promise<DependencyHealth> {
  const start = Date.now();
  try {
    const dir = require('path').dirname(STATE_TEST_FILE);
    if (!existsSync(dir)) {
      require('fs').mkdirSync(dir, { recursive: true });
    }
    writeFileSync(STATE_TEST_FILE, JSON.stringify({ test: true, timestamp: Date.now() }));
    unlinkSync(STATE_TEST_FILE);
    return {
      name: 'StateManager',
      status: 'healthy',
      latencyMs: Date.now() - start,
      message: 'State directory writable',
    };
  } catch (err) {
    return {
      name: 'StateManager',
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      message: `StateManager not writable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkInference(): Promise<DependencyHealth> {
  const start = Date.now();
  try {
    if (!existsSync(INFERENCE_TOOL)) {
      return {
        name: 'Inference',
        status: 'degraded',
        latencyMs: Date.now() - start,
        message: `Inference tool not found at ${INFERENCE_TOOL}`,
      };
    }
    // Quick echo test
    execSync(`echo "ping" | bun "${INFERENCE_TOOL}" fast 2>&1 | head -1`, { timeout: 15000, encoding: 'utf-8' });
    return {
      name: 'Inference',
      status: 'healthy',
      latencyMs: Date.now() - start,
      message: 'Inference.ts responsive',
    };
  } catch (err) {
    return {
      name: 'Inference',
      status: 'degraded',
      latencyMs: Date.now() - start,
      message: `Inference check failed: ${err instanceof Error ? err.message.slice(0, 60) : 'timeout'}`,
    };
  }
}

// ============================================================================
// Main
// ============================================================================

export async function checkHealth(): Promise<HealthCheckResult> {
  const [calendar, state, inference] = await Promise.all([
    checkCalendarAPI(),
    checkStateManager(),
    checkInference(),
  ]);

  const deps = [calendar, state, inference];
  const allHealthy = deps.every(d => d.status === 'healthy');
  const anyUnhealthy = deps.some(d => d.status === 'unhealthy');

  return {
    status: allHealthy ? 'healthy' : anyUnhealthy ? 'unhealthy' : 'degraded',
    timestamp: new Date().toISOString(),
    dependencies: { calendar, state, inference },
  };
}

// CLI
if (import.meta.main) {
  checkHealth().then(result => {
    const icon = result.status === 'healthy' ? '✅' : result.status === 'degraded' ? '⚠️' : '❌';

    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n${icon} Calendar Assistant Health: ${result.status.toUpperCase()}`);
      console.log(`   Checked: ${result.timestamp}\n`);

      for (const [name, dep] of Object.entries(result.dependencies)) {
        const depIcon = dep.status === 'healthy' ? '✅' : dep.status === 'degraded' ? '⚠️' : '❌';
        console.log(`   ${depIcon} ${dep.name}: ${dep.message} (${dep.latencyMs}ms)`);
      }
      console.log('');
    }
  }).catch(err => {
    console.error(`Health check failed: ${err}`);
    process.exit(1);
  });
}
