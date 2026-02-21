#!/usr/bin/env bun
/**
 * OutputValidator.hook.ts - PostToolUse Output Validation
 *
 * PURPOSE:
 * Validates tool outputs after execution to detect errors, secrets in output,
 * and unexpected patterns. Provides post-execution security and quality checks.
 *
 * TRIGGER: PostToolUse (matcher: Bash, Edit, Write, Read)
 *
 * INPUT:
 * - tool_name: "Bash" | "Edit" | "Write" | "Read"
 * - tool_input: { command?: string, file_path?: string, ... }
 * - tool_output: string | object (the result of the tool execution)
 * - session_id: Current session identifier
 *
 * OUTPUT:
 * - stdout: None (validation hooks don't block)
 * - exit(0): Always (non-blocking)
 *
 * SIDE EFFECTS:
 * - Writes to: MEMORY/VALIDATION/YYYY/MM/validation-{summary}-{timestamp}.jsonl
 * - Alerts: Logs warnings to stderr for detected issues
 *
 * VALIDATION CHECKS:
 * 1. Error Detection - Detects error patterns in Bash output
 * 2. Secret Detection - Scans output for potential secrets/credentials
 * 3. Unexpected Output - Detects anomalous patterns
 *
 * ERROR HANDLING:
 * - All errors fail-open (log and continue)
 * - Never blocks tool execution
 *
 * PERFORMANCE:
 * - Non-blocking: Yes (runs after tool completes)
 * - Typical execution: <50ms
 */

import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { kayaPath } from './lib/paths';

// ========================================
// Types
// ========================================

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown> | string;
  tool_output?: string | Record<string, unknown>;
  error?: string;
}

interface ValidationEvent {
  timestamp: string;
  session_id: string;
  validation_type: 'error_detected' | 'secret_detected' | 'anomaly_detected' | 'clean';
  tool: string;
  severity: 'info' | 'warning' | 'critical';
  details: string;
  output_snippet?: string;
}

// ========================================
// Secret Detection Patterns
// ========================================

