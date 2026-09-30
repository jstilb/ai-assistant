#!/usr/bin/env bun
/**
 * WaitingOnJmNotifier.ts — D2: edge-triggered poller for the Waiting-on-Jm surfaces
 *
 * Companion to WaitingOnJm.ts (D1, the full-state read model). Where D1 answers
 * "what's waiting on Jm right now" on demand, this module answers "what just
 * changed" — it watches pipeline_events for fresh needs-grilling/awaiting-approval
 * transitions and pushes a Telegram notification per transition, plus a cheap
 * delta-poll of the two non-event-driven surfaces (Lane-A waiting, needs-Jm
 * escalations) that only fires when their counts increase.
 *
 * EDGE-TRIGGERED, NOT LEVEL-TRIGGERED: this is the whole point (see the
 * 2026-06-12 alert-fatigue incident documented in lib/core/AlertGate.ts). One
 * Telegram message per NEW transition, deduped by AlertGate's fingerprint +
 * cooldown — never a re-nag for state that hasn't changed.
 *
 * FIRST-RUN BOOTSTRAP: pipeline.db ships with a large pre-existing backlog
 * (74 needs-grilling items at the time this was built). On the very first
 * invocation (no checkpoint file yet), this module initializes the checkpoint
 * to the CURRENT tail of pipeline_events + current waiting-counts WITHOUT
 * sending any notifications — otherwise first activation would fire one
 * message per backlog item, the exact level-triggered failure mode this slice
 * exists to prevent. Jm's window into the existing backlog is WaitingOnJm (D1)
 * — this poller only ever reacts to what changes AFTER it starts watching.
 *
 * CHECKPOINT: sinceId (NOT ts) — PipelineRepository.getRecentEvents' own
 * docstring documents that same-millisecond ties on `ts` silently drop events;
 * `id` is the monotonic, gap-free autoincrement PK made exactly for this.
 *
 * RETRY / POISON BOUND (D2 fix round): sinceId must NEVER advance past an
 * event whose notification failed to send — getRecentEvents filters strictly
 * `id > sinceId`, so advancing past a failed event loses it forever (it does
 * NOT "retry naturally next tick" — that comment was aspirational, not true,
 * until this fix). Per-event attempt counts live in `pendingRetries` in the
 * checkpoint file; while any id is outstanding there, sinceId is pinned to
 * (lowest outstanding id - 1), so that event AND every real event after it
 * re-fetch next tick. Already-delivered events among those refetched come
 * back "suppressed" (never re-sent) because AlertGate's per-key fingerprint
 * stamp (recordPaged) is checked before every send, for both notification
 * paths. After POISON_MAX_ATTEMPTS failed attempts for one event, it is
 * dropped (removed from pendingRetries, checkpoint advances past it) and the
 * drop itself is recordFailure'd at tier 'digest' — loud, visible in the
 * daily digest, never silent.
 *
 * @module WaitingOnJmNotifier
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getPipelineRepository, type PipelineRepository } from "./PipelineRepository.ts";
import { QueueManager, type QueueItem } from "./QueueManager.ts";
import { getWaitingOnJm } from "./WaitingOnJm.ts";
import { getAlertGate, type AlertGate } from "../../../../lib/core/AlertGate.ts";
import { notify } from "../../../../lib/core/NotificationService.ts";
import { recordFailure } from "../../../../lib/core/FailureLog.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

// ============================================================================
// Checkpoint
// ============================================================================

export interface NotifierCheckpoint {
  version: 2;
  /**
   * Highest pipeline_events.id fully RESOLVED (delivered, suppressed-as-a-
   * dup, or poison-dropped) — the sinceId cursor. Deliberately NOT just
   * "highest id fetched": while pendingRetries is non-empty, sinceId is
   * pinned to (lowest outstanding id - 1) so a failed send is never skipped.
   */
  sinceId: number;
  /**
   * Per-event delivery-attempt counts for events that have failed at least
   * once and have not yet hit POISON_MAX_ATTEMPTS. Keyed by
   * `String(pipeline_events.id)`. An id present here blocks sinceId from
   * advancing past (id - 1). Entries are deleted the instant an event
   * resolves (send succeeds, gate suppresses it as a dup, or it's poison-
   * dropped) — steady state is normally `{}`.
   */
  pendingRetries: Record<string, number>;
  /** Last-observed laneAWaitingDeliverables.count — delta-poll baseline. */
  lastLaneAWaitingCount: number;
  /** Last-observed needsJmEscalations.count — delta-poll baseline. */
  lastNeedsJmCount: number;
  lastRunAt: string;
}

