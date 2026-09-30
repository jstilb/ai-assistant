/**
 * Ranker.ts — EventScout event ranker (Slice 3 v2: fuller judge context + calibration rubric).
 *
 * Exported API:
 *   buildScoringLine(event, ctx)                    → string  (pure, no I/O)
 *   buildBatchSystemPrompt(brief)                   → string  (pure, no I/O)
 *   buildIntentBrief(constraints, inferFn?)         → Promise<string>
 *   scoreAllEvents(events, constraints, profile, brief, opts?) → Promise<Map<string, number>>
 *   rankEvents(events, constraints, profile, limit?, opts?)   → Promise<RankedEvent[]>
 *
 * Ranking flow:
 *   1. buildIntentBrief  — ONE inference call → compact "what counts as a fit".
 *                          On failure, falls back to raw query text (never throws).
 *   2. scoreAllEvents    — batched LLM scoring (~SCORE_BATCH_SIZE events/call).
 *                          bounded-concurrency pool (SCORE_CONCURRENCY parallel calls).
 *                          Any event the LLM drops → NEUTRAL_SCORE (never omitted).
 *   3. Sort desc by score; tiebreak: sooner startDatetime → nearer location.
 *   4. Why-lines: top WHY_TIER events get one batched LLM call; tail gets fallbackWhy.
 *   5. Return ALL events when limit is undefined/Infinity; slice to limit otherwise.
 *
 * Kill-switch: EVENTSCOUT_DISABLE_RERANK=1 → soonness order + fallbackWhy, no LLM.
 *
 * Testability: pass opts.scoreBatch to inject a deterministic fake scorer.
 */

import { inference } from "../../../../lib/core/Inference.ts";
import type { InferenceResult } from "../../../../lib/core/Inference.ts";
import type { EventItem, QueryContext, InterestProfile } from "./types.ts";
import { loadSources } from "./SourceManager.ts";
import { utcMsToLaParts } from "./lib/tz.ts";
import { z } from "zod";

// ============================================================================
// RankedEvent type
// ============================================================================

export interface RankedEvent extends EventItem {
  score: number;
  why: string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Number of events per LLM scoring batch.
 * Reduced from 75 to 40: Slice 3 scoring lines are ~3-4x larger (full desc, all
 * tags, practical signals), so 40 events/batch stays within a safe ~16k token budget
 * per call at standard model context limits.
 */
export const SCORE_BATCH_SIZE = 40;

/**
 * Score assigned to events the LLM didn't return in its batch response.
 * 0 (lowest possible) so they sort to the tail but are NEVER dropped.
 */
export const NEUTRAL_SCORE = 0;

/**
 * Max concurrent LLM scoring calls. Bounds provider rate-limit exposure.
 * Override via EVENTSCOUT_SCORE_CONCURRENCY env.
 */
const SCORE_CONCURRENCY_DEFAULT = 4;

function scoreConcurrency(): number {
  const raw = process.env["EVENTSCOUT_SCORE_CONCURRENCY"];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : SCORE_CONCURRENCY_DEFAULT;
}

/**
 * How many top events get LLM why-lines. The tail gets a cheap deterministic why.
 */
const WHY_TIER = 15;

// ============================================================================
// Haversine — kept for tiebreak (nearer wins on equal score+date)
// ============================================================================

const EARTH_RADIUS_MILES = 3958.8;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.asin(Math.sqrt(a));
}

// ============================================================================
// Bounded-concurrency worker pool
// ============================================================================

/**
 * Run `worker` over `items` with at most `limit` calls in flight at once.
 * A pull-based worker pool: each lane grabs the next index until the list drains.
 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let idx = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i]!);
    }
  });
  await Promise.all(lanes);
}

// ============================================================================
// ScoreBatchFn — injectable for tests
// ============================================================================

/** Signature for the per-batch scorer. Injected in tests; defaults to real LLM. */
export type ScoreBatchFn = (
  events: EventItem[],
  brief: string,
  constraints: QueryContext
) => Promise<Array<{ id: string; score: number }>>;

export interface RankOpts {
  /** Inject a fake batch scorer (tests only). Defaults to real LLM call. */
  scoreBatch?: ScoreBatchFn;
}

// ============================================================================
// Intent brief (one LLM call per query; shared across all batches)
// ============================================================================

