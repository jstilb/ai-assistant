#!/usr/bin/env bun
/**
 * Classifier.ts — V1.5 LLM-driven Tier-2 classifier.
 *
 * Reads unclassified Tier-2 events (CONFIG.tier2Apps + CONFIG.tier2DomainPatterns),
 * groups them into sessions (consecutive same-app events within SESSION_GAP_SEC),
 * and asks Sonnet to classify each session as low-value or not. Verdicts are
 * upserted into `classifications` (one row per event id, sharing the verdict).
 *
 * Sessions with NO title and NO url across all events are unclassifiable
 * (e.g. Android Chrome without the web extension) — they're skipped, not
 * counted, and reported via the run summary so we know how much we're missing.
 *
 * Idempotent: re-running skips events that already have a classifications row.
 * With --force, every Tier-2 event in the window is reconsidered.
 *
 * Flags:
 *   --force            re-classify even already-classified events
 *   --json             emit JSON summary on stdout
 *   --since=YYYY-MM-DD only consider events on/after this date (default: 30 days back)
 *   --limit=N          cap number of sessions classified this run (cost guard)
 *   --dry-run          sessionize + report what would be classified, no LLM calls
 */
import { CONFIG } from "../Config.ts";
import { Db, logFailure } from "./Db.ts";
import { shiftDate, todayLocal } from "./Util.ts";
import { inference } from "~/.claude/lib/core/Inference.ts";

/** Threshold below which "100% unclassifiable" stops being noise. Saves a
 *  spurious alert when there are simply no Tier-2 events in the window. */
const UNCLASSIFIABLE_ALARM_MIN_SESSIONS = 20;

export const SESSION_GAP_SEC = 120;
export const CLASSIFIER_NAME = "llm-sonnet";
const DEFAULT_SINCE_DAYS_BACK = 30;
const DEFAULT_SESSION_LIMIT = 200;

export interface Tier2Event {
  id: string;
  device: string;
  app: string | null;
  title: string | null;
  url: string | null;
  ts_start: Date;
  duration_sec: number;
}

export interface Session {
  device: string;
  app: string;
  startTs: Date;
  endTs: Date;
  totalDurationSec: number;
  events: Tier2Event[];
}

export interface ClassificationVerdict {
  is_low_value: boolean;
  reason: string;
  confidence: number;
}

export interface ClassifyRunSummary {
  candidate_events: number;
  sessions: number;
  classified: number;
  skipped_unclassifiable: number;
  /** Subset of skipped_unclassifiable whose app is NOT counted by another path
   *  (i.e. not in CONFIG.tier2AltCountedApps / tier2HeuristicFractions). Only
   *  these indicate a real regression of a title-bearing source — the
   *  unclassifiable alarm fires on this count, not the total. */
  skipped_unclassifiable_unexpected: number;
  skipped_already_classified: number;
  errors: number;
  tokens_in: number;
  tokens_out: number;
  est_cost_usd: number;
  dry_run: boolean;
}

/**
 * Build the tier-2 candidate WHERE clause and bindings.
 * @param prefix column-alias prefix, e.g. "e." or "" — emitted before `app`/`url`.
 */
function buildTier2Predicate(prefix: string): { clause: string; bindings: Record<string, unknown> } {
  const bindings: Record<string, unknown> = {};
  const appPh: string[] = [];
  CONFIG.tier2Apps.forEach((app, i) => {
    const k = `t2app${i}`;
    bindings[k] = app.toLowerCase();
    appPh.push(`$${k}`);
  });
  const appClause = appPh.length ? `lower(${prefix}app) IN (${appPh.join(", ")})` : "FALSE";

  const urlClauses: string[] = [];
  CONFIG.tier2DomainPatterns.forEach((pat, i) => {
    const k = `t2urlpat${i}`;
    bindings[k] = pat;
    urlClauses.push(`${prefix}url ILIKE $${k}`);
  });
  const urlClause = urlClauses.length ? `(${urlClauses.join(" OR ")})` : "FALSE";

  return {
    clause: `(${appClause} OR ${urlClause})`,
    bindings,
  };
}

