---
name: YouTubeCuration
description: On-demand curation for Jm's YouTube — prunes junk from watch history and Watch Later, and maintains per-topic intent playlists so recommendations stay intentional. Full spec of the prune/steer/wl modes and the archive ledger.
---

# YouTubeCuration

An on-demand Kaya capability that keeps Jm's YouTube recommendations intentional:

1. **Prune** — remove junk signals from watch history (recent-junk levers are ~88% effective — the classifier data is in `.scratch/youtube-curation/`), archive-before-delete.
2. **Steer** — maintain per-topic intent playlists Jm watches from (his real watching does the steering), plus Kaya-run second-tier levers: home-feed sweep + seeded searches.
3. **WL hygiene** — prune Watch Later back to a ~30-item intentional queue (prune-only; WL never receives automated adds).

Plus a read-only **status** view. Everything is invoked on demand; there is **no cron, no scheduled loop** — nothing in `daemon/cron/` for this skill, ever.

Full spec (assembled 2026-08-12, wayfinder ticket 11): `.scratch/youtube-curation/spec.md`. This SKILL.md restates the parts every future build/run must not silently drop; read the spec for anything not covered here.

## Honesty clause — bind this into every run's framing

**Kaya's levers suppress junk but cannot build new interests alone.** Homepage
shifts need tens of Jm's real watches over days — automated watching is a
dead lever (unverifiable, and YouTube discounts it). The product this skill
delivers is **a clean queue + suppressed junk, not a remote-controlled
algorithm.** Every run report should be honest about that ceiling, not imply
the algorithm was "fixed."

## Command surface

`/youtube prune | steer <prose intent> | wl | status` — explicit subcommands.
**Bare `/youtube` = `status`.**

## Session split — binding, no exceptions

- **`status`** and **`steer`'s declare→confirm→YAML step** run in **any**
  session — pure local reads/writes, no browser needed.
- **`prune`, `wl`, and `steer`'s seeding pass** (API + DOM work) are
  **`bin/claude-browser`-session-only** — they need claude-in-chrome driving
  Jm's real logged-in Chrome. Invoked from any other session, they must
  **fail loud and do nothing else**, printing exactly this one-line pointer
  (`<cmd>` is the actual subcommand invoked, e.g. `prune`, not literal text):
  `run /youtube <cmd> from the claude-browser session.`
- **No handoff machinery, ever.** Never auto-launch a terminal session — this
  is a banned landmine (see CLAUDE.md Security Rules: launching/relaunching
  GUI terminal apps from inside a session freezes that session's env and
  breaks persistence for every future interactive session).
- **Detection mechanism, WIRED (slice 4):** inside `bin/claude-browser`,
  `process.env.CLAUDE_CONFIG_DIR` points at the isolated
  `$HOME/.claude-browser-home` (or `$CLAUDE_BROWSER_HOME`) config dir;
  anywhere else it is unset or points at the default. `Tools/SessionGuard.ts`
  implements this check (confirmed by reading `bin/claude-browser`'s own
  `export CLAUDE_CONFIG_DIR="$BROWSER_HOME"` line): run
  `bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/SessionGuard.ts <cmd>`
  first in every DOM subcommand runbook — exit 0 means proceed, nonzero
  means STOP and print its stderr (the exact pointer line) as the whole
  response. `prune`'s and `wl`'s runbooks are wired this way now;
  `steer`'s seeding pass will wire it the same way when it lands.
- **Voice:** "clean up my YouTube" reaches Kaya through the existing
  CaptureGate — Router's classifier labels imperatives-to-Kaya
  `NOT_A_CAPTURE`. Not a capture; no LifeOS touch, no gate change needed here.
  Voice directly executes only non-browser work; any DOM pass gets the
  session pointer above instead of attempting to run.

## Preview rule — binding, no coded `--dry-run`

There is **no coded `--dry-run` flag anywhere in this skill, and there must
never be a parallel no-op code path for one to rot** (the job-reconciler
`--dry-run`-still-writes landmine is the anti-pattern this deliberately
avoids). Preview is conversational: "show me what wl would do" reruns the
same rubric over local canonical data only (events.db history + verdicts,
the last WL snapshot, `YouTubeIntent.yaml`).

**Bound rule: a preview request performs ZERO mutations** — no
events.db/state/ledger/log writes, no browser actions, no API calls — and
its output banners that the underlying data may be stale.

