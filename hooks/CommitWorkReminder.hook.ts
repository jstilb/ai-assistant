#!/usr/bin/env bun
/**
 * CommitWorkReminder.hook.ts - PostToolUse Work Queue Reminder
 *
 * PURPOSE:
 * Detects git commit commands and reminds the session about active work items
 * that may need status updates. Prevents the common failure mode where agents
 * commit code but never update the work queue.
 *
 * TRIGGER: PostToolUse (matcher: Bash)
 *
 * INPUT:
 * - tool_name: "Bash"
 * - tool_input: { command: string }
 * - tool_output: string (commit output)
 * - session_id: Current session identifier
 *
 * OUTPUT:
 * - stdout: None (advisory only)
 * - exit(0): Always (non-blocking)
 *
 * SIDE EFFECTS:
 * - Writes advisory to stderr when active work items exist after a commit
 *
 * ERROR HANDLING:
 * - All errors fail-open (exit 0)
 * - Never blocks tool execution
 *
 * PERFORMANCE:
 * - Fast-path exit for non-commit commands (<1ms for 99% of Bash calls)
 * - Only reads work-queue.json after confirming a real git commit
 */

import { readFileSync } from 'fs';
import { kayaPath } from './lib/paths';

// ========================================
// Types
// ========================================

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: { command?: string } | string;
  tool_output?: string | Record<string, unknown>;
  error?: string;
}

interface WorkQueueItem {
  id: string;
  title: string;
  status: string;
  workType: string;
}

interface WorkQueueState {
  items: WorkQueueItem[];
  lastUpdated: string;
  totalProcessed: number;
  totalFailed: number;
}

// ========================================
// Main
// ========================================

async function main(): Promise<void> {
  let input: HookInput;

  try {
    const text = await Promise.race([
      Bun.stdin.text(),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 100)
      )
    ]);

    if (!text.trim()) {
      process.exit(0);
      return;
    }

    input = JSON.parse(text);
  } catch {
    process.exit(0);
    return;
  }

  // Fast-path: only care about Bash commands containing "git commit"
  const command = typeof input.tool_input === 'string'
    ? input.tool_input
    : input.tool_input?.command ?? '';

  if (!command.includes('git commit')) {
    process.exit(0);
    return;
  }

  // Confirm it's a real commit (not git commit --amend --abort, etc. in a comment)
  if (!/\bgit\s+commit\b/.test(command)) {
    process.exit(0);
    return;
  }

  // Read work queue — fail-open on any error
  let queue: WorkQueueState;
  try {
    const raw = readFileSync(kayaPath('MEMORY', 'WORK', 'work-queue.json'), 'utf-8');
    queue = JSON.parse(raw);
  } catch {
    process.exit(0);
    return;
  }

  // Filter for active items (in_progress or partial), excluding approval-type items
  const activeItems = queue.items.filter(item =>
    (item.status === 'in_progress' || item.status === 'partial') &&
    item.workType !== 'approval'
  );

  if (activeItems.length === 0) {
    process.exit(0);
    return;
  }

  // Output advisory to stderr
  console.error('\n⚠️  [WorkReminder] Active work items detected after commit:');
  for (const item of activeItems) {
    const truncTitle = item.title.length > 60
      ? item.title.slice(0, 57) + '...'
      : item.title;
    console.error(`    - ${item.id} "${truncTitle}" [${item.status}]`);
  }
  console.error('    Update status: bun run ~/.claude/skills/AutonomousWork/Tools/WorkOrchestrator.ts complete <id>');
  console.error('');

  process.exit(0);
}

main().catch(() => {
  process.exit(0);
});
