#!/usr/bin/env bun
/**
 * ============================================================================
 * CronManager - Production-grade cron job scheduling for Kaya
 * ============================================================================
 *
 * PURPOSE:
 * Provides robust cron-style job scheduling with two execution modes:
 *   1. Main Session Jobs: Enqueue system events for processing in active session
 *   2. Isolated Session Jobs: Spawn dedicated agent turns for autonomous execution
 *
 * FEATURES:
 *   - Standard cron expression parsing (minute, hour, day, month, weekday)
 *   - YAML-based job definitions from MEMORY/daemon/cron/jobs/
 *   - Persistent job state and execution history
 *   - wakeMode: "now" for immediate execution
 *   - Enable/disable individual jobs
 *   - Execution callbacks for flexible integration
 *   - CLI interface for management
 *
 * USAGE:
 *   // Programmatic
 *   import { createCronManager } from "./CronManager";
 *
 *   const manager = createCronManager({
 *     jobsDir: "~/.claude/MEMORY/daemon/cron/jobs",
 *     stateDir: "~/.claude/MEMORY/daemon/cron",
 *   });
 *
 *   await manager.start();
 *
 *   // Register callback for job execution
 *   manager.onJobExecute(async (job) => {
 *     if (job.type === 'isolated') {
 *       // Spawn dedicated agent turn
 *     } else {
 *       // Enqueue system event
 *     }
 *   });
 *
 * CLI:
 *   bun lib/cron/CronManager.ts --list                    # List all jobs
 *   bun lib/cron/CronManager.ts --run <jobId>             # Run job now
 *   bun lib/cron/CronManager.ts --add <yamlPath>          # Add job from YAML
 *   bun lib/cron/CronManager.ts --enable <jobId>          # Enable job
 *   bun lib/cron/CronManager.ts --disable <jobId>         # Disable job
 *   bun lib/cron/CronManager.ts --status <jobId>          # Show job status
 *   bun lib/cron/CronManager.ts --daemon                  # Run as daemon
 *   bun lib/cron/CronManager.ts --test                    # Self-test
 *
 * JOB YAML FORMAT:
 *   id: daily-briefing
 *   schedule: "0 8 * * *"           # 8am daily
 *   type: isolated                  # isolated | main
 *   task: |
 *     Generate morning briefing with calendar, tasks, weather
 *   output: voice                   # voice | text | both | push | discord | silent
 *   enabled: true
 *   wakeMode: schedule              # schedule | now
 *
 * CRON EXPRESSION FORMAT:
 *   Minute Hour Day Month Weekday
 *   (0-59) (0-23) (1-31) (1-12) (0-6, Sunday=0)
 *
 * EXAMPLES:
 *   - Daily at 8am: "0 8 * * *"
 *   - Every 15 minutes: "star/15 * * * *" (replace star with asterisk)
 *   - Weekly on Sunday at midnight: "0 0 * * 0"
 *   - Monthly on the 1st at 9am: "0 9 1 * *"
 *   - Weekdays at 2:30pm: "30 14 * * 1-5"
 *
 * ============================================================================
 */

import { z } from "zod";
import { join, dirname, basename } from "path";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";
import { createStateManager } from "../../skills/CORE/Tools/StateManager";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Job execution type
 */
export type JobType = 'isolated' | 'main';

/**
 * Job output mode
 *
 * - voice: Send to voice server for TTS
 * - text: Written output only (log, display)
 * - both: Voice + text
 * - push: Send push notification (mobile)
 * - discord: Post to Discord channel
 * - silent: Execute without notification (log only)
 */
export type OutputMode = 'voice' | 'text' | 'both' | 'push' | 'discord' | 'silent';

/**
 * Wake mode for job execution
 */
export type WakeMode = 'schedule' | 'now';

/**
 * Cron job definition schema
 */
export const CronJobSchema = z.object({
  id: z.string(),
  schedule: z.string(),
  type: z.enum(['isolated', 'main']),
  task: z.string(),
  output: z.enum(['voice', 'text', 'both', 'push', 'discord', 'telegram', 'silent']).default('voice'),
  enabled: z.boolean().default(true),
  wakeMode: z.enum(['schedule', 'now']).default('schedule'),
  timeout: z.number().optional().default(300000), // 5 min default for isolated jobs
  lastRun: z.string().optional(),
  nextRun: z.string().optional(),
  runCount: z.number().default(0),
  failCount: z.number().default(0),
});

