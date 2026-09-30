---
name: RecallPlan
description: List and recall Claude Code plan-mode plans by readable name/date/excerpt instead of raw filenames. USE WHEN recall last plan, what plans did I write, list my plans, find a plan, resume a plan, show me plan X, which plan was that.
---

# RecallPlan

Claude Code's plan mode (`ExitPlanMode`) already persists every plan Jm approves as a
markdown file under `~/.claude/plans/*.md` — verified on disk 2026-07-04 (58+ files
spanning Feb-Jul 2026). No Kaya hook writes there; it is native Claude Code behavior, so
the persistence seam already exists. The gap this skill closes is **identifiability**:
filenames are auto-generated cryptic slugs (`create-a-plan-to-iridescent-treehouse.md`,
`rosy-blum.md`) with no title, date, or summary visible from a directory listing.

`Tools/RecallPlan.ts` derives a human title (first markdown `# H1`, or a title-cased
filename fallback) and a short excerpt for each plan, sorted newest-first, and lets a
session recall one by index, filename, or a substring of its name/title.

## Workflow Routing

| Trigger | Workflow |
|---------|----------|
| "recall my last plan", "what plans do I have", "list my plans" | `Workflows/Recall.md` |
| "show me plan #3", "resume the CalendarAssistant plan" | `Workflows/Recall.md` |

## Quick Reference

- **Plan store:** `~/.claude/plans/*.md` (native Claude Code plan-mode output — not a Kaya store)
- **List:** `bun Tools/RecallPlan.ts list [--limit N] [--json]` — default limit 10
- **Recall:** `bun Tools/RecallPlan.ts show <selector> [--lines N] [--json]` — selector is
  the 1-based index from `list`, an exact filename, or a substring of filename/title
- **Naming fix:** titles/excerpts are derived at read-time from file content — plan
  filenames on disk are left untouched (other docs, e.g. `plans/TEMPLATE-plan-prompt.md`,
  reference them by exact filename)
- **Excluded from listings:** `plans/TEMPLATE-plan-prompt.md` (a reusable prompt template,
  not a plan) and the `plans/Specs/` subdirectory (Kaya's spec pipeline, unrelated store)

## Examples

**Example 1: Recall the last plan for a new session**
```
User: "What was the last plan I wrote?"
→ Runs `bun Tools/RecallPlan.ts list --limit 5`
→ Shows index/date/title/excerpt for the 5 most recent plans
→ Jm picks one; runs `bun Tools/RecallPlan.ts show 1` and injects its path + excerpt
   into the session so work can resume from where it left off
```

**Example 2: Find a specific plan by topic**
```
User: "Find the plan about the CalendarAssistant overhaul"
→ Runs `bun Tools/RecallPlan.ts show calendarassistant` (substring match against
   filename/title)
→ If ambiguous (multiple matches), the tool lists the candidates with their index
   instead of guessing — Jm picks the exact one by index
```

**Example 3: Browse everything before deciding**
```
User: "List my last 20 plans"
→ Runs `bun Tools/RecallPlan.ts list --limit 20`
→ Returns readable title/date/excerpt per plan instead of raw slugs
```
