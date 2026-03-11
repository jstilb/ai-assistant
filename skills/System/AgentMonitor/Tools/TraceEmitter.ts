#!/usr/bin/env bun
/**
 * TraceEmitter - Lightweight trace emission for agents
 *
 * Provides a simple API for agents to emit execution traces.
 * Each trace is appended to the workflow's JSONL file.
 *
 * CLI Usage:
 *   bun run TraceEmitter.ts --workflow <id> --agent <agentId> --event tool_call --tool ReadFile
 *   bun run TraceEmitter.ts --workflow <id> --agent <agentId> --event start
 *   bun run TraceEmitter.ts --workflow <id> --agent <agentId> --event error --error "File not found"
 *
 * Programmatic:
 *   import { emitTrace } from './TraceEmitter.ts';
 *   emitTrace({ workflowId: 'wf1', agentId: 'eng', eventType: 'tool_call', metadata: { toolName: 'Read' } });
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { AgentTrace } from './TraceCollector.ts';

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME: string = join(homedir(), '.claude');
const TRACES_DIR: string = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'traces');

// ============================================================================
// Core Functions
// ============================================================================

function ensureTracesDir(): void {
  if (!existsSync(TRACES_DIR)) {
    mkdirSync(TRACES_DIR, { recursive: true });
  }
}

function emitTrace(trace: Omit<AgentTrace, 'timestamp'> & { timestamp?: number }): void {
  ensureTracesDir();

  const fullTrace: AgentTrace = {
    timestamp: Date.now(),
    ...trace,
    metadata: trace.metadata || {},
    context: trace.context || {},
  };

  const filePath = join(TRACES_DIR, `${fullTrace.workflowId}.jsonl`);
  const line = JSON.stringify(fullTrace) + '\n';
  appendFileSync(filePath, line, 'utf-8');
}

export function emitWorkflowStart(workflowId: string, agentId: string, context?: Record<string, unknown>): void {
  emitTrace({
    workflowId,
    agentId,
    eventType: 'start',
    metadata: {},
    context: context || {},
  });
}

export function emitToolCall(
  workflowId: string,
  agentId: string,
  toolName: string,
  latencyMs?: number,
  tokensUsed?: number,
  context?: Record<string, unknown>
): void {
  emitTrace({
    workflowId,
    agentId,
    eventType: 'tool_call',
    metadata: { toolName, latencyMs, tokensUsed },
    context: context || {},
  });
}

export function emitDecision(
  workflowId: string,
  agentId: string,
  iscCompletionRate?: number,
  context?: Record<string, unknown>
): void {
  emitTrace({
    workflowId,
    agentId,
    eventType: 'decision',
    metadata: { iscCompletionRate },
    context: context || {},
  });
}

export function emitCompletion(
  workflowId: string,
  agentId: string,
  tokensUsed?: number,
  latencyMs?: number,
  context?: Record<string, unknown>
): void {
  emitTrace({
    workflowId,
    agentId,
    eventType: 'completion',
    metadata: { tokensUsed, latencyMs },
    context: context || {},
  });
}

export function emitError(
  workflowId: string,
  agentId: string,
  errorMessage: string,
  context?: Record<string, unknown>
): void {
  emitTrace({
    workflowId,
    agentId,
    eventType: 'error',
    metadata: { errorMessage },
    context: context || {},
  });
}

// ============================================================================
// CLI Interface
// ============================================================================

function printUsage(): void {
  console.log(`
TraceEmitter - Emit agent execution traces

Usage:
  bun run TraceEmitter.ts --workflow <id> --agent <agentId> --event <type> [options]

Required:
  --workflow <id>     Workflow identifier
  --agent <agentId>   Agent identifier
  --event <type>      Event type: start, tool_call, decision, completion, error

Options:
  --tool <name>       Tool name (for tool_call events)
  --latency <ms>      Latency in milliseconds
  --tokens <count>    Token count
  --error <message>   Error message (for error events)
  --isc <rate>        ISC completion rate 0-1 (for decision events)
  --json              Output the emitted trace as JSON

Examples:
  bun run TraceEmitter.ts --workflow wf1 --agent eng --event start
  bun run TraceEmitter.ts --workflow wf1 --agent eng --event tool_call --tool ReadFile --latency 150
  bun run TraceEmitter.ts --workflow wf1 --agent eng --event error --error "File not found"
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const getArg = (name: string): string | undefined => {
    const idx = args.indexOf(name);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
  };

  const hasFlag = (name: string): boolean => args.includes(name);

  const workflowId = getArg('--workflow');
  const agentId = getArg('--agent');
  const eventType = getArg('--event') as AgentTrace['eventType'];

  if (!workflowId || !agentId || !eventType) {
    console.error('Error: --workflow, --agent, and --event are required');
    process.exit(1);
  }

  const validEvents = ['start', 'tool_call', 'decision', 'completion', 'error'];
  if (!validEvents.includes(eventType)) {
    console.error(`Error: --event must be one of: ${validEvents.join(', ')}`);
    process.exit(1);
  }

  const metadata: AgentTrace['metadata'] = {};
  const toolName = getArg('--tool');
  if (toolName) metadata.toolName = toolName;

  const latency = getArg('--latency');
  if (latency) metadata.latencyMs = parseInt(latency, 10);

  const tokens = getArg('--tokens');
  if (tokens) metadata.tokensUsed = parseInt(tokens, 10);

  const errorMsg = getArg('--error');
  if (errorMsg) metadata.errorMessage = errorMsg;

  const isc = getArg('--isc');
  if (isc) metadata.iscCompletionRate = parseFloat(isc);

  const trace: AgentTrace = {
    workflowId,
    agentId,
    timestamp: Date.now(),
    eventType,
    metadata,
    context: {},
  };

  emitTrace(trace);

  if (hasFlag('--json')) {
    console.log(JSON.stringify(trace, null, 2));
  } else {
    console.log(`Trace emitted: ${eventType} for ${agentId} in ${workflowId}`);
  }
}

if (import.meta.main) {
  main();
}
