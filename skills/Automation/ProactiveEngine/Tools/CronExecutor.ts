#!/usr/bin/env bun
/**
 * ============================================================================
 * CronExecutor - Execute cron jobs on demand
 * ============================================================================
 *
 * PURPOSE:
 * CLI tool for manually triggering cron jobs defined in the ProactiveEngine
 * skill. Useful for testing, debugging, or running scheduled tasks immediately.
 *
 * USAGE:
 *   bun CronExecutor.ts run <job-id>     # Execute a specific job
 *   bun CronExecutor.ts run-all          # Execute all enabled jobs
 *   bun CronExecutor.ts list             # List available jobs
 *   bun CronExecutor.ts --help           # Show help
 *
 * FEATURES:
 *   - Execute jobs from ~/.claude/MEMORY/daemon/cron/jobs/*.yaml
 *   - Log execution to ~/.claude/MEMORY/daemon/cron/logs/
 *   - Route output to correct channel (voice, push, discord, silent)
 *   - Production-ready error handling
 *   - Detailed execution reporting
 *
 * ============================================================================
 */

import { existsSync, mkdirSync, readdirSync, appendFileSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';
import { createNotificationService } from '../../../../lib/core/NotificationService';
import type { CronJob } from '../../../../lib/cron/CronManager';
import { CronJobSchema } from '../../../../lib/cron/CronManager';

// ============================================================================
// Configuration
// ============================================================================

const KAYA_DIR = process.env.KAYA_DIR || join(homedir(), '.claude');
const JOBS_DIR = join(KAYA_DIR, 'MEMORY/daemon/cron/jobs');
const LOGS_DIR = join(KAYA_DIR, 'MEMORY/daemon/cron/logs');

// ============================================================================
// Types
// ============================================================================

interface ExecutionResult {
  jobId: string;
  success: boolean;
  duration: number;
  output?: string;
  error?: string;
  timestamp: string;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Ensure logs directory exists
 */
function ensureLogsDir(): void {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
}

/**
 * Log execution result
 */
function logExecution(result: ExecutionResult): void {
  ensureLogsDir();

  const logEntry = {
    ...result,
    timestamp: new Date().toISOString(),
  };

  const logPath = join(LOGS_DIR, 'executions.jsonl');
  appendFileSync(logPath, JSON.stringify(logEntry) + '\n');

  // Also create a job-specific log
  const jobLogPath = join(LOGS_DIR, `${result.jobId}.jsonl`);
  appendFileSync(jobLogPath, JSON.stringify(logEntry) + '\n');
}

/**
 * Load all job YAML files
 */
async function loadJobs(): Promise<CronJob[]> {
  if (!existsSync(JOBS_DIR)) {
    return [];
  }

  const files = readdirSync(JOBS_DIR).filter(
    (f) => f.endsWith('.yaml') || f.endsWith('.yml')
  );

  const jobs: CronJob[] = [];

  for (const file of files) {
    try {
      const content = await Bun.file(join(JOBS_DIR, file)).text();
      const data = parseYaml(content);
      const job = CronJobSchema.parse(data);
      jobs.push(job);
    } catch (error) {
      console.error(`Failed to load job from ${file}:`, error);
    }
  }

  return jobs;
}

const DEFAULT_TIMEOUT = 5 * 60 * 1000; // 5 minutes

/**
 * Execute a cron job by spawning a claude CLI process
 */
async function executeJob(job: CronJob): Promise<ExecutionResult> {
  const startTime = Date.now();
  const notificationService = createNotificationService();

  console.log(`\n━━━ Executing Job: ${job.id} ━━━`);
  console.log(`Type: ${job.type}`);
  console.log(`Output: ${job.output}`);
  console.log(`Task: ${job.task}`);
  console.log('');

  let success = false;
  let output: string | undefined;
  let error: string | undefined;

  try {
    const prompt = [
      `You are executing a scheduled Kaya cron job.`,
      `Job ID: ${job.id}`,
      `Task: ${job.task}`,
      `Output mode: ${job.output}`,
      `Execute the task and provide a concise summary of what you accomplished.`,
    ].join('\n');

    const proc = Bun.spawn(['claude', '-p', prompt, '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep'], {
      cwd: join(homedir(), '.claude'),
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        KAYA_CRON_JOB_ID: job.id,
      },
    });

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      console.warn(`Job ${job.id} timed out after ${DEFAULT_TIMEOUT}ms, killing...`);
      proc.kill();
    }, DEFAULT_TIMEOUT);

    // Wait for completion
    const exitCode = await proc.exited;
    clearTimeout(timeoutHandle);

    // Read output
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    success = exitCode === 0;
    output = stdout.trim() || undefined;
    error = !success ? (stderr.trim() || `Exit code: ${exitCode}`) : undefined;

    // Route notification based on output mode (post-execution, with actual results)
    if (output && job.output !== 'silent') {
      const truncated = output.slice(0, 500);
      const channel = job.output === 'text' ? 'push' : (job.output === 'both' ? 'voice' : job.output);
      await notificationService.notify(`Cron [${job.id}]: ${truncated}`, {
        channel: channel as 'voice' | 'push' | 'discord',
        agentName: 'ProactiveEngine',
      });
    }

    if (success) {
      console.log(`✓ Success${output ? `: ${output.slice(0, 200)}` : ''}`);
    } else {
      console.error(`✗ Failed: ${error}`);
    }
  } catch (err) {
    success = false;
    error = err instanceof Error ? err.message : String(err);
    console.error(`✗ Failed: ${error}`);
  }

  const duration = Date.now() - startTime;

  const result: ExecutionResult = {
    jobId: job.id,
    success,
    duration,
    output: output?.slice(0, 1000),
    error,
    timestamp: new Date().toISOString(),
  };

  logExecution(result);

  console.log(`Duration: ${duration}ms`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  return result;
}

