#!/usr/bin/env bun
/**
 * BriefingFallback.ts - Deterministic safety net for the daily briefing
 *
 * The independent sentinel of the markdown-first inversion (ADR-022), pattern
 * templated on AutoInfoManager/Tools/FreshnessGuard.ts: the agent cannot game
 * its own verification, so a separate deterministic job checks that today's
 * briefing actually shipped and, if not, delivers the bare-minimum fallback
 * itself. Preserves the F-025 guarantee — "LLM fails, Jm still gets the
 * basics" — across the cutover from the TS pipeline to the agent workflow.
 *
 * Runs at 07:45 (the agent job runs at 06:00). If MEMORY/BRIEFINGS/.sent-{date}
 * or {date}.md is missing:
 *   1. DataGatherer → ground-truth BriefingData
 *   2. renderFallbackEditorial → minimal deterministic briefing
 *   3. Deliver.ts deliver() → written/Drive/telegram/voice (same sentinels as
 *      the agent path, so a late agent catch-up run cannot double-deliver)
 *   4. AlertGate page — the miss itself must be loud
 *   5. exit non-zero (degraded run; "cron wrappers must never exit 0 on
 *      degraded runs")
 *
 * Usage:
 *   bun BriefingFallback.ts             # check today; deliver fallback if missing
 *   bun BriefingFallback.ts --dry-run   # check + render, but send/write/page nothing
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { gatherBriefingData, type BriefingData } from "./DataGatherer.ts";
import { deliver } from "./Deliver.ts";
import { sendAlert } from "../../../../lib/core/AlertGate.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { readRunLock, defaultRunLocksDir } from "../../../../lib/cron/RunLock.ts";

// ============================================================================
// Fallback editorial
// ============================================================================

/**
 * Shared substring marker (sleep-cascade remediation, Slice A): embedded in
 * EVERY fallback headline this module produces — both the plain LLM-failure
 * default below and the sentinel's own override at the CLI entrypoint — so
 * a downstream consumer (lib/cron/JobReconciler.ts's decideCatchUp, via
 * bin/job-reconciler.ts's checkStaleMarker) can recognize a fallback-
 * authored briefing artifact from its first line alone, regardless of which
 * of the two call sites produced it. Before this, the two headlines used
 * unrelated wording ("minimal fallback briefing" vs "deterministic
 * fallback") and nothing checked either one — the reconciler saw a
 * fresh-by-mtime artifact and never re-ran the real agent for the rest of
 * the day. YAML manifests can't import a TS const, so
 * MEMORY/daemon/cron/manifests/daily-briefing.yaml's
 * `staleIfFirstLineContains` duplicates this exact string by hand — keep
 * both sides in sync if it ever changes.
 */
export const FALLBACK_MARKER = "deterministic fallback";

/** Exactly what the fallback path delivers — one field per Deliver.ts payload
 *  channel it uses. The failure signal is the AlertGate page below, not a
 *  delivery channel. */
export interface FallbackEditorial {
  telegram: string;
  voice: string;
  markdown: string;
}

/**
 * Render a minimal deterministic briefing from gathered data.
 * F-025 / P1-D: the original design was "no fallback — fail loudly." That meant a single
 * LLM hiccup left Jm with no briefing at all. This renders bare-minimum calendar/tasks/weather
 * so he still has the basics. The failure notification still fires so the miss is visible.
 */