## The one coded invariant — binding for every future destructive-action slice

> **The ledger row is written and confirmed BEFORE the destructive click.
> No write, no delete.**

Both WL prune verdicts (`someday` and `archive-only`) write a row; `keep`
writes nothing. This is the **only** coded gate anywhere in this skill —
every junk/keep/someday judgment is rubric-guided LLM judgment (`Rubric.md`),
never a numeric threshold. Determinism earns its place exactly once here:
atomic archive-before-delete is a hard safety boundary, not a content
judgment.

**Implemented (slice 4): `Tools/LedgerWriter.ts`.** `writeLedgerRow()`
writes one row and re-reads it back by `run_id`+`video_id`+`surface` BEFORE
resolving — an INSERT that "succeeds" but doesn't show up on re-read throws
rather than reporting success. Append-only by construction: the module
exports exactly one write function, no update/delete path exists anywhere
in the file. Ensures the table exists via AppUsageTracker's real init path
(`Db.open()` + `db.initSchema()`) rather than a second copy of the DDL.
CLI: `bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/LedgerWriter.ts --video-id <id> --surface history|watch_later --actions deleted,not-interested,dont-recommend,someday-add,wl-removed[,...] --reason "<text>" --run-id <id> [--title <t>] [--channel <c>] [--watched-at <iso>] [--extra '{"k":"v"}'] [--db-path <path>]`
— prints the confirmed row as JSON on success, exits nonzero on any failure
(validation, lock contention, timeout, or a failed confirm-read). `--db-path`
is for tests/demos only (`CONFIG.dbPath` is hardcoded to the live events.db
and does not honor `KAYA_HOME`) — real prune runs always omit it.

## Pacing rules — binding for every future browser-driving slice

- Randomized 1.5–8s between destructive/DOM actions; single-digit
  actions/minute.
- **Assert-before-act:** verify the target element/state before every
  destructive click; on mismatch, screenshot + **abort the whole batch** — no
  selector guessing on destructive actions.
- **Verified-state-change counting:** an action counts ONLY on confirmed
  state change (item gone on re-query; playlist contains the video on API
  re-read) — never a non-throwing click (the Instacart "26/26 added"
  false-success lesson).
- Per-item try/catch: one bad selector kills one item — but **any**
  assert-before-act mismatch aborts the whole batch, unconditionally.
- Aborts and anomalies always alert via **AlertGate** (Telegram); every run's
  final chat message states what completed vs. not.

**AlertGate invocation — the exact hook, no wrapper.** AlertGate
(`lib/core/AlertGate.ts`) already exports a small, directly-callable async
function — `sendAlert(message, { key, tier, ... })` — so this skill adds NO
wrapper file around it (that would be needless: AlertGate's own API IS the
smallest hook). Call it inline via `bun -e` from any DOM runbook step,
`tier: "page"` for both cases spec.md §11 requires immediate Telegram for:

```sh
# Abort/anomaly (always) — call the moment a batch aborts or an anomaly is detected:
bun -e '
import { sendAlert } from "'"$HOME"'/.claude/lib/core/AlertGate.ts";
console.log(await sendAlert(
  "YouTube prune run <run_id>: aborted — <one-line reason, e.g. selector drift on Not-interested button> (<N> items completed before the abort)",
  { key: "youtube-prune-abort-<run_id>", tier: "page" },
));
'

# Completion ping (every run, one line, counts only — the full report stays in chat, never Telegram):
bun -e '
import { sendAlert } from "'"$HOME"'/.claude/lib/core/AlertGate.ts";
console.log(await sendAlert(
  "YouTube prune run <run_id> complete: <N> deleted, <N> not-interested, <N> dont-recommend, <N> held.",
  { key: "youtube-prune-complete-<run_id>", tier: "page" },
));
'
```

