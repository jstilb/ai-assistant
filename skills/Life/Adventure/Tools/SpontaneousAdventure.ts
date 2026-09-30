#!/usr/bin/env bun
/**
 * SpontaneousAdventure.ts — "I've got a free window. Surprise me."
 *
 * The antidote to a blank Saturday. One `inference()` call turns a time window
 * (a free afternoon, a full day, a long weekend) + a home base + a radius +
 * budget into 2-4 concrete, ready-to-go adventure options, each with a one-line
 * hook, a rough plan, drive time, cost, and an "adventure score." The prompt is
 * biased toward the NEW and the NOVEL — it's told to favor places you likely
 * haven't been and to weave in the caller's standing adventure goals (for Jm:
 * explore Mexico/Baja, hit a national park, novel over familiar).
 *
 * Grounded + validated: real regions and drive-time-honest, no invented
 * addresses. `--commit <n>` adds the nth option to the TripTracker as a
 * `daytrip`/`roadtrip` so a whim becomes a tracked plan in one step.
 *
 * Usage:
 *   bun SpontaneousAdventure.ts suggest [--window <...>] [--from <place>]
 *        [--radius <mi>] [--budget <...>] [--vibe <...>] [--with <who>]
 *        [--goals <csv>] [--date <YYYY-MM-DD>] [--commit <n>] [--dry-run]
 *
 * @module SpontaneousAdventure
 */

import { inference } from "../../../../lib/core/Inference.ts";
import { addTrip, loadState, saveState, todayISO, type TripType } from "./TripTracker.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdventureOption {
  name: string;
  hook: string;
  plan: string;
  driveTime?: string;
  approxCost?: string;
  /** 1-10, higher = bolder/more novel. */
  adventureScore: number;
  bringAlong?: string;
  /** Coarse kind, mapped onto a TripTracker TripType when committed. */
  kind?: string;
}

export interface AdventureSuggestions {
  window: string;
  from: string;
  options: AdventureOption[];
}

export interface SuggestInput {
  window?: string;
  from?: string;
  radiusMi?: number;
  budget?: string;
  vibe?: string;
  companions?: string;
  goals?: string[];
}

/** Jm's standing adventure goals (M0 Adventurer) — used when --goals is omitted. */
const DEFAULT_GOALS = [
  "explore Mexico / Baja",
  "visit a national or state park",
  "favor novel places over familiar ones",
  "get outside — surf, hike, camp, swim",
];

// ---------------------------------------------------------------------------
// Validation gate
// ---------------------------------------------------------------------------

export function validateSuggestions(s: unknown): AdventureOption[] {
  if (typeof s !== "object" || s === null) throw new Error("Suggestions not an object");
  const o = s as Record<string, unknown>;
  if (!Array.isArray(o.options) || o.options.length < 2) {
    throw new Error("Need at least 2 adventure options");
  }
  const options: AdventureOption[] = [];
  for (let i = 0; i < o.options.length; i++) {
    const opt = o.options[i] as Record<string, unknown>;
    if (typeof opt !== "object" || opt === null) throw new Error(`Option ${i + 1} malformed`);
    if (typeof opt.name !== "string" || !opt.name.trim()) throw new Error(`Option ${i + 1} missing name`);
    if (typeof opt.plan !== "string" || opt.plan.trim().length < 15) {
      throw new Error(`Option ${i + 1} missing a real plan`);
    }
    const rawScore = typeof opt.adventureScore === "number" ? opt.adventureScore : 5;
    options.push({
      name: opt.name.trim(),
      hook: typeof opt.hook === "string" ? opt.hook : "",
      plan: opt.plan.trim(),
      driveTime: typeof opt.driveTime === "string" ? opt.driveTime : undefined,
      approxCost: typeof opt.approxCost === "string" ? opt.approxCost : undefined,
      adventureScore: Math.min(10, Math.max(1, Math.round(rawScore))),
      bringAlong: typeof opt.bringAlong === "string" ? opt.bringAlong : undefined,
      kind: typeof opt.kind === "string" ? opt.kind : undefined,
    });
  }
  return options;
}

// ---------------------------------------------------------------------------
// Suggest
// ---------------------------------------------------------------------------

