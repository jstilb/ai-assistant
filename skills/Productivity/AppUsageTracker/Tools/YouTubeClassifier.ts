#!/usr/bin/env bun
/**
 * YouTubeClassifier.ts — per-video low-value classification.
 *
 * Loads videos with both (a) a youtube_history row (meaning Jm actually
 * opened it) and (b) youtube_videos metadata (enriched, not error'd), but no
 * verdict yet. Sends each to Sonnet (default) via DI'd LLM. Caches verdicts
 * in youtube_verdicts; one row per video_id.
 *
 * The LLM is dependency-injected (see `YouTubeLlmClassifier`) so tests can
 * stub without invoking `claude -p`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Db, logFailure } from "./Db.ts";
import { inference } from "~/.claude/lib/core/Inference.ts";

const LLM_CLASSIFIER_NAME = "llm-sonnet";
const DEFAULT_LIMIT = 200;

export interface YouTubeVerdict {
  is_low_value: boolean;
  reason: string;
  confidence: number;
}

export interface YouTubeLlmInput {
  video_id: string;
  title: string | null;
  channel: string | null;
  duration_sec: number | null;
  category_id: number | null;
  tags: string[];
}

export interface YouTubeLlmResult {
  verdict: YouTubeVerdict;
  tokensIn: number;
  tokensOut: number;
  estCostUSD: number;
}

export type YouTubeLlmClassifier = (input: YouTubeLlmInput) => Promise<YouTubeLlmResult>;

export interface YouTubeClassifyOpts {
  db: Db;
  llm?: YouTubeLlmClassifier;
  limit?: number;
  force?: boolean;
  dryRun?: boolean;
}

export interface YouTubeClassifySummary {
  candidate_videos: number;
  classified: number;
  skipped_already: number;
  skipped_no_metadata: number;
  would_call_llm: number;
  errors: number;
  tokens_in: number;
  tokens_out: number;
  est_cost_usd: number;
  dry_run: boolean;
}

const SYSTEM_PROMPT = `You classify a single YouTube video into low-value vs not-low-value, from the perspective of a focused engineer trying to reduce passive entertainment.

Definitions:
- "low-value" = entertainment, shorts, vlogs, reaction videos, gaming streams, drama channels, celebrity gossip, comedy shorts, mindless distraction.
- "not low-value" = engineering / software tutorials, technical talks, documentaries, language learning, substantive journalism, podcasts on craft/science/business, anything genuinely educational or skill-building.

When unsure, prefer "not low-value" (false negative is cheaper than false positive — we don't want to penalize learning).

This is a single video — a small sample; judge only the value of this video, and do not infer Jm's overall viewing habits, character, focus, or trajectory from it.

Respond ONLY with a single JSON object (no prose, no fence) of this exact shape:
{ "is_low_value": <bool>, "reason": "<one short sentence>", "confidence": <number 0-1> }`;

// ---------------------------------------------------------------------------
// Calibration guidance — MediaValueRubric.md is read AT RUN TIME (same pattern
// as YouTubeCuration's Rubric.md → SeedSourcer): editing the rubric changes
// classification with zero code edits. The weekly calibration loop
// (CalibrationSampler.ts + Jm's review sheets) maintains that section.
// ---------------------------------------------------------------------------

const DEFAULT_RUBRIC_PATH = join(import.meta.dir, "..", "MediaValueRubric.md");
const GUIDANCE_HEADING = "## Classification guidance";

/**
 * Extract the `## Classification guidance` section body from MediaValueRubric.md.
 * Fails loud (before any LLM spend) if the file or section is missing — the
 * rubric ships with the code, so absence means a broken checkout, not an
 * optional feature.
 */
