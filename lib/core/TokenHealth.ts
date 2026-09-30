/**
 * TokenHealth — generalized proactive + reactive Google OAuth token health (S7 / B3).
 *
 * WHY: Google OAuth token expiry silently breaks jobs (2026-07-01: LifeOS
 * Sheets export died mid-run with "Invalid Credentials"). The existing check
 * (OAuthHealthCheck.ts) is REACTIVE ONLY — it detects failure after an API
 * call fails — and each Google surface (Sheets, Calendar, YouTube) duplicates
 * its own stderr-substring classifier. This module adds a PROACTIVE check
 * (read `expiry_date` out of the token JSON directly, no network call) and
 * centralizes the reactive stderr classifier so every surface shares it.
 *
 * Token files: `~/.config/google/{sheets,calendar,youtube}-token.json`,
 * shape `{ access_token, refresh_token, token_type, expiry_date }` (ms epoch).
 * Gmail (`gog`) manages its own credential store outside `~/.config/google/`;
 * its location isn't reliably discoverable from here, so gmail reports
 * `missing`/`unknown` honestly rather than guessing a path.
 *
 * KEY NUANCE (the actual steady state, confirmed against live tokens):
 * Google access tokens are short-lived by design (~1h) and googleapis
 * auto-refreshes `access_token` using `refresh_token` transparently,
 * persisting the new pair via the library's 'tokens' event (see
 * skills/Development/UnixCLI/Tools/Sheets.ts getAuthClient()). That means
 * `expiry_date` is essentially meaningless as a health signal WHENEVER a
 * refresh_token is present — a healthy, steady-state token sits minutes to
 * an hour from "expiry" at all times. Grading that `expiring_soon`/`expired`
 * was the S7 bug: it paged on every single run against real tokens (see
 * git history — classifyExpiry v1 flagged the live sheets-token.json, which
 * has a valid refresh_token, as `expiring_soon` at 0.8h remaining).
 *
 * So: `expiry_date` is only meaningful when there is NO refresh_token — that
 * is the one case where an access token actually can't renew itself and a
 * past/near expiry is real signal. With a refresh_token present, the token
 * is `healthy` by definition (barring the refresh_token itself being dead,
 * which only a REACTIVE probe can detect — see classifyReactiveFailure()).
 * See classifyExpiry() for the pure decision table.
 */

import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { recordFailure } from './FailureLog.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GoogleService = 'sheets' | 'calendar' | 'youtube' | 'gmail';
export type TokenStatus = 'healthy' | 'expiring_soon' | 'expired' | 'missing' | 'unknown';

export interface TokenHealthResult {
  service: GoogleService;
  status: TokenStatus;
  expiresInHrs?: number;
  detail: string;
}

export interface ReactiveProbeResult {
  ok: boolean;
  stderr?: string;
}