`sendAlert()` never throws (returns `'paged'|'spooled'|'logged'|'suppressed'|'dry-run'`
— log the result, don't gate on it). Substitute the real `run_id` into both
the message and the `key` (a distinct key per run so AlertGate's cooldown
never suppresses one run's abort because a previous run's abort recently
paged the same key). **`wl` runs reuse this exact same hook**, substituting
`wl` for `prune` throughout (`"YouTube wl run <run_id>: aborted — …"`,
`key: "youtube-wl-abort-<run_id>"` / `"youtube-wl-complete-<run_id>"`,
counts phrased as `<N> archived, <N> someday, <N> held`) — no separate
wrapper, no separate doc block; the wl runbook below just says "AlertGate,
per the pattern above" and shows the substituted counts.

## DPA / Takeout backstop — PERMANENTLY OUT OF SCOPE (build-time amendment)

**Google DPA is region-blocked for Jm's US account** (consent screen:
"feature isn't available in this country" — the gate is the Google Account
country field, VPN irrelevant; see memory
`project_appusage_google_dpa_ingest_mechanics`). Jm's decision (2026-08-12):
**no DPA code, no DPA display anywhere** — `status` shows no DPA/grant line,
and no future run report may add one without a fresh Jm decision. Ledger
rows + manual Takeout (the same inbox AppUsageTracker's `YouTubeIngest.ts`
already uses) are the **whole** archive story.

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

## Invocation

**Bare `/youtube` or `/youtube status`:**

```bash
bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/Status.ts
```

Renders: declared intent + a staleness lead line when `declared_at` is >~30
days old, Watch Later count from the last snapshot (with its capture date),
ledger totals per surface, held-for-review counts, and the last-run summary
from state. **Zero writes, zero browser/API calls — local reads only.**

**`/youtube steer <prose>` — declare path (runs anywhere, no browser, no
API):** two tools kept structurally separate so no single invocation can
both parse AND write:

1. **Parse:**
   `bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/IntentParser.ts "<prose>"`
   — free prose → `inference({schema})` → a topic list, printed as JSON.
   Extracts only affirmative interests ("more X"); negative/exclusion
   phrasing ("less Y") is dropped, never turned into a topic. **Writes
   nothing** — this tool has no filesystem write anywhere in it and no
   import of the write tool.
2. **Echo + wait:** Kaya echoes the parsed `topics` back to Jm in chat and
   waits for his confirmation (or a correction) before proceeding — the
   confirm-echo contract (spec.md §7). It's enforced structurally, not by a
   runtime check: there is no tool that both parses and writes.
3. **Write:**
   `bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/IntentWriter.ts "<topic one>" "<topic two>" ...`
   — takes only the CONFIRMED topics (never prose; no import of the
   inference seam), writes `USER/YouTubeIntent.yaml` with exactly `topics` +
   `declared_at` (ISO timestamp). **Replacement is total**: every write
   replaces the whole topic list — there is no merge/append path, so a new
   declaration always supersedes the prior one entirely. No in-file
   history (git history of the auto-committed repo is the archive).
4. **Confirm written state:** re-read the file via `IntentReader.ts`'s
   `readIntent()` and show Jm the now-current topics — the same reader
   `status` uses, so the write is confirmed through the exact path `status`
   will later read back, not by trusting the write call's return value alone.

The ~30-day staleness lead-line (already implemented in `Status.ts` —
`declared_at` older than ~30 days prints "intent is N weeks old — still
current?" ahead of the intent line) reads whatever `IntentWriter.ts` last
wrote, so a fresh `steer` declare always clears it.

**`/youtube prune`:** `bin/claude-browser`-session-only. Full runbook: see
"## Prune runbook" below.

**`/youtube wl`:** `bin/claude-browser`-session-only. Full runbook: see
"## wl runbook" below.

**`/youtube steer <prose>`'s seeding pass:** `bin/claude-browser`-session-only.
Full runbook: see "## steer runbook (seeding pass)" below.

USE WHEN (natural language triggers):
- Jm asks "what's my YouTube status", "how's my watch history looking",
  "what's my current YouTube intent"
- Jm says "clean up my YouTube", "prune my watch history" — runs the Prune
  runbook above IF the current session is `bin/claude-browser` (Session
  guard step 0 handles the "not in that session" case honestly)
- Jm says "prune watch later", "clean up watch later", "my WL is a mess" —
  runs the wl runbook below under the same session-guard condition
- Jm wants to declare or change intent: "I want to see more X on YouTube"
- Jm says "seed my YouTube playlists", "top up my [topic] playlist", "run
  the steer pass", "sweep my YouTube homepage" — runs the steer runbook
  (seeding pass) below under the same session-guard condition; a hard stop
  (not a session-guard failure) if no intent is declared yet — see the
  runbook's step 1

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
