/**
 * CalendarApi.ts — the Google Calendar REST calls that EventScout holds need.
 *
 * Why not lib/core/GcalCli.ts: `gcalcli add` cannot set an event's status
 * ("tentative"), transparency ("free"), reminders (none) or a private
 * extended property (the tag that finds a hold again by id, never by title).
 * This module calls the Calendar REST API directly. The token comes from
 * gcalcli's own stored login (Tools/gcal_token.py), so Kaya keeps one Google
 * login, not two.
 *
 * Every write is recorded in the shared calendar write log
 * (lib/core/CalendarWriteLog.ts).
 */

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logCalendarWrite } from "../../../../lib/core/CalendarWriteLog.ts";

const API = "https://www.googleapis.com/calendar/v3";
const TOKEN_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "gcal_token.py");
const LOG_CALLER = "EventScout/CalendarApi";

// ============================================================================
// Types
// ============================================================================

export interface CalendarTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start: CalendarTime;
  end: CalendarTime;
  transparency?: string;
  colorId?: string;
  htmlLink?: string;
  reminders?: { useDefault: boolean; overrides?: Array<{ method: string; minutes: number }> };
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
  source?: { title: string; url: string };
}

export type NewCalendarEvent = Omit<CalendarEvent, "id" | "htmlLink">;

/** The calls WeekendHolds needs; tests pass a fake. */
export interface CalendarClient {
  listEvents(q: { timeMin: string; timeMax: string; privateExtendedProperty?: string }): Promise<CalendarEvent[]>;
  insertEvent(event: NewCalendarEvent): Promise<CalendarEvent>;
  /** null when the event no longer exists (deleted). */
  getEvent(id: string): Promise<CalendarEvent | null>;
}

// ============================================================================
// Token
// ============================================================================

/** gcalcli's interpreter (it has google-auth). Override: EVENTSCOUT_GCALCLI_PYTHON. */
function gcalcliPython(): string {
  const override = process.env["EVENTSCOUT_GCALCLI_PYTHON"];
  if (override) return override;
  const which = spawnSync("/bin/sh", ["-c", "command -v gcalcli"], { encoding: "utf8" });
  const bin = which.stdout.trim();
  if (which.status !== 0 || !bin) throw new Error("CalendarApi: gcalcli is not on PATH");
  const shebang = readFileSync(realpathSync(bin), "utf8").split("\n")[0] ?? "";
  if (!shebang.startsWith("#!")) throw new Error(`CalendarApi: cannot read gcalcli's interpreter from ${bin}`);
  return shebang.slice(2).trim();
}

export function getAccessToken(): string {
  const run = spawnSync(gcalcliPython(), ["-I", TOKEN_SCRIPT], { encoding: "utf8", timeout: 60_000 });
  if (run.status !== 0 || !run.stdout) {
    throw new Error(`CalendarApi: no access token (exit ${run.status}): ${run.stderr.trim() || run.error?.message || "empty output"}`);
  }
  return run.stdout.trim();
}

// ============================================================================
// REST client
// ============================================================================

/** Waits before retry 1 and 2 of a transient failure (3 attempts in all). */
const RETRY_DELAYS_MS = [1_000, 4_000];
const RETRYABLE_READ = new Set([429, 500, 502, 503, 504]);
/**
 * A write retries only on 429 (rate limit: Google did not process it). Not on
 * 503: Google may have stored the event before it failed, and a retry would
 * then make a double hold.
 */
const RETRYABLE_WRITE = new Set([429]);

/** Injection points for tests; production uses the real fetch, token and timer. */
export interface CalendarClientDeps {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  getToken?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** Calendar write audit log path (default: the shared CalendarAssistant log). */
  writeLogPath?: string;
}

export function createCalendarClient(calendarId = "primary", deps: CalendarClientDeps = {}): CalendarClient {
  let token: string | null = null;
  const cal = encodeURIComponent(calendarId);
  const logOpts = deps.writeLogPath ? { logPath: deps.writeLogPath } : {};
  const doFetch = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const getToken = deps.getToken ?? getAccessToken;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  /**
   * One API call with a bounded retry. A dropped socket or a 429/5xx on a read
   * is retried (a 2026-11-08 dry run lost all holds to one "socket connection
   * was closed unexpectedly" on a read). A network error on a write is never
   * retried: the event may exist already.
   */
  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    token ??= getToken();
    const method = init.method ?? "GET";
    const isRead = method === "GET";
    const retryable = isRead ? RETRYABLE_READ : RETRYABLE_WRITE;
    for (let attempt = 0; ; attempt++) {
      const delay = RETRY_DELAYS_MS[attempt];
      try {
        const res = await doFetch(`${API}${path}`, {
          ...init,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
        });
        if (delay === undefined || !retryable.has(res.status)) return res;
        await res.body?.cancel();
        console.warn(`[CalendarApi] ${method} HTTP ${res.status}; retry ${attempt + 1} in ${delay} ms`);
      } catch (err) {
        if (delay === undefined || !isRead) throw err;
        console.warn(`[CalendarApi] ${method} network error (${(err as Error).message}); retry ${attempt + 1} in ${delay} ms`);
      }
      await sleep(delay);
    }
  }

  async function fail(res: Response, what: string): Promise<never> {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`CalendarApi: ${what} failed: HTTP ${res.status} ${res.statusText} — ${body}`);
  }

  return {
    async listEvents({ timeMin, timeMax, privateExtendedProperty }) {
      const out: CalendarEvent[] = [];
      let pageToken: string | undefined;
      do {
        const q = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "250" });
        if (privateExtendedProperty) q.set("privateExtendedProperty", privateExtendedProperty);
        if (pageToken) q.set("pageToken", pageToken);
        const res = await call(`/calendars/${cal}/events?${q}`);
        if (!res.ok) await fail(res, "list events");
        const page = (await res.json()) as { items?: CalendarEvent[]; nextPageToken?: string };
        out.push(...(page.items ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return out;
    },

    async insertEvent(event) {
      const title = event.summary ?? "(no title)";
      const res = await call(`/calendars/${cal}/events`, { method: "POST", body: JSON.stringify(event) });
      if (!res.ok) {
        logCalendarWrite({ target: calendarId, caller: LOG_CALLER, title, outcome: `failed: HTTP ${res.status}` }, logOpts);
        await fail(res, "insert event");
      }
      const created = (await res.json()) as CalendarEvent;
      logCalendarWrite({ target: calendarId, caller: LOG_CALLER, title, outcome: `created ${created.id}` }, logOpts);
      return created;
    },

    async getEvent(id) {
      const res = await call(`/calendars/${cal}/events/${encodeURIComponent(id)}`);
      if (res.status === 404 || res.status === 410) return null;
      if (!res.ok) await fail(res, "get event");
      const event = (await res.json()) as CalendarEvent;
      return event.status === "cancelled" ? null : event;
    },
  };
}