export type CronJob = z.infer<typeof CronJobSchema>;

/**
 * Job execution history entry
 */
export const JobExecutionSchema = z.object({
  jobId: z.string(),
  timestamp: z.string(),
  success: z.boolean(),
  duration: z.number(),
  error: z.string().optional(),
  output: z.string().optional(),
});

export type JobExecution = z.infer<typeof JobExecutionSchema>;

/**
 * Cron state schema
 */
export const CronStateSchema = z.object({
  jobs: z.array(CronJobSchema),
  history: z.array(JobExecutionSchema),
  lastCheck: z.string().optional(),
});

export type CronState = z.infer<typeof CronStateSchema>;

/**
 * Options for creating CronManager
 */
export interface CronManagerOptions {
  /** Directory containing job YAML files */
  jobsDir?: string;
  /** Directory for persistent state */
  stateDir?: string;
  /** Check interval in milliseconds (default: 60000 = 1 minute) */
  checkInterval?: number;
  /** Maximum execution history entries per job (default: 100) */
  maxHistoryPerJob?: number;
}

/**
 * Callback for job execution
 */
export type JobExecuteCallback = (job: CronJob) => Promise<{ success: boolean; output?: string; error?: string }>;

// ============================================================================
// CRON EXPRESSION PARSER
// ============================================================================

/**
 * Parse a cron expression and determine if it matches the current time
 */
