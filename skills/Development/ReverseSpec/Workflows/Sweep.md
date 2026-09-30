# Sweep Workflow

Coverage-driven batch: pick the next subjects worth spec'ing, run `SpecSubject.md` once per
subject in parallel subagents, lint everything, refresh the index, commit. This is how the
"go through Kaya skill by skill, hook by hook, component by component" program advances.

**Input:** optional batch size (default 8), optional `--kind`, optional explicit subject list.
**Output:** N new/refreshed specs, lint-clean; `docs/specs/INDEX.md` refreshed; one commit.

## Step 1 — Inventory

```bash
T=skills/Development/ReverseSpec/Tools
bun $T/Inventory.ts list --missing            # never spec'd
bun $T/Inventory.ts list --stale              # subject changed since its spec
bun $T/Inventory.ts list --json > /tmp/rs-inventory.json
```

Report the coverage line (`N current · M stale · K missing · total`) before choosing.

## Step 2 — Choose the batch

Stale specs go first (a wrong map is worse than no map). Then missing subjects ranked by
leverage, highest first:

1. **Hooks** registered in `settings.json` (they run on every session — highest blast radius).
2. **lib/core components** with the most importers (`grep -rl "from .*<Name>" --include=*.ts | wc -l`).
3. **Skills** with a cron job or a Telegram/voice surface (they act unattended).
4. **Skills** by trigger breadth (longest USE WHEN clause), then remaining components,
   agents, bin scripts, categories last (categories are generated routing tables).

Within a tier prefer subjects whose neighbors were already spec'd — cross-spec findings need
both sides written. Skip anything over ~2,000 LOC unless the batch is dedicated to it (see the
split rule in `SpecSubject.md` Step 1).

Cap: 8 subjects per sweep unless Jm sets a different size. Resolve the agent model first:

```bash
bun lib/core/RateLimitGuard.ts --preferred sonnet
```

## Step 3 — Fan out

One subagent per subject, all launched in a single message so they run concurrently. Never
spec two subjects in one agent. The prompt for each:

```
You are running the ReverseSpec SpecSubject workflow for exactly one subject.
Subject: <subject path>
Repo root: <absolute path of the current checkout — a worktree if one is active>
Read and follow skills/Development/ReverseSpec/Workflows/SpecSubject.md and
skills/Development/ReverseSpec/Template.md verbatim. Do not modify the subject or any file
other than the spec at its canonical path. Run the subject's tests with an ABSOLUTE path and
quote the "Ran N" line. Run `bun skills/Development/ReverseSpec/Tools/SpecLint.ts <spec>`
until it exits 0. Set generated_by: ReverseSpec/<your agent name>. Reply with: spec path,
feature count, AC count (observed/inferred), Findings counts per subsection, the single most
important Contradiction, and any Open Question that blocked you.
```

Do not also spec subjects yourself while agents run. If an agent returns 0 tool uses or a
rate-limit message, re-run it on the fallback tier (RateLimitGuard) — never accept a blank.

## Step 4 — Gate

```bash
bun $T/SpecLint.ts --all
bun $T/Inventory.ts index
```

Every spec in the batch must be `OK` or `WARN` (no `FAIL`). For a `FAIL`, send the same agent
back with the lint output rather than patching it yourself — the agent has the context.
Spot-read one spec per kind against the quality-bar table in `Template.md`; if the Summary
needs Kaya internals to understand, it goes back.

## Step 5 — Commit and report

```bash
git add docs/specs
git commit -m "ReverseSpec sweep: <N> specs (<kinds>) — coverage <current>/<total>"
```

Report to Jm: the coverage line before/after, the batch table (subject → features / ACs /
findings), the top three Contradictions across the batch, and whether `CrossSpec.md` should run
(it should whenever a batch adds ≥5 specs or touches a neighbor of an existing spec).

## Cadence

A sweep is a standing item, not a one-off: the inventory makes the remaining work visible
(`INDEX.md` coverage line), and staleness re-opens subjects as they change. The natural
rhythm is one sweep per week alongside the AutoMaintenance weekly run, and a `CrossSpec`
pass after every second sweep. Until a cron exists, Jm or a session triggers it with
"spec sweep".
