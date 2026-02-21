#!/usr/bin/env bun
/**
 * AgentRunner.ts - Single-agent process runner with watchdog timer
 *
 * Spawns agent processes with environment setup, configurable watchdog timer
 * (default 60s), and diagnostic dump on timeout. Uses args arrays for
 * child_process.spawn -- no shell string concatenation.
 *
 * Usage:
 *   import { createRunnerConfig, buildSpawnArgs, runAgent } from "./AgentRunner.ts";
 *   const config = createRunnerConfig({ prompt: "...", cwd: "/sandbox" });
 *   const result = await runAgent(config);
 */

import { spawnSync } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

// ============================================
// TYPES
// ============================================

export interface RunnerConfig {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

export interface RunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  duration_ms: number;
  diagnostic?: DiagnosticDump;
}

export interface DiagnosticDump {
  timedOut: boolean;
  timeoutMs: number;
  prompt: string;
  cwd: string;
  timestamp: string;
  stdout_tail: string;
  stderr_tail: string;
}

export interface SpawnConfig {
  command: string;
  args: string[];
  cwd: string;
  timeout: number;
  env?: Record<string, string>;
}

// ============================================
// CONFIG CREATION
// ============================================

export function createRunnerConfig(options: {
  prompt: string;
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}): RunnerConfig {
  return {
    prompt: options.prompt,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 60000,
    env: options.env,
  };
}

// ============================================
// SPAWN ARGS BUILDER
// ============================================

export function buildSpawnArgs(config: RunnerConfig): SpawnConfig {
  const args: string[] = [
    "--print",
    "--dangerously-skip-permissions",
    config.prompt,
  ];

  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([_, v]) => v !== undefined) as [string, string][]
    ),
    SIMULATION_MODE: "true",
    ...(config.env ?? {}),
  };

  return {
    command: "claude",
    args,
    cwd: config.cwd,
    timeout: config.timeoutMs,
    env,
  };
}

// ============================================
// AGENT EXECUTION
// ============================================

export function runAgent(config: RunnerConfig): RunResult {
  const spawnConfig = buildSpawnArgs(config);
  const startTime = Date.now();

  const result = spawnSync(spawnConfig.command, spawnConfig.args, {
    cwd: spawnConfig.cwd,
    encoding: "utf-8",
    timeout: spawnConfig.timeout,
    env: spawnConfig.env,
  });

  const duration_ms = Date.now() - startTime;
  const timedOut = result.signal === "SIGTERM";
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode = result.status ?? 1;

  let diagnostic: DiagnosticDump | undefined;

  if (timedOut) {
    diagnostic = {
      timedOut: true,
      timeoutMs: config.timeoutMs,
      prompt: config.prompt.slice(0, 500),
      cwd: config.cwd,
      timestamp: new Date().toISOString(),
      stdout_tail: stdout.slice(-500),
      stderr_tail: stderr.slice(-500),
    };

    // Write diagnostic dump to sandbox
    try {
      const diagDir = join(config.cwd, ".simulation-diagnostics");
      if (!existsSync(diagDir)) mkdirSync(diagDir, { recursive: true });
      const diagPath = join(diagDir, `timeout-${Date.now()}.json`);
      writeFileSync(diagPath, JSON.stringify(diagnostic, null, 2));
    } catch {
      // Best effort - don't fail on diagnostic write
    }
  }

  return {
    success: exitCode === 0 && !timedOut,
    stdout,
    stderr,
    exitCode,
    timedOut,
    duration_ms,
    diagnostic,
  };
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "run": {
      const prompt = args[0];
      const cwdArg = args.find(a => a.startsWith("--cwd="))?.split("=")[1];
      const timeoutArg = args.find(a => a.startsWith("--timeout="))?.split("=")[1];

      if (!prompt) {
        console.error("Usage: run <prompt> [--cwd=/path] [--timeout=60000]");
        process.exit(1);
      }

      const config = createRunnerConfig({
        prompt,
        cwd: cwdArg ?? process.cwd(),
        timeoutMs: timeoutArg ? parseInt(timeoutArg) : 60000,
      });

      console.error(`Running agent with timeout ${config.timeoutMs}ms...`);
      const result = runAgent(config);
      console.log(JSON.stringify({
        success: result.success,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        duration_ms: result.duration_ms,
        stdout_length: result.stdout.length,
        stderr_length: result.stderr.length,
        diagnostic: result.diagnostic,
      }, null, 2));
      process.exit(result.success ? 0 : 1);
      break;
    }

    default:
      console.log(`AgentRunner - Single-agent process runner with watchdog

Commands:
  run <prompt> [--cwd=/path] [--timeout=60000]   Run agent with watchdog timer

Default timeout: 60s
Diagnostic dump on timeout to .simulation-diagnostics/`);
      break;
  }
}
