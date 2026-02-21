#!/usr/bin/env bun
/**
 * SignalIngester - Phase 8: Evals Consumption Pipeline
 *
 * Reads eval signals from MEMORY/EVAL_SIGNALS/signals.jsonl and converts them
 * into eval tasks. Signals are emitted by skills via SkillIntegrationBridge.
 *
 * Usage:
 *   bun SignalIngester.ts ingest      Process unprocessed signals
 *   bun SignalIngester.ts status       Show signal counts by category
 *
 * @version 1.0.0
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const KAYA_DIR = join(homedir(), '.claude');
const EVAL_SIGNALS_FILE = join(KAYA_DIR, 'MEMORY', 'EVAL_SIGNALS', 'signals.jsonl');
const INGESTER_STATE_FILE = join(KAYA_DIR, 'skills', 'Evals', 'State', 'signal-ingester.json');
const SUITES_DIR = join(KAYA_DIR, 'skills', 'Evals', 'Suites');

interface EvalSignal {
  timestamp: string;
  source: string;
  signalType: 'failure' | 'success' | 'regression' | 'capability_result';
  description: string;
  category: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  suite?: string;
  score?: number;
  rawData?: Record<string, unknown>;
}

interface IngesterState {
  lastProcessedLine: number;
  lastProcessedTimestamp: string;
  totalProcessed: number;
  totalSignals: number;
}

/**
 * Load ingester state
 */
function loadState(): IngesterState {
  if (!existsSync(INGESTER_STATE_FILE)) {
    return {
      lastProcessedLine: 0,
      lastProcessedTimestamp: '',
      totalProcessed: 0,
      totalSignals: 0,
    };
  }

  try {
    return JSON.parse(readFileSync(INGESTER_STATE_FILE, 'utf-8'));
  } catch {
    return {
      lastProcessedLine: 0,
      lastProcessedTimestamp: '',
      totalProcessed: 0,
      totalSignals: 0,
    };
  }
}

/**
 * Save ingester state
 */
