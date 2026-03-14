#!/usr/bin/env bun
/**
 * FailureCapture.ts - Detailed failure capture for very low ratings
 *
 * PURPOSE:
 * When a user gives a very low rating (1-3), this captures the full context
 * for later analysis and learning. This helps identify patterns in failures.
 *
 * USAGE:
 *   import { captureFailure } from './FailureCapture';
 *   await captureFailure({
 *     transcriptPath: '/path/to/transcript.jsonl',
 *     rating: 2,
 *     sentimentSummary: 'Broke the build',
 *     detailedContext: 'Full context from last response',
 *     sessionId: 'abc-123',
 *   });
 *
 * OUTPUT:
 * - Creates file: MEMORY/LEARNING/FAILURES/<YYYY-MM>/<timestamp>_failure_<sessionId>.md
 *
 * @author Kaya Engineering
 * @version 1.0.0
 */

import { join } from "path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "fs";
import { prepareOutputPath } from "./OutputPathResolver";
import { execSync } from "child_process";

// ============================================================================
// Types
// ============================================================================

export interface FailureCaptureInput {
  /** Path to the conversation transcript */
  transcriptPath: string;
  /** Rating given (1-3) */
  rating: number;
  /** Brief summary of the sentiment/failure */
  sentimentSummary: string;
  /** Detailed context from the response */
  detailedContext?: string;
  /** Session ID for correlation */
  sessionId: string;
}

/** Input for the structured 3-file failure dump package (ISC 8120) */
export interface FailureDumpInput {
  /** Session ID for correlation */
  sessionId: string;
  /** Path to the conversation transcript JSONL */
  transcriptPath: string;
  /** Explicit user rating (must be 1-3) */
  rating: number;
  /** Optional user comment */
  comment?: string;
}

/** A single tool call extracted from the transcript */
interface ToolCallEntry {
  tool: string;
  input_summary: string;
  result_status: "success" | "error" | "timeout";
  timestamp: string;
}

/** Schema for tool-calls.json */
interface ToolCallsJson {
  session_id: string;
  total_calls: number;
  failed_calls: number;
  calls: ToolCallEntry[];
}

// ============================================================================
// Constants
// ============================================================================

function getKayaDir(): string {
  return process.env.KAYA_DIR || join(process.env.HOME || '', '.claude');
}
function getFailuresDir(): string {
  return join(getKayaDir(), 'MEMORY', 'LEARNING', 'FAILURES');
}
function getContextSessionPath(): string {
  return join(getKayaDir(), 'MEMORY', 'State', 'context-session.json');
}
const MAX_PACKAGE_SIZE_BYTES = 50 * 1024; // 50KB
const HAIKU_TIMEOUT_MS = 5000;

// ============================================================================
// Main Function
// ============================================================================

/**
 * Capture a detailed failure record for very low ratings
 */
export async function captureFailure(input: FailureCaptureInput): Promise<string> {
  const now = new Date();
  const shortSessionId = input.sessionId.slice(0, 8);

  // Use OutputPathResolver for consistent path generation
  const { path: filepath, directory } = await prepareOutputPath({
    skill: 'LEARNING/FAILURES',
    title: `failure-${shortSessionId}`,
    extension: 'md',
    includeTimestamp: true,
  });

  // Get last few entries from transcript for context
  let transcriptContext = '';
  if (input.transcriptPath && existsSync(input.transcriptPath)) {
    try {
      const content = readFileSync(input.transcriptPath, 'utf-8');
      const lines = content.trim().split('\n').slice(-20); // Last 20 entries
      transcriptContext = lines.map(line => {
        try {
          const entry = JSON.parse(line);
          const role = entry.role || 'unknown';
          const text = entry.content?.slice(0, 500) || '[no content]';
          return `**${role}**: ${text}${entry.content?.length > 500 ? '...' : ''}`;
        } catch {
          return '';
        }
      }).filter(Boolean).join('\n\n');
    } catch (err) {
      transcriptContext = `[Error reading transcript: ${err}]`;
    }
  }

  // Build the failure document
  const content = `# Failure Capture - Rating ${input.rating}/10

**Session:** ${input.sessionId}
**Timestamp:** ${now.toISOString()}
**Rating:** ${input.rating}/10

## Summary

${input.sentimentSummary}

## Detailed Context

${input.detailedContext || '[No detailed context provided]'}

## Transcript Excerpt

${transcriptContext || '[No transcript available]'}

---

*Captured automatically by FailureCapture.ts for analysis and improvement.*
`;

  // Write the file
  writeFileSync(filepath, content, 'utf-8');

  return filepath;
}

