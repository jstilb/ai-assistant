#!/usr/bin/env bun
/**
 * PackingListGenerator.ts — build & track checkable packing lists.
 *
 * Two layers, cleanly separated:
 *  1. A DETERMINISTIC base engine (no LLM) — `PACKING_PROFILES` holds a
 *     type-aware, categorized base checklist per trip profile (camping, beach,
 *     international, …), merged with a universal base and adjusted by
 *     duration + season. This is fully testable and is the sole owner of
 *     `data/packing-lists.json`.
 *  2. An OPTIONAL grounded LLM enrichment (`enrichItems`) — adds
 *     destination/activity-specific items the static base can't know (e.g.
 *     "reef-safe sunscreen + booties" for a Baja surf trip, "altitude meds"
 *     for a high-elevation trek). Gated behind `--enrich`; the base list is
 *     always usable without any LLM call.
 *
 * Every generated list is checkable: `check`/`uncheck` toggle items packed,
 * `status` reports progress and flags unpacked ESSENTIALS (the don't-leave-
 * without-it items). Every mutation also rewrites an Obsidian doc so the list
 * is usable on your phone while packing.
 *
 * Subcommands:
 *   generate  — build a list for a profile (optionally --enrich, --trip <id>)
 *   list      — show all saved lists
 *   show      — print one list grouped by category with checkboxes
 *   check     — mark item(s) packed (by number or text match)
 *   uncheck   — mark item(s) unpacked
 *   status    — progress + unpacked essentials
 *   remove    — delete a list
 *
 * @module PackingListGenerator
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { inference } from "../../../../lib/core/Inference.ts";
import { adventureVaultDir, packingStatePath } from "./AdventurePaths.ts";
import { TRIP_TYPES, type TripType } from "./TripTracker.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PackingProfile = TripType;

export type Season = "spring" | "summer" | "fall" | "winter" | "any";

export interface PackingItem {
  category: string;
  name: string;
  /** Don't-leave-without-it item — surfaced by `status` if still unpacked. */
  essential: boolean;
  packed: boolean;
  /** "base" (static template) or "enriched" (LLM-added, trip-specific). */
  source: "base" | "enriched";
}

export interface PackingList {
  id: string;
  label: string;
  profile: PackingProfile;
  durationDays: number;
  season: Season;
  /** Optional link back to a Trip (TripTracker id). */
  tripId: string | null;
  destination: string | null;
  items: PackingItem[];
  createdAt: string;
  updatedAt: string;
}

export interface PackingState {
  lists: PackingList[];
  lastUpdated: string;
}

// ---------------------------------------------------------------------------
// The deterministic base template
// ---------------------------------------------------------------------------

interface BaseItem {
  category: string;
  name: string;
  essential?: boolean;
}

/** Applied to EVERY list regardless of profile. */
const UNIVERSAL_BASE: BaseItem[] = [
  { category: "Documents & Money", name: "ID / driver's license", essential: true },
  { category: "Documents & Money", name: "Wallet + payment cards", essential: true },
  { category: "Documents & Money", name: "Cash for the trip" },
  { category: "Tech", name: "Phone + charger", essential: true },
  { category: "Tech", name: "Portable battery pack" },
  { category: "Toiletries", name: "Toothbrush + toothpaste", essential: true },
  { category: "Toiletries", name: "Deodorant" },
  { category: "Toiletries", name: "Any prescription meds", essential: true },
  { category: "Health", name: "Sunscreen" },
  { category: "Health", name: "Ibuprofen / basic first aid" },
  { category: "Clothing", name: "Underwear (per day)", essential: true },
  { category: "Clothing", name: "Socks (per day)" },
  { category: "Clothing", name: "Sleepwear" },
];

