# Prune runbook (`/youtube prune`)

Moved out of `SKILL.md`. The binding rules in `SKILL.md` (Honesty clause, Session split, Preview rule, coded invariant, Pacing rules, AlertGate invocation, DPA backstop) apply to this runbook. "Above" in the text below means those `SKILL.md` sections.

## Prune runbook (`/youtube prune`)

`bin/claude-browser`-session-only. Full autonomy, log-after (spec.md §1
Standing charter, §6) — no kill-list preview, no per-item confirmation.

### 0. Session guard — first, every time

```sh
bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/SessionGuard.ts prune
```

Nonzero exit → **STOP.** The entire response is that command's stderr (the
pointer line) — do not attempt any browser action, do not read Rubric.md, do
not touch state or the ledger. Exit 0 → continue.

Generate the run id once, now: `run_id="prune-$(date -u +%Y%m%dT%H%M%SZ)"`
(sortable, human-legible, unique enough for one on-demand run).

### 1. Load context

- Read `Rubric.md` §History (and the shared-keeps section above it).
- Read current intent: run `Status.ts` (Invocation above) and take its
  Intent line — `IntentReader.ts` has no CLI of its own (import-only). No
  intent declared is not a blocker (judge on generic signal only, per
  Rubric.md).
- Note any previously-held history items from
  `Tools/RunStateReader.ts` (`state.held.history`) — this run re-judges them
  alongside fresh candidates rather than leaving them stuck forever.

### 2. Collect candidates — ticket-07's proven scrape mechanics, folded in

Navigate to `https://www.youtube.com/feed/history`. This is **read-only
extraction** exactly like ticket 07's snapshot runbook
(`.scratch/youtube-curation/assets/07-snapshot-runbook.md`) up through the
point of deciding what to prune — the mutating actions only start in step 4.

1. **Trusted scroll, not synthetic.** Lazy-load requires a real user
   gesture: JS-jump near the bottom + one real mouse-wheel scroll (the
   `computer` tool's scroll action) + a 4–6s wait, repeated per batch, until
   enough of the newest-first list is rendered to fill this run's batch
   (up to the ≤50 cap plus some slack for keeps/holds). Synthetic
   `scrollTo`/`End` never fires YouTube's continuation loader (spec.md §4
   gotcha 1 — confirmed live in ticket 07).