/**
 * After this many failed delivery attempts for a single event, stop
 * retrying and advance past it rather than block the checkpoint forever —
 * a permanently-broken send (bad payload, Telegram rejecting every retry)
 * must not wedge every event behind it. The drop is loud: recordFailure at
 * tier 'digest' with an explicit DROPPED message, so it's visible in the
 * daily digest even though Jm never got paged for it.
 */
const POISON_MAX_ATTEMPTS = 3;

const DEFAULT_CHECKPOINT: NotifierCheckpoint = {
  version: 2,
  sinceId: 0,
  pendingRetries: {},
  lastLaneAWaitingCount: 0,
  lastNeedsJmCount: 0,
  lastRunAt: "",
};

function defaultCheckpointPath(): string {
  return join(getKayaHome(), "MEMORY/State/waiting-on-jm-notifier.json");
}

function loadCheckpoint(path: string): NotifierCheckpoint {
  if (!existsSync(path)) return { ...DEFAULT_CHECKPOINT, pendingRetries: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<NotifierCheckpoint> & {
      pendingRetries?: Record<string, number>;
    };
    if (parsed && typeof parsed.sinceId === "number") {
      // v1 checkpoints (no pendingRetries field) migrate in place: an absent
      // field is exactly the correct v2 default ("nothing was ever in
      // flight") — additive-field upgrade, no data loss. The migrated shape
      // is persisted back to disk on this run's saveCheckpoint call.
      const pendingRetries =
        parsed.pendingRetries && typeof parsed.pendingRetries === "object" ? { ...parsed.pendingRetries } : {};
      return {
        version: 2,
        sinceId: parsed.sinceId,
        pendingRetries,
        lastLaneAWaitingCount: parsed.lastLaneAWaitingCount ?? 0,
        lastNeedsJmCount: parsed.lastNeedsJmCount ?? 0,
        lastRunAt: parsed.lastRunAt ?? "",
      };
    }
  } catch {
    // Corrupt checkpoint — reset rather than wedge the poller forever.
  }
  return { ...DEFAULT_CHECKPOINT, pendingRetries: {} };
}

function saveCheckpoint(path: string, checkpoint: NotifierCheckpoint): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(checkpoint, null, 2));
}

// ============================================================================
// Secrets (mirrors ApprovalNudge.ts's loadSecrets — same shape, same file)
// ============================================================================

interface TelegramSecrets {
  bot_token?: string;
  chat_id?: string;
}

async function loadTelegramSecrets(): Promise<TelegramSecrets | null> {
  try {
    const home = getKayaHome();
    const secrets = (await Bun.file(`${home}/secrets.json`).json()) as Record<string, unknown>;
    const tg = secrets.telegram as TelegramSecrets | undefined;
    return tg ?? null;
  } catch {
    return null;
  }
}

// ============================================================================
// Types
// ============================================================================

/** Stages worth pushing a Telegram notification for. Everything else (researching,
 *  generating-spec, etc.) is scope for PipelineIntegrity, not this poller. */
const NOTIFY_WORTHY_STAGES = new Set(["needs-grilling", "awaiting-approval"]);

export interface NotifierEventOutcome {
  itemId: string;
  toStage: string;
  eventId: number;
  result: "sent" | "suppressed" | "failed";
}

export interface WaitingOnJmNotifierResult {
  isFirstRun: boolean;
  /** Count of ALL pipeline_events fetched this run (not just notify-worthy ones). */
  newEventCount: number;
  events: NotifierEventOutcome[];
  laneAIncreased: boolean;
  needsJmIncreased: boolean;
  checkpoint: NotifierCheckpoint;
}

