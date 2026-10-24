#!/usr/bin/env bun
/**
 * SystemHealthDigest.ts — daily Telegram roll-up of spooled alerts.
 *
 * Consumes the AlertGate digest spool (warnings, suppressed pages, AW
 * verification failures) plus the last 24h of cron failures, and sends ONE
 * deterministic Telegram message. Runs as the final step of kaya-spec-daily.sh
 * (~07:00), so warnings reach Jm once a morning instead of as ad-hoc pings.
 *
 * Sections:
 *   ⚠️ digest-tier entries — deduped by key: latest message, ×count
 *   ℹ️ log-tier entries    — counts only
 *   🕐 cron failures (24h) — grouped by job, from cron-health scanLogs
 *   📋 backlog (D3)        — needs-grilling/approvals/Lane-A counts from WaitingOnJm
 *
 * Sends nothing when there is nothing to report.
 *
 * Usage:
 *   bun skills/Automation/QueueRouter/Tools/SystemHealthDigest.ts
 */

import { getAlertGate, type AlertGate, type SpoolEntry } from "../../../../lib/core/AlertGate.ts";
import { scanLogs, isSleepChurn, type FailureRecord } from "../../../../bin/cron-health-monitor.ts";
import { getWaitingOnJm, type WaitingOnJmSummary } from "./WaitingOnJm.ts";

const CRON_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Telegram Bot API's hard message-length cap (characters). */
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/**
 * Re-spool cap on send failure (S6 — 401 auth-storm remediation): a failed
 * send re-spools the entries it just consumed so tomorrow's digest can retry
 * them, but re-spooling the ENTIRE uncapped set was the poison pill — a
 * digest that's too big to send once stays too big to send forever, growing
 * the raw spool file without bound (587 entries observed 2026-07-15).
 * Drop-oldest keeps the most recent, most-relevant entries; the drop is
 * logged (never silent).
 */
const RESPOOL_CAP = 100;

/**
 * Per-bullet character cap. A single spool message longer than this is
 * clipped (with "…") rather than left whole: the 4096 truncation below can
 * only drop a line wholesale, so one long message (an 800-char
 * eventscout-weekend-digest entry on 2026-10-16, a 5825-char
 * eval-health-weekly-digest entry on 2026-07-15) used to be dropped entirely.
 * Clipped, it still renders and Jm still sees that it fired.
 */
const MAX_BULLET_CHARS = 500;

/** Max characters of omitted-key names listed in the truncation tail. */
const MAX_TAIL_KEYS_CHARS = 300;

/**
 * One composed digest line plus what it accounts for. `entries` is the
 * number of consumed spool entries the line renders (0 for headers, cron
 * lines and backlog lines, which come from other sources); `key` is the
 * spool key, for naming the line in the truncation tail if it gets dropped.
 */
interface DigestLine {
  text: string;
  entries: number;
  key?: string;
}

/** Result of composing a digest: the text plus its spool-entry accounting. */
export interface ComposedDigest {
  text: string;
  /** Consumed spool entries represented by a line that made it into `text`. */
  renderedEntries: number;
  /** Consumed spool entries whose line was dropped by the 4096 truncation. */
  omittedEntries: number;
  /** Spool keys of the dropped lines (also named in the truncation tail). */
  omittedKeys: string[];
}

function clipMessage(message: string): string {
  return message.length <= MAX_BULLET_CHARS ? message : `${message.slice(0, MAX_BULLET_CHARS - 1)}…`;
}

function buildTruncationTail(omittedEntries: number, omittedKeys: string[]): string {
  const head = `…truncated, ${omittedEntries} entries omitted`;
  if (omittedKeys.length === 0) return head;
  const listed: string[] = [];
  let used = 0;
  for (const key of omittedKeys) {
    if (used + key.length + 2 > MAX_TAIL_KEYS_CHARS) break;
    listed.push(key);
    used += key.length + 2;
  }
  const rest = omittedKeys.length - listed.length;
  return `${head}: ${listed.join(", ")}${rest > 0 ? ` +${rest} more` : ""}`;
}

