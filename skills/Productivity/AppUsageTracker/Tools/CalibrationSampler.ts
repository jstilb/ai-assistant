#!/usr/bin/env bun
/**
 * CalibrationSampler.ts — stratified samples of classified YouTube videos for
 * Jm's weekly media-value calibration review.
 *
 * The G37 low-value metric and the /youtube curation rubric both rest on LLM
 * judgment that Jm has never systematically audited. This tool draws a
 * stratified sample from youtube_verdicts (confident-low / confident-high /
 * borderline), renders a review sheet into the Obsidian vault, and records the
 * sampled ids so later rounds never repeat a video. Jm fills in the sheet; the
 * recurring calibration task interprets his feedback (LLM judgment, not a
 * parser), writes explicit corrections back via `apply-verdict`, and distills
 * patterns into MediaValueRubric.md / YouTubeCuration's Rubric.md.
 *
 * Commands:
 *   (default)        generate the next round's review sheet
 *     --per-stratum=N   rows per stratum (default 8 → 24-row sheet)
 *     --recent-days=N   prefer videos watched in the last N days (default 90)
 *     --out=PATH        override sheet path
 *     --dry-run         print the sample, write nothing
 *     --json            machine-readable summary
 *   apply-verdict    write one Jm ground-truth verdict
 *     --video=ID --value=low|high [--reason="..."]
 *
 * Reads events.db READ-ONLY for sampling; apply-verdict takes a brief
 * read-write open. State: MEMORY/AppUsage/calibration/rounds.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG } from "../Config.ts";
import { Db } from "./Db.ts";

const HOME = process.env.HOME ?? "/Users/[user]";
const DEFAULT_STATE_PATH = `${HOME}/.claude/MEMORY/AppUsage/calibration/rounds.json`;
const DEFAULT_SHEET_DIR = `${HOME}/Desktop/obsidian/POS/Reviews/YouTube Calibration`;

const CONF_CONFIDENT = 0.75;   // >= → "confident" strata; < → borderline
const DEFAULT_PER_STRATUM = 8;
const DEFAULT_RECENT_DAYS = 90;
const MAX_PER_CHANNEL = 2;     // per stratum — stop one binge channel dominating

export type StratumKey = "confident-low" | "confident-high" | "borderline";

export interface SampleRow {
  video_id: string;
  title: string;
  channel: string | null;
  duration_sec: number | null;
  last_watched: string;        // ISO timestamp
  is_low_value: boolean;
  confidence: number;
  reason: string | null;
  classifier: string;
}

export interface RoundRecord {
  round: number;
  generated_at: string;
  sheet_path: string;
  video_ids: string[];
}

export interface CalibrationState { rounds: RoundRecord[] }

export function loadState(statePath: string = DEFAULT_STATE_PATH): CalibrationState {
  if (!existsSync(statePath)) return { rounds: [] };
  const raw: unknown = JSON.parse(readFileSync(statePath, "utf8"));
  if (typeof raw !== "object" || raw == null || !Array.isArray((raw as CalibrationState).rounds)) {
    throw new Error(`CalibrationSampler: malformed state at ${statePath}`);
  }
  return raw as CalibrationState;
}

export function saveState(state: CalibrationState, statePath: string = DEFAULT_STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}

interface VerdictRow {
  video_id: string;
  title: string | null;
  channel: string | null;
  duration_sec: number | bigint | null;
  is_low_value: boolean;
  confidence: number | null;
  reason: string | null;
  classifier: string;
  last_watched: string | Date;
}

async function loadClassified(db: Db): Promise<SampleRow[]> {
  const rows = await db.queryAll<VerdictRow>(`
    SELECT vd.video_id                AS video_id,
           v.title                    AS title,
           v.channel                  AS channel,
           v.duration_sec             AS duration_sec,
           vd.is_low_value            AS is_low_value,
           vd.confidence              AS confidence,
           vd.reason                  AS reason,
           vd.classifier              AS classifier,
           strftime(h.last_watched, '%Y-%m-%dT%H:%M:%SZ') AS last_watched
      FROM youtube_verdicts vd
      JOIN youtube_videos v ON v.video_id = vd.video_id
      JOIN (SELECT video_id, MAX(ts) AS last_watched
              FROM youtube_history GROUP BY video_id) h
        ON h.video_id = vd.video_id
     WHERE v.title IS NOT NULL AND length(v.title) > 0
  `);
  return rows.map(r => ({
    video_id: r.video_id,
    title: r.title ?? "",
    channel: r.channel,
    duration_sec: r.duration_sec == null ? null : Number(r.duration_sec),
    is_low_value: Boolean(r.is_low_value),
    confidence: r.confidence == null ? 0 : Number(r.confidence),
    reason: r.reason,
    classifier: r.classifier,
    last_watched: typeof r.last_watched === "string" ? r.last_watched : r.last_watched.toISOString(),
  }));
}

export function stratumOf(row: SampleRow): StratumKey {
  if (row.confidence < CONF_CONFIDENT) return "borderline";
  return row.is_low_value ? "confident-low" : "confident-high";
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Pick up to `n` rows from a stratum pool: prefer videos watched within
 * `recentDays` (they drive the current metric), cap MAX_PER_CHANNEL per
 * channel, backfill from older videos if the recent pool runs short.
 * `now`/`rng` injectable for tests.
 */