// ============================================================================
// Failure Dump (ISC 8120, 3634, 1352, 8740) — Structured 3-file package
// ============================================================================

/**
 * Extract tool calls from transcript JSONL file.
 * Returns structured array of tool invocations.
 */
function extractToolCalls(transcriptPath: string): ToolCallEntry[] {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];

  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const toolCalls: ToolCallEntry[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Look for tool_use blocks in assistant messages
        if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
          for (const block of entry.message.content) {
            if (block.type === 'tool_use') {
              toolCalls.push({
                tool: block.name ?? 'unknown',
                input_summary: JSON.stringify(block.input ?? {}).slice(0, 200),
                result_status: 'success', // assume success unless tool_result says otherwise
                timestamp: entry.timestamp ?? new Date().toISOString(),
              });
            }
            if (block.type === 'tool_result' && block.is_error) {
              // Mark the last call with matching tool_use_id as error
              const lastIdx = toolCalls.length - 1;
              if (lastIdx >= 0) {
                toolCalls[lastIdx].result_status = 'error';
              }
            }
          }
        }
        // Also handle flat tool_use at top level
        if (entry.role === 'assistant' && entry.content?.type === 'tool_use') {
          const c = entry.content;
          toolCalls.push({
            tool: c.name ?? 'unknown',
            input_summary: JSON.stringify(c.input ?? {}).slice(0, 200),
            result_status: 'success',
            timestamp: entry.timestamp ?? new Date().toISOString(),
          });
        }
      } catch {
        // skip malformed lines
      }
    }
    return toolCalls;
  } catch {
    return [];
  }
}

/**
 * Read last N lines of transcript for Haiku summarization.
 */
function getTranscriptLastLines(transcriptPath: string, n: number = 20): string {
  if (!transcriptPath || !existsSync(transcriptPath)) return '';
  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean).slice(-n);
    return lines.map(line => {
      try {
        const entry = JSON.parse(line);
        const role = entry.role ?? entry.type ?? 'unknown';
        let text = '';
        if (typeof entry.content === 'string') text = entry.content.slice(0, 300);
        else if (Array.isArray(entry.message?.content)) {
          text = entry.message.content
            .filter((c: { type: string; text?: string }) => c.type === 'text')
            .map((c: { type: string; text?: string }) => (c.text ?? '').slice(0, 300))
            .join(' ');
        }
        return `[${role}]: ${text}`;
      } catch {
        return '';
      }
    }).filter(Boolean).join('\n');
  } catch {
    return '';
  }
}

/**
 * Call Haiku via Inference.ts with a 5s timeout.
 * Returns the response text, or null on timeout/error.
 */