/** Type for the injected inference function (tests can override). */
type InferFn = (opts: {
  systemPrompt: string;
  userPrompt: string;
  level: "standard";
  expectJson: boolean;
  retries: number;
}) => Promise<InferenceResult>;

/**
 * Build a compact "intent brief" describing what the user is really after.
 * This is computed ONCE per query and threaded into every scoring batch so
 * judgments are consistent across batches.
 *
 * On any failure, falls back to the raw query text (never throws).
 *
 * @param constraints - Active QueryContext (rawQuery + structured hard filters).
 * @param inferFn     - Inference function (injectable for tests; defaults to real `inference`).
 */
export async function buildIntentBrief(
  constraints: QueryContext,
  inferFn: InferFn = inference
): Promise<string> {
  const systemPrompt = `You are an event recommendation assistant for a San Diego event discovery app.
Your job: read the user's query and write a compact (2–4 sentence) "intent brief" describing:
- What they're really looking for
- What would count as a strong fit vs a weak fit
Keep it tight and specific. Return ONLY the brief text — no JSON, no headers.`;

  // vibe/who no longer exist as structured fields (that was ConstraintParser's
  // LLM-inferred guess) — the raw query text carries that nuance instead, and
  // the intent-brief LLM call reads it directly below.
  const parts: string[] = [`Query: "${constraints.rawQuery}"`];
  if (constraints.categories?.length) parts.push(`Category: ${constraints.categories.join(", ")}`);

  const userPrompt = parts.join("\n");

  try {
    const result = await inferFn({
      systemPrompt,
      userPrompt,
      level: "standard",
      expectJson: false,
      retries: 2,
    });

    if (result.success && result.output.trim().length > 0) {
      // If inference returned a parsed value (JSON mode), use it; else use raw output.
      if (result.parsed !== undefined && typeof result.parsed === "string" && result.parsed.trim().length > 0) {
        return result.parsed.trim();
      }
      return result.output.trim();
    }
  } catch {
    // fall through to fallback
  }

  console.warn("[Ranker] buildIntentBrief failed — falling back to raw query text");
  return constraints.rawQuery;
}

// ============================================================================
// Scoring schema
// ============================================================================

const ScoreBatchSchema = z.array(
  z.object({
    id: z.string(),
    score: z.number().min(0).max(100),
  })
);

// ============================================================================
// Haversine utility (also used in buildScoringLine distance signal)
// ============================================================================

const EARTH_RADIUS_MILES_SL = 3958.8;

function haversineMilesSL(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_MILES_SL * 2 * Math.asin(Math.sqrt(a));
}

// ============================================================================
// ScoringLineCtx — context for pure buildScoringLine
// ============================================================================

/**
 * Context object passed to buildScoringLine. Pure: caller supplies these;
 * the function does no I/O.
 */
export interface ScoringLineCtx {
  /** User's home/origin coordinates (for distance calculation). */
  home: { lat: number; lng: number };
  /** Current time (for day-of-week and how-soon computation). */
  now: Date;
  /**
   * Map from sourceId to { name, geoHint } — built once per ranking pass from
   * loadSources(). The function uses the event's first source to look up the
   * human-readable name and fallback neighborhood.
   */
  sourceLookup: Map<string, { name: string; geoHint?: string }>;
}

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/**
 * Derive the neighborhood string from an event.
 * Priority: first comma-segment of event.address → source geoHint → null.
 */
function deriveNeighborhood(
  address: string | undefined,
  firstSourceId: string | undefined,
  sourceLookup: Map<string, { name: string; geoHint?: string }>
): string | null {
  if (address) {
    const seg = address.split(",")[0]?.trim();
    if (seg && seg.length > 0) return seg;
  }
  if (firstSourceId) {
    const info = sourceLookup.get(firstSourceId);
    if (info?.geoHint) return info.geoHint;
  }
  return null;
}

/**
 * Build an enriched scoring line for ONE event.
 *
 * Pure function: takes event + ctx, returns a deterministic string. No I/O.
 *
 * Fields included:
 *   id, title, category, ALL tags, venue, full performersOrTeams,
 *   neighborhood (address comma-seg → geoHint fallback), source name,
 *   day-of-week (LA local), how-soon (e.g. "in 2 days" / "today"),
 *   distance-from-home (haversine mi → "location unknown" if no coords),
 *   free vs $price, description (up to 400 chars).
 */
