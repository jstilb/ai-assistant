#!/usr/bin/env bun
/**
 * CalendarBlock.ts - Calendar events via kaya-cli gcal
 *
 * Uses CLI directly (NOT context files) to get fresh calendar data.
 */

import { agenda } from "../../../../lib/core/GcalCli.ts";
import type { BlockResult } from "./types.ts";

export type { BlockResult };

// Strip ANSI escape codes from string
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1B\][^\x07]*\x07/g, "");
}

interface CalendarEvent {
  time: string;
  title: string;
  duration?: string;
  location?: string;
}

export interface ParsedAgenda {
  events: CalendarEvent[];
  /** True count of events parsed BEFORE the 25-event prompt-size cap — so a
   *  capped `events` array is always paired with how many actually exist. */
  totalParsed: number;
  markdown: string;
  summary: string;
  /** True when gcalcli returned non-empty, non-JSON-array output that parsed
   *  to zero events and did NOT match the known empty-day sentinel (see
   *  isEmptyDaySentinel) — i.e. gcalcli's output format may genuinely have
   *  changed. Kept as data rather than a console.warn side effect inside this
   *  function so the parsing logic stays pure and independently testable;
   *  execute() below is what actually logs it. */
  formatWarning: boolean;
}

/**
 * gcalcli prints "No Events Found..." on a legitimately-empty agenda range —
 * wrapped in ANSI color codes EVEN when --nocolor is passed to the `agenda`
 * subcommand (verified empirically 2026-07-07: `bin/kaya-cli gcal --calendar
 * ... agenda 2027-03-01 2027-03-02 --nocolor` against a guaranteed-empty
 * future date range returned stdout `\x1B[0;33m\nNo Events Found...\n\x1B[0m`,
 * stderr empty). Pre-fix, this non-empty-but-zero-events output was
 * indistinguishable from a genuine gcalcli format change, so every
 * empty-calendar day fired a bogus "format may have changed" warning both to
 * the console and into the delivered briefing markdown. Case-insensitive
 * substring match (post ANSI-strip) so trailing punctuation / color-code
 * variations across gcalcli versions don't matter.
 */
function isEmptyDaySentinel(raw: string): boolean {
  return /no events found/i.test(stripAnsi(raw));
}

/**
 * Pure — parses gcalcli agenda stdout (JSON array, plaintext "TIME - TITLE"
 * lines, or the "No Events Found..." empty-day sentinel) into events +
 * delivery markdown + summary. Extracted from execute() so H1's empty-day
 * fix is unit-testable against real captured gcalcli output without spawning
 * gcalcli or mocking GcalCli.ts.
 */
