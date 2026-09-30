-- AppUsageTracker DuckDB schema. Idempotent: every CREATE is IF NOT EXISTS.
-- Run via `Tools/DBInit.ts` before any read/write.

CREATE TABLE IF NOT EXISTS events (
  id              VARCHAR PRIMARY KEY,           -- "<device>:<bucket>:<event_id>"
  device          VARCHAR NOT NULL,               -- 'mac' | 'phone' | 'tablet'
  bucket          VARCHAR NOT NULL,
  watcher         VARCHAR NOT NULL,               -- e.g. 'aw-watcher-android-usage'
  app             VARCHAR,                        -- 'com.reddit.frontpage' or 'Google Chrome'
  title           VARCHAR,                        -- window title (Mac) or app name (Android)
  url             VARCHAR,                        -- web watcher only
  audible         BOOLEAN,                        -- web watcher only
  ts_start        TIMESTAMP NOT NULL,
  duration_sec    DOUBLE NOT NULL,
  raw_json        VARCHAR                         -- full event payload, for audit/replay
);
CREATE INDEX IF NOT EXISTS idx_events_device_ts ON events(device, ts_start);
CREATE INDEX IF NOT EXISTS idx_events_app ON events(app);

CREATE TABLE IF NOT EXISTS sync_state (
  device          VARCHAR NOT NULL,
  bucket          VARCHAR NOT NULL,
  last_event_ts   TIMESTAMP,                      -- highest ts_start ingested
  last_sync_ok    TIMESTAMP,                      -- last successful poll
  last_error      VARCHAR,
  PRIMARY KEY (device, bucket)
);