export function buildScoringLine(event: EventItem, ctx: ScoringLineCtx): string {
  const { home, now, sourceLookup } = ctx;

  // --- Day-of-week (LA local) ---
  // Parse startDatetime as a wall-clock LA time. The ISO string already carries
  // an LA offset (e.g. "-07:00"), so Date.parse handles it correctly.
  const startMs = Date.parse(event.startDatetime);
  let dowStr = "unknown-day";
  if (!isNaN(startMs)) {
    const laParts = utcMsToLaParts(startMs);
    // Reconstruct a Date using the LA wall-clock components to get getDay()
    const laWall = new Date(laParts.year, laParts.month - 1, laParts.day);
    dowStr = DOW[laWall.getDay()] ?? "unknown-day";
  }

  // --- How-soon ---
  let howSoon = "date-unknown";
  if (!isNaN(startMs)) {
    const nowMs = now.getTime();
    const deltaDays = Math.round((startMs - nowMs) / 86_400_000);
    if (deltaDays <= 0) {
      howSoon = "today";
    } else if (deltaDays === 1) {
      howSoon = "in 1 day";
    } else {
      howSoon = `in ${deltaDays} days`;
    }
  }

  // --- Distance ---
  let distStr = "location unknown";
  if (event.lat !== undefined && event.lng !== undefined) {
    const miles = haversineMilesSL(home.lat, home.lng, event.lat, event.lng);
    distStr = `${miles.toFixed(1)}mi`;
  }

  // --- Neighborhood ---
  const firstSourceId = event.sources[0]?.sourceId;
  const neighborhood = deriveNeighborhood(event.address, firstSourceId, sourceLookup);

  // --- Source name ---
  const sourceInfo = firstSourceId ? sourceLookup.get(firstSourceId) : undefined;
  const sourceName = sourceInfo?.name ?? firstSourceId ?? "unknown-source";

  // --- Price ---
  let priceStr: string;
  if (event.isFree) {
    priceStr = "free";
  } else if (event.priceMin !== undefined) {
    priceStr = `$${event.priceMin}`;
  } else {
    priceStr = "price-unknown";
  }

  // --- All tags ---
  const tagsStr = event.tags.length > 0 ? `[${event.tags.join(",")}]` : null;

  // --- Description (up to ~400 chars) ---
  const descStr = event.description ? `desc:${event.description.slice(0, 400)}` : null;

  const parts: (string | null)[] = [
    `id:${event.id}`,
    `"${event.title}"`,
    event.category,
    tagsStr,
    event.venue ? `@${event.venue}` : "@unknown-venue",
    neighborhood ? `neighborhood:${neighborhood}` : null,
    `source:${sourceName}`,
    dowStr,
    howSoon,
    distStr,
    priceStr,
    event.startDatetime.slice(0, 16),
    event.performersOrTeams ? `perf:${event.performersOrTeams}` : null,
    descStr,
  ];

  return parts.filter(Boolean).join(" | ");
}

// ============================================================================
// buildBatchSystemPrompt — pure, testable prompt builder
// ============================================================================

/**
 * Build the system prompt for a scoring batch.
 * Includes the shared intent brief + explicit 0–100 rubric so ALL batches
 * apply the same calibration (cross-batch comparability).
 *
 * Pure function: brief → string. No I/O.
 */
export function buildBatchSystemPrompt(brief: string): string {
  return `You are the scoring engine of a San Diego event recommender.

INTENT BRIEF (what the user is after — apply this to EVERY event):
${brief}

SCORING RUBRIC — use the SAME scale in every batch for cross-batch consistency:
90–100: Perfect fit — exactly what the brief describes. Free + nearby + right vibe = top tier.
70–89:  Strong fit — clearly relevant, matches most of the intent.
50–69:  Plausible fit — some relevance, could work but has gaps.
30–49:  Weak fit — tangentially related or a stretch.
0–29:   Poor/no fit — irrelevant to the intent.

AGE-GATE: kids-only events (age cap ≤17, or camp/story-time programs) score 0–20 unless the query wants kids/family — else score normally.

Score on: (1) fit to the brief; (2) practical signals — free/paid, distance-from-home, day-of-week, how-soon.
Score ALL events in the list. Do NOT omit any.
Return ONLY valid JSON: an array of { "id": "<event-id>", "score": <number 0-100> }
No markdown fences. No extra text. Include every event id from the input.`;
}

