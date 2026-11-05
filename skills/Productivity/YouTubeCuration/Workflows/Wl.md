# wl runbook (`/youtube wl`)

Moved out of `SKILL.md`. The binding rules in `SKILL.md` (Honesty clause, Session split, Preview rule, coded invariant, Pacing rules, AlertGate invocation, DPA backstop) apply to this runbook. "Above" in the text below means those `SKILL.md` sections.

## wl runbook (`/youtube wl`)

`bin/claude-browser`-session-only. Full autonomy, log-after (spec.md §1
Standing charter, §8) — no kill-list preview, no per-item confirmation.
**Prune-only**: WL never receives automated adds (06) — nothing in this
runbook ever adds a video TO Watch Later, only removes.

### 0. Session guard — first, every time

```sh
bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/SessionGuard.ts wl
```

Nonzero exit → **STOP.** The entire response is that command's stderr (the
pointer line) — do not attempt any browser action, do not read Rubric.md, do
not touch state, the ledger, or the Data API. Exit 0 → continue.

Generate the run id once, now: `run_id="wl-$(date -u +%Y%m%dT%H%M%SZ)"`.

### 1. Load context

- Read `Rubric.md` §Watch Later (and the shared-keeps section above it).
- Read current intent: run `Status.ts` (Invocation above) and take its
  Intent line. No intent declared is not a blocker (judge on generic signal
  only, per Rubric.md).
- Note any previously-held watch_later items from `Tools/RunStateReader.ts`
  (`state.held.watch_later`) — this run's full-list extraction (step 2) will
  naturally re-encounter them wherever they sit, and they get re-judged
  alongside fresh candidates rather than left stuck forever (mirrors prune's
  step 1 for `held.history`).
- Note `state.wlSnapshot` (last capture date/count) and `state.somedayPlaylist`
  (a cached `{id, title}` — may be `null` on a first-ever `wl` run; resolved
  lazily in step 4, not here, so a run with zero someday verdicts makes zero
  playlist-lookup API calls).

### 2. Collect candidates — ticket-07's proven scrape mechanics, full list this time

Navigate to `https://www.youtube.com/playlist?list=WL`. This step extracts
**the entire WL list**, not just a working batch — a `wl` run always
produces a fresh, complete snapshot (step 8), and working **oldest-first**
(§8's ordering) means the working batch is defined by position from the
*bottom* of a list that can only be located by first reaching the true
bottom. This mirrors ticket-07's proven mechanics exactly (1,094 items in
~13.5 min — `.scratch/youtube-curation/assets/07-snapshot-runbook.md`), the
accepted cost behind the backlog math (~20 on-demand runs to steady state).

