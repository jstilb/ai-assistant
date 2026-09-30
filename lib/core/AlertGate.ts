#!/usr/bin/env bun
/**
 * AlertGate — central policy gate for outbound alert notifications.
 *
 * WHY: Every alert sender (GrillNudge, ApprovalNudge, spec-pipeline
 * escalations, AW failure events) was inventing its own throttling policy —
 * or none, which produced level-triggered Telegram nagging (the 2026-06-12
 * alert-fatigue incident). This module owns the policy so senders don't.
 *
 * MODEL — three tiers:
 *   page   → immediate send through NotificationService, but edge-triggered:
 *            at most once per cooldown per key, and (when a fingerprint is
 *            given) only when content actually changed since the last page —
 *            EXCEPT that an unchanged fingerprint suppresses only up to
 *            fingerprintTtlMs (default 7 days), after which a still-live
 *            condition re-pages. Suppressed pages degrade into digest-spool
 *            entries — throttling never silently drops an alert.
 *   digest → appended to MEMORY/NOTIFICATIONS/digest-spool.jsonl, delivered
 *            once daily by SystemHealthDigest. The default tier.
 *   log    → spooled with tier 'log'; the digest reports these only as counts.
 *
 * Dry-run: set KAYA_ALERT_DRY_RUN=1 to make every send() a no-op that returns
 * 'dry-run' (no network, no state stamp). Use this in hardening/test sessions
 * so live chats never receive throwaway alerts.
 *
 * Senders with their own delivery mechanism (e.g. inline-keyboard nudges) use
 * the gate-only API: shouldPage(key, opts) + recordPaged(key, fingerprint?).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { getKayaHome, defaultKayaHome, assertNotLiveHomeUnderTest } from './KayaHome.ts';
import { createAppendLog } from './AppendLog.ts';
import { loadSettings } from './ConfigLoader.ts';

export type AlertTier = 'page' | 'digest' | 'log';
export type AlertResult = 'paged' | 'spooled' | 'logged' | 'suppressed' | 'dry-run';

// ============================================================================
// Test/tmp-path leak guard
// ============================================================================
//
// WHY: On 2026-07-01/07-02, test-fixture OAuth token alerts (mkdtemp dirs
// like `/var/folders/.../oauth-fixtures-<rand>/token-....json`, agent
// scratchpad paths like `/private/tmp/claude-501/.../scratchpad/broken-fixture/
// sheets-token.json`) leaked into the LIVE notifications.jsonl, failure-log.jsonl,
// AND alert-gate.json/digest-spool.jsonl. Root cause: ad-hoc/uncommitted
// verification scripts (built from the same mkdtemp fixture idiom as the
// checked-in TokenHealth/OAuthHealthCheck tests, but run outside the bun:test
// harness so the tests' own KAYA_HOME + KAYA_ALERT_DRY_RUN beforeEach hooks
// never fired) called sweepAllTokens()/checkTokenHealth() against live state.
// This is a RECURRING class of mistake (confirmed leaking again on 07-02,
// hours after this investigation began), not a one-off — so the fix belongs
// here, in the gate every AlertGate-routed sender passes through, rather than
// in any single caller.
//
// This is a heuristic, best-effort content filter — NOT a substitute for
// callers setting KAYA_ALERT_DRY_RUN=1 in tests. It exists to fail SAFE when
// they forget.

const SUSPECT_PATH_MARKERS: readonly string[] = [
  '/var/folders/',   // macOS os.tmpdir()/mkdtempSync default root
  '/private/tmp/',   // Claude agent session scratchpad root (see scratchpad convention)
  '/tmp/',           // POSIX tmpdir root (Linux os.tmpdir(), and macOS's /tmp symlink)
  'oauth-fixtures',  // TokenHealth/OAuthHealthCheck.test.ts mkdtemp fixture prefix
  'scratchpad',      // agent session scratchpad convention (any OS)
  'mktemp',          // literal mktemp invocations/paths some scripts embed in messages
];

/**
 * Returns the first test/tmp-path marker found in `text`, or null if none.
 * Exported so other raw (non-AlertGate) notification writers — e.g.
 * OAuthHealthCheck.ts's direct notifications.jsonl append — can reuse the
 * same policy at their own seam.
 */
