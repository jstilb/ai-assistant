#!/usr/bin/env bun
/**
 * ============================================================================
 * kaya-daemon-ctl - Remote management CLI for Kaya daemon
 * ============================================================================
 *
 * USAGE:
 *   bun bin/kaya-daemon-ctl.ts status              Daemon status
 *   bun bin/kaya-daemon-ctl.ts jobs                 List all cron jobs
 *   bun bin/kaya-daemon-ctl.ts jobs run <jobId>     Trigger a job
 *   bun bin/kaya-daemon-ctl.ts queue                Queue statistics
 *   bun bin/kaya-daemon-ctl.ts health               Health check
 *   bun bin/kaya-daemon-ctl.ts logs [N]             Tail last N log lines
 *
 * ============================================================================
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ============================================================================
// Configuration
// ============================================================================

const KAYA_DIR = process.env.KAYA_DIR || join(homedir(), '.claude');
const DAEMON_DIR = join(KAYA_DIR, 'MEMORY', 'daemon');
const LOG_FILE = join(DAEMON_DIR, 'daemon.jsonl');
const PID_FILE = join(DAEMON_DIR, 'daemon.pid');

function getBaseUrl(): string {
  let port = 18000;
  let host = 'localhost';

  try {
    const settingsPath = join(KAYA_DIR, 'settings.json');
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      if (settings.daemon?.port) port = settings.daemon.port;
      if (settings.daemon?.host) host = settings.daemon.host;
    }
  } catch {
    // Use defaults
  }

  return `http://${host}:${port}`;
}

function isDaemonRunning(): boolean {
  if (!existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fetchJson(path: string, options?: RequestInit): Promise<any> {
  const url = `${getBaseUrl()}${path}`;
  try {
    const res = await fetch(url, options);
    return await res.json();
  } catch (err) {
    console.error(`Failed to connect to daemon at ${url}`);
    console.error('Is the daemon running? Start with: bun bin/kaya-daemon.ts start');
    process.exit(1);
  }
}

// ============================================================================
// Commands
// ============================================================================

async function showStatus(): Promise<void> {
  const data = await fetchJson('/status');

  console.log('\n  Kaya Daemon Status\n');
  console.log(`  PID:      ${data.pid}`);
  console.log(`  Port:     ${data.port}`);
  console.log(`  Uptime:   ${formatUptime(data.uptime)}`);
  console.log(`  Health:   ${formatHealth(data.health)}`);

  if (data.cron) {
    console.log(`\n  Cron:     ${data.cron.enabled}/${data.cron.total} enabled`);
  }

  if (data.queue) {
    console.log(`  Queue:    ${data.queue.pending} pending, ${data.queue.processed} processed, ${data.queue.failed} failed`);
  }

  console.log('');
}

async function showJobs(): Promise<void> {
  const data = await fetchJson('/cron/list');

  if (!data.jobs || data.jobs.length === 0) {
    console.log('\n  No cron jobs configured\n');
    return;
  }

  console.log(`\n  Cron Jobs (${data.count})\n`);

  for (const job of data.jobs) {
    const status = job.enabled ? 'ENABLED' : 'DISABLED';
    const statusColor = job.enabled ? '\x1b[32m' : '\x1b[90m';
    console.log(`  ${statusColor}${job.id}\x1b[0m [${status}]`);
    console.log(`    Schedule: ${job.schedule} | Type: ${job.type} | Output: ${job.output}`);
    if (job.nextRun) {
      const next = new Date(job.nextRun);
      const diff = next.getTime() - Date.now();
      console.log(`    Next:     ${job.nextRun} (${formatDuration(diff)})`);
    }
    if (job.lastRun) {
      console.log(`    Last:     ${job.lastRun}`);
    }
    console.log(`    Runs:     ${job.runCount} | Failures: ${job.failCount}`);
    if (job.task) {
      console.log(`    Task:     ${job.task}`);
    }
    console.log('');
  }
}

async function runJob(jobId: string): Promise<void> {
  console.log(`Triggering job: ${jobId}...`);

  const data = await fetchJson('/cron/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId }),
  });

  if (data.success) {
    console.log(`Job ${jobId} triggered successfully`);
  } else {
    console.error(`Failed to trigger job: ${data.error}`);
    process.exit(1);
  }
}

async function showQueue(): Promise<void> {
  const data = await fetchJson('/queue/status');

  console.log('\n  Message Queue\n');
  console.log(`  Pending:   ${data.pending}`);
  console.log(`  Processed: ${data.processed}`);
  console.log(`  Failed:    ${data.failed}`);
  console.log('');
}

async function showHealth(): Promise<void> {
  const data = await fetchJson('/health');

  console.log(`\n  Health: ${formatHealth(data.status)}\n`);
  console.log(`  Uptime:  ${formatUptime(data.uptime)}`);

  if (data.checks) {
    console.log('\n  Checks:');
    for (const [key, val] of Object.entries(data.checks)) {
      const icon = val ? '\x1b[32mOK\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
      console.log(`    ${key.padEnd(16)} ${icon}`);
    }
  }

  if (data.stats) {
    console.log('\n  Stats:');
    console.log(`    Jobs run:           ${data.stats.totalJobsRun}`);
    console.log(`    Jobs failed:        ${data.stats.totalJobsFailed}`);
    console.log(`    Consecutive fails:  ${data.stats.consecutiveFailures}`);
    console.log(`    Messages processed: ${data.stats.messagesProcessed}`);
  }

  console.log('');
}

function showLogs(count: number): void {
  if (!existsSync(LOG_FILE)) {
    console.log('No log file found');
    return;
  }

  const content = readFileSync(LOG_FILE, 'utf-8').trim();
  if (!content) {
    console.log('Log file is empty');
    return;
  }

  const lines = content.split('\n');
  const tail = lines.slice(-count);

  console.log(`\n  Last ${tail.length} log entries\n`);

  for (const line of tail) {
    try {
      const entry = JSON.parse(line);
      const level = (entry.level || 'info').toUpperCase().padEnd(5);
      const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '';
      console.log(`  [${time}] ${level} ${entry.message}`);
    } catch {
      console.log(`  ${line}`);
    }
  }

  console.log('');
}

// ============================================================================
// Formatting Helpers
// ============================================================================

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hours < 24) return `${hours}h ${mins}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatHealth(status: string): string {
  switch (status) {
    case 'healthy': return '\x1b[32mhealthy\x1b[0m';
    case 'degraded': return '\x1b[33mdegraded\x1b[0m';
    case 'unhealthy': return '\x1b[31munhealthy\x1b[0m';
    default: return status;
  }
}

function formatDuration(ms: number): string {
  if (ms < 0) return 'overdue';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h ${mins % 60}m`;
  return `in ${Math.floor(hours / 24)}d`;
}

// ============================================================================
// CLI
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  switch (command) {
    case 'status':
      await showStatus();
      break;

    case 'jobs':
      if (args[1] === 'run' && args[2]) {
        await runJob(args[2]);
      } else {
        await showJobs();
      }
      break;

    case 'queue':
      await showQueue();
      break;

    case 'health':
      await showHealth();
      break;

    case 'logs': {
      const count = args[1] ? parseInt(args[1], 10) : 20;
      showLogs(count);
      break;
    }

    case 'help':
    case '--help':
    case '-h':
      console.log(`
kaya-daemon-ctl - Remote management CLI for Kaya daemon

Usage:
  kaya-daemon-ctl <command> [args]

Commands:
  status              Show daemon status
  jobs                List all cron jobs
  jobs run <jobId>    Trigger a specific job
  queue               Show message queue stats
  health              Health check with component details
  logs [N]            Show last N log entries (default: 20)

Examples:
  bun bin/kaya-daemon-ctl.ts status
  bun bin/kaya-daemon-ctl.ts jobs
  bun bin/kaya-daemon-ctl.ts jobs run daily-briefing
  bun bin/kaya-daemon-ctl.ts health
  bun bin/kaya-daemon-ctl.ts logs 50
      `);
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run with --help for usage');
      process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
}