export interface WaitingOnJmNotifierDeps {
  repo?: PipelineRepository;
  gate?: AlertGate;
  now?: () => number;
  checkpointPath?: string;
  /** Resolve a pipeline item id to its QueueItem shape (for the approval nudge). */
  getQueueItem?: (id: string) => Promise<QueueItem | null>;
  /** Deliver an awaiting-approval inline-keyboard nudge. */
  sendApprovalNudge?: (item: QueueItem) => Promise<void>;
  /** Deliver a plain informational Telegram push. */
  notifyGrilling?: (message: string) => Promise<void>;
  /** Current Lane-A / needs-Jm counts for the delta poll. Sync fakes fine; the real impl is async (F3). */
  getWaitingCounts?: () =>
    | { laneAWaiting: number; needsJm: number }
    | Promise<{ laneAWaiting: number; needsJm: number }>;
}

// ============================================================================
// Defaults — resolved lazily so tests that inject everything never load
// secrets.json or dynamic-import approvals.ts.
// ============================================================================

async function defaultSendApprovalNudge(): Promise<(item: QueueItem) => Promise<void>> {
  if (process.env.KAYA_ALERT_DRY_RUN === "1") {
    return async (item) => {
      console.log(`[WaitingOnJmNotifier] (dry-run) would nudge approval item ${item.id}`);
    };
  }
  const secrets = await loadTelegramSecrets();
  if (!secrets?.bot_token || !secrets?.chat_id) {
    console.log("[WaitingOnJmNotifier] telegram secrets missing — approval nudges will be skipped");
    return async (item) => {
      console.warn(`[WaitingOnJmNotifier] cannot nudge ${item.id} — telegram secrets missing`);
    };
  }
  // cross-skill-allowed: ADR-004 bot lane (approvals surface)
  const { sendApprovalNudge } = await import("../../../Communication/Telegram/Server/handlers/approvals.ts");
  const token = secrets.bot_token;
  const chatId = secrets.chat_id;
  return (item) => sendApprovalNudge(token, chatId, item);
}

function defaultNotifyGrilling(): (message: string) => Promise<void> {
  if (process.env.KAYA_ALERT_DRY_RUN === "1") {
    return async (message) => {
      console.log(`[WaitingOnJmNotifier] (dry-run) would notify: ${message}`);
    };
  }
  return async (message) => {
    await notify(message, { channel: "telegram" });
  };
}

async function defaultGetQueueItem(id: string): Promise<QueueItem | null> {
  const qm = new QueueManager();
  return qm.get(id);
}

// ============================================================================
// runWaitingOnJmNotifier
// ============================================================================

