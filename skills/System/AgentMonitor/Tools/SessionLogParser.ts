#!/usr/bin/env bun
/**
 * SessionLogParser - Retrospective parser for MEMORY/WORK/ logs
 *
 * Parses session log files from MEMORY/WORK/ directories and converts
 * them into AgentTrace format for evaluation by the pipeline.
 *
 * Usage:
 *   import { parseSessionLog } from './SessionLogParser.ts';
 *   const traces = parseSessionLog('MEMORY/WORK/20260205-080013_tasks-daily');
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import type { AgentTrace } from './TraceCollector.ts';
import { auditLog } from './AuditLogger.ts';

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME: string = join(homedir(), '.claude');
const WORK_DIR: string = join(KAYA_HOME, 'MEMORY', 'WORK');

// ============================================================================
// Types
// ============================================================================

interface ParsedSession {
  workflowId: string;
  dirName: string;
  traces: AgentTrace[];
  metadata: {
    startTime: number | null;
    endTime: number | null;
    files: string[];
    lineCount: number;
  };
}

// ============================================================================
// Parsing Helpers
// ============================================================================

function extractTimestampFromDirName(dirName: string): number | null {
  // Format: 20260205-080013_tasks-daily
  const match = dirName.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})_/);
  if (!match) return null;
  const [, year, month, day, hour, min, sec] = match;
  return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}`).getTime();
}

function extractWorkflowIdFromDir(dirName: string): string {
  // Use dir name as workflow ID, sanitized
  return dirName.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function parseLogLine(line: string, baseTimestamp: number, lineIndex: number): AgentTrace | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length < 5) return null;

  // Try to parse JSONL entries first
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.timestamp && parsed.eventType) {
        return parsed as AgentTrace;
      }
    } catch {
      // Not valid JSON, try text parsing
    }
  }

  // Heuristic parsing of text-based log entries
  const agentTrace: Partial<AgentTrace> = {
    timestamp: baseTimestamp + (lineIndex * 100), // Approximate ordering
    agentId: 'session',
    context: { rawLine: trimmed },
    metadata: {},
  };

  // Detect event types from common patterns
  if (/^(start|begin|initiated|launching)/i.test(trimmed)) {
    agentTrace.eventType = 'start';
  } else if (/^(error|failed|exception|crash)/i.test(trimmed) || /error:/i.test(trimmed)) {
    agentTrace.eventType = 'error';
    agentTrace.metadata = { errorMessage: trimmed.slice(0, 200) };
  } else if (/^(complete|finished|done|success)/i.test(trimmed)) {
    agentTrace.eventType = 'completion';
  } else if (/tool[_ ]?call|invoke|executing|running/i.test(trimmed)) {
    agentTrace.eventType = 'tool_call';
    // Try to extract tool name
    const toolMatch = trimmed.match(/(?:tool[_ ]?call|invoke|executing|running)\s+(\w+)/i);
    if (toolMatch) {
      agentTrace.metadata = { toolName: toolMatch[1] };
    }
  } else if (/decision|chose|selected|routing/i.test(trimmed)) {
    agentTrace.eventType = 'decision';
  } else {
    // Default to tool_call for actionable lines
    return null;
  }

  if (!agentTrace.eventType) return null;

  return agentTrace as AgentTrace;
}

function parseMarkdownLog(content: string, baseTimestamp: number): AgentTrace[] {
  const traces: AgentTrace[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const trace = parseLogLine(lines[i], baseTimestamp, i);
    if (trace) {
      traces.push(trace);
    }
  }

  return traces;
}

function parseJsonlLog(content: string): AgentTrace[] {
  const traces: AgentTrace[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.workflowId && parsed.eventType) {
        traces.push(parsed as AgentTrace);
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  return traces;
}

// ============================================================================
// Core Functions
// ============================================================================

export function parseSessionLog(workDir: string): ParsedSession {
  // Resolve path
  const fullPath = workDir.startsWith('/') ? workDir : join(KAYA_HOME, workDir);
  const dirName = basename(fullPath);
  const workflowId = extractWorkflowIdFromDir(dirName);
  const baseTimestamp = extractTimestampFromDirName(dirName) || Date.now();

  if (!existsSync(fullPath)) {
    auditLog({
      action: 'retro',
      workflowId,
      details: { error: 'work directory not found', path: fullPath },
      success: false,
      errorMessage: `Work directory not found: ${fullPath}`,
    });
    return {
      workflowId,
      dirName,
      traces: [],
      metadata: { startTime: null, endTime: null, files: [], lineCount: 0 },
    };
  }

  const traces: AgentTrace[] = [];
  const files: string[] = [];
  let totalLines = 0;

  // Recursively read all files in the work directory
  const entries = readdirSync(fullPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      const filePath = join(fullPath, entry.name);
      files.push(entry.name);

      try {
        const content = readFileSync(filePath, 'utf-8');
        totalLines += content.split('\n').length;

        if (entry.name.endsWith('.jsonl')) {
          traces.push(...parseJsonlLog(content));
        } else if (entry.name.endsWith('.md') || entry.name.endsWith('.txt') || entry.name.endsWith('.log')) {
          traces.push(...parseMarkdownLog(content, baseTimestamp));
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  // Set workflow ID on all traces
  for (const trace of traces) {
    if (!trace.workflowId) {
      trace.workflowId = workflowId;
    }
  }

  // Sort by timestamp
  traces.sort((a, b) => a.timestamp - b.timestamp);

  // If we got no traces from parsing, create a minimal trace set
  if (traces.length === 0 && files.length > 0) {
    traces.push({
      workflowId,
      agentId: 'session',
      timestamp: baseTimestamp,
      eventType: 'start',
      metadata: {},
      context: { filesFound: files },
    });
    traces.push({
      workflowId,
      agentId: 'session',
      timestamp: baseTimestamp + 1000,
      eventType: 'completion',
      metadata: {},
      context: { totalLines },
    });
  }

  const startTime = traces.length > 0 ? traces[0].timestamp : null;
  const endTime = traces.length > 0 ? traces[traces.length - 1].timestamp : null;

  auditLog({
    action: 'retro',
    workflowId,
    details: { traceCount: traces.length, fileCount: files.length, totalLines },
    success: true,
  });

  return {
    workflowId,
    dirName,
    traces,
    metadata: { startTime, endTime, files, lineCount: totalLines },
  };
}

export function listWorkDirs(limit: number = 20): string[] {
  if (!existsSync(WORK_DIR)) return [];

  return readdirSync(WORK_DIR)
    .filter(d => {
      const fullPath = join(WORK_DIR, d);
      try {
        return existsSync(fullPath) && readdirSync(fullPath).length > 0;
      } catch {
        return false;
      }
    })
    .sort()
    .reverse()
    .slice(0, limit);
}
