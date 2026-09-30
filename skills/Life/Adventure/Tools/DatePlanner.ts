#!/usr/bin/env bun
/**
 * DatePlanner.ts — grounded, thoughtful date plans.
 *
 * One `inference()` call turns a vibe + budget + time-of-day + location into a
 * concrete date plan: a primary arc (2-4 beats with real place-TYPES and a
 * sensible flow), a weather/backup alternative, logistics, and a couple of
 * conversation-friendly notes. Defaults location to San Diego (Jm's home base)
 * but works for any city. Structurally VALIDATED before write — a plan that
 * has no real beats or no backup fails loud.
 *
 * Deliberately grounded and honest: it suggests real NEIGHBORHOODS and venue
 * TYPES ("a low-key natural-wine bar in a walkable neighborhood") rather than
 * inventing specific business names/addresses that may be wrong or closed.
 *
 * Usage:
 *   bun DatePlanner.ts plan [--vibe <...>] [--budget <...>] [--time <...>]
 *        [--location <city>] [--season <...>] [--duration <hrs>] [--notes <text>] [--dry-run]
 *
 * @module DatePlanner
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { inference } from "../../../../lib/core/Inference.ts";
import { adventureVaultDir } from "./AdventurePaths.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DateBeat {
  order: number;
  activity: string;
  why: string;
  approxCost?: string;
}

export interface DatePlan {
  title: string;
  vibe: string;
  location: string;
  beats: DateBeat[];
  backup: string;
  logistics: string;
  conversationStarters?: string[];
  budgetNote?: string;
}

export interface DatePlanInput {
  vibe?: string;
  budget?: string;
  time?: string;
  location?: string;
  season?: string;
  durationHrs?: number;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Validation gate
// ---------------------------------------------------------------------------

export function validateDatePlan(dp: unknown): DatePlan {
  if (typeof dp !== "object" || dp === null) throw new Error("Date plan is not an object");
  const o = dp as Record<string, unknown>;
  if (typeof o.title !== "string" || !o.title.trim()) throw new Error("Date plan missing title");
  if (!Array.isArray(o.beats) || o.beats.length < 2) {
    throw new Error("Date plan needs at least 2 beats");
  }
  const beats: DateBeat[] = [];
  for (let i = 0; i < o.beats.length; i++) {
    const b = o.beats[i] as Record<string, unknown>;
    if (typeof b !== "object" || b === null || typeof b.activity !== "string" || !b.activity.trim()) {
      throw new Error(`Beat ${i + 1} has no activity`);
    }
    beats.push({
      order: typeof b.order === "number" ? b.order : i + 1,
      activity: b.activity.trim(),
      why: typeof b.why === "string" ? b.why : "",
      approxCost: typeof b.approxCost === "string" ? b.approxCost : undefined,
    });
  }
  if (typeof o.backup !== "string" || o.backup.trim().length < 10) {
    throw new Error("Date plan needs a real weather/backup alternative");
  }
  return {
    title: o.title.trim(),
    vibe: typeof o.vibe === "string" ? o.vibe : "",
    location: typeof o.location === "string" ? o.location : "",
    beats,
    backup: o.backup.trim(),
    logistics: typeof o.logistics === "string" ? o.logistics : "",
    conversationStarters: Array.isArray(o.conversationStarters)
      ? o.conversationStarters.filter((s): s is string => typeof s === "string")
      : undefined,
    budgetNote: typeof o.budgetNote === "string" ? o.budgetNote : undefined,
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planDate(input: DatePlanInput): Promise<DatePlan> {
  const location = input.location?.trim() || "San Diego, CA";
  const vibe = input.vibe?.trim() || "relaxed but memorable, a little adventurous";
  const budget = input.budget?.trim() || "mid-range";
  const time = input.time?.trim() || "evening";
  const duration = input.durationHrs && input.durationHrs > 0 ? `${input.durationHrs} hours` : "about 3-4 hours";
  const seasonClause = input.season ? ` Season: ${input.season}.` : "";
  const notesClause = input.notes ? ` Extra context: ${input.notes}.` : "";

  const systemPrompt =
    "You are a thoughtful date planner with deep local knowledge of real cities, neighborhoods, and " +
    "the venue TYPES found there. You design dates with a natural arc (an easy opener, a shared " +
    "experience, a warm wind-down) that create real connection and give people things to talk about. " +
    "Suggest real NEIGHBORHOODS and specific venue TYPES, but do NOT invent specific business names, " +
    "addresses, or hours — those go stale. Keep it grounded, kind, and low-pressure. STRICT JSON only.";

  const userPrompt = `Plan a date in ${location}. Vibe: ${vibe}. Budget: ${budget}. Time: ${time}. Duration: ${duration}.${seasonClause}${notesClause}

Return JSON of EXACTLY this shape:
{
  "title": "<short evocative name for the date>",
  "vibe": "${vibe}",
  "location": "${location}",
  "beats": [
    {"order":1,"activity":"<opener — low-pressure, easy to talk over>","why":"<what makes it work>","approxCost":"<$ or free>"},
    {"order":2,"activity":"<main shared experience>","why":"...","approxCost":"..."},
    {"order":3,"activity":"<warm wind-down>","why":"...","approxCost":"..."}
  ],
  "backup": "<a concrete rain/too-crowded/plan-B alternative for the main beat>",
  "logistics": "<parking/transit, what to book ahead, ideal timing, what to wear>",
  "conversationStarters": ["<2-4 natural, non-cheesy prompts fitting the activities>"],
  "budgetNote": "<rough total + one splurge and one save option>"
}
Use 2-4 beats. Anchor to real ${location} neighborhoods/areas and venue types. No invented business names.`;

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
    throw new Error(`Date-plan inference failed: ${result.error ?? "no JSON returned"}`);
  }
  const plan = validateDatePlan(result.parsed);
  if (!plan.location) plan.location = location;
  return plan;
}

// ---------------------------------------------------------------------------
// Render + write
// ---------------------------------------------------------------------------

export function renderMarkdown(dp: DatePlan): string {
  const lines: string[] = [
    `# ${dp.title}`,
    "",
    `**Where:** ${dp.location}  ·  **Vibe:** ${dp.vibe}`,
    "",
    "## The Plan",
  ];
  for (const b of dp.beats) {
    const cost = b.approxCost ? `  _(${b.approxCost})_` : "";
    lines.push(`${b.order}. **${b.activity}**${cost}`);
    if (b.why) lines.push(`   — ${b.why}`);
  }
  lines.push("", `**If the weather/plan turns:** ${dp.backup}`);
  if (dp.logistics) lines.push("", `**Logistics:** ${dp.logistics}`);
  if (dp.budgetNote) lines.push("", `**Budget:** ${dp.budgetNote}`);
  if (dp.conversationStarters?.length) {
    lines.push("", "## Conversation Starters");
    for (const c of dp.conversationStarters) lines.push(`- ${c}`);
  }
  lines.push("", "_Generated by the Adventure skill's DatePlanner. Confirm venue hours before you go._");
  return lines.join("\n");
}

export function writeObsidianDoc(dp: DatePlan): string {
  const dir = adventureVaultDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const safe = dp.title.replace(/[^a-z0-9 ]/gi, "").trim().slice(0, 50) || "Date";
  const path = join(dir, `Date - ${safe}.md`);
  writeFileSync(path, renderMarkdown(dp), "utf8");
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

const USAGE = `DatePlanner — grounded, thoughtful date plans (defaults to San Diego).

Usage: bun skills/Life/Adventure/Tools/DatePlanner.ts plan [flags]

Flags:
  --vibe <text>          e.g. "adventurous", "romantic low-key", "artsy", "active outdoors"
  --budget <text>        e.g. "budget", "mid-range", "splurge", "under $60"
  --time <text>          e.g. "morning", "afternoon", "evening", "late night"
  --location <city>      default: San Diego, CA
  --season <text>        e.g. "summer" (affects outdoor suggestions)
  --duration <hrs>       target length in hours
  --notes <text>         anything about her/the situation (interests, first date, etc.)
  --dry-run              print the plan; do NOT write the Obsidian doc`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== "plan") {
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
  }
  const flags = parseFlags(rest);
  const input: DatePlanInput = {
    vibe: typeof flags.vibe === "string" ? flags.vibe : undefined,
    budget: typeof flags.budget === "string" ? flags.budget : undefined,
    time: typeof flags.time === "string" ? flags.time : undefined,
    location: typeof flags.location === "string" ? flags.location : undefined,
    season: typeof flags.season === "string" ? flags.season : undefined,
    durationHrs: typeof flags.duration === "string" ? Number(flags.duration) : undefined,
    notes: typeof flags.notes === "string" ? flags.notes : undefined,
  };
  console.error("Planning a date…");
  const dp = await planDate(input);

  if (flags["dry-run"]) {
    console.log(renderMarkdown(dp));
    console.error("\n(dry-run: no doc written)");
    return;
  }
  const path = writeObsidianDoc(dp);
  console.log(renderMarkdown(dp));
  console.error(`\nWrote date plan → ${path}`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
}
