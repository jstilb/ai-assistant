#!/usr/bin/env bun
/**
 * ============================================================================
 * SkillIntegrationBridge - Unified integration layer for Kaya skills
 * ============================================================================
 *
 * PURPOSE:
 * Provides a standardized API for skills to emit signals to the Kaya ecosystem:
 * - Insights (MemoryStore)
 * - Notifications (Voice, Push, Discord)
 * - Eval signals (AgentMonitor, Simulation feedback)
 * - ISC updates (Work tracking)
 *
 * DESIGN PRINCIPLES:
 * - Zero dependencies on skill internals
 * - Fail-silent error handling (never throw)
 * - Independently importable functions
 * - CLI interface for shell-based usage
 * - Strict TypeScript types
 *
 * USAGE:
 *   // As library
 *   import { emitInsight, emitNotification } from './SkillIntegrationBridge';
 *   await emitInsight({ source: 'MySkill', type: 'learning', title: '...', content: '...', tags: ['x'] });
 *   emitNotification('Task complete', { priority: 'high' });
 *
 *   // As CLI
 *   bun SkillIntegrationBridge.ts insight --source X --type learning --title "T" --content "C" --tags a,b
 *   bun SkillIntegrationBridge.ts notify --message "Hello" --agent Kaya --priority high
 *   bun SkillIntegrationBridge.ts eval --source X --signal-type failure --description "D" --category C
 *   bun SkillIntegrationBridge.ts isc --source X --row 1 --status DONE --verify-result PASS
 *
 * @author Kaya Engineering
 * @version 1.0.0
 */

import { existsSync, appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parseArgs } from 'util';

// Import from CORE tools
import { memoryStore } from './MemoryStore';
import { notifySync, notify } from './NotificationService';

// ============================================================================
// Types
// ============================================================================

export interface InsightPayload {
  source: string;
  type: 'learning' | 'decision' | 'artifact' | 'insight' | 'signal' | 'research';
  category?: string;
  title: string;
  content: string;
  tags: string[];
  tier?: 'hot' | 'warm' | 'cold';
  ttl?: number;
  metadata?: Record<string, unknown>;
}

export interface NotifyOpts {
  channel?: 'voice' | 'push' | 'discord';
  priority?: 'low' | 'normal' | 'high' | 'critical';
  agentName?: string;
  voiceId?: string;
  fallback?: boolean;
}

export interface EvalSignalPayload {
  source: string;
  signalType: 'failure' | 'success' | 'regression' | 'capability_result';
  description: string;
  category: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  suite?: string;
  score?: number;
  rawData?: Record<string, unknown>;
}

export interface ISCUpdatePayload {
  source: string;
  row: number;
  status?: 'PENDING' | 'ACTIVE' | 'DONE' | 'ADJUSTED' | 'BLOCKED' | 'VERIFIED';
  result?: string;
  verifyResult?: 'PASS' | 'ADJUSTED' | 'BLOCKED';
  reason?: string;
}

export interface ISCRow {
  id: number;
  description: string;
  status: string;
  [key: string]: unknown;
}

export type Signal =
  | { kind: 'insight'; payload: InsightPayload }
  | { kind: 'notification'; message: string; opts?: NotifyOpts }
  | { kind: 'eval'; payload: EvalSignalPayload }
  | { kind: 'isc'; payload: ISCUpdatePayload };

// ============================================================================
// Constants
// ============================================================================

const KAYA_DIR = process.env.KAYA_DIR || join(homedir(), '.claude');
const EVAL_SIGNALS_PATH = join(KAYA_DIR, 'MEMORY', 'EVAL_SIGNALS', 'signals.jsonl');
const ISC_PATH = join(KAYA_DIR, 'MEMORY', 'Work', 'current-isc.json');

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Emit an insight to MemoryStore
 * @param opts Insight payload
 * @returns Entry ID on success, empty string on failure
 */
export async function emitInsight(opts: InsightPayload): Promise<string> {
  try {
    const entry = await memoryStore.capture({
      type: opts.type,
      category: opts.category,
      title: opts.title,
      content: opts.content,
      tags: opts.tags,
      tier: opts.tier || 'hot',
      ttl: opts.ttl,
      metadata: opts.metadata,
      source: opts.source,
    });
    return entry.id;
  } catch (error) {
    console.error('[SkillIntegrationBridge] emitInsight failed:', error instanceof Error ? error.message : error);
    return '';
  }
}

/**
 * Emit a synchronous notification (fire-and-forget)
 * @param message Notification message
 * @param opts Notification options
 */
export function emitNotification(message: string, opts?: NotifyOpts): void {
  try {
    notifySync(message, {
      channel: opts?.channel,
      priority: opts?.priority,
      agentName: opts?.agentName,
      voiceId: opts?.voiceId,
      fallback: opts?.fallback,
    });
  } catch (error) {
    console.error('[SkillIntegrationBridge] emitNotification failed:', error instanceof Error ? error.message : error);
  }
}