export function findSuspectPath(text: string): string | null {
  for (const marker of SUSPECT_PATH_MARKERS) {
    if (text.includes(marker)) return marker;
  }
  return null;
}

/**
 * True when a page-tier send should be refused because it's on the REAL
 * (unsandboxed) delivery path — no custom `send` was injected into this
 * AlertGate, i.e. it would actually call NotificationService/Telegram — AND
 * KAYA_HOME points away from the production default (see defaultKayaHome()'s
 * doc: every launchd cron plist sets KAYA_HOME=<repo root>, which equals the
 * default and is NOT a meaningful override — only a genuine deviation, e.g. a
 * test/sandbox tmpdir, counts).
 *
 * Deliberately excludes gates with an injected `send` (the norm across this
 * repo's test suite, e.g. AlertGate.test.ts's makeGate()) — those can never
 * reach the network regardless of KAYA_HOME, so guarding them would only
 * produce false-positive suppressions in otherwise-correct hermetic tests
 * (this exact regression was caught against IntakeRunner.test.ts).
 *
 * Exported as a pure function, independent of any real AlertGate instance,
 * so its exact decision table is unit-testable without ever constructing a
 * network-capable gate.
 */
export function isSandboxedSendContext(usesDefaultSend: boolean): boolean {
  return usesDefaultSend && getKayaHome() !== defaultKayaHome();
}

export interface SendAlertOptions {
  /** Stable identifier for this alert class (e.g. 'grill-nudge', 'spec-escalation-<id>'). */
  key: string;
  /** Routing tier. Default: 'digest'. */
  tier?: AlertTier;
  /** Channel for page-tier sends. Default: 'telegram'. */
  channel?: string;
  /** Minimum interval between pages for this key. Default: 24h. */
  cooldownMs?: number;
  /** Content fingerprint — page only when it differs from the last paged value. */
  fingerprint?: string;
  /**
   * How long an UNCHANGED fingerprint keeps suppressing after the cooldown
   * has already elapsed. Default: 7 days (DEFAULT_FINGERPRINT_TTL_MS).
   *
   * WHY a TTL exists at all: fingerprint suppression used to be unbounded —
   * a static fingerprint (e.g. the executor's 'credit-pool-paused') paged
   * once and then NEVER again, so the Aug 18-24 executor failures were
   * silently swallowed against a page last sent 07-09. A still-live
   * condition must eventually re-page; the effective refire interval for
   * unchanged content is max(cooldownMs, fingerprintTtlMs). Callers whose
   * condition warrants faster refire (persistent infra outages) pass a
   * smaller value — e.g. 24h; a value <= cooldownMs makes the fingerprint
   * a pure no-op (suppression is then cooldown-only).
   */
  fingerprintTtlMs?: number;
  /**
   * Explicit override: confirms this alert is legitimate production traffic
   * even though it looks like test/tmp-fixture noise (message references a
   * path under `findSuspectPath()`'s markers, or KAYA_HOME is pointed away
   * from the production default while attempting a real page-tier send).
   * Default false — the safe default is to suppress and log loudly rather
   * than silently deliver what is very likely test noise. See
   * `findSuspectPath()` for the heuristic.
   */
  allowSuspectContext?: boolean;
  /**
   * Marks this alert as urgent enough to page THROUGH quiet hours (see
   * QuietHoursConfig). Honoured only when
   * settings.notifications.quietHours.allowCriticalOverride is true.
   *
   * Default false, and as of 2026-07-31 NO caller sets it — the deliberate
   * starting position is that nothing in this system is worth waking Jm at
   * 3am, and anything that turns out to be gets opted in explicitly with a
   * reason. Every other page is simply deferred to the morning digest, not
   * dropped.
   */
  critical?: boolean;
}

export interface SpoolEntry {
  timestamp: string;
  key: string;
  tier: AlertTier;
  message: string;
}

interface KeyState {
  lastSentAt: string;
  fingerprint?: string;
}

interface GateState {
  version: 1;
  keys: Record<string, KeyState>;
}

