#!/usr/bin/env bun
/**
 * Eval Suite Manager
 * Manage capability vs regression suites with saturation monitoring
 */

import type { EvalSuite, EvalType, SaturationStatus, EvalRun, Task } from '../Types/index.ts';
import { existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseArgs } from 'util';

const EVALS_DIR = join(import.meta.dir, '..');
const SUITES_DIR = join(EVALS_DIR, 'Suites');
const RESULTS_DIR = join(EVALS_DIR, 'Results');

/**
 * Ensure directories exist
 */
function ensureDirs(): void {
  if (!existsSync(SUITES_DIR)) mkdirSync(SUITES_DIR, { recursive: true });
  if (!existsSync(join(SUITES_DIR, 'Capability'))) mkdirSync(join(SUITES_DIR, 'Capability'));
  if (!existsSync(join(SUITES_DIR, 'Regression'))) mkdirSync(join(SUITES_DIR, 'Regression'));
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
}

/**
 * Create a new eval suite
 */
export function createSuite(
  name: string,
  type: EvalType,
  description: string,
  options?: {
    domain?: string;
    pass_threshold?: number;
    saturation_threshold?: number;
    tasks?: string[];
  }
): EvalSuite {
  ensureDirs();

  const suite: EvalSuite = {
    name,
    description,
    type,
    domain: options?.domain as any,
    tasks: options?.tasks ?? [],
    pass_threshold: options?.pass_threshold ?? (type === 'regression' ? 0.95 : 0.70),
    saturation_threshold: options?.saturation_threshold ?? 0.95,
    created_at: new Date().toISOString(),
  };

  const dir = type === 'capability' ? 'Capability' : 'Regression';
  const filePath = join(SUITES_DIR, dir, `${name}.yaml`);

  writeFileSync(filePath, stringifyYaml(suite));

  return suite;
}

/**
 * Load a suite by name
 */
export function loadSuite(name: string): EvalSuite | null {
  ensureDirs();

  // Check all known suite directories (including domain-specific like Kaya)
  for (const dir of ['Capability', 'Regression', 'Kaya']) {
    const filePath = join(SUITES_DIR, dir, `${name}.yaml`);
    if (existsSync(filePath)) {
      return parseYaml(readFileSync(filePath, 'utf-8')) as EvalSuite;
    }
  }

  // Also check the root Suites directory
  const rootPath = join(SUITES_DIR, `${name}.yaml`);
  if (existsSync(rootPath)) {
    return parseYaml(readFileSync(rootPath, 'utf-8')) as EvalSuite;
  }

  return null;
}

/**
 * List all suites
 */
export function listSuites(type?: EvalType): EvalSuite[] {
  ensureDirs();

  const suites: EvalSuite[] = [];
  const dirs = type ? [type === 'capability' ? 'Capability' : 'Regression'] : ['Capability', 'Regression', 'Kaya'];

  for (const dir of dirs) {
    const dirPath = join(SUITES_DIR, dir);
    if (!existsSync(dirPath)) continue;

    for (const file of readdirSync(dirPath)) {
      if (file.endsWith('.yaml')) {
        const suite = parseYaml(readFileSync(join(dirPath, file), 'utf-8')) as EvalSuite;
        suites.push(suite);
      }
    }
  }

  return suites;
}

/**
 * Add a task to a suite
 */
export function addTaskToSuite(suiteName: string, taskId: string): boolean {
  const suite = loadSuite(suiteName);
  if (!suite) return false;

  if (!suite.tasks.includes(taskId)) {
    suite.tasks.push(taskId);
    suite.updated_at = new Date().toISOString();

    const dir = suite.type === 'capability' ? 'Capability' : 'Regression';
    const filePath = join(SUITES_DIR, dir, `${suiteName}.yaml`);
    writeFileSync(filePath, stringifyYaml(suite));
  }

  return true;
}

/**
 * Linear regression helper
 */
