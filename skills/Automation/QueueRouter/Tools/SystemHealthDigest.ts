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
 * Hard-truncate a composed digest to TELEGRAM_MAX_MESSAGE_LENGTH, appending
 * an explicit "…truncated, N entries omitted" tail so a truncated send is
 * visibly incomplete rather than silently clipped by the API itself (or
 * rejected outright with an HTTP 400, which is what happened before this —
 * see RESPOOL_CAP's doc comment).
 *
 * Best-fit sequential scan, not a prefix cutoff: a single oversized line
 * (observed live 2026-07-15 — one `eval-health-weekly-digest` spool entry
 * alone ran 5825 chars, bigger than Telegram's ENTIRE cap) does not stop the
 * scan. It's skipped and counted as omitted, and every later line that still
 * fits in the remaining budget is kept in its original order. A plain
 * prefix-cutoff would let that one aberrant line blank out the whole rest of
 * an otherwise-normal-sized digest, which defeats the point of truncating
 * (staying informative) rather than just satisfying the char limit.
 *
 * The tail's own length depends on the final omitted count, so the budget
 * reserves worst-case headroom (6 digits — far beyond any realistic entry
 * count, especially now that RESPOOL_CAP bounds the spool itself) up front
 * rather than measuring the tail after the fact. That keeps this a single
 * linear pass while still guaranteeing the final message never exceeds the
 * cap.
 */
function truncateToTelegramLimit(lines: string[]): string {
  const buildTail = (n: number) => `…truncated, ${n} entries omitted`;
  const maxTailLength = buildTail(999_999).length;
  const budget = TELEGRAM_MAX_MESSAGE_LENGTH - maxTailLength - 1; // -1: the tail's own leading newline

  const kept: string[] = [];
  let usedLength = 0;
  let omittedBullets = 0;
  for (const line of lines) {
    const addLength = line.length + (kept.length > 0 ? 1 : 0); // +1 for the joining newline
    if (usedLength + addLength <= budget) {
      kept.push(line);
      usedLength += addLength;
    } else if (line.trim().startsWith("•")) {
      // Only bullet lines count as "entries" — a dropped section header
      // (its bullets, if any, are counted individually as they're visited)
      // isn't itself a separate omitted entry.
      omittedBullets++;
    }
  }

  const tail = buildTail(omittedBullets);
  return kept.length > 0 ? `${kept.join("\n")}\n${tail}` : tail;
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
  const digestByKey = new Map<string, { latest: string; count: number }>();
  const logByKey = new Map<string, number>();
  // [Slice B] Partitioned out of digestByKey's loop below — see
  // CRON_HEALTH_SLEEP_DIGEST_KEY's doc comment. Latest message wins on a
  // repeat, matching digestByKey's own dedup-by-key convention.
  let sleepDigestMessage: string | null = null;

  for (const e of entries) {
    if (e.tier === "log") {
      logByKey.set(e.key, (logByKey.get(e.key) ?? 0) + 1);
    } else if (e.key === CRON_HEALTH_SLEEP_DIGEST_KEY) {
      sleepDigestMessage = e.message;
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

  const lines: string[] = [`🩺 System health — ${new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" })}`];

  if (digestByKey.size > 0) {
    lines.push("", "⚠️ Alerts:");
    for (const [, { latest, count }] of digestByKey) {
      lines.push(`• ${latest}${count > 1 ? ` ×${count}` : ""}`);
    }
  }

  if (logByKey.size > 0 || sleepDigestMessage !== null) {
    lines.push("", "ℹ️ Counts:");
    for (const [key, count] of logByKey) {
      lines.push(`• ${key} ×${count}`);
    }
    if (sleepDigestMessage !== null) {
      // [Slice B] Message text as-is (not tallied/reformatted like the
      // key×count lines above) — cron-health-monitor already composed the
      // full "🌙 Overnight: ..." summary.
      lines.push(`• ${sleepDigestMessage}`);
    }
  }

  if (cronLines.length > 0) {
    lines.push("", "🕐 Cron failures (24h):");
    for (const { label, count } of cronLines) {
      lines.push(`• ${label}${count > 1 ? ` ×${count}` : ""}`);
    }
  }

  if (backlogHasContent) {
    lines.push("", "📋 Backlog:");
    lines.push(`• Needs grilling: ${backlog!.needsGrillingCount} (oldest ${backlog!.needsGrillingOldestAgeDays}d)`);
    lines.push(`• Approvals pending: ${backlog!.approvalsPendingCount}`);
    lines.push(`• Lane-A waiting: ${backlog!.laneAWaitingCount}`);
  } else if (backlogWarning) {
    lines.push("", `⚠️ Backlog metrics unavailable: ${backlogWarning}`);
  }

  const full = lines.join("\n");
  return full.length <= TELEGRAM_MAX_MESSAGE_LENGTH ? full : truncateToTelegramLimit(lines);
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
  const body = buildDigest(entries, cronFailures(), backlog, backlogWarning);

  if (!body) {
    console.log("[SystemHealthDigest] nothing to report");
    return;
  }

  try {
    await send(body);
    console.log(`[SystemHealthDigest] sent (${entries.length} spool entries)`);
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