/**
 * Load Tier-2 candidate events on or after `sinceDate`. If `excludeClassified`
 * is true, skip events that already have a classifications row.
 */
export async function loadTier2Events(
  db: Db,
  sinceDate: string,
  excludeClassified: boolean,
): Promise<Tier2Event[]> {
  const { clause, bindings } = buildTier2Predicate("e.");
  const allBindings: Record<string, unknown> = { ...bindings, since: sinceDate };
  const excludeJoin = excludeClassified
    ? `LEFT JOIN classifications c ON c.event_id = e.id WHERE c.event_id IS NULL AND `
    : `WHERE `;

  const sql = `
    SELECT e.id AS id, e.device AS device, e.app AS app, e.title AS title,
           e.url AS url, e.ts_start AS ts_start, e.duration_sec AS duration_sec
      FROM events e
      ${excludeJoin}
            CAST(e.ts_start AT TIME ZONE 'UTC' AT TIME ZONE '${CONFIG.localTimezone}' AS DATE) >= $since::DATE
        AND ${clause}
     ORDER BY e.device, e.app, e.ts_start
  `;

  return db.queryAll<Tier2Event>(sql, allBindings);
}

/**
 * Group tier-2 events into sessions: same device + same app, with adjacent
 * events separated by ≤ SESSION_GAP_SEC. Events with null app are dropped
 * (cannot be sessionized meaningfully).
 */
export function groupIntoSessions(events: Tier2Event[]): Session[] {
  const sessions: Session[] = [];
  let cur: Session | null = null;

  // Defensive sort — caller may have sorted, but groupIntoSessions is a pure helper.
  const sorted = [...events]
    .filter(e => e.app != null)
    .sort((a, b) => {
      if (a.device !== b.device) return a.device < b.device ? -1 : 1;
      const aa = a.app ?? "";
      const ba = b.app ?? "";
      if (aa !== ba) return aa < ba ? -1 : 1;
      return new Date(a.ts_start).getTime() - new Date(b.ts_start).getTime();
    });

  for (const ev of sorted) {
    const evStart = new Date(ev.ts_start);
    const evEnd = new Date(evStart.getTime() + ev.duration_sec * 1000);
    if (
      cur &&
      cur.device === ev.device &&
      cur.app === ev.app &&
      (evStart.getTime() - cur.endTs.getTime()) / 1000 <= SESSION_GAP_SEC
    ) {
      cur.events.push(ev);
      cur.totalDurationSec += ev.duration_sec;
      if (evEnd > cur.endTs) cur.endTs = evEnd;
    } else {
      cur = {
        device: ev.device,
        app: ev.app as string,
        startTs: evStart,
        endTs: evEnd,
        totalDurationSec: ev.duration_sec,
        events: [ev],
      };
      sessions.push(cur);
    }
  }
  return sessions;
}

/** A session is classifiable if at least one event has a non-empty title or url. */
export function isClassifiable(session: Session): boolean {
  return session.events.some(e =>
    (typeof e.title === "string" && e.title.trim().length > 0) ||
    (typeof e.url === "string" && e.url.trim().length > 0),
  );
}

const SYSTEM_PROMPT = `You classify a single media-consumption session into low-value or not low-value, from the perspective of a focused engineer trying to reduce passive entertainment.

Definitions:
- "low-value" = entertainment, infinite-scroll feeds, mindless distraction, celebrity gossip, gaming streams, drama channels, reaction videos, comedy shorts.
- "not low-value" = educational content, software/engineering tutorials, technical talks, language learning, news/journalism with substance, podcasts on craft/science/business, anything genuinely informative or skill-building.

When unsure or context is sparse, prefer "not low-value" (false negative is cheaper than false positive — we don't want to penalize learning).

This is a single session window — a small sample; judge only the value of this window, and do not infer Jm's overall habits, character, focus, or trajectory from it.

Respond ONLY with a single JSON object, no prose, no markdown fence, exactly this schema:
{ "is_low_value": <bool>, "reason": "<one short sentence>", "confidence": <number 0-1> }`;

