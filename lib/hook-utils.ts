/**
 * hook-utils.ts — Shared utilities for Claude Code hook scripts.
 *
 * Usage (UserPromptSubmit / PreToolUse / PostToolUse hooks):
 *   import { readHookInput } from '../lib/hook-utils.ts';
 *   const input = await readHookInput<MyInputType>();  // uses 5000ms default
 *
 * Usage (Stop hooks — stdin always immediately available):
 *   import { readHookInputSync } from '../lib/hook-utils.ts';
 *   const input = readHookInputSync<StopInput>();
 *
 * Two named policy entry points encode hook-class behavior in one place:
 *   - readSecurityHookInput()       — fail-CLOSED: throws on parse/timeout.
 *   - readObservabilityHookInput()  — fail-OPEN:   returns null on parse/timeout.
 *   - readSecurityHookInputSync() / readObservabilityHookInputSync() — synchronous variants.
 *
 * This module replaces all per-hook readStdinWithTimeout and readStdin implementations.
 */

export interface HookInputOptions {
  /** Timeout in milliseconds. Default: 5000 */
  timeoutMs?: number;
  /** Return null instead of empty string on timeout. Default: false (returns null) */
  nullOnTimeout?: boolean;
}

/** Canonical timeout for fail-closed security hook input reads. */
export const SECURITY_HOOK_INPUT_TIMEOUT_MS = 5000;

/** Canonical timeout for fail-open observability hook input reads. */
export const OBSERVABILITY_HOOK_INPUT_TIMEOUT_MS = 2000;

/**
 * Thrown by readSecurityHookInput / readSecurityHookInputSync when stdin
 * is empty, times out, or fails JSON parse. Security hooks let this propagate
 * uncaught so the hook process exits non-zero (fail-closed).
 */
export class SecurityHookInputError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'SecurityHookInputError';
  }
}

/**
 * Read and JSON-parse hook input from stdin with a timeout.
 * Returns null if stdin is empty, times out, or JSON parse fails.
 *
 * This replaces all readStdinWithTimeout implementations in hooks.
 *
 * @param options - Optional configuration
 * @returns Parsed JSON object or null
 */
export async function readHookInput<T>(options: HookInputOptions = {}): Promise<T | null> {
  const { timeoutMs = 5000 } = options;

  try {
    const stdinPromise = new Promise<string>((resolve) => {
      let data = '';
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', (chunk: string) => {
        data += chunk;
      });
      process.stdin.on('end', () => {
        resolve(data);
      });
      process.stdin.on('error', () => {
        resolve('');
      });
      // Resume stdin in case it's paused
      if (process.stdin.isPaused()) {
        process.stdin.resume();
      }
    });

    const timeoutPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve(''), timeoutMs);
    });

    const raw = await Promise.race([stdinPromise, timeoutPromise]);

    if (!raw || !raw.trim()) {
      return null;
    }

    return JSON.parse(raw) as T;
  } catch (err) {
    console.error('[hook-utils] readHookInput error:', err);
    return null;
  }
}

/**
 * Synchronous hook input read — for Stop hooks where stdin is always available.
 * Returns null on empty or parse error.
 *
 * Uses readFileSync(0) to read from stdin file descriptor directly.
 */
export function readHookInputSync<T>(): T | null {
  try {
    const { readFileSync } = require('fs') as typeof import('fs');
    const raw = readFileSync(0, 'utf-8');
    if (!raw || !raw.trim()) {
      return null;
    }
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error('[hook-utils] readHookInputSync error:', err);
    return null;
  }
}

// -- Policy-named entry points -----------------------------------------------
//
// These wrap readHookInput / readHookInputSync with the two canonical hook
// classes. The deletion test for this module: removing it scatters four
// different timeout/error policies across hooks/. Concentrating them here
// is the seam.

/**
 * Async, fail-CLOSED hook input read for security/gating hooks.
 *
 * Throws SecurityHookInputError on:
 *   - empty stdin
 *   - timeout (default SECURITY_HOOK_INPUT_TIMEOUT_MS)
 *   - JSON parse failure
 *
 * Intended consumer pattern: do NOT catch — let the throw propagate. The
 * hook process exits with a non-zero code, which for PreToolUse hooks
 * results in the tool call being blocked (fail-closed).
 */
export async function readSecurityHookInput<T>(options: HookInputOptions = {}): Promise<T> {
  const { timeoutMs = SECURITY_HOOK_INPUT_TIMEOUT_MS } = options;
  const result = await readHookInput<T>({ timeoutMs });
  if (result === null) {
    throw new SecurityHookInputError(
      `Security hook input unavailable (empty stdin, timeout >${timeoutMs}ms, or JSON parse failure)`,
    );
  }
  return result;
}

/**
 * Async, fail-OPEN hook input read for observability/UX hooks.
 *
 * Returns null on empty stdin, timeout, or JSON parse failure. Never throws.
 * Intended consumer pattern: callers handle the null branch by skipping
 * non-essential work and exiting 0 — observability hooks must never break
 * the user's flow.
 */
export async function readObservabilityHookInput<T>(options: HookInputOptions = {}): Promise<T | null> {
  const { timeoutMs = OBSERVABILITY_HOOK_INPUT_TIMEOUT_MS } = options;
  return await readHookInput<T>({ timeoutMs });
}

/**
 * Synchronous, fail-CLOSED hook input read. Mirrors readSecurityHookInput
 * for hook scripts that are structured around synchronous main()s. Throws
 * SecurityHookInputError on empty stdin or parse failure (no timeout —
 * stdin is always immediately available in hook context).
 */
export function readSecurityHookInputSync<T>(): T {
  const result = readHookInputSync<T>();
  if (result === null) {
    throw new SecurityHookInputError(
      'Security hook input unavailable (empty stdin or JSON parse failure)',
    );
  }
  return result;
}

/**
 * Synchronous, fail-OPEN hook input read. Mirrors readObservabilityHookInput
 * for hook scripts that are structured around synchronous main()s. Returns
 * null on empty stdin or parse failure.
 */
export function readObservabilityHookInputSync<T>(): T | null {
  return readHookInputSync<T>();
}
