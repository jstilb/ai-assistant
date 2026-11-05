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

Slice-by-slice build notes (status, steer declare path, session guard, prune, wl, steer tools) are in `references/BuildStatus.md`. Read it when you change or extend a tool.

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

For the full prune runbook (session guard, collect, judge, per-item junk handling, abort, held items, reconcile, report, preview), read `Workflows/Prune.md` before you run `/youtube prune`. `bin/claude-browser` session only.

## wl runbook (`/youtube wl`)

For the full Watch Later runbook (session guard, collect, judge, someday and archive-only verdicts, abort, held items, fresh snapshot, reconcile, report, preview), read `Workflows/Wl.md` before you run `/youtube wl`. `bin/claude-browser` session only.

## steer runbook (seeding pass) (`/youtube steer`)

For the full seeding-pass runbook (session guard, per-topic playlist top-up, home-feed sweep, seeded searches, dropped-topic cleanup, abort, check-in, report, preview), read `Workflows/Steer.md` before you run the seeding pass. The declare path in Invocation needs no browser.

## Files, Data model, Out of scope

The file table, the data model (ledger, run state, snapshots, intent file) and the out-of-scope list (spec section 1) are in `references/FilesAndDataModel.md`. Read it when you change a tool or the stored data.