CREATE TABLE IF NOT EXISTS classifications (
  event_id        VARCHAR PRIMARY KEY,
  tier            INTEGER NOT NULL,               -- 1, 2, 3
  classifier      VARCHAR NOT NULL,               -- 'tier1-whitelist' | 'llm-sonnet' | 'tier3-ignore'
  is_low_value    BOOLEAN NOT NULL,
  reason          VARCHAR,
  classified_at   TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_metrics (
  date                    DATE PRIMARY KEY,
  tier1_minutes           INTEGER NOT NULL DEFAULT 0,
  tier2_lowvalue_minutes  INTEGER NOT NULL DEFAULT 0,    -- V1.5+; 0 in V1
  total_lowvalue_minutes  INTEGER NOT NULL DEFAULT 0,    -- tier1 + tier2_lowvalue
  -- v2 — YouTube sub-split of tier2 (watched + listened == YouTube portion).
  -- For tracking only; the G37 media goal uses total_lowvalue_minutes.
  yt_watched_minutes      INTEGER NOT NULL DEFAULT 0,    -- foreground-corroborated
  yt_listened_minutes     INTEGER NOT NULL DEFAULT 0,    -- gap-inferred (e.g. bg audio)
  -- v3 — total ("all", not just low-value) aggregates for the usage overview.
  -- These are tracking-only; the G37 goal still uses total_lowvalue_minutes.
  total_youtube_minutes   INTEGER NOT NULL DEFAULT 0,    -- ALL YouTube consumed (every verdict), 2x-corrected
  total_media_minutes     INTEGER NOT NULL DEFAULT 0,    -- foreground screen time on non-utility apps (excl Tier-3)
  total_screen_minutes    INTEGER NOT NULL DEFAULT 0,    -- all foreground app screen time (currentwindow watcher, all apps)
  -- AVG over LOGGED days in [date-27, date] — i.e. days that have a row in
  -- daily_metrics. Days with no events / no row are absent from the divisor
  -- rather than treated as 0. Labels in Freshness.ts and Dashboard.ts read
  -- "avg per logged day" to keep this honest; renaming the column would be a
  -- migration so we keep `rolling_4wk_avg` as the historical identifier.
  rolling_4wk_avg         DOUBLE,
  computed_at             TIMESTAMP NOT NULL
);

-- V1.6 — Chrome SQLite ingest. One row per visit pulled from
-- ~/Library/Application Support/Google/Chrome/Default/History. Used for
-- per-URL classification of Mac Chrome browsing time (and, once Chrome
-- sync starts landing foreign rows, anything from other devices).
-- See ChromeIngest.ts / ChromeClassifier.ts.
CREATE TABLE IF NOT EXISTS chrome_visits (
  id                       VARCHAR PRIMARY KEY,    -- 'chrome:<chrome_visit_time_us>'
  source                   VARCHAR NOT NULL,        -- 'mac' (local) | 'sync' (originator_cache_guid non-empty)
  url                      VARCHAR NOT NULL,
  domain                   VARCHAR,                 -- lowercased host, e.g. 'reddit.com'
  title                    VARCHAR,
  visit_time               TIMESTAMP NOT NULL,      -- UTC, converted from Chrome epoch
  visit_duration_sec       DOUBLE NOT NULL DEFAULT 0,
  transition               INTEGER NOT NULL DEFAULT 0,
  from_visit_id            BIGINT NOT NULL DEFAULT 0,
  originator_cache_guid    VARCHAR
);
CREATE INDEX IF NOT EXISTS idx_chrome_visits_time ON chrome_visits(visit_time);
CREATE INDEX IF NOT EXISTS idx_chrome_visits_domain ON chrome_visits(domain);

-- Per-source cursor for incremental Chrome ingest. 'mac' refers to the local
-- Mac Chrome's SQLite — when phone-sync visits land, they appear in the same
-- snapshot and the cursor still moves forward correctly.
CREATE TABLE IF NOT EXISTS chrome_sync_state (
  source                       VARCHAR PRIMARY KEY,
  last_visit_time_chrome_us    BIGINT NOT NULL,        -- highest Chrome epoch seen
  last_sync_ok                 TIMESTAMP NOT NULL
);

-- Domain-level Chrome classification cache. Verdicts are keyed by (domain,
-- source) and have a TTL of CHROME_CACHE_TTL_DAYS (see ChromeClassifier.ts).
-- ChromeClassifier inserts rows here AND writes per-visit `classifications`
-- rows so the existing tier-2 metric path stays the single source of truth.
CREATE TABLE IF NOT EXISTS chrome_domain_verdicts (
  domain          VARCHAR NOT NULL,
  source          VARCHAR NOT NULL,
  is_low_value    BOOLEAN NOT NULL,
  reason          VARCHAR,
  confidence      DOUBLE,
  classifier      VARCHAR NOT NULL,        -- 'tier1-domain' | 'llm-sonnet'
  classified_at   TIMESTAMP NOT NULL,
  PRIMARY KEY (domain, source)
);

CREATE TABLE IF NOT EXISTS schema_version (
  version       INTEGER PRIMARY KEY,
  applied_at    TIMESTAMP NOT NULL
);

-- V1.6 — YouTube pipeline tables.
--
-- youtube_history: one row per Takeout "Watched <video>" entry. The Takeout
-- export only records open events, NOT watched durations.
-- youtube_videos: per-video metadata, populated by YouTubeEnrich.ts via the
-- YouTube Data API v3 (videos.list?part=contentDetails,snippet&id=...).
CREATE TABLE IF NOT EXISTS youtube_history (
  ts              TIMESTAMP NOT NULL,    -- UTC opened_at from Takeout
  video_id        VARCHAR NOT NULL,
  title           VARCHAR,
  channel         VARCHAR,
  channel_url     VARCHAR,
  source_export   VARCHAR NOT NULL,      -- 'takeout:<file-basename>' for audit/dedup
  PRIMARY KEY (ts, video_id)
);
CREATE INDEX IF NOT EXISTS idx_yt_history_video ON youtube_history(video_id);
CREATE INDEX IF NOT EXISTS idx_yt_history_time  ON youtube_history(ts);

CREATE TABLE IF NOT EXISTS youtube_videos (
  video_id        VARCHAR PRIMARY KEY,
  title           VARCHAR,
  channel         VARCHAR,
  channel_id      VARCHAR,
  duration_sec    INTEGER,
  category_id     INTEGER,
  tags_json       VARCHAR,                -- JSON array of strings
  enriched_at     TIMESTAMP,
  enrich_error    VARCHAR                 -- non-null when API returned no entry (deleted/private)
);

-- Per-video low-value verdict (analogous to chrome_domain_verdicts).
CREATE TABLE IF NOT EXISTS youtube_verdicts (
  video_id        VARCHAR PRIMARY KEY,
  is_low_value    BOOLEAN NOT NULL,
  reason          VARCHAR,
  confidence      DOUBLE,
  classifier      VARCHAR NOT NULL,       -- 'llm-sonnet'
  classified_at   TIMESTAMP NOT NULL
);

-- V1.7 — YouTubeCuration (skills/Productivity/YouTubeCuration) append-only
-- deletion ledger. THE ROW IS THE ARCHIVE (self-contained, never a pointer —
-- see youtube-curation spec.md §5): items newer than the last Takeout export
-- aren't anywhere else. THE ONE CODED INVARIANT (charter): a row here must be
-- written and confirmed BEFORE the corresponding destructive click — no
-- write, no delete. Created COMPLETE (all constraints inline) because DuckDB
-- ALTER TABLE ADD COLUMN cannot add constraints — see Db.ts's runMigrations
-- comments for the pattern this table deliberately avoids needing.
CREATE TABLE IF NOT EXISTS youtube_deletions (
  video_id        VARCHAR NOT NULL,
  title           VARCHAR,                 -- as rendered at deletion time
  channel         VARCHAR,                 -- as rendered at deletion time
  watched_at      TIMESTAMP,               -- history surface only; NULL for WL (WL renders no added-dates)
  surface         VARCHAR NOT NULL CHECK (surface IN ('history', 'watch_later')),
  actions         VARCHAR NOT NULL,        -- comma-joined: deleted, not-interested, dont-recommend, someday-add, wl-removed
  reason          VARCHAR NOT NULL,        -- the LLM's one-line judgment verbatim (no sensitive-marker vocabulary)
  extra           VARCHAR,                 -- JSON text, surface-specific rendered fields (WL: duration, published-ago, list position, resume fraction)
  run_id          VARCHAR NOT NULL,        -- /youtube run identifier
  created_at      TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_yt_deletions_run     ON youtube_deletions(run_id);
CREATE INDEX IF NOT EXISTS idx_yt_deletions_video   ON youtube_deletions(video_id);
CREATE INDEX IF NOT EXISTS idx_yt_deletions_surface ON youtube_deletions(surface);