function callHaikuWithTimeout(prompt: string): string | null {
  const inferencePath = join(getKayaDir(), 'tools', 'Inference.ts');
  if (!existsSync(inferencePath)) return null;

  try {
    const result = execSync(
      `echo ${JSON.stringify(prompt)} | bun ${inferencePath} fast`,
      {
        timeout: HAIKU_TIMEOUT_MS,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }
    );
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Compute total size of all files in a directory (non-recursive).
 */
function dirSizeBytes(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;
  try {
    return readdirSync(dirPath)
      .map(f => {
        try { return statSync(join(dirPath, f)).size; } catch { return 0; }
      })
      .reduce((a, b) => a + b, 0);
  } catch {
    return 0;
  }
}

/**
 * Create a structured 3-file failure dump package for ratings 1-3.
 *
 * Creates:
 *   MEMORY/LEARNING/FAILURES/YYYY-MM/{YYYY-MM-DD-HHMMSS}_{6char-slug}/
 *     ├── analysis.md           (Haiku summary + root cause)
 *     ├── context-snapshot.json (copy of context-session.json)
 *     └── tool-calls.json       (extracted tool invocations)
 *
 * Returns the package directory path on success.
 * Throws if rating is not 1-3.
 */
export async function captureFailureDump(input: FailureDumpInput): Promise<string> {
  if (input.rating > 3 || input.rating < 1) {
    throw new Error(`captureFailureDump called with rating=${input.rating} — only ratings 1-3 are valid`);
  }

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const yearMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const datePart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const slug = input.sessionId.replace(/-/g, '').slice(0, 6);

  const packageDir = join(getFailuresDir(), yearMonth, `${datePart}-${timePart}_${slug}`);
  mkdirSync(packageDir, { recursive: true });

  // --- context-snapshot.json ---
  let contextSnapshot: unknown = null;
  if (existsSync(getContextSessionPath())) {
    try {
      contextSnapshot = JSON.parse(readFileSync(getContextSessionPath(), 'utf-8'));
    } catch {
      contextSnapshot = { error: 'Failed to parse context-session.json' };
    }
  }
  writeFileSync(
    join(packageDir, 'context-snapshot.json'),
    JSON.stringify(contextSnapshot ?? {}, null, 2),
    'utf-8'
  );

  // --- tool-calls.json ---
  const toolCalls = extractToolCalls(input.transcriptPath);
  const failedCallCount = toolCalls.filter(c => c.result_status === 'error').length;
  const toolCallsJson: ToolCallsJson = {
    session_id: input.sessionId,
    total_calls: toolCalls.length,
    failed_calls: failedCallCount,
    calls: toolCalls,
  };
  writeFileSync(
    join(packageDir, 'tool-calls.json'),
    JSON.stringify(toolCallsJson, null, 2),
    'utf-8'
  );

  // --- analysis.md (Haiku-generated) ---
  const transcriptExcerpt = getTranscriptLastLines(input.transcriptPath, 20);

  // Haiku transcript summary (ISC 8740)
  const summaryPrompt = `You are analyzing a Kaya AI assistant session that received a low rating of ${input.rating}/10.\nSummarize the last 20 turns in 3 bullet points (1 sentence each).\nFocus on what went wrong, not what went right.\nBe specific and factual. Output ONLY the 3 bullets, no preamble.\n\nTranscript:\n${transcriptExcerpt.slice(0, 3000)}`;

  let haikuSummary = callHaikuWithTimeout(summaryPrompt);
  let haikuRootCause: string | null = null;

  if (haikuSummary) {
    const rootCausePrompt = `Given this session summary: ${haikuSummary}\nAnd user comment: ${input.comment ?? 'none'}\nIn 1-2 sentences, hypothesize the root cause of the failure.\nBe specific. Avoid generic phrases like "miscommunication".\nOutput only the hypothesis, no preamble.`;
    haikuRootCause = callHaikuWithTimeout(rootCausePrompt);
  }

  // Get context info from snapshot
  const sessionSnapshot = contextSnapshot as Record<string, unknown> | null;
  const profileName = typeof sessionSnapshot?.profile === 'string' ? sessionSnapshot.profile : 'unknown';
  const profileConfidence = typeof sessionSnapshot?.classificationConfidence === 'number'
    ? sessionSnapshot.classificationConfidence : null;
  const filesLoaded: string[] = Array.isArray(sessionSnapshot?.filesLoaded) ? sessionSnapshot.filesLoaded as string[] : [];

  const analysisContent = `# Failure Analysis — Rating ${input.rating}/10

**Session:** ${input.sessionId}
**Timestamp:** ${now.toISOString()}
**Rating:** ${input.rating}/10
**User Comment:** ${input.comment ?? 'none'}

## Session Summary ${haikuSummary ? '(Haiku-generated)' : ''}

${haikuSummary ?? '[Haiku unavailable — manual review required]'}

## Root Cause Hypothesis ${haikuRootCause ? '(Haiku-generated)' : ''}

${haikuRootCause ?? '[Haiku unavailable — manual review required]'}

## Context Loaded

Profile: ${profileName}${profileConfidence !== null ? ` (confidence: ${profileConfidence}%)` : ''}
Files loaded: ${filesLoaded.length > 0 ? filesLoaded.join(', ') : 'none recorded'}

## Signals

- Manual context loads: ${typeof sessionSnapshot?.manualLoads === 'number' ? sessionSnapshot.manualLoads : 'unknown'}
- Session duration: ${typeof sessionSnapshot?.durationMinutes === 'number' ? sessionSnapshot.durationMinutes : 'unknown'} minutes
- Tool calls: ${toolCalls.length} total (${failedCallCount} failed)
`;

  writeFileSync(join(packageDir, 'analysis.md'), analysisContent, 'utf-8');

  // --- Size enforcement (ISC 1352) ---
  const totalSize = dirSizeBytes(packageDir);
  if (totalSize > MAX_PACKAGE_SIZE_BYTES) {
    // First: truncate tool-calls.json by removing successful calls
    const failedCalls = toolCalls.filter(c => c.result_status !== 'success');
    const truncatedToolCalls: ToolCallsJson = {
      session_id: input.sessionId,
      total_calls: toolCalls.length,
      failed_calls: failedCallCount,
      calls: failedCalls, // keep only failed
    };
    writeFileSync(
      join(packageDir, 'tool-calls.json'),
      JSON.stringify(truncatedToolCalls, null, 2),
      'utf-8'
    );

    // Check again after truncating tool-calls
    const sizeAfterToolTruncation = dirSizeBytes(packageDir);
    if (sizeAfterToolTruncation > MAX_PACKAGE_SIZE_BYTES) {
      // Truncate analysis.md transcript section
      const maxAnalysisBytes = MAX_PACKAGE_SIZE_BYTES
        - (existsSync(join(packageDir, 'context-snapshot.json'))
            ? statSync(join(packageDir, 'context-snapshot.json')).size
            : 0)
        - (existsSync(join(packageDir, 'tool-calls.json'))
            ? statSync(join(packageDir, 'tool-calls.json')).size
            : 0);
      if (maxAnalysisBytes > 200) {
        const truncatedAnalysis = analysisContent.slice(0, maxAnalysisBytes - 30) + '\n\n[truncated — size limit reached]';
        writeFileSync(join(packageDir, 'analysis.md'), truncatedAnalysis, 'utf-8');
      }
    }
  }

  const finalSize = dirSizeBytes(packageDir);
  console.error(`[FailureCapture] Failure dump created: ${packageDir} (${Math.round(finalSize / 1024)}KB)`);
  return packageDir;
}

// ============================================================================
// CLI Mode
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log('Usage: bun FailureCapture.ts <sessionId> <rating> [summary]');
    process.exit(1);
  }

  const [sessionId, ratingStr, summary = 'Manual failure capture'] = args;
  const rating = parseInt(ratingStr, 10);

  if (isNaN(rating) || rating < 1 || rating > 10) {
    console.error('Rating must be a number between 1 and 10');
    process.exit(1);
  }

  captureFailure({
    transcriptPath: '',
    rating,
    sentimentSummary: summary,
    sessionId,
  }).then(filepath => {
    console.log(`Failure captured: ${filepath}`);
  }).catch(err => {
    console.error(`Error: ${err}`);
    process.exit(1);
  });
}
