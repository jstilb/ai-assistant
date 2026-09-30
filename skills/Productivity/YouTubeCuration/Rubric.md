# Rubric — `/youtube` curation judgment

The ONE home for every judgment call a `/youtube` run makes about an
individual item (spec.md §2; ticket 04 grilling, 2026-08-08). This is
**prose guidance Kaya applies with judgment while driving the browser** —
not deterministic code, not a scoring formula, not a numeric threshold
anywhere in this file. The one thing this skill DOES code deterministically
is the ledger write-then-confirm invariant (`Tools/LedgerWriter.ts`); every
verdict on an individual video is this rubric, read and reasoned about live,
never a coded gate.

`youtube_verdicts` (YouTubeClassifier's low-value/media-metrics table) is an
**input feature you may consult, never the criterion.** A video the
classifier flagged low-value can still be a keep here (background music is
low-value for focus metrics and a legitimate keep here); a video the
classifier never touched can still be junk here. The question this rubric
answers is different from the one that table answers: not "was this
low-value screen time" but "would Jm want more of this recommended right
now."

Current intent (`USER/YouTubeIntent.yaml`, declared via `/youtube steer`) is
**context for every judgment below**, not a filter applied after the fact.
If no intent has ever been declared, judge on generic signal only (rewatch,
music, one-off curiosity) and say so in the run report — don't invent an
intent to judge against.

## Shared keeps (apply on every surface)

- **Music / background audio — keep by default.** This is a legitimate
  taste signal even when it's low-value for focus metrics. If background
  music of one genre is flooding the homepage in a way that crowds out
  intent topics, that's a steering concern (`/youtube steer`'s
  suppress-channel lever) — not a reason to delete the listens themselves.
- **Deliberate rewatches — keep.** A rewatch is a strong genuine-taste
  signal, not junk. Use judgment on what counts as deliberate (a video
  watched fully more than once, a comfort-watch pattern) versus an
  accidental replay.
- **Social watches** — there's no dedicated detection for "watched with
  someone else." The general taste/intent-fit judgment below already covers
  these: if it's an outlier against everything else in the history/queue,
  treat it like any other outlier: on its own merits, not as a special
  category.
- **Sensitive / private items — prune aggressively, archive normally, never
  flag.** If an item looks personal/sensitive, prune it as readily as any
  other candidate the judgment below would prune (don't hold it out of
  extra caution, and don't keep it out of extra caution either — judge it
  like anything else). It still gets archived normally into the ledger
  (events.db is local and gitignored) — but:
  - **No special ledger flag.** Never mark, tag, or categorize a row as
    sensitive in any structured field.
  - **No sensitive-marker vocabulary in the `reason` text.** Write the
    `reason` the same way you would for any other item — describe what the
    video was/why it doesn't earn a place, not that it was sensitive or
    private. A `reason` that says "private" or "sensitive" makes the row
    MORE findable in the archive, which defeats the entire point of pruning
    it in the first place.

## §Channel quality — "does this channel earn trust to keep recommending from?"

A shared lens, not a surface of its own: §Seeding (below) applies it
directly when deciding whether a video earns a place in an intent playlist;
§History and §Watch Later judgments may consult it as one more piece of
context — the channel is never by itself the verdict on an item, which
still gets judged on its own merits per those sections' own questions.

The data behind this judgment — channel age, subscriber and upload counts,
channel description, a sample of recent upload titles, per-video
view/like/duration numbers — is handed to you as plain text. Read it
together the way a person skimming a channel page would. There is no
threshold to check off anywhere in this section, and no single signal below
is qualifying or disqualifying on its own. (Signal lists grounded in a
2026-08 web-research pass; sources logged in
`.scratch/youtube-curation/build-log.md`.)

**Content-farm / low-quality signals** (weigh together):
- Upload volume incoherent with the channel's age or audience — thousands
  of uploads on a young channel, or a multiple-videos-a-day pace no human
  creative process sustains.
- Recent titles that are near-identical templates with one swapped keyword,
  or that all chase the same viral premise back-to-back — centralized
  production, not a creator's evolving interests.
- Titles built on manufactured curiosity gaps — ALL CAPS, "You Won't
  Believe…", "GONE WRONG" — across most of the recent list, rather than
  describing what the video actually is.
- Views wildly out of proportion to likes across many videos — real
  audiences leave an engagement trace (likes typically land in the low
  single-digit percent of views; calibration context, not a cutoff).
- A boilerplate, keyword-stuffed, or absent channel description — no
  discernible person or point of view behind the output.
- A wall of near-identical-duration Shorts dominating recent uploads,
  paired with recycled premises — the classic Shorts-spam shape.