export interface CheckTokenHealthDeps {
  /** Absolute path to the token JSON file. Defaults to the well-known per-service path. */
  tokenPath?: string;
  /** Injectable clock (ms epoch). Defaults to Date.now. */
  now?: () => number;
  /** Run the reactive (live) probe after the proactive date check. Default false — proactive only. */
  runReactive?: boolean;
  /** Injectable reactive probe — defaults to a live `kaya-cli sheets list` call for sheets, no-op elsewhere. */
  reactiveProbe?: (service: GoogleService) => Promise<ReactiveProbeResult>;
  /** Bridge expired/expiring_soon results to AlertGate via recordFailure(). Default false (caller opts in). */
  bridgeToAlertGate?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Well-known token paths
// ---------------------------------------------------------------------------

// Only these two surfaces persist a googleapis-shaped token JSON under
// ~/.config/google/*-token.json:
//   - sheets:  skills/Development/UnixCLI/Tools/Sheets.ts getAuthClient()
//   - youtube: lib/core/youtube-auth.ts
// calendar uses `gcalcli` (its own oauth cache) and gmail uses `gog`
// (Application Support store) — neither ever writes a file at the
// ~/.config/google/{calendar,gmail}-token.json path this module would look
// for by default, so its ABSENCE there is expected, not a failure. See
// checkTokenHealth(): those two surfaces short-circuit to `unknown` when no
// explicit tokenPath override is supplied, instead of `missing`.
const SERVICES_WITH_FILE_TOKEN: ReadonlySet<GoogleService> = new Set(['sheets', 'youtube']);

function defaultTokenPath(service: GoogleService): string {
  return join(homedir(), '.config', 'google', `${service}-token.json`);
}

// ---------------------------------------------------------------------------
// classifyExpiry — pure, testable decision table
// ---------------------------------------------------------------------------

export interface ClassifyExpiryResult {
  status: Exclude<TokenStatus, 'missing'>;
  expiresInHrs?: number;
}

/**
 * Pure classification of a token's expiry state. No I/O.
 *
 * Decision table:
 * - `expiryDateMs` undefined → `unknown` (can't reason about a token with no
 *   expiry field at all — most likely damaged/foreign JSON, not our schema).
 * - `hasRefreshToken` true → `healthy`, ALWAYS, regardless of access-token
 *   expiry. googleapis auto-refreshes transparently; a Google access token
 *   sitting minutes from "expiry" with a live refresh_token is the normal,
 *   steady, healthy state — not a warning. `expiresInHrs` is still returned
 *   for info/debugging, it just doesn't drive status. (A revoked/dead
 *   refresh_token is a REACTIVE-only signal — see classifyReactiveFailure()
 *   and the reactive-probe override in checkTokenHealth().)
 * - `hasRefreshToken` false + past expiry → `expired` (hard failure: no
 *   refresh path exists, nothing will fix this automatically).
 * - `hasRefreshToken` false + < 24h until expiry → `expiring_soon` (includes
 *   the exact 24h boundary — err on the side of an earlier warning).
 * - `hasRefreshToken` false + ≥ 24h until expiry → `healthy`.
 */
export function classifyExpiry(
  expiryDateMs: number | undefined,
  hasRefreshToken: boolean,
  nowMs: number,
): ClassifyExpiryResult {
  if (expiryDateMs === undefined || Number.isNaN(expiryDateMs)) {
    return { status: 'unknown' };
  }

  const msRemaining = expiryDateMs - nowMs;
  const hrsRemaining = msRemaining / (60 * 60 * 1000);

  if (hasRefreshToken) {
    // Auto-refresh handles it — access-token expiry is not a health signal.
    return { status: 'healthy', expiresInHrs: hrsRemaining };
  }

  if (msRemaining <= 0) {
    return { status: 'expired', expiresInHrs: hrsRemaining };
  }

  if (msRemaining <= DAY_MS) {
    return { status: 'expiring_soon', expiresInHrs: hrsRemaining };
  }

  return { status: 'healthy', expiresInHrs: hrsRemaining };
}

// ---------------------------------------------------------------------------
// classifyReactiveFailure — shared stderr-substring classifier
// ---------------------------------------------------------------------------

/**
 * True when stderr/error text indicates an expired/invalid OAuth credential
 * (as opposed to a network blip, rate limit, or unrelated API error).
 * Centralizes the substring checks previously duplicated across
 * OAuthHealthCheck.ts (sheets) and the CalendarAssistant reactive probe,
 * which was folded into this shared classifier during the calassist
 * overhaul and no longer exists as a standalone file.
 */
export function classifyReactiveFailure(text: string | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    text.includes('Invalid Credentials') ||
    lower.includes('invalid_grant') ||
    lower.includes('token has been expired') ||
    lower.includes('401') ||
    lower.includes('403')
  );
}

// ---------------------------------------------------------------------------
// Default reactive probes (live — only invoked when runReactive is true and
// no probe is injected; tests always inject).
// ---------------------------------------------------------------------------