/**
 * Hard-truncate a composed digest to TELEGRAM_MAX_MESSAGE_LENGTH, appending
 * an explicit "…truncated, N entries omitted: key, key" tail so a truncated
 * send is visibly incomplete AND says what it left out, rather than being
 * silently clipped by the API (or rejected with an HTTP 400 — see
 * RESPOOL_CAP's doc comment).
 *
 * N counts consumed spool entries (a dropped "×8" line is 8 entries), so the
 * digest upholds "every consumed entry is rendered or counted".
 *
 * Best-fit sequential scan, not a prefix cutoff: a line that doesn't fit is
 * skipped and every later line that still fits is kept in original order.
 * The tail's length is bounded (MAX_TAIL_KEYS_CHARS + a short head), so the
 * budget reserves that worst case up front and the result never exceeds the
 * cap.
 */
function truncateToTelegramLimit(lines: DigestLine[]): ComposedDigest {
  const maxTailLength = buildTruncationTail(999_999, []).length + 2 + MAX_TAIL_KEYS_CHARS + " +999 more".length;
  const budget = TELEGRAM_MAX_MESSAGE_LENGTH - maxTailLength - 1; // -1: the tail's own leading newline

  const kept: string[] = [];
  let usedLength = 0;
  let renderedEntries = 0;
  let omittedEntries = 0;
  const omittedKeys: string[] = [];
  for (const line of lines) {
    const addLength = line.text.length + (kept.length > 0 ? 1 : 0); // +1 for the joining newline
    if (usedLength + addLength <= budget) {
      kept.push(line.text);
      usedLength += addLength;
      renderedEntries += line.entries;
    } else if (line.entries > 0) {
      omittedEntries += line.entries;
      if (line.key !== undefined) omittedKeys.push(line.key);
    }
  }

  const tail = buildTruncationTail(omittedEntries, omittedKeys);
  return {
    text: kept.length > 0 ? `${kept.join("\n")}\n${tail}` : tail,
    renderedEntries,
    omittedEntries,
    omittedKeys,
  };
}

/**
 * A1: group cron failures by jobId for the digest's "Cron failures (24h)"
 * section — one line per job, with its failure count and latest exit code.
 *
 * Replaces the old correlate()-then-re-merge-on-jobId workaround (which
 * called the since-deleted incident-clustering module's correlate() and
 * then undid its multi-job clustering back down to per-job lines for
 * everything but a genuine shared-cause cluster). That clustering never
 * fired in production (93/93 real incidents were single-job — see A1), so
 * grouping directly by jobId is both simpler and matches reality.
 */
function groupByJobId(cronFailures: FailureRecord[]): { label: string; count: number }[] {
  if (cronFailures.length === 0) return [];

  const byJob = new Map<string, FailureRecord[]>();
  for (const f of cronFailures) {
    const list = byJob.get(f.jobId) ?? [];
    list.push(f);
    byJob.set(f.jobId, list);
  }

  const lines: { label: string; count: number }[] = [];
  for (const [jobId, runs] of byJob) {
    const latest = runs.reduce((a, b) => (b.timestamp >= a.timestamp ? b : a));
    const suffix = latest.exitCode !== undefined ? ` (exit ${latest.exitCode})` : "";
    lines.push({ label: `${jobId}${suffix}`, count: runs.length });
  }

  return lines;
}

/**
 * [Slice B, sleep-cascade remediation] Digest-spool key cron-health-monitor
 * .ts's pageDigest() writes the morning "🌙 Overnight: N job(s) slept
 * through M run(s)..." summary under (see its doc comment). Previously this
 * same overnight event ALSO rendered as separate per-job "jobId×N (sleep)"
 * bullets derived independently from raw cronFailures, under "🕐 Cron
 * failures (24h):" — reporting the identical event twice. This entry is now
 * partitioned out of the plain "⚠️ Alerts:" loop and rendered once, as a
 * single info-area line (see buildDigest below); the raw cronFailures sleep-
 * churn classification (isSleepChurn) is still used, but ONLY to exclude
 * those failures from the plain cron-failures bucket — it no longer renders
 * its own bullet.
 */
const CRON_HEALTH_SLEEP_DIGEST_KEY = "cron-health-sleep-digest";

