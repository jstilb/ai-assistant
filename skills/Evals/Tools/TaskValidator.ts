#!/usr/bin/env bun
/**
 * Task YAML Schema Validator
 * Validates task YAML files against Zod schema
 *
 * CLI:
 *   bun TaskValidator.ts --all
 *   bun TaskValidator.ts --file path/to/task.yaml
 *   bun TaskValidator.ts --suite suite-name
 */

import { z } from 'zod';
import { readFileSync, readdirSync } from 'fs';
import { parse as parseYAML } from 'yaml';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { listGraders } from '../Graders/Base.ts';

// Import graders to register them
import '../Graders/CodeBased/index.ts';
import '../Graders/ModelBased/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EVALS_DIR = join(__dirname, '..');

// =============================================================================
// ZOD SCHEMA
// =============================================================================

const EvalDomainSchema = z.enum(['coding', 'conversational', 'research', 'computer_use', 'general']);
const EvalTypeSchema = z.enum(['capability', 'regression']);

const SetupSchema = z.object({
  sandbox: z.boolean().optional(),
  git_repo: z.string().optional(),
  checkout: z.string().optional(),
  working_dir: z.string().optional(),
  env_vars: z.record(z.string(), z.string()).optional(),
  timeout_ms: z.number().positive().optional(),
  scenario_prompt: z.string().optional(),
  baseline_ref: z.string().optional(),
  isolation: z.enum(['sandbox', 'shared', 'none']).optional(),
  setup_commands: z.array(z.string()).optional(),
}).optional();

const GraderConfigSchema = z.object({
  type: z.string(), // Validated against registry dynamically
  weight: z.number().min(0).max(10).optional(),
  required: z.boolean().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const TaskSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  type: EvalTypeSchema,
  domain: EvalDomainSchema,
  setup: SetupSchema,
  graders: z.array(GraderConfigSchema).min(1),
  tracked_metrics: z.array(z.object({
    type: z.enum(['transcript', 'latency', 'custom']),
    metrics: z.array(z.string()),
  })).optional(),
  trials: z.number().int().positive().optional(),
  pass_threshold: z.number().min(0).max(1).optional(),
  reference_solution: z.string().optional(),
  tags: z.array(z.string()).optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  source: z.enum(['manual', 'failure_log', 'generated']).optional(),
});

// =============================================================================
// VALIDATION LOGIC
// =============================================================================

interface ValidationResult {
  valid: boolean;
  file: string;
  errors: string[];
  warnings: string[];
}

function validateTask(file: string, content: string): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    file,
    errors: [],
    warnings: [],
  };

  try {
    // Parse YAML
    const data = parseYAML(content);

    // Validate against Zod schema
    const parsed = TaskSchema.safeParse(data);

    if (!parsed.success) {
      result.valid = false;
      parsed.error.errors.forEach(err => {
        result.errors.push(`${err.path.join('.')}: ${err.message}`);
      });
      return result;
    }

    const task = parsed.data;

    // Validate grader types against registry
    const registeredTypes = listGraders();

    for (const grader of task.graders) {
      if (!registeredTypes.includes(grader.type)) {
        result.errors.push(`Unknown grader type: ${grader.type}. Available: ${registeredTypes.join(', ')}`);
        result.valid = false;
      }
    }

    // Warnings for best practices
    if (task.trials && task.trials === 1 && task.type === 'capability') {
      result.warnings.push('Capability task with only 1 trial - consider increasing for statistical significance');
    }

    if (!task.pass_threshold) {
      result.warnings.push('No pass_threshold specified - will use default 0.75');
    }

    if (task.pass_threshold && task.pass_threshold < 0.5) {
      result.warnings.push(`Low pass_threshold (${task.pass_threshold}) - consider raising for regression tasks`);
    }

    const totalWeight = task.graders.reduce((sum, g) => sum + (g.weight || 1.0), 0);
    if (Math.abs(totalWeight - task.graders.length) > 0.01 && totalWeight !== 1.0) {
      result.warnings.push(`Grader weights sum to ${totalWeight.toFixed(2)} - this is allowed but unusual`);
    }

    if (task.graders.length > 5) {
      result.warnings.push(`${task.graders.length} graders configured - consider if all are necessary`);
    }

    // Check for required graders
    const hasRequiredGrader = task.graders.some(g => g.required);
    if (!hasRequiredGrader && task.type === 'regression') {
      result.warnings.push('Regression task without required graders - consider marking critical graders as required');
    }

  } catch (error) {
    result.valid = false;
    result.errors.push(`Parse error: ${error instanceof Error ? error.message : String(error)}`);
  }

  return result;
}

function findTaskFiles(pattern?: string): string[] {
  const useCasesDir = join(EVALS_DIR, 'UseCases');
  const files: string[] = [];

  function scanDir(dir: string) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.name.endsWith('.yaml') && entry.name.startsWith('task_')) {
        if (!pattern || fullPath.includes(pattern)) {
          files.push(fullPath);
        }
      }
    }
  }

  scanDir(useCasesDir);
  return files;
}

// =============================================================================
// CLI
// =============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
Task YAML Schema Validator

Usage:
  bun TaskValidator.ts --all                    Validate all task files
  bun TaskValidator.ts --file <path>            Validate specific file
  bun TaskValidator.ts --suite <suite-name>     Validate all tasks in suite

Options:
  --verbose    Show warnings in addition to errors
  --strict     Treat warnings as errors
`);
    process.exit(0);
  }

  const verbose = args.includes('--verbose');
  const strict = args.includes('--strict');

  let files: string[] = [];

  if (args.includes('--all')) {
    files = findTaskFiles();
  } else if (args.includes('--file')) {
    const idx = args.indexOf('--file');
    if (idx === -1 || !args[idx + 1]) {
      console.error('❌ --file requires a path argument');
      process.exit(1);
    }
    files = [args[idx + 1]];
  } else if (args.includes('--suite')) {
    const idx = args.indexOf('--suite');
    if (idx === -1 || !args[idx + 1]) {
      console.error('❌ --suite requires a suite name');
      process.exit(1);
    }
    const suiteName = args[idx + 1];
    files = findTaskFiles(suiteName);
  } else {
    console.error('❌ Must specify --all, --file, or --suite');
    process.exit(1);
  }

  console.log(`🔍 Validating ${files.length} task file(s)...\n`);

  const results: ValidationResult[] = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const result = validateTask(file, content);
    results.push(result);
  }

  // Report results
  let hasErrors = false;
  let hasWarnings = false;

  for (const result of results) {
    if (result.errors.length > 0) {
      hasErrors = true;
      console.log(`❌ ${result.file}`);
      result.errors.forEach(err => console.log(`   - ${err}`));
      console.log();
    } else if (result.warnings.length > 0 && verbose) {
      hasWarnings = true;
      console.log(`⚠️  ${result.file}`);
      result.warnings.forEach(warn => console.log(`   - ${warn}`));
      console.log();
    } else if (verbose) {
      console.log(`✅ ${result.file}`);
    }
  }

  // Summary
  const validCount = results.filter(r => r.valid).length;
  const invalidCount = results.length - validCount;
  const warningCount = results.filter(r => r.warnings.length > 0).length;

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📊 Validation Summary`);
  console.log(`   Valid:    ${validCount}/${results.length}`);
  console.log(`   Invalid:  ${invalidCount}`);
  console.log(`   Warnings: ${warningCount}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (hasErrors || (strict && hasWarnings)) {
    process.exit(1);
  }

  console.log('✅ All validations passed');
  process.exit(0);
}

main();
