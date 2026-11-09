/**
 * FollowUp.ts — the follow-up question in Jm's next Kaya session (G3 slice 2,
 * 2026-11-08, eventscout-loop-4; Kaya's plan in ~/.kaya/handoffs/eventscout-ALIGNMENT.md;
 * wrap-up item 2 of FEEDBACK F-003).
 *
 * The approved end state: after an outing, "it asks one question: How was it?
 * Anyone you want to see again? The answer goes into activity_log." There is no
 * push channel (Jm turned pushes off 2026-10-26), so the question rides in the
 * hold itself (G3 slice 1) and, from here, in Jm's first interactive Kaya
 * session after the hold's end: hooks/LoadContext.hook.ts prints the block this
 * module builds. Each hold is asked once; a hold Jm deleted (ledger "dropped")
 * is never asked.
 *
 * Kept light on purpose (it runs at every interactive session start): no Zod,
 * no network, no LLM; only the ledger JSON and a small "asked" file.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HoldEntry } from "./WeekendHolds.ts";

/** Ask while the outing is fresh (Kaya's heuristic): up to 4 days after the hold ends. */
export const FOLLOW_UP_WINDOW_MS = 4 * 86_400_000;

/** At most this many holds in one question. */
const MAX_IN_ONE_QUESTION = 3;

export interface AskedFile {
  /** calendarEventId → ISO time the question was shown. */
  asked: Record<string, string>;
}

export interface FollowUpPaths {
  ledger: string;
  asked: string;
}

/** The live State paths under a Kaya dir (the hook passes its own KAYA_DIR). */
export function followUpPaths(kayaDir: string): FollowUpPaths {
  const state = join(kayaDir, "skills", "Productivity", "EventScout", "State");
  return { ledger: join(state, "holds-ledger.json"), asked: join(state, "followups-asked.json") };
}

/** Holds to ask about now (pure): ended within the window, not dropped, not yet asked. */
export function dueFollowUps(entries: readonly HoldEntry[], asked: Readonly<Record<string, string>>, now: Date): HoldEntry[] {
  const nowMs = now.getTime();
  return entries
    .filter((e) => {
      if (e.status === "dropped" || asked[e.calendarEventId] !== undefined) return false;
      const endMs = Date.parse(e.end);
      return Number.isFinite(endMs) && endMs <= nowMs && nowMs - endMs <= FOLLOW_UP_WINDOW_MS;
    })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(0, MAX_IN_ONE_QUESTION);
}

const LA_WHEN = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const LA_DATE = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" });

/** The context block for the session (instructions to Kaya, plus the question to ask Jm). */
export function renderFollowUp(due: readonly HoldEntry[]): string {
  const holds = due.map((e) => `“${e.title}” on ${LA_WHEN.format(Date.parse(e.start))}`);
  const first = due[0];
  const example = first ? `"${first.title} on ${LA_DATE.format(Date.parse(first.start))}, 8/10, met two people I'd see again"` : "";
  return [
    "",
    "📍 EVENTSCOUT FOLLOW-UP (ask Jm once in this session, in one short line, at a natural point; do not repeat it):",
    `   "You had an EventScout hold: ${holds.join("; ")}. If you went: how was it, and anyone you want to see again?"`,
    `   His answer is a capture: route it through the LifeOS Router (skills/Productivity/LifeOS/Capture/Router.ts) so it lands in activity_log. Keep the event's date in the sentence, e.g. ${example}.`,
    "   If he did not go, or does not want to answer, log nothing.",
    "",
  ].join("\n");
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  const raw = readFileSync(path, "utf8").trim();
  return raw === "" ? fallback : (JSON.parse(raw) as T);
}

/**
 * The block to print at session start, or null when no hold is due. Records the
 * holds it returns as asked (atomic write), so each hold is asked once.
 */
export function followUpContext(now: Date, paths: FollowUpPaths): string | null {
  const ledger = readJson<{ entries?: HoldEntry[] }>(paths.ledger, {});
  const askedFile = readJson<AskedFile>(paths.asked, { asked: {} });
  const asked = askedFile.asked ?? {};
  const due = dueFollowUps(ledger.entries ?? [], asked, now);
  if (due.length === 0) return null;
  for (const e of due) asked[e.calendarEventId] = now.toISOString();
  mkdirSync(dirname(paths.asked), { recursive: true });
  const tmp = `${paths.asked}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ asked }, null, 2)}\n`);
  renameSync(tmp, paths.asked);
  return renderFollowUp(due);
}
