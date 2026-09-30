#!/usr/bin/env bun
/**
 * AWPoller.ts — pulls events from each device's ActivityWatch REST API into DuckDB.
 *
 * Invoked three ways (there is NO 5-min poller — the old `com.kaya.aw-poller`
 * LaunchAgent was removed: it collided with other jobs on events.db's exclusive
 * write lock and was consolidated into `com.kaya.appusage-nightly`):
 *   1. nightly at 02:00 for ALL devices via bin/nightly-pipeline.sh
 *   2. on USB plug-in for phone/tablet via PhoneAutoPoll.ts (com.kaya.aw-phone-autopoll)
 *   3. on-demand for all devices via `/media sync` (bin/sync-now.sh)
 * The mac thus only refreshes nightly + on-demand; a Freshness "mac stale" at
 * mid-day is expected, not a broken job. Idempotent (INSERT OR REPLACE on PK);
 * incremental (queries ?start=<last_event_ts>).
 *
 * Failure isolation: one device unreachable does NOT stop the others. Errors
 * are logged to MEMORY/MONITORING/failure-log.jsonl AND written to
 * sync_state.last_error so Freshness.ts can surface them.
 *
 * Flags:
 *   --dry-run    fetch from devices but do not write to DuckDB
 *   --json       emit JSON summary on stdout (default: human text)
 *   --device=N   only poll device with matching name ('mac'|'phone'|'tablet')
 */

import { CONFIG, isDeviceReady, type DeviceConfig } from "../Config.ts";
import { Db, logFailure } from "./Db.ts";

interface AWBucketInfo {
  id: string;
  type: string;
  client?: string;
  hostname?: string;
  /** ISO timestamp of the last event in this bucket on the AW server. Used to
   *  skip buckets that have gone silent for STALE_BUCKET_DAYS (e.g. old
   *  hostname-suffixed buckets left behind after a hostname change). */
  last_updated?: string;
}

/** Skip a server-side bucket whose `last_updated` is older than this. Catches
 *  the dead hostname-suffixed buckets that aw-server never deletes — without
 *  this, every 5-min poll fires a needless HTTP request per stale bucket. */
const STALE_BUCKET_DAYS = 7;

/** Guard against cursor poisoning: if the stored cursor is more than this far
 *  in the future of wall-clock now, treat it as corrupted and reset to the
 *  newest real event we have. Originally added after the 2026-05-14 TZ-drift
 *  incident — see SKILL.md "Cursor TZ drift" section. */
const CURSOR_FUTURE_TOLERANCE_MS = 5 * 60_000;

interface AWEvent {
  id?: number;
  timestamp: string;
  duration: number;
  data: Record<string, unknown>;
}

export interface PollSummary {
  device: string;
  buckets: number;
  events_fetched: number;
  events_inserted: number;
  ok: boolean;
  error?: string;
  skipped?: string;
}

const FETCH_TIMEOUT_MS = 10_000;