/** D3: backlog counts sourced from WaitingOnJm — needs-grilling, approvals, Lane-A. */
export interface BacklogMetrics {
  needsGrillingCount: number;
  needsGrillingOldestAgeDays: number;
  approvalsPendingCount: number;
  laneAWaitingCount: number;
}

/**
 * T2-08(b): needs-grilling backlog escalation threshold.
 *
 * The daily digest (below) reports the backlog's count/oldest-age every
 * morning unconditionally — that line alone doesn't distinguish "stable,
 * acceptable idle inventory" (this backlog is expected to grow; grilling is
 * interactive-only, see GrillTask.md) from "something has gone genuinely
 * wrong." This threshold adds the missing distinction: a hard age ceiling,
 * well above the ordinary drift rate, that only trips on a genuine runaway.
 *
 * 90 days chosen deliberately above the oldest item observed at plan time
 * (66.6d, growing roughly linearly with no drainage) so it does not fire on
 * landing — see runSystemHealthDigest's escalation call.
 */
const GRILL_STALE_AGE_DAYS = 90;

/**
 * Re-escalation cooldown for the grill-backlog-stale page (T2-08(b)).
 *
 * Deliberately NOT AlertGate's 24h default: once `needsGrillingOldestAgeDays`
 * crosses GRILL_STALE_AGE_DAYS it stays crossed every single day afterward
 * (the backlog drains only via interactive grilling, not on its own) — a 24h
 * cooldown would re-page every morning for as long as Jm leaves it
 * ungrilled, which is exactly the "always-on noise source" this ticket's own
 * risk section warns against. A 7-day cooldown re-surfaces the page on a
 * weekly cadence if it's still unresolved (so it can't be silently
 * forgotten) without nagging daily about a condition that, by design,
 * doesn't self-heal between one morning's digest and the next.
 */
const GRILL_STALE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Build the digest body. Pure — returns null when there is nothing to say.
 *
 * `backlog`/`backlogWarning` (D3) are the WaitingOnJm rollup, gathered
 * best-effort by the caller: `backlog` is the metrics on success, or null on
 * a gather failure (in which case `backlogWarning` carries the error message
 * so the failure is visible in the digest rather than silently dropped).
 */
export function buildDigest(
  entries: SpoolEntry[],
  cronFailures: FailureRecord[],
  backlog: BacklogMetrics | null = null,
  backlogWarning: string | null = null,
): string | null {
  return composeDigest(entries, cronFailures, backlog, backlogWarning)?.text ?? null;
}

/**
 * buildDigest plus its spool-entry accounting. Invariant (guarded by tests):
 * renderedEntries + omittedEntries === entries.length — every consumed spool
 * entry is either rendered or counted (and named) in the truncation tail.
 */
