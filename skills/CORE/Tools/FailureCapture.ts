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

import { join, dirname } from "path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { prepareOutputPath } from "./OutputPathResolver";

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

// ============================================================================
// Constants
// ============================================================================

const KAYA_DIR = process.env.KAYA_DIR || join(process.env.HOME || '', '.claude');
const FAILURES_DIR = join(KAYA_DIR, 'MEMORY', 'LEARNING', 'FAILURES');

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