/**
 * List all jobs
 */
async function listJobs(): Promise<void> {
  const jobs = await loadJobs();

  if (jobs.length === 0) {
    console.log('No jobs found in', JOBS_DIR);
    return;
  }

  console.log('\nAvailable Cron Jobs:\n');

  for (const job of jobs) {
    const status = job.enabled ? '✓ ENABLED' : '✗ DISABLED';
    console.log(`${job.id} [${status}]`);
    console.log(`  Type: ${job.type}`);
    console.log(`  Schedule: ${job.schedule}`);
    console.log(`  Output: ${job.output}`);
    console.log(`  Task: ${job.task.slice(0, 80)}${job.task.length > 80 ? '...' : ''}`);
    console.log('');
  }
}

/**
 * Run a specific job
 */
async function runJob(jobId: string): Promise<void> {
  const jobs = await loadJobs();
  const job = jobs.find((j) => j.id === jobId);

  if (!job) {
    console.error(`Job not found: ${jobId}`);
    console.error(`Available jobs: ${jobs.map((j) => j.id).join(', ')}`);
    process.exit(1);
  }

  const result = await executeJob(job);

  if (!result.success) {
    process.exit(1);
  }
}

/**
 * Run all enabled jobs
 */
async function runAllJobs(): Promise<void> {
  const jobs = await loadJobs();
  const enabledJobs = jobs.filter((j) => j.enabled);

  if (enabledJobs.length === 0) {
    console.log('No enabled jobs to run');
    return;
  }

  console.log(`Running ${enabledJobs.length} enabled job(s)...\n`);

  const results: ExecutionResult[] = [];

  for (const job of enabledJobs) {
    const result = await executeJob(job);
    results.push(result);
  }

  // Summary
  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  console.log('\n━━━ Execution Summary ━━━');
  console.log(`Total: ${results.length}`);
  console.log(`Successful: ${successful}`);
  console.log(`Failed: ${failed}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (failed > 0) {
    process.exit(1);
  }
}

// ============================================================================
// CLI
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
CronExecutor - Execute cron jobs on demand

USAGE:
  bun CronExecutor.ts run <job-id>     Execute a specific job
  bun CronExecutor.ts run-all          Execute all enabled jobs
  bun CronExecutor.ts list             List available jobs
  bun CronExecutor.ts --help           Show this help

EXAMPLES:
  # List all jobs
  bun CronExecutor.ts list

  # Run a specific job
  bun CronExecutor.ts run daily-briefing

  # Run all enabled jobs
  bun CronExecutor.ts run-all

NOTES:
  - Jobs are loaded from: ${JOBS_DIR}
  - Logs are written to: ${LOGS_DIR}
  - Output is routed based on job.output (voice, text, both, push, discord, silent)
    `);
    process.exit(0);
  }

  const command = args[0];

  try {
    if (command === 'list') {
      await listJobs();
    } else if (command === 'run') {
      const jobId = args[1];
      if (!jobId) {
        console.error('Error: Job ID required');
        console.error('Usage: bun CronExecutor.ts run <job-id>');
        process.exit(1);
      }
      await runJob(jobId);
    } else if (command === 'run-all') {
      await runAllJobs();
    } else {
      console.error(`Unknown command: ${command}`);
      console.error('Use --help for usage information');
      process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