function matchesCronExpression(expression: string, date: Date = new Date()): boolean {
  const parts = expression.trim().split(/\s+/);

  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${expression} (expected 5 fields)`);
  }

  const [minuteExpr, hourExpr, dayExpr, monthExpr, weekdayExpr] = parts;

  const minute = date.getMinutes();
  const hour = date.getHours();
  const day = date.getDate();
  const month = date.getMonth() + 1; // JS months are 0-indexed
  const weekday = date.getDay(); // Sunday = 0

  return (
    matchesField(minuteExpr, minute, 0, 59) &&
    matchesField(hourExpr, hour, 0, 23) &&
    matchesField(dayExpr, day, 1, 31) &&
    matchesField(monthExpr, month, 1, 12) &&
    matchesField(weekdayExpr, weekday, 0, 6)
  );
}

/**
 * Check if a field expression matches the current value
 */
function matchesField(expr: string, value: number, min: number, max: number): boolean {
  // Wildcard
  if (expr === '*') return true;

  // Step values (*/n)
  if (expr.startsWith('*/')) {
    const step = parseInt(expr.slice(2), 10);
    if (isNaN(step)) throw new Error(`Invalid step value: ${expr}`);
    return value % step === 0;
  }

  // Range (n-m)
  if (expr.includes('-')) {
    const [start, end] = expr.split('-').map(s => parseInt(s, 10));
    if (isNaN(start) || isNaN(end)) throw new Error(`Invalid range: ${expr}`);
    return value >= start && value <= end;
  }

  // List (n,m,o)
  if (expr.includes(',')) {
    const values = expr.split(',').map(s => parseInt(s, 10));
    if (values.some(isNaN)) throw new Error(`Invalid list: ${expr}`);
    return values.includes(value);
  }

  // Single value
  const target = parseInt(expr, 10);
  if (isNaN(target)) throw new Error(`Invalid value: ${expr}`);
  return value === target;
}

/**
 * Calculate the next run time for a cron expression
 */
function getNextRunTime(expression: string, from: Date = new Date()): Date {
  // Start from the next minute
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);

  // Check up to 4 years in the future (conservative limit)
  const maxIterations = 4 * 365 * 24 * 60;

  for (let i = 0; i < maxIterations; i++) {
    if (matchesCronExpression(expression, next)) {
      return next;
    }
    next.setMinutes(next.getMinutes() + 1);
  }

  throw new Error(`Could not find next run time for expression: ${expression}`);
}

// ============================================================================
// CRON MANAGER
// ============================================================================

/**
 * CronManager interface
 */
export interface CronManager {
  /** Start the cron scheduler */
  start(): Promise<void>;

  /** Stop the cron scheduler */
  stop(): void;

  /** Load jobs from YAML directory */
  loadJobs(): Promise<void>;

  /** Add a job from YAML content */
  addJob(yamlContent: string): Promise<void>;

  /** Add a job from file path */
  addJobFromFile(path: string): Promise<void>;

  /** Remove a job */
  removeJob(jobId: string): Promise<void>;

  /** Enable a job */
  enableJob(jobId: string): Promise<void>;

  /** Disable a job */
  disableJob(jobId: string): Promise<void>;

  /** Execute a job immediately */
  runJobNow(jobId: string): Promise<void>;

  /** List all jobs */
  listJobs(): Promise<CronJob[]>;

  /** Get job status */
  getJobStatus(jobId: string): Promise<CronJob | null>;

  /** Get job execution history */
  getJobHistory(jobId: string, limit?: number): Promise<JobExecution[]>;

  /** Register callback for job execution */
  onJobExecute(callback: JobExecuteCallback): void;

  /** Check if scheduler is running */
  isRunning(): boolean;
}

/**
 * Create a CronManager instance
 */
export function createCronManager(options: CronManagerOptions = {}): CronManager {
  const homeDir = homedir();
  const jobsDir = options.jobsDir?.replace('~', homeDir) || join(homeDir, '.claude/MEMORY/daemon/cron/jobs');
  const stateDir = options.stateDir?.replace('~', homeDir) || join(homeDir, '.claude/MEMORY/daemon/cron');
  const checkInterval = options.checkInterval || 60000; // 1 minute
  const maxHistoryPerJob = options.maxHistoryPerJob || 100;

  // Ensure directories exist
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }

  const statePath = join(stateDir, 'state.json');
  const stateManager = createStateManager<CronState>({
    path: statePath,
    schema: CronStateSchema,
    defaults: { jobs: [], history: [] },
    backupOnWrite: false,
  });

  let running = false;
  let intervalId: NodeJS.Timeout | null = null;
  let executeCallback: JobExecuteCallback | null = null;

  /**
   * Load jobs from YAML directory
   */
  async function loadJobs(): Promise<void> {
    if (!existsSync(jobsDir)) {
      console.warn(`Jobs directory does not exist: ${jobsDir}`);
      return;
    }

    const files = readdirSync(jobsDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    const state = await stateManager.load();

    for (const file of files) {
      const content = readFileSync(join(jobsDir, file), 'utf-8');
      const jobData = parseYaml(content);

      try {
        const job = CronJobSchema.parse(jobData);

        // Calculate next run time
        if (job.wakeMode === 'schedule') {
          job.nextRun = getNextRunTime(job.schedule).toISOString();
        }

        // Update or add job
        const existingIndex = state.jobs.findIndex(j => j.id === job.id);
        if (existingIndex >= 0) {
          // Preserve run counts and last run
          job.runCount = state.jobs[existingIndex].runCount;
          job.failCount = state.jobs[existingIndex].failCount;
          job.lastRun = state.jobs[existingIndex].lastRun;
          state.jobs[existingIndex] = job;
        } else {
          state.jobs.push(job);
        }
      } catch (error) {
        console.error(`Failed to parse job from ${file}:`, error);
      }
    }

    await stateManager.save(state);
  }

  /**
   * Add a job from YAML content
   */
  async function addJob(yamlContent: string): Promise<void> {
    const jobData = parseYaml(yamlContent);
    const job = CronJobSchema.parse(jobData);

    if (job.wakeMode === 'schedule') {
      job.nextRun = getNextRunTime(job.schedule).toISOString();
    }

    await stateManager.update(state => {
      const existingIndex = state.jobs.findIndex(j => j.id === job.id);
      if (existingIndex >= 0) {
        state.jobs[existingIndex] = job;
      } else {
        state.jobs.push(job);
      }
      return state;
    });
  }

  /**
   * Add a job from file path
   */
  async function addJobFromFile(path: string): Promise<void> {
    const content = readFileSync(path, 'utf-8');
    await addJob(content);
  }

  /**
   * Remove a job
   */
  async function removeJob(jobId: string): Promise<void> {
    await stateManager.update(state => ({
      ...state,
      jobs: state.jobs.filter(j => j.id !== jobId),
    }));
  }

  /**
   * Enable a job
   */
  async function enableJob(jobId: string): Promise<void> {
    await stateManager.update(state => {
      const job = state.jobs.find(j => j.id === jobId);
      if (job) {
        job.enabled = true;
        if (job.wakeMode === 'schedule') {
          job.nextRun = getNextRunTime(job.schedule).toISOString();
        }
      }
      return state;
    });
  }

  /**
   * Disable a job
   */
  async function disableJob(jobId: string): Promise<void> {
    await stateManager.update(state => {
      const job = state.jobs.find(j => j.id === jobId);
      if (job) {
        job.enabled = false;
        job.nextRun = undefined;
      }
      return state;
    });
  }

  /**
   * Execute a job
   */
  async function executeJob(job: CronJob): Promise<void> {
    const startTime = Date.now();

    console.log(`[CronManager] Executing job: ${job.id}`);

    let success = false;
    let output: string | undefined;
    let error: string | undefined;

    try {
      if (executeCallback) {
        const result = await executeCallback(job);
        success = result.success;
        output = result.output;
        error = result.error;
      } else {
        console.warn(`[CronManager] No execute callback registered for job: ${job.id}`);
        success = true;
      }
    } catch (err) {
      success = false;
      error = err instanceof Error ? err.message : String(err);
      console.error(`[CronManager] Job execution failed: ${job.id}`, err);
    }

    const duration = Date.now() - startTime;

    // Update job state and add history
    await stateManager.update(state => {
      const jobIndex = state.jobs.findIndex(j => j.id === job.id);
      if (jobIndex >= 0) {
        state.jobs[jobIndex].lastRun = new Date().toISOString();
        state.jobs[jobIndex].runCount++;

        if (!success) {
          state.jobs[jobIndex].failCount++;
        }

        // Calculate next run
        if (state.jobs[jobIndex].wakeMode === 'schedule' && state.jobs[jobIndex].enabled) {
          state.jobs[jobIndex].nextRun = getNextRunTime(state.jobs[jobIndex].schedule).toISOString();
        }
      }

      // Add to history
      state.history.push({
        jobId: job.id,
        timestamp: new Date().toISOString(),
        success,
        duration,
        error,
        output,
      });

      // Trim history per job
      const jobHistory = state.history.filter(h => h.jobId === job.id);
      if (jobHistory.length > maxHistoryPerJob) {
        const toRemove = jobHistory.slice(0, jobHistory.length - maxHistoryPerJob);
        state.history = state.history.filter(h => !toRemove.includes(h));
      }

      return state;
    });

    console.log(`[CronManager] Job ${job.id} completed in ${duration}ms (success: ${success})`);
  }

  /**
   * Run a job immediately
   */
  async function runJobNow(jobId: string): Promise<void> {
    const state = await stateManager.load();
    const job = state.jobs.find(j => j.id === jobId);

    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    await executeJob(job);
  }

  /**
   * Check for jobs that need to run
   */
  async function checkJobs(): Promise<void> {
    const state = await stateManager.load();
    const now = new Date();

    for (const job of state.jobs) {
      if (!job.enabled) continue;

      let shouldRun = false;

      if (job.wakeMode === 'now') {
        shouldRun = true;
        // Change to schedule mode after first run
        await stateManager.update(s => {
          const j = s.jobs.find(j => j.id === job.id);
          if (j) j.wakeMode = 'schedule';
          return s;
        });
      } else if (job.wakeMode === 'schedule') {
        shouldRun = matchesCronExpression(job.schedule, now);
      }

      if (shouldRun) {
        // Execute in background to avoid blocking
        executeJob(job).catch(err => {
          console.error(`[CronManager] Unhandled error executing job ${job.id}:`, err);
        });
      }
    }

    // Update last check time
    await stateManager.update(state => ({
      ...state,
      lastCheck: now.toISOString(),
    }));
  }

  /**
   * Start the scheduler
   */
  async function start(): Promise<void> {
    if (running) {
      console.warn('[CronManager] Already running');
      return;
    }

    console.log('[CronManager] Starting...');

    // Load jobs from directory
    await loadJobs();

    running = true;

    // Initial check
    await checkJobs();

    // Schedule periodic checks
    intervalId = setInterval(() => {
      checkJobs().catch(err => {
        console.error('[CronManager] Error during scheduled check:', err);
      });
    }, checkInterval);

    console.log(`[CronManager] Started (check interval: ${checkInterval}ms)`);
  }

  /**
   * Stop the scheduler
   */
  function stop(): void {
    if (!running) {
      console.warn('[CronManager] Not running');
      return;
    }

    console.log('[CronManager] Stopping...');

    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }

    running = false;

    console.log('[CronManager] Stopped');
  }

  /**
   * List all jobs
   */
  async function listJobs(): Promise<CronJob[]> {
    const state = await stateManager.load();
    return state.jobs;
  }

  /**
   * Get job status
   */
  async function getJobStatus(jobId: string): Promise<CronJob | null> {
    const state = await stateManager.load();
    return state.jobs.find(j => j.id === jobId) || null;
  }

  /**
   * Get job execution history
   */
  async function getJobHistory(jobId: string, limit: number = 10): Promise<JobExecution[]> {
    const state = await stateManager.load();
    return state.history
      .filter(h => h.jobId === jobId)
      .slice(-limit)
      .reverse();
  }

  /**
   * Register callback for job execution
   */
  function onJobExecute(callback: JobExecuteCallback): void {
    executeCallback = callback;
  }

  /**
   * Check if scheduler is running
   */
  function isRunning(): boolean {
    return running;
  }

  return {
    start,
    stop,
    loadJobs,
    addJob,
    addJobFromFile,
    removeJob,
    enableJob,
    disableJob,
    runJobNow,
    listJobs,
    getJobStatus,
    getJobHistory,
    onJobExecute,
    isRunning,
  };
}

// ============================================================================
// CLI
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
CronManager - Production-grade cron job scheduling for Kaya

USAGE:
  bun lib/cron/CronManager.ts [COMMAND] [OPTIONS]

COMMANDS:
  --list                    List all jobs with status
  --run <jobId>             Execute job immediately
  --add <yamlPath>          Add job from YAML file
  --enable <jobId>          Enable a job
  --disable <jobId>         Disable a job
  --remove <jobId>          Remove a job
  --status <jobId>          Show detailed job status
  --history <jobId> [N]     Show last N executions (default: 10)
  --daemon                  Run as daemon (blocks)
  --test                    Run self-test
  --help                    Show this help

EXAMPLES:
  # List all jobs
  bun lib/cron/CronManager.ts --list

  # Run a job immediately
  bun lib/cron/CronManager.ts --run daily-briefing

  # Add a new job
  bun lib/cron/CronManager.ts --add ~/job.yaml

  # Start daemon mode
  bun lib/cron/CronManager.ts --daemon
`);
    process.exit(0);
  }

  const manager = createCronManager();

  async function main() {
    const command = args[0];

    try {
      if (command === '--list') {
        // Load jobs from directory first
        await manager.loadJobs();
        const jobs = await manager.listJobs();

        if (jobs.length === 0) {
          console.log('No jobs configured');
          return;
        }

        console.log('\nConfigured Jobs:\n');

        for (const job of jobs) {
          const status = job.enabled ? '✓ ENABLED' : '✗ DISABLED';
          console.log(`${job.id} [${status}]`);
          console.log(`  Type: ${job.type}`);
          console.log(`  Schedule: ${job.schedule}`);
          console.log(`  Wake Mode: ${job.wakeMode}`);
          if (job.nextRun) console.log(`  Next Run: ${job.nextRun}`);
          if (job.lastRun) console.log(`  Last Run: ${job.lastRun}`);
          console.log(`  Runs: ${job.runCount} | Failures: ${job.failCount}`);
          console.log(`  Task: ${job.task.slice(0, 60)}${job.task.length > 60 ? '...' : ''}`);
          console.log('');
        }
      } else if (command === '--run') {
        const jobId = args[1];
        if (!jobId) {
          console.error('Error: Job ID required');
          process.exit(1);
        }

        console.log(`Running job: ${jobId}...`);
        await manager.runJobNow(jobId);
        console.log('Job completed');
      } else if (command === '--add') {
        const yamlPath = args[1];
        if (!yamlPath) {
          console.error('Error: YAML file path required');
          process.exit(1);
        }

        console.log(`Adding job from: ${yamlPath}...`);
        await manager.addJobFromFile(yamlPath);
        console.log('Job added successfully');
      } else if (command === '--enable') {
        const jobId = args[1];
        if (!jobId) {
          console.error('Error: Job ID required');
          process.exit(1);
        }

        console.log(`Enabling job: ${jobId}...`);
        await manager.enableJob(jobId);
        console.log('Job enabled');
      } else if (command === '--disable') {
        const jobId = args[1];
        if (!jobId) {
          console.error('Error: Job ID required');
          process.exit(1);
        }

        console.log(`Disabling job: ${jobId}...`);
        await manager.disableJob(jobId);
        console.log('Job disabled');
      } else if (command === '--remove') {
        const jobId = args[1];
        if (!jobId) {
          console.error('Error: Job ID required');
          process.exit(1);
        }

        console.log(`Removing job: ${jobId}...`);
        await manager.removeJob(jobId);
        console.log('Job removed');
      } else if (command === '--status') {
        const jobId = args[1];
        if (!jobId) {
          console.error('Error: Job ID required');
          process.exit(1);
        }

        const job = await manager.getJobStatus(jobId);

        if (!job) {
          console.error(`Job not found: ${jobId}`);
          process.exit(1);
        }

        console.log(`\nJob: ${job.id}\n`);
        console.log(`Status: ${job.enabled ? 'ENABLED' : 'DISABLED'}`);
        console.log(`Type: ${job.type}`);
        console.log(`Schedule: ${job.schedule}`);
        console.log(`Wake Mode: ${job.wakeMode}`);
        console.log(`Output: ${job.output}`);
        if (job.nextRun) console.log(`Next Run: ${job.nextRun}`);
        if (job.lastRun) console.log(`Last Run: ${job.lastRun}`);
        console.log(`Total Runs: ${job.runCount}`);
        console.log(`Failures: ${job.failCount}`);
        console.log(`\nTask:\n${job.task}`);
      } else if (command === '--history') {
        const jobId = args[1];
        const limit = args[2] ? parseInt(args[2], 10) : 10;

        if (!jobId) {
          console.error('Error: Job ID required');
          process.exit(1);
        }

        const history = await manager.getJobHistory(jobId, limit);

        if (history.length === 0) {
          console.log(`No execution history for job: ${jobId}`);
          return;
        }

        console.log(`\nExecution History for ${jobId}:\n`);

        for (const entry of history) {
          const status = entry.success ? '✓ SUCCESS' : '✗ FAILED';
          console.log(`${entry.timestamp} [${status}] (${entry.duration}ms)`);
          if (entry.output) console.log(`  Output: ${entry.output}`);
          if (entry.error) console.log(`  Error: ${entry.error}`);
        }
      } else if (command === '--daemon') {
        console.log('Starting CronManager daemon...');

        // Register default callback (just log)
        manager.onJobExecute(async (job) => {
          console.log(`[EXECUTE] Job ${job.id}: ${job.task}`);
          return { success: true, output: 'Logged execution' };
        });

        await manager.start();

        // Keep process alive
        console.log('CronManager running. Press Ctrl+C to stop.');

        process.on('SIGINT', () => {
          console.log('\nShutting down...');
          manager.stop();
          process.exit(0);
        });

        // Prevent exit
        await new Promise(() => {});
      } else if (command === '--test') {
        console.log('Running self-test...\n');

        // Test cron expression matching
        console.log('Testing cron expression parsing...');

        const testCases = [
          { expr: '* * * * *', date: new Date(), expected: true },
          { expr: '0 8 * * *', date: new Date('2024-01-01T08:00:00'), expected: true },
          { expr: '0 8 * * *', date: new Date('2024-01-01T09:00:00'), expected: false },
          { expr: '*/15 * * * *', date: new Date('2024-01-01T08:15:00'), expected: true },
          { expr: '*/15 * * * *', date: new Date('2024-01-01T08:16:00'), expected: false },
          { expr: '0 0 1 * *', date: new Date('2024-01-01T00:00:00'), expected: true },
          { expr: '30 14 * * 1-5', date: new Date('2024-01-01T14:30:00'), expected: true }, // Monday
          { expr: '30 14 * * 1-5', date: new Date('2024-01-06T14:30:00'), expected: false }, // Saturday
        ];

        let passed = 0;
        let failed = 0;

        for (const test of testCases) {
          const result = matchesCronExpression(test.expr, test.date);
          if (result === test.expected) {
            console.log(`  ✓ ${test.expr} at ${test.date.toISOString()}: ${result}`);
            passed++;
          } else {
            console.log(`  ✗ ${test.expr} at ${test.date.toISOString()}: expected ${test.expected}, got ${result}`);
            failed++;
          }
        }

        console.log(`\nTest Results: ${passed} passed, ${failed} failed`);

        if (failed > 0) {
          process.exit(1);
        }
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

  main();
}

// ============================================================================
// EXPORTS
// ============================================================================

export { matchesCronExpression, getNextRunTime };