export async function suggestAdventures(input: SuggestInput): Promise<AdventureSuggestions> {
  const window = input.window?.trim() || "a full free day";
  const from = input.from?.trim() || "San Diego / Ocean Beach, CA";
  const radius = input.radiusMi && input.radiusMi > 0 ? `${input.radiusMi} miles` : "reasonable for the time window";
  const budget = input.budget?.trim() || "flexible, lean toward cheap";
  const vibe = input.vibe?.trim() || "spontaneous and a little bold";
  const goals = input.goals?.length ? input.goals : DEFAULT_GOALS;
  const withClause = input.companions ? ` Going with: ${input.companions}.` : " Solo or open to bringing someone.";

  const systemPrompt =
    "You are a spontaneity engine — a friend with an encyclopedic mental map of everything within a " +
    "few hours of anywhere, who's great at turning a free window into a real adventure RIGHT NOW. " +
    "Bias hard toward the novel and the memorable over the safe and familiar. Be concrete about real " +
    "regions and honest about drive times, but do NOT invent specific business names/addresses/hours. " +
    "Match each option to the available time window realistically. STRICT JSON only.";

  const userPrompt = `I have: ${window}. Starting from: ${from}. Radius: ${radius}. Budget: ${budget}. Vibe: ${vibe}.${withClause}
Weave in these standing adventure goals where they fit: ${goals.join("; ")}.

Return JSON of EXACTLY this shape:
{
  "window": "${window}",
  "from": "${from}",
  "options": [
    {
      "name": "<destination / adventure>",
      "hook": "<one-line why-this-is-great>",
      "plan": "<concrete run of the day: where, what, in what order>",
      "driveTime": "<honest one-way drive/travel time>",
      "approxCost": "<$ range>",
      "adventureScore": <1-10, higher = bolder/more novel>,
      "bringAlong": "<key things to grab before leaving>",
      "kind": "<daytrip|roadtrip|camping|beach|surf|backpacking|city|other>"
    }
  ]
}
Give 3-4 options spanning the score range (one easy/close, one bold). Each must fit "${window}" realistically.`;

  const result = await inference({
    systemPrompt,
    userPrompt,
    level: "standard",
    expectJson: true,
    timeout: 150_000,
    retries: 1,
    retryDelayMs: 3000,
  });
  if (!result.success || result.parsed === undefined) {
    throw new Error(`Spontaneous-adventure inference failed: ${result.error ?? "no JSON returned"}`);
  }
  const options = validateSuggestions(result.parsed);
  // Sort by adventure score descending so the boldest is first.
  options.sort((a, b) => b.adventureScore - a.adventureScore);
  return { window, from, options };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export function renderConsole(s: AdventureSuggestions): string {
  const lines = [`🎲 ${s.options.length} adventures for "${s.window}" from ${s.from}:`, ""];
  s.options.forEach((o, i) => {
    lines.push(`${i + 1}. ${o.name}  —  adventure ${o.adventureScore}/10`);
    if (o.hook) lines.push(`   “${o.hook}”`);
    lines.push(`   ${o.plan}`);
    const meta = [
      o.driveTime ? `🚗 ${o.driveTime}` : "",
      o.approxCost ? `💰 ${o.approxCost}` : "",
      o.kind ? `🏷️ ${o.kind}` : "",
    ].filter(Boolean);
    if (meta.length) lines.push(`   ${meta.join("   ")}`);
    if (o.bringAlong) lines.push(`   Bring: ${o.bringAlong}`);
    lines.push("");
  });
  lines.push("Pick one and go. --commit <n> turns it into a tracked trip.");
  return lines.join("\n");
}

/** Map an option's coarse kind onto a valid TripType. */
function toTripType(kind: string | undefined): TripType {
  const valid: TripType[] = [
    "camping",
    "roadtrip",
    "international",
    "city",
    "beach",
    "backpacking",
    "surf",
    "daytrip",
    "other",
  ];
  if (kind && (valid as string[]).includes(kind)) return kind as TripType;
  return "daytrip";
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

const USAGE = `SpontaneousAdventure — turn a free window into a real adventure right now.

Usage: bun skills/Life/Adventure/Tools/SpontaneousAdventure.ts suggest [flags]

Flags:
  --window <text>    e.g. "a free Saturday", "an afternoon", "a 3-day weekend"
  --from <place>     home base (default: San Diego / Ocean Beach)
  --radius <mi>      max distance to consider
  --budget <text>    e.g. "cheap", "under $100", "money's no object"
  --vibe <text>      e.g. "chill nature", "adrenaline", "romantic", "cultural"
  --with <who>       companions
  --goals <csv>      standing goals to weave in (default: Jm's M0 adventurer goals)
  --commit <n>       add option #n to the TripTracker as a tracked trip
  --date <YYYY-MM-DD> start date to stamp on a committed trip (default: today)
  --dry-run          just print; never commit`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== "suggest") {
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
  }
  const flags = parseFlags(rest);
  const input: SuggestInput = {
    window: typeof flags.window === "string" ? flags.window : undefined,
    from: typeof flags.from === "string" ? flags.from : undefined,
    radiusMi: typeof flags.radius === "string" ? Number(flags.radius) : undefined,
    budget: typeof flags.budget === "string" ? flags.budget : undefined,
    vibe: typeof flags.vibe === "string" ? flags.vibe : undefined,
    companions: typeof flags.with === "string" ? flags.with : undefined,
    goals:
      typeof flags.goals === "string"
        ? flags.goals.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
  };
  console.error("Rolling the adventure dice…");
  const suggestions = await suggestAdventures(input);
  console.log(renderConsole(suggestions));

  const commitN = typeof flags.commit === "string" ? Number(flags.commit) : NaN;
  if (Number.isInteger(commitN)) {
    if (flags["dry-run"]) {
      console.error("(dry-run: not committing)");
      return;
    }
    const opt = suggestions.options[commitN - 1];
    if (!opt) throw new Error(`--commit ${commitN} is out of range (1–${suggestions.options.length})`);
    const state = loadState();
    const startDate = typeof flags.date === "string" ? flags.date : todayISO();
    const trip = addTrip(state, {
      destination: opt.name,
      type: toTripType(opt.kind),
      startDate,
      companions: input.companions ?? null,
      notes: `Spontaneous pick (adventure ${opt.adventureScore}/10): ${opt.hook || opt.plan}`,
    });
    saveState(state);
    console.error(`\nCommitted as tracked trip [${trip.id}] on ${startDate}.`);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
}
