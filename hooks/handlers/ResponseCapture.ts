/**
 * ResponseCapture.ts - Response Capture Handler
 *
 * PURPOSE:
 * Captures completed responses and updates task status.
 * Also handles learning capture for significant insights and sends notifications.
 * Extracts and persists ISC (Ideal State Criteria) to current task's ISC.json.
 *
 * STRUCTURE:
 * Session: WORK/{session_dir}/
 * Task: WORK/{session_dir}/tasks/{current_task}/
 *   - ISC.json (task's criteria)
 *   - THREAD.md (task's algorithm log with frontmatter metadata)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { getKayaDir } from '../lib/paths';
import { sendEventToObservability, getCurrentTimestamp, getSourceApp } from '../lib/observability';
import { notifyTaskComplete, notifyError, getSessionDurationMinutes } from '../lib/notifications';
import { getLearningCategory, isLearningCapture } from '../lib/learning-utils';
import { getPSTTimestamp, getPSTDate, getYearMonth, getISOTimestamp } from '../lib/time';
import type { ParsedTranscript, StructuredResponse } from '../../lib/core/TranscriptParser';

const BASE_DIR = getKayaDir();
const WORK_DIR = join(BASE_DIR, 'MEMORY', 'WORK');
const STATE_DIR = join(BASE_DIR, 'MEMORY', 'STATE');
const CURRENT_WORK_FILE = join(STATE_DIR, 'current-work.json');

// ============================================================================
// Types
// ============================================================================

interface CurrentWork {
  session_id: string;
  session_dir: string;
  current_task: string;
  task_count: number;
  created_at: string;
}

interface HookInput {
  session_id: string;
  transcript_path: string;
  hook_event_name: string;
}

type EffortLevel = 'QUICK' | 'STANDARD' | 'THOROUGH' | 'TRIVIAL';

interface CaptureMetadata {
  lastCaptureAt: string;
  responseChars: number;
  criteriaExtractedCount: number;
  warnings: string[];
}

interface ISCDocument {
  taskId: string;
  status: string;
  effortLevel: string;
  criteria: string[];
  antiCriteria: string[];
  satisfaction: {
    satisfied: number;
    partial: number;
    failed: number;
    total: number;
  } | null;
  captureMetadata?: CaptureMetadata;
  iscSyncSource?: string;
  iscSyncAt?: string;
  iscSyncCount?: number;
  iscSyncVerified?: boolean;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// ISC Extraction Helpers
// ============================================================================

function extractEffortLevel(text: string): EffortLevel | null {
  const match = text.match(/level\s+(QUICK|STANDARD|THOROUGH|TRIVIAL)/i);
  return match ? (match[1].toUpperCase() as EffortLevel) : null;
}

function extractISCSatisfaction(text: string): ISCDocument['satisfaction'] | null {
  // Match patterns like "6 ISC criteria, all satisfied"
  const allSatisfied = text.match(/(\d+)\s*(?:ISC\s*)?criteria?,?\s*all\s*satisfied/i);
  if (allSatisfied) {
    const total = parseInt(allSatisfied[1], 10);
    return { satisfied: total, partial: 0, failed: 0, total };
  }

  // Match: X/Y criteria satisfied
  const partial = text.match(/(\d+)\/(\d+)\s*criteria\s*satisfied/i);
  if (partial) {
    return {
      satisfied: parseInt(partial[1], 10),
      total: parseInt(partial[2], 10),
      partial: 0,
      failed: 0,
    };
  }

  return null;
}

/**
 * Extract criteria from Kaya-format response sections (ACTIONS + RESULTS).
 * Parses numbered/bulleted list items from ⚡ ACTIONS: and ✅ RESULTS: sections.
 */
function extractCriteria(text: string): string[] {
  const criteria: string[] = [];
  const sectionPatterns = [/⚡\s*ACTIONS?:([^]*?)(?=(?:✅|📊|📁|➡️|📖|🗣️|⭐)|$)/i, /✅\s*RESULTS?:([^]*?)(?=(?:📊|📁|➡️|📖|🗣️|⭐)|$)/i];

  for (const pattern of sectionPatterns) {
    const match = text.match(pattern);
    if (!match) continue;

    const sectionText = match[1];
    // Match numbered (1. 2.) or bulleted (- *) list items
    const lines = sectionText.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      const listMatch = trimmed.match(/^(?:\d+[.)]\s*|-\s*|\*\s*)(.+)/);
      if (listMatch) {
        const item = listMatch[1].trim();
        if (item.length > 5) {
          criteria.push(item);
        }
      }
    }
  }

  // Dedup by string equality
  return [...new Set(criteria)];
}