export function renderFallbackEditorial(
  data: BriefingData,
  headline = `⚠️ Editorial LLM failed — ${FALLBACK_MARKER} (minimal briefing)`
): FallbackEditorial {
  const lines: string[] = [headline];

  if (data.weather?.current) {
    lines.push(`\n🌤️  ${data.weather.current}`);
  }

  // Day plan (2026-07-31). scheduler-daily stopped sending its own ~05:44
  // Telegram message and now publishes to MEMORY/BRIEFINGS/day-plan-{date}.md
  // for the briefing to carry. THIS path must include it too: the agent run
  // fails often enough to matter (3 of the 12 days to 07-31, failureClass
  // 'timeout'), and if only the agent path carried the plan, every one of
  // those days would silently lose it. Read here rather than threaded through
  // BriefingData because the plan is not gathered data — it is another job's
  // published artifact, and a missing file is a normal, reportable state.
  const dayPlan = readPublishedDayPlan(
    new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })
  );
  if (dayPlan) {
    lines.push(`\n${dayPlan}`);
  } else {
    lines.push("\n🗓️ No day plan published today (scheduler-daily did not produce one).");
  }

  const events = data.calendar?.events ?? [];
  if (data.calendar?.fetchError) {
    lines.push(`\n📅 Calendar unavailable (${data.calendar.fetchError})`);
  } else if (events.length > 0) {
    lines.push("\n📅 Today's calendar:");
    for (const ev of events.slice(0, 10)) {
      lines.push(`• ${ev.time ? `${ev.time} — ` : ""}${ev.title ?? "(no title)"}`);
    }
  } else {
    lines.push("\n📅 Calendar clear");
  }

  // Mirrors calendar.fetchError above: GoalsBlock carries a WIG-heading parse
  // failure through data.goals.parseError instead of silently shipping an
  // empty goals section (see GoalsBlock.ts, DataGatherer.gatherGoals()).
  if (data.goals?.parseError) {
    lines.push(`\n⚠️ WIG parse failed — check goals.yaml (${data.goals.parseError})`);
  }

  const overdue = data.tasks?.overdue ?? [];
  if (overdue.length > 0) {
    lines.push("\n⚠️  Overdue:");
    for (const t of overdue.slice(0, 5)) lines.push(`• ${t.title}`);
  }

  const dueToday = data.tasks?.dueToday ?? [];
  if (dueToday.length > 0) {
    lines.push("\n📋 Due today:");
    for (const t of dueToday.slice(0, 5)) lines.push(`• ${t.title}`);
  }

  const waiting = data.waitingOnJm;
  if (waiting) {
    lines.push(
      `\n👀 Waiting on you: ${waiting.needsGrillingCount} grilling (oldest ${waiting.needsGrillingOldestAgeDays}d), ` +
        `${waiting.approvalsPendingCount} approvals, ${waiting.pendingApprovalMergesCount} deferred merges, ` +
        `${waiting.needsJmEscalationsCount} escalations, ${waiting.laneAWaitingCount} Lane-A deliverables`
    );
  }

  const telegram = lines.join("\n").slice(0, 4000);
  return {
    telegram,
    voice: "Editorial failed. Minimal briefing delivered via Telegram.",
    markdown: telegram,
  };
}

// ============================================================================
// Delivery check — pure decision, unit-testable
// ============================================================================

export interface BriefingDeliveryCheck {
  delivered: boolean;
  missing: string[];
}

/** Delivered = both the global sentinel AND the written artifact exist. */
/**
 * Is the PRIMARY daily-briefing run still in flight right now?
 *
 * 2026-07-31. The sentinel's premise is "the 06:00 run MISSED" — but until
 * this check existed it could not tell a miss from a run that is merely still
 * going, and it raced its own primary. Arithmetic: daily-briefing's timeout is
 * 1500s and it inherits JobSpec's default retry {max:2} = 3 attempts, so a
 * hanging run occupies 06:00 → ~07:35 (observed 07-31: attempts timed out at
 * 06:34 / 07:02 / 07:35, exit 143, failureClass 'timeout'). The sentinel fires
 * at 07:45 — a 10-minute margin. Any slower day and the sentinel delivers a
 * fallback, and pages about it, while the real briefing is still being
 * generated.
 *
 * Returning true means "not missed YET" — the sentinel exits 0 without
 * delivering or paging. That is NOT the "silently exit 0 on a degraded run"
 * anti-pattern: nothing is degraded yet, the primary still owns the slot. The
 * lock cannot pin this open indefinitely — the runner's own timeout kills the
 * wrapper (releasing the lock), readRunLock() independently treats a dead-pid
 * or over-age lock as stale, and this job's retry budget is capped (see
 * daily-briefing.yaml) so the worst case clears well before 07:45.
 */
export function isPrimaryRunInFlight(
  locksDir: string = defaultRunLocksDir(),
  jobId = "daily-briefing",
): boolean {
  return readRunLock(jobId, locksDir) !== null;
}

/**
 * Read the day plan scheduler-daily published for `date`, or null when it
 * never landed. Absence is a normal state (scheduler-daily failed, or has not
 * run yet), so this returns null rather than throwing — the caller reports the
 * gap in the briefing instead of failing the whole fallback over it.
 *
 * `briefingsDir` is injectable for tests; it defaults to the same directory
 * the briefing's own artifacts live in.
 */
