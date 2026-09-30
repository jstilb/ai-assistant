#!/usr/bin/env bun
/**
 * cli.ts — EventScout CLI entrypoint (Slice 8).
 *
 * Runnable:
 *   bun skills/Productivity/EventScout/cli.ts <subcommand> [args]
 *
 * Subcommands:
 *   query "<query text>"  [--from YYYY-MM-DD --to YYYY-MM-DD] [--free]
 *                          [--max-price N] [--category <cat>]... [--time-of-day <bucket>]...
 *                          [--limit N] [--refresh]
 *       Cache-first query: reads from cache by default (no live fetching).
 *       Zero NL interpretation happens in code — the calling agent resolves
 *       dates/refresh-intent/price-mode/category-explicitness (see SKILL.md)
 *       and passes structured flags. Pass --refresh to trigger a live refresh
 *       of category-relevant sources, then read cache, filter, rank, and
 *       print ranked events. Omitting --from/--to defaults to the next 14
 *       days (a banner is printed).
 *
 *   prefetch
 *       Ingest all enabled sources; print per-source counts; update each
 *       ingested source's lastFetched in State/source-state.json.
 *
 *   add-source <url>  [--tier <fetchTier>] [--category <cat>] [--name <name>]
 *       Append a valid EventSource to sources.json.
 *       Defaults: tier=html-llm, pollInterval=720, enabled=true.
 *       Validates URL syntax and schema before writing.
 *
 *   list-sources
 *       Print all sources: id / tier / lastFetched / enabled.
 *
 *   refresh <sourceId>
 *       Live-ingest one source by id; update its lastFetched.
 *
 * Env overrides (tests / ad-hoc):
 *   EVENTSCOUT_SOURCES_PATH=/tmp/sources.json  — avoids touching real sources.json
 *   EVENTSCOUT_CACHE_PATH=/tmp/cache.json      — avoids touching real cache
 */

import { dirname, sep } from "path";
import { fileURLToPath } from "url";
import { ingestSource, ingestAll } from "./Tools/Ingest.ts";
import { queryHybrid, persistRefreshedEvents } from "./Tools/Query.ts";
import { loadSources, addSource, updateLastFetched } from "./Tools/SourceManager.ts";
import {
  EventSourceSchema,
  FetchTierSchema,
  CategorySchema,
  TimeOfDaySchema,
  DEFAULT_CACHE_PATH,
  DEFAULT_SAVED_PATH,
  DEFAULT_SOURCE_STATE_PATH,
} from "./Tools/types.ts";
import type { EventSource, FetchTier, Category, TimeOfDay, QueryContext } from "./Tools/types.ts";
import { readEvents } from "./Tools/Cache.ts";
import { saveEvent, unsaveEvent, readSaved } from "./Tools/SavedEvents.ts";
import { saveToIdeas, addToCalendar } from "./Tools/Actions.ts";
import {
  noteBooking,
  scanNotices,
  listEntries,
  markBooked,
  dismiss,
  DEFAULT_BOOKING_LEDGER_PATH,
} from "./Tools/BookingLedger.ts";
import { renderNoticesMarkdown, ExplicitBookingActionSchema } from "./Tools/Booking.ts";
import type { BookingAction } from "./Tools/Booking.ts";
import { startUiServer } from "./Tools/UiServer.ts";
import { loadProfile } from "./Tools/InterestProfile.ts";
import {
  buildExplicitWindow,
  buildDefaultWindow,
  parseIsoDateStrict,
  WindowValidationError,
  DEFAULT_HOME,
  DEFAULT_RADIUS_MILES,
} from "./Tools/Window.ts";
import { laDateIso } from "./Tools/lib/tz.ts";

// ============================================================================
// Helpers
// ============================================================================