export interface AlertGateOptions {
  statePath?: string;
  spoolPath?: string;
  /**
   * Path for the digest-spool archive (B6, S4d) — where consumeSpool()
   * appends every entry it consumes, verbatim, before wiping the live
   * spool. Same override convention as statePath/spoolPath: tests pass an
   * explicit path so they never touch getKayaHome().
   */
  archivePath?: string;
  /**
   * Delivery function for page-tier sends. Default: NotificationService
   * notify(). Resolves `true` iff delivery was confirmed (a channel accepted
   * the message), `false` iff every retry+fallback attempt failed — send()'s
   * page-tier branch only stamps the cooldown on `true` (T2-01).
   */
  send?: (message: string, channel: string) => Promise<boolean>;
  /** Injectable clock for tests. */
  now?: () => number;
  /**
   * Explicit quiet-hours policy, bypassing settings.json. Tests pass this so
   * the decision never depends on the machine's real clock or on Jm's live
   * settings; production leaves it unset.
   */
  quietHours?: QuietHoursConfig;
}

const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/**
 * Default TTL on unchanged-fingerprint suppression (see
 * SendAlertOptions.fingerprintTtlMs). 7 days balances the two failure modes
 * this gate has actually produced: level-triggered nagging (the 2026-06-12
 * alert-fatigue incident — why fingerprints dedup at all) vs. the 2026-08
 * executor silence (a static fingerprint suppressing FOREVER, so six days of
 * genuine failures never reached Jm). A stuck-unchanged condition now re-pages
 * weekly at worst by default; callers tune per alert class.
 */
export const DEFAULT_FINGERPRINT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ============================================================================
// Quiet hours (2026-07-31)
// ============================================================================
//
// WHY THIS IS NEW CODE and not a revived setting: quiet hours were previously
// a documented no-op. lib/cron/RouteOutput.ts's header records the autopsy —
// `settings.daemon?.quietHours` "is not set anywhere in settings.json —
// confirmed by grep — so the quiet-hours downgrade was always a no-op", and
// the MessageQueue layer that nominally owned it was deleted in the S11
// messaging collapse (ADR-019) in favour of calling AlertGate directly.
// AlertGate itself never had a time-of-day concept at all.
//
// The gap was measurable: of 117 page-tier Telegram sends in the 14 days to
// 2026-07-31, 35 (30%) landed between 22:00 and 07:00 local — including a
// "🌙 Overnight: 1 job slept through 1 run" notice at 02:20 AM about a
// condition the reconciler fixes by itself.
//
// Behaviour: during the window a page is demoted to the digest tier — spooled,
// visible in the morning SystemHealthDigest, and NOT stamped against the
// cooldown, so a still-live condition can page properly once the window ends.
// Nothing is dropped.
export interface QuietHoursConfig {
  enabled: boolean;
  /** Local hour the window opens, inclusive (0-23). */
  startHour: number;
  /** Local hour the window closes, exclusive (0-23). */
  endHour: number;
  /** IANA zone the hours are expressed in. */
  timeZone: string;
  /** When true, sends passing `critical: true` page through the window. */
  allowCriticalOverride: boolean;
}

export const DEFAULT_QUIET_HOURS: QuietHoursConfig = {
  enabled: true,
  startHour: 22,
  endHour: 7,
  timeZone: 'America/Los_Angeles',
  // Mirrors settings.notifications.callGuard.allowCriticalOverride's vocabulary.
  allowCriticalOverride: true,
};

/**
 * Local hour (0-23) for an epoch ms in the given IANA zone. Uses Intl rather
 * than arithmetic on a UTC offset so DST transitions are handled by the
 * platform — a fixed -7 would silently shift the window by an hour for four
 * months of the year.
 */
export function localHourIn(nowMs: number, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false,
  }).format(new Date(nowMs));
  // 'en-US' hour12:false renders midnight as '24' on some ICU versions.
  return Number(hour) % 24;
}

/**
 * Is `nowMs` inside the quiet window? Pure and exported so the decision table
 * — especially the midnight wrap, which is the whole point of a 22->07 window
 * — is unit-testable without constructing a gate.
 */
