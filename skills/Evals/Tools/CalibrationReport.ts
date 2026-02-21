#!/usr/bin/env bun
/**
 * CalibrationReport.ts
 * Generate calibration reports from human review queue
 *
 * Reads human-reviewed eval results and computes:
 * - Agreement rate between human and grader scores
 * - Per-grader calibration statistics
 * - Score distribution analysis
 *
 * Usage:
 *   bun CalibrationReport.ts [--queue <path>] [--output <path>]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'util';

const EVALS_DIR = join(import.meta.dir, '..');
const DEFAULT_QUEUE_DIR = join(EVALS_DIR, 'Results', 'human_review_queue');

// =============================================================================
// TYPES
// =============================================================================

interface HumanReview {
  task_id: string;
  trial_id: string;
  grader_type: string;
  grader_score: number;
  grader_reasoning?: string;
  human_score: number;
  human_reasoning?: string;
  timestamp: string;
  reviewer?: string;
}

interface GraderStats {
  grader_type: string;
  total_reviews: number;
  mean_absolute_error: number;
  agreement_rate: number; // Within 0.1 threshold
  correlation: number;
  score_bias: number; // Positive = grader scores higher than human
  reviews: HumanReview[];
}

interface CalibrationReport {
  generated_at: string;
  total_reviews: number;
  overall_agreement_rate: number;
  overall_mae: number;
  grader_stats: GraderStats[];
  score_distribution: {
    grader: Record<string, number>;
    human: Record<string, number>;
  };
}

// =============================================================================
// HELPERS
// =============================================================================

function loadReviews(queueDir: string): HumanReview[] {
  if (!existsSync(queueDir)) {
    console.warn(`⚠️  Queue directory not found: ${queueDir}`);
    return [];
  }

  const reviews: HumanReview[] = [];
  const files = readdirSync(queueDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    try {
      const content = readFileSync(join(queueDir, file), 'utf-8');
      const data = JSON.parse(content);

      // Support both single review and array of reviews
      const reviewsData = Array.isArray(data) ? data : [data];
      reviews.push(...reviewsData);
    } catch (error) {
      console.warn(`⚠️  Failed to parse ${file}: ${error}`);
    }
  }

  return reviews;
}

function calculateMAE(values: { grader: number; human: number }[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, v) => acc + Math.abs(v.grader - v.human), 0);
  return sum / values.length;
}

function calculateAgreementRate(values: { grader: number; human: number }[], threshold = 0.1): number {
  if (values.length === 0) return 0;
  const agreed = values.filter(v => Math.abs(v.grader - v.human) <= threshold).length;
  return agreed / values.length;
}

function calculateCorrelation(values: { grader: number; human: number }[]): number {
  if (values.length < 2) return 0;

  const n = values.length;
  const graderScores = values.map(v => v.grader);
  const humanScores = values.map(v => v.human);

  const meanGrader = graderScores.reduce((a, b) => a + b, 0) / n;
  const meanHuman = humanScores.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let denomGrader = 0;
  let denomHuman = 0;

  for (let i = 0; i < n; i++) {
    const diffGrader = graderScores[i] - meanGrader;
    const diffHuman = humanScores[i] - meanHuman;

    numerator += diffGrader * diffHuman;
    denomGrader += diffGrader * diffGrader;
    denomHuman += diffHuman * diffHuman;
  }

  const denominator = Math.sqrt(denomGrader * denomHuman);
  return denominator === 0 ? 0 : numerator / denominator;
}

function calculateBias(values: { grader: number; human: number }[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, v) => acc + (v.grader - v.human), 0);
  return sum / values.length;
}

function buildScoreDistribution(reviews: HumanReview[]): { grader: Record<string, number>; human: Record<string, number> } {
  const graderDist: Record<string, number> = {};
  const humanDist: Record<string, number> = {};

  for (const review of reviews) {
    // Bucket scores into bins: 0-0.2, 0.2-0.4, 0.4-0.6, 0.6-0.8, 0.8-1.0
    const graderBin = Math.floor(review.grader_score * 5) / 5;
    const humanBin = Math.floor(review.human_score * 5) / 5;

    const graderKey = `${graderBin.toFixed(1)}-${(graderBin + 0.2).toFixed(1)}`;
    const humanKey = `${humanBin.toFixed(1)}-${(humanBin + 0.2).toFixed(1)}`;

    graderDist[graderKey] = (graderDist[graderKey] || 0) + 1;
    humanDist[humanKey] = (humanDist[humanKey] || 0) + 1;
  }

  return { grader: graderDist, human: humanDist };
}

// =============================================================================
// CORE
// =============================================================================

function generateCalibrationReport(reviews: HumanReview[]): CalibrationReport {
  if (reviews.length === 0) {
    return {
      generated_at: new Date().toISOString(),
      total_reviews: 0,
      overall_agreement_rate: 0,
      overall_mae: 0,
      grader_stats: [],
      score_distribution: { grader: {}, human: {} },
    };
  }

  // Group by grader type
  const byGrader = new Map<string, HumanReview[]>();

  for (const review of reviews) {
    const existing = byGrader.get(review.grader_type) || [];
    existing.push(review);
    byGrader.set(review.grader_type, existing);
  }

  // Compute per-grader stats
  const graderStats: GraderStats[] = [];

  for (const [graderType, graderReviews] of byGrader.entries()) {
    const values = graderReviews.map(r => ({ grader: r.grader_score, human: r.human_score }));

    graderStats.push({
      grader_type: graderType,
      total_reviews: graderReviews.length,
      mean_absolute_error: calculateMAE(values),
      agreement_rate: calculateAgreementRate(values),
      correlation: calculateCorrelation(values),
      score_bias: calculateBias(values),
      reviews: graderReviews,
    });
  }

  // Sort by total reviews descending
  graderStats.sort((a, b) => b.total_reviews - a.total_reviews);

  // Overall stats
  const allValues = reviews.map(r => ({ grader: r.grader_score, human: r.human_score }));
  const overallMAE = calculateMAE(allValues);
  const overallAgreement = calculateAgreementRate(allValues);

  // Score distribution
  const scoreDistribution = buildScoreDistribution(reviews);

  return {
    generated_at: new Date().toISOString(),
    total_reviews: reviews.length,
    overall_agreement_rate: overallAgreement,
    overall_mae: overallMAE,
    grader_stats: graderStats,
    score_distribution: scoreDistribution,
  };
}

function formatReport(report: CalibrationReport): string {
  const lines: string[] = [];

  lines.push(`# Grader Calibration Report`);
  lines.push('');
  lines.push(`**Generated:** ${report.generated_at}`);
  lines.push(`**Total Reviews:** ${report.total_reviews}`);
  lines.push('');

  if (report.total_reviews === 0) {
    lines.push('No human reviews available yet.');
    lines.push('');
    lines.push('To add human reviews, create JSON files in the human review queue with this format:');
    lines.push('');
    lines.push('```json');
    lines.push('{');
    lines.push('  "task_id": "task_example",');
    lines.push('  "trial_id": "trial_001",');
    lines.push('  "grader_type": "llm_rubric",');
    lines.push('  "grader_score": 0.85,');
    lines.push('  "grader_reasoning": "Agent completed task with minor issues",');
    lines.push('  "human_score": 0.90,');
    lines.push('  "human_reasoning": "Task completed well, grader was slightly harsh",');
    lines.push('  "timestamp": "2026-02-12T10:30:00Z",');
    lines.push('  "reviewer": "jm"');
    lines.push('}');
    lines.push('```');
    return lines.join('\n');
  }

  // Overall summary
  lines.push(`## Overall Calibration`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Agreement Rate (±0.1) | ${(report.overall_agreement_rate * 100).toFixed(1)}% |`);
  lines.push(`| Mean Absolute Error | ${report.overall_mae.toFixed(3)} |`);
  lines.push('');

  // Per-grader stats
  lines.push(`## Per-Grader Statistics`);
  lines.push('');
  lines.push(`| Grader | Reviews | Agreement | MAE | Correlation | Bias |`);
  lines.push(`|--------|---------|-----------|-----|-------------|------|`);

  for (const stat of report.grader_stats) {
    const biasSign = stat.score_bias >= 0 ? '+' : '';
    lines.push(
      `| ${stat.grader_type} | ${stat.total_reviews} | ${(stat.agreement_rate * 100).toFixed(1)}% | ${stat.mean_absolute_error.toFixed(3)} | ${stat.correlation.toFixed(3)} | ${biasSign}${stat.score_bias.toFixed(3)} |`
    );
  }

  lines.push('');
  lines.push('**Legend:**');
  lines.push('- **Agreement**: % within ±0.1 of human score');
  lines.push('- **MAE**: Mean Absolute Error');
  lines.push('- **Correlation**: Pearson correlation coefficient');
  lines.push('- **Bias**: Positive = grader scores higher than human');
  lines.push('');

  // Score distribution
  lines.push(`## Score Distribution`);
  lines.push('');
  lines.push(`| Score Range | Grader Count | Human Count |`);
  lines.push(`|-------------|--------------|-------------|`);

  const allBins = new Set([
    ...Object.keys(report.score_distribution.grader),
    ...Object.keys(report.score_distribution.human),
  ]);

  const sortedBins = Array.from(allBins).sort();

  for (const bin of sortedBins) {
    const graderCount = report.score_distribution.grader[bin] || 0;
    const humanCount = report.score_distribution.human[bin] || 0;
    lines.push(`| ${bin} | ${graderCount} | ${humanCount} |`);
  }

  lines.push('');

  return lines.join('\n');
}

// =============================================================================
// CLI
// =============================================================================

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      queue: { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`
CalibrationReport - Human Review Calibration Analysis

Usage:
  bun CalibrationReport.ts [options]

Options:
  --queue <path>   Path to human review queue directory (default: Results/human_review_queue)
  --output <path>  Write report to file (default: stdout)
  --help           Show this help

Example:
  bun CalibrationReport.ts
  bun CalibrationReport.ts --queue ./custom_queue --output calibration.md
`);
    process.exit(0);
  }

  const queueDir = values.queue || DEFAULT_QUEUE_DIR;

  console.log(`\n🔍 Loading human reviews from: ${queueDir}\n`);

  const reviews = loadReviews(queueDir);

  if (reviews.length === 0) {
    console.log(`⚠️  No human reviews found in queue directory.`);
    console.log(`   Create review files in: ${queueDir}\n`);
  } else {
    console.log(`✅ Loaded ${reviews.length} reviews\n`);
  }

  const report = generateCalibrationReport(reviews);
  const markdown = formatReport(report);

  if (values.output) {
    writeFileSync(values.output, markdown);
    console.log(`📄 Report written to: ${values.output}\n`);
  } else {
    console.log(markdown);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  }
}

main();
