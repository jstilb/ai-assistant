# YouTubeCuration: files, data model, out of scope

Moved out of `SKILL.md`. Reference tables. Read them when you change a tool or the stored data.

## Files

| Path | Purpose |
|---|---|
| `Tools/Status.ts` | `/youtube` / `/youtube status` — read-only summary (see Invocation) |
| `Tools/IntentReader.ts` | Reads `USER/YouTubeIntent.yaml` (`topics` + `declared_at`); degrades to "no intent declared" if missing/malformed |
| `Tools/IntentParser.ts` | `/youtube steer <prose>` parse step — prose → `inference({schema})` → topic list; zero writes |
| `Tools/IntentWriter.ts` | `/youtube steer` write step — CONFIRMED topics → `USER/YouTubeIntent.yaml`; total replacement, never merges, never touches the inference seam |
| `Tools/RunStateReader.ts` | Reads `MEMORY/State/youtube-curation.json` (convenience cache, not ground truth); degrades safely on missing/corrupt file. Slice 6 adds `lastSteerDetail` (per-topic adds, sweep count, searches run, dropped-topic cleanups, subjective check-in) alongside the existing `held`/`lastRun`/`wlSnapshot`/`somedayPlaylist` fields |
| `Tools/LedgerReader.ts` | READ_ONLY totals per surface from events.db's `youtube_deletions`; fails loud (throws) on lock contention, times out rather than hanging, degrades to zero+note if the table doesn't exist yet |
| `Tools/SnapshotReader.ts` | Last Watch Later snapshot count + date — state-file pointer first, falls back to the ticket-07 asset |
| `Rubric.md` | The judgment rubric applied per item during `prune`/`wl`/steer-sweep passes, plus §Channel quality (shared channel-trust lens, research-grounded 2026-08-16) and §Seeding — which `SeedSourcer.ts` reads at RUN TIME and embeds verbatim in its judgment prompt (the one place code loads this file; editing the rubric changes seeding behavior with zero code edits) |
| `Tools/LedgerWriter.ts` | Writes + confirms ONE `youtube_deletions` row before resolving — the one coded invariant. Append-only (no update/delete export). CLI + importable API |
| `Tools/RunStateWriter.ts` | Writes `MEMORY/State/youtube-curation.json` — held items per surface (partial-patch merge, other surfaces/fields untouched) + last-run summary + (slice 6) `lastSteerDetail`. Schemas kept compatible with `RunStateReader.ts` by importing its exact validators |
| `Tools/ReconcileRun.ts` | READ_ONLY: given a `run_id` + claimed per-(surface,action) counts, tallies the ledger's actual counts and reports match/mismatch — spec.md §12's report-vs-ledger anchor. Used by `prune`/`wl` only — `steer` writes no ledger rows, so it never calls this. CLI + importable API |
| `Tools/SessionGuard.ts` | Deterministic `bin/claude-browser`-session check (`CLAUDE_CONFIG_DIR` marker). Exit 0 in-session; nonzero + the exact pointer line otherwise. Every DOM subcommand runbook runs this first |
| `Tools/PlaylistClient.ts` | The skill's ONE YouTube Data API seam (slice 5; slice 6 reuses its generic surface unchanged): find/create/delete playlists (`findPlaylistByTitle`, `listMyPlaylists`, `createPlaylist`, `deletePlaylist`), insert + verify-contains playlist items (`insertPlaylistItem`, `verifyPlaylistContainsVideo`, and the composed write-then-confirm `addAndVerifyPlaylistItem` — slice 6 added bounded verify-retry here, 3 attempts/~8s backoff, insert never re-issued on a verify miss), plus `ensureSomedayPlaylist()`/`SOMEDAY_PLAYLIST_TITLE` — the only Someday-specific code in the file. Injectable `http` + `getAccessToken` + (slice 6) `sleepFn`; fails loud (`PlaylistApiError`) on quota/auth/any non-2xx, pointing at `YouTubeOAuthBootstrap.ts` for 401/scope 403s. CLI + importable API |
| `Tools/WlSnapshotWriter.ts` | Writes a dated `wl-snapshot-<date>.json` in ticket-07's exact shape into `SnapshotReader.ts`'s `wlSnapshotDir()`, then updates the run-state `wlSnapshot` pointer via `RunStateWriter.ts` (partial-patch — other state fields untouched). CLI + importable API |
| `Tools/SeedSourcer.ts` | (slice 6; channel-quality enrichment 2026-08-16) Per-topic candidate sourcing for steer's seeding pass: `readRubricSection()` (Rubric.md §Channel quality + §Seeding, fail-loud before any quota spend) → one `search.list` call → `filterAlreadyWatched()` (read-only `events.db` `youtube_history` cross-ref, reuses `LedgerReader.ts`'s `openReadOnly`/timeout/lock-contention pattern) → `videos.list` metadata + stats → `getChannelDossiers()` (`channels.list` batched ≤50/call + per-channel recent-upload titles, degrade-to-`[]` per channel) → `inference({schema})` judgment against the full declared intent AND the rubric (all via the existing `YOUTUBE_API_KEY`, not OAuth — public read endpoints). Code never filters on any stat — every number goes to the LLM as text. `sourceTopicCandidates()` composes the pipeline; caps at `TARGET_CANDIDATE_COUNT` (10), never trusts an LLM-returned id outside the actual candidate set (selections AND `rejectedForQuality` alike). CLI + importable API |
| `Tools/TopicPlaylistTopUp.ts` | (slice 6) Idempotent `"Kaya: <topic>"` playlist top-up: find-or-create (`PlaylistClient.ts`, unchanged), count how many current items are still unwatched (`countUnwatched`, defaults to `SeedSourcer.ts`'s `filterAlreadyWatched()`), add just enough of an already-ranked candidate list to close the gap to ~10 unwatched. Per-item add failures are caught and returned in `failed`, never abort the topic. CLI + importable API |
| `Tools/DroppedTopicCleanup.ts` | (slice 6) Structural log-then-delete for playlists whose topic left the intent (excludes `"Kaya: Someday"`). `enumerateDroppedTopicPlaylists()` (read-only, no delete call anywhere in it) and `deleteDroppedTopicPlaylist()` (takes an already-enumerated record, no enumeration logic of its own) are separate exports so the ordering can't be silently reordered; `cleanupDroppedTopicPlaylists()` composes both. No `youtube_deletions` row — these are Kaya-created artifacts (spec.md §7.4). CLI + importable API |

## Data model

- **Intent** (`USER/YouTubeIntent.yaml`): current state only —
  `topics: string[]`, `declared_at`. No in-file history; the auto-committed
  repo's git history is the archive. Declared via `/youtube steer`'s
  parse→echo→confirm→write flow (see Invocation) — every write is a total
  replacement, never a merge.
- **Run state** (`MEMORY/State/youtube-curation.json`): convenience cache —
  held-for-review items per surface (with reasons), last-run summary, a
  pointer to the most recent WL snapshot, (slice 5) a `somedayPlaylist`
  pointer (`{id, title}`) caching the Someday playlist's YouTube id, and
  (slice 6) `lastSteerDetail` — the richer structured record of the most
  recent steer run (per-topic playlist adds, sweep action count, searches
  run, dropped-topic cleanups with their logged items, the subjective
  check-in answer) alongside the generic `lastRun` one-liner every mode
  writes. **NOT ground truth**; losing any field degrades safely — held
  items are simply re-judged next run, a lost `wlSnapshot` pointer just
  falls back to the ticket-07 asset (`SnapshotReader.ts`), a lost
  `somedayPlaylist` pointer just costs one extra paginated title search next
  time (`PlaylistClient.ts`'s `ensureSomedayPlaylist()` always re-validates
  a cached id against a live read and falls back to an exact-title search
  before ever creating — never risks a duplicate playlist), and a lost
  `lastSteerDetail` just means the next `status`/preview has nothing richer
  than `lastRun`'s one-liner to show — steer's per-topic intent playlists
  themselves are NOT cached anywhere in this file (unlike Someday);
  `TopicPlaylistTopUp.ts`/`DroppedTopicCleanup.ts` always resolve them
  fresh by exact title via `PlaylistClient.ts` each run (cheap — one
  paginated `playlists.list` covers every topic at once), so there is no
  cache to lose for those.
- **WL snapshots** (`.scratch/youtube-curation/assets/wl-snapshot-<date>.json`):
  a full point-in-time capture of the Watch Later list, same shape ticket 07
  proved (`captured_at`, `engine`, `header_count`, `complete`, `items[]`).
  The ticket-07 asset is the first one; every `wl` run writes a fresh one
  (`Tools/WlSnapshotWriter.ts`, step 8 of the wl runbook) into the SAME
  directory (`SnapshotReader.ts`'s `wlSnapshotDir()` — one function, not two
  hardcoded copies of the path), keeping `SummarizeSnapshot.ts` (built for
  ticket 07) and `SnapshotReader.ts`'s fallback-file reader compatible with
  every future snapshot with zero changes to either.
- **Ledger** (`events.db` → `youtube_deletions`): append-only archive of
  destructive acts; the row IS the archive (self-contained, never a
  pointer). DDL lives in
  `skills/Productivity/AppUsageTracker/db/schema.sql` alongside the existing
  YouTube tables. Shares AppUsageTracker's single-writer DuckDB lock —
  **every touch needs a timeout and fails loud on contention, never queues
  silently**; connections are always fully closed (DuckDB releases its OS
  lock only on full close, not on disconnect alone). Written exclusively
  through `Tools/LedgerWriter.ts` (write-then-confirm, append-only); read
  through `Tools/LedgerReader.ts` (totals), `Tools/ReconcileRun.ts`
  (per-run reconciliation), or directly for the wl runbook's
  already-watched-per-Takeout cross-ref (`youtube_history`, read-only) —
  and directly by `Tools/SeedSourcer.ts` for steer's own already-watched
  cross-ref (same table, same read-only discipline, no ledger involvement).
- **Someday playlist** (YouTube Data API, title `"Kaya: Someday"` —
  `PlaylistClient.SOMEDAY_PLAYLIST_TITLE`): the ONE Kaya-managed archive
  shelf for WL items still wanted but not realistic in the next 2–3 weeks
  (spec.md §8) — distinct from `/youtube steer`'s per-topic intent
  playlists. Its id is cached in run state (`somedayPlaylist`, above) but
  that cache is never load-bearing for correctness — see above.
- **Per-topic intent playlists** (YouTube Data API, title `"Kaya: <topic>"`
  — one per declared topic, `Tools/TopicPlaylistTopUp.ts`'s
  `topicPlaylistTitle()`): the queue Jm actually watches from (spec.md §7;
  ticket 06 pt 1) — playlist-adds emit no rec signal, his watching from
  them is what does the real steering (honesty clause). Topped up to ~10
  unwatched items per `steer` seeding pass. Unlike the Someday playlist,
  **no id cache anywhere in run state** — resolved fresh by exact title
  every run (cheap: one paginated `playlists.list` call covers every topic
  at once, per `DroppedTopicCleanup.ts`'s `listMyPlaylists()` use). Deleted
  (via `Tools/DroppedTopicCleanup.ts`) when a topic leaves
  `USER/YouTubeIntent.yaml` — its remaining items are logged in the run
  report + `lastSteerDetail` BEFORE the delete, but never in
  `youtube_deletions` (these are Kaya-created artifacts, not Jm's data —
  spec.md §7.4).

## Out of scope (spec §1)

Measured steering-feedback loop (homepage-mix snapshots, media-metrics/TELOS
integration — v1 evaluation is the subjective check-in only); fresh-slate
controls (pause-history, bulk clears — item-level actions only);
scheduled/autonomous curation; platforms other than YouTube; likes and
subscriptions (identity-expressive — Jm's own clicks only); automated
watch-time.