export function readPublishedDayPlan(
  date: string,
  briefingsDir: string = join(getKayaHome(), "MEMORY", "BRIEFINGS"),
): string | null {
  try {
    const path = join(briefingsDir, `day-plan-${date}.md`);
    if (!existsSync(path)) return null;
    const body = readFileSync(path, "utf-8").trim();
    return body.length > 0 ? body : null;
  } catch {
    return null;
  }
}

export function checkBriefingDelivered(date: string, briefingsDir: string): BriefingDeliveryCheck {
  const missing: string[] = [];
  const sentinel = join(briefingsDir, `.sent-${date}`);
  const artifact = join(briefingsDir, `${date}.md`);
  if (!existsSync(sentinel)) missing.push(sentinel);
  if (!existsSync(artifact)) missing.push(artifact);
  return { delivered: missing.length === 0, missing };
}

// ============================================================================
// CLI entrypoint
// ============================================================================

if (import.meta.main) {
  // Composition root: gatherWaitingOnJm reads through the TaskClient seam —
  // register the adapters before gathering (same as DataGatherer's own entry).
  await import("../../../../bin/wire-queue-task-integration.ts");

  const dryRun = process.argv.slice(2).includes("--dry-run");
  const briefingsDir = join(getKayaHome(), "MEMORY", "BRIEFINGS");
  const date = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  try {
    const check = checkBriefingDelivered(date, briefingsDir);
    if (check.delivered) {
      console.log(`[BriefingFallback] OK — briefing for ${date} already delivered (sentinel + artifact present).`);
      process.exit(0);
    }

    // Not delivered — but is the primary still working on it? Deliver a
    // fallback only for a genuine MISS, never on top of a live run. See
    // isPrimaryRunInFlight's docblock for the timing that made this a real,
    // near-daily race rather than a theoretical one.
    if (isPrimaryRunInFlight()) {
      console.log(
        `[BriefingFallback] SKIP — briefing for ${date} not delivered yet, but the ` +
          `daily-briefing run still holds a live run lock. The primary owns this slot; ` +
          `a fallback now would double-deliver and page about a run that has not missed.`
      );
      process.exit(0);
    }

    console.error(`[BriefingFallback] Briefing for ${date} NOT delivered — missing:`);
    for (const m of check.missing) console.error(`  - ${m}`);

    console.error("[BriefingFallback] Gathering ground truth for the deterministic fallback...");
    const data = await gatherBriefingData();
    const fallback = renderFallbackEditorial(
      data,
      `⚠️ Morning briefing agent run missed — ${FALLBACK_MARKER}`
    );

    if (dryRun) {
      console.log("[BriefingFallback] --dry-run: would deliver the following (nothing sent, nothing written):");
      console.log(fallback.telegram);
      process.exit(1);
    }

    const delivery = await deliver({
      date,
      tier: "fallback",
      markdown: fallback.markdown,
      telegram: fallback.telegram,
      voice: fallback.voice,
    });

    const outcome = delivery.delivered.includes("written")
      ? "deterministic fallback delivered"
      : "fallback skipped because full delivery already started";

    // Awaited (T2-01): process.exit(1) follows shortly below — without the
    // await, the delivery attempt would be truncated before it could even
    // start on this page-tier "briefing missed" alert.
    const pageResult = await sendAlert(
      `⚠️ Daily briefing missed its 06:00 agent run — ${outcome} at ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles" })}. Check MEMORY/daemon/cron/logs/daily-briefing.jsonl for why the agent run failed.`,
      { key: "briefing-sentinel", tier: "page" }
    );
    console.error(`[BriefingFallback] AlertGate page result: ${pageResult}`);

    // Fallback delivered, but the run is degraded by definition — the primary
    // path failed. Never exit 0 on a degraded run.
    process.exit(1);
  } catch (err) {
    console.error("[BriefingFallback] Fatal error:", err instanceof Error ? err.message : String(err));
    // Fail loud: page even when the fallback itself broke — this is the
    // "no briefing at all" worst case.
    try {
      await sendAlert(
        `🔴 BriefingFallback crashed while trying to deliver the fallback briefing for ${date}: ${err instanceof Error ? err.message : String(err)}`,
        { key: "briefing-sentinel", tier: "page" }
      );
    } catch {
      // AlertGate itself failing must not mask the original error.
    }
    process.exit(1);
  }
}