/** Profile-specific additions, merged over the universal base. */
export const PACKING_PROFILES: Record<PackingProfile, BaseItem[]> = {
  camping: [
    { category: "Shelter & Sleep", name: "Tent + stakes + footprint", essential: true },
    { category: "Shelter & Sleep", name: "Sleeping bag (temp-rated)", essential: true },
    { category: "Shelter & Sleep", name: "Sleeping pad" },
    { category: "Shelter & Sleep", name: "Camp pillow" },
    { category: "Kitchen", name: "Camp stove + fuel", essential: true },
    { category: "Kitchen", name: "Lighter / matches (waterproof)", essential: true },
    { category: "Kitchen", name: "Cookpot + utensils + bowl/mug" },
    { category: "Kitchen", name: "Water (1+ gal/person/day) or filter", essential: true },
    { category: "Kitchen", name: "Cooler + food + bear-safe storage" },
    { category: "Kitchen", name: "Trash bags (pack it out)" },
    { category: "Gear", name: "Headlamp + spare batteries", essential: true },
    { category: "Gear", name: "Camp chair" },
    { category: "Gear", name: "Multi-tool / knife" },
    { category: "Gear", name: "Duct tape + paracord" },
    { category: "Clothing", name: "Insulating layer (fleece/puffy)" },
    { category: "Clothing", name: "Rain shell" },
    { category: "Clothing", name: "Sturdy closed-toe shoes/boots", essential: true },
    { category: "Clothing", name: "Warm hat + beanie for night" },
    { category: "Health", name: "Bug spray" },
    { category: "Health", name: "Expanded first-aid kit" },
  ],
  backpacking: [
    { category: "Pack", name: "Backpacking pack (properly fitted)", essential: true },
    { category: "Pack", name: "Pack rain cover / liner" },
    { category: "Shelter & Sleep", name: "Ultralight tent / tarp", essential: true },
    { category: "Shelter & Sleep", name: "Sleeping bag + pad", essential: true },
    { category: "Kitchen", name: "Backpacking stove + fuel canister", essential: true },
    { category: "Kitchen", name: "Water filter / purifier", essential: true },
    { category: "Kitchen", name: "Lightweight pot + spork" },
    { category: "Kitchen", name: "Calorie-dense meals + snacks", essential: true },
    { category: "Kitchen", name: "Bear canister / Ursack (if required)" },
    { category: "Navigation", name: "Map + compass (or GPS)", essential: true },
    { category: "Navigation", name: "Permit (if required)", essential: true },
    { category: "Gear", name: "Headlamp + spare batteries", essential: true },
    { category: "Gear", name: "Trekking poles" },
    { category: "Gear", name: "Blister kit + leukotape" },
    { category: "Clothing", name: "Moisture-wicking base layers" },
    { category: "Clothing", name: "Insulating + rain layers", essential: true },
    { category: "Clothing", name: "Broken-in hiking boots/trail runners", essential: true },
  ],
  beach: [
    { category: "Beach", name: "Swimsuit(s)", essential: true },
    { category: "Beach", name: "Beach towel" },
    { category: "Beach", name: "Sandals / flip-flops" },
    { category: "Beach", name: "Sunglasses" },
    { category: "Beach", name: "Wide-brim hat" },
    { category: "Beach", name: "Beach bag" },
    { category: "Beach", name: "Reef-safe sunscreen (SPF 30+)", essential: true },
    { category: "Beach", name: "Aloe / after-sun" },
    { category: "Beach", name: "Dry bag for phone/valuables" },
    { category: "Clothing", name: "Light cover-up / linen shirt" },
  ],
  surf: [
    { category: "Surf", name: "Board (or arrange rental)", essential: true },
    { category: "Surf", name: "Wetsuit (thickness for water temp)", essential: true },
    { category: "Surf", name: "Leash + spare" },
    { category: "Surf", name: "Wax + traction pad" },
    { category: "Surf", name: "Booties / gloves / hood (cold water)" },
    { category: "Surf", name: "Rash guard" },
    { category: "Surf", name: "Ding-repair kit" },
    { category: "Beach", name: "Changing poncho / towel", essential: true },
    { category: "Beach", name: "Reef-safe sunscreen + zinc", essential: true },
    { category: "Beach", name: "Dry bag" },
    { category: "Health", name: "Ear plugs (surfer's ear)" },
  ],
  roadtrip: [
    { category: "Vehicle", name: "License, registration, insurance card", essential: true },
    { category: "Vehicle", name: "Phone car mount + charging cable" },
    { category: "Vehicle", name: "Roadside kit (jumper, tire gauge)" },
    { category: "Vehicle", name: "Spare tire check + jack" },
    { category: "Comfort", name: "Snacks + refillable water bottles" },
    { category: "Comfort", name: "Cooler" },
    { category: "Comfort", name: "Offline maps / playlists / podcasts" },
    { category: "Comfort", name: "Sunglasses" },
    { category: "Comfort", name: "Neck pillow + blanket" },
    { category: "Comfort", name: "Reusable bag for trash" },
  ],
  international: [
    { category: "Documents & Money", name: "Passport (6+ mo validity)", essential: true },
    { category: "Documents & Money", name: "Visa / entry docs (if required)", essential: true },
    { category: "Documents & Money", name: "Copies of passport (digital + paper)" },
    { category: "Documents & Money", name: "Travel insurance info" },
    { category: "Documents & Money", name: "Local currency + no-FX-fee card" },
    { category: "Tech", name: "Universal power adapter", essential: true },
    { category: "Tech", name: "eSIM / local SIM plan" },
    { category: "Health", name: "Prescription meds in original bottles", essential: true },
    { category: "Health", name: "Any required vaccination proof" },
    { category: "Health", name: "Motion-sickness / stomach meds" },
    { category: "Gear", name: "Packing cubes" },
    { category: "Gear", name: "Reusable water bottle (empty through security)" },
    { category: "Clothing", name: "Layer for the flight" },
  ],
  city: [
    { category: "Gear", name: "Daypack / crossbody bag" },
    { category: "Gear", name: "Comfortable walking shoes", essential: true },
    { category: "Gear", name: "Compact umbrella / packable rain jacket" },
    { category: "Clothing", name: "One smart-casual outfit for dinners out" },
    { category: "Tech", name: "Offline maps + transit app" },
    { category: "Documents & Money", name: "Hotel/booking confirmations" },
  ],
  daytrip: [
    { category: "Gear", name: "Daypack", essential: true },
    { category: "Gear", name: "Water + snacks", essential: true },
    { category: "Gear", name: "Layer for weather change" },
    { category: "Gear", name: "Sunglasses + hat" },
  ],
  other: [
    { category: "Gear", name: "Daypack" },
    { category: "Clothing", name: "Weather-appropriate outer layer" },
  ],
};

