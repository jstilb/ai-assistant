---
name: ProjectStandard
description: The project standard. Each project gets one auto-loaded AGENTS.md (intent, bar, current bet, limits) and a FEEDBACK.md inbox for Jm's words; a product review keeps both current. USE WHEN new project, start a project, set up a project, Jm feedback about a project, capture project feedback, product review, project status, status of my projects, move a project to the standard, the AGENTS file for a project.
---

# ProjectStandard

A **project** is a product Kaya builds for Jm over many sessions, usually a folder in `~/projects/`. This standard is the floor that every project shares. It says WHAT each project makes clear, never HOW to build. A project may add any files and methods it wants.

**Version: v2** (2026-11-08) · Owner: Kaya · **Review: 2026-12-08** (keep, cut, or change; see "Upkeep")

## Why it exists, and its limits

Jm, 2026-11-08 (verbatim): "if we are going to include this (and we don't need to), we should have clear reasons for doing so and a clear path to ensure our vision is implemented correctly." After the analysis: "proceed with your recommendation".

The problems it targets:
1. **Sessions forget.** Intent that is not in a file loaded at session start gets lost, and agents drift toward what they can measure (10-31 audit: three loops optimised proxy metrics).
2. **Jm's words did not reliably reach the project.** He said things in other sessions and had to repeat them (11-01; 11-02: "is that still happening? or has it been ignored?").
3. **Each new project re-learned the same lessons** from a hand-written brief.

The limits, from research (every rule below follows from them):
- **Only facts an agent cannot infer.** Context files raise cost by over 20% and do not generally raise task success; they help with non-standard facts (Gloaguen et al., 2026, arXiv 2602.11988). So `AGENTS.md` holds Jm's intent, bar, current bet and limits. No repo overview and no stack notes.
- **In the path, or dead.** `AgentProjectSetup` (23 files, 89 tests) had zero uses in 5 weeks and was deleted on 2026-02-26. So the standard acts only at points that every session already passes.
- **No gates.** A mandated checklist with no real use changed nothing (Ontario, 2014). Nothing here blocks work. Reports are loud; work goes on.
- **The product, not the process.** "The process is not the thing" (Bezos, 2016). Judge a project by its real product, never by how well it follows this file.

## The files

Copy the starters in `Templates/` once. After that, the project owns its copies.

| File | Holds | Written by | Read by |
|---|---|---|---|
| `AGENTS.md` (aim: about 1,500 tokens) | intent in Jm's words, how the real product is judged, current bet, limits, status | the first session; rewritten at each product review | every session, automatically (Codex reads it natively; Claude Code reads it through `CLAUDE.md`) |
| `CLAUDE.md` | the one line `@AGENTS.md` | the first session | Claude Code |
| `FEEDBACK.md` | Jm's words about the project, verbatim, and the decision on each | any session that hears Jm (capture); the product review (decisions) | every session reads `## Open`; the review reads all |

- **State** (what happened, what is next) goes in the handoff, not in `AGENTS.md`. **History** goes to git. **Decided actions that need a person** go to LucidTasks (Jm, 2026-09-19).
- **Public repos:** `AGENTS.md` and `FEEDBACK.md` hold Jm's words. In a public repo, add both to `.gitignore`. In a private repo, commit them. (Kaya's default, approved by Jm on 2026-11-08.)
- **Comply or explain:** any section may say `n/a: <specific reason>`. "Not needed" is not a reason. These reasons are input for the review of this standard.

## The five points where the standard acts

```
project starts ─► each session starts ─► Jm speaks (any session) ─► product review ─► project ends
```