// ============================================================================
// Task ISC Update
// ============================================================================

/**
 * Update task's ISC.json with extracted satisfaction data
 */
function updateTaskISC(sessionDir: string, currentTask: string, text: string): void {
  const taskPath = join(WORK_DIR, sessionDir, 'tasks', currentTask);
  const iscPath = join(taskPath, 'ISC.json');

  if (!existsSync(iscPath)) {
    console.error(`[ISC] Task ISC.json not found: ${iscPath}`);
    return;
  }

  try {
    const doc: ISCDocument = JSON.parse(readFileSync(iscPath, 'utf-8'));
    const timestamp = getISOTimestamp();

    // Extract effort level if found
    const effort = extractEffortLevel(text);
    if (effort) {
      doc.effortLevel = effort;
    }

    // Extract criteria from ACTIONS/RESULTS sections
    const newCriteria = extractCriteria(text);
    if (newCriteria.length > 0) {
      const existing = new Set(doc.criteria);
      for (const c of newCriteria) {
        if (!existing.has(c)) {
          doc.criteria.push(c);
        }
      }
    }

    // Extract satisfaction from response
    const satisfaction = extractISCSatisfaction(text);
    if (satisfaction) {
      doc.satisfaction = satisfaction;
      doc.status = satisfaction.satisfied === satisfaction.total ? 'COMPLETE' : 'PARTIAL';
    }

    // Check for completion marker
    if (text.includes('✓ COMPLETE')) {
      doc.status = 'COMPLETE';
    }

    // Write capture metadata — proves extraction ran and what it found
    const warnings: string[] = [];
    if (text.length > 200 && newCriteria.length === 0) {
      warnings.push('Response contained content but no criteria matched extraction patterns');
    }
    doc.captureMetadata = {
      lastCaptureAt: timestamp,
      responseChars: text.length,
      criteriaExtractedCount: newCriteria.length,
      warnings,
    };

    doc.updatedAt = timestamp;

    writeFileSync(iscPath, JSON.stringify(doc, null, 2), 'utf-8');
    console.error(`[ISC] Updated task ISC: ${currentTask} (${newCriteria.length} criteria extracted)`);
  } catch (err) {
    console.error(`[ISC] Error updating task ISC: ${err}`);
  }
}

/**
 * Update task THREAD.md frontmatter status
 */
function updateTaskMeta(sessionDir: string, currentTask: string, structured: StructuredResponse): void {
  const taskPath = join(WORK_DIR, sessionDir, 'tasks', currentTask);
  const threadPath = join(taskPath, 'THREAD.md');

  if (!existsSync(threadPath)) {
    console.error(`[Capture] Task THREAD.md not found: ${threadPath}`);
    return;
  }

  try {
    let content = readFileSync(threadPath, 'utf-8');
    const timestamp = getISOTimestamp();

    // Update status if complete
    if (structured.completed || structured.summary) {
      content = content.replace(/^status: "IN_PROGRESS"$/m, 'status: "DONE"');

      // Add completedAt if not present in frontmatter
      if (!content.includes('completedAt:')) {
        content = content.replace(/^(---\n[\s\S]*?)(---)/, `$1completedAt: "${timestamp}"\n$2`);
      }

      // Add summary if not present in frontmatter
      const summary = (structured.completed || structured.summary || '').substring(0, 200);
      if (summary && !content.includes('summary:')) {
        content = content.replace(/^(---\n[\s\S]*?)(---)/, `$1summary: "${summary.replace(/"/g, '\\"')}"\n$2`);
      }
    }

    writeFileSync(threadPath, content, 'utf-8');
    console.error(`[Capture] Updated task THREAD: ${currentTask}`);
  } catch (err) {
    console.error(`[Capture] Error updating task META: ${err}`);
  }
}

/**
 * Extract phase content from Kaya-format response into THREAD.md phase placeholders.
 * Only replaces _Pending..._ — never overwrites existing content.
 * Also writes capture metadata into THREAD.md frontmatter.
 */
