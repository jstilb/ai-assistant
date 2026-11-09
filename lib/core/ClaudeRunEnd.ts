/**
 * ClaudeRunEnd.ts — how a headless `claude` run ended, and the ONE signature
 * table every CLI-text matcher in Kaya reads.
 *
 * Pure and imports NOTHING: a hook (load cost per tool call) and the separate
 * eval-lab repo import this file. Plan P02 §4; ADR 032.
 *
 * Three tiers (the `source` argument of `classifyText`) over one table:
 *   - `"machine"` — every row. For machine-authored text only.
 *   - `"log"`     — prose-safe rows + `logSafe` rows. For a program's own log
 *     text (cron's combined script stdout + stderr).
 *   - `"any"`     — prose-safe rows only. For any text, incl. agent output.
 * Row flags:
 *   - `proseSafe: true`  — whole-banner or errno wording that cannot appear in
 *     normal prose. Safe on any text, including an agent's own stdout.
 *   - `proseSafe: false` — short tokens (`429`, "timeout", "unauthorized") that
 *     are safe ONLY on machine-authored text: stderr, an API error message, a
 *     stream-json `subtype`, a caught exception. An agent's stdout is its own
 *     narrative ("the monthly report from the pool table"), so these rows never
 *     run on it.
 *   - `logSafe: true` (on a few `proseSafe: false` rows) — full error wording
 *     ("Timeout after 30000ms", "read ECONNRESET", "Invalid Credentials") that a
 *     program prints, not a bare word. Safe on a program's own log output (a
 *     cron script's stdout and stderr), where the bare tokens ("timeout", "401",
 *     "permission denied") are too common. The `"log"` source uses these rows.
 *
 * Patterns match machine text only (ruling (i) of
 * feedback_determinism_earns_its_place). Every row's `fixture` is a real
 * string the row exists for (harvested from MEMORY/daemon/cron/logs where one
 * was found) and must match its own `pattern` — ClaudeRunEnd.test.ts checks it.
 */

export type RunEnd = "ok" | "timeout" | "network" | "rate-limit" | "quota" | "auth" | "no-output" | "failed";
export type TextEnd = "timeout" | "network" | "rate-limit" | "quota" | "auth";

export interface Signature {
  end: TextEnd;
  pattern: RegExp;
  proseSafe: boolean;
  /** Error wording that is safe on program log text (see the file header). Only set on `proseSafe: false` rows. */
  logSafe?: true;
  fixture: string;
}

/**
 * The ONE signature table. Order is the classification order: the first row
 * that matches wins, and rows are grouped rate-limit → quota → auth →
 * network → timeout.
 */
