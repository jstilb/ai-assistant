#!/usr/bin/env bun
/**
 * @deprecated LEGACY - This tool predates the QueueManager/JSONL queue system.
 * It exports tasks to a standalone JSON file in MEMORY/State/ rather than using
 * the standard JSONL queue format in MEMORY/QUEUES/. New code should use
 * QueueManager.ts instead. Retained for backward compatibility with older
 * workflows that may still reference the JSON export format.
 *
 * ExportTaskQueue.ts
 *
 * Deterministic tool for exporting tasks to JSON queue.
 * Ensures consistent task queue creation for autonomous work workflows.
 *
 * Usage:
 *   echo '{"tasks": [...]}' | bun run $KAYA_DIR/tools/ExportTaskQueue.ts
 *   bun run $KAYA_DIR/tools/ExportTaskQueue.ts --date 2026-01-23 --source "daily-maintenance"
 *
 * Input format (JSON via stdin):
 * {
 *   "tasks": [
 *     {
 *       "title": "Task title",
 *       "description": "Task description",
 *       "category": "Kaya Development" | "D&D" | etc,
 *       "priority": "high" | "medium" | "low",
 *       "note": "Optional note"
 *     }
 *   ]
 * }
 *
 * Output: MEMORY/State/queued-tasks-{date}.json
 */

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

const KAYA_DIR = process.env.KAYA_DIR || process.env.KAYA_HOME || join(process.env.HOME || '', '.claude');
const STATE_DIR = join(KAYA_DIR, 'MEMORY', 'State');

interface Task {
  title: string;
  description: string;
  category: string;
  priority: 'high' | 'medium' | 'low';
  note?: string;
}

interface TaskInput {
  tasks: Task[];
  source?: string;
}

interface TaskQueue {
  generated: string;
  source: string;
  note: string;
  tasks: Task[];
}

async function exportTaskQueue(input: TaskInput, date?: string): Promise<string> {
  // Ensure state directory exists
  if (!existsSync(STATE_DIR)) {
    await mkdir(STATE_DIR, { recursive: true });
  }

  // Generate filename
  const dateStr = date || new Date().toISOString().split('T')[0];
  const filename = `queued-tasks-${dateStr}.json`;
  const filepath = join(STATE_DIR, filename);

  // Create queue object
  const queue: TaskQueue = {
    generated: new Date().toISOString().replace('T', ' ').split('.')[0] + getTimezoneOffset(),
    source: input.source || 'manual-export',
    note: 'Tasks queued for manual creation or later processing',
    tasks: input.tasks,
  };

  // Write to file
  await writeFile(filepath, JSON.stringify(queue, null, 2), 'utf-8');

  return filepath;
}

function getTimezoneOffset(): string {
  const offset = -new Date().getTimezoneOffset();
  const hours = Math.floor(Math.abs(offset) / 60);
  const minutes = Math.abs(offset) % 60;
  const sign = offset >= 0 ? '+' : '-';
  return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  const args = process.argv.slice(2);

  // Parse CLI arguments
  const dateArg = args.find(arg => arg.startsWith('--date='))?.split('=')[1];
  const sourceArg = args.find(arg => arg.startsWith('--source='))?.split('=')[1];

  // Read input from stdin
  const inputStr = await readStdin();

  if (!inputStr.trim()) {
    console.error('❌ No input provided. Expected JSON via stdin.');
    console.error('\nUsage:');
    console.error('  echo \'{"tasks": [...]}\' | bun run ExportTaskQueue.ts');
    process.exit(1);
  }

  let input: TaskInput;
  try {
    input = JSON.parse(inputStr);
  } catch (err) {
    console.error('❌ Invalid JSON input:', err);
    process.exit(1);
  }

  // Override source if provided via CLI
  if (sourceArg) {
    input.source = sourceArg;
  }

  // Validate input
  if (!input.tasks || !Array.isArray(input.tasks)) {
    console.error('❌ Input must contain a "tasks" array');
    process.exit(1);
  }

  if (input.tasks.length === 0) {
    console.log('ℹ️  No tasks to export');
    process.exit(0);
  }

  // Export queue
  const filepath = await exportTaskQueue(input, dateArg);

  // Report success
  console.log(`✅ Exported ${input.tasks.length} tasks to: ${filepath}`);
  console.log(`\nQueue summary:`);
  console.log(`  Generated: ${new Date().toISOString()}`);
  console.log(`  Source: ${input.source || 'manual-export'}`);
  console.log(`  Tasks: ${input.tasks.length}`);
  console.log(`\nPriority breakdown:`);
  const high = input.tasks.filter(t => t.priority === 'high').length;
  const medium = input.tasks.filter(t => t.priority === 'medium').length;
  const low = input.tasks.filter(t => t.priority === 'low').length;
  console.log(`  High:   ${high}`);
  console.log(`  Medium: ${medium}`);
  console.log(`  Low:    ${low}`);
}

main().catch(console.error);