export function isWithinQuietHours(nowMs: number, cfg: QuietHoursConfig): boolean {
  if (!cfg.enabled) return false;
  if (cfg.startHour === cfg.endHour) return false; // degenerate: never quiet
  const hour = localHourIn(nowMs, cfg.timeZone);
  return cfg.startHour < cfg.endHour
    ? hour >= cfg.startHour && hour < cfg.endHour // same-day window (e.g. 1->5)
    : hour >= cfg.startHour || hour < cfg.endHour; // wraps midnight (e.g. 22->7)
}

/**
 * Merge settings.notifications.quietHours over the defaults. Unset/partial
 * config is normal — every field falls back individually, and a malformed
 * block degrades to the defaults rather than throwing on the alert path.
 */
export function resolveQuietHours(settings: unknown): QuietHoursConfig {
  const raw = (settings as { notifications?: { quietHours?: Partial<QuietHoursConfig> } } | null)
    ?.notifications?.quietHours;
  if (!raw || typeof raw !== 'object') return DEFAULT_QUIET_HOURS;
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 23 ? v : fallback;
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_QUIET_HOURS.enabled,
    startHour: num(raw.startHour, DEFAULT_QUIET_HOURS.startHour),
    endHour: num(raw.endHour, DEFAULT_QUIET_HOURS.endHour),
    timeZone: typeof raw.timeZone === 'string' && raw.timeZone ? raw.timeZone : DEFAULT_QUIET_HOURS.timeZone,
    allowCriticalOverride:
      typeof raw.allowCriticalOverride === 'boolean'
        ? raw.allowCriticalOverride
        : DEFAULT_QUIET_HOURS.allowCriticalOverride,
  };
}

// ============================================================================
// State TTL — keeps alert-gate.json from accumulating garbage keys forever.
// ============================================================================
//
// WHY: alert-gate.json had no expiry, so every one-off/renamed key (e.g. the
// 2026-07 page-storm's 93 `incident:<hash>` keys, made obsolete when the
// monitor collapsed onto a single `cron-health` key) stuck around forever —
// 99/120 keys in the live file were dead. Mirrors cron-health-monitor.ts's
// PRUNE_OLDER_THAN_MS convention (90 days) so both state files age out on the
// same policy.
const STATE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/**
 * Drops keys whose lastSentAt is older than STATE_TTL_MS, in place.
 *
 * lastSentAt is the only timestamp KeyState carries (stamped as an ISO
 * string by recordPaged()) — there is no secondary field to fall back on.
 * When it's missing or unparseable (hand-edited state, or a future format
 * change), age is unknown rather than zero, so per this repo's
 * partial-observability default (unknown is not evidence of staleness) the
 * key is KEPT, not pruned. A key being pruned always means we positively
 * know it's stale, never that we failed to determine its age.
 *
 * Runs at the top of saveState() — the single state-write path — so pruning
 * can never be skipped by forgetting to call a separate maintenance step.
 */
function pruneStaleKeys(state: GateState, nowMs: number): void {
  const cutoff = nowMs - STATE_TTL_MS;
  for (const [key, keyState] of Object.entries(state.keys)) {
    const lastSentMs = new Date(keyState.lastSentAt).getTime();
    if (Number.isNaN(lastSentMs)) continue; // unknown age — keep
    if (lastSentMs < cutoff) delete state.keys[key];
  }
}

// T2-01: switched from notifySync() (fire-and-forget, no result) to notify()
// (Promise<boolean> — true iff a channel accepted the message, false iff every
// retry+fallback attempt failed). send()'s page-tier branch awaits this and
// only stamps the cooldown on a CONFIRMED delivery — see send() below.
async function defaultSend(message: string, channel: string): Promise<boolean> {
  // Lazy import keeps AlertGate loadable in contexts where NotificationService
  // (and its CallDetector dependency tree) is unwanted, e.g. lightweight tests.
  try {
    const { notify } = await import('./NotificationService.ts');
    return await notify(message, { channel: channel as never });
  } catch {
    return false; // never throw past this boundary — send()'s own contract
  }
}

