# steer runbook, seeding pass (`/youtube steer`)

Moved out of `SKILL.md`. The binding rules in `SKILL.md` (Honesty clause, Session split, Preview rule, coded invariant, Pacing rules, AlertGate invocation, DPA backstop) apply to this runbook. "Above" in the text below means those `SKILL.md` sections.

## steer runbook (seeding pass) (`/youtube steer`)

`bin/claude-browser`-session-only (spec.md §7's Seed phase; the declare
phase — parse→echo→confirm→write — runs anywhere and is documented under
Invocation above, not here). One pass, one report (spec.md §3). Full
autonomy, log-after — no per-item confirmation, no kill-list preview.

**No ledger rows anywhere in this runbook.** Playlist adds and home-feed
sweep clicks destroy nothing of Jm's (they're Kaya-created queue artifacts
or off-intent-tile suppressions, never a delete of watch history/WL) — the
one coded invariant (ledger-row-before-delete) simply doesn't apply here
because there is no delete of Jm's data to archive. `LedgerWriter.ts` and
`ReconcileRun.ts` are never called from this runbook. Every count in the
run report instead comes from **verified-state-change counting**
(spec.md §10) captured live during the pass: a playlist add counts only
after `PlaylistClient.ts`'s fresh re-read confirms it; a sweep action
counts only after a fresh re-query confirms the tile/menu state actually
changed.

### 0. Session guard — first, every time

```sh
bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/SessionGuard.ts steer
```

Nonzero exit → **STOP.** The entire response is that command's stderr (the
pointer line) — do not attempt any browser/API action, do not read
Rubric.md, do not touch state. Exit 0 → continue.

Generate the run id once, now: `run_id="steer-$(date -u +%Y%m%dT%H%M%SZ)"`.

### 1. Load context

- Read current intent: run `Status.ts` (Invocation above) and take its
  Intent line — `IntentReader.ts` has no CLI of its own (import-only). **No
  intent declared is a hard stop for this runbook** (unlike prune/wl, which
  can judge on generic signal alone): there is nothing to seed playlists
  for, no sweep-relevance basis, and no dropped-topic set to compute against
  an empty current-topics list. Tell Jm to declare intent first
  (`/youtube steer <what you want to see more of>`) and stop — do not
  attempt a "generic" seeding pass.
- Read `Rubric.md`'s shared-keeps section (music/rewatches/sensitive
  handling) — the home-feed sweep (step 3) applies the same judgment
  discipline to what NOT to touch, even though intent-relevance (not
  history-recency) is the sweep's primary lens here.
- Note the intent-staleness check: if `declared_at` is >~30 days old, the
  run's final report leads with that (reuse `Status.ts`'s framing) — the
  pass still executes (spec.md §7's declare-phase rule carries through to
  seeding).

### 2. Per-topic playlist top-up

For each topic in the declared intent, even treatment (spec.md §7 — no
per-topic prioritization):

1. **Source candidates:**
   ```sh
   bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/SeedSourcer.ts \
     --topic "<topic>" --intent-topics "<t1>,<t2>,..."
   ```
   Reads `Rubric.md` §Channel quality + §Seeding first (fail-loud if the
   headings are missing — before any quota spend), then one `search.list`
   call (100 units) + an already-watched `events.db` cross-ref +
   `videos.list` metadata incl. stats (1 unit) + per-unique-channel
   dossiers (`channels.list`, 1 unit per ≤50 ids; recent-upload titles via
   `playlistItems.list`, 1 unit/channel, degrade-to-empty) + an
   `inference({schema})` judgment against the full declared intent AND the
   embedded rubric text (not just this topic in isolation — the LLM sees
   all of Jm's topics as context, plus each channel's dossier; code never
   filters on any stat). Prints `{ topic, candidates, rejectedForQuality,
   searched, afterWatchedFilter }` — `candidates` is already ≤10,
   unwatched, and LLM-approved, in preference order; `rejectedForQuality`
   is the candidates the LLM passed over on channel-quality grounds with
   its one-line reasons (informational only — nothing consumes it except
   the run report, step 8). A zero-candidate result for a topic (search
   came back empty, or every result was already watched, or the LLM found
   nothing on-topic) is not an error — note it for the report and move to
   the next topic.