function linearRegression(x: number[], y: number[]): { slope: number; intercept: number; r2: number } {
  const n = x.length;
  if (n === 0) return { slope: 0, intercept: 0, r2: 0 };

  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  // Calculate R²
  const yMean = sumY / n;
  const ssRes = y.reduce((sum, yi, i) => {
    const predicted = slope * x[i] + intercept;
    return sum + Math.pow(yi - predicted, 2);
  }, 0);
  const ssTot = y.reduce((sum, yi) => sum + Math.pow(yi - yMean, 2), 0);
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

  return { slope, intercept, r2 };
}

/**
 * Calculate 95% confidence interval for the trend
 */
function confidenceInterval95(
  x: number[],
  y: number[],
  regression: { slope: number; intercept: number }
): { lower: number; upper: number } {
  const n = x.length;
  if (n < 3) return { lower: 0, upper: 1 };

  // Calculate residual standard error
  const yMean = y.reduce((a, b) => a + b, 0) / n;
  const residuals = y.map((yi, i) => yi - (regression.slope * x[i] + regression.intercept));
  const rss = residuals.reduce((sum, r) => sum + r * r, 0);
  const se = Math.sqrt(rss / (n - 2));

  // t-statistic for 95% CI with n-2 degrees of freedom (approximation)
  const tStat = n <= 30 ? 2.0 : 1.96;

  // Predict at the last point
  const lastX = x[x.length - 1];
  const predicted = regression.slope * lastX + regression.intercept;

  const xMean = x.reduce((a, b) => a + b, 0) / n;
  const sxx = x.reduce((sum, xi) => sum + Math.pow(xi - xMean, 2), 0);
  const sePrediction = se * Math.sqrt(1 / n + Math.pow(lastX - xMean, 2) / sxx);

  const margin = tStat * sePrediction;

  return {
    lower: Math.max(0, predicted - margin),
    upper: Math.min(1, predicted + margin),
  };
}

/**
 * Check saturation status for a suite
 */
export function checkSaturation(suiteName: string): SaturationStatus {
  const suite = loadSuite(suiteName);
  if (!suite) {
    throw new Error(`Suite not found: ${suiteName}`);
  }

  // Load recent results
  const suiteResultsDir = join(RESULTS_DIR, suiteName);
  const history: { date: string; rate: number }[] = [];

  if (existsSync(suiteResultsDir)) {
    const runDirs = readdirSync(suiteResultsDir)
      .filter(d => d.startsWith('run_'))
      .sort()
      .slice(-10);  // Last 10 runs

    for (const runDir of runDirs) {
      const runPath = join(suiteResultsDir, runDir, 'run.json');
      if (existsSync(runPath)) {
        try {
          const run = JSON.parse(readFileSync(runPath, 'utf-8')) as EvalRun;
          history.push({
            date: run.completed_at ?? run.started_at,
            rate: run.pass_rate,
          });
        } catch {
          // Skip invalid runs
        }
      }
    }
  }

  const threshold = suite.saturation_threshold ?? 0.95;

  // Statistical analysis if we have enough data
  let trendDirection: 'improving' | 'plateaued' | 'declining' = 'plateaued';
  let confidenceInterval: { lower: number; upper: number } | undefined;
  let regression: { slope: number; intercept: number; r2: number } | undefined;

  if (history.length >= 3) {
    // Perform linear regression
    const x = history.map((_, i) => i); // Index as x-axis
    const y = history.map(h => h.rate);

    regression = linearRegression(x, y);
    confidenceInterval = confidenceInterval95(x, y, regression);

    // Classify trend based on slope and confidence
    const slopeThreshold = 0.01; // 1% change per run
    const { slope } = regression;

    if (slope > slopeThreshold) {
      trendDirection = 'improving';
    } else if (slope < -slopeThreshold) {
      trendDirection = 'declining';
    } else {
      trendDirection = 'plateaued';
    }

    // If confidence interval is wide, trend is uncertain -> plateaued
    const ciWidth = confidenceInterval.upper - confidenceInterval.lower;
    if (ciWidth > 0.2) {
      trendDirection = 'plateaued';
    }
  }

  // Determine saturation
  const recentAboveThreshold = history.slice(-3).filter(h => h.rate >= threshold);
  const saturated =
    recentAboveThreshold.length >= 3 &&
    (trendDirection === 'plateaued' || trendDirection === 'improving');

  let recommendedAction: 'graduate_to_regression' | 'add_harder_cases' | 'keep';

  if (suite.type === 'capability' && saturated) {
    recommendedAction = 'graduate_to_regression';
  } else if (saturated) {
    recommendedAction = 'add_harder_cases';
  } else {
    recommendedAction = 'keep';
  }

  return {
    suite_id: suiteName,
    pass_rate_history: history,
    saturated,
    consecutive_above_threshold: recentAboveThreshold.length,
    recommended_action: recommendedAction,
    trend_direction: trendDirection,
    confidence_interval: confidenceInterval,
    regression_stats: regression ? {
      slope: regression.slope,
      r_squared: regression.r2,
    } : undefined,
  };
}

