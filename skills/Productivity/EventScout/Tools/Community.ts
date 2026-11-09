/**
 * Community.ts — community detection for the Thursday plan (ALIGNMENT G2,
 * slice 1): groups that meet again rank above one-off shows.
 *
 * Two parts, each where it earns its place:
 *   1. Facts (deterministic): group the WHOLE cache into series (title without
 *      dates + venue). A series recurs when its dates fall on one weekday with
 *      gaps of ≥ 6 days, or when a source gives a weekly/monthly RRULE. These
 *      are counts from the cache, so the hold can state them without invention.
 *   2. Judgement (one LLM call per run): is a recurring series a community —
 *      adults who meet again and can get to know each other — or a watch-only
 *      show, a band residency, an exhibit, a kids-only class? A date rule cannot
 *      tell a weekly salsa social from a weekly improv show.
 *
 * The hold step (WeekendHolds.ts) puts communities first. If the LLM call
 * fails, the caller reports it loudly and keeps score order.
 */

import { z } from "zod";
import type { InferenceResult } from "../../../../lib/core/Inference.ts";
import type { EventItem } from "./types.ts";
import { utcMsToLaParts } from "./lib/tz.ts";

// ============================================================================
// Series facts (deterministic)
// ============================================================================

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const RRULE_DAYS: Record<string, (typeof WEEKDAYS)[number]> = {
  SU: "Sunday",
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
};
/** Minimum days between two dates of a recurring group (a show run or a daily exhibit has shorter gaps). */
const MIN_GAP_DAYS = 6;

export interface SeriesFacts {
  key: string;
  /** Distinct LA dates (YYYY-MM-DD) of this series in the cache, sorted. */
  dates: string[];
  /** The weekday all dates share, or the RRULE's BYDAY; null when unknown. */
  weekday: (typeof WEEKDAYS)[number] | null;
  /** "weekly", "every 2 weeks", "monthly", or "repeating" (gap pattern unclear). */
  cadence: string;
  /** True when a source gave a recurrence rule (not only dates). */
  fromRule: boolean;
}

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const MONTH_DAY = new RegExp(`\\b(?:${MONTHS})\\.?\\s*\\d{1,2}(?:st|nd|rd|th)?\\b`, "g");
const MONTH_ALONE = new RegExp(`\\b(?:${MONTHS})\\b`, "g");