function usage(): void {
  console.log(`
EventScout CLI — discover San Diego events

Usage:
  bun skills/Productivity/EventScout/cli.ts <subcommand> [options]

Subcommands:
  query "<query text>"  [--from YYYY-MM-DD --to YYYY-MM-DD] [--free]
                         [--max-price N] [--category <cat>]... [--time-of-day <bucket>]...
                         [--limit N] [--refresh]
      Cache-first query: reads from cache by default (fast, no network).
      ALL natural-language interpretation (dates, refresh intent, price mode,
      explicit-vs-inferred category) is the CALLING AGENT's job — see SKILL.md
      "How to invoke query (agents)". This CLI does zero NL guessing; it only
      validates structured flags, LOUDLY, and errors non-zero on anything malformed.
        --from/--to      Explicit YYYY-MM-DD date window (both required together).
                          Omit both → defaults to the next 14 days (banner printed).
        --free           Hard filter: only free events.
        --max-price N    Hard filter: isFree OR price <= N. Don't combine with --free.
        --category <cat> Hard filter — repeatable. Only pass when the user NAMED
                          a category directly; omit for vibe/goal queries (soft
                          ranking signal handled by the LLM ranker instead).
        --time-of-day <bucket>  Repeatable: morning | afternoon | evening | late.
      Live-refresh fires ONLY when --refresh is passed (no more NL sniffing).
      Filters, ranks, and prints top N picks (default all).

  prefetch
      Ingest all enabled sources; print per-source counts; update lastFetched.

  add-source <url>  [--tier <fetchTier>] [--category <cat>] [--name <name>]
      Append a new source to sources.json.
      Fetch tiers: api | rss | ics | shopify | spa | html-llm (default)
      Categories: music | comedy | theater | sports | arts | community |
                  festival | talk | film | other

  list-sources
      List all registered sources with id, tier, lastFetched, enabled.

  refresh <sourceId>
      Live-ingest a single source and update its lastFetched.

  ui
      Launch a local web UI (default http://localhost:4180) to browse, filter,
      and search the cached events, view details/links, and trigger refreshes.
      Override the port with EVENTSCOUT_UI_PORT. Ctrl-C to stop.

  save <eventId>
      EXPORT an event from the cache to activity_ideas in LifeOS.
      Prints confirmation + row ref (usable for undo/delete).
      (For the local "interested" shortlist, use 'saved add' instead.)

  saved [list | add <eventId> | remove <eventId>]
      Jm's local "interested" shortlist (State/saved-events.json) — the same
      list behind the UI's ★ star toggle and "Saved" filter. Entries snapshot
      the full event, so saved picks survive cache refreshes/pruning.
        saved list            Show all saved events (default subcommand).
        saved add <id>        Save an event from the cache.
        saved remove <id>     Unsave an event.

  add-to-calendar <eventId> [--action buy-tickets|reserve|rsvp|none] [--book-by YYYY-MM-DD]
      Create a Google Calendar event from a cached event.
      Prints confirmation + calendar event ref. Also records the booking
      action in the booking ledger — --action is the CALLING AGENT's
      judgment (see SKILL.md "Booking Notices"), not guessed in code.
      Omitting --action is NOT an error: the entry lands "unclassified" and
      nags in every scan/digest until re-noted with a real action.
      --book-by, if given, overrides the code's computed lead-day default.

  booking <scan|list|note|booked|dismiss> [args]
      Booking notices — the "book before the deadline" reminders.
        scan [--window N]   show booking actions due within N days (default 14);
                            marks past events expired
        list                dump the full booking ledger (all statuses)
        note <eventId> [--action buy-tickets|reserve|rsvp|none] [--book-by YYYY-MM-DD]
                            manually track a cached event; same flag contract
                            as add-to-calendar above
        booked <eventId>    mark an entry booked (stops reminders)
        dismiss <eventId>   mark an entry dismissed (stops reminders)

Options for add-source:
  --tier <tier>         Fetch tier (default: html-llm)
  --category <cat>      Category hint (optional)
  --name <name>         Display name (default: derived from URL hostname)

Env overrides (for testing):
  EVENTSCOUT_SOURCES_PATH=/tmp/sources.json
  EVENTSCOUT_CACHE_PATH=/tmp/cache.json
`);
}

/**
 * Derive a URL-based source id: lowercase hostname + first path segment,
 * spaces/slashes replaced with hyphens. e.g. "https://mysite.com/calendar" → "mysite-calendar"
 */
function deriveSourceId(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").replace(/\./g, "-");
    const firstPath = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    return firstPath ? `${host}-${firstPath}` : host;
  } catch {
    return "source-" + Date.now();
  }
}

/**
 * Derive a display name from a URL hostname.
 * e.g. "https://mysite.com/calendar" → "mysite.com"
 */
function deriveSourceName(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Parse --key value pairs from args array, returning leftover positional args */
export function parseFlags(
  args: string[]
): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      // Boolean flag: next token is absent or is itself a --flag
      if (next === undefined || next.startsWith("--")) {
        flags[key] = "true";
        i += 1;
      } else {
        flags[key] = next;
        i += 2;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }
  return { flags, positional };
}

/**
 * Scan the raw args array for every occurrence of `--flagName <value>` and
 * return the collected values, in order. Used for flags that may repeat
 * (--category, --time-of-day) — parseFlags' Record<string,string> can only
 * hold the LAST value for a repeated key, which would silently drop earlier
 * occurrences (e.g. "--category comedy --category music" → only "music").
 */
function collectRepeatableFlag(args: string[], flagName: string): string[] {
  const needle = `--${flagName}`;
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === needle && i + 1 < args.length) {
      values.push(args[i + 1]!);
    }
  }
  return values;
}