export const RUN_END_SIGNATURES: readonly Signature[] = [
  // ── rate-limit ────────────────────────────────────────────────────────────
  {
    end: "rate-limit",
    pattern: /hit your (?:[a-z0-9-]+ )?limit/i,
    proseSafe: true,
    fixture: "You've hit your weekly limit · resets 7am (America/Los_Angeles)",
  },
  {
    // Per-model pool banner (2026-08-29, 31 cron log rows).
    end: "rate-limit",
    pattern: /reached your (?:[a-z0-9.-]+ ){0,3}limit/i,
    proseSafe: true,
    fixture: "You've reached your Fable 5 limit. Switch to another model, or manage usage credits at claude.ai/se",
  },
  {
    end: "rate-limit",
    pattern: /limit\b[^.\n]{0,40}resets/i,
    proseSafe: true,
    fixture: "You've hit your session limit · resets 2pm (America/Los_Angeles)",
  },
  { end: "rate-limit", pattern: /usage limit reached/i, proseSafe: true, fixture: "Claude AI usage limit reached|1760000000" },
  { end: "rate-limit", pattern: /rate_limit_error/i, proseSafe: true, fixture: '{"type":"error","error":{"type":"rate_limit_error"}}' },
  {
    // The CLI's text-mode banner lands on STDOUT (Verify, 2026-11-08: 380 stdoutTail rows in cron logs).
    end: "rate-limit",
    pattern: /API Error: 529\b/,
    proseSafe: true,
    fixture:
      "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.",
  },
  { end: "rate-limit", pattern: /overloaded_error/, proseSafe: true, fixture: '{"type":"error","error":{"type":"overloaded_error"}}' },
  { end: "rate-limit", pattern: /\b429\b/, proseSafe: false, fixture: "API Error: 429 Too Many Requests" },
  { end: "rate-limit", pattern: /too many requests/i, proseSafe: false, fixture: "HTTP error: too many requests" },
  { end: "rate-limit", pattern: /overloaded/i, proseSafe: false, fixture: "API Error: 529 Overloaded" },
  { end: "rate-limit", pattern: /rate limit/i, proseSafe: false, fixture: "rate limit reached" },
  // ── quota ─────────────────────────────────────────────────────────────────
  { end: "quota", pattern: /credit balance is too low/i, proseSafe: true, fixture: "exit 1: Credit balance is too low" },
  // ── auth ──────────────────────────────────────────────────────────────────
  {
    // 2026-07-15 401 auth storm (22 cron log rows).
    end: "auth",
    pattern: /Failed to authenticate/i,
    proseSafe: true,
    fixture: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
  },
  {
    end: "auth",
    pattern: /Invalid authentication credentials/i,
    proseSafe: true,
    fixture: '{"type":"authentication_error","message":"Invalid authentication credentials"}',
  },
  { end: "auth", pattern: /authentication_error/, proseSafe: true, fixture: '{"type":"error","error":{"type":"authentication_error"}}' },
  { end: "auth", pattern: /Not logged in\b.{0,5}Please run \/login/, proseSafe: true, fixture: "Not logged in · Please run /login" },
  { end: "auth", pattern: /invalid_grant/i, proseSafe: true, fixture: '{"error":"invalid_grant"}' },
  { end: "auth", pattern: /token has been expired/i, proseSafe: true, fixture: "Token has been expired or revoked." },
  { end: "auth", pattern: /invalid credentials/i, proseSafe: false, logSafe: true, fixture: "Error: Invalid Credentials" },
  { end: "auth", pattern: /\b401\b/, proseSafe: false, fixture: "Request failed with status code 401" },
  { end: "auth", pattern: /\b403\b/, proseSafe: false, fixture: "Request failed with status code 403" },
  { end: "auth", pattern: /unauthorized/i, proseSafe: false, fixture: "Unauthorized" },
  { end: "auth", pattern: /authentication/i, proseSafe: false, fixture: "authentication required" },
  { end: "auth", pattern: /invalid api key/i, proseSafe: false, fixture: "Invalid API key · Please run /login" },
  { end: "auth", pattern: /permission denied/i, proseSafe: false, fixture: "permission denied" },
  // ── network ───────────────────────────────────────────────────────────────
  {
    end: "network",
    pattern: /\b(?:ENOTFOUND|ECONNREFUSED|ENETUNREACH|EAI_AGAIN)\b/i,
    proseSafe: true,
    fixture: "Error: getaddrinfo ENOTFOUND api.anthropic.com",
  },
  {
    // Machine-only: agents write "fixed ECONNRESET handling" in their own stdout.
    end: "network",
    pattern: /\b(?:ECONNRESET|ETIMEDOUT|EPIPE)\b/i,
    proseSafe: false,
    logSafe: true,
    fixture: "Error: read ECONNRESET",
  },
  {
    // `.` tolerates straight/curly apostrophes.
    end: "network",
    pattern: /can.t reach the api server/i,
    proseSafe: true,
    fixture: "Error: Can't reach the API server. Please check your network connection.",
  },
  { end: "network", pattern: /socket.*closed/i, proseSafe: false, logSafe: true, fixture: "The socket connection was closed unexpectedly" },
  // ── timeout ───────────────────────────────────────────────────────────────
  { end: "timeout", pattern: /Timeout after \d+ms/i, proseSafe: false, logSafe: true, fixture: "Timeout after 30000ms" },
  { end: "timeout", pattern: /timeout|timed out/i, proseSafe: false, fixture: "request timed out" },
];

/**
 * Classify CLI text. `"machine"` uses the whole table; `"log"` uses the
 * prose-safe and log-safe rows (a program's own log output, e.g. a cron
 * script's stdout/stderr); `"any"` uses only the prose-safe rows (use it on an
 * agent's stdout or any text a model wrote). Returns null when no row matches.
 */
export function classifyText(text: string, source: "machine" | "log" | "any"): TextEnd | null {
  for (const sig of RUN_END_SIGNATURES) {
    if (source === "any" && !sig.proseSafe) continue;
    if (source === "log" && !sig.proseSafe && !sig.logSafe) continue;
    if (sig.pattern.test(text)) return sig.end;
  }
  return null;
}

export interface ExitFacts {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** Node errno from a spawn-level error (e.g. "ENOTFOUND"), when present. */
  errorCode?: string;
}

/** Spawn-level errno codes that mean the API was unreachable, not a task failure. */
const NETWORK_ERRNO = new Set(["ENOTFOUND", "ECONNREFUSED", "ENETUNREACH", "EAI_AGAIN"]);

/**
 * How a run ended. Precedence: ok (exit 0, not timed out) → timeout (caller's
 * flag) → network (errno) → stderr under the machine tier → stdout under the
 * prose-safe tier → no-output (both blank) → failed.
 */
export function classifyRunEnd(f: ExitFacts): RunEnd {
  if (f.exitCode === 0 && !f.timedOut) return "ok";
  if (f.timedOut) return "timeout";
  if (f.errorCode !== undefined && NETWORK_ERRNO.has(f.errorCode)) return "network";
  const fromStderr = classifyText(f.stderr, "machine");
  if (fromStderr) return fromStderr;
  const fromStdout = classifyText(f.stdout, "any");
  if (fromStdout) return fromStdout;
  if (f.stdout.trim() === "" && f.stderr.trim() === "") return "no-output";
  return "failed";
}

/** True when the text carries a usage-limit or credit banner (prose-safe tier only). */
export function isLimitText(text: string): boolean {
  const end = classifyText(text, "any");
  return end === "rate-limit" || end === "quota";
}

/**
 * The reset time from a limit banner ("… · resets 11:50pm (America/Los_Angeles)"
 * → "11:50pm"). Null when the text names no reset.
 */
export function extractResetInfo(text: string): string | null {
  const match = text.match(/resets\s+(.+?)(?:\s*\(|$)/i);
  return match?.[1]?.trim() ?? null;
}