export function composeDigest(
  entries: SpoolEntry[],
  cronFailures: FailureRecord[],
  backlog: BacklogMetrics | null = null,
  backlogWarning: string | null = null,
): ComposedDigest | null {
  const digestByKey = new Map<string, { latest: string; count: number }>();
  const logByKey = new Map<string, number>();
  // [Slice B] Partitioned out of digestByKey's loop below — see
  // CRON_HEALTH_SLEEP_DIGEST_KEY's doc comment. Latest message wins on a
  // repeat, matching digestByKey's own dedup-by-key convention.
  let sleepDigestMessage: string | null = null;
  let sleepDigestCount = 0;

  for (const e of entries) {
    if (e.tier === "log") {
      logByKey.set(e.key, (logByKey.get(e.key) ?? 0) + 1);
    } else if (e.key === CRON_HEALTH_SLEEP_DIGEST_KEY) {
      sleepDigestMessage = e.message;
      sleepDigestCount++;
    } else {
      const prev = digestByKey.get(e.key);
      digestByKey.set(e.key, { latest: e.message, count: (prev?.count ?? 0) + 1 });
    }
  }

  // [S1d, superseded by Slice B] Sleep-churn cron failures are still
  // excluded from the plain failures bucket — reusing cron-health-monitor's
  // own isSleepChurn() classification (sleptThrough || (timeout && exit
  // 143), see its doc comment) so there's exactly one definition of
  // "sleep-churn" shared between the monitor's page-vs-queue decision and
  // this digest's rendering. Unlike before, the excluded failures no longer
  // render their own "(sleep)" bullets here — that summary now comes
  // exclusively from the cron-health-sleep-digest spool entry above, so the
  // same overnight event isn't reported twice.
  const plainCronFailures = cronFailures.filter((f) => !isSleepChurn(f));
  const cronLines = groupByJobId(plainCronFailures);
  const backlogHasContent =
    backlog !== null && (backlog.needsGrillingCount + backlog.approvalsPendingCount + backlog.laneAWaitingCount) > 0;

  if (
    digestByKey.size === 0 &&
    logByKey.size === 0 &&
    cronLines.length === 0 &&
    sleepDigestMessage === null &&
    !backlogHasContent &&
    !backlogWarning
  ) {
    return null;
  }

  const lines: DigestLine[] = [];
  const add = (text: string, entries = 0, key?: string) => lines.push({ text, entries, key });

  add(`🩺 System health — ${new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" })}`);

  if (digestByKey.size > 0) {
    add("");
    add("⚠️ Alerts:");
    for (const [key, { latest, count }] of digestByKey) {
      add(`• ${clipMessage(latest)}${count > 1 ? ` ×${count}` : ""}`, count, key);
    }
  }

  if (logByKey.size > 0 || sleepDigestMessage !== null) {
    add("");
    add("ℹ️ Counts:");
    for (const [key, count] of logByKey) {
      add(`• ${key} ×${count}`, count, key);
    }
    if (sleepDigestMessage !== null) {
      // [Slice B] Message text as-is (not tallied/reformatted like the
      // key×count lines above) — cron-health-monitor already composed the
      // full "🌙 Overnight: ..." summary.
      add(`• ${clipMessage(sleepDigestMessage)}`, sleepDigestCount, CRON_HEALTH_SLEEP_DIGEST_KEY);
    }
  }

  if (cronLines.length > 0) {
    add("");
    add("🕐 Cron failures (24h):");
    for (const { label, count } of cronLines) {
      add(`• ${label}${count > 1 ? ` ×${count}` : ""}`);
    }
  }

  if (backlogHasContent) {
    add("");
    add("📋 Backlog:");
    add(`• Needs grilling: ${backlog!.needsGrillingCount} (oldest ${backlog!.needsGrillingOldestAgeDays}d)`);
    add(`• Approvals pending: ${backlog!.approvalsPendingCount}`);
    add(`• Lane-A waiting: ${backlog!.laneAWaitingCount}`);
  } else if (backlogWarning) {
    add("");
    add(`⚠️ Backlog metrics unavailable: ${backlogWarning}`);
  }

  const full = lines.map((l) => l.text).join("\n");
  if (full.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
    return { text: full, renderedEntries: entries.length, omittedEntries: 0, omittedKeys: [] };
  }
  return truncateToTelegramLimit(lines);
}

export interface SystemHealthDigestDeps {
  gate?: AlertGate;
  send?: (message: string) => Promise<void>;
  cronFailures?: () => FailureRecord[];
  /** D3: backlog metrics source — injectable so tests never touch pipeline.db/lucidtasks.db. Sync fakes fine; the real impl is async (F3). */
  getWaitingOnJm?: () => WaitingOnJmSummary | Promise<WaitingOnJmSummary>;
}