function updateTaskPhases(sessionDir: string, currentTask: string, text: string): void {
  const taskPath = join(WORK_DIR, sessionDir, 'tasks', currentTask);
  const threadPath = join(taskPath, 'THREAD.md');

  if (!existsSync(threadPath)) {
    console.error(`[Capture] Task THREAD.md not found for phase capture: ${threadPath}`);
    return;
  }

  try {
    let content = readFileSync(threadPath, 'utf-8');
    const timestamp = getISOTimestamp();

    // Map response sections to THREAD.md phase headers
    const phaseMap: Array<{ responsePattern: RegExp; phaseHeader: string }> = [
      { responsePattern: /📋\s*SUMMARY:([^]*?)(?=(?:🔍|⚡|✅|📊|📁|➡️|📖|🗣️|⭐)|$)/i, phaseHeader: '### 👀 OBSERVE Phase' },
      { responsePattern: /🔍\s*ANALYSIS:([^]*?)(?=(?:⚡|✅|📊|📁|➡️|📖|🗣️|⭐)|$)/i, phaseHeader: '### 🧠 THINK Phase' },
      { responsePattern: /⚡\s*ACTIONS?:([^]*?)(?=(?:✅|📊|📁|➡️|📖|🗣️|⭐)|$)/i, phaseHeader: '### 🔨 BUILD Phase' },
      { responsePattern: /✅\s*RESULTS?:([^]*?)(?=(?:📊|📁|➡️|📖|🗣️|⭐)|$)/i, phaseHeader: '### ✅ VERIFY Phase' },
      { responsePattern: /📖\s*STORY\s*EXPLANATION:([^]*?)(?=(?:⭐|🗣️)|$)/i, phaseHeader: '### 🎓 LEARN Phase' },
    ];

    const populatedPhases: string[] = [];

    for (const { responsePattern, phaseHeader } of phaseMap) {
      const match = text.match(responsePattern);
      if (!match) continue;

      const extracted = match[1].trim();
      if (!extracted || extracted.length < 5) continue;

      // Only replace _Pending..._ placeholders — never overwrite existing content
      const phaseRegex = new RegExp(
        `(${phaseHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\n_Pending\\.\\.\\._`
      );
      if (phaseRegex.test(content)) {
        content = content.replace(phaseRegex, `$1\n${extracted}`);
        // Track which phase name was populated (e.g., "OBSERVE", "THINK")
        const phaseName = phaseHeader.match(/(\w+) Phase/)?.[1] ?? phaseHeader;
        populatedPhases.push(phaseName);
      }
    }

    // Write capture metadata into THREAD.md frontmatter
    if (content.startsWith('---')) {
      const frontmatterEnd = content.indexOf('---', 3);
      if (frontmatterEnd !== -1) {
        const before = content.slice(0, frontmatterEnd);
        const after = content.slice(frontmatterEnd);

        // Remove existing capture metadata if present (for re-runs)
        let cleaned = before
          .replace(/^captureAttemptedAt:.*\n/m, '')
          .replace(/^phasesPopulated:.*\n/m, '')
          .replace(/^phasesPopulatedList:.*\n/m, '')
          .replace(/^responseChars:.*\n/m, '');

        cleaned += `captureAttemptedAt: "${timestamp}"\n`;
        cleaned += `phasesPopulated: ${populatedPhases.length}\n`;
        if (populatedPhases.length > 0) {
          cleaned += `phasesPopulatedList: "${populatedPhases.join(',')}"\n`;
        }
        cleaned += `responseChars: ${text.length}\n`;

        content = cleaned + after;
      }
    }

    writeFileSync(threadPath, content, 'utf-8');
    console.error(`[Capture] Updated THREAD phases: ${currentTask} (${populatedPhases.length} phases populated)`);
  } catch (err) {
    console.error(`[Capture] Error updating task phases: ${err}`);
  }
}

// ============================================================================
// Learning Capture
// ============================================================================

function generateFilename(description: string, type: 'LEARNING' | 'WORK'): string {
  const pstTimestamp = getPSTTimestamp();
  const date = pstTimestamp.slice(0, 10);
  const time = pstTimestamp.slice(11, 19).replace(/:/g, '');

  const cleanDesc = description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60);

  return `${date}-${time}_${type}_${cleanDesc}.md`;
}