const KAYA_CLI = '~/.claude/bin/kaya-cli';

async function defaultReactiveProbe(service: GoogleService): Promise<ReactiveProbeResult> {
  if (service !== 'sheets') {
    // Only Sheets has a wired live probe today (kaya-cli sheets list).
    // Calendar/YouTube/Gmail proactive-only until their own CLIs are wired.
    return { ok: true };
  }
  try {
    execSync(`${KAYA_CLI} sheets list --limit 1`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    return { ok: true };
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer | string };
    return { ok: false, stderr: e.stderr ? e.stderr.toString() : String(err) };
  }
}

// ---------------------------------------------------------------------------
// checkTokenHealth
// ---------------------------------------------------------------------------

const REMEDIATION_POINTER =
  'Re-auth with: bun ~/.claude/skills/Development/UnixCLI/Tools/reauth-sheets.ts (Sheets) ' +
  'or bun ~/.claude/lib/core/youtube-auth.ts (YouTube).';

export async function checkTokenHealth(
  service: GoogleService,
  deps: CheckTokenHealthDeps = {},
): Promise<TokenHealthResult> {
  const now = deps.now ?? Date.now;
  const usingDefaultPath = deps.tokenPath === undefined;
  const tokenPath = deps.tokenPath ?? defaultTokenPath(service);

  let result: TokenHealthResult;

  if (!existsSync(tokenPath)) {
    if (usingDefaultPath && !SERVICES_WITH_FILE_TOKEN.has(service)) {
      // calendar (gcalcli) and gmail (gog) never write a token to this path —
      // its absence is expected, not a failure. `unknown` (not `missing`)
      // so sweeps/OAuthHealthCheck don't page on a permanent non-signal.
      // The reactive probe below (if wired for this service) still gets a
      // chance to catch a genuine credential failure.
      result = {
        service,
        status: 'unknown',
        detail: `${service} does not persist a token at ${tokenPath} (uses its own credential store) — proactive check is not applicable for this surface.`,
      };
    } else {
      result = { service, status: 'missing', detail: `Token file not found at ${tokenPath}. ${REMEDIATION_POINTER}` };
    }
  } else {
    let parsed: { access_token?: string; refresh_token?: string; expiry_date?: number };
    try {
      parsed = JSON.parse(readFileSync(tokenPath, 'utf-8'));
    } catch (err) {
      result = {
        service,
        status: 'unknown',
        detail: `Token file at ${tokenPath} is not valid JSON: ${(err as Error).message}`,
      };
      return finalize(result, deps);
    }

    const hasRefreshToken = typeof parsed.refresh_token === 'string' && parsed.refresh_token.length > 0;
    const classified = classifyExpiry(parsed.expiry_date, hasRefreshToken, now());

    result = {
      service,
      status: classified.status,
      expiresInHrs: classified.expiresInHrs,
      detail: describeStatus(classified.status, tokenPath, classified.expiresInHrs),
    };
  }

  if (deps.runReactive) {
    const probe = deps.reactiveProbe ?? defaultReactiveProbe;
    const probeResult = await probe(service);
    if (!probeResult.ok && classifyReactiveFailure(probeResult.stderr)) {
      // Live probe caught a credential failure the date-based check may have
      // missed (e.g. refresh_token present but actually revoked server-side).
      result = {
        service,
        status: 'expired',
        detail: `Live probe failed with a credential error: ${(probeResult.stderr ?? '').slice(0, 200)}. ${REMEDIATION_POINTER}`,
      };
    }
  }

  return finalize(result, deps);
}

