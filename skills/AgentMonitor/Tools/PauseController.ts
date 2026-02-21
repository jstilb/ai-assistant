#!/usr/bin/env bun
/**
 * PauseController - Workflow pause/resume signal management
 *
 * Sends pause signals to running workflows, waits for acknowledgment,
 * manages checkpoint state, and sends resume signals after approval.
 * All signals use JSONL file-based transport for crash safety.
 *
 * Usage:
 *   import { createPauseController } from './PauseController.ts';
 *   const controller = createPauseController();
 *   await controller.pause(workflowId, reason, interventionId);
 *   await controller.resume(workflowId, interventionId);
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

// ============================================================================
// Types
// ============================================================================

export interface PauseSignal {
  signal: 'pause';
  timestamp: number;
  reason: string;
  interventionId: string;
}

export interface ResumeSignal {
  signal: 'resume';
  timestamp: number;
  interventionId: string;
  approvedBy?: string;
}

export interface PauseAcknowledgment {
  signal: 'pause-ack';
  timestamp: number;
  interventionId: string;
  checkpointPath: string;
}

export interface PauseResult {
  success: boolean;
  workflowId: string;
  interventionId: string;
  acknowledgedAt?: number;
  checkpointPath?: string;
  error?: string;
  timedOut?: boolean;
}

export interface ResumeResult {
  success: boolean;
  workflowId: string;
  interventionId: string;
  resumedAt?: number;
  error?: string;
}

export interface PauseControllerConfig {
  /** Timeout waiting for workflow to acknowledge pause (ms) */
  pauseAckTimeoutMs: number;
  /** Poll interval for checking acknowledgment (ms) */
  pollIntervalMs: number;
  /** Max time to wait for resume confirmation (ms) */
  resumeTimeoutMs: number;
}

export interface PauseController {
  pause(workflowId: string, reason: string, interventionId: string): Promise<PauseResult>;
  resume(workflowId: string, interventionId: string, approvedBy?: string): Promise<ResumeResult>;
  isPaused(workflowId: string): boolean;
  getPausedWorkflows(): string[];
  getCheckpoint(workflowId: string): unknown | null;
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = join(homedir(), '.claude');
const SIGNALS_DIR = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'signals');
const CHECKPOINTS_DIR = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'checkpoints');
const STATE_DIR = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'state');

const DEFAULT_CONFIG: PauseControllerConfig = {
  pauseAckTimeoutMs: 30000,
  pollIntervalMs: 1000,
  resumeTimeoutMs: 10000,
};

// ============================================================================
// Implementation
// ============================================================================

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function signalPath(workflowId: string, type: string): string {
  return join(SIGNALS_DIR, `${workflowId}-${type}.jsonl`);
}

function checkpointDir(workflowId: string): string {
  return join(CHECKPOINTS_DIR, workflowId);
}

function readLastLine(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8').trim();
  if (!content) return null;
  const lines = content.split('\n');
  return lines[lines.length - 1] || null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createPauseController(config?: Partial<PauseControllerConfig>): PauseController {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const pausedWorkflows = new Set<string>();

  // Load persisted state
  const stateFile = join(STATE_DIR, 'paused-workflows.json');
  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
      if (Array.isArray(state.paused)) {
        for (const wf of state.paused) pausedWorkflows.add(wf);
      }
    } catch {
      // Corrupted state file, start fresh
    }
  }

  function persistState(): void {
    ensureDir(STATE_DIR);
    const state = { paused: Array.from(pausedWorkflows), updatedAt: Date.now() };
    const tmpPath = stateFile + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    const { renameSync } = require('fs');
    renameSync(tmpPath, stateFile);
  }

  return {
    async pause(workflowId: string, reason: string, interventionId: string): Promise<PauseResult> {
      ensureDir(SIGNALS_DIR);

      // Write pause signal
      const signal: PauseSignal = {
        signal: 'pause',
        timestamp: Date.now(),
        reason,
        interventionId,
      };

      const pausePath = signalPath(workflowId, 'pause');
      appendFileSync(pausePath, JSON.stringify(signal) + '\n', 'utf-8');

      // Wait for acknowledgment
      const ackPath = signalPath(workflowId, 'pause-ack');
      const startTime = Date.now();

      while (Date.now() - startTime < cfg.pauseAckTimeoutMs) {
        const lastLine = readLastLine(ackPath);
        if (lastLine) {
          try {
            const ack: PauseAcknowledgment = JSON.parse(lastLine);
            if (ack.interventionId === interventionId && ack.signal === 'pause-ack') {
              pausedWorkflows.add(workflowId);
              persistState();
              return {
                success: true,
                workflowId,
                interventionId,
                acknowledgedAt: ack.timestamp,
                checkpointPath: ack.checkpointPath,
              };
            }
          } catch {
            // Malformed ack, keep waiting
          }
        }
        await sleep(cfg.pollIntervalMs);
      }

      // Timeout — mark as paused anyway (conservative)
      pausedWorkflows.add(workflowId);
      persistState();
      return {
        success: false,
        workflowId,
        interventionId,
        timedOut: true,
        error: `Pause acknowledgment timeout after ${cfg.pauseAckTimeoutMs}ms`,
      };
    },

    async resume(workflowId: string, interventionId: string, approvedBy?: string): Promise<ResumeResult> {
      ensureDir(SIGNALS_DIR);

      if (!pausedWorkflows.has(workflowId)) {
        return {
          success: false,
          workflowId,
          interventionId,
          error: `Workflow ${workflowId} is not paused`,
        };
      }

      // Write resume signal
      const signal: ResumeSignal = {
        signal: 'resume',
        timestamp: Date.now(),
        interventionId,
        approvedBy,
      };

      const resumePath = signalPath(workflowId, 'resume');
      appendFileSync(resumePath, JSON.stringify(signal) + '\n', 'utf-8');

      pausedWorkflows.delete(workflowId);
      persistState();

      return {
        success: true,
        workflowId,
        interventionId,
        resumedAt: Date.now(),
      };
    },

    isPaused(workflowId: string): boolean {
      return pausedWorkflows.has(workflowId);
    },

    getPausedWorkflows(): string[] {
      return Array.from(pausedWorkflows);
    },

    getCheckpoint(workflowId: string): unknown | null {
      const cpDir = checkpointDir(workflowId);
      if (!existsSync(cpDir)) return null;

      // Find most recent checkpoint
      const { readdirSync } = require('fs');
      const files = readdirSync(cpDir)
        .filter((f: string) => f.endsWith('-checkpoint.json'))
        .sort()
        .reverse();

      if (files.length === 0) return null;

      try {
        return JSON.parse(readFileSync(join(cpDir, files[0]), 'utf-8'));
      } catch {
        return null;
      }
    },
  };
}