/** Thrown by buildQueryContext on any malformed/invalid query flag. */
export class QueryFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryFlagError";
  }
}

export interface BuiltQuery {
  context: QueryContext;
  refresh: boolean;
  limit: number;
  /** Set when --from/--to were omitted and the default 14-day window was used. */
  banner: string | null;
}

// ============================================================================
// Worktree live-state guard
// ============================================================================

/**
 * KAYA_HOME (types.ts) resolves to ~/.claude unless KAYA_DIR is set, so a
 * state-writing command run from an unmerged worktree writes the LIVE tree's
 * State/ files. That combination has corrupted shared state before (2026-07-03:
 * worktree booking demos wrote a not-yet-merged enum value into the live
 * ledger; every live booking command then hard-failed on Zod until merge).
 * This guard refuses it loudly instead. It only fires when a command's
 * RESOLVED write target actually lands in the live tree — test runs that
 * redirect state via EVENTSCOUT_*_PATH / KAYA_DIR are untouched.
 *
 * Escape hatches: KAYA_DIR=<worktree root> (state stays in the worktree) or
 * EVENTSCOUT_ALLOW_LIVE_STATE=1 (deliberately target live state).
 */
export function liveStateWriteTargets(subcommand: string, rest: string[]): Array<[label: string, path: string]> {
  const cachePath = process.env["EVENTSCOUT_CACHE_PATH"] ?? DEFAULT_CACHE_PATH;
  const savedPath = process.env["EVENTSCOUT_SAVED_PATH"] ?? DEFAULT_SAVED_PATH;
  const ledgerPath = process.env["EVENTSCOUT_BOOKING_LEDGER_PATH"] ?? DEFAULT_BOOKING_LEDGER_PATH;
  const sourceStatePath = process.env["EVENTSCOUT_SOURCE_STATE_PATH"] ?? DEFAULT_SOURCE_STATE_PATH;
  switch (subcommand) {
    case "prefetch":
    case "refresh":
      return [
        ["events cache", cachePath],
        ["source freshness state", sourceStatePath],
      ];
    case "query":
      return rest.includes("--refresh")
        ? [
            ["events cache", cachePath],
            ["source freshness state", sourceStatePath],
          ]
        : [];
    case "ui":
      return [
        ["events cache (UI refresh buttons)", cachePath],
        ["saved shortlist", savedPath],
      ];
    case "save":
      return [["LifeOS activity_ideas export", "external:activity_ideas"]];
    case "saved":
      return rest[0] === "add" || rest[0] === "remove" ? [["saved shortlist", savedPath]] : [];
    case "add-to-calendar":
      return [
        ["booking ledger", ledgerPath],
        ["Google Calendar", "external:gcal"],
      ];
    case "booking":
      return rest[0] === "note" || rest[0] === "booked" || rest[0] === "dismiss"
        ? [["booking ledger", ledgerPath]]
        : [];
    default:
      return [];
  }
}

function guardWorktreeLiveState(subcommand: string, rest: string[]): void {
  const worktreeMarker = `${sep}.claude${sep}worktrees${sep}`;
  const thisDir = dirname(fileURLToPath(import.meta.url));
  if (!thisDir.includes(worktreeMarker)) return;
  if (process.env["EVENTSCOUT_ALLOW_LIVE_STATE"] === "1") return;

  const liveStateRoot = `${process.env["HOME"]}/.claude/skills/Productivity/EventScout/State/`;
  const offenders = liveStateWriteTargets(subcommand, rest).filter(
    ([, p]) => p.startsWith("external:") || p.startsWith(liveStateRoot),
  );
  if (offenders.length === 0) return;

  console.error(
    `✗ Refusing: this CLI is running from a WORKTREE (${thisDir})\n` +
      `  but "${subcommand}" would write shared/live state:\n` +
      offenders.map(([label, p]) => `    - ${label}: ${p}`).join("\n") +
      `\n  Unmerged worktree code writing live state has corrupted the shared tree before.\n` +
      `  Either: KAYA_DIR=<worktree root> (keep state in the worktree),\n` +
      `  or set the EVENTSCOUT_*_PATH override for the file(s) above,\n` +
      `  or EVENTSCOUT_ALLOW_LIVE_STATE=1 to deliberately target live state.`,
  );
  process.exit(1);
}

const QUERY_USAGE =
  'Usage: eventscout query "<query text>" [--from YYYY-MM-DD --to YYYY-MM-DD] ' +
  "[--free] [--max-price N] [--category <cat>]... [--time-of-day <bucket>]... " +
  "[--refresh] [--limit N]";