function describeStatus(status: TokenStatus, tokenPath: string, expiresInHrs?: number): string {
  switch (status) {
    case 'healthy':
      return `Token at ${tokenPath} is healthy (expires in ${expiresInHrs?.toFixed(1)}h).`;
    case 'expiring_soon':
      return `Token at ${tokenPath} expires soon (${expiresInHrs?.toFixed(1)}h remaining). ${REMEDIATION_POINTER}`;
    case 'expired':
      return `Token at ${tokenPath} is expired with no live refresh_token. ${REMEDIATION_POINTER}`;
    case 'unknown':
      return `Token at ${tokenPath} has no readable expiry_date — status unknown.`;
    default:
      return `Token at ${tokenPath}: ${status}.`;
  }
}

function finalize(result: TokenHealthResult, deps: CheckTokenHealthDeps): TokenHealthResult {
  if (deps.bridgeToAlertGate) bridgeToAlertGate(result);
  return result;
}

// ---------------------------------------------------------------------------
// AlertGate bridge
// ---------------------------------------------------------------------------

function bridgeToAlertGate(result: TokenHealthResult): void {
  if (result.status === 'expired') {
    recordFailure({
      source: `TokenHealth:${result.service}`,
      error: result.detail,
      context: { service: result.service, status: result.status },
      tier: 'page',
      alertKey: `token-health-${result.service}`,
      alertMessage: `🔑 ${result.service} OAuth token expired — ${REMEDIATION_POINTER}`,
      fingerprint: `token-health-${result.service}:expired`,
    });
  } else if (result.status === 'expiring_soon') {
    recordFailure({
      source: `TokenHealth:${result.service}`,
      error: result.detail,
      context: { service: result.service, status: result.status, expiresInHrs: result.expiresInHrs },
      tier: 'digest',
      alertKey: `token-health-${result.service}`,
      alertMessage: `⚠️ ${result.service} OAuth token expiring soon (${result.expiresInHrs?.toFixed(1)}h) — ${REMEDIATION_POINTER}`,
      fingerprint: `token-health-${result.service}:expiring_soon`,
    });
  }
  // healthy / missing / unknown: no alert bridge. 'missing' and 'unknown' are
  // configuration/observability gaps rather than actionable credential
  // failures — sweepAllTokens() surfaces them in its summary for a human to
  // read, without paging.
}

// ---------------------------------------------------------------------------
// sweepAllTokens
// ---------------------------------------------------------------------------

export interface SweepAllTokensDeps {
  tokenPaths?: Partial<Record<GoogleService, string>>;
  now?: () => number;
  runReactive?: boolean;
  reactiveProbe?: (service: GoogleService) => Promise<ReactiveProbeResult>;
  bridgeToAlertGate?: boolean;
}

export interface SweepAllTokensSummary {
  ts: string;
  results: TokenHealthResult[];
  overallOk: boolean;
  anyExpired: boolean;
  anyExpiringSoon: boolean;
}

const ALL_SERVICES: GoogleService[] = ['sheets', 'calendar', 'youtube', 'gmail'];

export async function sweepAllTokens(deps: SweepAllTokensDeps = {}): Promise<SweepAllTokensSummary> {
  const results: TokenHealthResult[] = [];
  for (const service of ALL_SERVICES) {
    const result = await checkTokenHealth(service, {
      tokenPath: deps.tokenPaths?.[service],
      now: deps.now,
      runReactive: deps.runReactive,
      reactiveProbe: deps.reactiveProbe,
      bridgeToAlertGate: deps.bridgeToAlertGate,
    });
    results.push(result);
  }

  const anyExpired = results.some((r) => r.status === 'expired');
  const anyExpiringSoon = results.some((r) => r.status === 'expiring_soon');
  const overallOk = results.every((r) => r.status === 'healthy' || r.status === 'missing' || r.status === 'unknown');

  return {
    ts: new Date((deps.now ?? Date.now)()).toISOString(),
    results,
    overallOk,
    anyExpired,
    anyExpiringSoon,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  sweepAllTokens({ runReactive: true, bridgeToAlertGate: true }).then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.anyExpired ? 1 : 0);
  }).catch((err) => {
    console.error(`[TokenHealth] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