export function pickForStratum(
  pool: SampleRow[], n: number, recentDays: number,
  rng: () => number = Math.random, now: Date = new Date(),
): SampleRow[] {
  const cutoff = now.getTime() - recentDays * 24 * 3600 * 1000;
  const recent = pool.filter(r => Date.parse(r.last_watched) >= cutoff);
  const older = pool.filter(r => Date.parse(r.last_watched) < cutoff);
  const picked: SampleRow[] = [];
  const perChannel = new Map<string, number>();
  for (const candidate of [...shuffle(recent, rng), ...shuffle(older, rng)]) {
    if (picked.length >= n) break;
    const ch = (candidate.channel ?? "").toLowerCase();
    const used = perChannel.get(ch) ?? 0;
    if (used >= MAX_PER_CHANNEL) continue;
    perChannel.set(ch, used + 1);
    picked.push(candidate);
  }
  // Sheet reads best sorted by recency within the stratum.
  return picked.sort((a, b) => Date.parse(b.last_watched) - Date.parse(a.last_watched));
}

export interface SamplePlan {
  round: number;
  strata: Record<StratumKey, SampleRow[]>;
  poolSizes: Record<StratumKey, number>;
  excluded: number;
}

export function buildSample(
  all: SampleRow[], previouslySampled: Set<string>, perStratum: number,
  recentDays: number, round: number,
  rng: () => number = Math.random, now: Date = new Date(),
): SamplePlan {
  // Never resample a video from an earlier round, and never surface Jm's own
  // jm-calibration verdicts back to him.
  const eligible = all.filter(r => !previouslySampled.has(r.video_id) && r.classifier !== "jm-calibration");
  const pools: Record<StratumKey, SampleRow[]> = {
    "confident-low": [], "confident-high": [], "borderline": [],
  };
  for (const row of eligible) pools[stratumOf(row)].push(row);
  return {
    round,
    strata: {
      "confident-low": pickForStratum(pools["confident-low"], perStratum, recentDays, rng, now),
      "confident-high": pickForStratum(pools["confident-high"], perStratum, recentDays, rng, now),
      "borderline": pickForStratum(pools["borderline"], perStratum, recentDays, rng, now),
    },
    poolSizes: {
      "confident-low": pools["confident-low"].length,
      "confident-high": pools["confident-high"].length,
      "borderline": pools["borderline"].length,
    },
    excluded: all.length - eligible.length,
  };
}

const STRATUM_META: Record<StratumKey, { title: string; blurb: string }> = {
  "confident-low": {
    title: "Confidently LOW-value",
    blurb: "Kaya is sure these were low-value watches (they count fully against G37). Scan for anything that was actually worthwhile.",
  },
  "confident-high": {
    title: "Confidently NOT low-value",
    blurb: "Kaya is sure these were worthwhile (they count zero against G37). Scan for entertainment that slipped through — this is where the metric under-counts.",
  },
  "borderline": {
    title: "Borderline (low confidence)",
    blurb: "Kaya was unsure. Your calls here teach the rubric the most.",
  },
};

