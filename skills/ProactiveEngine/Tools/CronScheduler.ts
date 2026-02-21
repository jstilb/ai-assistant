#!/usr/bin/env bun
/**
 * ============================================================================
 * CronScheduler - Thin CLI wrapper for the unified Kaya daemon
 * ============================================================================
 *
 * PURPOSE:
 * Delegates all cron daemon lifecycle management to bin/pai-daemon.ts.
 * Provides backward-compatible CLI for ProactiveEngine skill.
 *
 * USAGE:
 *   bun CronScheduler.ts start       Start the unified daemon
 *   bun CronScheduler.ts stop        Stop the unified daemon
 *   bun CronScheduler.ts status      Show status via daemon HTTP API
 *   bun CronScheduler.ts next        Show next scheduled executions
 *   bun CronScheduler.ts --help      Show help
 *
 * ============================================================================
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createCronManager, getNextRunTime } from '../../../lib/cron/CronManager';

const KAYA_DIR = process.env.KAYA_DIR || join(homedir(), '.claude');
const DAEMON_BIN = join(KAYA_DIR, 'bin/pai-daemon.ts');
const DAEMON_DIR = join(KAYA_DIR, 'MEMORY/daemon');
const PID_FILE = join(DAEMON_DIR, 'daemon.pid');
const JOBS_DIR = join(DAEMON_DIR, 'cron/jobs');
const CRON_STATE_DIR = join(DAEMON_DIR, 'cron');

function getDaemonUrl(): string {
  let port = 18000;
  let host = 'localhost';
  try {
    const settings = JSON.parse(readFileSync(join(KAYA_DIR, 'settings.json'), 'utf-8'));
    if (settings.daemon?.port) port = settings.daemon.port;
    if (settings.daemon?.host) host = settings.daemon.host;
  } catch {
    // defaults
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

/**
 * Start: delegates to bun bin/pai-daemon.ts start
 */
async function startDaemon(): Promise<void> {
  if (isDaemonRunning()) {
    console.log('Daemon is already running');
    process.exit(0);
  }

  console.log('Starting unified Kaya daemon...');
  const proc = Bun.spawn(['bun', 'run', DAEMON_BIN, 'start'], {
    cwd: KAYA_DIR,
    stdout: 'inherit',
    stderr: 'inherit',
  });

  // Wait briefly to let it start
  await new Promise(resolve => setTimeout(resolve, 2000));

  if (isDaemonRunning()) {
    console.log('Daemon started');
  } else {
    // It's running in foreground, the process is still going
    await proc.exited;
  }
}

/**
 * Stop: delegates to bun bin/pai-daemon.ts stop
 */
async function stopDaemon(): Promise<void> {
  if (!isDaemonRunning()) {
    console.log('Daemon is not running');
    process.exit(0);
  }

  const proc = Bun.spawn(['bun', 'run', DAEMON_BIN, 'stop'], {
    cwd: KAYA_DIR,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  await proc.exited;
}

/**
 * Status: queries daemon HTTP API, falls back to local state
 */
async function showStatus(): Promise<void> {
  const running = isDaemonRunning();

  console.log('\n  CronScheduler Status\n');

  if (running) {
    try {
      const res = await fetch(`${getDaemonUrl()}/status`);
      const data = await res.json();

      console.log(`  Status: RUNNING (PID: ${data.pid})`);
      console.log(`  Uptime: ${Math.floor(data.uptime / 60)}m`);
      console.log(`  Health: ${data.health}`);

      if (data.cron) {
        console.log(`\n  Jobs:   ${data.cron.enabled}/${data.cron.total} enabled\n`);

        for (const job of data.cron.jobs) {
          const status = job.enabled ? '\x1b[32mENABLED\x1b[0m' : '\x1b[90mDISABLED\x1b[0m';
          console.log(`  ${job.id} [${status}]`);
          console.log(`    Schedule: ${job.schedule} | Type: ${job.type}`);
          if (job.nextRun) console.log(`    Next:     ${job.nextRun}`);
          if (job.lastRun) console.log(`    Last:     ${job.lastRun}`);
          console.log(`    Runs:     ${job.runCount} | Fails: ${job.failCount}`);
          console.log('');
        }
      }
    } catch {
      console.log('  Status: RUNNING (API unreachable)');
    }
  } else {
    console.log('  Status: STOPPED');

    // Load jobs from files for reference
    const manager = createCronManager({ jobsDir: JOBS_DIR, stateDir: CRON_STATE_DIR });
    await manager.loadJobs();
    const jobs = await manager.listJobs();

    console.log(`\n  Configured jobs: ${jobs.length}`);
    console.log(`  Enabled: ${jobs.filter(j => j.enabled).length}\n`);
  }

  console.log('');
}

/**
 * Next: show next scheduled executions (reads local state)
 */
async function showNext(): Promise<void> {
  const manager = createCronManager({ jobsDir: JOBS_DIR, stateDir: CRON_STATE_DIR });
  await manager.loadJobs();
  const jobs = await manager.listJobs();
  const enabled = jobs.filter(j => j.enabled && j.wakeMode === 'schedule');

  if (enabled.length === 0) {
    console.log('No enabled scheduled jobs');
    return;
  }

  console.log('\n  Next Scheduled Executions\n');

  const withNext = enabled.map(job => {
    try {
      return { job, next: getNextRunTime(job.schedule) };
    } catch {
      return { job, next: null };
    }
  }).sort((a, b) => {
    if (!a.next) return 1;
    if (!b.next) return -1;
    return a.next.getTime() - b.next.getTime();
  });

  const now = Date.now();
  for (const { job, next } of withNext) {
    if (!next) {
      console.log(`  ${job.id}: invalid schedule`);
      continue;
    }
    const diff = next.getTime() - now;
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(mins / 60);
    const timeStr = hours > 0 ? `${hours}h ${mins % 60}m` : `${mins}m`;

    console.log(`  ${job.id}`);
    console.log(`    ${next.toISOString().replace('T', ' ').slice(0, 19)} (in ${timeStr})`);
    console.log(`    ${job.task.slice(0, 80)}${job.task.length > 80 ? '...' : ''}\n`);
  }
}

// ============================================================================
// CLI
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
CronScheduler - Manage the Kaya cron daemon

USAGE:
  bun CronScheduler.ts start       Start the unified daemon
  bun CronScheduler.ts stop        Stop the daemon
  bun CronScheduler.ts status      Show status and active jobs
  bun CronScheduler.ts next        Show next scheduled executions
  bun CronScheduler.ts restart     Restart the daemon
  bun CronScheduler.ts --help      Show this help

NOTES:
  This tool delegates to the unified Kaya daemon (bin/pai-daemon.ts).
  Jobs directory: ${JOBS_DIR}
    `);
    process.exit(0);
  }

  const command = args[0];

  try {
    switch (command) {
      case 'start':
        await startDaemon();
        break;
      case 'stop':
        await stopDaemon();
        break;
      case 'status':
        await showStatus();
        break;
      case 'next':
        await showNext();
        break;
      case 'restart':
        await stopDaemon();
        await new Promise(resolve => setTimeout(resolve, 1000));
        await startDaemon();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
