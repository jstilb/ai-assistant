# Recall — list and select a past plan

Execution procedure for recalling a previously written Claude Code plan and injecting it
into the current session's context.

## Steps

1. **List recent plans.**
   ```bash
   bun ~/.claude/skills/Development/RecallPlan/Tools/RecallPlan.ts list --limit 10
   ```
   This prints, newest first: `#index  date  title` followed by the filename and a short
   excerpt. Default limit is 10 — pass `--limit N` if Jm asks for more or fewer.

2. **Present the list to Jm** exactly as returned (index, date, title, excerpt) so he can
   identify the plan he means without having to recall a cryptic filename.

3. **Resolve Jm's selection.** Once Jm names a plan — by its number (`#3`), part of its
   title ("the CalendarAssistant one"), or the filename — run:
   ```bash
   bun ~/.claude/skills/Development/RecallPlan/Tools/RecallPlan.ts show <selector>
   ```
   `<selector>` accepts: the 1-based index from step 1, an exact filename (with or
   without `.md`), or a case-insensitive substring against the filename or title.

   - If the tool reports **"Ambiguous selector"**, it lists the candidate matches with
     their index — relay those to Jm and ask him to pick by index. Do not guess.
   - If it reports **"No plan matched"**, re-run `list` with a higher `--limit` before
     concluding the plan doesn't exist — the default limit is 10 and older plans may be
     further back.

4. **Inject into context.** `show` prints the plan's path, date, title, and full content
   (or the first N lines with `--lines N`). Read the file at the returned path (or use the
   printed content directly) so the plan's content is now in the session's context, and
   confirm to Jm which plan was loaded (path + title) before continuing work on it.

## Notes

- This is a **read-only** recall tool — it never modifies files under `~/.claude/plans/`.
  Plan persistence itself is handled natively by Claude Code's plan mode (`ExitPlanMode`);
  this workflow only makes the existing files easier to find and load.
- Matching in step 3 is deterministic on purpose: picking the wrong plan would silently
  inject the wrong context into a session, so ambiguous input surfaces candidates rather
  than guessing.
