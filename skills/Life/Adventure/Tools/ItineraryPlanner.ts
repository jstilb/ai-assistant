#!/usr/bin/env bun
/**
 * ItineraryPlanner.ts — grounded day-by-day trip itineraries.
 *
 * One `inference()` call turns a destination + dates + interests + budget into
 * a structured, day-by-day itinerary (morning/afternoon/evening blocks, meals,
 * logistics, rough costs), which is structurally VALIDATED before it's trusted
 * and written to an Obsidian doc under Adventure/. The validator (mirroring the
 * Cooking skill's LLM-output gates) rejects an itinerary that doesn't actually
 * cover the requested number of days or leaves days empty — the model fails
 * loud rather than producing a half-baked plan.
 *
 * Optionally links the itinerary back to a Trip record (TripTracker) by setting
 * that trip's `itineraryRef` to the written doc path (`--trip <id>`).
 *
 * Usage:
 *   bun ItineraryPlanner.ts plan --destination <name> --days <n>
 *        [--start <YYYY-MM-DD>] [--interests <csv>] [--budget <level|usd>]
 *        [--pace <relaxed|balanced|packed>] [--with <who>] [--trip <id>] [--dry-run]
 *
 * @module ItineraryPlanner
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { inference } from "../../../../lib/core/Inference.ts";
import { adventureVaultDir } from "./AdventurePaths.ts";
import { loadState, saveState, updateTrip } from "./TripTracker.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ItineraryBlock {
  time: string; // "Morning" | "Afternoon" | "Evening" | specific
  activity: string;
  detail: string;
  approxCost?: string;
}

export interface ItineraryDay {
  day: number;
  date?: string;
  title: string;
  blocks: ItineraryBlock[];
  meals?: string;
  logistics?: string;
}

export interface Itinerary {
  destination: string;
  days: ItineraryDay[];
  overview: string;
  budgetNote?: string;
  tips?: string[];
}

export interface PlanInput {
  destination: string;
  days: number;
  startDate?: string;
  interests?: string[];
  budget?: string;
  pace?: "relaxed" | "balanced" | "packed";
  companions?: string;
}

// ---------------------------------------------------------------------------
// Validation gate
// ---------------------------------------------------------------------------

/** Reject an itinerary that doesn't cover the requested days or leaves them empty. */
export function validateItinerary(it: unknown, expectedDays: number): Itinerary {
  if (typeof it !== "object" || it === null) throw new Error("Itinerary is not an object");
  const obj = it as Record<string, unknown>;
  if (typeof obj.destination !== "string" || !obj.destination.trim()) {
    throw new Error("Itinerary missing destination");
  }
  if (typeof obj.overview !== "string" || obj.overview.trim().length < 20) {
    throw new Error("Itinerary overview missing or too short");
  }
  if (!Array.isArray(obj.days) || obj.days.length !== expectedDays) {
    throw new Error(
      `Itinerary must have exactly ${expectedDays} day(s), got ${
        Array.isArray(obj.days) ? obj.days.length : "none"
      }`,
    );
  }
  const days: ItineraryDay[] = [];
  for (let i = 0; i < obj.days.length; i++) {
    const d = obj.days[i] as Record<string, unknown>;
    if (typeof d !== "object" || d === null) throw new Error(`Day ${i + 1} is malformed`);
    if (!Array.isArray(d.blocks) || d.blocks.length < 1) {
      throw new Error(`Day ${i + 1} has no activity blocks`);
    }
    const blocks: ItineraryBlock[] = [];
    for (const b of d.blocks) {
      const bb = b as Record<string, unknown>;
      if (typeof bb.activity !== "string" || !bb.activity.trim()) {
        throw new Error(`Day ${i + 1} has a block with no activity`);
      }
      blocks.push({
        time: typeof bb.time === "string" ? bb.time : "",
        activity: bb.activity.trim(),
        detail: typeof bb.detail === "string" ? bb.detail : "",
        approxCost: typeof bb.approxCost === "string" ? bb.approxCost : undefined,
      });
    }
    days.push({
      day: typeof d.day === "number" ? d.day : i + 1,
      date: typeof d.date === "string" ? d.date : undefined,
      title: typeof d.title === "string" && d.title.trim() ? d.title.trim() : `Day ${i + 1}`,
      blocks,
      meals: typeof d.meals === "string" ? d.meals : undefined,
      logistics: typeof d.logistics === "string" ? d.logistics : undefined,
    });
  }
  return {
    destination: obj.destination.trim(),
    overview: obj.overview.trim(),
    days,
    budgetNote: typeof obj.budgetNote === "string" ? obj.budgetNote : undefined,
    tips: Array.isArray(obj.tips) ? obj.tips.filter((t): t is string => typeof t === "string") : undefined,
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planItinerary(input: PlanInput): Promise<Itinerary> {
  if (!input.destination.trim()) throw new Error("destination is required");
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 21) {
    throw new Error("days must be an integer 1–21");
  }
  const pace = input.pace ?? "balanced";
  const interests = input.interests?.length ? input.interests.join(", ") : "general sightseeing, food, local culture";
  const budget = input.budget ?? "mid-range";
  const withClause = input.companions ? ` The trip is with: ${input.companions}.` : "";
  const startClause = input.startDate ? ` Trip starts ${input.startDate}; date each day accordingly.` : "";

  const systemPrompt =
    "You are an expert travel planner who builds realistic, grounded day-by-day itineraries. " +
    "You know real regions, neighborhoods, and the kinds of activities that exist there, and you " +
    "sequence a day sensibly by geography and energy. Be specific and practical (real place-types, " +
    "realistic times, honest cost ranges). Do NOT invent exact addresses, phone numbers, or URLs. " +
    "Return STRICT JSON only — no prose outside the JSON.";

  const userPrompt = `Plan a ${input.days}-day itinerary for ${input.destination}.
Interests: ${interests}. Budget: ${budget}. Pace: ${pace}.${withClause}${startClause}

Return JSON of EXACTLY this shape:
{
  "destination": "${input.destination}",
  "overview": "<2-3 sentence framing of the trip arc>",
  "budgetNote": "<rough total + how to save/splurge>",
  "days": [
    {
      "day": 1,
      "date": "<YYYY-MM-DD or omit>",
      "title": "<theme of the day>",
      "blocks": [
        {"time":"Morning","activity":"<what>","detail":"<how/where-type/why>","approxCost":"<$ range or 'free'>"},
        {"time":"Afternoon","activity":"...","detail":"...","approxCost":"..."},
        {"time":"Evening","activity":"...","detail":"...","approxCost":"..."}
      ],
      "meals": "<breakfast/lunch/dinner ideas — cuisine + neighborhood type>",
      "logistics": "<getting around, reservations to make, timing notes>"
    }
  ],
  "tips": ["<3-6 practical, destination-specific tips>"]
}
There MUST be exactly ${input.days} day object(s), each with at least 2 blocks. A ${pace} pace means ${
    pace === "relaxed" ? "2-3 anchor activities/day with downtime" : pace === "packed" ? "4-5 activities/day, efficient" : "3-4 activities/day"
  }.`;

  const result = await inference({
    systemPrompt,
    userPrompt,
    level: "standard",
    expectJson: true,
    timeout: 180_000,
    retries: 1,
    retryDelayMs: 3000,
  });
  if (!result.success || result.parsed === undefined) {
    throw new Error(`Itinerary inference failed: ${result.error ?? "no JSON returned"}`);
  }
  return validateItinerary(result.parsed, input.days);
}

// ---------------------------------------------------------------------------
// Render + write
// ---------------------------------------------------------------------------

export function renderMarkdown(it: Itinerary, input: PlanInput): string {
  const lines: string[] = [
    `# ${it.destination} — ${it.days.length}-Day Itinerary`,
    "",
    `**Pace:** ${input.pace ?? "balanced"}  ·  **Budget:** ${input.budget ?? "mid-range"}${
      input.companions ? `  ·  **With:** ${input.companions}` : ""
    }`,
    input.interests?.length ? `**Interests:** ${input.interests.join(", ")}` : "",
    "",
    `> ${it.overview}`,
    "",
  ].filter(Boolean);
  if (it.budgetNote) {
    lines.push(`**Budget note:** ${it.budgetNote}`, "");
  }
  for (const day of it.days) {
    lines.push(`## Day ${day.day}${day.date ? ` (${day.date})` : ""} — ${day.title}`);
    for (const b of day.blocks) {
      const cost = b.approxCost ? `  _(${b.approxCost})_` : "";
      lines.push(`- **${b.time || "—"}: ${b.activity}**${cost}`);
      if (b.detail) lines.push(`  ${b.detail}`);
    }
    if (day.meals) lines.push(`- 🍽️ **Meals:** ${day.meals}`);
    if (day.logistics) lines.push(`- 🧭 **Logistics:** ${day.logistics}`);
    lines.push("");
  }
  if (it.tips?.length) {
    lines.push("## Tips");
    for (const t of it.tips) lines.push(`- ${t}`);
    lines.push("");
  }
  lines.push("_Generated by the Adventure skill's ItineraryPlanner. Verify hours/bookings before you go._");
  return lines.join("\n");
}

export function writeObsidianDoc(it: Itinerary, input: PlanInput): string {
  const dir = adventureVaultDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const stamp = input.startDate ? `-${input.startDate}` : "";
  const safe = it.destination.replace(/[^a-z0-9 ]/gi, "").trim();
  const path = join(dir, `Itinerary - ${safe}${stamp}.md`);
  writeFileSync(path, renderMarkdown(it, input), "utf8");
  return path;
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

const USAGE = `ItineraryPlanner — grounded day-by-day trip itineraries.

Usage: bun skills/Life/Adventure/Tools/ItineraryPlanner.ts plan --destination <name> --days <n> [flags]

Flags:
  --start <YYYY-MM-DD>   date the trip (days get dated)
  --interests <csv>      e.g. "food,hiking,history,nightlife"
  --budget <level|usd>   e.g. "budget" | "mid-range" | "splurge" | "1500"
  --pace <relaxed|balanced|packed>
  --with <who>           travel companions
  --trip <id>            link result back onto a TripTracker trip (sets itineraryRef)
  --dry-run              print the plan; do NOT write the Obsidian doc or update the trip`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== "plan") {
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
  }
  const flags = parseFlags(rest);
  const destination = typeof flags.destination === "string" ? flags.destination : "";
  const days = typeof flags.days === "string" ? Number(flags.days) : NaN;
  if (!destination || !Number.isInteger(days)) {
    throw new Error("plan requires --destination <name> and --days <n>");
  }
  const input: PlanInput = {
    destination,
    days,
    startDate: typeof flags.start === "string" ? flags.start : undefined,
    interests:
      typeof flags.interests === "string"
        ? flags.interests.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
    budget: typeof flags.budget === "string" ? flags.budget : undefined,
    pace: typeof flags.pace === "string" ? (flags.pace as PlanInput["pace"]) : undefined,
    companions: typeof flags.with === "string" ? flags.with : undefined,
  };

  console.error(`Planning ${days}-day itinerary for ${destination}…`);
  const it = await planItinerary(input);

  if (flags["dry-run"]) {
    console.log(renderMarkdown(it, input));
    console.error("\n(dry-run: no doc written, no trip updated)");
    return;
  }

  const path = writeObsidianDoc(it, input);
  console.log(renderMarkdown(it, input));
  console.error(`\nWrote itinerary → ${path}`);

  if (typeof flags.trip === "string") {
    const state = loadState();
    updateTrip(state, flags.trip, { itineraryRef: path });
    saveState(state);
    console.error(`Linked itinerary to trip [${flags.trip}]`);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
}