/**
 * Graduate a suite from capability to regression
 */
export function graduateSuite(suiteName: string): boolean {
  const suite = loadSuite(suiteName);
  if (!suite || suite.type !== 'capability') {
    return false;
  }

  // Update type
  suite.type = 'regression';
  suite.pass_threshold = 0.95;  // Higher threshold for regression
  suite.updated_at = new Date().toISOString();

  // Move file
  const oldPath = join(SUITES_DIR, 'Capability', `${suiteName}.yaml`);
  const newPath = join(SUITES_DIR, 'Regression', `${suiteName}.yaml`);

  writeFileSync(newPath, stringifyYaml(suite));
  if (existsSync(oldPath)) {
    const fs = require('fs');
    fs.unlinkSync(oldPath);
  }

  return true;
}

/**
 * Format suite summary for display
 */
export function formatSuiteSummary(suite: EvalSuite, saturation?: SaturationStatus): string {
  const lines: string[] = [];

  const typeIcon = suite.type === 'capability' ? '🎯' : '🔒';
  lines.push(`## ${typeIcon} ${suite.name}`);
  lines.push('');
  lines.push(`**Type:** ${suite.type}`);
  lines.push(`**Description:** ${suite.description}`);
  if (suite.domain) lines.push(`**Domain:** ${suite.domain}`);
  lines.push(`**Tasks:** ${suite.tasks.length}`);
  lines.push(`**Pass Threshold:** ${(suite.pass_threshold ?? 0.75) * 100}%`);
  lines.push('');

  if (saturation) {
    lines.push('### Saturation Status');
    lines.push('');
    const satIcon = saturation.saturated ? '⚠️' : '✅';
    lines.push(`${satIcon} **Saturated:** ${saturation.saturated ? 'Yes' : 'No'}`);
    lines.push(`**Consecutive above ${(suite.saturation_threshold ?? 0.95) * 100}%:** ${saturation.consecutive_above_threshold}/3`);
    lines.push(`**Recommendation:** ${saturation.recommended_action.replace(/_/g, ' ')}`);

    if (saturation.trend_direction) {
      const trendIcon = saturation.trend_direction === 'improving' ? '📈'
        : saturation.trend_direction === 'declining' ? '📉'
        : '➡️';
      lines.push(`**Trend:** ${trendIcon} ${saturation.trend_direction}`);
    }

    if (saturation.regression_stats) {
      lines.push(`**Regression Slope:** ${saturation.regression_stats.slope > 0 ? '+' : ''}${saturation.regression_stats.slope.toFixed(4)}`);
      lines.push(`**R² (fit quality):** ${saturation.regression_stats.r_squared.toFixed(3)}`);
    }

    if (saturation.confidence_interval) {
      lines.push(`**95% CI (next run):** [${saturation.confidence_interval.lower.toFixed(3)}, ${saturation.confidence_interval.upper.toFixed(3)}]`);
    }

    if (saturation.pass_rate_history.length > 0) {
      lines.push('');
      lines.push('**Recent Pass Rates:**');
      for (const entry of saturation.pass_rate_history.slice(-5)) {
        const date = new Date(entry.date).toLocaleDateString();
        lines.push(`- ${date}: ${(entry.rate * 100).toFixed(1)}%`);
      }
    }
  }

  if (suite.tasks.length > 0) {
    lines.push('');
    lines.push('### Tasks');
    lines.push('');
    for (const task of suite.tasks) {
      lines.push(`- ${task}`);
    }
  }

  return lines.join('\n');
}