export function parseAgendaOutput(stdout: string): ParsedAgenda {
  const events: CalendarEvent[] = [];

  // Try to parse as JSON first
  if (stdout.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(stdout.trim());
      for (const event of parsed) {
        // Handle various formats from gcal
        const start = event.start?.dateTime || event.start?.date || event.time || "";
        const time = start.includes("T")
          ? new Date(start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
          : start;

        events.push({
          time,
          title: event.summary || event.title || "Untitled",
          duration: event.duration || "",
          location: event.location,
        });
      }
    } catch {
      // Not valid JSON, parse as text
    }
  }

  // Parse text output if JSON parsing failed or returned empty
  if (events.length === 0 && stdout.trim() && stdout.trim() !== "[]") {
    // Strip ANSI codes first
    const cleanOutput = stripAnsi(stdout);
    const lines = cleanOutput.trim().split("\n");

    for (const line of lines) {
      // Clean the line and skip empty/headers
      const cleanLine = line.trim();
      if (!cleanLine || cleanLine.startsWith("#") || cleanLine.startsWith("=")) continue;

      // Try to parse "TIME - TITLE" or "TIME: TITLE" format
      // Look for time patterns like "7:15", "9:00 AM", etc.
      const timeMatch = cleanLine.match(/(\d{1,2}:\d{2}(?:\s*(?:AM|PM))?)/i);
      if (timeMatch) {
        const timeStr = timeMatch[1].trim();
        // Get the title - everything after the time
        const afterTime = cleanLine.slice(cleanLine.indexOf(timeStr) + timeStr.length);
        const title = afterTime.replace(/^[\s\-:]+/, "").trim();

        if (title && !title.match(/^\d/)) {
          // Avoid duplicating if title looks like a time
          events.push({
            time: timeStr,
            title: title,
          });
        }
      } else {
        // No H:MM anywhere — all-day event. gcalcli puts the day's first
        // event on the date line itself ("Mon Aug 17         New York"), and
        // all-day events have no time column, so an H:MM-only parser drops
        // them entirely: an all-day-only agenda parsed to zero events, which
        // both delivered a false "Calendar clear" and fired the bogus
        // format-change warning below (observed 2026-08-17). Multi-day
        // all-day events are listed under their START date ("Tue Aug 11
        // Charleston" on an Aug 17 query) — passed through like everything
        // else; the editorial LLM decides relevance.
        const allDayMatch = cleanLine.match(
          /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(\S.*)$/
        );
        if (allDayMatch) {
          events.push({ time: "all-day", title: allDayMatch[1].trim() });
        }
      }
    }
  }

  // Validate: if output was non-empty but nothing parsed AND it's not the
  // known empty-day sentinel, warn and include raw fallback.
  const rawTrimmed = stdout.trim();
  const emptyDay = isEmptyDaySentinel(stdout);
  const formatWarning = events.length === 0 && Boolean(rawTrimmed) && rawTrimmed !== "[]" && !emptyDay;

  // Pass ALL events through — the editorial LLM decides which are routine vs key
  // and where the free windows are. (A ~30-keyword isKeyEvent filter + a free-window
  // heuristic used to drop/derive this in code before the LLM ever saw the events.)
  // Bounded to cap prompt size on heavy days.
  const todayEvents = events.slice(0, 25);

  // No markdown rendering — the live path (DataGatherer) reads only .data.
  const markdown = "";

  // Generate summary
  const summary = todayEvents.length > 0
    ? `${todayEvents.length} events today`
    : "Calendar clear";

  return { events: todayEvents, totalParsed: events.length, markdown, summary, formatWarning };
}

export async function execute(
  deps: { agendaFn?: typeof agenda } = {}
): Promise<BlockResult> {
  try {
    const VALID_CALENDARS = [
      "[user]@gmail.com",
      "[user-email]",
    ];

    // No inner catch here: a gcalcli failure must propagate to the outer catch
    // and return success:false + error, NOT be swallowed into stdout="[]" —
    // that rendered every calendar OUTAGE as "Calendar clear" (a lie) from
    // the block all the way through the delivered briefing.
    const agendaFn = deps.agendaFn ?? agenda;
    const stdout = agendaFn("today", "tomorrow", { calendars: VALID_CALENDARS, timeoutMs: 10000 });

    const { events: todayEvents, totalParsed, markdown, summary, formatWarning } = parseAgendaOutput(stdout);

    if (formatWarning) {
      console.warn(`[CalendarBlock] gcalcli output format may have changed — 0 events parsed from non-empty output`);
    }

    return {
      blockName: "calendar",
      success: true,
      data: { events: todayEvents, eventCount: todayEvents.length, totalParsed },
      markdown,
      summary,
    };
  } catch (error) {
    return {
      blockName: "calendar",
      success: false,
      data: { events: [], eventCount: 0 },
      markdown: "## Calendar\n\nFailed to load calendar.\n",
      summary: "Calendar unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--test") || args.includes("-t")) {
    execute()
      .then((result) => {
        console.log("=== Calendar Block Test ===\n");
        console.log("Success:", result.success);
        console.log("\nMarkdown:\n", result.markdown);
        console.log("\nSummary:", result.summary);
        if (result.error) console.log("\nError:", result.error);
      })
      .catch(console.error);
  } else {
    console.log("Usage: bun CalendarBlock.ts --test");
  }
}