/**
 * Build a validated QueryContext + refresh/limit/banner from raw CLI args.
 *
 * Pure and synchronous — no NL interpretation, no I/O. home/radiusMiles are
 * passed in (resolved from InterestProfile.json by the caller, async, before
 * this runs) rather than looked up here, so this function stays a plain,
 * fully unit-testable transform of args → QueryContext.
 *
 * Throws QueryFlagError with a helpful message on any malformed/invalid
 * input — LOUD failure, never a silent best-guess (see Window.ts doc comment
 * for the bug class this replaces).
 */
export function buildQueryContext(
  args: string[],
  now: Date = new Date(),
  home: { lat: number; lng: number } = DEFAULT_HOME,
  radiusMiles: number = DEFAULT_RADIUS_MILES
): BuiltQuery {
  const { flags, positional } = parseFlags(args);

  const rawQuery = positional.join(" ").trim();
  if (!rawQuery) {
    throw new QueryFlagError(QUERY_USAGE);
  }

  // ---- limit ----------------------------------------------------------------
  const limitRaw = flags["limit"];
  const limit = limitRaw ? parseInt(limitRaw, 10) : Infinity;
  if (!isFinite(limit) && limitRaw !== undefined) {
    throw new QueryFlagError("--limit must be a positive integer");
  }
  if (isFinite(limit) && (isNaN(limit) || limit < 1)) {
    throw new QueryFlagError("--limit must be a positive integer");
  }

  // ---- refresh: --refresh flag ONLY (no more NL "latest"/"update" sniffing) --
  const refresh = "refresh" in flags;

  // ---- free / maxPrice --------------------------------------------------------
  const free = "free" in flags ? true : undefined;
  let maxPrice: number | undefined;
  if (flags["max-price"] !== undefined) {
    const n = Number(flags["max-price"]);
    if (!Number.isFinite(n) || n < 0) {
      throw new QueryFlagError(
        `--max-price must be a non-negative number, got "${flags["max-price"]}"`
      );
    }
    maxPrice = n;
  }

  // ---- categories (repeatable) ------------------------------------------------
  const categoriesRaw = collectRepeatableFlag(args, "category");
  let categories: Category[] | undefined;
  if (categoriesRaw.length > 0) {
    categories = categoriesRaw.map((cat) => {
      const parsed = CategorySchema.safeParse(cat);
      if (!parsed.success) {
        throw new QueryFlagError(
          `Invalid --category "${cat}". Valid categories: music | comedy | theater | ` +
            "sports | arts | community | festival | talk | film | food | other"
        );
      }
      return parsed.data;
    });
  }

  // ---- time-of-day (repeatable) ------------------------------------------------
  const timeOfDayRaw = collectRepeatableFlag(args, "time-of-day");
  let timeOfDay: TimeOfDay[] | undefined;
  if (timeOfDayRaw.length > 0) {
    timeOfDay = timeOfDayRaw.map((tod) => {
      const parsed = TimeOfDaySchema.safeParse(tod);
      if (!parsed.success) {
        throw new QueryFlagError(
          `Invalid --time-of-day "${tod}". Valid buckets: morning | afternoon | evening | late`
        );
      }
      return parsed.data;
    });
  }

  // ---- window: explicit --from/--to, or default next-14-days ------------------
  const fromRaw = flags["from"];
  const toRaw = flags["to"];
  let window: { start: string; end: string };
  let banner: string | null = null;

  if (fromRaw !== undefined || toRaw !== undefined) {
    if (fromRaw === undefined || toRaw === undefined) {
      throw new QueryFlagError("--from and --to must both be given together");
    }
    try {
      window = buildExplicitWindow(fromRaw, toRaw, now);
    } catch (err) {
      if (err instanceof WindowValidationError) throw new QueryFlagError(err.message);
      throw err;
    }
  } else {
    const built = buildDefaultWindow(now);
    window = built.window;
    const todayLabel = window.start.slice(0, 10);
    banner = `ℹ️ No --from/--to given — defaulting to the next 14 days (${todayLabel} → ${built.toLabel}).`;
  }

  const context: QueryContext = {
    rawQuery,
    window,
    ...(free !== undefined ? { free } : {}),
    ...(maxPrice !== undefined ? { maxPrice } : {}),
    ...(categories !== undefined ? { categories } : {}),
    ...(timeOfDay !== undefined ? { timeOfDay } : {}),
    home,
    radiusMiles,
  };

  return { context, refresh, limit, banner };
}

// ============================================================================
// Booking flags — `add-to-calendar` / `booking note` (markdown-first
// de-determinization, Slice 2, 2026-07)
// ============================================================================

/** Thrown by parseBookingFlags on any malformed/invalid booking flag. */
export class BookingFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingFlagError";
  }
}

