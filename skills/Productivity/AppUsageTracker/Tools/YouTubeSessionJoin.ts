/**
 * YouTubeSessionJoin.ts — estimate consumed (watched OR listened) minutes for
 * low-value YouTube videos from Takeout watch-history.
 *
 * Takeout records the time a video was OPENED, not how long it was consumed.
 * We infer consumed time from two signals:
 *
 *   1. Inter-open gap — the time until the NEXT video was opened bounds how
 *      long the previous one could have been consumed. A video skipped after
 *      10s shows a 10s gap; one listened through shows a gap ≈ its duration.
 *      This is the only signal that captures background phone listening, which
 *      the foreground watchers never see.
 *
 *   2. aw-watcher foreground sessions (tablet / Mac only) — when the open
 *      falls inside a real foreground watching session and that session shows
 *      LESS time than the gap implies, the user demonstrably left earlier, so
 *      the session estimate wins. Phone sessions are excluded: phone YouTube
 *      is mostly background audio, so its foreground watcher records tiny
 *      fragments that would wrongly crush genuine listening time.
 *
 * Per open:  consumed = min(videoDuration, gapToNextOpen)
 *            refined:  if a tablet/Mac session contains the open and its
 *                      per-open share is smaller, use that share instead.
 *
 * Opens corroborated by a foreground session are tagged "watched"; gap-only
 * opens are tagged "listened" (consumption inferred, not directly observed).
 * Both sum into the low-value total — the split is for tracking, not the goal.
 */

import { CONFIG } from "../Config.ts";
import { Db } from "./Db.ts";

/** Max gap between aw-watcher events still treated as one foreground session. */
export const YOUTUBE_SESSION_GAP_SEC = 300;
/** Pathological-data guard (e.g. an 8-hour livestream VOD opened once and left
 *  before another open). Generous enough never to truncate a normal video. */
export const YOUTUBE_ABSOLUTE_CAP_SEC = 4 * 3600;
/** Applied when a video's duration is unknown (deleted/private/0-duration). */
export const UNKNOWN_DURATION_FALLBACK_SEC = 1800;
/** Cap on listening-only opens (no foreground session) where gap >= duration —
 *  i.e. we'd otherwise count the full video duration. Jm typically listens at
 *  2x; without a real-time signal, defaulting to full duration overcounts.
 *  Quantified: 13 hour-plus background listens drove most of the dur-wins
 *  overcount in 28-day analysis. */
export const LISTENING_NO_SESSION_CAP_SEC = 60 * 60;
/** Playback-speed factor for duration-INFERRED listening. Jm consumes YouTube at
 *  ~2x, so when we fall back to a video's nominal duration (no foreground session
 *  and no tighter inter-open gap), real time ≈ duration/2. Applied ONLY to the
 *  duration-wins listening branch — "watched" minutes are real foreground screen
 *  time (already 2x-correct) and gap-wins minutes are real elapsed wall-clock. */
export const LISTEN_SPEED_FACTOR = 0.5;

/** Foreground watchers we trust as evidence of active watching. Phone is
 *  excluded on purpose — see file header. */
const FOREGROUND_DEVICES = ["tablet", "mac"];
const YT_APPS_LOWERCASE = ["youtube", "com.google.android.youtube", "nebula"];

export interface YouTubeConsumption {
  /** Total low-value YouTube minutes — watchedMinutes + listenedMinutes. */
  minutes: number;
  /** Minutes corroborated by a tablet/Mac foreground session. */
  watchedMinutes: number;
  /** Minutes inferred from inter-open gaps with no foreground corroboration. */
  listenedMinutes: number;
}

interface OpenRow {
  ts: Date;
  nextTs: Date | null;
  durationSec: number | null;
  isLowValue: boolean;
}

interface AwEvent {
  device: string;
  ts_start: Date;
  duration_sec: number;
}

interface YouTubeSession {
  device: string;
  start: Date;
  end: Date;
  duration_sec: number;
}

function buildSessions(events: AwEvent[]): YouTubeSession[] {
  const sorted = [...events].sort((a, b) => {
    if (a.device !== b.device) return a.device < b.device ? -1 : 1;
    return a.ts_start.getTime() - b.ts_start.getTime();
  });
  const sessions: YouTubeSession[] = [];
  let cur: YouTubeSession | null = null;
  for (const ev of sorted) {
    const evStart = ev.ts_start;
    const evEnd = new Date(evStart.getTime() + ev.duration_sec * 1000);
    if (cur && cur.device === ev.device && (evStart.getTime() - cur.end.getTime()) / 1000 <= YOUTUBE_SESSION_GAP_SEC) {
      cur.duration_sec += ev.duration_sec;
      if (evEnd > cur.end) cur.end = evEnd;
    } else {
      cur = { device: ev.device, start: evStart, end: evEnd, duration_sec: ev.duration_sec };
      sessions.push(cur);
    }
  }
  return sessions;
}

function findContainingSession(sessions: YouTubeSession[], ts: Date): YouTubeSession | null {
  for (const s of sessions) {
    if (ts >= s.start && ts <= s.end) return s;
  }
  return null;
}

/**
 * Consumed low-value YouTube minutes for a local-date, split into
 * foreground-corroborated ("watched") and gap-inferred ("listened").
 */
