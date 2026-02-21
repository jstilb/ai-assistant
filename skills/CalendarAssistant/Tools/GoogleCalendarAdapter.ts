#!/usr/bin/env bun
/**
 * GoogleCalendarAdapter.ts - CRUD via kaya-cli Calendar Commands
 *
 * Wraps `kaya-cli calendar` CLI commands for calendar CRUD operations.
 * Uses Bun.spawn for CLI execution with proper error handling.
 * Caches calendar state with 5-minute TTL.
 *
 * @module GoogleCalendarAdapter
 */

import type {
  CalendarEvent,
  NewEvent,
  EventUpdate,
  Result,
  CalendarError,
} from "./types";

// ============================================
// CACHE
// ============================================

interface CacheEntry {
  data: CalendarEvent[];
  timestamp: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let agendaCache: CacheEntry | null = null;

/**
 * Check if cache is still valid.
 */
function isCacheValid(): boolean {
  if (!agendaCache) return false;
  return Date.now() - agendaCache.timestamp < CACHE_TTL_MS;
}

/**
 * Invalidate the agenda cache (call after writes).
 */
export function invalidateCache(): void {
  agendaCache = null;
}

// ============================================
// CLI EXECUTION
// ============================================

/**
 * Execute a kaya-cli calendar command and return stdout.
 */
async function execCalendarCommand(
  args: string[]
): Promise<Result<string, CalendarError>> {
  try {
    const proc = Bun.spawn(["kaya-cli", "gcal", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      // Check for specific error types
      if (stderr.includes("auth") || stderr.includes("token")) {
        return {
          success: false,
          error: {
            code: "AUTH_EXPIRED",
            message: `Calendar authentication issue: ${stderr.slice(0, 200)}`,
            retryable: true,
            retryAfterMs: 5000,
          },
        };
      }

      if (stderr.includes("rate") || stderr.includes("quota")) {
        return {
          success: false,
          error: {
            code: "RATE_LIMITED",
            message: `Calendar API rate limited: ${stderr.slice(0, 200)}`,
            retryable: true,
            retryAfterMs: 10000,
          },
        };
      }

      return {
        success: false,
        error: {
          code: "API_UNAVAILABLE",
          message: `Calendar command failed (exit ${exitCode}): ${stderr.slice(0, 200) || stdout.slice(0, 200)}`,
          retryable: true,
          retryAfterMs: 3000,
        },
      };
    }

    return { success: true, data: stdout };
  } catch (err) {
    return {
      success: false,
      error: {
        code: "API_UNAVAILABLE",
        message: `Failed to execute calendar command: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
        retryAfterMs: 5000,
      },
    };
  }
}

// ============================================
// PARSING
// ============================================

/**
 * Parse TSV agenda output into CalendarEvent objects.
 */
function parseAgendaOutput(output: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  const lines = output.trim().split("\n").filter((l) => l.trim());

  for (const line of lines) {
    try {
      // gcalcli agenda --tsv outputs: date\ttime\tevent_title
      // gcalcli agenda --nocolor outputs structured text
      const parts = line.split("\t");

      if (parts.length >= 3) {
        // TSV format
        const dateStr = parts[0]?.trim();
        const timeStr = parts[1]?.trim();
        const title = parts.slice(2).join(" ").trim();

        if (dateStr && title) {
          const startStr = timeStr
            ? `${dateStr} ${timeStr}`
            : dateStr;

          events.push({
            id: generateEventId(title, startStr),
            title,
            start: startStr,
            end: "", // Will be computed or fetched separately
            isAllDay: !timeStr,
            isRecurring: false,
          });
        }
      } else {
        // Plain text format - try to extract event info
        const match = line.match(
          /(\d{4}-\d{2}-\d{2})?\s*(\d{1,2}:\d{2}(?:\s*[APap][Mm])?)?.*?(?:\s{2,}|\t)(.+)/
        );
        if (match) {
          const [, dateStr, timeStr, title] = match;
          if (title && title.trim()) {
            events.push({
              id: generateEventId(title.trim(), dateStr || ""),
              title: title.trim(),
              start: dateStr
                ? timeStr
                  ? `${dateStr} ${timeStr}`
                  : dateStr
                : "",
              end: "",
              isAllDay: !timeStr,
              isRecurring: false,
            });
          }
        }
      }
    } catch {
      // Skip unparseable lines
    }
  }

  return events;
}

/**
 * Generate a deterministic event ID from title and time.
 */
function generateEventId(title: string, time: string): string {
  const input = `${title}:${time}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return `evt_${Math.abs(hash).toString(36)}`;
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Get calendar agenda for a time period.
 * Uses cache if available and fresh.
 *
 * @param startDate - Start date (default: today)
 * @param endDate - End date (default: 7 days from now)
 * @returns Array of calendar events
 */
export async function getAgenda(
  startDate?: string,
  endDate?: string
): Promise<Result<CalendarEvent[], CalendarError>> {
  // Check cache for default queries
  if (!startDate && !endDate && isCacheValid()) {
    return { success: true, data: agendaCache!.data };
  }

  const args = ["agenda", "--nocolor", "--tsv"];
  if (startDate) args.push(startDate);
  if (endDate) args.push(endDate);

  const result = await execCalendarCommand(args);
  if (!result.success) return result;

  const events = parseAgendaOutput(result.data);

  // Update cache for default queries
  if (!startDate && !endDate) {
    agendaCache = { data: events, timestamp: Date.now() };
  }

  return { success: true, data: events };
}

/**
 * Search for events matching a query.
 *
 * @param query - Search term
 * @param startDate - Optional start date
 * @param endDate - Optional end date
 * @returns Matching events
 */
export async function searchEvents(
  query: string,
  startDate?: string,
  endDate?: string
): Promise<Result<CalendarEvent[], CalendarError>> {
  const args = ["search", query, "--nocolor", "--tsv"];
  if (startDate) args.push(startDate);
  if (endDate) args.push(endDate);

  const result = await execCalendarCommand(args);
  if (!result.success) return result;

  return { success: true, data: parseAgendaOutput(result.data) };
}

/**
 * Create a new calendar event.
 *
 * @param event - Event details
 * @returns Result indicating success or failure
 */
export async function createEvent(
  event: NewEvent
): Promise<Result<{ created: true; title: string }, CalendarError>> {
  const args: string[] = [];

  if (event.attendees && event.attendees.length === 0 && !event.location) {
    // Use quick-add for simple events
    const quickStr = `${event.title} ${event.start}`;
    args.push("quick", quickStr);
  } else {
    // Use detailed add
    args.push("add");
    args.push("--title", event.title);
    args.push("--when", event.start);

    if (event.end) {
      args.push("--end", event.end);
    }

    if (event.location) {
      args.push("--where", event.location);
    }

    if (event.description) {
      args.push("--description", event.description);
    }

    if (event.attendees) {
      for (const attendee of event.attendees) {
        args.push("--who", attendee);
      }
    }

    if (event.isAllDay) {
      args.push("--allday");
    }

    args.push("--noprompt");
  }

  const result = await execCalendarCommand(args);
  if (!result.success) return result;

  // Invalidate cache after write
  invalidateCache();

  return { success: true, data: { created: true, title: event.title } };
}

/**
 * Delete a calendar event.
 * SAFETY: This should only be called after user confirmation
 * has been validated by SafetyGuardrails.
 *
 * @param eventTitle - Title of event to delete
 * @returns Result indicating success or failure
 */
export async function deleteEvent(
  eventTitle: string
): Promise<Result<{ deleted: true; title: string }, CalendarError>> {
  const result = await execCalendarCommand(["delete", eventTitle]);
  if (!result.success) return result;

  invalidateCache();
  return { success: true, data: { deleted: true, title: eventTitle } };
}

/**
 * Get events for today.
 */
export async function getTodayEvents(): Promise<
  Result<CalendarEvent[], CalendarError>
> {
  return getAgenda("today", "tomorrow");
}

/**
 * Get events for this week.
 */
export async function getWeekEvents(): Promise<
  Result<CalendarEvent[], CalendarError>
> {
  return getAgenda("today", "7 days from now");
}

/**
 * Check if a time slot is free.
 *
 * @param start - Start time ISO string
 * @param end - End time ISO string
 * @returns Whether the slot is free
 */
export async function isSlotFree(
  start: string,
  end: string
): Promise<Result<boolean, CalendarError>> {
  const agendaResult = await getAgenda(start, end);
  if (!agendaResult.success) return agendaResult;

  // If no events in the range, slot is free
  return { success: true, data: agendaResult.data.length === 0 };
}

// CLI interface
if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "agenda") {
    const result = await getAgenda(args[1], args[2]);
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "today") {
    const result = await getTodayEvents();
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "week") {
    const result = await getWeekEvents();
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "search") {
    const result = await searchEvents(args[1] || "");
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "free") {
    const result = await isSlotFree(args[1] || "", args[2] || "");
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`GoogleCalendarAdapter - Calendar CRUD via kaya-cli

Usage:
  bun run GoogleCalendarAdapter.ts agenda [start] [end]
  bun run GoogleCalendarAdapter.ts today
  bun run GoogleCalendarAdapter.ts week
  bun run GoogleCalendarAdapter.ts search "query"
  bun run GoogleCalendarAdapter.ts free "start" "end"
`);
  }
}
