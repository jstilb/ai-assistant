#!/usr/bin/env bun
/**
 * StopFailure.hook.ts - Handler for StopFailure hook event
 *
 * PURPOSE:
 * Fires when a Claude Code session terminates due to an API error (rate limit,
 * auth failure, billing error, etc.). Sends an ntfy.sh notification and appends
 * a structured entry to the failure log for post-mortem inspection.
 *
 * TRIGGER: StopFailure (fires after session terminates due to API error)
 *
 * INPUT (stdin JSON):
 * - hook_event_name: "StopFailure"
 * - session_id: Current session identifier
 * - transcript_path: Path to the JSONL transcript file
 * - cwd: Working directory at time of failure
 * - permission_mode: Claude permission mode
 * - error: Error type enum (rate_limit | authentication_failed | billing_error | etc.)
 * - error_details?: Optional human-readable error detail string
 * - last_assistant_message: Last message from assistant before failure
 *
 * OUTPUT:
 * - stdout: None
 * - stderr: Debug/warning logs
 * - exit(0): Always (hook must never propagate errors)
 *
 * SIDE EFFECTS:
 * - Notification: Routes through AlertGate (S5 migration) via notifyError()
 *   -> hooks/lib/notifications.ts's notify('error', ...) — NOT a literal
 *   ntfy.sh fetch (that raw path was deleted in S5; see notifications.ts's
 *   own comment on the 'ntfy' channel name). Own 5-min per-error-type
 *   cooldown gates whether notifyError() is even called; AlertGate applies
 *   its OWN separate cooldown/dedup on top. Tier is 'page' only when this
 *   error's mapped priority is 'urgent' (see PRIORITY_MAP below) — today
 *   only billing_error reaches that tier; authentication_failed is mapped
 *   to 'high' and can therefore only ever reach 'digest' tier (delivered by
 *   the next daily SystemHealthDigest run, not immediately).
 * - Log: Appends JSONL entry to MEMORY/MONITORING/failure-log.jsonl
 * - Cooldown: Reads/writes MEMORY/MONITORING/stop-failure-cooldown.json
 *
 * ERROR HANDLING:
 * - Malformed/missing payload: Logs warning to stderr, exits 0
 * - Any runtime error: Caught by top-level try/catch, exits 0
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { notifyError } from './lib/notifications';
import { readHookInput } from '../lib/hook-utils';
import type { NotificationPriority } from './lib/notifications';
import { recordFailure } from '../lib/core/FailureLog.ts';
import { kayaHomePath } from '../lib/core/KayaHome.ts';
import { trackWindowedHealStreak, type FailStreakResult } from '../lib/cron/FailStreak.ts';
import type { AlertResult, SendAlertOptions } from '../lib/core/AlertGate.ts';

/** Matches lib/core/AlertGate.ts's `sendAlert()` signature exactly — used
 *  only to type `maybeEscalateInteractiveAuthStreak()`'s test-only DI seam
 *  below (production never passes this argument, so it always falls back to
 *  trackWindowedHealStreak()'s own real-`sendAlert` default). */
type SendAlertFn = (message: string, options: SendAlertOptions) => Promise<AlertResult>;

// ============================================================================
// Types
// ============================================================================

type ErrorType =
  | 'rate_limit'
  | 'authentication_failed'
  | 'billing_error'
  | 'invalid_request'
  | 'server_error'
  | 'max_output_tokens'
  | 'unknown';

const VALID_ERROR_TYPES: readonly ErrorType[] = [
  'rate_limit',
  'authentication_failed',
  'billing_error',
  'invalid_request',
  'server_error',
  'max_output_tokens',
  'unknown',
] as const;

interface StopFailurePayload {
  hook_event_name: 'StopFailure';
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  error: ErrorType;
  error_details?: string;
  last_assistant_message: string;
}

type CooldownState = Record<string, string>;

// ============================================================================
// Constants
// ============================================================================

const COOLDOWN_MINUTES = 5;
const COOLDOWN_MS = COOLDOWN_MINUTES * 60 * 1000;

const PRIORITY_MAP: Record<ErrorType, NotificationPriority> = {
  rate_limit: 'default',
  authentication_failed: 'high',
  billing_error: 'urgent',
  invalid_request: 'default',
  server_error: 'default',
  max_output_tokens: 'low',
  unknown: 'default',
};

