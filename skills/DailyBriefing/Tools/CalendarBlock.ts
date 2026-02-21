#!/usr/bin/env bun
/**
 * CalendarBlock.ts - Calendar events via kaya-cli gcal
 *
 * Uses CLI directly (NOT context files) to get fresh calendar data.
 */

import { execSync } from "child_process";
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

// Keywords for routine time blocks that should be filtered out
const ROUTINE_KEYWORDS = [
  'morning routine', 'evening routine', 'walk', 'lunch', 'dinner',
  'decompress', 'prep', 'workout', 'rehab', 'laundry', 'sheets',
  'project time', 'work session', 'personal tasks', 'salsa practice',
  'breakfast', 'wake up', 'wind down', 'sleep', 'bed', 'nap',
  'shower', 'get ready', 'commute', 'drive home', 'errands'
];

// Keywords indicating key meetings/events to always include
const KEY_EVENT_KEYWORDS = [
  'sync', 'meeting', 'call', '1:1', 'standup', 'review', 'interview',
  'presentation', 'demo', 'client', 'team', 'all hands', 'retro',
  'planning', 'sprint', 'kickoff', 'onboarding', 'training', 'workshop'
];

function isKeyEvent(event: CalendarEvent): boolean {
  const title = event.title.toLowerCase();

  // Skip routine time blocks
  if (ROUTINE_KEYWORDS.some(kw => title.includes(kw))) return false;

  // Include events with locations (external meetings)
  if (event.location) return true;

  // Include anything with meeting-related words
  if (KEY_EVENT_KEYWORDS.some(kw => title.includes(kw))) return true;

  // Include if title doesn't look like a generic time block
  // Generic blocks often start with verbs or are very short
  const genericPatterns = /^(do|work|time|block|focus|deep work|heads down)/i;
  if (genericPatterns.test(title)) return false;

  // Default: include if it has a specific time (most calendar events)
  return true;
}

export interface CalendarBlockConfig {
  showFreeWindows?: boolean;
}

export async function execute(config: CalendarBlockConfig = {}): Promise<BlockResult> {
  const { showFreeWindows = true } = config;

  try {
    // Use kaya-cli gcal directly
    let stdout = "";
    try {
      stdout = execSync('kaya-cli gcal agenda 2>/dev/null || kaya-cli calendar list --days 1 2>/dev/null || echo "[]"', {
        encoding: "utf-8",
        timeout: 10000,
      });
    } catch {
      // CLI not available or failed
      stdout = "[]";
    }

    const events: CalendarEvent[] = [];
    const today = new Date().toISOString().split("T")[0];

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
        }
      }
    }

    // Filter to key events only (skip routine time blocks)
    const todayEvents = events.filter(isKeyEvent);

    // Calculate free windows (simple heuristic)
    const freeWindows: string[] = [];
    if (showFreeWindows && todayEvents.length > 0) {
      // Check if morning is free (before 9am)
      const firstEventTime = todayEvents[0]?.time || "";
      if (firstEventTime.includes("10") || firstEventTime.includes("11") || parseInt(firstEventTime) > 9) {
        freeWindows.push("Early morning (before 9am)");
      }

      // Check gaps between events
      // ... (simplified for now)
    } else if (showFreeWindows && todayEvents.length === 0) {
      freeWindows.push("Calendar is open today");
    }

    // Format markdown
    let markdown = "## Calendar\n\n";

    if (todayEvents.length > 0) {
      markdown += `${todayEvents.length} key event${todayEvents.length > 1 ? "s" : ""} today:\n`;
      for (const event of todayEvents.slice(0, 8)) {
        const duration = event.duration ? ` (${event.duration})` : "";
        const location = event.location ? ` @ ${event.location}` : "";
        markdown += `- ${event.time} - ${event.title}${duration}${location}\n`;
      }
      if (todayEvents.length > 8) {
        markdown += `- ...and ${todayEvents.length - 8} more\n`;
      }
    } else {
      markdown += "No events scheduled for today.\n";
    }

    if (freeWindows.length > 0) {
      markdown += `\n**Free windows:** ${freeWindows.join(", ")}\n`;
    }

    // Generate summary
    const summary = todayEvents.length > 0
      ? `${todayEvents.length} events today`
      : "Calendar clear";

    return {
      blockName: "calendar",
      success: true,
      data: { events: todayEvents, freeWindows, eventCount: todayEvents.length },
      markdown,
      summary,
    };
  } catch (error) {
    return {
      blockName: "calendar",
      success: false,
      data: { events: [], freeWindows: [], eventCount: 0 },
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
    execute({ showFreeWindows: true })
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