const SECRET_PATTERNS = [
  // API Keys
  { pattern: /sk[-_][a-zA-Z0-9]{20,}/g, name: 'API Key (sk_)' },
  { pattern: /api[-_]?key[\s:=]+['""]?[a-zA-Z0-9]{16,}/gi, name: 'API Key' },
  { pattern: /bearer\s+[a-zA-Z0-9\-_.]{20,}/gi, name: 'Bearer Token' },

  // AWS
  { pattern: /AKIA[0-9A-Z]{16}/g, name: 'AWS Access Key' },
  { pattern: /aws[-_]?secret[-_]?access[-_]?key[\s:=]+['""]?[a-zA-Z0-9/+=]{40}/gi, name: 'AWS Secret Key' },

  // Private Keys
  { pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/g, name: 'Private Key' },
  { pattern: /-----BEGIN\s+OPENSSH\s+PRIVATE\s+KEY-----/g, name: 'OpenSSH Private Key' },

  // Database
  { pattern: /mongodb(\+srv)?:\/\/[^:]+:[^@]+@/gi, name: 'MongoDB Connection String' },
  { pattern: /postgres(ql)?:\/\/[^:]+:[^@]+@/gi, name: 'PostgreSQL Connection String' },
  { pattern: /mysql:\/\/[^:]+:[^@]+@/gi, name: 'MySQL Connection String' },

  // GitHub/GitLab
  { pattern: /ghp_[a-zA-Z0-9]{36}/g, name: 'GitHub Personal Access Token' },
  { pattern: /gho_[a-zA-Z0-9]{36}/g, name: 'GitHub OAuth Token' },
  { pattern: /glpat-[a-zA-Z0-9\-]{20}/g, name: 'GitLab Personal Access Token' },

  // Slack
  { pattern: /xoxb-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24}/g, name: 'Slack Bot Token' },
  { pattern: /xoxp-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24}/g, name: 'Slack User Token' },

  // JWT
  { pattern: /eyJ[a-zA-Z0-9\-_]+\.eyJ[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_.]+/g, name: 'JWT Token' },
];

// ========================================
// Error Patterns
// ========================================

const ERROR_PATTERNS = [
  // Generic errors
  { pattern: /error:/gi, severity: 'warning' as const },
  { pattern: /fatal:/gi, severity: 'critical' as const },
  { pattern: /exception:/gi, severity: 'warning' as const },
  { pattern: /panic:/gi, severity: 'critical' as const },

  // Exit codes
  { pattern: /exit code [1-9]\d*/gi, severity: 'warning' as const },
  { pattern: /exited with status [1-9]\d*/gi, severity: 'warning' as const },

  // Permission errors
  { pattern: /permission denied/gi, severity: 'warning' as const },
  { pattern: /access denied/gi, severity: 'warning' as const },
  { pattern: /EACCES/g, severity: 'warning' as const },
  { pattern: /EPERM/g, severity: 'warning' as const },

  // File errors
  { pattern: /no such file or directory/gi, severity: 'warning' as const },
  { pattern: /file not found/gi, severity: 'warning' as const },
  { pattern: /ENOENT/g, severity: 'warning' as const },

  // Network errors
  { pattern: /connection refused/gi, severity: 'warning' as const },
  { pattern: /ECONNREFUSED/g, severity: 'warning' as const },
  { pattern: /timeout/gi, severity: 'info' as const },

  // Segfaults and crashes
  { pattern: /segmentation fault/gi, severity: 'critical' as const },
  { pattern: /core dumped/gi, severity: 'critical' as const },
  { pattern: /killed/gi, severity: 'warning' as const },
];

// ========================================
// Validation Logging
// ========================================

function generateEventSummary(event: ValidationEvent): string {
  const words = event.details
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1)
    .slice(0, 5);

  return [event.validation_type, ...words].join('-').slice(0, 50);
}

function getValidationLogPath(event: ValidationEvent): string {
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  const hour = now.getHours().toString().padStart(2, '0');
  const min = now.getMinutes().toString().padStart(2, '0');
  const sec = now.getSeconds().toString().padStart(2, '0');

  const summary = generateEventSummary(event);
  const timestamp = `${year}${month}${day}-${hour}${min}${sec}`;

  return kayaPath('MEMORY', 'VALIDATION', year, month, `validation-${summary}-${timestamp}.jsonl`);
}

function logValidationEvent(event: ValidationEvent): void {
  try {
    const logPath = getValidationLogPath(event);
    const dir = logPath.substring(0, logPath.lastIndexOf('/'));

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const content = JSON.stringify(event, null, 2);
    writeFileSync(logPath, content);
  } catch {
    // Logging failure should not impact execution
  }
}

// ========================================
// Validation Functions
// ========================================

function detectSecrets(output: string): { found: boolean; secrets: string[] } {
  const secrets: string[] = [];

  for (const { pattern, name } of SECRET_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    if (pattern.test(output)) {
      secrets.push(name);
    }
  }

  return { found: secrets.length > 0, secrets };
}

function detectErrors(output: string): { found: boolean; severity: 'info' | 'warning' | 'critical'; patterns: string[] } {
  let maxSeverity: 'info' | 'warning' | 'critical' = 'info';
  const patterns: string[] = [];

  for (const { pattern, severity } of ERROR_PATTERNS) {
    pattern.lastIndex = 0;
    const match = output.match(pattern);
    if (match) {
      patterns.push(match[0]);
      if (severity === 'critical') {
        maxSeverity = 'critical';
      } else if (severity === 'warning' && maxSeverity !== 'critical') {
        maxSeverity = 'warning';
      }
    }
  }

  return { found: patterns.length > 0, severity: maxSeverity, patterns };
}

function getOutputString(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === null || output === undefined) return '';
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

// ========================================
// Tool-Specific Handlers
// ========================================

function validateBashOutput(input: HookInput): void {
  const output = getOutputString(input.tool_output);

  // Check for secrets in output
  const secretCheck = detectSecrets(output);
  if (secretCheck.found) {
    const event: ValidationEvent = {
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      validation_type: 'secret_detected',
      tool: 'Bash',
      severity: 'critical',
      details: `Potential secrets detected in output: ${secretCheck.secrets.join(', ')}`,
      output_snippet: output.slice(0, 200),
    };
    logValidationEvent(event);
    console.error(`⚠️ [OutputValidator] SECRET DETECTED in Bash output: ${secretCheck.secrets.join(', ')}`);
    return;
  }

  // Check for errors
  const errorCheck = detectErrors(output);
  if (errorCheck.found) {
    const event: ValidationEvent = {
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      validation_type: 'error_detected',
      tool: 'Bash',
      severity: errorCheck.severity,
      details: `Error patterns detected: ${errorCheck.patterns.slice(0, 3).join(', ')}`,
      output_snippet: output.slice(0, 200),
    };
    logValidationEvent(event);

    if (errorCheck.severity === 'critical') {
      console.error(`🚨 [OutputValidator] CRITICAL ERROR in Bash output: ${errorCheck.patterns[0]}`);
    }
    return;
  }

  // Check if tool reported an error
  if (input.error) {
    const event: ValidationEvent = {
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      validation_type: 'error_detected',
      tool: 'Bash',
      severity: 'warning',
      details: `Tool execution error: ${input.error}`,
    };
    logValidationEvent(event);
  }
}

function validateFileOutput(toolName: string, input: HookInput): void {
  const output = getOutputString(input.tool_output);

  // Check for secrets in file content that was read/written
  const secretCheck = detectSecrets(output);
  if (secretCheck.found) {
    const filePath = typeof input.tool_input === 'string'
      ? input.tool_input
      : (input.tool_input?.file_path as string) || 'unknown';

    const event: ValidationEvent = {
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      validation_type: 'secret_detected',
      tool: toolName,
      severity: 'critical',
      details: `Potential secrets detected in ${toolName} operation on ${filePath}: ${secretCheck.secrets.join(', ')}`,
    };
    logValidationEvent(event);
    console.error(`⚠️ [OutputValidator] SECRET DETECTED in ${toolName} output: ${secretCheck.secrets.join(', ')}`);
  }

  // Check for tool errors
  if (input.error) {
    const event: ValidationEvent = {
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      validation_type: 'error_detected',
      tool: toolName,
      severity: 'warning',
      details: `Tool execution error: ${input.error}`,
    };
    logValidationEvent(event);
  }
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
    // Parse error or timeout - exit silently
    process.exit(0);
    return;
  }

  // Route to appropriate handler
  switch (input.tool_name) {
    case 'Bash':
      validateBashOutput(input);
      break;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'Read':
      validateFileOutput(input.tool_name, input);
      break;
  }

  process.exit(0);
}

main().catch(() => {
  process.exit(0);
});