function summarizeSession(session: Session): string {
  const titles = Array.from(new Set(session.events.map(e => e.title).filter((t): t is string => !!t && t.trim().length > 0)));
  const urls = Array.from(new Set(session.events.map(e => e.url).filter((u): u is string => !!u && u.trim().length > 0)));
  const minutes = (session.totalDurationSec / 60).toFixed(1);
  const lines: string[] = [
    `device: ${session.device}`,
    `app: ${session.app}`,
    `duration_min: ${minutes}`,
    `event_count: ${session.events.length}`,
  ];
  if (titles.length > 0) lines.push(`titles:`, ...titles.slice(0, 12).map(t => `  - ${t.slice(0, 200)}`));
  if (urls.length > 0) lines.push(`urls:`, ...urls.slice(0, 12).map(u => `  - ${u.slice(0, 200)}`));
  return lines.join("\n");
}

/**
 * Validate raw LLM JSON into a typed verdict, throwing on shape mismatch.
 */
function parseVerdict(raw: unknown): ClassificationVerdict {
  if (raw == null || typeof raw !== "object") throw new Error("classifier response not an object");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.is_low_value !== "boolean") throw new Error("is_low_value missing or not boolean");
  const reason = typeof obj.reason === "string" ? obj.reason : "";
  let confidence = typeof obj.confidence === "number" ? obj.confidence : 0;
  if (!Number.isFinite(confidence)) confidence = 0;
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;
  return { is_low_value: obj.is_low_value, reason, confidence };
}

export async function classifySession(session: Session): Promise<{ verdict: ClassificationVerdict; tokensIn: number; tokensOut: number; estCostUSD: number }> {
  const result = await inference({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: summarizeSession(session),
    level: "standard",
    expectJson: true,
  });
  if (!result.success || result.parsed === undefined) {
    throw new Error(`inference failed: ${result.error ?? "no parsed output"}`);
  }
  const verdict = parseVerdict(result.parsed);
  return {
    verdict,
    tokensIn: result.estimatedTokens.input,
    tokensOut: result.estimatedTokens.output,
    estCostUSD: result.estimatedCostUSD,
  };
}

export async function upsertClassification(
  db: Db,
  session: Session,
  verdict: ClassificationVerdict,
): Promise<void> {
  const now = new Date().toISOString();
  for (const ev of session.events) {
    await db.run(
      `INSERT OR REPLACE INTO classifications
       (event_id, tier, classifier, is_low_value, reason, classified_at)
       VALUES ($id, 2, $classifier, $low, $reason, $ts::TIMESTAMP)`,
      {
        id: ev.id,
        classifier: CLASSIFIER_NAME,
        low: verdict.is_low_value,
        reason: verdict.reason,
        ts: now,
      },
    );
  }
}

export interface ClassifyAllOpts {
  sinceDate?: string;
  limit?: number;
  force?: boolean;
  dryRun?: boolean;
}