- Compilation/reaction/re-post framing at high frequency with no evident
  added commentary or curation — reuse for arbitrage, not for fans.

**Legitimate-creator signals:**
- A coherent niche and consistent voice across recent titles — the list
  reads like one person's ongoing interest, not a template engine.
- A cadence proportionate to apparent production effort, sustained over
  the channel's age.
- Titles that are specific and honest about content; a description that
  says who is speaking and why, in non-generic terms.
- Views and likes that move together plausibly, and view counts that make
  sense next to the subscriber base.

**False-positive warnings — where farm-shaped signals are innocent:**
- High-cadence news, sports-highlight, and live-event channels
  legitimately post many times a day; frequency alone convicts nothing.
- Faceless ≠ low-effort — narration-driven educational and animation
  channels are often excellent. Judge coherence and craft, not the
  presence of a host.
- Clip/compilation channels fans genuinely want exist —
  curated-with-care is different from wholesale re-upload arbitrage.
- Some genres (ambient/background music, ASMR, study streams) naturally
  run very low like-to-view ratios — passive consumption, not botting.
  This matters doubly here because music is a shared keep (above).
- A small, young channel with few uploads is unproven, not a farm — judge
  internal consistency; don't penalize smallness itself.

## §History — "would Jm want more of this recommended right now?"

Candidates are recent watch history, newest-first (`youtube.com/feed/history`
— recency dominates the recommender roughly 2x, and 'Not interested' is only
potent against recent behavior; spec.md §4, §6). Judge each item against the
question above, with current intent as context. Channel-level context
(§Channel quality, above) can inform this judgment too — the item is still
judged on its own merits.

**Prime target: one-off curiosity clicks.** Clickbait, drama, rabbit-hole
entries — the video someone clicked once out of curiosity and never intended
as an ongoing interest. These are the highest-value prunes (the ~88%
recent-junk lever ticket 03 measured). Recognize the pattern: a single watch,
no relation to anything else in the history or the declared intent, thumbnail
or title shaped like bait rather than a real interest.

**Recent vs. old is a matter of judgment, not a cutoff.** "Recent" means
still within the window that plausibly shaped what's showing up on the
homepage right now — days, not months — and it's read from context (where
the item sits in the newest-first list, how it compares to everything
around it), never a fixed day-count. There is no number to plug in here;
decide per item, per run.

- **Recent junk** → three actions together: **'Not interested' + 'Don't
  recommend channel' + delete.** Recent junk is where the suppression
  signal actually lands (03's finding); doing all three together is what
  makes the prune effective, not just tidy.
- **Old junk** → **delete only.** 'Not interested'/'Don't recommend' on
  something months old doesn't meaningfully suppress anything current — it's
  just noise on the algorithm's side. Delete it for the archive/cleanliness
  value and stop there.

**When you're not sure** — genuinely ambiguous, not just "this could go
either way but I lean junk" — hold it. Held items go into
`Tools/RunStateWriter.ts`'s state file and get listed in the run report for
Jm's bulk approval next run. This is itself a rubric-guided call, not a
coded gate: judgment decides what counts as "unsure," there's no confidence
number behind it.

**Cap: ≤50 deletions/run** (tunable; first live runs use ≤5 — spec.md §6,
§12). This is a pacing/blast-radius bound, not a judgment signal — reaching
the cap doesn't mean "these are junkier than the rest," it just means the
pass stops there and the remainder waits for next run.

## §Watch Later — "does this still earn a place in a short intentional queue?"

Candidates come from the Watch Later playlist (`youtube.com/playlist?list=WL`),
worked **oldest-first** — bottom of the list, where confidence is highest and
mistakes are cheapest (ticket 08 pt 4). Judge each item against the question
above. The target shape: **WL is only what Jm would realistically watch in
the next 2–3 weeks — roughly 30 items.** That number is a **calibration
anchor for judgment, not a quota to hit or a cutoff to enforce** — never count
down to it, never treat "we're above/below 30" as itself a verdict. It exists
so the question above has a concrete shape in mind: is this item plausible
viewing in the *near* future, or has it drifted into someday/never territory.

**What informs the judgment (none of it a mechanical gate):**
- **Age** — how long the item has sat in WL. An old add isn't automatically
  stale (some long-sit items are genuinely still wanted — a deep-dive video
  saved for a free weekend), but age is real signal: the longer something has
  sat unwatched, the more it's earned scrutiny.
- **Already-watched-per-Takeout** — `events.db`'s `youtube_history` table is
  queryable locally (read-only; the same DB the ledger lives in — mind the
  single-writer lock and timeout discipline §13 binds everywhere else in this
  skill). If the video shows up there, Jm has already watched it elsewhere and
  WL is just holding a stale placeholder — strong signal toward archive-only
  (or someday, if it's the kind of thing worth a deliberate rewatch — the
  shared-keeps rewatch judgment applies here too).
- **Abandoned resume bars** — a partial-progress indicator that's sat
  unchanged across multiple runs suggests Jm started it and moved on, not that
  he's mid-way through and coming back. A *fresh* partial-progress item (just
  started) is a different signal than one that's been sitting stale for
  months — judge the trajectory, not just the presence of a resume bar.