export function readCalibrationGuidance(rubricPath: string = DEFAULT_RUBRIC_PATH): string {
  let markdown: string;
  try {
    markdown = readFileSync(rubricPath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`YouTubeClassifier: cannot read rubric at ${rubricPath} — ${msg}`);
  }
  const lines = markdown.split("\n");
  const start = lines.findIndex(l => l.trim() === GUIDANCE_HEADING);
  if (start === -1) {
    throw new Error(`YouTubeClassifier: rubric at ${rubricPath} has no "${GUIDANCE_HEADING}" section`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(l => /^##\s/.test(l));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  if (body.length === 0) {
    throw new Error(`YouTubeClassifier: "${GUIDANCE_HEADING}" section in ${rubricPath} is empty`);
  }
  return body;
}

export function buildSystemPrompt(rubricPath: string = DEFAULT_RUBRIC_PATH): string {
  const guidance = readCalibrationGuidance(rubricPath);
  return `${SYSTEM_PROMPT}

Calibration guidance from Jm's review rounds (overrides the definitions above wherever they conflict):
${guidance}`;
}

// Read once per process — the nightly run classifies up to 300 videos and the
// rubric cannot change mid-run in any way we'd want to honor.
let cachedSystemPrompt: string | null = null;

interface CandidateRow {
  video_id: string;
  title: string | null;
  channel: string | null;
  channel_id: string | null;
  duration_sec: number | null;
  category_id: number | null;
  tags_json: string | null;
  enrich_error: string | null;
  has_verdict: boolean;
}

async function loadCandidates(db: Db): Promise<CandidateRow[]> {
  // Ordered most-recently-watched first so a capped run (--limit) always
  // classifies the videos that move recent daily_metrics, and the nightly
  // backlog drains newest→oldest. video_id is a stable tiebreaker.
  const sql = `
    SELECT v.video_id      AS video_id,
           v.title          AS title,
           v.channel        AS channel,
           v.channel_id     AS channel_id,
           v.duration_sec   AS duration_sec,
           v.category_id    AS category_id,
           v.tags_json      AS tags_json,
           v.enrich_error   AS enrich_error,
           EXISTS (SELECT 1 FROM youtube_verdicts vd WHERE vd.video_id = v.video_id) AS has_verdict
      FROM youtube_videos v
      JOIN (
        SELECT video_id, MAX(ts) AS last_watched
          FROM youtube_history
         GROUP BY video_id
      ) h ON h.video_id = v.video_id
     ORDER BY h.last_watched DESC, v.video_id
  `;
  const rows = await db.queryAll<CandidateRow>(sql);
  return rows.map(r => ({ ...r, has_verdict: Boolean(r.has_verdict) }));
}

async function upsertVerdict(
  db: Db, videoId: string, verdict: YouTubeVerdict, classifier: string,
): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO youtube_verdicts
       (video_id, is_low_value, reason, confidence, classifier, classified_at)
     VALUES ($id, $low, $reason, $conf, $cls, $now::TIMESTAMP)`,
    {
      id: videoId, low: verdict.is_low_value, reason: verdict.reason,
      conf: verdict.confidence, cls: classifier, now: new Date().toISOString(),
    },
  );
}

export const defaultYouTubeClassifier: YouTubeLlmClassifier = async (input) => {
  const userPrompt = JSON.stringify({
    video_id: input.video_id,
    title: input.title,
    channel: input.channel,
    duration_minutes: input.duration_sec != null ? Math.round(input.duration_sec / 60) : null,
    category_id: input.category_id,
    tags: (input.tags ?? []).slice(0, 6),
  });
  if (cachedSystemPrompt == null) cachedSystemPrompt = buildSystemPrompt();
  const result = await inference({
    systemPrompt: cachedSystemPrompt,
    userPrompt,
    level: "standard",
    expectJson: true,
    // Per-video classification is one disposable `claude -p` call with no
    // side effects, so it is safe to re-run. The overwhelming failure mode in
    // the failure log was `Timeout after 90000ms` on 145 *distinct* videos
    // (not video-specific) — i.e. transient `claude -p` stalls (post-sleep
    // dead sockets, network blips, credit-pool pauses), exactly what a fresh
    // subprocess recovers. Without retry each stall permanently dropped that
    // video for the night. The 1800s step cap still bounds a sustained outage.
    retries: 2,
    retryDelayMs: 2000,
  });
  if (!result.success || result.parsed == null) {
    throw new Error(`inference failed: ${result.error ?? "no parsed output"}`);
  }
  const raw = result.parsed as Record<string, unknown>;
  if (typeof raw.is_low_value !== "boolean") {
    throw new Error("classifier response missing is_low_value bool");
  }
  let confidence = typeof raw.confidence === "number" ? raw.confidence : 0;
  if (!Number.isFinite(confidence)) confidence = 0;
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;
  return {
    verdict: {
      is_low_value: raw.is_low_value,
      reason: typeof raw.reason === "string" ? raw.reason : "",
      confidence,
    },
    tokensIn: result.estimatedTokens.input,
    tokensOut: result.estimatedTokens.output,
    estCostUSD: result.estimatedCostUSD,
  };
};

export async function classifyYouTubeVideos(opts: YouTubeClassifyOpts): Promise<YouTubeClassifySummary> {
  const llm = opts.llm ?? defaultYouTubeClassifier;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const force = opts.force ?? false;
  const dryRun = opts.dryRun ?? false;

  await opts.db.initSchema();
  const candidates = await loadCandidates(opts.db);

  const summary: YouTubeClassifySummary = {
    candidate_videos: candidates.length,
    classified: 0,
    skipped_already: 0,
    skipped_no_metadata: 0,
    would_call_llm: 0,
    errors: 0,
    tokens_in: 0,
    tokens_out: 0,
    est_cost_usd: 0,
    dry_run: dryRun,
  };

  for (const row of candidates) {
    if (row.has_verdict && !force) {
      summary.skipped_already++;
      continue;
    }
    // Need at least a title to classify meaningfully. enrich_error rows are
    // for videos the API couldn't find (deleted/private/wrong-key) — skip them.
    if (row.enrich_error != null || (row.title == null || row.title.length === 0)) {
      summary.skipped_no_metadata++;
      continue;
    }
    if (summary.classified >= limit) continue;
    if (dryRun) { summary.would_call_llm++; continue; }

    let tags: string[] = [];
    if (row.tags_json) {
      try {
        const parsed: unknown = JSON.parse(row.tags_json);
        if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string");
      } catch { /* ignore — empty tags */ }
    }
    try {
      const r = await llm({
        video_id: row.video_id,
        title: row.title,
        channel: row.channel,
        duration_sec: row.duration_sec != null ? Number(row.duration_sec) : null,
        category_id: row.category_id != null ? Number(row.category_id) : null,
        tags,
      });
      await upsertVerdict(opts.db, row.video_id, r.verdict, LLM_CLASSIFIER_NAME);
      summary.classified++;
      summary.tokens_in += r.tokensIn;
      summary.tokens_out += r.tokensOut;
      summary.est_cost_usd += r.estCostUSD;
    } catch (err) {
      summary.errors++;
      await logFailure("YouTubeClassifier", err, { video_id: row.video_id });
    }
  }

  return summary;
}

async function main(argv: string[]): Promise<void> {
  const json = argv.includes("--json");
  const force = argv.includes("--force");
  const dryRun = argv.includes("--dry-run");
  const limitFlag = argv.find(a => a.startsWith("--limit="))?.slice("--limit=".length);
  const limit = limitFlag ? parseInt(limitFlag, 10) : undefined;

  const db = await Db.open();
  try {
    await db.initSchema();
    const summary = await classifyYouTubeVideos({ db, force, dryRun, limit });
    if (json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      const tag = dryRun ? "DRY-RUN " : "";
      console.log(`${tag}YouTubeClassifier: ${summary.candidate_videos} candidates`);
      console.log(`  classified=${summary.classified}  skipped_already=${summary.skipped_already}  no_metadata=${summary.skipped_no_metadata}  errors=${summary.errors}`);
      if (dryRun) console.log(`  would_call_llm=${summary.would_call_llm}`);
      if (!dryRun) console.log(`  tokens in=${summary.tokens_in} out=${summary.tokens_out}  est_cost=$${summary.est_cost_usd.toFixed(4)}`);
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) main(process.argv.slice(2)).catch(err => {
  console.error(err);
  process.exit(1);
});