/**
 * Emit an async notification (await result)
 * @param message Notification message
 * @param opts Notification options
 */
export async function emitNotificationAsync(message: string, opts?: NotifyOpts): Promise<void> {
  try {
    await notify(message, {
      channel: opts?.channel,
      priority: opts?.priority,
      agentName: opts?.agentName,
      voiceId: opts?.voiceId,
      fallback: opts?.fallback,
    });
  } catch (error) {
    console.error('[SkillIntegrationBridge] emitNotificationAsync failed:', error instanceof Error ? error.message : error);
  }
}

/**
 * Emit an eval signal to MEMORY/EVAL_SIGNALS/signals.jsonl
 * @param opts Eval signal payload
 */
export async function emitEvalSignal(opts: EvalSignalPayload): Promise<void> {
  try {
    const dir = join(KAYA_DIR, 'MEMORY', 'EVAL_SIGNALS');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const signal = {
      timestamp: new Date().toISOString(),
      source: opts.source,
      signalType: opts.signalType,
      description: opts.description,
      category: opts.category,
      severity: opts.severity || 'medium',
      suite: opts.suite,
      score: opts.score,
      rawData: opts.rawData,
    };

    appendFileSync(EVAL_SIGNALS_PATH, JSON.stringify(signal) + '\n');
  } catch (error) {
    console.error('[SkillIntegrationBridge] emitEvalSignal failed:', error instanceof Error ? error.message : error);
  }
}

/**
 * Emit an ISC update to MEMORY/Work/current-isc.json
 * @param opts ISC update payload
 */
export async function emitISCUpdate(opts: ISCUpdatePayload): Promise<void> {
  try {
    const workDir = join(KAYA_DIR, 'MEMORY', 'Work');
    if (!existsSync(workDir)) {
      mkdirSync(workDir, { recursive: true });
    }

    let isc: { rows: ISCRow[] } = { rows: [] };

    if (existsSync(ISC_PATH)) {
      try {
        const content = readFileSync(ISC_PATH, 'utf-8');
        isc = JSON.parse(content);
      } catch {
        // Invalid JSON, start fresh
        isc = { rows: [] };
      }
    }

    // Find and update the row
    const rowIndex = isc.rows.findIndex((r) => r.id === opts.row);
    if (rowIndex >= 0) {
      const row = isc.rows[rowIndex];
      if (opts.status) row.status = opts.status;
      if (opts.result) row.result = opts.result;
      if (opts.verifyResult) row.verifyResult = opts.verifyResult;
      if (opts.reason) row.reason = opts.reason;

      // Add metadata
      row.lastUpdated = new Date().toISOString();
      row.lastUpdatedBy = opts.source;

      writeFileSync(ISC_PATH, JSON.stringify(isc, null, 2));
    } else {
      console.error(`[SkillIntegrationBridge] ISC row ${opts.row} not found`);
    }
  } catch (error) {
    console.error('[SkillIntegrationBridge] emitISCUpdate failed:', error instanceof Error ? error.message : error);
  }
}

/**
 * Get active ISC rows from current-isc.json
 * @returns Array of ISC rows, or null if not found
 */