// ============================================================================
// Real LLM batch scorer (default ScoreBatchFn)
// ============================================================================

/**
 * Create the real ScoreBatchFn, closed over the scoring context (home, now, sourceLookup).
 * Built ONCE per rankEvents call and passed to scoreAllEvents.
 */
function makeRealScoreBatch(ctx: ScoringLineCtx): ScoreBatchFn {
  return async (
    events: EventItem[],
    brief: string,
    constraints: QueryContext
  ): Promise<Array<{ id: string; score: number }>> => {
    return realScoreBatch(events, brief, constraints, ctx);
  };
}

async function realScoreBatch(
  events: EventItem[],
  brief: string,
  constraints: QueryContext,
  ctx: ScoringLineCtx
): Promise<Array<{ id: string; score: number }>> {
  const systemPrompt = buildBatchSystemPrompt(brief);

  const userPrompt = `Query: "${constraints.rawQuery}"

Events to score:
${events.map((e) => buildScoringLine(e, ctx)).join("\n")}

Return the JSON array now.`;

  const result = await inference({
    systemPrompt,
    userPrompt,
    level: "standard",
    expectJson: true,
    retries: 2,
  });

  if (!result.success || result.parsed === undefined) {
    console.error("[Ranker] Batch scoring LLM call failed:", result.error);
    return [];
  }

  const parsed = ScoreBatchSchema.safeParse(result.parsed);
  if (!parsed.success) {
    console.error("[Ranker] Batch scoring schema mismatch:", parsed.error.message);
    return [];
  }

  return parsed.data;
}

// ============================================================================
// scoreAllEvents
// ============================================================================

/**
 * Score EVERY event 0–100 for this query.
 *
 * - Splits events into batches of SCORE_BATCH_SIZE.
 * - Runs batches through a bounded-concurrency pool.
 * - Merges all batch results into a Map<id, score>.
 * - Any event not returned by the LLM → NEUTRAL_SCORE (never dropped).
 *
 * @param events      - All filtered events to score.
 * @param constraints - Active QueryContext.
 * @param profile     - User's InterestProfile (passed to scorer for context).
 * @param brief       - Pre-computed intent brief (shared across all batches).
 * @param opts        - { scoreBatch } injectable for tests.
 */
export async function scoreAllEvents(
  events: EventItem[],
  constraints: QueryContext,
  _profile: InterestProfile,
  brief: string,
  opts?: RankOpts
): Promise<Map<string, number>> {
  const scoreBatch = opts?.scoreBatch ?? realScoreBatch;
  const scoreMap = new Map<string, number>();

  // Seed all events with NEUTRAL_SCORE so any that the LLM drops are still present.
  for (const e of events) {
    scoreMap.set(e.id, NEUTRAL_SCORE);
  }

  if (events.length === 0) return scoreMap;

  // Partition into batches
  const batches: EventItem[][] = [];
  for (let i = 0; i < events.length; i += SCORE_BATCH_SIZE) {
    batches.push(events.slice(i, i + SCORE_BATCH_SIZE));
  }

  // Run batches with bounded concurrency; merge results into scoreMap
  await runWithConcurrency(batches, scoreConcurrency(), async (batch) => {
    try {
      const scores = await scoreBatch(batch, brief, constraints);
      for (const { id, score } of scores) {
        if (scoreMap.has(id)) {
          scoreMap.set(id, Math.max(0, Math.min(100, score)));
        }
        // ids not in the original set are silently ignored
      }
    } catch (err) {
      console.error("[Ranker] scoreAllEvents batch threw:", (err as Error).message);
      // batch retains NEUTRAL_SCORE for all its events — already seeded above
    }
  });

  return scoreMap;
}

// ============================================================================
// Why-line generation (LLM — batched, top-tier only)
// ============================================================================

const WhyLinesSchema = z.object({
  explanations: z.array(
    z.object({
      id: z.string(),
      why: z.string(),
    })
  ),
});

/**
 * Generate "why it fits" explanations for the top-tier events in ONE LLM call.
 * Returns a map of event.id → why-line. On failure returns empty map.
 */
