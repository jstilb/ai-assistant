#!/usr/bin/env bun
/**
 * TripTracker.ts — manage the pipeline of trips & adventures.
 *
 * This is the deterministic backbone of the Adventure skill. It is the SOLE
 * owner of `data/trips.json` and makes NO LLM calls — the creative, grounded
 * concerns (itineraries, date plans, spontaneous suggestions, packing
 * enrichment) live in their own tools. A trip here is a lightweight record
 * that ties together dates, type, companions, budget, and links out to the
 * itinerary doc and packing list produced by the other tools.
 *
 * The killer feature is `agenda`: "what's coming up, how many days away, and
 * am I ready?" — for each upcoming trip it computes a countdown and a
 * readiness note (itinerary planned? packing started/done?) and, inside a
 * pre-trip window, nudges you to start packing.
 *
 * Subcommands (see the CLI usage block at the bottom):
 *   add       — start tracking a trip
 *   list      — show tracked trips (filter by status)
 *   show      — print one trip in full
 *   update    — edit fields on a trip (dates, status, budget, links, notes)
 *   agenda    — upcoming trips sorted by proximity, with countdown + readiness
 *   complete  — mark a trip completed
 *   cancel    — mark a trip cancelled
 *   remove    — delete a trip record
 *
 * Status is normally inferred from the calendar (planning → upcoming → active
 * → completed) but can be pinned via `update --status` or the terminal
 * `complete`/`cancel` verbs. `--date` overrides "today" for testability.
 *
 * @module TripTracker
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { tripsStatePath } from "./AdventurePaths.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lifecycle of a trip. `planning`/`upcoming`/`active` are date-derived unless pinned. */
export type TripStatus = "planning" | "upcoming" | "active" | "completed" | "cancelled";

/** Coarse trip kind — drives the default packing profile and framing. */
export type TripType =
  | "camping"
  | "roadtrip"
  | "international"
  | "city"
  | "beach"
  | "backpacking"
  | "surf"
  | "daytrip"
  | "other";

export const TRIP_TYPES: readonly TripType[] = [
  "camping",
  "roadtrip",
  "international",
  "city",
  "beach",
  "backpacking",
  "surf",
  "daytrip",
  "other",
] as const;

export interface Trip {
  id: string;
  /** Human destination label, e.g. "Joshua Tree" or "Oaxaca, Mexico". */
  destination: string;
  type: TripType;
  /** Trip start, YYYY-MM-DD, or null if undated (a someday/spontaneous idea). */
  startDate: string | null;
  /** Trip end, YYYY-MM-DD, or null (single-day or open-ended). */
  endDate: string | null;
  /** Pinned status, or null to derive from the calendar. */
  status: TripStatus | null;
  /** Who's coming along (free text: "Julie", "boys trip", "solo"). */
  companions: string | null;
  /** Rough budget in USD, or null. */
  budget: number | null;
  /** Relative/absolute path to the itinerary doc, or null if not planned yet. */
  itineraryRef: string | null;
  /** Id of the linked packing list (see PackingListGenerator), or null. */
  packingListId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TripsState {
  trips: Trip[];
  lastUpdated: string;
}

// ---------------------------------------------------------------------------
// Date helpers (calendar-day math, timezone-stable via UTC anchoring)
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Today's calendar day in the local timezone, YYYY-MM-DD. */
export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Parse a YYYY-MM-DD string to UTC-midnight epoch ms (calendar-day anchor). */
function parseDay(iso: string): number {
  const parts = iso.split("-").map(Number);
  const y = parts[0]!;
  const m = parts[1]!;
  const d = parts[2]!;
  return Date.UTC(y, m - 1, d);
}

/** Whole days from `a` to `b` (b − a); negative if b is before a. */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseDay(b) - parseDay(a)) / 86_400_000);
}

/** True for a well-formed YYYY-MM-DD calendar day. */
export function isValidDay(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const ms = parseDay(iso);
  return new Date(ms).toISOString().slice(0, 10) === iso;
}