export async function computeYouTubeConsumption(
  db: Db,
  date: string,
  opts: { includeAllVerdicts?: boolean } = {},
): Promise<YouTubeConsumption> {
  // Default: only low-value opens count (the G37 goal). includeAllVerdicts=true
  // counts EVERY open regardless of verdict (low-value, not-low-value, or
  // unclassified) — used for the total_youtube_minutes tracking column.
  const { includeAllVerdicts = false } = opts;
  // (1) Every open for the local date, each carrying the timestamp of the
  // NEXT open anywhere in history (LEAD over the full table, then filtered).
  const openRows = await db.queryAll<{
    ts: string; next_ts: string | null;
    duration_sec: number | bigint | null; is_low_value: boolean | null;
  }>(
    `
    WITH ordered AS (
      SELECT h.ts AS ts, h.video_id AS video_id,
             LEAD(h.ts) OVER (ORDER BY h.ts, h.video_id) AS next_ts
        FROM youtube_history h
    )
    SELECT o.ts::VARCHAR        AS ts,
           o.next_ts::VARCHAR   AS next_ts,
           v.duration_sec       AS duration_sec,
           vd.is_low_value      AS is_low_value
      FROM ordered o
      LEFT JOIN youtube_videos v   ON v.video_id  = o.video_id
      LEFT JOIN youtube_verdicts vd ON vd.video_id = o.video_id
     WHERE CAST(o.ts AT TIME ZONE 'UTC' AT TIME ZONE '${CONFIG.localTimezone}' AS DATE) = $date::DATE
     ORDER BY o.ts
    `,
    { date },
  );
  if (openRows.length === 0) return { minutes: 0, watchedMinutes: 0, listenedMinutes: 0 };

  const parseTs = (s: string): Date => new Date(s.replace(" ", "T") + "Z");
  const opens: OpenRow[] = openRows.map(r => ({
    ts: parseTs(r.ts),
    nextTs: r.next_ts == null ? null : parseTs(r.next_ts),
    durationSec: r.duration_sec == null ? null : Number(r.duration_sec),
    isLowValue: r.is_low_value === true,
  }));

  // (2) tablet/Mac foreground YouTube events around the day. A generous
  // [date-1, date+2] UTC bracket guarantees any session overlapping a local
  // open is loaded; over-fetching is harmless since only sessions that
  // actually contain an open get attributed.
  const appPh = YT_APPS_LOWERCASE.map((_, i) => `$app${i}`).join(", ");
  const devPh = FOREGROUND_DEVICES.map((_, i) => `$dev${i}`).join(", ");
  const bindings: Record<string, unknown> = { date };
  YT_APPS_LOWERCASE.forEach((app, i) => { bindings[`app${i}`] = app; });
  FOREGROUND_DEVICES.forEach((dev, i) => { bindings[`dev${i}`] = dev; });
  const events = await db.queryAll<{ device: string; ts_start: string; duration_sec: number | bigint }>(
    `
    SELECT e.device AS device, e.ts_start::VARCHAR AS ts_start, e.duration_sec AS duration_sec
      FROM events e
     WHERE lower(e.app) IN (${appPh})
       AND e.device IN (${devPh})
       AND e.ts_start BETWEEN ($date::DATE - INTERVAL 1 DAY) AND ($date::DATE + INTERVAL 2 DAY)
     ORDER BY e.device, e.ts_start
    `,
    bindings,
  );
  const sessions = buildSessions(events.map(e => ({
    device: e.device,
    ts_start: parseTs(e.ts_start),
    duration_sec: Number(e.duration_sec),
  })));

  // (3) Map every open to its containing foreground session (if any) so the
  // session's time can be split across the opens that share it.
  const openSession = new Map<OpenRow, YouTubeSession | null>();
  const sessionOpenCount = new Map<YouTubeSession, number>();
  for (const open of opens) {
    const s = findContainingSession(sessions, open.ts);
    openSession.set(open, s);
    if (s != null) sessionOpenCount.set(s, (sessionOpenCount.get(s) ?? 0) + 1);
  }

  // (4) Per low-value open: gap estimate, refined by foreground session.
  let watchedSec = 0;
  let listenedSec = 0;
  for (const open of opens) {
    if (!includeAllVerdicts && !open.isLowValue) continue;

    const gapSec = open.nextTs == null
      ? Infinity
      : (open.nextTs.getTime() - open.ts.getTime()) / 1000;

    const hasDuration = open.durationSec != null && open.durationSec > 0;
    let estimate = hasDuration
      ? Math.min(open.durationSec as number, gapSec)
      : Math.min(gapSec, UNKNOWN_DURATION_FALLBACK_SEC);

    const session = openSession.get(open) ?? null;
    if (session != null) {
      // Foreground-corroborated: if the session's per-open share is tighter
      // than the gap estimate, the user demonstrably left earlier.
      const share = session.duration_sec / (sessionOpenCount.get(session) ?? 1);
      estimate = Math.min(estimate, share);
    } else if (hasDuration && (open.durationSec as number) <= gapSec) {
      // Listening-only AND nominal duration won (gap >= duration): no real-time
      // signal, so apply the 2x playback-speed factor (real ≈ duration/2), then
      // cap defensively. Gap-wins listening is left alone — the gap IS real time.
      estimate = Math.min(estimate * LISTEN_SPEED_FACTOR, LISTENING_NO_SESSION_CAP_SEC);
    }

    estimate = Math.min(estimate, YOUTUBE_ABSOLUTE_CAP_SEC);
    if (estimate <= 0) continue;

    if (session != null) watchedSec += estimate;
    else listenedSec += estimate;
  }

  const watchedMinutes = Math.round(watchedSec / 60);
  const listenedMinutes = Math.round(listenedSec / 60);
  return {
    minutes: watchedMinutes + listenedMinutes,
    watchedMinutes,
    listenedMinutes,
  };
}
