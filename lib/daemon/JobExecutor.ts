#!/usr/bin/env bun
/**
 * ============================================================================
 * JobExecutor - Execute cron jobs via MessageQueue or isolated agent spawning
 * ============================================================================
 *
 * PURPOSE:
 * Provides the CronManager execute callback that routes jobs based on type:
 *   - main: Enqueue to MessageQueue for notification delivery
 *   - isolated: Spawn a dedicated claude CLI process for autonomous execution
 *
 * USAGE:
 *   const executor = createJobExecutor({
 *     messageRouter,
 *     eventBus,
 *     logDir: '~/.claude/MEMORY/daemon/cron/logs',
 *   });
 *
 *   cronManager.onJobExecute(executor.execute);
 *
 * ============================================================================
 */

import { existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { CronJob, JobExecuteCallback } from '../cron/CronManager';
import type { MessageRouter } from '../messaging/MessageRouter';
import type { EventBus } from '../messaging/EventBus';

// ============================================================================
// Types
// ============================================================================

export interface JobExecutorConfig {
  /** MessageRouter for routing job output */
  messageRouter: MessageRouter;
  /** EventBus for emitting job lifecycle events */
  eventBus: EventBus;
  /** Directory for job execution logs */
  logDir?: string;
  /** Default timeout for isolated jobs (ms, default: 300000 = 5min) */
  defaultTimeout?: number;
}

export interface JobExecutor {
  /** Execute callback compatible with CronManager.onJobExecute */
  execute: JobExecuteCallback;
  /** Get list of currently running isolated processes */
  getRunningProcesses(): { jobId: string; pid: number; startedAt: number }[];
  /** Kill all running isolated processes (for graceful shutdown) */
  killAll(): void;
}

interface RunningProcess {
  jobId: string;
  pid: number;
  startedAt: number;
  proc: any; // Bun.Subprocess
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a JobExecutor instance
 */
export function createJobExecutor(config: JobExecutorConfig): JobExecutor {
  const {
    messageRouter,
    eventBus,
    logDir = join(homedir(), '.claude/MEMORY/daemon/cron/logs'),
    defaultTimeout = 300000,
  } = config;

  // Track running isolated processes
  const runningProcesses = new Map<string, RunningProcess>();

  // Ensure log directory exists
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  /**
   * Log execution event to job-specific JSONL file
   */
  function logExecution(jobId: string, entry: Record<string, any>): void {
    const logPath = join(logDir, `${jobId}.jsonl`);
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
    try {
      appendFileSync(logPath, line);
    } catch {
      // Silent fail for logging
    }
  }

  /**
   * Execute a main-type job (route through MessageQueue)
   */
  async function executeMainJob(job: CronJob): Promise<{ success: boolean; output?: string; error?: string }> {
    try {
      const messageIds = messageRouter.route({
        content: job.task,
        outputMode: job.output,
        priority: 'normal',
        jobId: job.id,
      });

      const output = messageIds.length > 0
        ? `Enqueued ${messageIds.length} message(s) to ${job.output} channel`
        : `No messages enqueued (output mode: ${job.output})`;

      return { success: true, output };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, error };
    }
  }

  /**
   * Execute an isolated-type job (spawn claude CLI process)
   */
  async function executeIsolatedJob(job: CronJob): Promise<{ success: boolean; output?: string; error?: string }> {
    const timeout = defaultTimeout;

    const prompt = [
      `You are executing a scheduled Kaya cron job.`,
      `Job ID: ${job.id}`,
      `Task: ${job.task}`,
      `Output mode: ${job.output}`,
      `Execute the task and provide a concise summary of what you accomplished.`,
    ].join('\n');

    logExecution(job.id, { event: 'spawn.start', prompt: prompt.slice(0, 200) });

    try {
      const proc = Bun.spawn(['/Users/[user]/.local/bin/claude', '-p', prompt, '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep'], {
        cwd: join(homedir(), '.claude'),
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          KAYA_CRON_JOB_ID: job.id,
        },
      });

      // Track the process
      const entry: RunningProcess = {
        jobId: job.id,
        pid: proc.pid,
        startedAt: Date.now(),
        proc,
      };
      runningProcesses.set(job.id, entry);

      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        if (runningProcesses.has(job.id)) {
          console.warn(`[JobExecutor] Job ${job.id} timed out after ${timeout}ms, killing...`);
          logExecution(job.id, { event: 'timeout', timeout });
          proc.kill();
          runningProcesses.delete(job.id);
        }
      }, timeout);

      // Wait for completion
      const exitCode = await proc.exited;

      clearTimeout(timeoutHandle);
      runningProcesses.delete(job.id);

      // Read output
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      const success = exitCode === 0;
      const output = stdout.trim() || undefined;
      const error = !success ? (stderr.trim() || `Exit code: ${exitCode}`) : undefined;

      logExecution(job.id, {
        event: 'spawn.complete',
        exitCode,
        success,
        outputLength: output?.length || 0,
      });

      // Route output through MessageRouter if there's content
      if (output && job.output !== 'silent') {
        messageRouter.route({
          content: output.slice(0, 500), // Truncate for notifications
          outputMode: job.output,
          priority: 'normal',
          jobId: job.id,
        });
      }

      return { success, output: output?.slice(0, 1000), error };
    } catch (err) {
      runningProcesses.delete(job.id);
      const error = err instanceof Error ? err.message : String(err);
      logExecution(job.id, { event: 'spawn.error', error });
      return { success: false, error };
    }
  }

  /**
   * Main execute callback
   */
  const execute: JobExecuteCallback = async (job: CronJob) => {
    const startTime = Date.now();

    // Emit job started event
    eventBus.emit({
      type: 'job.started',
      jobId: job.id,
      jobType: job.type,
      timestamp: startTime,
    });

    let result: { success: boolean; output?: string; error?: string };

    if (job.type === 'main') {
      result = await executeMainJob(job);
    } else if (job.type === 'isolated') {
      result = await executeIsolatedJob(job);
    } else {
      result = { success: false, error: `Unknown job type: ${job.type}` };
    }

    const duration = Date.now() - startTime;

    // Emit completion or failure event
    if (result.success) {
      eventBus.emit({
        type: 'job.completed',
        jobId: job.id,
        success: true,
        duration,
        output: result.output,
        timestamp: Date.now(),
      });
    } else {
      eventBus.emit({
        type: 'job.failed',
        jobId: job.id,
        error: result.error || 'Unknown error',
        duration,
        timestamp: Date.now(),
      });
    }

    logExecution(job.id, {
      event: 'execute.complete',
      type: job.type,
      success: result.success,
      duration,
      error: result.error,
    });

    return result;
  };

  function getRunningProcesses(): { jobId: string; pid: number; startedAt: number }[] {
    return Array.from(runningProcesses.values()).map(({ jobId, pid, startedAt }) => ({
      jobId,
      pid,
      startedAt,
    }));
  }

  function killAll(): void {
    for (const [jobId, entry] of runningProcesses.entries()) {
      console.log(`[JobExecutor] Killing isolated process for job ${jobId} (PID: ${entry.pid})`);
      try {
        entry.proc.kill();
      } catch {
        // Already dead
      }
      runningProcesses.delete(jobId);
    }
  }

  return { execute, getRunningProcesses, killAll };
}