/** Season-driven additions, layered on top of profile + universal. */
const SEASON_ADDS: Record<Season, BaseItem[]> = {
  summer: [
    { category: "Clothing", name: "Lightweight breathable clothing" },
    { category: "Health", name: "Extra sunscreen + electrolytes" },
  ],
  winter: [
    { category: "Clothing", name: "Insulated jacket", essential: true },
    { category: "Clothing", name: "Gloves + warm hat" },
    { category: "Clothing", name: "Thermal base layers" },
    { category: "Health", name: "Lip balm + hand lotion" },
  ],
  spring: [{ category: "Clothing", name: "Packable rain jacket" }],
  fall: [{ category: "Clothing", name: "Warm mid-layer for cool evenings" }],
  any: [],
};

// ---------------------------------------------------------------------------
// Deterministic base builder
// ---------------------------------------------------------------------------

/**
 * Build the base (LLM-free) item list for a profile. Merges universal + profile
 * + season items, de-duplicating by (category, name) with essential-wins.
 * Purely a function of its inputs — the unit of determinism the tests pin.
 */
export function buildBaseItems(
  profile: PackingProfile,
  season: Season = "any",
): PackingItem[] {
  const merged = new Map<string, PackingItem>();
  const add = (b: BaseItem) => {
    const key = `${b.category}::${b.name}`.toLowerCase();
    const existing = merged.get(key);
    if (existing) {
      existing.essential = existing.essential || Boolean(b.essential);
      return;
    }
    merged.set(key, {
      category: b.category,
      name: b.name,
      essential: Boolean(b.essential),
      packed: false,
      source: "base",
    });
  };
  UNIVERSAL_BASE.forEach(add);
  (PACKING_PROFILES[profile] ?? PACKING_PROFILES.other).forEach(add);
  (SEASON_ADDS[season] ?? []).forEach(add);
  return [...merged.values()];
}

// ---------------------------------------------------------------------------
// State load / save (single owner of packing-lists.json)
// ---------------------------------------------------------------------------

