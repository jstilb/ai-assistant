# YouTubeCuration: what is built (through slice 6)

Moved out of `SKILL.md`. Per-slice build notes and tool inventory. Read it when you change or extend the tools.

## What's built so far (through slice 6)

- **`status`** (read-only, zero writes, zero browser/API calls) — this is
  what bare `/youtube` runs. See Invocation below.
- **`steer`'s declare path** (`/youtube steer <prose>`, the
  parse→confirm→YAML half only — no browser, no API, runs anywhere) — see
  Invocation below.
- **`Rubric.md`** — the judgment rubric: shared keeps (music, rewatches,
  sensitive/private handling), §Channel quality (2026-08-16 — the shared
  channel-trust lens, research-grounded farm/legit signals + false-positive
  warnings; all surfaces consult it, seeding applies it directly), §History
  (prune's judgment question, recent-vs-old action split, unsure→hold),
  §Watch Later (wl's keep/someday/archive-only judgment, the ~30-item
  calibration anchor, unsure→hold — ticket 08's policy, slice 5), and
  §Seeding (2026-08-16 — topic-fit + channel-trust, embedded verbatim into
  `SeedSourcer.ts`'s judgment prompt at run time).
- **`prune`** (`/youtube prune`, `bin/claude-browser`-session-only) — full
  runbook below. Deterministic tools this slice built to support it:
  `Tools/LedgerWriter.ts` (write-then-confirm ledger row — the one coded
  invariant), `Tools/RunStateWriter.ts` (held-items + last-run summary),
  `Tools/ReconcileRun.ts` (report-vs-ledger reconciliation), and
  `Tools/SessionGuard.ts` (the session check above). AlertGate wiring is
  direct `sendAlert()` calls, documented above — no wrapper file.
- **`wl`** (`/youtube wl`, `bin/claude-browser`-session-only, slice 5) —
  full runbook below. New tools this slice built:
  `Tools/PlaylistClient.ts` (the skill's ONE YouTube Data API seam —
  find/create/delete playlists, insert-and-verify playlist items; the
  Someday-playlist helpers are a thin wrapper over an otherwise generic
  surface slice 6 reuses unchanged) and `Tools/WlSnapshotWriter.ts` (writes
  a dated WL snapshot file in ticket-07's exact shape + updates the
  run-state `wlSnapshot` pointer). Reuses `LedgerWriter.ts`,
  `RunStateWriter.ts` (now also caching a `somedayPlaylist` pointer),
  `ReconcileRun.ts`, and `SessionGuard.ts` unchanged from slice 4.
- **`steer`'s seeding pass** (`/youtube steer`'s API+DOM half,
  `bin/claude-browser`-session-only, slice 6) — full runbook below. New
  tools this slice built: `Tools/SeedSourcer.ts` (per-topic candidate
  sourcing — `search.list` + `videos.list` + an already-watched
  `events.db` cross-ref + `inference({schema})` judgment against intent,
  capped at ≤10 unwatched candidates/topic; 2026-08-16 enrichment added
  run-time Rubric.md §Channel quality/§Seeding embedding, per-channel
  dossiers via `channels.list` + recent-upload titles, and the
  `rejectedForQuality` report field), `Tools/TopicPlaylistTopUp.ts`
  (idempotent per-topic `"Kaya: <topic>"` playlist top-up — find-or-create,
  count unwatched, add just enough to close the gap to ~10), and
  `Tools/DroppedTopicCleanup.ts` (structural log-then-delete: enumerates a
  dropped topic's playlist + remaining items BEFORE any delete call is
  possible — no `youtube_deletions` row, per spec.md §7.4, these are
  Kaya-created artifacts, not Jm's data). `Tools/PlaylistClient.ts` itself
  gained bounded verify-retry (3 attempts, ~8s backoff) inside
  `addAndVerifyPlaylistItem()` — `playlistItems.list` lags an insert by a
  few seconds, and the insert is never re-issued on a verify miss.
  `playlistItems.list` ALSO lags a just-completed `playlists.insert` (live,
  reproduced 2/2 2026-08-12/13: `TopicPlaylistTopUp.ts`'s find-or-create path
  created a fresh `"Kaya: <topic>"` playlist and immediately 404'd listing
  its items) — fixed with the same retry shape via
  `listPlaylistItemVideoIds()`'s opt-in `retryOn404` option, which
  `TopicPlaylistTopUp.ts` passes only on its own `created === true` branch so
  a 404 on an existing playlist still fails immediately.
  `Tools/RunStateReader.ts`/`RunStateWriter.ts` gained a `lastSteerDetail`
  field (per-topic adds, sweep count, searches run, dropped-topic cleanups
  with their logged items, the subjective check-in answer) alongside the
  generic `lastRun` summary every mode writes. Reuses `SessionGuard.ts`,
  `IntentReader.ts`, `RunStateReader.ts`'s `held`-item precedent is NOT
  used here (steer has no unsure-hold state — see the runbook), and the
  AlertGate hook documented above, `steer` substituted for `prune`/`wl`.
  **No `LedgerWriter.ts`/`ReconcileRun.ts` calls anywhere in this pass** —
  playlist adds and sweep clicks destroy nothing of Jm's, so there is
  nothing to archive (spec.md §7.4; the run report's counts come from
  verified-state-change tallies instead, per §10).
- **`youtube_deletions`** ledger table in events.db — DDL:
  `skills/Productivity/AppUsageTracker/db/schema.sql`; `LedgerWriter.ts` is
  the first thing that writes to it.
- Readers: intent, run state, ledger totals, last WL snapshot (see Files).
- **NOT yet built:** the `/youtube` command dispatch that routes
  subcommands to these tools (today each tool is invoked directly per the
  Invocation section below; a dispatcher is not required for the tools to
  work, only for command-surface ergonomics).