1. **Trusted scroll, not synthetic.** JS-jump near the bottom + one real
   mouse-wheel scroll (the `computer` tool's scroll action) + a 4–6s wait,
   repeated until the rendered item count stops growing (spec.md §4 gotcha
   1). Synthetic `scrollTo`/`End` never fires YouTube's continuation loader.
2. **Extract in-page**, selectors as of 2026-08 (spec.md §4, ticket-07's
   proven script — **current-best, drift expected**, adapt and record any
   adaptation in the run report): WL items render as
   `ytd-playlist-video-renderer`; per item pull `video_id` (from
   `a#video-title`'s `?v=` param), `title`, `channel` + `channel_url`
   (`ytd-channel-name a`), `duration` badge text, `progress_pct` (resume-bar
   width, null if absent) — the exact field set + extraction script ticket
   07 already proved live (`07-snapshot-runbook.md` §2). **Extend that
   script with one more field this run needs that ticket 07 didn't capture:
   a rendered relative-age string** ("3 years ago" — often shown alongside
   view count in the renderer's metadata row, e.g. via
   `#metadata-line`/`ytd-video-meta-block` text content) for the Rubric's
   age signal and the ledger's `extra.publishedAgo`. Treat it exactly like
   `duration`: badge/text if present, `null` if the DOM doesn't render it —
   never block on its absence (fail-loud-not-fail-silent, spec.md §10, same
   discipline ticket-07 applied to `duration`).
3. **Clipboard exfil, the proven pattern:** `navigator.clipboard.writeText`
   from an in-page handler wired to a trusted click on verified-inert
   coordinates, then `pbpaste` from Bash — identical to the Prune runbook's
   step 2.3 (see there for the full rationale); repeat per batch, appending
   to one full-list array, each item tagged with its 1-based `position`
   (top of list = 1; highest position number = oldest, i.e. this run's
   starting point).
4. **Assert extracted count == header count** (the "N videos" header text).
   On mismatch, re-scroll and retry twice; if it still mismatches, proceed
   with what was captured, note the discrepancy for the report AND write the
   eventual snapshot (step 8) with `complete: false` — never silently drop
   the gap (mirrors ticket-07's own §3 assert discipline exactly).

**Define this run's working batch** from the full extraction: the last
≤50 items by position (≤5 for first live runs — spec.md §8, §12), i.e.
`items.slice(-CAP)`, PLUS any item anywhere in the full list whose
`video_id` matches a previously-held `watch_later` entry (step 1) — those
are in scope for re-judgment this run regardless of where they sit.

### 3. Judge each candidate — Rubric.md §Watch Later, item by item

For each candidate in the working batch (oldest position first): apply
Rubric.md §Watch Later's question — "does this still earn a place in a
short intentional queue?" — informed by age, current intent, resume state,
and **already-watched-per-Takeout**: query `events.db`'s `youtube_history`
table (read-only; same single-writer-lock/timeout discipline as every other
events.db touch in this skill — reuse `LedgerReader.ts`'s `withTimeout`/
`openReadOnly` pattern, `SELECT 1 FROM youtube_history WHERE video_id = $id
LIMIT 1`) for each candidate. Classify **keep**, **someday**,
**archive-only**, or **hold (unsure)** — see Rubric.md for what each means;
no numeric threshold anywhere in this step.

- **keep** → no action, no ledger row, no browser action. Move on.
- **hold** → no destructive action this run. Collect into a held-list for
  step 7 (`RunStateWriter.ts`).
- **someday / archive-only** → queue for step 4/5 respectively.

Stop adding new someday/archive-only items once the run's cap (≤50; **≤5
for first live runs**) is reached; anything past the cap in the working
batch stays an untouched candidate for next run — remember the ordering
guarantee: the remainder is the highest-confidence (most-recently-added)
portion of what's left, since this run already consumed the oldest slice.

### 4. Someday verdict: API add + verify FIRST, then ledger row, then browser Remove

This ordering differs from archive-only/prune's "ledger row is always
first" shape because the someday path has an extra fact that must be TRUE
before the ledger row can honestly claim it happened: the Someday-playlist
add. The one coded invariant (ledger row confirmed **before the destructive
click**) still holds — the destructive click here is the browser Remove,
which still only happens after a confirmed ledger row.

1. **Resolve the Someday playlist, once per run, lazily** (only on the
   FIRST someday verdict this run — a run with zero someday items makes
   zero playlist-lookup calls):
   ```sh
   bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/PlaylistClient.ts ensure-someday \
     --cached-id "<state.somedayPlaylist.id, if present>"
   ```
   Immediately persist whatever id came back (whether `created: true` or
   `false` — cheap, idempotent, and means a crash mid-run still leaves the
   next run with a fast cache hit):
   ```sh
   bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/RunStateWriter.ts \
     '{"somedayPlaylist":{"id":"<id>","title":"Kaya: Someday"}}'
   ```
2. **Add + confirm, one call:**
   ```sh
   bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/PlaylistClient.ts add-verified \
     --playlist-id "<someday playlist id>" --video-id "<id>"
   ```
   This is `addAndVerifyPlaylistItem()` — insert, then a FRESH re-read
   confirming the video is actually in the playlist (never trusting the
   insert response alone, spec.md §10). Nonzero exit / thrown error → **this
   item's someday routing failed**: log it as a per-item anomaly for the
   report, do **not** write a ledger row for it (the row would have to claim
   `someday-add` happened, which would be false), do **not** click Remove
   (WL is untouched, which is the safe state), and move to the next
   candidate. Sustained failures here are an anomaly worth escalating to a
   batch abort, same threshold as prune's ledger-write-failure note.
3. **Ledger row, confirmed, only once the add is confirmed:**
   ```sh
   bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/LedgerWriter.ts \
     --video-id <id> --surface watch_later \
     --actions someday-add,wl-removed \
     --reason "<one-line judgment, verbatim, no sensitive-marker vocabulary>" \
     --run-id "$run_id" --title "<as rendered>" --channel "<as rendered>" \
     --extra '{"duration":"<badge text or null>","publishedAgo":"<relative-age text or null>","listPosition":<position>,"resumeFraction":<progress_pct/100 or null>}'
   ```
   **Never pass `--watched-at` for a WL row** — `LedgerWriter.ts` throws on
   that combination by construction (WL renders no added-dates, spec.md
   §5). A nonzero exit here means: do not click Remove for this item; treat
   as a per-item failure exactly like prune's step 4 (the WL item is still
   safely in WL AND now also safely in Someday — nothing is lost).
4. **Assert-before-act, then browser Remove, then verified-state-change
   counting** — identical discipline to the Prune runbook's step 4.1/4.4:
   re-verify the item is still present and is the SAME item before
   clicking `button[aria-label="Remove from Watch later"]`
   (current-best selector, spec.md §4 — adapt on drift, record the
   adaptation); on an assert-before-act mismatch, **abort the whole batch**
   (unconditional, §10); after the click, re-query and confirm the item is
   actually gone from WL before counting it.
5. **Pacing:** randomized 1.5–8s between destructive/DOM actions (the
   Someday API add does NOT count against this pacing budget — it's an API
   call, not a DOM click, per spec.md §8).

### 5. Archive-only verdict: ledger row, confirmed, then browser Remove

Simpler shape — no API step:

```sh
bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/LedgerWriter.ts \
  --video-id <id> --surface watch_later \
  --actions wl-removed \
  --reason "<one-line judgment, verbatim, no sensitive-marker vocabulary>" \
  --run-id "$run_id" --title "<as rendered>" --channel "<as rendered>" \
  --extra '{"duration":"<badge text or null>","publishedAgo":"<relative-age text or null>","listPosition":<position>,"resumeFraction":<progress_pct/100 or null>}'
```

Then the same assert-before-act → browser Remove → verified-state-change →
pacing discipline as step 4.4/4.5 above (and identical to the Prune
runbook's step 4). A nonzero ledger-write exit means: do not click Remove
for this item, treat as a per-item failure, move on.

### 6. On abort or anomaly

Stop the batch immediately (items already ledgered+actioned before the
abort stay actioned; nothing rolls back — a Someday add + ledger row with
no completed Remove yet is still a safe, honest state: the row says exactly
what happened). Send the abort alert via AlertGate, reusing the pattern
documented under "AlertGate invocation" above with `wl` substituted for
`prune` throughout (`key: "youtube-wl-abort-$run_id"`). Continue to steps
7–9 using whatever counts/holds accumulated before the abort.

### 7. Held items → RunStateWriter

```sh
bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/RunStateWriter.ts \
  '{"held":{"watch_later":[{"videoId":"<id>","title":"<as rendered>","reason":"<one-line — why unsure>"}]}}'
```

Pass the FULL held-watch_later list for this run in one call (it replaces
`held.watch_later` wholesale; `held.history` from a prior `prune` run is
left untouched — verified by `RunStateWriter.test.ts`'s reverse-merge case).
Then write `lastRun`:

```sh
bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/RunStateWriter.ts \
  '{"lastRun":{"mode":"wl","runId":"'"$run_id"'","at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","summary":"<N> archived, <N> someday, <N> held"}}'
```

### 8. Fresh WL snapshot

Re-scrolling the full list a second time (post-removal) to re-capture it
would double this run's wall-clock cost for no accuracy gain the snapshot
actually needs (it's a convenience count/date cache, not ground truth —
`RunStateReader.ts`'s doctrine). Instead, derive the post-run snapshot from
step 2's full extraction: drop every item whose `video_id` got a
**confirmed** Remove this run (someday or archive-only alike), keep
everyone else's fields as extracted. `header_count` becomes the original
header count minus this run's confirmed-removed count (or stays `null` if
the original header had none); `complete` carries forward step 2's own
assert result (a mismatch there means `false` here too — an accurate-count
edit doesn't turn an incomplete original capture into a complete one).

```sh
bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/WlSnapshotWriter.ts \
  '<post-run items JSON array>' --header-count <N> [--incomplete]
```

(Omit `--dir`/`--state-path` for a real run — those exist only for tests
and demos, matching every other tool's `--db-path`-style test-only override
pattern in this skill.) This call also updates the run-state `wlSnapshot`
pointer (`Tools/WlSnapshotWriter.ts` calls `writeRunState()` internally),
so `Status.ts`'s next read picks up the fresh count/date automatically.

### 9. Reconcile, then report

```sh
bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/ReconcileRun.ts \
  --run-id "$run_id" \
  --claim watch_later:wl-removed:<N_total_removed> --claim watch_later:someday-add:<N_someday>
```

(`N_total_removed` covers BOTH verdict types — every removed row carries
`wl-removed` whether or not it also carries `someday-add`, so the ledger's
comma-joined `actions` column naturally tallies both under one claim, per
`ReconcileRun.ts`'s own per-action splitting.) Nonzero exit /
`MISMATCH DETECTED` means fix the report before sending it. Then send the
completion ping (AlertGate, per the pattern above, `wl` substituted).

**The run's final chat message** (spec.md §11 — full contents every run):
counts (archived / someday / total pruned); the held list (video + one-line
reason each, for bulk approval next run); any anomalies/aborts with reason,
and any selector adaptations made this run (including the new
publishedAgo-field extraction, if it drifted); the fresh WL count + capture
date (from step 8); the intent-staleness lead line when `declared_at` >
~30d (reuse `Status.ts`'s framing); the `ReconcileRun.ts` output verbatim
(or its `ALL MATCH`/`MISMATCH DETECTED` line at minimum). **No DPA line,
ever** (spec.md §9 amendment).

### Preview ("show me what wl would do")

Same Rubric.md §Watch Later judgment, but over **local data only**: the
last WL snapshot (`SnapshotReader.ts` — state pointer if present, else the
ticket-07 fallback asset) + `events.db`'s `youtube_history` (already-watched
cross-ref) + current intent. **Zero mutations** — no `LedgerWriter`/
`RunStateWriter`/`PlaylistClient` calls, no browser navigation, no API
calls. Banner the response with the snapshot's own capture date (this is
not a live WL read; it may be stale, possibly by weeks). This does NOT
require the session guard (no browser action happens), so it can run
anywhere.