export interface BookingFlags {
  action: BookingAction;
  /** ISO instant (LA midnight of the given date); undefined = no override. */
  bookBy?: string;
}

/**
 * Parse the `--action`/`--book-by` flags shared by `add-to-calendar` and
 * `booking note`. Zero classification happens here or anywhere downstream —
 * the calling agent has already judged the action from SKILL.md's "Booking
 * Notices" guidance before invoking the CLI; this only validates structured
 * flags, LOUDLY (see Booking.ts's module doc comment for the full context).
 *
 * `--action` must be one of buy-tickets | reserve | rsvp | none — an invalid
 * value throws. OMITTING `--action` is NOT an error: the entry lands
 * "unclassified" and nags in every scan/digest until resolved.
 *
 * `--book-by YYYY-MM-DD`, if given, overrides Booking.ts's computed lead-day
 * default outright.
 */
export function parseBookingFlags(args: string[]): BookingFlags {
  const { flags } = parseFlags(args);

  let action: BookingAction = "unclassified";
  const rawAction = flags["action"];
  if (rawAction !== undefined) {
    const parsed = ExplicitBookingActionSchema.safeParse(rawAction);
    if (!parsed.success) {
      throw new BookingFlagError(
        `Invalid --action "${rawAction}". Valid actions: buy-tickets | reserve | rsvp | none`
      );
    }
    action = parsed.data;
  }

  let bookBy: string | undefined;
  const rawBookBy = flags["book-by"];
  if (rawBookBy !== undefined) {
    try {
      const { year, month, day } = parseIsoDateStrict(rawBookBy);
      bookBy = laDateIso(year, month, day, 0, 0, 0);
    } catch (err) {
      if (err instanceof WindowValidationError) {
        throw new BookingFlagError(`Invalid --book-by "${rawBookBy}" — ${err.message}`);
      }
      throw err;
    }
  }

  return { action, bookBy };
}

// ============================================================================
// Subcommand handlers
// ============================================================================

async function cmdQuery(args: string[]): Promise<void> {
  // Resolve home/radius from InterestProfile.json (falls back to hardcoded
  // defaults on any error — profile is optional config, not a hard dependency).
  let home = DEFAULT_HOME;
  let radiusMiles = DEFAULT_RADIUS_MILES;
  try {
    const profile = await loadProfile();
    home = { lat: profile.homeLocation.lat, lng: profile.homeLocation.lng };
    radiusMiles = profile.defaultRadiusMiles;
  } catch {
    // fall back to DEFAULT_HOME / DEFAULT_RADIUS_MILES
  }

  let built: BuiltQuery;
  try {
    built = buildQueryContext(args, new Date(), home, radiusMiles);
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    process.exit(1);
  }

  const { context, refresh, limit, banner } = built;

  if (banner) console.log(banner);
  console.log(`\nEventScout — querying: "${context.rawQuery}"\n`);

  const result = await queryHybrid(context, limit, refresh);

  if (result.refreshedSources.length > 0) {
    console.log(`\n[hybrid] Refreshed: ${result.refreshedSources.join(", ")}`);
  }
  if (result.skippedSources.length > 0) {
    console.log(`[hybrid] Capped/skipped: ${result.skippedSources.join(", ")}`);
  }

  console.log("\n=== Results ===");
  console.log(result.markdown);
  console.log(
    `\n[${result.rankedEvents.length} ranked result(s) from ${result.events.length} filtered / cache total]`
  );
}