function esc(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function fmtMin(durationSec: number | null): string {
  if (durationSec == null) return "?";
  return String(Math.max(1, Math.round(durationSec / 60)));
}

export function renderSheet(plan: SamplePlan, generatedAt: Date): string {
  const date = generatedAt.toISOString().slice(0, 10);
  const total = (Object.values(plan.strata) as SampleRow[][]).reduce((n, rows) => n + rows.length, 0);
  const lines: string[] = [];
  lines.push("---");
  lines.push(`round: ${plan.round}`);
  lines.push(`generated: ${date}`);
  lines.push(`videos: ${total}`);
  lines.push("status: awaiting-review");
  lines.push("---");
  lines.push("");
  lines.push(`# YouTube Media-Value Calibration — Round ${plan.round}`);
  lines.push("");
  lines.push("These are Kaya's actual classifications of videos **you watched** — the same verdicts that produce the G37 low-value-media number and inform /youtube playlist curation. ~10 minutes: fix what's wrong, skip what's right.");
  lines.push("");
  lines.push("**How to review each row:**");
  lines.push("- Agree → leave **Your call** blank.");
  lines.push("- Disagree → put `low` or `high` in **Your call** (`low` = counts against G37, `high` = worthwhile). Add a note if the *reason* matters (\"this channel is always junk\", \"gaming is fine in this context\", ...). Notes teach the rubric; bare overrides only fix the one video.");
  lines.push("");
  lines.push("When done, change `status: awaiting-review` to `status: reviewed` in the frontmatter above (that's the signal the next round picks up). The weekly calibration task then writes your overrides into `youtube_verdicts` as ground truth and distills patterns into the classifier rubric.");
  lines.push("");
  for (const key of ["confident-low", "confident-high", "borderline"] as StratumKey[]) {
    const meta = STRATUM_META[key];
    const rows = plan.strata[key];
    lines.push(`## ${meta.title} (${rows.length})`);
    lines.push("");
    lines.push(meta.blurb);
    lines.push("");
    if (rows.length === 0) {
      lines.push("_(no unsampled videos left in this stratum)_");
      lines.push("");
      continue;
    }
    lines.push("| Video | Channel | Min | Watched | Kaya's verdict | Conf | Kaya's reason | Your call | Notes |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const r of rows) {
      const link = `[${esc(r.title)}](https://www.youtube.com/watch?v=${r.video_id})`;
      const verdict = r.is_low_value ? "low" : "high";
      lines.push(`| ${link} | ${esc(r.channel ?? "?")} | ${fmtMin(r.duration_sec)} | ${r.last_watched.slice(0, 10)} | ${verdict} | ${r.confidence.toFixed(2)} | ${esc(r.reason ?? "")} | | |`);
    }
    lines.push("");
  }
  lines.push("## General feedback (optional, highest leverage)");
  lines.push("");
  lines.push("Anything rubric-level: channels or genres to always/never count, how to treat Shorts, music, podcasts, rewatches, \"edutainment\", etc. Free-form — the calibration task reads this with judgment, not a parser.");
  lines.push("");
  lines.push("- ");
  lines.push("");
  return lines.join("\n");
}

export function sheetVideoIds(plan: SamplePlan): string[] {
  return (Object.values(plan.strata) as SampleRow[][]).flat().map(r => r.video_id);
}

// ---------------------------------------------------------------------------
// apply-verdict — Jm ground-truth upsert
// ---------------------------------------------------------------------------

export async function applyJmVerdict(
  db: Db, videoId: string, value: "low" | "high", reason: string,
): Promise<{ previous: { is_low_value: boolean; classifier: string } | null }> {
  const prev = await db.queryRow<{ is_low_value: boolean; classifier: string }>(
    `SELECT is_low_value, classifier FROM youtube_verdicts WHERE video_id = $id`, { id: videoId },
  );
  await db.run(
    `INSERT OR REPLACE INTO youtube_verdicts
       (video_id, is_low_value, reason, confidence, classifier, classified_at)
     VALUES ($id, $low, $reason, 1.0, 'jm-calibration', $now::TIMESTAMP)`,
    { id: videoId, low: value === "low", reason, now: new Date().toISOString() },
  );
  return { previous: prev ? { is_low_value: Boolean(prev.is_low_value), classifier: prev.classifier } : null };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function flagValue(argv: string[], name: string): string | undefined {
  return argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function mainGenerate(argv: string[]): Promise<void> {
  const json = argv.includes("--json");
  const dryRun = argv.includes("--dry-run");
  const perStratum = parseInt(flagValue(argv, "per-stratum") ?? String(DEFAULT_PER_STRATUM), 10);
  const recentDays = parseInt(flagValue(argv, "recent-days") ?? String(DEFAULT_RECENT_DAYS), 10);
  const statePath = flagValue(argv, "state") ?? DEFAULT_STATE_PATH;
  const dbPath = flagValue(argv, "db") ?? CONFIG.dbPath;

  const state = loadState(statePath);
  const round = state.rounds.reduce((m, r) => Math.max(m, r.round), 0) + 1;
  const previouslySampled = new Set(state.rounds.flatMap(r => r.video_ids));

  const db = await Db.openReadOnly(dbPath);
  let all: SampleRow[];
  try { all = await loadClassified(db); } finally { db.close(); }

  const now = new Date();
  const plan = buildSample(all, previouslySampled, perStratum, recentDays, round, Math.random, now);
  const total = sheetVideoIds(plan).length;
  const date = now.toISOString().slice(0, 10);
  const outPath = flagValue(argv, "out")
    ?? join(DEFAULT_SHEET_DIR, `Round ${String(plan.round).padStart(2, "0")} — ${date}.md`);

  if (dryRun) {
    if (json) {
      console.log(JSON.stringify({ round, total, poolSizes: plan.poolSizes, excluded: plan.excluded, would_write: outPath }, null, 2));
    } else {
      console.log(`DRY-RUN round ${round}: would sample ${total} videos → ${outPath}`);
      console.log(`  pools: low=${plan.poolSizes["confident-low"]} high=${plan.poolSizes["confident-high"]} borderline=${plan.poolSizes.borderline}  excluded(prior rounds/jm)=${plan.excluded}`);
    }
    return;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, renderSheet(plan, now));
  state.rounds.push({ round, generated_at: now.toISOString(), sheet_path: outPath, video_ids: sheetVideoIds(plan) });
  saveState(state, statePath);

  if (json) {
    console.log(JSON.stringify({ round, total, sheet: outPath, poolSizes: plan.poolSizes, state: statePath }, null, 2));
  } else {
    console.log(`CalibrationSampler: round ${round} — ${total} videos → ${outPath}`);
    console.log(`  pools: low=${plan.poolSizes["confident-low"]} high=${plan.poolSizes["confident-high"]} borderline=${plan.poolSizes.borderline}  excluded(prior rounds/jm)=${plan.excluded}`);
  }
}

async function mainApplyVerdict(argv: string[]): Promise<void> {
  const videoId = flagValue(argv, "video");
  const value = flagValue(argv, "value");
  const reason = flagValue(argv, "reason") ?? "Jm calibration override";
  const dbPath = flagValue(argv, "db") ?? CONFIG.dbPath;
  if (!videoId || (value !== "low" && value !== "high")) {
    console.error(`Usage: CalibrationSampler.ts apply-verdict --video=<id> --value=low|high [--reason="..."]`);
    process.exit(1);
  }
  const db = await Db.open(dbPath);
  try {
    const { previous } = await applyJmVerdict(db, videoId, value, reason);
    const prevStr = previous ? `${previous.is_low_value ? "low" : "high"} (${previous.classifier})` : "none";
    console.log(`apply-verdict ${videoId}: ${prevStr} → ${value} (jm-calibration)`);
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const run = argv[0] === "apply-verdict" ? mainApplyVerdict(argv.slice(1)) : mainGenerate(argv);
  run.catch(err => { console.error(err); process.exit(1); });
}