export function getActiveISCRows(): ISCRow[] | null {
  try {
    if (!existsSync(ISC_PATH)) {
      return null;
    }

    const content = readFileSync(ISC_PATH, 'utf-8');
    const isc = JSON.parse(content);
    return isc.rows || null;
  } catch (error) {
    console.error('[SkillIntegrationBridge] getActiveISCRows failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Find ISC row by keyword search in description
 * @param keyword Search keyword
 * @returns Row number (ID) or null if not found
 */
export function findISCRowByDescription(keyword: string): number | null {
  try {
    const rows = getActiveISCRows();
    if (!rows) return null;

    const lowerKeyword = keyword.toLowerCase();
    const found = rows.find((r) => r.description?.toLowerCase().includes(lowerKeyword));
    return found ? found.id : null;
  } catch (error) {
    console.error('[SkillIntegrationBridge] findISCRowByDescription failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Emit multiple signals in parallel (batch execution)
 * @param signals Array of signals to emit
 */
export async function emitBatch(signals: Signal[]): Promise<void> {
  try {
    const promises = signals.map(async (signal) => {
      switch (signal.kind) {
        case 'insight':
          return emitInsight(signal.payload);
        case 'notification':
          return emitNotificationAsync(signal.message, signal.opts);
        case 'eval':
          return emitEvalSignal(signal.payload);
        case 'isc':
          return emitISCUpdate(signal.payload);
      }
    });

    await Promise.all(promises);
  } catch (error) {
    console.error('[SkillIntegrationBridge] emitBatch failed:', error instanceof Error ? error.message : error);
  }
}

// ============================================================================
// CLI Interface
// ============================================================================

async function runCli(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      // Insight options
      source: { type: 'string' },
      type: { type: 'string' },
      category: { type: 'string' },
      title: { type: 'string' },
      content: { type: 'string' },
      tags: { type: 'string' },
      tier: { type: 'string' },
      ttl: { type: 'string' },

      // Notification options
      message: { type: 'string' },
      agent: { type: 'string' },
      priority: { type: 'string' },
      channel: { type: 'string' },
      'voice-id': { type: 'string' },

      // Eval signal options
      'signal-type': { type: 'string' },
      description: { type: 'string' },
      severity: { type: 'string' },
      suite: { type: 'string' },
      score: { type: 'string' },

      // ISC options
      row: { type: 'string' },
      status: { type: 'string' },
      result: { type: 'string' },
      'verify-result': { type: 'string' },
      reason: { type: 'string' },

      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  const command = positionals[0];

  if (values.help || !command) {
    console.log(`
SkillIntegrationBridge - Unified integration layer for Kaya skills

Commands:
  insight     Emit an insight to MemoryStore
  notify      Send a notification
  eval        Emit an eval signal
  isc         Update ISC tracking

Insight Options:
  --source <string>       Source skill name (required)
  --type <string>         Type: learning|decision|artifact|insight|signal|research (required)
  --category <string>     Sub-category
  --title <string>        Entry title (required)
  --content <string>      Entry content (required)
  --tags <string>         Comma-separated tags (required)
  --tier <string>         Tier: hot|warm|cold (default: hot)
  --ttl <number>          Time-to-live in seconds

Notification Options:
  --message <string>      Notification message (required)
  --agent <string>        Agent name
  --priority <string>     Priority: low|normal|high|critical
  --channel <string>      Channel: voice|push|discord
  --voice-id <string>     Voice ID override

Eval Signal Options:
  --source <string>       Source skill name (required)
  --signal-type <string>  Type: failure|success|regression|capability_result (required)
  --description <string>  Signal description (required)
  --category <string>     Category (required)
  --severity <string>     Severity: low|medium|high|critical
  --suite <string>        Test suite name
  --score <number>        Score value

ISC Options:
  --source <string>       Source skill name (required)
  --row <number>          Row ID (required)
  --status <string>       Status: PENDING|ACTIVE|DONE|ADJUSTED|BLOCKED|VERIFIED
  --result <string>       Result text
  --verify-result <string> Verify result: PASS|ADJUSTED|BLOCKED
  --reason <string>       Reason for status change

Examples:
  bun SkillIntegrationBridge.ts insight --source MySkill --type learning --title "Found pattern" --content "..." --tags "algo,isc"
  bun SkillIntegrationBridge.ts notify --message "Task complete" --agent Kaya --priority high
  bun SkillIntegrationBridge.ts eval --source TestSuite --signal-type failure --description "Auth test failed" --category security
  bun SkillIntegrationBridge.ts isc --source Verifier --row 1 --status DONE --verify-result PASS
`);
    return;
  }

  try {
    switch (command) {
      case 'insight': {
        if (!values.source || !values.type || !values.title || !values.content || !values.tags) {
          console.error('Error: --source, --type, --title, --content, and --tags are required');
          process.exit(1);
        }

        const id = await emitInsight({
          source: values.source,
          type: values.type as InsightPayload['type'],
          category: values.category,
          title: values.title,
          content: values.content,
          tags: values.tags.split(',').map((t) => t.trim()),
          tier: (values.tier as InsightPayload['tier']) || 'hot',
          ttl: values.ttl ? parseInt(values.ttl) : undefined,
        });

        console.log(`Insight emitted: ${id}`);
        break;
      }

      case 'notify': {
        if (!values.message) {
          console.error('Error: --message is required');
          process.exit(1);
        }

        await emitNotificationAsync(values.message, {
          agentName: values.agent,
          priority: values.priority as NotifyOpts['priority'],
          channel: values.channel as NotifyOpts['channel'],
          voiceId: values['voice-id'],
        });

        console.log('Notification sent');
        break;
      }

      case 'eval': {
        if (!values.source || !values['signal-type'] || !values.description || !values.category) {
          console.error('Error: --source, --signal-type, --description, and --category are required');
          process.exit(1);
        }

        await emitEvalSignal({
          source: values.source,
          signalType: values['signal-type'] as EvalSignalPayload['signalType'],
          description: values.description,
          category: values.category,
          severity: (values.severity as EvalSignalPayload['severity']) || 'medium',
          suite: values.suite,
          score: values.score ? parseFloat(values.score) : undefined,
        });

        console.log('Eval signal emitted');
        break;
      }

      case 'isc': {
        if (!values.source || !values.row) {
          console.error('Error: --source and --row are required');
          process.exit(1);
        }

        await emitISCUpdate({
          source: values.source,
          row: parseInt(values.row),
          status: values.status as ISCUpdatePayload['status'],
          result: values.result,
          verifyResult: values['verify-result'] as ISCUpdatePayload['verifyResult'],
          reason: values.reason,
        });

        console.log('ISC update emitted');
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

// Run CLI if executed directly
if (import.meta.main) {
  runCli();
}