// T2-03 (theme2-auth-failure-paging.md): PRIORITY_MAP above hard-maps
// authentication_failed to 'high', which notify()'s tier logic
// (hooks/lib/notifications.ts:270, `event === 'error' && resolvedPriority
// === 'urgent' ? 'page' : 'digest'`) can never escalate past 'digest' — a
// persistent auth-failure streak from a cause S2 (keychain-recreation)/S3
// (setup-token-invalid)/S4 (cron auth-incident) don't directly instrument
// would otherwise sit silent until the next daily digest no matter how many
// times it recurs (confirmed live: a 16-event burst across 16 distinct
// session_ids in ~1 minute, 2026-07-17, sat 'digest'-tier only). This is a
// SEPARATE escalation path from notifyError() below, keyed class-level (not
// per-session_id, since session_id is different on every occurrence) with
// its own rolling window via trackWindowedHealStreak (lib/cron/FailStreak.ts,
// T2-04's consolidated heal-streak machinery) — "N within any window span,"
// not pure infinite-consecutive, so one stale blip weeks apart can't
// silently prime a false escalation.
const INTERACTIVE_AUTH_STREAK_KEY = 'interactive-auth';
const INTERACTIVE_AUTH_ALERT_KEY = 'interactive-auth-incident';
const INTERACTIVE_AUTH_WINDOW_MS = 10 * 60 * 1000; // "3 within any 10-minute span" (§5)
// §5: "a persistent SAME incident pages once per half hour, not once per day
// and not once per occurrence" — matches bin/cron-health-monitor.ts's
// pageAuthIncident() cooldownMs (30 * 60 * 1000) exactly, so this page path
// and S4's cron auth-incident page path share the same re-page cadence.
// Without this, AlertGate falls back to its own 24h DEFAULT_COOLDOWN_MS, so
// a genuinely ongoing incident that re-crosses the streak threshold 1-2h
// after its first page would be silently demoted to digest for up to ~24h.
const INTERACTIVE_AUTH_COOLDOWN_MS = 30 * 60 * 1000;
// How recent an S2/S3 root-cause page must be to count as "already covered"
// — mirrors S4's pageAuthIncident() cooldown convention (30 min), not an
// independently-tuned knob. See §6: a naive threshold-3 escalation with no
// cross-check would have double-paged on 2026-07-17's live incident (S2
// paged at 15:42:52; the authentication_failed cascade started 4 min later).
const ROOT_CAUSE_CROSS_CHECK_WINDOW_MS = 30 * 60 * 1000;
const ROOT_CAUSE_ALERT_KEYS = ['keychain-credential-recreated', 'setup-token-invalid'] as const;

// ============================================================================
// Helpers
// ============================================================================

function isValidErrorType(value: string): value is ErrorType {
  return (VALID_ERROR_TYPES as readonly string[]).includes(value);
}

function parsePayload(raw: string): StopFailurePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[StopFailure] Could not parse stdin as JSON');
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    console.error('[StopFailure] Payload is not an object');
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  const sessionId = typeof obj['session_id'] === 'string' ? obj['session_id'] : '';
  const transcriptPath = typeof obj['transcript_path'] === 'string' ? obj['transcript_path'] : '';
  const cwd = typeof obj['cwd'] === 'string' ? obj['cwd'] : '';
  const permissionMode = typeof obj['permission_mode'] === 'string' ? obj['permission_mode'] : '';
  const lastAssistantMessage = typeof obj['last_assistant_message'] === 'string' ? obj['last_assistant_message'] : '';
  const errorDetails = typeof obj['error_details'] === 'string' ? obj['error_details'] : undefined;

  const rawError = typeof obj['error'] === 'string' ? obj['error'] : '';
  const error: ErrorType = isValidErrorType(rawError) ? rawError : 'unknown';

  if (!sessionId) {
    console.error('[StopFailure] Missing session_id — logging with empty session');
  }

  return {
    hook_event_name: 'StopFailure',
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
    permission_mode: permissionMode,
    error,
    error_details: errorDetails,
    last_assistant_message: lastAssistantMessage,
  };
}

