#!/usr/bin/env bun
/**
 * RouteOutput — maps a cron job's `output` mode directly onto an AlertGate
 * spool entry.
 *
 * ============================================================================
 * WHY THIS EXISTS (S11 — "messaging collapse")
 * ============================================================================
 * Extracted from bin/run-cron-job.ts's inline `routeOutput()`, which
 * previously built a fresh `MessageRouter` + `MessageQueue` pair
 * (lib/messaging/MessageRouter.ts + MessageQueue.ts, both DELETED in this
 * slice) on every non-silent job completion. That pair amounted to ~1000 LOC
 * of channel-fallback / rate-limit / quiet-hours / retry / dedup machinery
 * that its one real caller never actually configured:
 *   - `createMessageQueue()` was called with zero config, so rate limits,
 *     `disabledChannels`, and the deduplication cache never engaged.
 *   - `RouteRequest.priority` was hardcoded to `'normal'` on every call (there
 *     is no per-job priority concept in JobSpec.ts), so MessageQueue's own
 *     priority-driven page/digest split (`message.priority === 'critical' ||
 *     'high' ? 'page' : 'digest'`) always landed on `'digest'`, and its
 *     duration-based escalation (`jobDuration`) never fired either — the
 *     field was never even passed in.
 *   - `settings.daemon?.quietHours` is not set anywhere in settings.json —
 *     confirmed by grep — so the quiet-hours downgrade was always a no-op.
 *   - MessageQueue's own `processMessage()` already routed real delivery
 *     through `AlertGate.sendAlert()` (see its doc comment) — so the
 *     Router/Queue pair was a load-bearing-*looking* layer sitting in front
 *     of AlertGate, not an independent policy.
 *
 * This module removes the middle layer: `routeJobOutput()` calls AlertGate
 * directly. See docs/decisions/019-let-the-model-speak-s11-messaging-collapse.md
 * for the full writeup, including why every non-silent OutputMode maps to
 * AlertGate's `digest` tier (Jm's explicit call, 2026-07-07 — preserve the
 * OLD system's actual production behavior exactly: zero new live Telegram
 * pings, right after the July alert-storm remediation) and why the old
 * voice-channel call-guard was dropped rather than ported (see "Call-guard"
 * below).
 * ============================================================================
 */

import {
  sendAlert,
  type SendAlertOptions,
  type AlertResult,
  type AlertTier,
} from '../core/AlertGate.ts';
import type { JobSpec } from './JobSpec';

// ============================================================================
// OutputMode → tier mapping
// ============================================================================

/** Every `JobSpec['output']` value except `'silent'` (handled separately — no AlertGate call at all, matching the old `if (outputMode === 'silent') return` short-circuit). */
export type NonSilentOutputMode = Exclude<JobSpec['output'], 'silent'>;

/**
 * OutputMode → AlertGate tier.
 *
 * DESIGN DECISION (see ADR-019): every non-silent mode maps to `digest`.
 * This intentionally matches the OLD system's *actual* production behavior
 * exactly — `routeOutput()`'s only real caller always passed
 * `priority: 'normal'`, which `MessageQueue.processMessage()` mapped to
 * `'digest'` on every call, regardless of OutputMode. Jm chose this over the
 * alternative (mapping to AlertGate's `page` tier, matching ADR-004's
 * documented-but-never-implemented design intent for cron output) on
 * 2026-07-07, specifically to introduce zero new live Telegram pings this
 * soon after the July 2026 alert-storm remediation (K1). All ten non-silent
 * job specs (8 text, 1 both, 1 voice — grep across
 * MEMORY/daemon/cron/manifests/*.yaml) now spool into the daily
 * SystemHealthDigest exactly as they did before this slice; only the
 * MessageRouter/MessageQueue middle layer is gone.
 */
export const OUTPUT_MODE_TIER: Record<NonSilentOutputMode, AlertTier> = {
  voice: 'digest',
  both: 'digest',
  text: 'digest',
  push: 'digest',
  telegram: 'digest',
  discord: 'digest',
};

/**
 * OutputMode → delivery channel. Currently inert: AlertGate's `digest`
 * branch (`AlertGate.send()`) spools unconditionally and never reads
 * `SendAlertOptions.channel` — only a `page`-tier send passes it to
 * `NotificationService`. Kept as explicit, documented metadata (not
 * "speculative scaffolding" — it costs one static Record, no runtime
 * behavior) so a future mode that opts into `page` tier has an existing,
 * faithful-to-the-old-`OUTPUT_TO_CHANNELS`-mapping answer to "which channel"
 * rather than needing to reconstruct it. See ADR-019 for why the
 * *call-guard* (the thing that actually would have gated `voice` on this
 * channel) was dropped rather than kept alongside this table.
 */