function generateLearningContent(structured: StructuredResponse, fullText: string, timestamp: string): string {
  return `---
capture_type: LEARNING
timestamp: ${timestamp}
auto_captured: true
tags: [auto-capture]
---

# Quick Learning: ${structured.completed || structured.summary || 'Task Completion'}

**Date:** ${structured.date || getPSTDate()}
**Auto-captured:** Yes

---

## Summary

${structured.summary || 'N/A'}

## Analysis

${structured.analysis || 'N/A'}

## Actions Taken

${structured.actions || 'N/A'}

## Results

${structured.results || 'N/A'}

## Current Status

${structured.status || 'N/A'}

## Next Steps

${structured.next || 'N/A'}

---

<details>
<summary>Full Response</summary>

${fullText.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')}

</details>
`;
}

// ============================================================================
// Main Capture Logic
// ============================================================================

function readCurrentWork(): CurrentWork | null {
  try {
    if (!existsSync(CURRENT_WORK_FILE)) return null;
    return JSON.parse(readFileSync(CURRENT_WORK_FILE, 'utf-8'));
  } catch (err) {
    console.error(`[Capture] Error reading current-work.json: ${err}`);
    return null;
  }
}

async function captureWorkSummary(text: string, structured: StructuredResponse): Promise<void> {
  try {
    const currentWork = readCurrentWork();

    if (currentWork?.session_dir && currentWork?.current_task) {
      // Update task ISC with satisfaction data + criteria extraction
      updateTaskISC(currentWork.session_dir, currentWork.current_task, text);

      // Always attempt phase capture for active tasks (unconditional)
      updateTaskPhases(currentWork.session_dir, currentWork.current_task, text);

      // Update completion metadata only when response signals completion
      if (structured.summary || structured.completed) {
        updateTaskMeta(currentWork.session_dir, currentWork.current_task, structured);
      }
    }

    // Learning capture (unchanged)
    const isLearning = isLearningCapture(text, structured.summary, structured.analysis);

    if (isLearning) {
      let description = (structured.completed || structured.summary || 'task-completion')
        .replace(/^Completed\s+/i, '')
        .replace(/\[AGENT:\w+\]\s*/gi, '')
        .replace(/\[.*?\]/g, '')
        .trim();

      if (!description || description.length < 3) {
        description = structured.summary || structured.analysis || 'task-completion';
        description = description.replace(/^Completed\s+/i, '').trim();
      }

      if (!description || description.length < 3) {
        description = 'general-task';
      }

      const yearMonth = getYearMonth();
      const filename = generateFilename(description, 'LEARNING');
      const category = getLearningCategory(text);
      const targetDir = join(BASE_DIR, 'MEMORY', 'LEARNING', category, yearMonth);

      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
      }

      const filePath = join(targetDir, filename);
      const timestamp = getPSTTimestamp();
      const content = generateLearningContent(structured, text, timestamp);

      writeFileSync(filePath, content, 'utf-8');
      console.log(`✅ Captured learning to: ${filePath}`);
    }
  } catch (error) {
    console.error('[Capture] Error capturing work summary:', error);
  }
}

/**
 * Handle response capture with pre-parsed transcript data.
 */
export async function handleCapture(parsed: ParsedTranscript, hookInput: HookInput): Promise<void> {
  const { lastMessage, structured, plainCompletion } = parsed;

  // Capture work summary (async, non-blocking)
  if (lastMessage) {
    captureWorkSummary(lastMessage, structured).catch(err => {
      console.error('[Capture] History capture failed (non-critical):', err);
    });
  }

  // Push notifications for long tasks
  const duration = getSessionDurationMinutes();
  if (duration > 0) {
    console.error(`⏱️ Session duration: ${duration.toFixed(1)} minutes`);
  }

  const hasError = lastMessage && (
    /error|failed|exception|crash/i.test(lastMessage) &&
    /📊\s*STATUS:.*(?:error|failed|broken)/i.test(lastMessage)
  );

  if (hasError) {
    notifyError(plainCompletion).catch(() => {});
  } else {
    notifyTaskComplete(plainCompletion).catch(() => {});
  }

  // Observability event
  await sendEventToObservability({
    source_app: getSourceApp(),
    session_id: hookInput.session_id,
    hook_event_type: 'Stop',
    timestamp: getCurrentTimestamp(),
    transcript_path: hookInput.transcript_path,
    summary: structured.completed || plainCompletion,
  }).catch(() => {});
}
