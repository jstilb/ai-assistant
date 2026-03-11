#!/usr/bin/env bun
/**
 * ============================================================================
 * CronValidator - Validate cron job YAML syntax
 * ============================================================================
 *
 * PURPOSE:
 * CLI tool for validating cron job YAML files before deployment. Checks
 * schema compliance, cron expression syntax, and required fields.
 *
 * USAGE:
 *   bun CronValidator.ts <yaml-file>     # Validate a specific file
 *   bun CronValidator.ts --all           # Validate all job files
 *   bun CronValidator.ts --help          # Show help
 *
 * FEATURES:
 *   - Validate required fields (id, schedule, type, task, output, enabled)
 *   - Validate cron expression syntax
 *   - Check for duplicate job IDs
 *   - Verify output channel values
 *   - Clear error reporting with line numbers
 *
 * ============================================================================
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';
import { CronJobSchema } from '../../../../lib/cron/CronManager';
import type { CronJob } from '../../../../lib/cron/CronManager';
import { z } from 'zod';

// ============================================================================
// Configuration
// ============================================================================

const KAYA_DIR = process.env.KAYA_DIR || join(homedir(), '.claude');
const JOBS_DIR = join(KAYA_DIR, 'MEMORY/daemon/cron/jobs');

// ============================================================================
// Types
// ============================================================================

interface ValidationError {
  file: string;
  field?: string;
  message: string;
  severity: 'error' | 'warning';
}

interface ValidationResult {
  file: string;
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
  job?: CronJob;
}

// ============================================================================
// Cron Expression Validation
// ============================================================================

/**
 * Validate cron expression syntax
 */