export class AlertGate {
  /**
   * Explicit overrides, when given, always win and never change (tests pass
   * these — see makeGate() in AlertGate.test.ts). When NOT given, the path is
   * resolved lazily — via the statePath/spoolPath getters below — on every
   * access, rather than once in the constructor.
   *
   * WHY lazy: `getAlertGate()` returns a module-level singleton (see bottom
   * of this file) that lives for the lifetime of the process — including the
   * whole `bun test` process, which runs many test files' worth of
   * beforeEach/afterEach KAYA_HOME churn. Freezing `getKayaHome()`'s result
   * once, at whichever moment the singleton happened to be first constructed,
   * meant every later send() kept writing to that ONE frozen path forever —
   * regardless of which test's KAYA_HOME sandbox was active by then. That is
   * the root cause behind FailureLog.test.ts's 'MyPipeline'/'Alerter'/
   * 'custom-key' fixtures (and TokenHealth/OAuthHealthCheck's
   * 'token-health-*' fixtures) leaking into the LIVE digest-spool.jsonl on
   * 2026-07-02 (S1.9 iteration-2). Resolving fresh on every access means a
   * send() always targets whatever KAYA_HOME is ACTIVE right now — paired
   * with FailureLog.ts's direct synchronous getAlertGate().send() call (A1;
   * no more fire-and-forget bridge to race a test's own afterEach teardown)
   * and this file's own assertNotLiveHomeUnderTest() tripwire in saveState()/
   * spool() (A1), this closes the leak at every layer: the singleton no
   * longer remembers a stale path, there is no async bridge left to race, and
   * an unpinned test hitting the real (non-overridden) write path under
   * NODE_ENV=test throws instead of silently writing live state.
   */
  private readonly statePathOverride?: string;
  private readonly spoolPathOverride?: string;
  private readonly archivePathOverride?: string;
  private readonly sendFn: (message: string, channel: string) => Promise<boolean>;
  private readonly now: () => number;
  /**
   * True only when the caller did NOT inject a `send` function, i.e. this
   * gate's page-tier delivery is the REAL NotificationService/Telegram path.
   * Every hermetic test in this repo (see makeGate() in AlertGate.test.ts,
   * and the many other test files that construct AlertGate directly) injects
   * its own recording `send` stub — those gates can never reach the network
   * regardless of KAYA_HOME, so the KAYA_HOME-mismatch guard below must not
   * apply to them. It exists specifically for `getAlertGate()`'s default
   * singleton (used by `sendAlert()` and FailureLog's AlertGate bridge),
   * which IS the real send path.
   */
  private readonly usesDefaultSend: boolean;
  private readonly quietHoursOverride?: QuietHoursConfig;

  constructor(options: AlertGateOptions = {}) {
    this.statePathOverride = options.statePath;
    this.spoolPathOverride = options.spoolPath;
    this.archivePathOverride = options.archivePath;
    this.sendFn = options.send ?? defaultSend;
    this.usesDefaultSend = options.send === undefined;
    this.now = options.now ?? Date.now;
    this.quietHoursOverride = options.quietHours;
  }

  /**
   * Resolved quiet-hours policy. Read per access (not cached in the
   * constructor) for the same reason statePath/spoolPath are — a long-lived
   * singleton must pick up a settings edit without a restart. A settings read
   * failure degrades to DEFAULT_QUIET_HOURS: the alert path must never throw
   * because config is malformed.
   */
  private get quietHours(): QuietHoursConfig {
    if (this.quietHoursOverride) return this.quietHoursOverride;
    try {
      return resolveQuietHours(loadSettings());
    } catch {
      return DEFAULT_QUIET_HOURS;
    }
  }

  private get statePath(): string {
    return this.statePathOverride ?? join(getKayaHome(), 'MEMORY/State/alert-gate.json');
  }

  private get spoolPath(): string {
    return this.spoolPathOverride ?? join(getKayaHome(), 'MEMORY/NOTIFICATIONS/digest-spool.jsonl');
  }

  private get archivePath(): string {
    return this.archivePathOverride ?? join(getKayaHome(), 'MEMORY/NOTIFICATIONS/digest-spool-archive.jsonl');
  }