async function cmdPrefetch(): Promise<void> {
  console.log("\nEventScout — Prefetch (all enabled sources)\n");

  // Hard wall-clock guard: even with per-source timeouts, a single unresolved fetch/promise
  // can keep the Bun event loop alive indefinitely (this prefetch once hung ~7 days, leaking
  // its claude -p children as zombies). If we blow the overall budget, force-exit. .unref()
  // so the timer itself never keeps the loop alive.
  const PREFETCH_MAX_MS = 45 * 60 * 1000;
  const guard = setTimeout(() => {
    console.error(`[prefetch] HARD TIMEOUT after ${PREFETCH_MAX_MS}ms — force exit`);
    process.exit(124); // standard timeout exit; orphan children reparent to launchd (PID 1), which reaps them
  }, PREFETCH_MAX_MS);
  guard.unref();

  try {
    const sources = loadSources();
    const enabled = sources.filter((s) => s.enabled);
    console.log(`Sources to ingest: ${enabled.length}\n`);

    // Single ingestAll call: concurrent fetch + dedup + geo-enrich + cache write.
    // Previously cmdPrefetch fetched each source twice:
    //   1. a manual for-loop over ingestSource (per source, no cache write)
    //   2. ingestAll (all sources again, with cache write)
    // Now each source is fetched exactly once. Per-source counts and lastFetched
    // updates are derived from the IngestResult returned by ingestAll.
    const result = await ingestAll(sources);

    console.log("Per-source counts:");
    for (const [id, count] of Object.entries(result.perSource)) {
      const status = result.failureReasons?.[id]
        ? `FAILED — ${result.failureReasons[id]}`
        : `${count} event(s)`;
      console.log(`  ${id}: ${status}`);
    }
    console.log(`\nMerges: ${result.merges} | Written to cache: ${result.written}`);

    // Update lastFetched for all sources that produced at least 1 event
    const successIds = Object.entries(result.perSource)
      .filter(([, count]) => count > 0)
      .map(([id]) => id);

    const ts = new Date().toISOString();
    for (const id of successIds) {
      updateLastFetched(id, ts);
    }
    console.log(`\nUpdated lastFetched for: ${successIds.join(", ") || "none"}`);
    console.log("\nDone.\n");
  } finally {
    clearTimeout(guard);
  }

  // Explicit exit: a lingering unresolved promise (e.g. a slow source whose underlying fetch
  // never settled despite our AbortControllers) must not keep the process alive after the
  // work is done. Exiting here reparents any orphan children to launchd, which reaps them.
  process.exit(0);
}

async function cmdAddSource(args: string[]): Promise<void> {
  const { flags, positional } = parseFlags(args);

  const rawUrl = positional[0];
  if (!rawUrl) {
    console.error("Usage: eventscout add-source <url> [--tier <tier>] [--category <cat>] [--name <name>]");
    process.exit(1);
  }

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("Protocol must be http or https");
    }
  } catch (err) {
    console.error(`Invalid URL "${rawUrl}": ${(err as Error).message}`);
    process.exit(1);
  }

  // Validate tier
  const tierRaw = flags["tier"] ?? "html-llm";
  const tierParsed = FetchTierSchema.safeParse(tierRaw);
  if (!tierParsed.success) {
    console.error(
      `Invalid tier "${tierRaw}". Valid tiers: api | rss | ics | shopify | spa | html-llm`
    );
    process.exit(1);
  }
  const tier = tierParsed.data as FetchTier;

  // Validate category (optional)
  let categoryHint: Category | undefined;
  if (flags["category"]) {
    const catParsed = CategorySchema.safeParse(flags["category"]);
    if (!catParsed.success) {
      console.error(
        `Invalid category "${flags["category"]}". Valid categories: music | comedy | theater | sports | arts | community | festival | talk | film | other`
      );
      process.exit(1);
    }
    categoryHint = catParsed.data as Category;
  }

  const url = parsedUrl.toString();
  const name = flags["name"] ?? deriveSourceName(url);
  const id = deriveSourceId(url);

  const source: EventSource = EventSourceSchema.parse({
    id,
    url,
    name,
    fetchTier: tier,
    ...(categoryHint !== undefined ? { categoryHint } : {}),
    pollInterval: 720,
    enabled: true,
  });

  addSource(source);
  console.log(`\nSource added:\n${JSON.stringify(source, null, 2)}\n`);
}

function cmdListSources(): void {
  const sources = loadSources();
  if (sources.length === 0) {
    console.log("No sources registered.");
    return;
  }
  console.log(`\nEventScout — ${sources.length} source(s):\n`);
  console.log(
    `${"ID".padEnd(36)} ${"TIER".padEnd(10)} ${"ENABLED".padEnd(8)} ${"LAST FETCHED"}`
  );
  console.log("-".repeat(80));
  for (const s of sources) {
    const lastFetched = s.lastFetched ? new Date(s.lastFetched).toLocaleString() : "never";
    console.log(
      `${s.id.padEnd(36)} ${s.fetchTier.padEnd(10)} ${String(s.enabled).padEnd(8)} ${lastFetched}`
    );
  }
  console.log("");
}