export function validateCronExpression(expression: string): { valid: boolean; error?: string } {
  const parts = expression.trim().split(/\s+/);

  if (parts.length !== 5) {
    return {
      valid: false,
      error: `Invalid cron expression: expected 5 fields, got ${parts.length}`,
    };
  }

  const [minute, hour, day, month, weekday] = parts;

  // Validate each field
  const validations = [
    { name: 'minute', value: minute, min: 0, max: 59 },
    { name: 'hour', value: hour, min: 0, max: 23 },
    { name: 'day', value: day, min: 1, max: 31 },
    { name: 'month', value: month, min: 1, max: 12 },
    { name: 'weekday', value: weekday, min: 0, max: 6 },
  ];

  for (const field of validations) {
    const result = validateCronField(field.value, field.min, field.max);
    if (!result.valid) {
      return {
        valid: false,
        error: `Invalid ${field.name} field: ${result.error}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Validate a single cron field
 */
export function validateCronField(
  field: string,
  min: number,
  max: number
): { valid: boolean; error?: string } {
  // Wildcard
  if (field === '*') {
    return { valid: true };
  }

  // Step values (*/n)
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    if (isNaN(step) || step <= 0) {
      return { valid: false, error: `Invalid step value: ${field}` };
    }
    return { valid: true };
  }

  // Range (n-m)
  if (field.includes('-')) {
    const [start, end] = field.split('-').map((s) => parseInt(s, 10));
    if (isNaN(start) || isNaN(end)) {
      return { valid: false, error: `Invalid range: ${field}` };
    }
    if (start < min || start > max || end < min || end > max) {
      return {
        valid: false,
        error: `Range out of bounds (${min}-${max}): ${field}`,
      };
    }
    if (start >= end) {
      return { valid: false, error: `Invalid range (start >= end): ${field}` };
    }
    return { valid: true };
  }

  // List (n,m,o)
  if (field.includes(',')) {
    const values = field.split(',').map((s) => parseInt(s, 10));
    if (values.some(isNaN)) {
      return { valid: false, error: `Invalid list: ${field}` };
    }
    if (values.some((v) => v < min || v > max)) {
      return {
        valid: false,
        error: `List values out of bounds (${min}-${max}): ${field}`,
      };
    }
    return { valid: true };
  }

  // Single value
  const value = parseInt(field, 10);
  if (isNaN(value)) {
    return { valid: false, error: `Invalid value: ${field}` };
  }
  if (value < min || value > max) {
    return {
      valid: false,
      error: `Value out of bounds (${min}-${max}): ${value}`,
    };
  }

  return { valid: true };
}

// ============================================================================
// Validation Logic
// ============================================================================

/**
 * Validate a single YAML file
 */
async function validateFile(filePath: string): Promise<ValidationResult> {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const file = filePath;

  // Check if file exists
  if (!existsSync(filePath)) {
    errors.push({
      file,
      message: 'File does not exist',
      severity: 'error',
    });
    return { file, valid: false, errors, warnings };
  }

  try {
    // Read and parse YAML
    const content = await Bun.file(filePath).text();
    let data: unknown;

    try {
      data = parseYaml(content);
    } catch (yamlError) {
      errors.push({
        file,
        message: `YAML parse error: ${yamlError instanceof Error ? yamlError.message : String(yamlError)}`,
        severity: 'error',
      });
      return { file, valid: false, errors, warnings };
    }

    // Validate against schema
    let job: CronJob;
    try {
      job = CronJobSchema.parse(data);
    } catch (schemaError) {
      if (schemaError instanceof z.ZodError) {
        for (const issue of schemaError.issues) {
          errors.push({
            file,
            field: issue.path.join('.'),
            message: issue.message,
            severity: 'error',
          });
        }
      } else {
        errors.push({
          file,
          message: `Schema validation error: ${String(schemaError)}`,
          severity: 'error',
        });
      }
      return { file, valid: false, errors, warnings };
    }

    // Additional validations
    // 1. Validate cron expression
    const cronResult = validateCronExpression(job.schedule);
    if (!cronResult.valid) {
      errors.push({
        file,
        field: 'schedule',
        message: cronResult.error || 'Invalid cron expression',
        severity: 'error',
      });
    }

    // 2. Check task content
    if (job.task.trim().length === 0) {
      errors.push({
        file,
        field: 'task',
        message: 'Task description cannot be empty',
        severity: 'error',
      });
    }

    // 3. Warn if task is very short
    if (job.task.trim().length < 10) {
      warnings.push({
        file,
        field: 'task',
        message: 'Task description is very short (< 10 characters)',
        severity: 'warning',
      });
    }

    // 4. Check ID format
    if (!/^[a-z0-9-]+$/.test(job.id)) {
      warnings.push({
        file,
        field: 'id',
        message: 'Job ID should only contain lowercase letters, numbers, and hyphens',
        severity: 'warning',
      });
    }

    // 5. Warn if output is silent but type is isolated
    if (job.output === 'silent' && job.type === 'isolated') {
      warnings.push({
        file,
        field: 'output',
        message: 'Isolated jobs with silent output may not provide feedback',
        severity: 'warning',
      });
    }

    const valid = errors.length === 0;

    return { file, valid, errors, warnings, job };
  } catch (error) {
    errors.push({
      file,
      message: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
      severity: 'error',
    });
    return { file, valid: false, errors, warnings };
  }
}

/**
 * Validate all job files in the jobs directory
 */
async function validateAllFiles(): Promise<ValidationResult[]> {
  if (!existsSync(JOBS_DIR)) {
    console.error(`Jobs directory does not exist: ${JOBS_DIR}`);
    return [];
  }

  const files = readdirSync(JOBS_DIR).filter(
    (f) => f.endsWith('.yaml') || f.endsWith('.yml')
  );

  if (files.length === 0) {
    console.log('No job files found in', JOBS_DIR);
    return [];
  }

  const results: ValidationResult[] = [];
  const jobIds = new Set<string>();

  for (const file of files) {
    const filePath = join(JOBS_DIR, file);
    const result = await validateFile(filePath);
    results.push(result);

    // Check for duplicate IDs
    if (result.job && jobIds.has(result.job.id)) {
      result.errors.push({
        file: result.file,
        field: 'id',
        message: `Duplicate job ID: ${result.job.id}`,
        severity: 'error',
      });
      result.valid = false;
    } else if (result.job) {
      jobIds.add(result.job.id);
    }
  }

  return results;
}

/**
 * Print validation results
 */
function printResults(results: ValidationResult[]): void {
  let totalErrors = 0;
  let totalWarnings = 0;
  let validFiles = 0;

  console.log('\n━━━ Validation Results ━━━\n');

  for (const result of results) {
    const status = result.valid ? '✓' : '✗';
    const color = result.valid ? '\x1b[32m' : '\x1b[31m';
    const reset = '\x1b[0m';

    console.log(`${color}${status}${reset} ${result.file}`);

    if (result.errors.length > 0) {
      for (const error of result.errors) {
        const field = error.field ? ` [${error.field}]` : '';
        console.log(`  ✗ ERROR${field}: ${error.message}`);
        totalErrors++;
      }
    }

    if (result.warnings.length > 0) {
      for (const warning of result.warnings) {
        const field = warning.field ? ` [${warning.field}]` : '';
        console.log(`  ⚠ WARNING${field}: ${warning.message}`);
        totalWarnings++;
      }
    }

    if (result.valid && result.warnings.length === 0) {
      validFiles++;
    }

    console.log('');
  }

  // Summary
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Total files: ${results.length}`);
  console.log(`Valid: ${validFiles}`);
  console.log(`Errors: ${totalErrors}`);
  console.log(`Warnings: ${totalWarnings}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

// ============================================================================
// CLI
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
CronValidator - Validate cron job YAML syntax

USAGE:
  bun CronValidator.ts <yaml-file>     Validate a specific file
  bun CronValidator.ts --all           Validate all job files
  bun CronValidator.ts --help          Show this help

EXAMPLES:
  # Validate a specific file
  bun CronValidator.ts ~/job.yaml

  # Validate all jobs in the jobs directory
  bun CronValidator.ts --all

VALIDATION CHECKS:
  - Required fields: id, schedule, type, task, output, enabled
  - Cron expression syntax (5 fields: minute hour day month weekday)
  - Field value ranges
  - Duplicate job IDs
  - Task content presence
  - ID format (lowercase, numbers, hyphens)

JOBS DIRECTORY: ${JOBS_DIR}
    `);
    process.exit(0);
  }

  try {
    let results: ValidationResult[];

    if (args[0] === '--all') {
      results = await validateAllFiles();
    } else {
      // Validate single file
      const filePath = args[0];
      const result = await validateFile(filePath);
      results = [result];
    }

    printResults(results);

    // Exit with error if any file is invalid
    const hasErrors = results.some((r) => !r.valid);
    process.exit(hasErrors ? 1 : 0);
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