function readCooldownState(cooldownPath: string): CooldownState {
  if (!existsSync(cooldownPath)) return {};
  try {
    const content = readFileSync(cooldownPath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      // Validate all values are strings
      const result: CooldownState = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') result[k] = v;
      }
      return result;
    }
  } catch {
    console.error('[StopFailure] Failed to read cooldown state, resetting');
  }
  return {};
}

function isOnCooldown(state: CooldownState, errorType: ErrorType): boolean {
  const lastSent = state[errorType];
  if (!lastSent) return false;
  const elapsed = Date.now() - new Date(lastSent).getTime();
  return elapsed < COOLDOWN_MS;
}

function writeCooldownState(cooldownPath: string, state: CooldownState): void {
  const dir = dirname(cooldownPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(cooldownPath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * T2-03 §6 cross-check: has an S2 (keychain-credential-recreated) or S3
 * (setup-token-invalid) page already fired recently? If so, THIS occurrence
 * is very likely the same root cause those sentinels already paged Jm about
 * — escalating again here would reproduce exactly the storm pattern the
 * July 401-storm remediation exists to prevent.
 *
 * Fails toward "not recently paged" (-> still escalate) on any read/parse
 * error or missing key. This is a deliberate asymmetry: the cost of a false
 * negative here is one redundant page (alert fatigue); the cost of a false
 * positive would be silently dropping the ONLY page for a genuine,
 * otherwise-unwatched auth outage. Mirrors the same "uncertainty resolves
 * toward acting on the real signal" convention as
 * bin/cron-health-monitor.ts's wasFailStreakPaged (T2-04).
 */
function rootCauseRecentlyPaged(alertGateStatePath: string, nowMs: number): boolean {
  try {
    const raw = JSON.parse(readFileSync(alertGateStatePath, 'utf-8')) as {
      keys?: Record<string, { lastSentAt?: string }>;
    };
    for (const key of ROOT_CAUSE_ALERT_KEYS) {
      const lastSentAt = raw.keys?.[key]?.lastSentAt;
      if (!lastSentAt) continue;
      const ts = new Date(lastSentAt).getTime();
      if (Number.isFinite(ts) && nowMs - ts < ROOT_CAUSE_CROSS_CHECK_WINDOW_MS) return true;
    }
    return false;
  } catch {
    return false; // missing/unreadable state -> can't confirm -> escalate anyway
  }
}

/**
 * T2-03: escalate a persistent authentication_failed streak to a page once
 * it crosses HEAL_ESCALATE_THRESHOLD within INTERACTIVE_AUTH_WINDOW_MS —
 * the residual gap this slice closes (see the doc comment on
 * INTERACTIVE_AUTH_STREAK_KEY above). Independent of the digest-cooldown
 * gate below (COOLDOWN_MS) — that gate is about how often notifyError()'s
 * ordinary digest-tier notice fires; this is a wholly separate page path
 * under its own AlertGate key, so it must run regardless of that cooldown's
 * state.
 */
/**
 * `sendAlertFn` is a test-only DI seam (mirrors trackHealStreak()'s own
 * convention) — production never passes it, so trackWindowedHealStreak()
 * always falls back to the real `sendAlert`. Exists so a hermetic test can
 * inject a sandboxed AlertGate and prove the 30-min cooldown (§5) is
 * actually threaded through, without ever reaching the real singleton's
 * defaultSend/Telegram path or relying on KAYA_ALERT_DRY_RUN (which
 * short-circuits AlertGate.send() BEFORE the cooldown check ever runs, so it
 * cannot exercise this behavior at all).
 */
async function maybeEscalateInteractiveAuthStreak(
  alertGateStatePath: string,
  sendAlertFn?: SendAlertFn,
  nowMs: number = Date.now(),
): Promise<FailStreakResult | undefined> {
  if (rootCauseRecentlyPaged(alertGateStatePath, nowMs)) {
    console.error(
      '[StopFailure] interactive-auth streak escalation skipped this occurrence — S2/S3 already paged this root cause recently',
    );
    return undefined;
  }

  const windowMinutes = INTERACTIVE_AUTH_WINDOW_MS / 60_000;
  const result = await trackWindowedHealStreak(
    INTERACTIVE_AUTH_STREAK_KEY,
    true,
    INTERACTIVE_AUTH_WINDOW_MS,
    (streak) =>
      `Kaya has hit 'authentication_failed' ${streak} times in the last ${windowMinutes} minutes across ` +
      `interactive/background sessions (session_id differs each time) — not a keychain-recreation event and ` +
      `not a cron-job auth incident (those page separately); a persistent auth failure needs investigation.`,
    INTERACTIVE_AUTH_ALERT_KEY,
    INTERACTIVE_AUTH_COOLDOWN_MS,
    sendAlertFn,
    nowMs,
  );
  if (result.action === 'paged') {
    console.error(`[StopFailure] interactive-auth streak escalated to page (streak=${result.streak})`);
  }
  return result;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const cooldownPath = kayaHomePath('MEMORY/MONITORING/stop-failure-cooldown.json');

  const rawInput = await readHookInput<Record<string, unknown>>({ timeoutMs: 500 });
  const rawStr = rawInput ? JSON.stringify(rawInput) : '';
  const payload = parsePayload(rawStr);

  if (!payload) {
    console.error('[StopFailure] Malformed or missing payload — exiting gracefully');
    process.exit(0);
  }

  const timestamp = new Date().toISOString();

  // Append to failure log via unified recordFailure (always — regardless of cooldown).
  // tier:'digest' for auth/billing outages so they surface in the daily health digest;
  // everything else is 'log' (forensic only, no alert).
  recordFailure({
    source: 'StopFailure',
    error: payload.error_details || payload.error,
    context: {
      session_id: payload.session_id,
      error_type: payload.error,
      cwd: payload.cwd,
      last_assistant_message: payload.last_assistant_message,
    },
    tier: (payload.error === 'authentication_failed' || payload.error === 'billing_error') ? 'digest' : 'log',
    alertKey: `stop-failure-${payload.error}`,
  });
  console.error(`[StopFailure] Logged failure: ${payload.error} (session: ${payload.session_id})`);

  // T2-03: class-level streak escalation for the residual authentication_failed
  // gap (see maybeEscalateInteractiveAuthStreak's doc). Deliberately BEFORE
  // and independent of the digest-cooldown check below.
  if (payload.error === 'authentication_failed') {
    await maybeEscalateInteractiveAuthStreak(kayaHomePath('MEMORY/State/alert-gate.json'));
  }

  // Check cooldown before sending notification
  const cooldownState = readCooldownState(cooldownPath);

  if (isOnCooldown(cooldownState, payload.error)) {
    console.error(`[StopFailure] Notification suppressed (cooldown active for: ${payload.error})`);
    process.exit(0);
  }

  // Send notification
  const priority = PRIORITY_MAP[payload.error];
  const message = payload.error_details
    ? `Session ${payload.session_id} stopped: ${payload.error} — ${payload.error_details}`
    : `Session ${payload.session_id} stopped: ${payload.error}`;

  await notifyError(message, {
    title: `Kaya — StopFailure: ${payload.error}`,
    priority,
    tags: ['warning', 'stop_sign'],
  });
  console.error(`[StopFailure] Notification sent for error type: ${payload.error}`);

  // Update cooldown state
  cooldownState[payload.error] = timestamp;
  writeCooldownState(cooldownPath, cooldownState);

  process.exit(0);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('[StopFailure] Fatal error:', error);
    process.exit(0);
  });
}

// Exported for hermetic unit tests only (T2-03) — mirrors the
// export-after-main() convention used by bin/cron-health-monitor.ts and
// lib/cron/FailStreak.ts. Does not affect the `import.meta.main` entry point.
export {
  maybeEscalateInteractiveAuthStreak,
  rootCauseRecentlyPaged,
  INTERACTIVE_AUTH_STREAK_KEY,
  INTERACTIVE_AUTH_ALERT_KEY,
  INTERACTIVE_AUTH_WINDOW_MS,
  INTERACTIVE_AUTH_COOLDOWN_MS,
  ROOT_CAUSE_ALERT_KEYS,
  ROOT_CAUSE_CROSS_CHECK_WINDOW_MS,
};
