#!/usr/bin/env bun
/**
 * CostTracker.ts
 * Track token usage and costs from eval runs
 *
 * Usage:
 *   bun CostTracker.ts summary [--period 7d]
 *   bun CostTracker.ts budget --warn-at 5.00
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'util';
import type { Transcript } from '../Types/index.ts';

const EVALS_DIR = join(import.meta.dir, '..');
const TRANSCRIPTS_DIR = join(EVALS_DIR, 'Transcripts');

// =============================================================================
// PRICING (as of Feb 2026, per million tokens)
// =============================================================================

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-6': { input: 15.00, output: 75.00 },
  'claude-sonnet-4-5': { input: 3.00, output: 15.00 },
  'claude-haiku-4-5': { input: 0.80, output: 4.00 },
  // Fallback for unknown models
  'default': { input: 3.00, output: 15.00 },
};

// =============================================================================
// TYPES
// =============================================================================

interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  model: string;
}

interface CostSummary {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost: number;
  by_model: Record<string, {
    input_tokens: number;
    output_tokens: number;
    cost: number;
    count: number;
  }>;
  period_start: string;
  period_end: string;
  transcript_count: number;
}

// =============================================================================
// HELPERS
// =============================================================================

function parseTimespan(period: string): number {
  const match = period.match(/^(\d+)([dhm])$/);
  if (!match) {
    throw new Error(`Invalid period format: ${period}. Use format like 7d, 24h, 30d`);
  }

  const value = parseInt(match[1]);
  const unit = match[2];

  const MS_PER_MINUTE = 60 * 1000;
  const MS_PER_HOUR = 60 * MS_PER_MINUTE;
  const MS_PER_DAY = 24 * MS_PER_HOUR;

  switch (unit) {
    case 'm': return value * MS_PER_MINUTE;
    case 'h': return value * MS_PER_HOUR;
    case 'd': return value * MS_PER_DAY;
    default: return 7 * MS_PER_DAY;
  }
}

function loadTranscripts(sinceMs?: number): TokenUsage[] {
  if (!existsSync(TRANSCRIPTS_DIR)) {
    console.warn(`⚠️  Transcripts directory not found: ${TRANSCRIPTS_DIR}`);
    return [];
  }

  const usages: TokenUsage[] = [];
  const cutoffTime = sinceMs ? Date.now() - sinceMs : 0;

  const entries = readdirSync(TRANSCRIPTS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const transcriptPath = join(TRANSCRIPTS_DIR, entry.name, 'transcript.json');
    if (!existsSync(transcriptPath)) continue;

    try {
      const stats = entry;
      // Check directory modification time as proxy for transcript age
      const dirPath = join(TRANSCRIPTS_DIR, entry.name);
      const dirStats = require('fs').statSync(dirPath);
      const mtime = dirStats.mtimeMs;

      if (cutoffTime > 0 && mtime < cutoffTime) {
        continue; // Skip old transcripts
      }

      const content = readFileSync(transcriptPath, 'utf-8');
      const transcript: Transcript = JSON.parse(content);

      if (transcript.metrics?.token_usage) {
        usages.push({
          input_tokens: transcript.metrics.token_usage.input_tokens || 0,
          output_tokens: transcript.metrics.token_usage.output_tokens || 0,
          model: transcript.model || 'default',
        });
      }
    } catch (error) {
      // Skip invalid transcripts
      continue;
    }
  }

  return usages;
}

function calculateCost(inputTokens: number, outputTokens: number, model: string): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING['default'];

  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;

  return inputCost + outputCost;
}

function generateSummary(usages: TokenUsage[], periodMs?: number): CostSummary {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;

  const byModel: Record<string, {
    input_tokens: number;
    output_tokens: number;
    cost: number;
    count: number;
  }> = {};

  for (const usage of usages) {
    totalInputTokens += usage.input_tokens;
    totalOutputTokens += usage.output_tokens;

    const cost = calculateCost(usage.input_tokens, usage.output_tokens, usage.model);
    totalCost += cost;

    if (!byModel[usage.model]) {
      byModel[usage.model] = {
        input_tokens: 0,
        output_tokens: 0,
        cost: 0,
        count: 0,
      };
    }

    byModel[usage.model].input_tokens += usage.input_tokens;
    byModel[usage.model].output_tokens += usage.output_tokens;
    byModel[usage.model].cost += cost;
    byModel[usage.model].count += 1;
  }

  const now = new Date();
  const periodStart = periodMs ? new Date(Date.now() - periodMs) : new Date(0);

  return {
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
    total_cost: totalCost,
    by_model: byModel,
    period_start: periodStart.toISOString(),
    period_end: now.toISOString(),
    transcript_count: usages.length,
  };
}

// =============================================================================
// COMMANDS
// =============================================================================

function cmdSummary(period?: string): void {
  const periodMs = period ? parseTimespan(period) : undefined;
  const periodLabel = period || 'all time';

  console.log(`\n=== Cost Summary (${periodLabel}) ===\n`);

  const usages = loadTranscripts(periodMs);

  if (usages.length === 0) {
    console.log(`❌ No transcript data found for period: ${periodLabel}\n`);
    return;
  }

  const summary = generateSummary(usages, periodMs);

  console.log(`📊 Overview:`);
  console.log(`   Transcripts: ${summary.transcript_count}`);
  console.log(`   Period: ${new Date(summary.period_start).toLocaleDateString()} - ${new Date(summary.period_end).toLocaleDateString()}`);
  console.log();

  console.log(`💰 Total Cost: $${summary.total_cost.toFixed(4)}`);
  console.log(`   Input tokens: ${summary.total_input_tokens.toLocaleString()}`);
  console.log(`   Output tokens: ${summary.total_output_tokens.toLocaleString()}`);
  console.log();

  console.log(`📈 By Model:`);
  console.log();

  const sortedModels = Object.entries(summary.by_model).sort((a, b) => b[1].cost - a[1].cost);

  for (const [model, stats] of sortedModels) {
    console.log(`   ${model}:`);
    console.log(`     Cost: $${stats.cost.toFixed(4)}`);
    console.log(`     Input: ${stats.input_tokens.toLocaleString()} tokens`);
    console.log(`     Output: ${stats.output_tokens.toLocaleString()} tokens`);
    console.log(`     Transcripts: ${stats.count}`);
    console.log();
  }

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

function cmdBudget(warnAt: number): void {
  console.log(`\n=== Budget Check (warning threshold: $${warnAt.toFixed(2)}) ===\n`);

  const usages = loadTranscripts();

  if (usages.length === 0) {
    console.log(`❌ No transcript data found\n`);
    return;
  }

  const summary = generateSummary(usages);

  console.log(`💰 Total Cost (all time): $${summary.total_cost.toFixed(4)}`);
  console.log();

  if (summary.total_cost >= warnAt) {
    console.log(`⚠️  WARNING: Cost exceeds threshold!`);
    console.log(`   Threshold: $${warnAt.toFixed(2)}`);
    console.log(`   Current: $${summary.total_cost.toFixed(4)}`);
    console.log(`   Overage: $${(summary.total_cost - warnAt).toFixed(4)}`);
    console.log();
    process.exit(1);
  } else {
    console.log(`✅ Cost within budget`);
    console.log(`   Threshold: $${warnAt.toFixed(2)}`);
    console.log(`   Current: $${summary.total_cost.toFixed(4)}`);
    console.log(`   Remaining: $${(warnAt - summary.total_cost).toFixed(4)}`);
    console.log();
  }

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

// =============================================================================
// CLI
// =============================================================================

async function main() {
  const args = Bun.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
Cost Tracker - Token usage and cost tracking for evals

Usage:
  bun CostTracker.ts summary [--period 7d]     Show cost summary
  bun CostTracker.ts budget --warn-at 5.00     Check budget threshold

Options:
  --period <timespan>    Time period (e.g., 7d, 24h, 30d)
  --warn-at <amount>     Budget warning threshold in USD

Examples:
  bun CostTracker.ts summary
  bun CostTracker.ts summary --period 7d
  bun CostTracker.ts summary --period 24h
  bun CostTracker.ts budget --warn-at 10.00
`);
    process.exit(0);
  }

  const command = args[0];

  try {
    if (command === 'summary') {
      const periodIdx = args.indexOf('--period');
      const period = periodIdx !== -1 && args[periodIdx + 1] ? args[periodIdx + 1] : undefined;

      cmdSummary(period);
    } else if (command === 'budget') {
      const warnIdx = args.indexOf('--warn-at');
      if (warnIdx === -1 || !args[warnIdx + 1]) {
        console.error('❌ budget command requires --warn-at <amount>');
        process.exit(1);
      }

      const warnAt = parseFloat(args[warnIdx + 1]);
      if (isNaN(warnAt) || warnAt <= 0) {
        console.error('❌ --warn-at must be a positive number');
        process.exit(1);
      }

      cmdBudget(warnAt);
    } else {
      console.error(`❌ Unknown command: ${command}`);
      console.error(`   Valid commands: summary, budget`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

main();