async function cmdRefresh(args: string[]): Promise<void> {
  const sourceId = args[0];
  if (!sourceId) {
    console.error("Usage: eventscout refresh <sourceId>");
    process.exit(1);
  }

  const sources = loadSources();
  const source = sources.find((s) => s.id === sourceId);
  if (!source) {
    console.error(`Source not found: "${sourceId}"`);
    console.error(`Available: ${sources.map((s) => s.id).join(", ")}`);
    process.exit(1);
  }

  console.log(`\nEventScout — Refreshing: ${source.id} (${source.url})\n`);
  try {
    const events = await ingestSource(source);
    // Persist like the prefetch/hybrid paths do — without this, refresh fetched
    // events but discarded them (only lastFetched changed, cache never updated).
    const persisted = await persistRefreshedEvents(events);
    const ts = new Date().toISOString();
    updateLastFetched(source.id, ts);
    console.log(
      `Done — ${events.length} event(s) fetched, ${persisted} persisted to cache; lastFetched updated to ${ts}\n`
    );
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function cmdSave(args: string[]): Promise<void> {
  const eventId = args[0];
  if (!eventId) {
    console.error("Usage: eventscout save <eventId>");
    process.exit(1);
  }

  const allEvents = readEvents();
  const event = allEvents.find((e) => e.id === eventId);
  if (!event) {
    console.error(`Event not found in cache: "${eventId}"`);
    console.error(`Run 'eventscout query ...' first to populate the cache.`);
    process.exit(1);
  }

  console.log(`\nEventScout — saving to activity_ideas: "${event.title}"\n`);
  const result = await saveToIdeas(event);

  if (!result.ok) {
    console.error(`ERROR: ${result.error ?? "unknown error"}`);
    process.exit(1);
  }

  console.log(`Done — saved to activity_ideas (row ref: ${result.ref})`);
  console.log(`  title: ${event.title}`);
  console.log(`  venue: ${event.venue ?? "—"}`);
  console.log(`  date:  ${event.startDatetime}`);
  console.log(`\nRef "${result.ref}" can be used to delete this row if needed.\n`);
}

function cmdSaved(args: string[]): void {
  const sub = args[0] ?? "list";

  switch (sub) {
    case "list": {
      const saved = readSaved();
      if (saved.length === 0) {
        console.log("\nNo saved events. Save one with: eventscout saved add <eventId>\n");
        return;
      }
      const cachedIds = new Set(readEvents().map((e) => e.id));
      console.log(`\nEventScout — ${saved.length} saved event(s)\n`);
      for (const { savedAt, event } of saved) {
        const gone = cachedIds.has(event.id) ? "" : "  [no longer in cache]";
        console.log(
          `- ${event.startDatetime.slice(0, 10)} · ${event.title}` +
            `${event.venue ? ` · ${event.venue}` : ""}${gone}`
        );
        console.log(`    id: ${event.id}  (saved ${savedAt.slice(0, 10)})`);
      }
      console.log("");
      return;
    }
    case "add": {
      const eventId = args[1];
      if (!eventId) {
        console.error("Usage: eventscout saved add <eventId>");
        process.exit(1);
      }
      const event = readEvents().find((e) => e.id === eventId);
      if (!event) {
        console.error(`Event not found in cache: "${eventId}"`);
        console.error(`Run 'eventscout query ...' first to populate the cache.`);
        process.exit(1);
      }
      const { added } = saveEvent(event);
      console.log(
        added
          ? `Saved ★ "${event.title}" (${event.startDatetime.slice(0, 10)}${event.venue ? `, ${event.venue}` : ""})`
          : `Already saved — snapshot refreshed: "${event.title}"`
      );
      return;
    }
    case "remove": {
      const eventId = args[1];
      if (!eventId) {
        console.error("Usage: eventscout saved remove <eventId>");
        process.exit(1);
      }
      const { removed } = unsaveEvent(eventId);
      if (!removed) {
        console.error(`Not in the saved list: "${eventId}"`);
        process.exit(1);
      }
      console.log(`Removed from saved: ${eventId}`);
      return;
    }
    default: {
      console.error(`Unknown saved subcommand: "${sub}"`);
      console.error("Usage: eventscout saved [list | add <eventId> | remove <eventId>]");
      process.exit(1);
    }
  }
}

async function cmdAddToCalendar(args: string[]): Promise<void> {
  const { positional } = parseFlags(args);
  const eventId = positional[0];
  if (!eventId) {
    console.error("Usage: eventscout add-to-calendar <eventId> [--action buy-tickets|reserve|rsvp|none] [--book-by YYYY-MM-DD]");
    process.exit(1);
  }

  let booking: BookingFlags;
  try {
    booking = parseBookingFlags(args);
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    process.exit(1);
  }

  const allEvents = readEvents();
  const event = allEvents.find((e) => e.id === eventId);
  if (!event) {
    console.error(`Event not found in cache: "${eventId}"`);
    console.error(`Run 'eventscout query ...' first to populate the cache.`);
    process.exit(1);
  }

  console.log(`\nEventScout — adding to calendar: "${event.title}"\n`);
  const result = await addToCalendar(event, booking.action, booking.bookBy);

  if (!result.ok) {
    console.error(`ERROR: ${result.error ?? "unknown error"}`);
    process.exit(1);
  }

  console.log(`Done — calendar event created (ref: ${result.ref})`);
  console.log(`  title: ${event.title}`);
  console.log(`  date:  ${event.startDatetime}`);
  console.log(`  venue: ${event.venue ?? "—"}`);
  if (result.booking?.noted) {
    const entry = result.booking.entry!;
    const label = entry.action === "unclassified" ? "⚠️ unclassified (needs review)" : entry.action;
    console.log(`  booking: ${label}${entry.bookBy ? `, book by ${entry.bookBy.slice(0, 10)}` : ""}`);
  } else if (result.booking && !result.booking.noted) {
    console.log(`  booking: not noted (${result.booking.reason})`);
  }
  console.log(`\nRef "${result.ref}" can be used to delete this event if needed.\n`);
}

async function cmdBooking(args: string[]): Promise<void> {
  const sub = args[0] ?? "scan";

  switch (sub) {
    case "scan": {
      // Optional --window N (days); default 14.
      const wi = args.indexOf("--window");
      const windowDays =
        wi >= 0 && args[wi + 1] ? parseInt(args[wi + 1]!, 10) || 14 : 14;
      const { notices, expired } = scanNotices(new Date(), windowDays);
      console.log(renderNoticesMarkdown(notices, new Date()));
      if (expired.length > 0) {
        console.log(`\n(${expired.length} past event(s) marked expired.)`);
      }
      break;
    }

    case "list": {
      const entries = listEntries();
      if (entries.length === 0) {
        console.log("Booking ledger is empty.");
        break;
      }
      console.log(`\nBooking ledger — ${entries.length} entr(ies):\n`);
      for (const e of entries) {
        console.log(
          `  [${e.status}] ${e.action} — ${e.title}\n` +
            `    when: ${e.startDatetime}  bookBy: ${e.bookBy ?? "—"}\n` +
            `    id:   ${e.eventId}`
        );
      }
      break;
    }

    case "note": {
      const noteArgs = args.slice(1);
      const { positional } = parseFlags(noteArgs);
      const eventId = positional[0];
      if (!eventId) {
        console.error("Usage: eventscout booking note <eventId> [--action buy-tickets|reserve|rsvp|none] [--book-by YYYY-MM-DD]");
        process.exit(1);
      }

      let booking: BookingFlags;
      try {
        booking = parseBookingFlags(noteArgs);
      } catch (err) {
        console.error(`ERROR: ${(err as Error).message}`);
        process.exit(1);
      }

      const event = readEvents().find((e) => e.id === eventId);
      if (!event) {
        console.error(`Event not found in cache: "${eventId}"`);
        process.exit(1);
      }
      const res = noteBooking(event, new Date(), booking.action, booking.bookBy);
      if (!res.noted) {
        console.log(`Not noted: ${res.reason}`);
      } else {
        const label = res.entry!.action === "unclassified" ? "⚠️ unclassified (needs review)" : res.entry!.action;
        console.log(
          `Noted "${event.title}" — action: ${label}, bookBy: ${res.entry!.bookBy ?? "—"}`
        );
      }
      break;
    }

    case "booked":
    case "dismiss": {
      const eventId = args[1];
      if (!eventId) {
        console.error(`Usage: eventscout booking ${sub} <eventId>`);
        process.exit(1);
      }
      const ok = sub === "booked" ? markBooked(eventId) : dismiss(eventId);
      console.log(
        ok
          ? `Marked "${eventId}" as ${sub === "booked" ? "booked" : "dismissed"}.`
          : `No ledger entry for "${eventId}".`
      );
      break;
    }

    default:
      console.error(`Unknown booking subcommand: "${sub}"`);
      console.error("  scan [--window N] | list | note <id> | booked <id> | dismiss <id>");
      process.exit(1);
  }
}

// ============================================================================
// Main dispatch
// ============================================================================

if (import.meta.main) {
  const [subcommand, ...rest] = process.argv.slice(2);

  if (!subcommand) {
    usage();
    process.exit(1);
  }

  guardWorktreeLiveState(subcommand, rest);

  switch (subcommand) {
    case "query":
      await cmdQuery(rest);
      break;

    case "prefetch":
      await cmdPrefetch();
      break;

    case "add-source":
      await cmdAddSource(rest);
      break;

    case "list-sources":
      cmdListSources();
      break;

    case "refresh":
      await cmdRefresh(rest);
      break;

    case "ui":
      startUiServer();
      break;

    case "save":
      await cmdSave(rest);
      break;

    case "saved":
      cmdSaved(rest);
      break;

    case "add-to-calendar":
      await cmdAddToCalendar(rest);
      break;

    case "booking":
      await cmdBooking(rest);
      break;

    case "--help":
    case "-h":
    case "help":
      usage();
      break;

    default:
      console.error(`Unknown subcommand: "${subcommand}"\n`);
      usage();
      process.exit(1);
  }
}