export const OUTPUT_MODE_CHANNEL: Record<NonSilentOutputMode, string> = {
  voice: 'voice',
  both: 'voice',
  text: 'push', // old: "Text-only goes to push notification"
  push: 'push',
  telegram: 'push', // old: "Telegram routes through push for now"
  discord: 'discord',
};

// ============================================================================
// routeJobOutput()
// ============================================================================

export interface RouteJobOutputDeps {
  /** Injectable AlertGate sender. Defaults to the real singleton `sendAlert()`. Tests inject a stub (or a fully-isolated `AlertGate` instance's bound `.send`) to stay hermetic. */
  sendAlertFn?: (message: string, options: SendAlertOptions) => AlertResult;
}

/**
 * Route a cron job's output to AlertGate. Returns `null` for the no-op cases
 * (silent mode, or empty output) — matching the old `routeOutput()`'s
 * `if (mode === 'silent' || !output) return;` short-circuit exactly (zero
 * AlertGate calls, zero enqueues either way).
 *
 * SILENT-ON-SUCCESS (S6, 2026-07-15 — 401 auth-storm remediation): this
 * function itself has no notion of job outcome — WHETHER to call it at all
 * is decided one layer up, at bin/run-cron-job.ts's single call site. Before
 * this slice that call site invoked routeJobOutput() only on SUCCESS, which
 * spooled every successful job's routine stdout into SystemHealthDigest's
 * spool daily; several concurrently-nonempty job keys pushed the composed
 * digest past Telegram's 4096-char cap and the resulting send failure
 * re-spooled the entire uncapped entry set forever (the digest poison
 * pill). The call site now invokes this function only on FAILURE.
 *
 * NOTE — call-guard (voice→push downgrade during an active call) is NOT
 * reproduced here. It lived in the OLD `lib/messaging/MessageRouter.ts`'s
 * `route()` (deleted this slice):
 *
 *   if (isOnCall() && !(callGuard?.allowCriticalOverride && priority === 'critical')) {
 *     channels = channels.map(ch => ch === 'voice' ? 'push' : ch);
 *   }
 *
 * Two independent reasons it was dropped, not ported, even though
 * `settings.notifications.callGuard.enabled` is genuinely `true` in
 * production (unlike quiet-hours/rate-limits, which were dead config):
 *
 * 1. **It has nothing left to gate.** The guard only ever downgraded a live
 *    `voice` channel send to `push`. Every OutputMode now maps to `digest`
 *    tier (see OUTPUT_MODE_TIER above), which never selects a live channel
 *    at all — `AlertGate.send()`'s digest branch spools unconditionally and
 *    never reads `channel`. There is no live voice send in this code path
 *    for the guard to protect Jm from.
 * 2. **It was verifiably dead code even when it mattered.** Re-reading the
 *    OLD call sequence: `MessageRouter`'s `createMessageRouter()` fired its
 *    call-detection refresh fire-and-forget at construction time
 *    (`refreshCallStateCache()`, never awaited) and `route()` read the
 *    still-cold cache SYNCHRONOUSLY one line later (`isOnCall()`) —
 *    `routeOutput()` never called the router's `waitForInitialDetection()`
 *    first. `detectActiveCall()` is genuinely async (spawns
 *    `pgrep`/CoreAudio subprocesses); it cannot resolve within the same
 *    microtask. So in the one real call path, on-call state was NEVER
 *    observed as true — the downgrade could not engage, ever, regardless of
 *    whether Jm was actually on a call. `MessageRouter.test.ts`'s own
 *    "callGuard config does not crash" tests never asserted the downgrade
 *    actually happened, only that nothing threw — consistent with this
 *    being unnoticed dead code, not a considered, working safeguard.
 *
 * Porting a never-triggered guard onto a tier that no longer has anything
 * for it to guard is exactly the kind of speculative scaffolding this slice
 * exists to delete. If a future cron job (or a future JobSpec priority
 * field) legitimately opts into AlertGate's `page` tier, CallDetector
 * (`lib/core/CallDetector.ts`) should be wired in AT THAT POINT — properly
 * `await`ed before the channel decision this time — not resurrected
 * speculatively here.
 */
export async function routeJobOutput(
  jobId: string,
  output: string,
  mode: JobSpec['output'],
  deps: RouteJobOutputDeps = {},
): Promise<AlertResult | null> {
  if (mode === 'silent' || !output) return null;

  const sendAlertFn = deps.sendAlertFn ?? sendAlert;

  const tier = OUTPUT_MODE_TIER[mode];
  const channel = OUTPUT_MODE_CHANNEL[mode];

  const content = `[${jobId}] ${output.slice(0, 500)}`;
  const options: SendAlertOptions = {
    key: `cron:${jobId}`,
    tier,
    channel,
  };
  return sendAlertFn(content, options);
}