  /**
   * Route an alert through the gate. Returns what actually happened so
   * callers can log it — never throws.
   *
   * T2-01: async — the page tier now AWAITS real delivery confirmation
   * (defaultSend()/notify() resolves a boolean) and only stamps the cooldown
   * (recordPaged()) when delivery is CONFIRMED. A failed delivery does NOT
   * stamp the cooldown (so the very next invocation can retry), re-spools the
   * message to the digest tier (so it's not lost even if every page retry
   * ever fails), and traces loudly — mirrors the existing internal-error
   * catch's console.error + log-tier-spool pattern below.
   */
  async send(message: string, options: SendAlertOptions): Promise<AlertResult> {
    try {
      if (process.env.KAYA_ALERT_DRY_RUN === '1') return 'dry-run';

      if (!options.allowSuspectContext) {
        const marker = findSuspectPath(message);
        if (marker) {
          this.logSuspectSuppression(
            options.key,
            `message references a test/tmp path ("${marker}")`,
          );
          // Demoted to 'log' tier (not dropped) — recoverable in the raw
          // spool for forensics, but doesn't pollute the digest a human reads
          // or trigger a real page.
          this.spool(message, options.key, 'log');
          return 'suppressed';
        }
      }

      const tier = options.tier ?? 'digest';
      if (tier === 'digest') {
        this.spool(message, options.key, 'digest');
        return 'spooled';
      }
      if (tier === 'log') {
        this.spool(message, options.key, 'log');
        return 'logged';
      }

      // page tier

      // Quiet hours: demote to digest rather than interrupt. Checked BEFORE
      // shouldPage() so the cooldown is left untouched — a condition that is
      // still live at 07:00 can page then, instead of having silently spent
      // its 24h cooldown on a 03:00 send nobody saw.
      const quiet = this.quietHours;
      if (
        isWithinQuietHours(this.now(), quiet) &&
        !(options.critical && quiet.allowCriticalOverride)
      ) {
        this.spool(message, options.key, 'digest');
        return 'suppressed';
      }

      if (!this.shouldPage(options.key, options)) {
        // Demote to digest so the alert is still visible tomorrow morning.
        this.spool(message, options.key, 'digest');
        return 'suppressed';
      }
      if (!options.allowSuspectContext && isSandboxedSendContext(this.usesDefaultSend)) {
        // A REAL page (network send) is about to fire while KAYA_HOME points
        // away from the production default — the file-based tiers above are
        // already safely redirected by getKayaHome(), but NotificationService's
        // network send is not KAYA_HOME-aware, so this is the one place a
        // sandboxed test/session could still reach Jm's real Telegram. Scoped
        // to usesDefaultSend so hermetic tests that inject their own `send`
        // stub (the norm across this repo's test suite) are never affected —
        // they can't reach the network regardless of KAYA_HOME. Treat a
        // non-default KAYA_HOME at send time, on the REAL send path, as
        // evidence this is a test/sandbox context that forgot
        // KAYA_ALERT_DRY_RUN=1, and refuse the live send.
        this.logSuspectSuppression(
          options.key,
          `KAYA_HOME ("${getKayaHome()}") differs from the production default ("${defaultKayaHome()}") at page-send time`,
        );
        this.spool(message, options.key, 'log');
        return 'suppressed';
      }
      const delivered = await this.sendFn(message, options.channel ?? 'telegram');
      if (!delivered) {
        // Delivery NOT confirmed — do NOT stamp the cooldown (recordPaged()
        // is skipped entirely), so the next invocation of this same key can
        // retry immediately rather than silently self-suppressing for the
        // full cooldown window. Re-spool to digest (mirrors
        // SystemHealthDigest.ts's own re-spool-on-failure precedent) so the
        // alert surfaces at worst by the next digest run, and trace loudly
        // (console.error + a durable 'log'-tier spool entry) so a repeated
        // failure is visible immediately, not just in tomorrow's digest.
        console.error(
          `[AlertGate] DELIVERY FAILED for key="${options.key}" — page NOT confirmed, cooldown NOT ` +
            `stamped so the next attempt can retry. Re-spooling to digest so it's not lost.`,
        );
        this.spool(message, options.key, 'digest');
        try {
          this.spool(
            `[AlertGate delivery failure] key="${options.key}"`,
            'alert-gate-delivery-failure',
            'log',
          );
        } catch {
          // intentionally silent: this durable trace is best-effort only —
          // the console.error above already fired, so a second failure here
          // (e.g. the same disk error that caused the delivery/spool failure
          // this block exists to trace) has nowhere further to escalate to
          // without risking infinite recursion. Mirrors the identical
          // best-effort nested-trace pattern in this file's outer catch below.
        }
        return 'suppressed';
      }
      this.recordPaged(options.key, options.fingerprint);
      return 'paged';
    } catch (err) {
      // fable-audit batch2, Finding A: this used to be `catch { return
      // 'suppressed'; }` — a genuine unexpected exception here (e.g.
      // writeFileSync throwing ENOSPC/EACCES inside saveState(), a future
      // bug in this file) was swallowed with ZERO trace, indistinguishable
      // from an ordinary cooldown suppression. The one module whose entire
      // job is "never silently drop an alert" was itself capable of going
      // silent. Fix ADDS visibility only — the return contract (never
      // throws, returns 'suppressed') is unchanged; callers that already
      // treat 'suppressed' as "not delivered this time" see no behavior
      // change. Do NOT call sendAlert()/AlertGate.send() from here — that
      // would just re-enter this same try/catch.
      const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
      console.error(
        `[AlertGate] INTERNAL ERROR in send() (key="${options.key}") — an alert was just ` +
          `silently dropped by an unexpected exception, not an ordinary cooldown/suppression: ${detail}`,
      );
      // Best-effort durable trace, mirroring this file's existing
      // suspect-suppression pattern (console.error + a 'log'-tier spool
      // entry — see the suspect-path branch above). 'log' tier is excluded
      // from the human-facing digest (reported only as a count), so this
      // never pollutes what Jm reads, but it IS a persistent record a
      // future investigation can grep for. Wrapped in its own try/catch —
      // the very failure we're tracing could be the spool/state write
      // itself, and this trace attempt must never throw past this catch.
      try {
        this.spool(
          `[AlertGate internal error] key="${options.key}": ${detail}`,
          'alert-gate-internal-error',
          'log',
        );
      } catch {
        // intentionally silent: this durable trace is best-effort only —
        // the console.error above already fired, so a second failure here
        // (e.g. the same disk error that triggered the outer catch) has
        // nowhere further to escalate to without risking infinite recursion.
      }
      return 'suppressed';
    }
  }