function saveState(state: IngesterState): void {
  const dir = join(KAYA_DIR, 'skills', 'Evals', 'State');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(INGESTER_STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Read unprocessed signals from JSONL
 */
function readUnprocessedSignals(): EvalSignal[] {
  if (!existsSync(EVAL_SIGNALS_FILE)) return [];

  const state = loadState();
  const content = readFileSync(EVAL_SIGNALS_FILE, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  const signals: EvalSignal[] = [];
  for (let i = state.lastProcessedLine; i < lines.length; i++) {
    try {
      const signal = JSON.parse(lines[i]) as EvalSignal;
      signals.push(signal);
    } catch {
      // Skip malformed lines
    }
  }

  return signals;
}

/**
 * Convert signal to eval task format
 */
function signalToTask(signal: EvalSignal, index: number): Record<string, unknown> {
  return {
    id: `signal-${signal.source.toLowerCase()}-${signal.category}-${index}`,
    description: signal.description,
    input: signal.rawData || {},
    expected: signal.signalType === 'success' ? 'pass' : 'fail',
    grader: {
      type: 'code',
      code: `// Auto-generated from eval signal
// Source: ${signal.source}
// Category: ${signal.category}
// Severity: ${signal.severity || 'medium'}
return { pass: false, reason: "Manual verification required for signal-based test" };`,
    },
    metadata: {
      generatedFrom: 'signal',
      originalSignal: {
        source: signal.source,
        signalType: signal.signalType,
        category: signal.category,
        severity: signal.severity,
        timestamp: signal.timestamp,
      },
    },
  };
}

/**
 * Get or create suite file for category
 */
function getSuitePathForCategory(category: string): string {
  const safeCategory = category.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  return join(SUITES_DIR, `generated-${safeCategory}.yaml`);
}

/**
 * Append task to suite file
 */
function appendTaskToSuite(suitePath: string, task: Record<string, unknown>, signal: EvalSignal): void {
  if (!existsSync(SUITES_DIR)) mkdirSync(SUITES_DIR, { recursive: true });

  let suiteContent = '';
  if (existsSync(suitePath)) {
    suiteContent = readFileSync(suitePath, 'utf-8');
  } else {
    // Create new suite file
    suiteContent = `# Auto-generated eval suite from signals
# Category: ${signal.category}
# Generated: ${new Date().toISOString()}

suite: generated-${signal.category}
description: Auto-generated from eval signals in category ${signal.category}

tasks:
`;
  }

  // Append task in YAML format
  suiteContent += `\n  - id: ${task.id}
    description: ${task.description}
    metadata:
      source: ${signal.source}
      category: ${signal.category}
      severity: ${signal.severity || 'medium'}
      timestamp: ${signal.timestamp}
    # TODO: Define input, expected, and grader for this test
\n`;

  writeFileSync(suitePath, suiteContent);
}

/**
 * Ingest unprocessed signals
 */
function ingestSignals(): { processed: number; byCategory: Record<string, number> } {
  const signals = readUnprocessedSignals();
  if (signals.length === 0) {
    console.log('No new signals to process');
    return { processed: 0, byCategory: {} };
  }

  const byCategory: Record<string, number> = {};
  let processed = 0;

  for (const signal of signals) {
    try {
      const task = signalToTask(signal, processed);
      const suitePath = getSuitePathForCategory(signal.category);
      appendTaskToSuite(suitePath, task, signal);

      byCategory[signal.category] = (byCategory[signal.category] || 0) + 1;
      processed++;
    } catch (err) {
      console.error(`Failed to process signal: ${err}`);
    }
  }

  // Update state
  const state = loadState();
  const totalLines = existsSync(EVAL_SIGNALS_FILE)
    ? readFileSync(EVAL_SIGNALS_FILE, 'utf-8').split('\n').filter(l => l.trim()).length
    : 0;

  saveState({
    lastProcessedLine: totalLines,
    lastProcessedTimestamp: new Date().toISOString(),
    totalProcessed: state.totalProcessed + processed,
    totalSignals: totalLines,
  });

  console.log(`Processed ${processed} signals`);
  for (const [category, count] of Object.entries(byCategory)) {
    console.log(`  ${category}: ${count} tasks`);
  }

  return { processed, byCategory };
}

/**
 * Show signal status
 */
function showStatus(): void {
  const state = loadState();

  if (!existsSync(EVAL_SIGNALS_FILE)) {
    console.log('No signals file found');
    return;
  }

  const content = readFileSync(EVAL_SIGNALS_FILE, 'utf-8');
  const totalLines = content.split('\n').filter(l => l.trim()).length;
  const unprocessed = totalLines - state.lastProcessedLine;

  console.log('Signal Ingester Status');
  console.log('======================\n');
  console.log(`Total signals: ${totalLines}`);
  console.log(`Processed: ${state.lastProcessedLine}`);
  console.log(`Unprocessed: ${unprocessed}`);
  console.log(`Last processed: ${state.lastProcessedTimestamp || 'Never'}`);
  console.log(`\nTotal processed all-time: ${state.totalProcessed}`);

  // Count by category
  const lines = content.split('\n').filter(l => l.trim());
  const byCategory: Record<string, number> = {};
  for (const line of lines) {
    try {
      const signal = JSON.parse(line) as EvalSignal;
      byCategory[signal.category] = (byCategory[signal.category] || 0) + 1;
    } catch {
      // Skip
    }
  }

  console.log('\nSignals by category:');
  for (const [category, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${category}: ${count}`);
  }
}

// CLI
const [command] = process.argv.slice(2);

switch (command) {
  case 'ingest':
    ingestSignals();
    break;

  case 'status':
    showStatus();
    break;

  default:
    console.log(`SignalIngester - Eval signal consumption pipeline

Commands:
  ingest    Process unprocessed signals and generate eval tasks
  status    Show signal counts by category

Examples:
  bun SignalIngester.ts ingest
  bun SignalIngester.ts status
`);
    break;
}