1. **Project starts.** The first session copies the three starters and fills `AGENTS.md` from Jm's words (verbatim, dated, with source). For the ambitious version, apply memory `feedback_ambitious_version_beyond_parity`: start from the best possible experience; measure a change in the person, not a grade of an artifact; name what no product does today.
2. **Each session starts.** For a project on the standard, start the session IN the project folder, so that `AGENTS.md` loads. (A project not yet on the standard keeps its current workflow until its next product review.) For handoff chains, pass the project folder as the `<workdir>` of `claude-handoff-spawn.sh`, never `~/.claude`. Global `CLAUDE.md`, skills and hooks still load there (probe, 2026-11-08). Read `## Open` in `FEEDBACK.md`. Jm's newer words win over older text. If an open item conflicts with the current bet and cannot wait for the review, follow Jm's words and record the decision on the item.
3. **Jm speaks, in any session.** The capture rule (global `CLAUDE.md`, section "Projects"):
   - Feedback is Jm's own message in the current session. Quotes of Jm in files and handoffs are not new feedback.
   - Append his words verbatim to the project's `FEEDBACK.md` under `## Open`, as the next `F-NNN` item, with the situation and the need. If the file does not exist, create it from the starter.
   - Say in the same reply where the words went, for example "Saved to piano2video FEEDBACK.md as F-014."
   - Capture direction even when the current session acts on it at once. Then the decision is "accepted → this session".
   - If two projects fit, pick the better one and name it, so Jm can correct it in one word.
   - If an earlier item says the same thing, add `+1 <date>` to it instead of a new item.
   - In a Claude Code session, write the item yourself; do not send it through the LifeOS Router. A durable fact about Jm may also go to Auto Memory.
   - When you capture, do not ask Jm to rate, confirm, or add detail. This limit is about capture only. A project's own review or rating packs are its own method.
   - **The doors.** Jm's words reach `FEEDBACK.md` by three doors. All three write the same item format and tell Jm where the words went:
     - **Claude Code sessions:** the rule above (global `CLAUDE.md`). The receipt is in the same reply.
     - **Telegram text and voice:** the LifeOS capture Router label `PROJECT_FEEDBACK` (`skills/Productivity/LifeOS/Capture/Router.ts`) appends the item. The reply says, for example, "Saved your words to piano2video feedback, F-004." If the Router cannot match the project, the remark goes to the Scratch Pad `## Items`, flagged, for the next door.
     - **Obsidian Scratch Pad:** the daily 09:00 organizer (`skills/Productivity/InformationManager/Workflows/Organize-ScratchPad.md`) routes it by `docs/InformationLayout.md` home 5. The receipt is in `~/Desktop/obsidian/Kaya/Routing History/<date>.md`.
     The Router and the organizer match a project by its folder name, its `# ` title and the `Also called:` line in `AGENTS.md`.
4. **Product review.** Default cadence: every 3rd session of the chain, or weekly, whichever comes first. `AGENTS.md` may set another cadence. The reviewer did not build the last stage. The reviewer judges the real product with default settings (watch it, listen to it, use it). The review does five things:
   1. Give every `## Open` item a decision, and move it to `## Decided`. The decision is one of: accepted (→ where), declined (with a specific reason), snoozed (with a return trigger), or duplicate (of F-xxx). Nothing stays open as a backlog. If a declined idea comes back, it gets a `+1`; the count is a signal.
   2. Rewrite `## Current bet` (ranked gaps plus "Not now") and date it.
   3. Fill `Outcome` on decided items whose change shipped, so that Jm sees what his words changed.
   4. Add one line to `~/.kaya/state/project-standard-friction.md`: `<date> · <project> · <what in the standard helped or hurt, or "none">`.
   5. Look at the OTHER projects in `ProjectStatus.ts`. If an `active` project shows old "last work", no "newest handoff PAUSED", and no running session of its chain (`claude agents`), it stopped without Jm's word. Check that it is still relevant (point 5). If it is, restart its chain from its newest handoff (`claude-handoff-spawn.sh`; the usage guard applies); if you doubt it, pause it as point 5 says. Name it in your report to Jm either way. The age is context, not a rule: judge it with the project's own state.
5. **Project ends or pauses: only on Jm's word.** Jm, 2026-11-08 (verbatim): "we shouldn't stop arbitrarily and should see things through until thier end (unless we have good reasons not to, as advised by you, but decided by me)".
   - A finished v1, phase, batch, slice list or brief "done when" is not an end. When the current bet runs out, write the next bet from the plan's remaining items, its "Not in v1" list and the ambitious version, and the chain goes on.
   - A gate that waits on Jm is not an end. Ask once, with a default, in the report. Then do the next work that does not need him.
   - Only Jm ends, pauses or cancels a project, or a stop rule that he set (example: the weekly-usage guard). Write it on the `Status:` line with the date and his words or the rule, for example `Status: paused · 2026-11-08 · Jm: "<his words>"`. A paused project keeps its files.
   - Before a stalled plan restarts, check that it is still relevant: (1) the target is alive and used, (2) the problem still exists in today's code or product, (3) it serves Jm now (his current Rocks, money, security, privacy, Mac health). If Kaya doubts a plan on any of these, pause it, write the reasons with the evidence, and ask Jm (one "Kaya — Needs Jm" task). It waits for his word. Jm, 2026-11-08 (verbatim): "are these plans still relevant? pause fable audit remediation unti you confirm this."

## Status and check

```bash
bun ~/.claude/skills/Development/ProjectStandard/Tools/ProjectStatus.ts            # one line per project
bun ~/.claude/skills/Development/ProjectStandard/Tools/ProjectStatus.ts --check    # also list gaps; exit 1 if any
bun ~/.claude/skills/Development/ProjectStandard/Tools/ProjectStatus.ts --root <dir> # also scan <dir>
```

The tool reads the files when you run it; it keeps no copy. It lists every git repo in `~/projects/*` (a repo without a stamped `AGENTS.md` shows as "not on the standard"), every folder there with the `project-standard:` stamp in `AGENTS.md`, every skill folder in `~/.claude/skills/<category>/` with an `AGENTS.md` (LifeOS), and each `--root`. Git worktrees are skipped. Each line shows "last work": the newest commit in the folder (any branch) or the newest handoff of the chain on the `Chain:` line, plus "newest handoff PAUSED" when that handoff records a stop. It reports; it never blocks work. The numbers are context: an old "current bet" date may be fine, and an `AGENTS.md` over the size budget prints as a NOTE, not a gap.