export function loadState(statePath: string = packingStatePath()): PackingState {
  if (!existsSync(statePath)) {
    return { lists: [], lastUpdated: new Date().toISOString() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (e) {
    throw new Error(`Failed to parse packing-lists.json at ${statePath}: ${String(e)}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { lists?: unknown }).lists)
  ) {
    throw new Error(`packing-lists.json at ${statePath} is malformed (missing lists[])`);
  }
  return parsed as PackingState;
}

export function saveState(state: PackingState, statePath: string = packingStatePath()): void {
  state.lastUpdated = new Date().toISOString();
  const dir = dirname(statePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "packing";
}

function uniqueId(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

// ---------------------------------------------------------------------------
// LLM enrichment (optional, grounded, validated)
// ---------------------------------------------------------------------------

/**
 * Ask the model for destination/activity-specific items the static base can't
 * know. Returns validated, de-duplicated items marked source:"enriched".
 * Throws on inference failure so the caller can fall back to the base list.
 */
export async function enrichItems(
  profile: PackingProfile,
  destination: string,
  durationDays: number,
  season: Season,
  existing: PackingItem[],
): Promise<PackingItem[]> {
  const have = existing.map((i) => i.name.toLowerCase());
  const systemPrompt =
    "You are an expert trip-packing advisor. Given a trip, list only the SPECIFIC extra items " +
    "a smart traveler would add for THIS destination/activity that a generic checklist would miss. " +
    "Be concrete and grounded — no filler, no items already covered. Return STRICT JSON only.";
  const userPrompt = `Trip: ${profile} trip to ${destination}, ${durationDays} day(s), season: ${season}.
Already on the list (do NOT repeat these): ${existing.map((i) => i.name).join("; ")}.

Return JSON of the form:
{"items":[{"category":"<short category>","name":"<specific item>","essential":<true|false>}]}
Include 5-12 destination-specific items. "essential" = would meaningfully hurt the trip if forgotten.
Categories should reuse existing ones where sensible (Clothing, Health, Gear, Documents & Money, Tech, etc.).`;

  const result = await inference({
    systemPrompt,
    userPrompt,
    level: "standard",
    expectJson: true,
    timeout: 120_000,
    retries: 1,
    retryDelayMs: 3000,
  });
  if (!result.success || result.parsed === undefined) {
    throw new Error(`Packing enrichment failed: ${result.error ?? "no JSON"}`);
  }
  const parsed = result.parsed as { items?: unknown };
  if (!Array.isArray(parsed.items)) {
    throw new Error("Packing enrichment returned no items[]");
  }
  const out: PackingItem[] = [];
  const seen = new Set(have);
  for (const raw of parsed.items) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as { category?: unknown; name?: unknown; essential?: unknown };
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const category = typeof r.category === "string" && r.category.trim() ? r.category.trim() : "Gear";
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({
      category,
      name,
      essential: r.essential === true,
      packed: false,
      source: "enriched",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

export interface GenerateInput {
  profile: PackingProfile;
  label?: string;
  destination?: string | null;
  durationDays?: number;
  season?: Season;
  tripId?: string | null;
  enriched?: PackingItem[];
}

export function makeList(state: PackingState, input: GenerateInput): PackingList {
  if (!TRIP_TYPES.includes(input.profile)) {
    throw new Error(`Unknown profile "${input.profile}" (want one of ${TRIP_TYPES.join(", ")})`);
  }
  const durationDays = input.durationDays && input.durationDays > 0 ? input.durationDays : 3;
  const season = input.season ?? "any";
  const base = buildBaseItems(input.profile, season);
  const items = [...base, ...(input.enriched ?? [])];
  const label =
    input.label?.trim() ||
    `${input.destination?.trim() || capitalize(input.profile)} — ${input.profile} (${durationDays}d)`;
  const existing = new Set(state.lists.map((l) => l.id));
  const id = uniqueId(slugify(label), existing);
  const now = new Date().toISOString();
  const list: PackingList = {
    id,
    label,
    profile: input.profile,
    durationDays,
    season,
    tripId: input.tripId ?? null,
    destination: input.destination ?? null,
    items,
    createdAt: now,
    updatedAt: now,
  };
  state.lists.push(list);
  return list;
}

// ---------------------------------------------------------------------------
// Mutations on a list
// ---------------------------------------------------------------------------

export function findList(state: PackingState, id: string): PackingList {
  const list = state.lists.find((l) => l.id === id);
  if (!list) throw new Error(`No packing list with id "${id}"`);
  return list;
}

/** Toggle items packed/unpacked by 1-based index or case-insensitive name substring. */
export function setPacked(list: PackingList, selector: string, packed: boolean): PackingItem[] {
  const touched: PackingItem[] = [];
  const asNum = Number(selector);
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= list.items.length) {
    const item = list.items[asNum - 1]!;
    item.packed = packed;
    touched.push(item);
  } else {
    const needle = selector.toLowerCase();
    for (const item of list.items) {
      if (item.name.toLowerCase().includes(needle)) {
        item.packed = packed;
        touched.push(item);
      }
    }
  }
  if (touched.length === 0) throw new Error(`No item matched "${selector}"`);
  list.updatedAt = new Date().toISOString();
  return touched;
}

export interface PackingStatusReport {
  total: number;
  packed: number;
  unpackedEssentials: PackingItem[];
  complete: boolean;
}

export function statusOf(list: PackingList): PackingStatusReport {
  const packed = list.items.filter((i) => i.packed).length;
  const unpackedEssentials = list.items.filter((i) => i.essential && !i.packed);
  return {
    total: list.items.length,
    packed,
    unpackedEssentials,
    complete: packed === list.items.length,
  };
}

export function removeList(state: PackingState, id: string): PackingList {
  const idx = state.lists.findIndex((l) => l.id === id);
  if (idx === -1) throw new Error(`No packing list with id "${id}"`);
  const [removed] = state.lists.splice(idx, 1);
  return removed!;
}

// ---------------------------------------------------------------------------
// Rendering + Obsidian doc
// ---------------------------------------------------------------------------

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function groupByCategory(items: PackingItem[]): Map<string, PackingItem[]> {
  const groups = new Map<string, PackingItem[]>();
  for (const item of items) {
    const arr = groups.get(item.category) ?? [];
    arr.push(item);
    groups.set(item.category, arr);
  }
  return groups;
}

export function renderMarkdown(list: PackingList): string {
  const st = statusOf(list);
  const lines: string[] = [
    `# Packing List — ${list.label}`,
    "",
    `**Profile:** ${list.profile}  ·  **Duration:** ${list.durationDays} day(s)  ·  **Season:** ${list.season}`,
    list.destination ? `**Destination:** ${list.destination}` : "",
    list.tripId ? `**Trip:** ${list.tripId}` : "",
    `**Progress:** ${st.packed}/${st.total} packed${st.complete ? " ✅" : ""}`,
    "",
  ].filter(Boolean);
  for (const [category, items] of groupByCategory(list.items)) {
    lines.push(`## ${category}`);
    for (const item of items) {
      const box = item.packed ? "[x]" : "[ ]";
      const star = item.essential ? " ⭐" : "";
      lines.push(`- ${box} ${item.name}${star}`);
    }
    lines.push("");
  }
  lines.push("_⭐ = essential. Generated by the Adventure skill's PackingListGenerator._");
  return lines.join("\n");
}

export function writeObsidianDoc(list: PackingList): string {
  const dir = adventureVaultDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `Packing - ${list.label}.md`);
  writeFileSync(path, renderMarkdown(list), "utf8");
  return path;
}

function renderConsole(list: PackingList): string {
  const st = statusOf(list);
  const lines = [`${list.label}  [${list.id}]  ${st.packed}/${st.total} packed`, ""];
  let n = 0;
  for (const [category, items] of groupByCategory(list.items)) {
    lines.push(category);
    for (const item of items) {
      n++;
      const box = item.packed ? "✓" : " ";
      const star = item.essential ? " *" : "";
      lines.push(`  ${String(n).padStart(2)}. [${box}] ${item.name}${star}`);
    }
  }
  return lines.join("\n");
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

const SEASONS: readonly Season[] = ["spring", "summer", "fall", "winter", "any"];

const USAGE = `PackingListGenerator — build & track checkable packing lists.

Usage: bun skills/Life/Adventure/Tools/PackingListGenerator.ts <command> [flags]

Commands:
  generate  --profile <${TRIP_TYPES.join("|")}> [--destination <name>] [--days <n>]
            [--season <${SEASONS.join("|")}>] [--trip <tripId>] [--label <text>] [--enrich]
  list
  show      --id <id>
  check     --id <id> --item <number|text>
  uncheck   --id <id> --item <number|text>
  status    --id <id>
  remove    --id <id>

--enrich adds destination-specific items via one grounded LLM call (base list works without it).
State: data/packing-lists.json (override ADVENTURE_PACKING_PATH). Docs → Obsidian/Adventure/.`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const state = loadState();

  switch (cmd) {
    case "generate": {
      const profile = (typeof flags.profile === "string" ? flags.profile : "other") as PackingProfile;
      if (!TRIP_TYPES.includes(profile)) {
        throw new Error(`--profile must be one of ${TRIP_TYPES.join(", ")}`);
      }
      const season = (typeof flags.season === "string" ? flags.season : "any") as Season;
      if (!SEASONS.includes(season)) throw new Error(`--season must be one of ${SEASONS.join(", ")}`);
      const destination = typeof flags.destination === "string" ? flags.destination : null;
      const durationDays = typeof flags.days === "string" ? Number(flags.days) : undefined;

      let enriched: PackingItem[] | undefined;
      if (flags.enrich) {
        const base = buildBaseItems(profile, season);
        try {
          enriched = await enrichItems(
            profile,
            destination ?? capitalize(profile),
            durationDays && durationDays > 0 ? durationDays : 3,
            season,
            base,
          );
          console.log(`Enriched with ${enriched.length} destination-specific item(s).`);
        } catch (e) {
          console.error(`(enrichment skipped: ${e instanceof Error ? e.message : String(e)})`);
        }
      }

      const list = makeList(state, {
        profile,
        destination,
        durationDays,
        season,
        tripId: typeof flags.trip === "string" ? flags.trip : null,
        label: typeof flags.label === "string" ? flags.label : undefined,
        enriched,
      });
      saveState(state);
      const docPath = writeObsidianDoc(list);
      console.log(`\nCreated packing list [${list.id}] → ${docPath}\n`);
      console.log(renderConsole(list));
      break;
    }
    case "list": {
      if (state.lists.length === 0) {
        console.log("No packing lists yet. Try: generate --profile camping");
        break;
      }
      for (const l of state.lists) {
        const st = statusOf(l);
        console.log(`[${l.id}]  ${l.label}  —  ${st.packed}/${st.total} packed`);
      }
      break;
    }
    case "show": {
      const id = typeof flags.id === "string" ? flags.id : "";
      console.log(renderConsole(findList(state, id)));
      break;
    }
    case "check":
    case "uncheck": {
      const id = typeof flags.id === "string" ? flags.id : "";
      const selector = typeof flags.item === "string" ? flags.item : "";
      if (!selector) throw new Error("--item <number|text> is required");
      const list = findList(state, id);
      const touched = setPacked(list, selector, cmd === "check");
      saveState(state);
      writeObsidianDoc(list);
      const verb = cmd === "check" ? "Packed" : "Unpacked";
      console.log(`${verb}: ${touched.map((t) => t.name).join(", ")}`);
      const st = statusOf(list);
      console.log(`Progress: ${st.packed}/${st.total}`);
      break;
    }
    case "status": {
      const id = typeof flags.id === "string" ? flags.id : "";
      const list = findList(state, id);
      const st = statusOf(list);
      console.log(`${list.label}: ${st.packed}/${st.total} packed${st.complete ? " ✅ ready!" : ""}`);
      if (st.unpackedEssentials.length > 0) {
        console.log(`\n⚠️  Unpacked essentials (${st.unpackedEssentials.length}):`);
        for (const e of st.unpackedEssentials) console.log(`   • ${e.name} (${e.category})`);
      } else if (!st.complete) {
        console.log("\nAll essentials packed — only nice-to-haves remain.");
      }
      break;
    }
    case "remove": {
      const id = typeof flags.id === "string" ? flags.id : "";
      const removed = removeList(state, id);
      saveState(state);
      console.log(`Removed: ${removed.label} [${removed.id}]`);
      break;
    }
    default:
      console.log(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
}
