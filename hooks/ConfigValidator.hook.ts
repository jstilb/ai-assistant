#!/usr/bin/env bun
/**
 * ConfigValidator.hook.ts - Configuration Validation (SessionStart)
 *
 * PURPOSE:
 * Validates settings.json schema compliance and required fields at session start.
 * Ensures Kaya configuration is complete and valid before session begins.
 *
 * TRIGGER: SessionStart
 *
 * INPUT:
 * - session_id: Current session identifier
 * - transcript_path: Path to session transcript
 * - cwd: Current working directory
 *
 * OUTPUT:
 * - stdout: None (validation hooks are informational)
 * - exit(0): Always (non-blocking)
 *
 * VALIDATION CHECKS:
 * 1. settings.json exists and is valid JSON
 * 2. Required fields are present (daidentity, principal)
 * 3. Environment variables are properly configured
 * 4. Hook paths exist and are executable
 *
 * SIDE EFFECTS:
 * - Writes to: MEMORY/VALIDATION/YYYY/MM/config-validation-{timestamp}.jsonl
 * - Alerts: Logs warnings to stderr for configuration issues
 *
 * ERROR HANDLING:
 * - All errors fail-open (log and continue)
 * - Never prevents session start
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, constants, accessSync } from 'fs';
import { kayaPath, getSettingsPath } from './lib/paths';

// ========================================
// Types
// ========================================

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

interface ConfigValidationResult {
  timestamp: string;
  session_id: string;
  valid: boolean;
  checks: {
    settings_exists: boolean;
    settings_valid_json: boolean;
    daidentity_present: boolean;
    daidentity_name_set: boolean;
    principal_present: boolean;
    principal_name_set: boolean;
    env_pai_dir_set: boolean;
    hooks_configured: boolean;
    hooks_executable: boolean;
  };
  issues: string[];
  warnings: string[];
}

interface SettingsJson {
  daidentity?: {
    name?: string;
    voiceId?: string;
    color?: string;
  };
  principal?: {
    name?: string;
    timezone?: string;
  };
  env?: Record<string, string>;
  hooks?: Record<string, unknown[]>;
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
}

// ========================================
// Validation Functions
// ========================================

function loadSettings(): { success: boolean; data?: SettingsJson; error?: string } {
  try {
    const settingsPath = getSettingsPath();

    if (!existsSync(settingsPath)) {
      return { success: false, error: 'settings.json not found' };
    }

    const content = readFileSync(settingsPath, 'utf-8');
    const data = JSON.parse(content) as SettingsJson;

    return { success: true, data };
  } catch (error) {
    return { success: false, error: `Invalid JSON: ${error}` };
  }
}

function validateDaidentity(settings: SettingsJson): { present: boolean; nameSet: boolean; issues: string[] } {
  const issues: string[] = [];

  if (!settings.daidentity) {
    return { present: false, nameSet: false, issues: ['daidentity section missing'] };
  }

  if (!settings.daidentity.name || settings.daidentity.name.trim() === '') {
    issues.push('daidentity.name not set');
  }

  // Check for default name that should be changed
  if (settings.daidentity.name === 'Kaya' && !settings.daidentity.voiceId) {
    issues.push('daidentity appears to be using defaults - consider running install wizard');
  }

  return {
    present: true,
    nameSet: !!settings.daidentity.name && settings.daidentity.name.trim() !== '',
    issues,
  };
}

function validatePrincipal(settings: SettingsJson): { present: boolean; nameSet: boolean; issues: string[] } {
  const issues: string[] = [];

  if (!settings.principal) {
    return { present: false, nameSet: false, issues: ['principal section missing'] };
  }

  if (!settings.principal.name || settings.principal.name.trim() === '') {
    issues.push('principal.name not set');
  }

  // Check for default name that should be changed
  if (settings.principal.name === 'User') {
    issues.push('principal.name is still "User" - run install wizard to set your name');
  }

  return {
    present: true,
    nameSet: !!settings.principal.name && settings.principal.name.trim() !== '' && settings.principal.name !== 'User',
    issues,
  };
}

function validateEnv(settings: SettingsJson): { kayaDirSet: boolean; warnings: string[] } {
  const warnings: string[] = [];

  if (!settings.env) {
    return { kayaDirSet: false, warnings: ['env section missing'] };
  }

  if (!settings.env.KAYA_DIR) {
    warnings.push('KAYA_DIR not set in env - using default ~/.claude');
  }

  // Check optional but recommended env vars
  if (!settings.env.ELEVENLABS_API_KEY) {
    warnings.push('ELEVENLABS_API_KEY not set - voice notifications disabled');
  }

  return {
    kayaDirSet: !!settings.env.KAYA_DIR,
    warnings,
  };
}

function validateHooks(settings: SettingsJson): { configured: boolean; executable: boolean; issues: string[] } {
  const issues: string[] = [];

  if (!settings.hooks) {
    return { configured: false, executable: false, issues: ['hooks section missing'] };
  }

  const hookEvents = Object.keys(settings.hooks);
  if (hookEvents.length === 0) {
    return { configured: false, executable: false, issues: ['no hooks configured'] };
  }

  // Check a few critical hook files exist and are executable
  const criticalHooks = [
    'LoadContext.hook.ts',
    'SecurityValidator.hook.ts',
    'StopOrchestrator.hook.ts',
  ];

  let allExecutable = true;
  for (const hook of criticalHooks) {
    const hookPath = kayaPath('hooks', hook);

    if (!existsSync(hookPath)) {
      issues.push(`Critical hook missing: ${hook}`);
      allExecutable = false;
      continue;
    }

    try {
      accessSync(hookPath, constants.X_OK);
    } catch {
      // On Unix, .ts files run via bun don't need +x
      // Just check they exist and have content
      const stats = statSync(hookPath);
      if (stats.size === 0) {
        issues.push(`Hook file is empty: ${hook}`);
        allExecutable = false;
      }
    }
  }

  return {
    configured: true,
    executable: allExecutable && issues.length === 0,
    issues,
  };
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

  return kayaPath('MEMORY', 'VALIDATION', year, month, `config-validation-${timestamp}.jsonl`);
}

function logValidationResult(result: ConfigValidationResult): void {
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

function validateConfig(sessionId: string): ConfigValidationResult {
  const result: ConfigValidationResult = {
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    valid: true,
    checks: {
      settings_exists: false,
      settings_valid_json: false,
      daidentity_present: false,
      daidentity_name_set: false,
      principal_present: false,
      principal_name_set: false,
      env_pai_dir_set: false,
      hooks_configured: false,
      hooks_executable: false,
    },
    issues: [],
    warnings: [],
  };

  // Load and validate settings.json
  const settingsResult = loadSettings();
  result.checks.settings_exists = settingsResult.success || existsSync(getSettingsPath());
  result.checks.settings_valid_json = settingsResult.success;

  if (!settingsResult.success) {
    result.valid = false;
    result.issues.push(settingsResult.error || 'Failed to load settings');
    return result;
  }

  const settings = settingsResult.data!;

  // Validate daidentity
  const daidentityCheck = validateDaidentity(settings);
  result.checks.daidentity_present = daidentityCheck.present;
  result.checks.daidentity_name_set = daidentityCheck.nameSet;
  result.issues.push(...daidentityCheck.issues.filter(i => i.includes('missing')));
  result.warnings.push(...daidentityCheck.issues.filter(i => !i.includes('missing')));

  // Validate principal
  const principalCheck = validatePrincipal(settings);
  result.checks.principal_present = principalCheck.present;
  result.checks.principal_name_set = principalCheck.nameSet;
  result.issues.push(...principalCheck.issues.filter(i => i.includes('missing')));
  result.warnings.push(...principalCheck.issues.filter(i => !i.includes('missing')));

  // Validate env
  const envCheck = validateEnv(settings);
  result.checks.env_pai_dir_set = envCheck.kayaDirSet;
  result.warnings.push(...envCheck.warnings);

  // Validate hooks
  const hooksCheck = validateHooks(settings);
  result.checks.hooks_configured = hooksCheck.configured;
  result.checks.hooks_executable = hooksCheck.executable;
  result.issues.push(...hooksCheck.issues);

  // Determine overall validity
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

  const sessionId = input.session_id || 'unknown';

  // Run validation
  const result = validateConfig(sessionId);

  // Log result
  logValidationResult(result);

  // Output issues to stderr (but don't be noisy on success)
  if (result.issues.length > 0) {
    console.error(`[ConfigValidator] Configuration issues detected:`);
    for (const issue of result.issues) {
      console.error(`  ⚠️ ${issue}`);
    }
  }

  // Only show warnings on first run (when principal not set)
  if (!result.checks.principal_name_set && result.warnings.length > 0) {
    console.error(`[ConfigValidator] Recommendations:`);
    for (const warning of result.warnings) {
      console.error(`  📝 ${warning}`);
    }
  }

  process.exit(0);
}

main().catch(() => {
  process.exit(0);
});