  /** Loud, explicit log line for a suspect-context suppression — never silent. */
  private logSuspectSuppression(key: string, reason: string): void {
    console.error(
      `[AlertGate] SUPPRESSED alert (key="${key}") — ${reason}. ` +
        `This is almost always a test or ad-hoc script that forgot KAYA_ALERT_DRY_RUN=1. ` +
        `If this IS a legitimate production alert, pass { allowSuspectContext: true } to ` +
        `sendAlert()/AlertGate.send() to confirm and bypass this guard.`,
    );
  }

  /**
   * Gate check only — for senders with their own delivery (inline keyboards
   * etc.). Pair with recordPaged() after a successful send.
   */
  shouldPage(
    key: string,
    options: { cooldownMs?: number; fingerprint?: string; fingerprintTtlMs?: number } = {},
  ): boolean {
    const state = this.loadState();
    const prev = state.keys[key];
    if (!prev) return true;

    const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    const elapsed = this.now() - new Date(prev.lastSentAt).getTime();
    if (elapsed < cooldownMs) return false;

    // Unchanged fingerprint dedups — but only up to fingerprintTtlMs. This
    // used to be unconditional (`return false`), which made any STATIC
    // fingerprint a one-shot alert: the executor's 'credit-pool-paused' paged
    // 07-09 and then swallowed six days of genuine Aug failures. A still-live
    // condition now re-pages once the TTL elapses.
    if (options.fingerprint !== undefined && prev.fingerprint === options.fingerprint) {
      const fingerprintTtlMs = options.fingerprintTtlMs ?? DEFAULT_FINGERPRINT_TTL_MS;
      if (elapsed < fingerprintTtlMs) return false;
    }
    return true;
  }