- **Current intent** (`USER/YouTubeIntent.yaml`) — context, same as
  everywhere else in this rubric. An item that matches a declared topic
  leans toward keep/someday; one that doesn't relate to anything currently
  declared leans toward archive, but absence of intent match is never itself
  the reason to prune — plenty of legitimate keeps (music, a rewatch, a
  standing curiosity) have nothing to do with declared topics.
- **Channel quality** (§Channel quality, above) — one more piece of
  context; never by itself the verdict on an item.

**No mechanical cutoffs anywhere in this section** — no "N days old = prune,"
no "below position K = safe." Read the item, read its context (age, watched
status, resume state, intent fit) together, and reason about whether it still
belongs in a short, honest, watchable-soon queue.

### Verdicts

- **keep** — stays in WL untouched. No action, no ledger row. This is the
  right call whenever the item is still plausible viewing in the next 2–3
  weeks, or is a shared-keep (music, deliberate rewatch) that belongs in the
  active queue on its own merits.
- **someday** — still genuinely wanted, just not realistic in the next 2–3
  weeks. Routes to the ONE Kaya-managed **Someday playlist** — an archive
  shelf distinct from `/youtube steer`'s per-topic intent playlists (those
  are the curated queue Jm actively watches from; Someday is where wanted-but-
  not-now items go so they aren't lost, without cluttering the active WL
  queue). Mechanics: Data API add to the Someday playlist, confirmed by a
  fresh API re-read (`Tools/PlaylistClient.ts`'s verify-contains — an add
  counts only on confirmed re-read, never a non-throwing insert call), THEN
  the ledger row (`actions: "someday-add,wl-removed"`), THEN the browser
  Remove from WL. The Someday add doesn't count against browser-action
  pacing caps — it's an API call, not a DOM click.
- **archive-only** — no longer earns a place and isn't worth holding
  anywhere else either. Ledger row (`actions: "wl-removed"`) then browser
  Remove. Still archived normally into the ledger (the row is the archive —
  WL has no export surface of its own, spec.md §9) — this is about queue
  membership, not about erasing the record of it having been watched/added.

**Unsure → hold, not prune.** Genuinely ambiguous items (not "could go either
way but I lean archive" — actually unsure) go into `Tools/RunStateWriter.ts`'s
`held.watch_later` list and get listed in the run report for Jm's bulk
approval next run, exactly like §History's hold pattern. WL never receives
automated adds (06) — hold is the only outcome that leaves an item untouched
without a keep verdict; there is no "kaya adds something to WL" path anywhere
in this skill.

**Cap: ≤50 prunes/run** (tunable; first live runs use ≤5 — spec.md §8, §12).
Same pacing/blast-radius framing as §History's cap: reaching it doesn't mean
"these are worse than what's left," it just means the pass stops there and
the remainder — an oldest-first list, so the highest-confidence remainder —
waits for next run. Backlog math (ticket 08): ~1,060 items over the ~30
target, ⇒ ~20 on-demand runs to steady state; no cron, on-demand only.

Shared keeps (music, deliberate rewatches, sensitive/private handling —
above) apply here exactly as they do in §History.

## §Seeding — "does this video, and its channel, earn a place in a Kaya: <topic> playlist?"

Candidates are unwatched search results for one declared intent topic
(`/youtube steer`'s seeding pass). `Tools/SeedSourcer.ts` embeds this
section and §Channel quality into its judgment prompt at run time — edit
the rubric and seeding behavior changes with no code change. Judge each
candidate on two lenses together:

- **Topic fit** — is this genuinely the declared interest, judged from
  title/description, not keyword-adjacent drift? The full declared intent
  list is context here the same way it is everywhere else in this rubric.
- **Channel trust** — §Channel quality, above. A substantive, on-topic
  video from a content-farm channel does not earn a place; a trustworthy
  channel's video still has to clear topic fit on its own.

Prefer substantive content over clickbait, but don't invent a taste
profile beyond what the topic states. When you pass over a candidate
specifically on channel-quality grounds, say why in one line — that
reasoning surfaces in the run report so Jm can see why a channel was
skipped, not just that it was. There is no numeric threshold anywhere in
this judgment.