async function generateWhyLines(
  events: EventItem[],
  constraints: QueryContext
): Promise<Map<string, string>> {
  if (events.length === 0) return new Map();

  const eventList = events
    .map((e) => {
      const parts = [
        `id: "${e.id}"`,
        `title: "${e.title}"`,
        `category: ${e.category}`,
        e.tags.length > 0 ? `tags: ${e.tags.join(", ")}` : null,
        e.venue ? `venue: ${e.venue}` : null,
        e.isFree ? "free" : e.priceMin !== undefined ? `$${e.priceMin}` : null,
        `date: ${e.startDatetime.slice(0, 10)}`,
        e.performersOrTeams ? `performers: ${e.performersOrTeams}` : null,
        e.description ? `desc: ${e.description.slice(0, 120)}` : null,
      ].filter(Boolean).join("; ");
      return `- ${parts}`;
    })
    .join("\n");

  const systemPrompt = `You are an event recommendation assistant for a San Diego event discovery app.
Write a short (max 15 words), specific "why it fits" explanation for each event relative to the query.
Return ONLY valid JSON: { "explanations": [ { "id": "<event-id>", "why": "<explanation>" }, ... ] }
No markdown fences. No extra text.`;

  const userPrompt = `Query: "${constraints.rawQuery}"

Events:
${eventList}

Return the JSON object now.`;

  const result = await inference({
    systemPrompt,
    userPrompt,
    level: "standard",
    expectJson: true,
    retries: 2,
  });

  if (!result.success || result.parsed === undefined) {
    console.error("[Ranker] Why-line generation failed:", result.error);
    return new Map();
  }

  const parsed = WhyLinesSchema.safeParse(result.parsed);
  if (!parsed.success) {
    console.error("[Ranker] Why-line schema mismatch:", parsed.error.message);
    return new Map();
  }

  const map = new Map<string, string>();
  for (const item of parsed.data.explanations) {
    if (item.why.trim().length > 0) {
      map.set(item.id, item.why.trim());
    }
  }
  return map;
}

// ============================================================================
// Deterministic why-line fallback
// ============================================================================

function fallbackWhy(event: EventItem): string {
  const parts: string[] = [];
  if (event.isFree) parts.push("free to attend");
  if (event.venue) parts.push(`at ${event.venue}`);
  const date = event.startDatetime.slice(0, 10);
  parts.push(`on ${date}`);
  const tagsStr = event.tags.slice(0, 3).join(", ");
  if (tagsStr) parts.push(tagsStr);
  return `${event.category} event ${parts.join(", ")}`.trim();
}

// ============================================================================
// rankEvents — main export
// ============================================================================

/**
 * Rank filtered events for this query using LLM scoring.
 *
 * Flow:
 *   1. buildIntentBrief — 1 LLM call → what the user is after.
 *   2. scoreAllEvents   — batched, concurrent LLM calls → 0–100 per event.
 *   3. Sort desc by score; ties → sooner startDatetime → nearer location.
 *   4. Why-lines: top WHY_TIER events via 1 LLM call; tail → fallbackWhy.
 *   5. Return all events when limit is undefined/Infinity; slice otherwise.
 *
 * Kill-switch: EVENTSCOUT_DISABLE_RERANK=1 → soonness order + fallbackWhy, no LLM.
 * Failure-safe: any scoring failure → fallback to soonness order (never throws).
 *
 * @param events      - Pre-filtered EventItem[].
 * @param constraints - Active QueryContext.
 * @param profile     - User's InterestProfile.
 * @param limit       - Max results (default Infinity → return all).
 * @param opts        - { scoreBatch } injectable fake for tests.
 */