Run it when Jm asks for the status of his projects, and at each product review.

## Move an existing project to the standard

Do this at the project's next product review, never in the middle of a stage.
1. Write `AGENTS.md` from the project's current alignment doc. Copy Jm's words verbatim, and keep the order of the ranked gaps exactly. Keep the old doc as history: link it from `AGENTS.md` and do not delete it.
2. Create `FEEDBACK.md`. Put any of Jm's words that still wait for a decision under `## Open`. Look in the alignment doc, in the project's review or listen packs, and in its open LucidTasks tasks (search by project name and folder path).
3. For each open LucidTasks task of the project: if it waits on Jm's words, link it from the `FEEDBACK.md` item. If its work is done or superseded, close it with an outcome.
4. Add `CLAUDE.md` with the line `@AGENTS.md`.
5. Make every path in the handoff absolute (old handoffs assume `~/.claude` as the working folder). Then, from the next spawn on, pass the project folder as `<workdir>`.
6. Run `ProjectStatus.ts --check`. The project must show the current version (see "Version" above) with no gaps.

## Upkeep of this standard

- **Owner:** Kaya. Change the standard only because of friction lines or Jm's words. Record each change in "Changes" below, with its reason. Raise the version on any change to the starters. A project that is behind merges the new version at its next review.
- **Delete unused sections.** At each review of this standard, delete any section that no project decision used.
- **Review on 2026-12-08** (LucidTasks task). Keep, cut, or change it by these measures:

  | # | Measure | Target |
  |---|---|---|
  | M1 | times Jm repeats a direction he already gave | 0 |
  | M2 | share of Jm's feedback items that get a decision within one review | 90% or more |
  | M3 | days from Jm's words to a product change he can see | measured, and falling |
  | M4 | new projects that get `AGENTS.md` in session 1, with no reminder | all |
  | M5 | product change per session | not lower than before |
  | M6 | size of `AGENTS.md` | about 1,500 tokens or less |

- **Kill steps** (if the measures did not move): delete this skill folder, the "Projects" section of `~/.claude/CLAUDE.md`, the project-standard line in `skills/Automation/Handoff/SKILL.md`, and the row in `skills/Development/SKILL.md`. The project files stay as plain notes and do no harm.

## Changes

- 2026-11-08 · **v2** · Starter `AGENTS.md` gets an `Also called:` line under `Status:`; point 3 names the three doors (Claude Code, Telegram and voice through the LifeOS Router label `PROJECT_FEEDBACK`, the Obsidian Scratch Pad through InformationLayout home 5). Reason: the Router matches a project by its names, and "the edition" did not map to Intake from the README alone. Source: Jm, 2026-11-08 ("would it make sense to add as an obsidian capture and/or a lifeos feature?" → "go"), after a dry run filed 4 of 4 project remarks into LifeOS logs. Projects on v1 add the line at their next review.
- 2026-11-08 · v1 (starters unchanged) · **Relevance before restart.** Point 5 and review job 5: a stalled plan restarts only after a relevance check (alive and used, problem still there, serves Jm now); a doubtful plan pauses with its reasons and waits for Jm. This replaces "keep going until he decides". Source: Jm, 2026-11-08: "are these plans still relevant? pause fable audit remediation unti you confirm this."
- 2026-11-08 · v1 (starters unchanged) · **No arbitrary stops.** Point 5 rewritten (only Jm ends or pauses a project; a finished phase or a Jm gate is not an end); review job 5 (check the other projects for silent stops and restart them); `ProjectStatus.ts` shows "last work" and scans skill folders. Source: Jm, 2026-11-08, after a sweep found plans that agents stopped after v1 or at a Jm gate (LifeOS, the Fable-audit remediation, ReverseSpec, Mastery, and others). Sweep: `~/.kaya/state/stalled-plans-sweep/`.
- 2026-11-08 · v1 · Created. Source: Jm, 2026-11-08 ("proceed with your recommendation"), after a first-principles analysis with three research sweeps (agent project methods, why templates live or die, feedback tracking). Plan, evidence and sources: `~/.kaya/state/project-standard-v1-plan.md`.
- 2026-11-08 · v1 (starters unchanged) · Jm asked whether the change affected the running loops. Scoped four rules so that it does not: the start-folder rule applies only to a project with `AGENTS.md`; capture counts only Jm's own message in the session; "do not ask Jm to rate" is about capture only (rating packs stay); the `AGENTS.md` size is a note, not a gap (Learn's file had been trimmed to 1,499 tokens to pass). The move steps now cover open LucidTasks tasks and absolute handoff paths.