2. **Extract in-page**, never by returning raw hrefs/DOM text through the
   tool boundary. Selectors as of 2026-08 (spec.md §4; **current-best, drift
   expected** — adapt if the DOM has moved and record the adaptation in the
   run report, per §10's fail-loud-not-fail-silent rule): history items
   render as `yt-lockup-view-model` (no channel link rendered on this
   element — pull channel from the lockup's metadata row instead); day
   sections group under `ytd-item-section-renderer` with a `#title` header
   (ticket 07's grouping pattern — this is what gives you "recent vs. old"
   context per Rubric.md, since the rubric deliberately has no numeric
   cutoff). Build one JSON array per batch, same field shape as ticket 07's
   `history-sample-<date>.json` (`.scratch/youtube-curation/assets/`): `{
   day, video_id, title, channel, channel_url, progress_pct }` per item
   (extract `video_id` from the anchor's `?v=` param in-page — never hand a
   raw href back through the tool boundary).
3. **Clipboard exfil, the proven pattern:** call
   `navigator.clipboard.writeText(JSON.stringify(batch))` from an in-page
   handler wired to a **trusted click** — the extension's exfil guard
   `[BLOCKED]`s large/direct JS-tool return values, and a synthetic
   `writeText()` call outside a user-activation event is silently ignored by
   the browser itself. Trigger the click via the `computer` tool on
   **verified-inert coordinates** (header whitespace, never a thumbnail or
   title — an eyeballed click that lands on content once navigated into a
   video logs a spurious watch, the disclosed ticket-07 incident). Then read
   the clipboard from the Bash tool: `pbpaste`. Repeat per batch, appending
   to the working candidate list.
4. **Assert extracted count is sane** before proceeding — if a batch's
   extraction comes back empty or clearly truncated after a real scroll+wait,
   re-scroll and retry once; if it still fails, that's an anomaly for the
   report (§10), not a silent skip.

### 3. Judge each candidate — Rubric.md §History, item by item

For each candidate (newest-first, stop once you've reached the run's working
cap): apply Rubric.md's question — "would Jm want more of this recommended
right now?" — with current intent as context. `youtube_verdicts`
(YouTubeClassifier's table, readable via a local events.db query if useful)
is input-only, never the criterion. Classify each item as **keep**, **junk
(recent)**, **junk (old)**, or **hold (unsure)** — see Rubric.md for what
each means; there is no numeric threshold anywhere in this step, it's
read-and-reason per item.

- **keep** → no action, no ledger row. Move on.
- **hold** → no destructive action this run. Collect into a held-list for
  step 6 (`RunStateWriter.ts`).
- **junk (recent / old)** → queue for step 4, tagged with which action set
  applies (recent = all three actions; old = delete only).

Stop adding new junk items once the run's cap (≤50; **≤5 for first live
runs** — spec.md §6, §12) is reached; anything past the cap that would have
been judged stays as an untouched candidate for next run (not a hold — it
was simply never reached).

### 4. Per junk item: ledger row FIRST, confirmed, then the destructive click

This is the one coded invariant (spec.md §5) — **no write, no delete.**

```sh
bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/LedgerWriter.ts \
  --video-id <id> --surface history \
  --actions deleted,not-interested,dont-recommend \
  --reason "<one-line judgment, verbatim, no sensitive-marker vocabulary>" \
  --run-id "$run_id" \
  --title "<as rendered>" --channel "<as rendered>" --watched-at "<ISO date>"
```

`watched_at` is a DuckDB `TIMESTAMP` column — it needs an actual parseable
date, not the day-section label verbatim. Convert: "Today" → today's date;
"Yesterday" → today − 1 day; a dated header like "Aug 5" → that date in the
current year (or prior year if the resulting date would be in the future).
No time-of-day is ever rendered on the history page, so use midnight UTC
(`T00:00:00Z`) for all of them — the ledger's `watched_at` is a day-level
signal for "recent vs. old" review, not a precise timestamp; `created_at`
(stamped by LedgerWriter itself) is what's precise.

(For old-junk, `--actions deleted` only.) The CLI prints the confirmed row
(including the `created_at` it actually landed with) on success and exits
nonzero on ANY failure — lock contention, timeout, or a failed confirm-read.
**A nonzero exit here means: do not click anything for this item.** Treat it
as a per-item failure (see the try/catch note below), not a batch abort by
itself — but if it recurs across items (e.g. sustained lock contention),
that's an anomaly worth aborting the batch over and alerting on.

Only once the ledger write is confirmed:

1. **Assert-before-act.** Re-verify (via `find` or a fresh `read_page`) that
   the target item/menu-item is still present and is the SAME item you
   judged — YouTube's list can reflow between judgment and action. On
   mismatch: screenshot, **abort the whole batch** (not just this item —
   spec.md §10's unconditional rule), and alert via AlertGate (see below).
2. Open the item's overflow ("⋮") menu via a verified-inert coordinate
   click; locate "Not interested" and "Don't recommend channel" (recent
   junk only — **highest-drift surface**, spec.md §4: these buttons have
   intermittently gone missing since June 2026; if either is absent, record
   the adaptation in the run report and fall back to whatever the menu
   does offer — don't guess a selector). Click each with the same
   verified-inert-coordinate discipline (`find` first, click the found
   element, don't eyeball coordinates on a reflowing menu).
3. Then "Remove from Watch history" / equivalent delete action from the
   same or a fresh overflow menu.
4. **Verified-state-change counting only.** After the delete action,
   re-query (fresh extraction of that region of the list, or a `find` for
   the video's id) and confirm the item is actually gone. A non-throwing
   click is NOT a completed action — count it only once you've confirmed
   the state actually changed (the Instacart "26/26 added" false-success
   lesson, spec.md §10).
5. **Per-item try/catch:** a selector miss or an unexpected element state
   for THIS item is caught, logged as an anomaly for the report, and this
   item is skipped (it already has no orphaned ledger effect either way —
   the row was written whether or not the click below it succeeds, which is
   exactly why the row-then-click order is safe: a failed click just means
   an accurate archive entry for an item that stayed in Jm's real history).
   Move to the next item. **The one exception:** an assert-before-act
   mismatch (step 1 above) is never just "this item's problem" — it aborts
   the whole batch, unconditionally.
6. **Pacing:** a randomized 1.5–8s wait between every destructive action
   (not just between items — between each click within an item too),
   keeping the whole pass at single-digit actions/minute.

### 5. On abort or anomaly

Stop the batch immediately (no further destructive actions this run — items
already ledgered+actioned before the abort stay actioned; nothing rolls
back). Send the abort alert (see "AlertGate invocation" above) with a
one-line reason and how many items completed first. Continue to steps 6–7
using whatever counts/holds accumulated before the abort — the report must
still be produced.

### 6. Held items → RunStateWriter

```sh
bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/RunStateWriter.ts \
  '{"held":{"history":[{"videoId":"<id>","title":"<as rendered>","reason":"<one-line — why unsure>"}]}}'
```

Pass the FULL held-history list for this run in one call (it replaces
`held.history` wholesale; `held.watch_later` from a prior `wl` run is left
untouched — see RunStateWriter.ts's merge semantics). Then write `lastRun`
in a second call (or combine into one JSON blob):

```sh
bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/RunStateWriter.ts \
  '{"lastRun":{"mode":"prune","runId":"'"$run_id"'","at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","summary":"<N> deleted, <N> not-interested, <N> dont-recommend, <N> held"}}'
```

### 7. Reconcile, then report

```sh
bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/ReconcileRun.ts \
  --run-id "$run_id" \
  --claim history:deleted:<N> --claim history:not-interested:<N> --claim history:dont-recommend:<N>
```

Nonzero exit / `MISMATCH DETECTED` in the output means the report's claimed
counts don't match what's actually in the ledger — fix the report before
sending it, don't send a report you know is wrong. Then send the completion
ping (AlertGate, above).

**The run's final chat message** (spec.md §11 — full contents every run):
per-action counts (deleted / not-interested / dont-recommend); the held
list (video + one-line reason each, for bulk approval next run); any
anomalies/aborts with reason, and any selector adaptations made this run;
the intent-staleness lead line when `declared_at` > ~30d (reuse
`Status.ts`'s framing); the `ReconcileRun.ts` output verbatim (or its
`ALL MATCH`/`MISMATCH DETECTED` line at minimum). **No DPA line, ever**
(spec.md §9 amendment).

### Preview ("show me what prune would do")

Same Rubric.md §History judgment, but over **local data only**:
`events.db` history (if a prior run/ingest has landed any — there is
currently no local history table beyond `youtube_deletions` and
`youtube_verdicts`, so a preview is necessarily bounded by whatever's
already local) + `youtube_verdicts` + current intent. **Zero mutations** —
no `LedgerWriter`/`RunStateWriter` calls, no browser navigation, no API
calls. Banner the response with a staleness note (this is not a live
history read; it may not reflect what's on YouTube right now). This does
NOT require the session guard (no browser action happens), so it can run
anywhere.