2. **Top up the topic's playlist:**
   ```sh
   bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/TopicPlaylistTopUp.ts \
     --topic "<topic>" --candidates '<the candidates[].videoId array from step 1, as JSON>'
   ```
   Idempotent: finds-or-creates `"Kaya: <topic>"` (`PlaylistClient.ts`'s
   generic `findPlaylistByTitle`/`createPlaylist`, reused unchanged), reads
   current contents, cross-references them against `events.db` for
   already-watched (the same check `SeedSourcer.ts` uses), and adds just
   enough of the candidate list — via `addAndVerifyPlaylistItem()`'s
   insert-then-verify (now with slice-6's bounded retry, spec.md §10) — to
   bring the playlist's **unwatched** count up to ~10. A candidate already
   in the playlist is skipped, never re-added. **Playlist adds emit no rec
   signal** (ticket 06 pt 1/3) — this is queue UX only; do not narrate it to
   Jm as "steering the algorithm," the honesty clause (top of this file)
   applies here specifically.
3. **Per-item add failures** (a verify-retry exhaustion, a transient API
   error) are caught inside `TopicPlaylistTopUp.ts` itself and returned in
   its `failed` array — record these as anomalies in the report; they do
   not abort the topic's remaining candidates or the pass.
4. **Pacing does not apply to this step** — API calls, not DOM clicks
   (spec.md §7's pacing rule is scoped to browser-driven actions; the home-
   feed sweep in step 3 below is where pacing binds).

### 3. Home-feed sweep (DOM, claude-in-chrome)

Navigate to `https://www.youtube.com/`. **Cap: ≤15 sweep actions/pass**
(spec.md §7.2) — a lower, separate cap from prune's/wl's ≤50; stop adding
new sweep actions once reached, note anything past the cap as untouched for
next run (not a hold — steer keeps no held-item state, see step 5).

1. For each visible home-feed tile, apply Rubric.md's shared-keeps section
   plus intent-relevance judgment: "is this tile off-intent junk, or does
   it belong (on-topic, or a legitimate keep like music/a deliberate
   rewatch)?" This is a DIFFERENT lens from prune's §History question
   (recency-weighted junk) — steer's sweep judges against the declared
   intent specifically, not general recommendability.
2. **Off-intent junk** → open the tile's overflow menu, click **'Not
   interested'** and **'Don't recommend channel'** (spec.md §4's
   highest-drift surface — these buttons have intermittently gone missing
   since June 2026; if either is absent on a given tile, record the
   adaptation in the run report and use whatever the menu does offer —
   never guess a selector, per §10's fail-loud rules).
3. **Assert-before-act, then verified-state-change counting** — identical
   discipline to the Prune/wl runbooks' step 4: re-verify the tile is still
   present and is the SAME tile before clicking (the feed can reflow); on a
   mismatch, screenshot, **abort the whole batch** (unconditional, §10,
   same as every other DOM pass in this skill) and alert via AlertGate (see
   below). After each click, re-query and confirm the tile's state actually
   changed (menu closed, tile suppressed/reduced, or an explicit
   confirmation) before counting the action — a non-throwing click is not a
   completed action.
4. **Per-tile try/catch:** a selector miss or unexpected element state for
   ONE tile is caught, logged as an anomaly, and that tile is skipped —
   move to the next. The one exception is the same as every other DOM pass:
   an assert-before-act mismatch is never just "this tile's problem," it
   aborts the whole sweep.
5. **Pacing:** randomized 1.5–8s between every destructive action (not just
   between tiles — between each click within a tile too), single-digit
   actions/minute (spec.md §4).
6. **No ledger row for any sweep action** — reiterated from this section's
   header: `LedgerWriter.ts` is never called here. The sweep's count is
   however many actions this step's verified-state-change counting
   confirmed, full stop.

### 4. Seeded searches (DOM, in-session)

1–2 searches per topic (spec.md §7.3; ticket 06 pt 3 — "weak-but-confirmed
signal"). For each topic, issue the topic string (or a close variant) into
YouTube's search box via a trusted click + type (never a synthetic
value-set — mirrors the trusted-interaction discipline spec.md §4 requires
elsewhere), let results render, then move on — **do not open/play any
result** (automated watching is a dead lever, honesty clause; opening a
video also risks a spurious watch, the ticket-07 disclosed incident that
motivated §4 gotcha 3's verified-inert-coordinates rule). Same 1.5–8s
pacing as the sweep. Count `searchesRun` as however many searches were
actually issued (a search box interaction failure for one topic is a
per-item anomaly, not a batch abort — searches carry no assert-before-act
destructive-click risk the way a sweep click does).

### 5. Dropped-topic cleanup — LAST, log-then-delete

```sh
bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/DroppedTopicCleanup.ts cleanup \
  --current-topics "<t1>,<t2>,..."
```

Runs last in the pass (spec.md §7.4) — after every topic still in the
current intent has had its chance to top up, this step finds every
`"Kaya: <topic>"` playlist (excluding `"Kaya: Someday"`, which is never a
cleanup candidate) whose topic is no longer declared, and removes it.
**Structural log-then-delete** (`DroppedTopicCleanup.ts`'s own header):
`enumerateDroppedTopicPlaylists()` (read-only — lists every dropped
playlist's remaining items) runs to completion for ALL dropped playlists
before `deleteDroppedTopicPlaylist()` issues its first DELETE call — the
CLI's `cleanup` subcommand composes both in that fixed order and cannot be
invoked in a way that skips the log half (see
`DroppedTopicCleanup.test.ts`'s call-order assertion). No approval
round-trip (ticket 06 pt 5 — "log-after autonomy"). **No
`youtube_deletions` ledger row for these deletes** — the items enumerated
here are the log; they go straight into the run report and `lastSteerDetail`
(step 6), never events.db (spec.md §5, §7.4: these are Kaya-created
artifacts, not Jm's data). A per-playlist delete failure is caught inside
`DroppedTopicCleanup.ts` itself (`deleted: false` in its result, with the
item log still intact) and does not stop cleanup of the remaining dropped
playlists — record it as an anomaly.

### 6. On abort or anomaly

A sweep abort (step 3's assert-before-act mismatch) stops the SWEEP
immediately — items already actioned before the abort stay actioned,
nothing rolls back (there's nothing to roll back to; no ledger writes
happened either way). Playlist top-up (step 2) and dropped-topic cleanup
(step 5) are unaffected by a sweep abort — they're separate API-only steps
with their own per-item try/catch, not gated on the sweep completing.
Send the abort alert via AlertGate, reusing the pattern documented under
"AlertGate invocation" above with `steer` substituted throughout
(`key: "youtube-steer-abort-$run_id"`). Continue to steps 7–8 using
whatever counts accumulated before the abort — the report must still be
produced.

### 7. Ask the subjective check-in, then write run state

Ask Jm directly in this pass's chat: **"has the homepage felt better?"**
(v1's only evaluation loop, ticket 06 pt 6 — there is no measured
homepage-mix/media-metrics feedback loop, that's permanently out of scope
for v1). Record whatever Jm answers verbatim as `subjectiveCheckIn`; if Jm
hasn't answered by the time this step runs (e.g. an unattended/scripted
invocation), write `null` — never fabricate an answer.

```sh
bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/RunStateWriter.ts \
  '{"lastSteerDetail":{"runId":"'"$run_id"'","at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","topics":[<SteerTopicResult objects from step 2, one per topic>],"sweepActionCount":<N>,"searchesRun":<N>,"droppedTopicCleanups":[<DroppedTopicCleanup.ts cleanup output from step 5>],"subjectiveCheckIn":"<Jm answer or null>"}}'
```

Then write the generic `lastRun` summary every mode writes (what
`Status.ts` renders):

```sh
bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/RunStateWriter.ts \
  '{"lastRun":{"mode":"steer","runId":"'"$run_id"'","at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","summary":"<N> topics topped up (<N> adds), <N> sweep actions, <N> searches, <N> dropped-topic cleanups"}}'
```

**No held-item state for steer** — unlike prune/wl, this runbook writes
nothing to `state.held.*`; there is no "unsure, hold for next run" verdict
anywhere in steer's flow (playlist top-up is deterministic given
SeedSourcer's candidates, the sweep's per-tile judgment is act-or-skip with
no third state, dropped-topic cleanup has no judgment step at all).

### 8. Report

**The run's final chat message** (spec.md §11 — full contents every run,
reusing whatever `Status.ts`'s staleness framing/AlertGate wiring slices
4/5 established, no second reporting path): per-topic playlist adds
(topic, created?, existing-unwatched count, adds this run); per-topic
channel-quality pass-overs (`SeedSourcer.ts`'s `rejectedForQuality` —
video, channel, and the LLM's one-line reason, verbatim — so Jm can see
WHY a channel was skipped, not just that it was); sweep action
count (with any per-tile anomalies/selector adaptations — the 'Not
interested'/'Don't recommend channel' menus are the highest-drift surface,
spec.md §4, adapt-if-drifted under the fail-loud rules and record what
adapted); searches run per topic; dropped-topic cleanups with their logged
items (topic, playlist title, the video ids that were in it, deleted?);
any aborts with reason and how much completed first; the intent-staleness
lead line when `declared_at` > ~30d; **the subjective check-in question and
Jm's answer** (steer-specific, spec.md §11); and the honesty-clause
reminder (top of this file) that Jm's own watching from these playlists,
not this pass, is what actually re-steers the homepage. **No DPA line,
ever** (spec.md §9 amendment). **No `ReconcileRun.ts` output** — unlike
prune/wl, there is no ledger to reconcile against (this section's header).

Then send the completion ping (AlertGate, per the pattern documented above,
`steer` substituted: `key: "youtube-steer-complete-$run_id"`, counts
phrased as `<N> topics topped up, <N> sweep actions, <N> searches, <N>
dropped-topic cleanups`).

### Preview ("show me what steer's seeding pass would do")

Same intent-relevance judgment, but over **local data only**: current
intent (`IntentReader.ts`) + `events.db`'s `youtube_history`
(already-watched cross-ref, same as `SeedSourcer.ts`'s live check) +
whatever the run-state's `lastSteerDetail` last recorded (a stale,
convenience-cache snapshot of playlist ids/counts, not a live API read).
**Zero mutations** — no `SeedSourcer`/`TopicPlaylistTopUp`/
`DroppedTopicCleanup`/`RunStateWriter` calls, no browser navigation, no API
calls (this means a preview CANNOT show live playlist unwatched-counts or a
live home-feed — it can only describe what topics exist and roughly what
happened last time). Banner the response accordingly (this is not a live
read; it may be stale). This does NOT require the session guard (no
browser/API action happens), so it can run anywhere.