function words(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Series key: the title without dates or month names, plus the venue name
 * (the part before the first comma, so "Tango Del Rey" and "Tango Del Rey,
 * 3567 Del Rey St" match). Null when the title or the venue is empty: two
 * "Open Mic" listings with no venue can be two places, so they never merge.
 */
export function seriesKey(e: Pick<EventItem, "title" | "venue">): string | null {
  const title = words(
    e.title
      .toLowerCase()
      .replace(MONTH_DAY, " ")
      .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ")
      .replace(MONTH_ALONE, " "),
  );
  const venue = words((e.venue ?? "").split(",")[0] ?? "");
  return title && venue ? `${title}|${venue}` : null;
}

function laDateOf(e: Pick<EventItem, "startDatetime">): string | null {
  const ms = Date.parse(e.startDatetime);
  if (!Number.isFinite(ms)) return null;
  const p = utcMsToLaParts(ms);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function weekdayOf(iso: string): (typeof WEEKDAYS)[number] {
  const name = WEEKDAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()];
  if (!name) throw new Error(`Community: bad date ${iso}`);
  return name;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

/** A cadence name only when EVERY gap fits it; else "repeating" (e.g. 7, 7, 28 days). */
export function cadenceFromGaps(gaps: readonly number[]): string {
  const all = (lo: number, hi: number): boolean => gaps.every((g) => g >= lo && g <= hi);
  if (all(6, 8)) return "weekly";
  if (all(13, 15)) return "every 2 weeks";
  if (all(27, 35)) return "monthly";
  return "repeating";
}

interface RuleFacts {
  cadence: string;
  /** The single BYDAY weekday; null when the rule names several days or none. */
  weekday: (typeof WEEKDAYS)[number] | null;
  /** WEEKLY with no BYDAY repeats on the weekday of its own start date. */
  weekdayFromStart: boolean;
}

/** Weekly/monthly RRULE facts, or null for any other rule. */
function ruleFacts(rule: string): RuleFacts | null {
  const freq = /FREQ=(WEEKLY|MONTHLY)/i.exec(rule)?.[1]?.toUpperCase();
  if (!freq) return null;
  const interval = Number(/INTERVAL=(\d+)/i.exec(rule)?.[1] ?? "1");
  const byDay = /BYDAY=([A-Z0-9,+-]+)/i.exec(rule)?.[1];
  const days = (byDay ?? "").split(",").map((d) => d.replace(/^[+-]?\d+/, "").toUpperCase());
  const only = byDay && days.length === 1 ? days[0] : undefined;
  const weekday = only ? (RRULE_DAYS[only] ?? null) : null;
  if (freq === "MONTHLY") return { cadence: interval === 1 ? "monthly" : `every ${interval} months`, weekday, weekdayFromStart: false };
  return { cadence: interval === 1 ? "weekly" : `every ${interval} weeks`, weekday, weekdayFromStart: !byDay };
}

/**
 * Recurring series in the cache, by series key. Cancelled events never count.
 * A series qualifies by its dates (≥ 2 dates, one weekday, every gap ≥ 6 days)
 * or by a weekly/monthly recurrence rule from a source.
 */
export function detectSeries(cache: readonly EventItem[]): Map<string, SeriesFacts> {
  const groups = new Map<string, { dates: Set<string>; rule: RuleFacts | null }>();
  for (const e of cache) {
    if (e.status === "cancelled") continue;
    const date = laDateOf(e);
    const key = seriesKey(e);
    if (!date || !key) continue;
    const g = groups.get(key) ?? { dates: new Set<string>(), rule: null };
    g.dates.add(date);
    if (!g.rule && e.recurrenceRule) g.rule = ruleFacts(e.recurrenceRule);
    groups.set(key, g);
  }
  const out = new Map<string, SeriesFacts>();
  for (const [key, g] of groups) {
    const dates = [...g.dates].sort();
    const first = dates[0];
    if (!first) continue;
    if (g.rule) {
      const weekday = g.rule.weekday ?? (g.rule.weekdayFromStart ? weekdayOf(first) : null);
      out.set(key, { key, dates, weekday, cadence: g.rule.cadence, fromRule: true });
      continue;
    }
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      const a = dates[i - 1];
      const b = dates[i];
      if (a && b) gaps.push(daysBetween(a, b));
    }
    if (gaps.length === 0) continue;
    const oneWeekday = new Set(dates.map(weekdayOf)).size === 1;
    if (!oneWeekday || Math.min(...gaps) < MIN_GAP_DAYS) continue;
    // Two dates show a repeat, not a cadence: name one only from 3+ dates.
    const cadence = dates.length >= 3 ? cadenceFromGaps(gaps) : "repeating";
    out.set(key, { key, dates, weekday: weekdayOf(first), cadence, fromRule: false });
  }
  return out;
}

function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * The hold line's facts, from the cache only (no invented dates). A rule-based
 * series names the rule, not a date count: its cached dates can be the rule's
 * own projection, not dates a source page showed.
 */
export function describeSeries(f: SeriesFacts): string {
  // "repeating" = no cadence is proven (2 dates, or uneven gaps): say only the weekday.
  const when =
    f.cadence === "repeating"
      ? f.weekday
        ? `on ${f.weekday}s`
        : "again"
      : f.weekday
        ? `${f.cadence} on ${f.weekday}s`
        : f.cadence;
  if (f.fromRule) return `meets ${when} (the source's calendar repeats it)`;
  const n = f.dates.length;
  if (f.cadence === "repeating") {
    // Review 1 (2026-11-08): 2 dates, or uneven gaps, prove a repeat, not "every
    // Saturday" (a "Saturdays of the month" night read as weekly). List the dates.
    const shown = f.dates.slice(0, 4).map(shortDate).join(", ");
    const last = f.dates[n - 1];
    const more = n > 4 && last ? `, … ${shortDate(last)}` : "";
    return `the sources list it on ${f.weekday ? `${n} ${f.weekday}s` : `${n} dates`}: ${shown}${more}`;
  }
  const first = f.dates[0];
  const last = f.dates[n - 1];
  const listed = first && last ? `EventScout found it on ${n} dates, ${shortDate(first)} – ${shortDate(last)}` : "EventScout found it again";
  return `meets ${when} (${listed})`;
}

// ============================================================================
// Community judgement (one LLM call)
// ============================================================================

export interface CommunityCandidate {
  key: string;
  title: string;
  venue?: string;
  category: string;
  tags: string[];
  description?: string;
  cadence: string;
}

export interface CommunityVerdict {
  community: boolean;
  /** Short kind, e.g. "dance social", "open mic", "watch-only show". */
  kind: string;
}

/** Classify recurring series; resolves to a verdict per candidate key, or throws. */
export type ClassifyFn = (candidates: CommunityCandidate[]) => Promise<Map<string, CommunityVerdict>>;

type InferFn = (opts: {
  systemPrompt: string;
  userPrompt: string;
  level: "standard";
  schema: Record<string, unknown>;
  timeout: number;
  retries: number;
}) => Promise<InferenceResult>;

const defaultInfer: InferFn = async (options) => {
  const provider = await import("../../../../lib/core/Inference.ts");
  return provider.inference(options);
};

const VerdictSchema = z.object({
  verdicts: z.array(z.object({ id: z.string(), community: z.boolean(), kind: z.string() })),
});

const VERDICT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          community: { type: "boolean" },
          kind: { type: "string" },
        },
        required: ["id", "community", "kind"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You sort recurring San Diego events for an adult who wants to become a regular somewhere and meet the same people again.

For each event series, decide "community": true or false.
- true: a gathering where the same adults can meet again and get to know each other. Examples: adult classes and workshop series, clubs, pickup or rec-league sports, run or ride clubs, dance socials and dance classes, open mics, jams, trivia nights, craft or game nights, volunteer, mutual-aid or activist groups, meetups, practice groups.
- false: watch-only performances (a weekly show, a band or DJ playing a venue), exhibits, tours, markets and sales, races or spectator sports, programs only for kids, teens, parents of young kids or seniors, registration notices, private or commercial services (photo sessions, chauffeured trips), and closed courses with a fixed run (e.g. a 6-week course already under way, "class 5 of 6") that a newcomer cannot join this week.
Judge from the title, venue, category, tags and description. If it is unclear, choose false.
"kind" is 2–4 words, e.g. "dance social", "open mic", "watch-only show", "kids class".
Return one verdict for every id.`;

/** The default classifier: one Sonnet call with a JSON schema; throws on any failure. */
export function makeClassifier(infer: InferFn = defaultInfer): ClassifyFn {
  return async (candidates) => {
    if (candidates.length === 0) return new Map();
    const lines = candidates.map((c, i) =>
      JSON.stringify({
        id: `s${i + 1}`,
        title: c.title,
        venue: c.venue ?? "",
        category: c.category,
        tags: c.tags.slice(0, 8),
        cadence: c.cadence,
        description: (c.description ?? "").replace(/\s+/g, " ").slice(0, 280),
      }),
    );
    const result = await infer({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: `Event series (one JSON object per line):\n${lines.join("\n")}\n\nReturn {"verdicts": [...]} now.`,
      level: "standard",
      schema: VERDICT_JSON_SCHEMA,
      timeout: 180_000,
      retries: 1,
    });
    if (!result.success) throw new Error(`community check LLM call failed: ${result.error ?? "unknown error"}`);
    const parsed = VerdictSchema.safeParse(result.parsed);
    if (!parsed.success) throw new Error(`community check returned a bad shape: ${parsed.error.message}`);
    const byId = new Map(parsed.data.verdicts.map((v) => [v.id, v]));
    const out = new Map<string, CommunityVerdict>();
    candidates.forEach((c, i) => {
      const v = byId.get(`s${i + 1}`);
      if (v) out.set(c.key, { community: v.community, kind: v.kind });
    });
    if (out.size < candidates.length) {
      throw new Error(`community check answered ${out.size} of ${candidates.length} series`);
    }
    return out;
  };
}