// CLI interface
if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      type: { type: 'string', short: 't', default: 'capability' },
      description: { type: 'string', short: 'd' },
      domain: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  const [command, ...args] = positionals;

  if (values.help || !command) {
    console.log(`
SuiteManager - Manage evaluation suites

Commands:
  create <name>       Create a new suite
  list [type]         List all suites (optionally filter by type)
  show <name>         Show suite details with saturation status
  add-task <suite> <task>  Add a task to a suite
  check-saturation <name>  Check if suite is saturated
  graduate <name>     Graduate capability suite to regression

Options:
  -t, --type          Suite type: capability or regression (default: capability)
  -d, --description   Suite description
  --domain            Suite domain (coding, conversational, research, computer_use)
  -h, --help          Show this help

Examples:
  bun run SuiteManager.ts create auth-security -t capability -d "Authentication security tests"
  bun run SuiteManager.ts list regression
  bun run SuiteManager.ts show auth-security
  bun run SuiteManager.ts add-task auth-security fix-auth-bypass
  bun run SuiteManager.ts check-saturation auth-security
  bun run SuiteManager.ts graduate auth-security
`);
    process.exit(0);
  }

  switch (command) {
    case 'create': {
      if (!args[0] || !values.description) {
        console.error('Usage: create <name> -d "description"');
        process.exit(1);
      }
      const suite = createSuite(
        args[0],
        values.type as EvalType,
        values.description,
        { domain: values.domain }
      );
      console.log(`Created suite: ${suite.name} (${suite.type})`);
      break;
    }

    case 'list': {
      const type = args[0] as EvalType | undefined;
      const suites = listSuites(type);
      console.log(`\n${type ? type.charAt(0).toUpperCase() + type.slice(1) : 'All'} Suites:\n`);
      for (const suite of suites) {
        const icon = suite.type === 'capability' ? '🎯' : '🔒';
        console.log(`  ${icon} ${suite.name} (${suite.tasks.length} tasks)`);
      }
      break;
    }

    case 'show': {
      if (!args[0]) {
        console.error('Usage: show <name>');
        process.exit(1);
      }
      const suite = loadSuite(args[0]);
      if (!suite) {
        console.error(`Suite not found: ${args[0]}`);
        process.exit(1);
      }
      const saturation = checkSaturation(args[0]);
      console.log('\n' + formatSuiteSummary(suite, saturation));
      break;
    }

    case 'add-task': {
      if (!args[0] || !args[1]) {
        console.error('Usage: add-task <suite> <task>');
        process.exit(1);
      }
      if (addTaskToSuite(args[0], args[1])) {
        console.log(`Added task ${args[1]} to suite ${args[0]}`);
      } else {
        console.error(`Failed to add task to suite`);
        process.exit(1);
      }
      break;
    }

    case 'check-saturation': {
      if (!args[0]) {
        console.error('Usage: check-saturation <name>');
        process.exit(1);
      }
      const status = checkSaturation(args[0]);
      console.log(`\nSaturation Status: ${args[0]}\n`);
      console.log(`  Saturated: ${status.saturated ? '⚠️ Yes' : '✅ No'}`);
      console.log(`  Consecutive above threshold: ${status.consecutive_above_threshold}/3`);
      console.log(`  Recommendation: ${status.recommended_action}`);
      break;
    }

    case 'graduate': {
      if (!args[0]) {
        console.error('Usage: graduate <name>');
        process.exit(1);
      }
      if (graduateSuite(args[0])) {
        console.log(`Graduated suite ${args[0]} from capability to regression`);
      } else {
        console.error(`Failed to graduate suite (not found or not a capability suite)`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}