  /** Stamp a key as paged now. Fingerprint is only updated here, so change
   *  detection always compares against the last *delivered* alert. */
  recordPaged(key: string, fingerprint?: string): void {
    const state = this.loadState();
    state.keys[key] = {
      lastSentAt: new Date(this.now()).toISOString(),
      ...(fingerprint !== undefined ? { fingerprint } : {}),
    };
    this.saveState(state);
  }

  /** Append an entry to the digest spool. */
  spool(message: string, key: string, tier: AlertTier = 'digest'): void {
    // Only guard the REAL default-derived path — a spoolPath override (the
    // norm across this repo's hermetic test suite, e.g. makeGate() in
    // AlertGate.test.ts) already targets a caller-controlled sandbox path
    // regardless of KAYA_HOME, so guarding it too would only produce
    // false-positive throws in otherwise-correct hermetic tests.
    if (!this.spoolPathOverride) assertNotLiveHomeUnderTest('AlertGate.spool');
    const entry: SpoolEntry = {
      timestamp: new Date(this.now()).toISOString(),
      key,
      tier,
      message,
    };
    // this.spoolPath is a lazily-resolved getter (see its doc comment) — the
    // AppendLog handle is therefore constructed per call too, so a send()
    // always targets whichever KAYA_HOME is active right now rather than
    // whatever it was when a cached handle would have been built.
    createAppendLog(this.spoolPath).append(entry);
  }

  /** Read spool entries without consuming them. */
  readSpool(): SpoolEntry[] {
    if (!existsSync(this.spoolPath)) return [];
    const entries: SpoolEntry[] = [];
    for (const line of readFileSync(this.spoolPath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as SpoolEntry);
      } catch {
        // Torn/partial write — skip the line, keep the rest.
      }
    }
    return entries;
  }

  /**
   * Read all spool entries and truncate the spool (digest delivery).
   *
   * B6 (S4d): before wiping, every consumed entry is appended verbatim to a
   * durable digest-spool-archive.jsonl — SystemHealthDigest's live spool
   * wipe behavior is unchanged (still truncated exactly as before), this
   * only adds a forensic trail so a digest delivery that never reaches
   * Telegram (or a bug in the digest composer) doesn't erase the only copy
   * of what was spooled that day.
   */
  consumeSpool(): SpoolEntry[] {
    const entries = this.readSpool();
    if (entries.length > 0) {
      // Only guard the REAL default-derived path — see the matching comment
      // in spool()/saveState() above; an archivePath override (the norm
      // across this repo's hermetic test suite) already targets a
      // caller-controlled sandbox regardless of KAYA_HOME.
      if (!this.archivePathOverride) assertNotLiveHomeUnderTest('AlertGate.consumeSpool');
      const archiveLog = createAppendLog(this.archivePath);
      for (const entry of entries) {
        archiveLog.append(entry);
      }
    }
    if (existsSync(this.spoolPath)) {
      writeFileSync(this.spoolPath, '');
    }
    return entries;
  }

  // --------------------------------------------------------------------------

  private loadState(): GateState {
    if (!existsSync(this.statePath)) return { version: 1, keys: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf-8')) as GateState;
      if (parsed && typeof parsed === 'object' && parsed.keys) return parsed;
    } catch {
      // Corrupt state — reset rather than wedge every sender.
    }
    return { version: 1, keys: {} };
  }

  private saveState(state: GateState): void {
    // Only guard the REAL default-derived path — see the matching comment in
    // spool() above; a statePath override already targets a caller-controlled
    // sandbox regardless of KAYA_HOME.
    if (!this.statePathOverride) assertNotLiveHomeUnderTest('AlertGate.saveState');
    pruneStaleKeys(state, this.now());
    this.ensureDir(this.statePath);
    writeFileSync(this.statePath, JSON.stringify(state, null, 2));
  }

  private ensureDir(filePath: string): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// Default singleton
// ============================================================================

let _defaultGate: AlertGate | null = null;

export function getAlertGate(): AlertGate {
  if (!_defaultGate) _defaultGate = new AlertGate();
  return _defaultGate;
}

/** Convenience: route an alert through the default gate. */
export async function sendAlert(message: string, options: SendAlertOptions): Promise<AlertResult> {
  return getAlertGate().send(message, options);
}
