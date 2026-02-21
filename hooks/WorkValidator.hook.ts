#!/usr/bin/env bun
/**
 * WorkValidator.hook.ts - Work Completion Validation (SessionEnd)
 *
 * PURPOSE:
 * Validates that work directories are complete and properly structured before
 * session ends. Ensures no work is lost due to incomplete capture.
 *
 * TRIGGER: SessionEnd
 *
 * INPUT:
 * - conversation_id: Current conversation identifier
 * - timestamp: Session end timestamp
 *
 * OUTPUT:
 * - stdout: None (validation hooks are informational)
 * - exit(0): Always (non-blocking)
 *
 * VALIDATION CHECKS:
 * 1. Current work directory exists
 * 2. IDEAL.md has content (not empty)
 * 3. META.yaml has required fields
 * 4. Work items have been captured
 *
 * SIDE EFFECTS:
 * - Writes to: MEMORY/VALIDATION/YYYY/MM/work-validation-{timestamp}.jsonl
 * - Alerts: Logs warnings to stderr for incomplete work
 *
 * ERROR HANDLING:
 * - All errors fail-open (log and continue)
 * - Never prevents session end
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { kayaPath } from './lib/paths';

// ========================================
// Types
// ========================================

interface HookInput {
  conversation_id?: string;
  timestamp?: string;
}

interface WorkValidationResult {
  timestamp: string;
  session_id: string;
  valid: boolean;
  checks: {
    work_dir_exists: boolean;
    ideal_md_exists: boolean;
    ideal_md_has_content: boolean;
    meta_yaml_exists: boolean;
    meta_yaml_valid: boolean;
  };
  work_dir?: string;
  issues: string[];
  warnings: string[];
}

// ========================================
// Validation Functions
// ========================================

function getCurrentWork(): { session_id: string; work_dir: string } | null {
  try {
    const statePath = kayaPath('MEMORY', 'State', 'current-work.json');
    if (!existsSync(statePath)) {
      return null;
    }

    const content = readFileSync(statePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function validateIdealMd(workDir: string): { exists: boolean; hasContent: boolean } {
  try {
    const idealPath = join(workDir, 'IDEAL.md');

    if (!existsSync(idealPath)) {
      return { exists: false, hasContent: false };
    }

    const stats = statSync(idealPath);
    const content = readFileSync(idealPath, 'utf-8').trim();

    // Check if file has meaningful content (more than just a header)
    const hasContent = content.length > 50 && content.split('\n').length > 3;

    return { exists: true, hasContent };
  } catch {
    return { exists: false, hasContent: false };
  }
}

function validateMetaYaml(workDir: string): { exists: boolean; valid: boolean; issues: string[] } {
  try {
    const metaPath = join(workDir, 'META.yaml');
    const issues: string[] = [];

    if (!existsSync(metaPath)) {
      return { exists: false, valid: false, issues: ['META.yaml not found'] };
    }

    const content = readFileSync(metaPath, 'utf-8');

    // Check for required fields
    const requiredFields = ['created', 'status', 'prompt'];

    for (const field of requiredFields) {
      if (!content.includes(`${field}:`)) {
        issues.push(`Missing required field: ${field}`);
      }
    }

    // Check status is valid
    const statusMatch = content.match(/status:\s*(\w+)/);
    if (statusMatch) {
      const status = statusMatch[1].toLowerCase();
      if (!['in_progress', 'completed', 'failed', 'abandoned'].includes(status)) {
        issues.push(`Invalid status: ${status}`);
      }
    }

    return {
      exists: true,
      valid: issues.length === 0,
      issues,
    };
  } catch (error) {
    return { exists: false, valid: false, issues: [`Error reading META.yaml: ${error}`] };
  }
}

function getValidationLogPath(): string {
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  const hour = now.getHours().toString().padStart(2, '0');
  const min = now.getMinutes().toString().padStart(2, '0');
  const sec = now.getSeconds().toString().padStart(2, '0');

  const timestamp = `${year}${month}${day}-${hour}${min}${sec}`;

  return kayaPath('MEMORY', 'VALIDATION', year, month, `work-validation-${timestamp}.jsonl`);
}

function logValidationResult(result: WorkValidationResult): void {
  try {
    const logPath = getValidationLogPath();
    const dir = logPath.substring(0, logPath.lastIndexOf('/'));

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const content = JSON.stringify(result, null, 2);
    writeFileSync(logPath, content);
  } catch {
    // Logging failure should not impact execution
  }
}

// ========================================
// Main Validation
// ========================================

function validateWork(sessionId: string): WorkValidationResult {
  const result: WorkValidationResult = {
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    valid: true,
    checks: {
      work_dir_exists: false,
      ideal_md_exists: false,
      ideal_md_has_content: false,
      meta_yaml_exists: false,
      meta_yaml_valid: false,
    },
    issues: [],
    warnings: [],
  };

  // Get current work directory
  const currentWork = getCurrentWork();
  if (!currentWork || !currentWork.work_dir) {
    result.warnings.push('No current work directory tracked');
    return result;
  }

  const workDir = kayaPath('MEMORY', 'WORK', currentWork.work_dir);
  result.work_dir = workDir;

  // Check 1: Work directory exists
  result.checks.work_dir_exists = existsSync(workDir);
  if (!result.checks.work_dir_exists) {
    result.valid = false;
    result.issues.push(`Work directory does not exist: ${workDir}`);
    return result;
  }

  // Check 2 & 3: IDEAL.md exists and has content
  const idealCheck = validateIdealMd(workDir);
  result.checks.ideal_md_exists = idealCheck.exists;
  result.checks.ideal_md_has_content = idealCheck.hasContent;

  if (!idealCheck.exists) {
    result.warnings.push('IDEAL.md not found');
  } else if (!idealCheck.hasContent) {
    result.warnings.push('IDEAL.md exists but has minimal content');
  }

  // Check 4 & 5: META.yaml exists and is valid
  const metaCheck = validateMetaYaml(workDir);
  result.checks.meta_yaml_exists = metaCheck.exists;
  result.checks.meta_yaml_valid = metaCheck.valid;

  if (!metaCheck.exists) {
    result.warnings.push('META.yaml not found');
  } else if (!metaCheck.valid) {
    result.issues.push(...metaCheck.issues);
  }

  // Determine overall validity (issues = problems, warnings = ok but suboptimal)
  result.valid = result.issues.length === 0;

  return result;
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
    // Parse error or timeout - use empty input
    input = {};
  }

  const sessionId = input.conversation_id || 'unknown';

  // Run validation
  const result = validateWork(sessionId);

  // Log result
  logValidationResult(result);

  // Output warnings/issues to stderr for visibility
  if (result.issues.length > 0) {
    console.error(`[WorkValidator] ISSUES detected:`);
    for (const issue of result.issues) {
      console.error(`  ⚠️ ${issue}`);
    }
  }

  if (result.warnings.length > 0) {
    console.error(`[WorkValidator] Warnings:`);
    for (const warning of result.warnings) {
      console.error(`  📝 ${warning}`);
    }
  }

  if (result.valid && result.issues.length === 0 && result.warnings.length === 0) {
    console.error(`[WorkValidator] ✅ Work validation passed for ${result.work_dir}`);
  }

  process.exit(0);
}

main().catch(() => {
  process.exit(0);
});