export async function runWaitingOnJmNotifier(
  deps: WaitingOnJmNotifierDeps = {}
): Promise<WaitingOnJmNotifierResult> {
  const repo = deps.repo ?? getPipelineRepository();
  const gate = deps.gate ?? getAlertGate();
  const now = deps.now ?? Date.now;
  const checkpointPath = deps.checkpointPath ?? defaultCheckpointPath();
  const getQueueItem = deps.getQueueItem ?? defaultGetQueueItem;
  const getWaitingCounts =
    deps.getWaitingCounts ??
    (async () => {
      const summary = await getWaitingOnJm(new Date(now()));
      return {
        laneAWaiting: summary.laneAWaitingDeliverables.count,
        needsJm: summary.needsJmEscalations.count,
      };
    });

  try {
    const sendApprovalNudgeFn = deps.sendApprovalNudge ?? (await defaultSendApprovalNudge());
    const notifyGrillingFn = deps.notifyGrilling ?? defaultNotifyGrilling();

    const isFirstRun = !existsSync(checkpointPath);

    if (isFirstRun) {
      const allEvents = repo.getRecentEvents(null, { sinceId: 0 });
      const maxId = allEvents.reduce((max, e) => Math.max(max, e.id), 0);
      const counts = await getWaitingCounts();
      const checkpoint: NotifierCheckpoint = {
        version: 2,
        sinceId: maxId,
        pendingRetries: {},
        lastLaneAWaitingCount: counts.laneAWaiting,
        lastNeedsJmCount: counts.needsJm,
        lastRunAt: new Date(now()).toISOString(),
      };
      saveCheckpoint(checkpointPath, checkpoint);
      console.log(
        `[WaitingOnJmNotifier] bootstrap: initialized checkpoint at event #${maxId} — 0 notifications sent`
      );
      return {
        isFirstRun: true,
        newEventCount: 0,
        events: [],
        laneAIncreased: false,
        needsJmIncreased: false,
        checkpoint,
      };
    }

    const checkpoint = loadCheckpoint(checkpointPath);
    // ORDER BY id ASC is guaranteed by PipelineRepository.getRecentEvents —
    // ascending processing order is what makes "pin sinceId to the lowest
    // outstanding failed id" a correct, ordering-preserving retry boundary.
    const events = repo.getRecentEvents(null, { sinceId: checkpoint.sinceId });
    const notifyWorthy = events.filter((e) => NOTIFY_WORTHY_STAGES.has(e.to_stage));

    const outcomes: NotifierEventOutcome[] = [];
    const pendingRetries: Record<string, number> = { ...checkpoint.pendingRetries };

    for (const event of notifyWorthy) {
      const fingerprint = `${event.item_id}:${event.to_stage}`;
      const key = `waiting-on-jm:${fingerprint}`;
      const retryKey = String(event.id);

      if (!gate.shouldPage(key, { fingerprint })) {
        // Resolved — either a fresh dup-suppress, or this is a refetch of an
        // event that was already delivered earlier (this run or a prior one)
        // and only came back around because a DIFFERENT event blocked the
        // checkpoint. Either way it must not keep blocking.
        delete pendingRetries[retryKey];
        outcomes.push({ itemId: event.item_id, toStage: event.to_stage, eventId: event.id, result: "suppressed" });
        continue;
      }

      try {
        if (event.to_stage === "awaiting-approval") {
          const item = await getQueueItem(event.item_id);
          if (item) {
            await sendApprovalNudgeFn(item);
          } else {
            await notifyGrillingFn(
              `Approval item ${event.item_id} needs review — item details unavailable (may have been swept). ` +
              `Run \`queue approvals\` to check.`
            );
          }
        } else {
          // needs-grilling
          const pipelineItem = repo.get(event.item_id);
          const title = pipelineItem?.title ?? event.item_id;
          await notifyGrillingFn(
            `New needs-grilling item: "${title}" (${event.item_id}). Run \`grill next\` to work through the backlog.`
          );
        }
        gate.recordPaged(key, fingerprint);
        delete pendingRetries[retryKey];
        outcomes.push({ itemId: event.item_id, toStage: event.to_stage, eventId: event.id, result: "sent" });
      } catch (err) {
        // Per-item failure is loud (recordFailure, tier 'digest' — visible in
        // the daily digest) and never crashes the whole run. It does NOT
        // stamp the gate. sinceId is pinned below this event (see the
        // pendingRetries → newSinceId computation after this loop), so —
        // unlike the old code — this is a REAL retry next tick, not just an
        // aspirational comment: the event re-fetches until it either
        // succeeds or hits POISON_MAX_ATTEMPTS and is dropped.
        const attempts = (pendingRetries[retryKey] ?? 0) + 1;
        if (attempts >= POISON_MAX_ATTEMPTS) {
          delete pendingRetries[retryKey];
          recordFailure({
            source: "WaitingOnJmNotifier:send",
            error: err,
            tier: "digest",
            context: {
              itemId: event.item_id,
              toStage: event.to_stage,
              eventId: event.id,
              attempt: attempts,
              maxAttempts: POISON_MAX_ATTEMPTS,
              outcome: "dropped",
            },
            alertMessage:
              `WaitingOnJmNotifier: notification DROPPED after ${attempts} failed attempts — ` +
              `${event.item_id} (${event.to_stage}, event #${event.id}). Jm will NOT be paged for this ` +
              `transition; check \`waiting-on-jm\` manually.`,
          });
        } else {
          pendingRetries[retryKey] = attempts;
          recordFailure({
            source: "WaitingOnJmNotifier:send",
            error: err,
            tier: "digest",
            context: {
              itemId: event.item_id,
              toStage: event.to_stage,
              eventId: event.id,
              attempt: attempts,
              maxAttempts: POISON_MAX_ATTEMPTS,
              outcome: "will-retry",
            },
            alertMessage:
              `WaitingOnJmNotifier: send attempt ${attempts}/${POISON_MAX_ATTEMPTS} failed for ` +
              `${event.item_id} (${event.to_stage}) — event #${event.id} blocks the checkpoint and will retry next tick.`,
          });
        }
        outcomes.push({ itemId: event.item_id, toStage: event.to_stage, eventId: event.id, result: "failed" });
      }
    }

    // sinceId must never advance past an event that still owes a retry.
    // While pendingRetries is non-empty, pin sinceId to (lowest outstanding
    // id - 1) so that event AND every real event fetched after it (including
    // ones already delivered this run) re-fetch next tick — safe because the
    // gate check above suppresses duplicate sends for anything already
    // stamped via recordPaged. Only once nothing is outstanding does sinceId
    // advance to the tail of what was actually fetched this run.
    const outstandingIds = Object.keys(pendingRetries).map(Number);
    const maxEventId = events.reduce((max, e) => Math.max(max, e.id), checkpoint.sinceId);
    const newSinceId = outstandingIds.length > 0 ? Math.min(...outstandingIds) - 1 : maxEventId;

    // Cheap non-event-driven delta poll: Lane-A waiting deliverables and needs-Jm
    // escalations aren't tracked in pipeline_events at all (separate LucidTasks
    // store) — push only on increase, never on hold/decrease.
    const counts = await getWaitingCounts();
    const laneAIncreased = counts.laneAWaiting > checkpoint.lastLaneAWaitingCount;
    const needsJmIncreased = counts.needsJm > checkpoint.lastNeedsJmCount;

    if (laneAIncreased) {
      await notifyGrillingFn(
        `Lane-A waiting deliverables increased: ${checkpoint.lastLaneAWaitingCount} → ${counts.laneAWaiting}. ` +
        `Run \`waiting-on-jm\` for details.`
      );
    }
    if (needsJmIncreased) {
      await notifyGrillingFn(
        `Needs-Jm escalations increased: ${checkpoint.lastNeedsJmCount} → ${counts.needsJm}. ` +
        `Run \`waiting-on-jm\` for details.`
      );
    }

    const newCheckpoint: NotifierCheckpoint = {
      version: 2,
      sinceId: newSinceId,
      pendingRetries,
      lastLaneAWaitingCount: counts.laneAWaiting,
      lastNeedsJmCount: counts.needsJm,
      lastRunAt: new Date(now()).toISOString(),
    };
    saveCheckpoint(checkpointPath, newCheckpoint);

    const sentCount = outcomes.filter((o) => o.result === "sent").length;
    const suppressedCount = outcomes.filter((o) => o.result === "suppressed").length;
    const failedCount = outcomes.filter((o) => o.result === "failed").length;

    if (events.length === 0 && !laneAIncreased && !needsJmIncreased) {
      console.log("[WaitingOnJmNotifier] 0 new events");
    } else {
      console.log(
        `[WaitingOnJmNotifier] ${events.length} new event(s): ${sentCount} sent, ${suppressedCount} suppressed, ` +
        `${failedCount} failed; laneA ${laneAIncreased ? "↑" : "="} ${counts.laneAWaiting}, ` +
        `needsJm ${needsJmIncreased ? "↑" : "="} ${counts.needsJm}`
      );
    }

    return {
      isFirstRun: false,
      newEventCount: events.length,
      events: outcomes,
      laneAIncreased,
      needsJmIncreased,
      checkpoint: newCheckpoint,
    };
  } catch (err) {
    // LOUD: structural poller failures (DB unreadable, checkpoint unwritable,
    // etc.) — recordFailure at digest tier (visible in the daily digest) and
    // rethrow so the CLI exits nonzero and cron-health-monitor flags it.
    recordFailure({
      source: "WaitingOnJmNotifier",
      error: err,
      tier: "digest",
      context: { checkpointPath },
    });
    throw err;
  }
}

// ============================================================================
// CLI Entry
// ============================================================================

if (import.meta.main) {
  // Composition root: the default getWaitingCounts reads through the
  // TaskClient seam (F3) — register the adapters before running.
  await import("../../../../bin/wire-queue-task-integration.ts");
  runWaitingOnJmNotifier()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[WaitingOnJmNotifier] poller error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