// ---------------------------------------------------------------------------
// State load / save (single owner of trips.json)
// ---------------------------------------------------------------------------

export function loadState(statePath: string = tripsStatePath()): TripsState {
  if (!existsSync(statePath)) {
    return { trips: [], lastUpdated: new Date().toISOString() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (e) {
    throw new Error(`Failed to parse trips.json at ${statePath}: ${String(e)}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { trips?: unknown }).trips)
  ) {
    throw new Error(`trips.json at ${statePath} is malformed (missing trips[])`);
  }
  return parsed as TripsState;
}

export function saveState(state: TripsState, statePath: string = tripsStatePath()): void {
  state.lastUpdated = new Date().toISOString();
  const dir = dirname(statePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Id generation (deterministic — no randomness)
// ---------------------------------------------------------------------------

function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "trip";
}

function uniqueId(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

/**
 * Effective status of a trip as of `asOf`. A pinned `status` (completed,
 * cancelled, or an explicit override) always wins; otherwise it's derived
 * from the calendar: before start → upcoming (or planning if undated),
 * within [start,end] → active, after end → completed.
 */
export function effectiveStatus(trip: Trip, asOf: string = todayISO()): TripStatus {
  if (trip.status) return trip.status;
  if (!trip.startDate) return "planning";
  const toStart = daysBetween(asOf, trip.startDate);
  if (toStart > 0) return "upcoming";
  const end = trip.endDate ?? trip.startDate;
  const toEnd = daysBetween(asOf, end);
  if (toEnd >= 0) return "active";
  return "completed";
}

/** Trip is neither completed nor cancelled as of `asOf`. */
function isOpen(trip: Trip, asOf: string): boolean {
  const s = effectiveStatus(trip, asOf);
  return s !== "completed" && s !== "cancelled";
}

// ---------------------------------------------------------------------------
// Agenda — the killer "what's coming up and am I ready?" view
// ---------------------------------------------------------------------------

/** How many days out a trip starts surfacing a "start packing" nudge. */
export const PACKING_NUDGE_DAYS = 7;

export interface AgendaEntry {
  trip: Trip;
  status: TripStatus;
  /** Days until the trip starts (0 = starts today, negative = already active). */
  daysUntil: number | null;
  /** Human-readable readiness summary, e.g. "no itinerary · packing not started". */
  readiness: string;
  /** True when inside the pre-trip window and packing isn't done. */
  packingNudge: boolean;
}

/**
 * Upcoming/active trips sorted soonest-first, each annotated with a countdown
 * and a readiness note. Undated planning ideas sort last (they have no clock).
 * Completed/cancelled trips are excluded.
 */
export function agenda(state: TripsState, asOf: string = todayISO()): AgendaEntry[] {
  const open = state.trips.filter((t) => isOpen(t, asOf));
  const entries: AgendaEntry[] = open.map((trip) => {
    const status = effectiveStatus(trip, asOf);
    const daysUntil = trip.startDate ? daysBetween(asOf, trip.startDate) : null;
    const readiness = readinessNote(trip);
    const packingDone = packingIsDone(trip);
    const packingNudge =
      daysUntil !== null && daysUntil >= 0 && daysUntil <= PACKING_NUDGE_DAYS && !packingDone;
    return { trip, status, daysUntil, readiness, packingNudge };
  });
  // Sort: dated soonest-first, undated (null) last.
  entries.sort((a, b) => {
    if (a.daysUntil === null && b.daysUntil === null) return 0;
    if (a.daysUntil === null) return 1;
    if (b.daysUntil === null) return -1;
    return a.daysUntil - b.daysUntil;
  });
  return entries;
}

function packingIsDone(trip: Trip): boolean {
  // The tracker only knows whether a list is *linked*; completeness lives in
  // PackingListGenerator's own state. We treat "linked" as "packing started".
  // A caller wanting true done-ness passes it via update notes; here linked
  // means at least underway, which is enough to quiet the nudge conservatively
  // only once the user marks the list complete via update --status.
  return false;
}

function readinessNote(trip: Trip): string {
  const parts: string[] = [];
  parts.push(trip.itineraryRef ? "itinerary planned" : "no itinerary");
  parts.push(trip.packingListId ? "packing list linked" : "no packing list");
  if (trip.budget === null) parts.push("no budget set");
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface AddTripInput {
  destination: string;
  type?: TripType;
  startDate?: string | null;
  endDate?: string | null;
  companions?: string | null;
  budget?: number | null;
  notes?: string | null;
  itineraryRef?: string | null;
  packingListId?: string | null;
}

export function addTrip(state: TripsState, input: AddTripInput): Trip {
  if (!input.destination || !input.destination.trim()) {
    throw new Error("addTrip: destination is required");
  }
  if (input.startDate && !isValidDay(input.startDate)) {
    throw new Error(`addTrip: invalid startDate "${input.startDate}" (want YYYY-MM-DD)`);
  }
  if (input.endDate && !isValidDay(input.endDate)) {
    throw new Error(`addTrip: invalid endDate "${input.endDate}" (want YYYY-MM-DD)`);
  }
  if (input.startDate && input.endDate && daysBetween(input.startDate, input.endDate) < 0) {
    throw new Error("addTrip: endDate is before startDate");
  }
  const type = input.type ?? "other";
  if (!TRIP_TYPES.includes(type)) {
    throw new Error(`addTrip: unknown type "${type}" (want one of ${TRIP_TYPES.join(", ")})`);
  }
  const existing = new Set(state.trips.map((t) => t.id));
  const id = uniqueId(slugify(input.destination), existing);
  const now = new Date().toISOString();
  const trip: Trip = {
    id,
    destination: input.destination.trim(),
    type,
    startDate: input.startDate ?? null,
    endDate: input.endDate ?? null,
    status: null,
    companions: input.companions ?? null,
    budget: input.budget ?? null,
    itineraryRef: input.itineraryRef ?? null,
    packingListId: input.packingListId ?? null,
    notes: input.notes ?? null,
    createdAt: now,
    updatedAt: now,
  };
  state.trips.push(trip);
  return trip;
}

export function findTrip(state: TripsState, id: string): Trip {
  const trip = state.trips.find((t) => t.id === id);
  if (!trip) throw new Error(`No trip with id "${id}"`);
  return trip;
}

export interface UpdateTripInput {
  destination?: string;
  type?: TripType;
  startDate?: string | null;
  endDate?: string | null;
  status?: TripStatus | null;
  companions?: string | null;
  budget?: number | null;
  itineraryRef?: string | null;
  packingListId?: string | null;
  notes?: string | null;
}

export function updateTrip(state: TripsState, id: string, patch: UpdateTripInput): Trip {
  const trip = findTrip(state, id);
  if (patch.destination !== undefined) {
    if (!patch.destination.trim()) throw new Error("updateTrip: destination cannot be empty");
    trip.destination = patch.destination.trim();
  }
  if (patch.type !== undefined) {
    if (!TRIP_TYPES.includes(patch.type)) {
      throw new Error(`updateTrip: unknown type "${patch.type}"`);
    }
    trip.type = patch.type;
  }
  if (patch.startDate !== undefined) {
    if (patch.startDate && !isValidDay(patch.startDate)) {
      throw new Error(`updateTrip: invalid startDate "${patch.startDate}"`);
    }
    trip.startDate = patch.startDate;
  }
  if (patch.endDate !== undefined) {
    if (patch.endDate && !isValidDay(patch.endDate)) {
      throw new Error(`updateTrip: invalid endDate "${patch.endDate}"`);
    }
    trip.endDate = patch.endDate;
  }
  if (trip.startDate && trip.endDate && daysBetween(trip.startDate, trip.endDate) < 0) {
    throw new Error("updateTrip: endDate is before startDate");
  }
  if (patch.status !== undefined) trip.status = patch.status;
  if (patch.companions !== undefined) trip.companions = patch.companions;
  if (patch.budget !== undefined) trip.budget = patch.budget;
  if (patch.itineraryRef !== undefined) trip.itineraryRef = patch.itineraryRef;
  if (patch.packingListId !== undefined) trip.packingListId = patch.packingListId;
  if (patch.notes !== undefined) trip.notes = patch.notes;
  trip.updatedAt = new Date().toISOString();
  return trip;
}

export function removeTrip(state: TripsState, id: string): Trip {
  const idx = state.trips.findIndex((t) => t.id === id);
  if (idx === -1) throw new Error(`No trip with id "${id}"`);
  const [removed] = state.trips.splice(idx, 1);
  return removed!;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function fmtDates(trip: Trip): string {
  if (!trip.startDate) return "undated";
  if (!trip.endDate || trip.endDate === trip.startDate) return trip.startDate;
  const nights = daysBetween(trip.startDate, trip.endDate);
  return `${trip.startDate} → ${trip.endDate} (${nights} night${nights === 1 ? "" : "s"})`;
}

function renderTrip(trip: Trip, asOf: string): string {
  const status = effectiveStatus(trip, asOf);
  const lines = [
    `${trip.destination}  [${trip.id}]`,
    `  type: ${trip.type}   status: ${status}   dates: ${fmtDates(trip)}`,
  ];
  if (trip.companions) lines.push(`  with: ${trip.companions}`);
  if (trip.budget !== null) lines.push(`  budget: $${trip.budget}`);
  lines.push(`  itinerary: ${trip.itineraryRef ?? "—"}   packing: ${trip.packingListId ?? "—"}`);
  if (trip.notes) lines.push(`  notes: ${trip.notes}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI arg parsing
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

function asType(v: string | boolean | undefined): TripType | undefined {
  if (typeof v !== "string") return undefined;
  if (!TRIP_TYPES.includes(v as TripType)) {
    throw new Error(`Unknown --type "${v}" (want one of ${TRIP_TYPES.join(", ")})`);
  }
  return v as TripType;
}

function asBudget(v: string | boolean | undefined): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === "none" || v === "null") return null;
  if (typeof v !== "string") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid --budget "${v}"`);
  return n;
}

const USAGE = `TripTracker — the deterministic backbone of the Adventure skill.

Usage: bun skills/Life/Adventure/Tools/TripTracker.ts <command> [flags]

Commands:
  add       --destination <name> [--type <t>] [--start <YYYY-MM-DD>] [--end <YYYY-MM-DD>]
            [--with <companions>] [--budget <usd>] [--itinerary <path>] [--packing <id>] [--notes <text>]
  list      [--status <planning|upcoming|active|completed|cancelled|all>]  (default: open trips)
  show      --id <id>
  update    --id <id> [any add flag] [--status <s|none>] [--budget <usd|none>]
  agenda    [--date <YYYY-MM-DD>]        upcoming trips + countdown + readiness
  complete  --id <id>
  cancel    --id <id>
  remove    --id <id>

Trip types: ${TRIP_TYPES.join(", ")}
--date overrides "today" (testability). State: data/trips.json (override ADVENTURE_TRIPS_PATH).`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const asOf = typeof flags.date === "string" ? flags.date : todayISO();
  const state = loadState();

  switch (cmd) {
    case "add": {
      const destination = typeof flags.destination === "string" ? flags.destination : "";
      const trip = addTrip(state, {
        destination,
        type: asType(flags.type),
        startDate: typeof flags.start === "string" ? flags.start : undefined,
        endDate: typeof flags.end === "string" ? flags.end : undefined,
        companions: typeof flags.with === "string" ? flags.with : undefined,
        budget: asBudget(flags.budget) ?? undefined,
        itineraryRef: typeof flags.itinerary === "string" ? flags.itinerary : undefined,
        packingListId: typeof flags.packing === "string" ? flags.packing : undefined,
        notes: typeof flags.notes === "string" ? flags.notes : undefined,
      });
      saveState(state);
      console.log(`Added trip [${trip.id}]\n`);
      console.log(renderTrip(trip, asOf));
      break;
    }
    case "list": {
      const filter = typeof flags.status === "string" ? flags.status : "open";
      let trips = state.trips;
      if (filter === "open") {
        trips = trips.filter((t) => isOpen(t, asOf));
      } else if (filter !== "all") {
        trips = trips.filter((t) => effectiveStatus(t, asOf) === filter);
      }
      if (trips.length === 0) {
        console.log("No trips.");
        break;
      }
      console.log(trips.map((t) => renderTrip(t, asOf)).join("\n\n"));
      break;
    }
    case "show": {
      const id = typeof flags.id === "string" ? flags.id : "";
      console.log(renderTrip(findTrip(state, id), asOf));
      break;
    }
    case "update": {
      const id = typeof flags.id === "string" ? flags.id : "";
      const statusRaw = flags.status;
      const status: TripStatus | null | undefined =
        statusRaw === undefined
          ? undefined
          : statusRaw === "none" || statusRaw === "null"
            ? null
            : (statusRaw as TripStatus);
      const trip = updateTrip(state, id, {
        destination: typeof flags.destination === "string" ? flags.destination : undefined,
        type: asType(flags.type),
        startDate: flags.start === undefined ? undefined : flags.start === "none" ? null : String(flags.start),
        endDate: flags.end === undefined ? undefined : flags.end === "none" ? null : String(flags.end),
        status,
        companions: typeof flags.with === "string" ? flags.with : undefined,
        budget: asBudget(flags.budget),
        itineraryRef: typeof flags.itinerary === "string" ? flags.itinerary : undefined,
        packingListId: typeof flags.packing === "string" ? flags.packing : undefined,
        notes: typeof flags.notes === "string" ? flags.notes : undefined,
      });
      saveState(state);
      console.log(`Updated [${trip.id}]\n`);
      console.log(renderTrip(trip, asOf));
      break;
    }
    case "agenda": {
      const entries = agenda(state, asOf);
      if (entries.length === 0) {
        console.log("No upcoming trips. Time to plan one — try SpontaneousAdventure.ts.");
        break;
      }
      const out: string[] = [`Adventure agenda (as of ${asOf}):\n`];
      for (const e of entries) {
        const when =
          e.daysUntil === null
            ? "someday"
            : e.daysUntil === 0
              ? "TODAY"
              : e.daysUntil < 0
                ? `in progress (day ${-e.daysUntil + 1})`
                : `in ${e.daysUntil} day${e.daysUntil === 1 ? "" : "s"}`;
        out.push(`• ${e.trip.destination} — ${when}  [${e.status}]`);
        out.push(`    ${fmtDates(e.trip)} · ${e.readiness}`);
        if (e.packingNudge) out.push(`    ⚠️  start packing — trip is within ${PACKING_NUDGE_DAYS} days`);
      }
      console.log(out.join("\n"));
      break;
    }
    case "complete": {
      const id = typeof flags.id === "string" ? flags.id : "";
      const trip = updateTrip(state, id, { status: "completed" });
      saveState(state);
      console.log(`Marked completed: ${trip.destination} [${trip.id}]`);
      break;
    }
    case "cancel": {
      const id = typeof flags.id === "string" ? flags.id : "";
      const trip = updateTrip(state, id, { status: "cancelled" });
      saveState(state);
      console.log(`Marked cancelled: ${trip.destination} [${trip.id}]`);
      break;
    }
    case "remove": {
      const id = typeof flags.id === "string" ? flags.id : "";
      const removed = removeTrip(state, id);
      saveState(state);
      console.log(`Removed: ${removed.destination} [${removed.id}]`);
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
