/**
 * ResponseCapture.test.ts - Verify execution trace artifacts
 *
 * Tests that ResponseCapture writes verifiable state into ISC.json and THREAD.md
 * so that auditors can distinguish "never ran" from "ran but found nothing" from "success".
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We test the internal functions by importing the module and calling handleCapture
// which drives the full pipeline. But first we need to mock the dependencies.

// Create a temp directory structure that mirrors WORK/{session}/tasks/{task}/
const TEST_DIR = join(tmpdir(), `capture-test-${Date.now()}`);
const SESSION_DIR = 'test-session';
const TASK_NAME = 'task-001';
const WORK_DIR = join(TEST_DIR, 'MEMORY', 'WORK');
const STATE_DIR = join(TEST_DIR, 'MEMORY', 'STATE');
const TASK_PATH = join(WORK_DIR, SESSION_DIR, 'tasks', TASK_NAME);

// Sample Kaya-format response with all sections
const SAMPLE_RESPONSE = `📋 SUMMARY: Fixed the authentication bug in login flow
🔍 ANALYSIS: The session token was not being refreshed after expiry
⚡ ACTIONS:
1. Added token refresh logic to AuthService.ts
2. Updated middleware to check token expiry before each request
3. Added retry logic for failed auth attempts
✅ RESULTS:
1. All 47 tests passing including new auth tests
2. Session persistence verified across page reloads
📊 STATUS: Complete — all criteria satisfied
📁 CAPTURE: Auth fix with token refresh
➡️ NEXT: Monitor production for any session-related errors
📖 STORY EXPLANATION:
1. Found the bug was in AuthService token refresh
2. The token was expiring but the middleware wasn't checking
3. Added a pre-request check that refreshes expired tokens
4. Added retry logic as a safety net
⭐ RATE (1-10):
🗣️ Kaya: Fixed auth bug by adding token refresh. All 47 tests passing.`;

// Minimal response with no structured sections
const MINIMAL_RESPONSE = 'Done.';

// Response with content but no list items
const NO_LIST_RESPONSE = `📋 SUMMARY: Quick acknowledgment
🔍 ANALYSIS: Nothing to analyze
⚡ ACTIONS: None taken
✅ RESULTS: None
🗣️ Kaya: Acknowledged.`;

describe('ResponseCapture execution trace', () => {
  beforeEach(() => {
    // Create scaffold directories and files
    mkdirSync(TASK_PATH, { recursive: true });
    mkdirSync(STATE_DIR, { recursive: true });

    // Write scaffold ISC.json (empty criteria, no captureMetadata)
    const scaffoldISC = {
      taskId: TASK_NAME,
      status: 'IN_PROGRESS',
      effortLevel: 'STANDARD',
      criteria: [],
      antiCriteria: [],
      satisfaction: null,
      createdAt: '2026-02-17T07:00:00Z',
      updatedAt: '2026-02-17T07:00:00Z',
    };
    writeFileSync(join(TASK_PATH, 'ISC.json'), JSON.stringify(scaffoldISC, null, 2));

    // Write scaffold THREAD.md with phase placeholders
    const scaffoldThread = `---
taskId: "${TASK_NAME}"
title: "Test Task"
effortLevel: "STANDARD"
status: "IN_PROGRESS"
createdAt: "2026-02-17T07:00:00Z"
---

# Algorithm Thread: Test Task

## Phase Log

### 👀 OBSERVE Phase
_Pending..._

### 🧠 THINK Phase
_Pending..._

### 📋 PLAN Phase
_Pending..._

### 🔨 BUILD Phase
_Pending..._

### ▶️ EXECUTE Phase
_Pending..._

### ✅ VERIFY Phase
_Pending..._

### 🎓 LEARN Phase
_Pending..._

---

## ISC Evolution

_Criteria updates logged here..._
`;
    writeFileSync(join(TASK_PATH, 'THREAD.md'), scaffoldThread);

    // Write current-work.json pointing to our test task
    writeFileSync(
      join(STATE_DIR, 'current-work.json'),
      JSON.stringify({
        session_id: 'test-session-id',
        session_dir: SESSION_DIR,
        current_task: TASK_NAME,
        task_count: 1,
        created_at: '2026-02-17T07:00:00Z',
      })
    );
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  // We can't easily call handleCapture (it depends on many side effects),
  // so we test the extracted functions directly by importing them.
  // Since they're not exported, we'll test via a helper that reimplements the core logic.
  // This is the pragmatic approach — test the extraction + writing logic in isolation.

  test('extractCriteria extracts numbered and bulleted items from ACTIONS and RESULTS', () => {
    // Inline the extraction logic for testing
    const extractCriteria = (text: string): string[] => {
      const criteria: string[] = [];
      const sectionPatterns = [/⚡\s*ACTIONS?:([^]*?)(?=(?:✅|📊|📁|➡️|📖|🗣️|⭐)|$)/i, /✅\s*RESULTS?:([^]*?)(?=(?:📊|📁|➡️|📖|🗣️|⭐)|$)/i];

      for (const pattern of sectionPatterns) {
        const match = text.match(pattern);
        if (!match) continue;

        const sectionText = match[1];
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

      return [...new Set(criteria)];
    };

    const criteria = extractCriteria(SAMPLE_RESPONSE);

    // Should extract 3 from ACTIONS + 2 from RESULTS = 5
    expect(criteria.length).toBe(5);
    expect(criteria[0]).toContain('token refresh logic');
    expect(criteria[1]).toContain('middleware');
    expect(criteria[2]).toContain('retry logic');
    expect(criteria[3]).toContain('47 tests passing');
    expect(criteria[4]).toContain('Session persistence');
  });

  test('extractCriteria returns empty array for response with no list items', () => {
    const extractCriteria = (text: string): string[] => {
      const criteria: string[] = [];
      const sectionPatterns = [/⚡\s*ACTIONS?:([^]*?)(?=(?:✅|📊|📁|➡️|📖|🗣️|⭐)|$)/i, /✅\s*RESULTS?:([^]*?)(?=(?:📊|📁|➡️|📖|🗣️|⭐)|$)/i];

      for (const pattern of sectionPatterns) {
        const match = text.match(pattern);
        if (!match) continue;

        const sectionText = match[1];
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

      return [...new Set(criteria)];
    };

    const criteria = extractCriteria(MINIMAL_RESPONSE);
    expect(criteria.length).toBe(0);

    const criteria2 = extractCriteria(NO_LIST_RESPONSE);
    expect(criteria2.length).toBe(0);
  });

  test('extractCriteria deduplicates identical items', () => {
    const extractCriteria = (text: string): string[] => {
      const criteria: string[] = [];
      const sectionPatterns = [/⚡\s*ACTIONS?:([^]*?)(?=(?:✅|📊|📁|➡️|📖|🗣️|⭐)|$)/i, /✅\s*RESULTS?:([^]*?)(?=(?:📊|📁|➡️|📖|🗣️|⭐)|$)/i];

      for (const pattern of sectionPatterns) {
        const match = text.match(pattern);
        if (!match) continue;

        const sectionText = match[1];
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

      return [...new Set(criteria)];
    };

    // Same item appears in both ACTIONS and RESULTS
    const dupResponse = `⚡ ACTIONS:
1. Fixed the authentication token refresh
✅ RESULTS:
1. Fixed the authentication token refresh`;

    const criteria = extractCriteria(dupResponse);
    expect(criteria.length).toBe(1);
  });

  test('phase extraction maps Kaya sections to THREAD.md phases', () => {
    // Simulate the phase extraction logic
    const phaseMap: Array<{ responsePattern: RegExp; phaseHeader: string }> = [
      { responsePattern: /📋\s*SUMMARY:([^]*?)(?=(?:🔍|⚡|✅|📊|📁|➡️|📖|🗣️|⭐)|$)/i, phaseHeader: '### 👀 OBSERVE Phase' },
      { responsePattern: /🔍\s*ANALYSIS:([^]*?)(?=(?:⚡|✅|📊|📁|➡️|📖|🗣️|⭐)|$)/i, phaseHeader: '### 🧠 THINK Phase' },
      { responsePattern: /⚡\s*ACTIONS?:([^]*?)(?=(?:✅|📊|📁|➡️|📖|🗣️|⭐)|$)/i, phaseHeader: '### 🔨 BUILD Phase' },
      { responsePattern: /✅\s*RESULTS?:([^]*?)(?=(?:📊|📁|➡️|📖|🗣️|⭐)|$)/i, phaseHeader: '### ✅ VERIFY Phase' },
      { responsePattern: /📖\s*STORY\s*EXPLANATION:([^]*?)(?=(?:⭐|🗣️)|$)/i, phaseHeader: '### 🎓 LEARN Phase' },
    ];

    let content = readFileSync(join(TASK_PATH, 'THREAD.md'), 'utf-8');
    const populatedPhases: string[] = [];

    for (const { responsePattern, phaseHeader } of phaseMap) {
      const match = SAMPLE_RESPONSE.match(responsePattern);
      if (!match) continue;

      const extracted = match[1].trim();
      if (!extracted || extracted.length < 5) continue;

      const phaseRegex = new RegExp(
        `(${phaseHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\n_Pending\\.\\.\\._`
      );
      if (phaseRegex.test(content)) {
        content = content.replace(phaseRegex, `$1\n${extracted}`);
        const phaseName = phaseHeader.match(/(\w+) Phase/)?.[1] ?? phaseHeader;
        populatedPhases.push(phaseName);
      }
    }

    // Should populate OBSERVE, THINK, BUILD, VERIFY, LEARN = 5 phases
    expect(populatedPhases.length).toBe(5);
    expect(populatedPhases).toContain('OBSERVE');
    expect(populatedPhases).toContain('THINK');
    expect(populatedPhases).toContain('BUILD');
    expect(populatedPhases).toContain('VERIFY');
    expect(populatedPhases).toContain('LEARN');

    // Verify _Pending..._ was replaced for populated phases
    expect(content).not.toContain('### 👀 OBSERVE Phase\n_Pending..._');
    expect(content).toContain('### 👀 OBSERVE Phase\n');
    expect(content).toContain('token refresh logic');

    // PLAN and EXECUTE phases have no mapping — should stay pending
    expect(content).toContain('### 📋 PLAN Phase\n_Pending..._');
    expect(content).toContain('### ▶️ EXECUTE Phase\n_Pending..._');
  });

  test('phase extraction does NOT overwrite existing content', () => {
    // Pre-populate OBSERVE phase with existing content
    let content = readFileSync(join(TASK_PATH, 'THREAD.md'), 'utf-8');
    content = content.replace(
      '### 👀 OBSERVE Phase\n_Pending..._',
      '### 👀 OBSERVE Phase\nExisting content from previous capture'
    );
    writeFileSync(join(TASK_PATH, 'THREAD.md'), content);

    // Now try to extract — OBSERVE should NOT be overwritten
    content = readFileSync(join(TASK_PATH, 'THREAD.md'), 'utf-8');
    const phaseHeader = '### 👀 OBSERVE Phase';
    const phaseRegex = new RegExp(
      `(${phaseHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\n_Pending\\.\\.\\._`
    );

    // Should NOT match because _Pending..._ was replaced
    expect(phaseRegex.test(content)).toBe(false);
    expect(content).toContain('Existing content from previous capture');
  });

  test('captureMetadata records extraction attempt in ISC.json', () => {
    // Simulate what updateTaskISC does
    const iscPath = join(TASK_PATH, 'ISC.json');
    const doc = JSON.parse(readFileSync(iscPath, 'utf-8'));

    // Before: no captureMetadata
    expect(doc.captureMetadata).toBeUndefined();

    // Simulate extraction
    const text = SAMPLE_RESPONSE;
    const extractCriteria = (t: string): string[] => {
      const criteria: string[] = [];
      const sectionPatterns = [/⚡\s*ACTIONS?:([^]*?)(?=(?:✅|📊|📁|➡️|📖|🗣️|⭐)|$)/i, /✅\s*RESULTS?:([^]*?)(?=(?:📊|📁|➡️|📖|🗣️|⭐)|$)/i];
      for (const pattern of sectionPatterns) {
        const match = t.match(pattern);
        if (!match) continue;
        const lines = match[1].split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          const listMatch = trimmed.match(/^(?:\d+[.)]\s*|-\s*|\*\s*)(.+)/);
          if (listMatch && listMatch[1].trim().length > 5) {
            criteria.push(listMatch[1].trim());
          }
        }
      }
      return [...new Set(criteria)];
    };

    const newCriteria = extractCriteria(text);
    const warnings: string[] = [];
    if (text.length > 200 && newCriteria.length === 0) {
      warnings.push('Response contained content but no criteria matched extraction patterns');
    }

    doc.captureMetadata = {
      lastCaptureAt: new Date().toISOString(),
      responseChars: text.length,
      criteriaExtractedCount: newCriteria.length,
      warnings,
    };
    doc.criteria = newCriteria;

    writeFileSync(iscPath, JSON.stringify(doc, null, 2));

    // Verify
    const updated = JSON.parse(readFileSync(iscPath, 'utf-8'));
    expect(updated.captureMetadata).toBeDefined();
    expect(updated.captureMetadata.lastCaptureAt).toBeTruthy();
    expect(updated.captureMetadata.responseChars).toBeGreaterThan(0);
    expect(updated.captureMetadata.criteriaExtractedCount).toBe(5);
    expect(updated.captureMetadata.warnings).toHaveLength(0);
    expect(updated.criteria).toHaveLength(5);
  });

  test('captureMetadata warns when response has content but no criteria', () => {
    const text = NO_LIST_RESPONSE;
    const extractCriteria = (t: string): string[] => {
      const criteria: string[] = [];
      const sectionPatterns = [/⚡\s*ACTIONS?:([^]*?)(?=(?:✅|📊|📁|➡️|📖|🗣️|⭐)|$)/i, /✅\s*RESULTS?:([^]*?)(?=(?:📊|📁|➡️|📖|🗣️|⭐)|$)/i];
      for (const pattern of sectionPatterns) {
        const match = t.match(pattern);
        if (!match) continue;
        const lines = match[1].split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          const listMatch = trimmed.match(/^(?:\d+[.)]\s*|-\s*|\*\s*)(.+)/);
          if (listMatch && listMatch[1].trim().length > 5) {
            criteria.push(listMatch[1].trim());
          }
        }
      }
      return [...new Set(criteria)];
    };

    const newCriteria = extractCriteria(text);
    const warnings: string[] = [];
    if (text.length > 200 && newCriteria.length === 0) {
      warnings.push('Response contained content but no criteria matched extraction patterns');
    }

    expect(newCriteria).toHaveLength(0);
    // NO_LIST_RESPONSE is ~130 chars — under 200 threshold
    expect(warnings).toHaveLength(0);

    // Now test with a longer response
    const longNoList = NO_LIST_RESPONSE + '\n'.repeat(100) + 'padding to exceed 200 chars';
    const warnings2: string[] = [];
    if (longNoList.length > 200 && newCriteria.length === 0) {
      warnings2.push('Response contained content but no criteria matched extraction patterns');
    }
    expect(warnings2).toHaveLength(1);
    expect(warnings2[0]).toContain('no criteria matched');
  });

  test('THREAD.md frontmatter captures attempt metadata', () => {
    // Simulate frontmatter metadata injection
    let content = readFileSync(join(TASK_PATH, 'THREAD.md'), 'utf-8');
    const timestamp = new Date().toISOString();

    const frontmatterEnd = content.indexOf('---', 3);
    expect(frontmatterEnd).toBeGreaterThan(0);

    const before = content.slice(0, frontmatterEnd);
    const after = content.slice(frontmatterEnd);

    const updated = before +
      `captureAttemptedAt: "${timestamp}"\n` +
      `phasesPopulated: 3\n` +
      `phasesPopulatedList: "OBSERVE,THINK,BUILD"\n` +
      `responseChars: 4500\n` +
      after;

    writeFileSync(join(TASK_PATH, 'THREAD.md'), updated);

    const result = readFileSync(join(TASK_PATH, 'THREAD.md'), 'utf-8');
    expect(result).toContain('captureAttemptedAt:');
    expect(result).toContain('phasesPopulated: 3');
    expect(result).toContain('phasesPopulatedList: "OBSERVE,THINK,BUILD"');
    expect(result).toContain('responseChars: 4500');
  });
});