export async function classifyAll(db: Db, opts: ClassifyAllOpts = {}): Promise<ClassifyRunSummary> {
  const sinceDate = opts.sinceDate ?? shiftDate(todayLocal(), -DEFAULT_SINCE_DAYS_BACK);
  const limit = opts.limit ?? DEFAULT_SESSION_LIMIT;
  const force = opts.force ?? false;
  const dryRun = opts.dryRun ?? false;

  const events = await loadTier2Events(db, sinceDate, !force);
  const sessions = groupIntoSessions(events);

  const summary: ClassifyRunSummary = {
    candidate_events: events.length,
    sessions: sessions.length,
    classified: 0,
    skipped_unclassifiable: 0,
    skipped_unclassifiable_unexpected: 0,
    skipped_already_classified: 0, // already filtered at SQL level when !force
    errors: 0,
    tokens_in: 0,
    tokens_out: 0,
    est_cost_usd: 0,
    dry_run: dryRun,
  };

  // Apps whose unclassifiable sessions are EXPECTED (counted elsewhere or deemed
  // not-low-value) and therefore must not trip the unclassifiable alarm.
  // Heuristic-fraction apps are folded in so adding one auto-suppresses it.
  const altCounted = new Set<string>([
    ...CONFIG.tier2AltCountedApps.map(a => a.toLowerCase()),
    ...Object.keys(CONFIG.tier2HeuristicFractions).map(a => a.toLowerCase()),
  ]);

  for (const session of sessions) {
    if (summary.classified >= limit) break;
    if (!isClassifiable(session)) {
      summary.skipped_unclassifiable++;
      if (!altCounted.has(session.app.toLowerCase())) {
        summary.skipped_unclassifiable_unexpected++;
      }
      continue;
    }
    if (dryRun) {
      summary.classified++;
      continue;
    }
    try {
      const { verdict, tokensIn, tokensOut, estCostUSD } = await classifySession(session);
      await upsertClassification(db, session, verdict);
      summary.classified++;
      summary.tokens_in += tokensIn;
      summary.tokens_out += tokensOut;
      summary.est_cost_usd += estCostUSD;
    } catch (err) {
      summary.errors++;
      await logFailure("Classifier", err, {
        device: session.device,
        app: session.app,
        startTs: session.startTs.toISOString(),
        events: session.events.length,
      });
    }
  }

  return summary;
}

async function main(argv: string[]): Promise<void> {
  const force = argv.includes("--force");
  const json = argv.includes("--json");
  const dryRun = argv.includes("--dry-run");
  const sinceFlag = argv.find(a => a.startsWith("--since="))?.slice("--since=".length);
  const limitFlag = argv.find(a => a.startsWith("--limit="))?.slice("--limit=".length);
  const limit = limitFlag ? parseInt(limitFlag, 10) : undefined;

  const db = await Db.open();
  try {
    await db.initSchema();
    const summary = await classifyAll(db, { sinceDate: sinceFlag, limit, force, dryRun });
    // Alarm on the silent design failure: a title-bearing source went dark, so
    // sessions that SHOULD be classifiable have no title/url. This was the bug
    // that hid for weeks. We count only sessions whose app is not already
    // counted by another path (tier2AltCountedApps / tier2HeuristicFractions) —
    // otherwise metadata-less phone apps (YouTube/WhatsApp/Messages/LinkedIn/
    // Nebula), which are counted via watch-history or the heuristic fraction,
    // would false-fire this every single night.
    if (!dryRun
        && summary.classified === 0
        && summary.skipped_unclassifiable_unexpected >= UNCLASSIFIABLE_ALARM_MIN_SESSIONS) {
      await logFailure(
        "Classifier",
        new Error(`${summary.skipped_unclassifiable_unexpected} sessions expected to be classifiable had no title/url — a title-bearing watcher may have regressed (install aw-watcher-web or check the desktop pipeline)`),
        { sessions: summary.sessions, candidates: summary.candidate_events, unexpected: summary.skipped_unclassifiable_unexpected },
      );
    }
    if (json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      const tag = dryRun ? "DRY-RUN " : "";
      console.log(`${tag}Classifier run: ${summary.candidate_events} candidate events → ${summary.sessions} sessions`);
      console.log(`  classified=${summary.classified}  unclassifiable=${summary.skipped_unclassifiable}  errors=${summary.errors}`);
      if (!dryRun) {
        console.log(`  tokens in=${summary.tokens_in} out=${summary.tokens_out}  est_cost=$${summary.est_cost_usd.toFixed(4)}`);
      }
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) main(process.argv.slice(2)).catch(err => {
  console.error(err);
  process.exit(1);
});