async function fetchJson<T>(url: string): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} on ${url}`);
    return await res.json() as T;
  } finally {
    clearTimeout(t);
  }
}

export async function pollDevice(
  dev: DeviceConfig,
  db: Db,
  dryRun: boolean,
): Promise<PollSummary> {
  const summary: PollSummary = {
    device: dev.name,
    buckets: 0,
    events_fetched: 0,
    events_inserted: 0,
    ok: false,
  };

  if (!isDeviceReady(dev)) {
    summary.skipped = "placeholder Tailscale IP — set AW_PHONE_URL/AW_TABLET_URL or edit Config.ts";
    summary.ok = true; // not an error, just not configured yet
    return summary;
  }

  const buckets = await fetchJson<Record<string, AWBucketInfo>>(`${dev.baseUrl}/api/0/buckets/`);
  summary.buckets = Object.keys(buckets).length;

  for (const [bucketId, bucketInfo] of Object.entries(buckets)) {
    // Skip server-side stale buckets (e.g. old hostname-suffixed buckets that
    // aw-server retains forever). last_updated is ISO from aw-server.
    if (bucketInfo.last_updated) {
      const updatedMs = Date.parse(bucketInfo.last_updated);
      if (Number.isFinite(updatedMs)) {
        const ageMs = Date.now() - updatedMs;
        if (ageMs > STALE_BUCKET_DAYS * 86_400_000) continue;
      }
    }

    // CRITICAL: read the cursor via strftime so it comes back as a UTC ISO
    // string. `SELECT last_event_ts` returns DuckDBTimestampValue, which
    // `new Date(...)` then interprets as LOCAL TIME — adding the host's TZ
    // offset on every poll. With events.length === 0 we rewrite the cursor
    // back, so the drift compounds across polls (+7h per cycle in PDT) until
    // the cursor lands months in the future and no new events are ever seen.
    // Reading the column as an explicit ISO-Z string avoids the round-trip.
    const last = await db.queryRow<{ last_event_ts_iso: string | null }>(
      `SELECT strftime(last_event_ts, '%Y-%m-%dT%H:%M:%S.%fZ') AS last_event_ts_iso
         FROM sync_state WHERE device = $device AND bucket = $bucket`,
      { device: dev.name, bucket: bucketId },
    );

    let since = last?.last_event_ts_iso ?? "1970-01-01T00:00:00.000000Z";

    // Cursor-poison guard. If the cursor sits more than CURSOR_FUTURE_TOLERANCE_MS
    // ahead of now, something corrupted it (the TZ-drift incident landed cursors
    // in Jan 2027). Reset to MAX(events.ts_start) for this bucket, or to epoch
    // if we have no events. Log so any recurrence is visible.
    const cursorMs = Date.parse(since);
    if (Number.isFinite(cursorMs) && cursorMs > Date.now() + CURSOR_FUTURE_TOLERANCE_MS) {
      const recovered = await db.queryRow<{ iso: string | null }>(
        `SELECT strftime(MAX(ts_start), '%Y-%m-%dT%H:%M:%S.%fZ') AS iso
           FROM events WHERE device = $device AND bucket = $bucket`,
        { device: dev.name, bucket: bucketId },
      );
      const corrected = recovered?.iso ?? "1970-01-01T00:00:00.000000Z";
      await logFailure("AWPoller", new Error("poisoned cursor reset"), {
        device: dev.name,
        bucket: bucketId,
        poisoned_cursor: since,
        reset_to: corrected,
      });
      await db.run(
        `UPDATE sync_state SET last_event_ts = $ts::TIMESTAMP
          WHERE device = $device AND bucket = $bucket`,
        { device: dev.name, bucket: bucketId, ts: corrected },
      );
      since = corrected;
    }

    const eventsUrl = `${dev.baseUrl}/api/0/buckets/${encodeURIComponent(bucketId)}/events?start=${encodeURIComponent(since)}&limit=${CONFIG.pollFetchLimit}`;
    const events = await fetchJson<AWEvent[]>(eventsUrl);
    summary.events_fetched += events.length;

    if (dryRun) continue;

    // No new events still counts as a successful poll — refresh last_sync_ok
    // but leave last_event_ts alone. Rewriting last_event_ts when there are no
    // new events would re-run the TIMESTAMP round-trip every poll; if that
    // round-trip is ever lossy again, the cursor would drift. Touch only
    // last_sync_ok via UPDATE-or-INSERT (the row may not exist yet).
    if (events.length === 0) {
      const now = new Date().toISOString();
      await db.run(
        `INSERT INTO sync_state (device, bucket, last_event_ts, last_sync_ok, last_error)
         SELECT $device, $bucket, NULL, $now::TIMESTAMP, NULL
          WHERE NOT EXISTS (
            SELECT 1 FROM sync_state WHERE device = $device AND bucket = $bucket
          )`,
        { device: dev.name, bucket: bucketId, now },
      );
      await db.run(
        `UPDATE sync_state SET last_sync_ok = $now::TIMESTAMP, last_error = NULL
          WHERE device = $device AND bucket = $bucket`,
        { device: dev.name, bucket: bucketId, now },
      );
      continue;
    }

    // AW returns events newest-first. Insert all; track newest timestamp.
    // Use Date.parse() rather than string compare — `since` from DB lacks the
    // 'Z' suffix that AW's `ev.timestamp` carries, so `ev.timestamp > since`
    // would lexically compare unevenly and could fail to advance newestTs.
    let newestTs = since;
    let newestMs = Date.parse(since);
    for (const ev of events) {
      // PK includes ev.timestamp to survive aw-server local DB wipes — if
      // aw-server reinstalls, event IDs reset to 1 and would otherwise collide
      // with pre-wipe rows. The accompanying schema v1 migration appends
      // ts_start to every legacy row so re-fetched events line up.
      const id = `${dev.name}:${bucketId}:${ev.id ?? "x"}:${ev.timestamp}`;
      const data = ev.data ?? {};
      await db.run(
        `INSERT OR REPLACE INTO events
         (id, device, bucket, watcher, app, title, url, audible, ts_start, duration_sec, raw_json)
         VALUES ($id, $device, $bucket, $watcher, $app, $title, $url, $audible, $ts::TIMESTAMP, $dur, $raw)`,
        {
          id,
          device: dev.name,
          bucket: bucketId,
          watcher: bucketInfo.type ?? "",
          app: (data.app ?? data.application ?? null) as string | null,
          title: (data.title ?? null) as string | null,
          url: (data.url ?? null) as string | null,
          audible: (data.audible ?? null) as boolean | null,
          ts: ev.timestamp,
          dur: Number(ev.duration),
          raw: JSON.stringify(ev),
        },
      );
      summary.events_inserted++;
      const evMs = Date.parse(ev.timestamp);
      if (Number.isFinite(evMs) && evMs > newestMs) {
        newestMs = evMs;
        newestTs = ev.timestamp;
      }
    }

    await db.run(
      `INSERT OR REPLACE INTO sync_state (device, bucket, last_event_ts, last_sync_ok, last_error)
       VALUES ($device, $bucket, $newest::TIMESTAMP, $now::TIMESTAMP, NULL)`,
      {
        device: dev.name,
        bucket: bucketId,
        newest: newestTs,
        now: new Date().toISOString(),
      },
    );
  }

  // Clear any stale '_poll_' error row from a previous failed poll —
  // a successful run means the device-level error is no longer current.
  await db.run(
    `DELETE FROM sync_state WHERE device = $device AND bucket = '_poll_'`,
    { device: dev.name },
  );

  summary.ok = true;
  return summary;
}

async function main(argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const json = argv.includes("--json");
  const deviceFlag = argv.find(a => a.startsWith("--device="))?.slice("--device=".length);

  const db = await Db.open();
  try {
    await db.initSchema();
    const targets = CONFIG.devices.filter(d => !deviceFlag || d.name === deviceFlag);
    const results: PollSummary[] = [];

    for (const dev of targets) {
      try {
        const r = await pollDevice(dev, db, dryRun);
        results.push(r);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Only log to failure-log on the OK → FAIL transition. Continuous failures
        // (e.g. phone unplugged for days) would otherwise spam the log every 5 min.
        const prior = await db.queryRow<{ last_error: string | null }>(
          `SELECT last_error FROM sync_state WHERE device = $device AND bucket = '_poll_'`,
          { device: dev.name },
        );
        const isNewFailure = !prior || prior.last_error === null;
        await db.run(
          `INSERT OR REPLACE INTO sync_state (device, bucket, last_event_ts, last_sync_ok, last_error)
           VALUES ($device, '_poll_', NULL, NULL, $err)`,
          { device: dev.name, err: msg },
        );
        if (isNewFailure) {
          await logFailure("AWPoller", err, { device: dev.name });
        }
        results.push({
          device: dev.name,
          buckets: 0,
          events_fetched: 0,
          events_inserted: 0,
          ok: false,
          error: msg,
        });
      }
    }

    if (json) {
      console.log(JSON.stringify({ dryRun, results }, null, 2));
    } else {
      for (const r of results) {
        const tag = r.ok ? (r.skipped ? "SKIP" : "OK") : "ERR";
        const detail = r.skipped
          ? r.skipped
          : r.error
            ? r.error
            : `${r.events_inserted}/${r.events_fetched} events across ${r.buckets} buckets`;
        console.log(`[${tag}] ${r.device}: ${detail}`);
      }
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) main(process.argv.slice(2)).catch(err => {
  console.error(err);
  process.exit(1);
});