export async function runSystemHealthDigest(deps: SystemHealthDigestDeps = {}): Promise<void> {
  if (process.env.KAYA_ALERT_DRY_RUN === "1") {
    console.log("[SystemHealthDigest] dry-run — skipping");
    return;
  }

  const gate = deps.gate ?? getAlertGate();
  const send = deps.send ?? (async (message: string) => {
    const { notify } = await import("../../../../lib/core/NotificationService.ts");
    // notify() resolves successfully even when every channel attempt
    // failed (it dead-letters to an in-memory queue instead of throwing).
    // Must check the delivered result and throw here so the catch below
    // re-spools — otherwise a failed send is indistinguishable from a
    // successful one and the digest content is silently lost.
    const delivered = await notify(message, { channel: "telegram", agentName: "System Health" });
    if (!delivered) {
      throw new Error("notify() reported non-delivery (all channel attempts failed)");
    }
  });
  const cronFailures = deps.cronFailures ?? (() => scanLogs(CRON_LOOKBACK_MS));
  const getWaitingOnJmFn = deps.getWaitingOnJm ?? getWaitingOnJm;

  // D3: backlog metrics are best-effort — a WaitingOnJm read failure must
  // never block the rest of the digest from sending. Failure becomes a
  // visible warning line in the digest body (buildDigest) instead of an
  // uncaught throw here.
  let backlog: BacklogMetrics | null = null;
  let backlogWarning: string | null = null;
  try {
    const summary = await getWaitingOnJmFn();
    backlog = {
      needsGrillingCount: summary.needsGrilling.count,
      needsGrillingOldestAgeDays: summary.needsGrilling.oldestAgeDays,
      approvalsPendingCount: summary.approvalsPending.count,
      laneAWaitingCount: summary.laneAWaitingDeliverables.count,
    };
  } catch (err) {
    backlogWarning = err instanceof Error ? err.message : String(err);
    console.error(`[SystemHealthDigest] backlog metrics gather failed: ${backlogWarning}`);
  }

  // T2-08(b): threshold-crossing escalation on top of the existing daily
  // backlog computation above — see GRILL_STALE_AGE_DAYS's doc comment.
  // Best-effort like the gather itself: only evaluated when the gather
  // succeeded (a null backlog already surfaced its own warning above), and
  // routed through the same `gate` the rest of this function uses so tests
  // observe it through the same injected AlertGate instance rather than a
  // second, unrelated sender.
  if (backlog && backlog.needsGrillingOldestAgeDays > GRILL_STALE_AGE_DAYS) {
    const result = await gate.send(
      `Needs-grilling backlog: oldest item is ${backlog.needsGrillingOldestAgeDays}d old ` +
        `(${backlog.needsGrillingCount} total waiting) — needs Jm attention.`,
      { key: "grill-backlog-stale", tier: "page", cooldownMs: GRILL_STALE_COOLDOWN_MS },
    );
    console.log(`[SystemHealthDigest] grill-backlog-stale escalation: ${result}`);
  }

  // Consume first so entries appended mid-send aren't lost to the truncate;
  // on send failure everything (up to RESPOOL_CAP) is re-spooled for
  // tomorrow's digest.
  const entries = gate.consumeSpool();
  const composed = composeDigest(entries, cronFailures(), backlog, backlogWarning);

  if (!composed) {
    console.log("[SystemHealthDigest] nothing to report");
    return;
  }

  try {
    await send(composed.text);
    const omittedNote = composed.omittedEntries > 0
      ? `, ${composed.omittedEntries} omitted by the ${TELEGRAM_MAX_MESSAGE_LENGTH}-char cap: ${composed.omittedKeys.join(", ")}`
      : "";
    console.log(`[SystemHealthDigest] sent (${entries.length} spool entries: ${composed.renderedEntries} rendered${omittedNote})`);
  } catch (err) {
    // Cap the re-spool (S6 — see RESPOOL_CAP's doc comment): drop-oldest,
    // keep the most recent RESPOOL_CAP entries, and always log the drop
    // count — a capped drop must never be silent.
    const dropCount = Math.max(0, entries.length - RESPOOL_CAP);
    const toRespool = dropCount > 0 ? entries.slice(dropCount) : entries;
    for (const e of toRespool) gate.spool(e.message, e.key, e.tier);
    const dropNote = dropCount > 0 ? ` (dropped ${dropCount} oldest entries past the ${RESPOOL_CAP}-entry cap)` : "";
    console.error(`[SystemHealthDigest] send failed, re-spooled ${toRespool.length} entries${dropNote}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (import.meta.main) {
  // Composition root: the real getWaitingOnJm reads through the TaskClient
  // seam (F3) — register the adapters before running.
  await import("../../../../bin/wire-queue-task-integration.ts");
  runSystemHealthDigest().catch(err => {
    console.error("SystemHealthDigest FATAL:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