export async function rankEvents(
  events: EventItem[],
  constraints: QueryContext,
  profile: InterestProfile,
  limit: number = Infinity,
  opts?: RankOpts
): Promise<RankedEvent[]> {
  if (events.length === 0) return [];

  const effectiveLimit = limit <= 0 ? 0 : limit;

  // ---- Determine origin for proximity tiebreak ----------------------------
  // QueryContext.home is always resolved by the caller (never undefined).
  const origin = constraints.home ?? profile.homeLocation;

  /** Sort events soonest-first, then nearest-first. Pure deterministic fallback. */
  function soonessThenProximity(a: EventItem, b: EventItem): number {
    const tA = new Date(a.startDatetime).getTime();
    const tB = new Date(b.startDatetime).getTime();
    if (tA !== tB) return tA - tB; // sooner first

    // Proximity tiebreak
    const dA =
      a.lat !== undefined && a.lng !== undefined
        ? haversineMiles(origin.lat, origin.lng, a.lat, a.lng)
        : Infinity;
    const dB =
      b.lat !== undefined && b.lng !== undefined
        ? haversineMiles(origin.lat, origin.lng, b.lat, b.lng)
        : Infinity;
    return dA - dB; // nearer first
  }

  // ---- Kill-switch: soonness fallback path --------------------------------
  if (process.env["EVENTSCOUT_DISABLE_RERANK"] === "1") {
    const sorted = [...events].sort(soonessThenProximity);
    const sliced = isFinite(effectiveLimit) ? sorted.slice(0, effectiveLimit) : sorted;
    return sliced.map((e) => ({ ...e, score: 0, why: fallbackWhy(e) }));
  }

  // ---- LLM scoring path ---------------------------------------------------
  // Build source lookup once — maps sourceId → { name, geoHint } for scoring lines.
  // Only done when we're actually going to use the real scorer (injected scorer bypasses it).
  let scoreMap: Map<string, number>;
  try {
    const brief = await buildIntentBrief(constraints);

    // If an injected scorer is provided (tests), use it as-is.
    // Otherwise, build the scoring context and create the real scorer.
    let effectiveOpts = opts;
    if (!opts?.scoreBatch) {
      const sources = loadSources();
      const sourceLookup = new Map(
        sources.map((s) => [s.id, { name: s.name, geoHint: s.geoHint }])
      );
      const scoringCtx: ScoringLineCtx = {
        home: origin,
        now: new Date(),
        sourceLookup,
      };
      effectiveOpts = { scoreBatch: makeRealScoreBatch(scoringCtx) };
    }

    scoreMap = await scoreAllEvents(events, constraints, profile, brief, effectiveOpts);
  } catch (err) {
    console.warn("[Ranker] Scoring failed — falling back to soonness order:", (err as Error).message);
    const sorted = [...events].sort(soonessThenProximity);
    const sliced = isFinite(effectiveLimit) ? sorted.slice(0, effectiveLimit) : sorted;
    return sliced.map((e) => ({ ...e, score: 0, why: fallbackWhy(e) }));
  }

  // ---- Sort desc by score; tiebreak: sooner → nearer ----------------------
  const sorted = [...events].sort((a, b) => {
    const sA = scoreMap.get(a.id) ?? NEUTRAL_SCORE;
    const sB = scoreMap.get(b.id) ?? NEUTRAL_SCORE;
    if (sB !== sA) return sB - sA; // desc by score

    // Tiebreak 1: sooner date
    const tA = new Date(a.startDatetime).getTime();
    const tB = new Date(b.startDatetime).getTime();
    if (tA !== tB) return tA - tB; // sooner first

    // Tiebreak 2: nearer location
    const dA =
      a.lat !== undefined && a.lng !== undefined
        ? haversineMiles(origin.lat, origin.lng, a.lat, a.lng)
        : Infinity;
    const dB =
      b.lat !== undefined && b.lng !== undefined
        ? haversineMiles(origin.lat, origin.lng, b.lat, b.lng)
        : Infinity;
    return dA - dB; // nearer first
  });

  const sliced = isFinite(effectiveLimit) ? sorted.slice(0, effectiveLimit) : sorted;

  // ---- Why-lines: top WHY_TIER get LLM call; tail gets fallback -----------
  const topTier = sliced.slice(0, WHY_TIER);
  const tail = sliced.slice(WHY_TIER);

  // Best-effort why-lines for the top tier — on failure, fall back for all
  let whyMap = new Map<string, string>();
  try {
    whyMap = await generateWhyLines(topTier, constraints);
  } catch {
    // whyMap stays empty; all will get fallbackWhy
  }

  return sliced.map((e) => {
    const score = scoreMap.get(e.id) ?? NEUTRAL_SCORE;
    const why = whyMap.get(e.id) ?? fallbackWhy(e);
    return { ...e, score, why };
  });
}
