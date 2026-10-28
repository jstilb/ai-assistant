---
name: Handoff
description: Move long work to a fresh session at 40-50% context — save the work, write a handoff file, start the next background session, then stop. USE WHEN handoff, hand off, context budget, ContextBudgetGuard note, continue in a new session, fresh session, session at 40 percent, context at 50 percent.
---

# Handoff

Sessions run on the 1M context window with compaction off. Quality drops long before the wall, so long work continues in a fresh session at 40-50% of the window. Jm (2026-10-27): "once it reaches 40% it should spawn a new session to continue work (this should be the norm)."

**Trigger:** the `ContextBudgetGuard` hook note (`hooks/ContextBudgetGuard.hook.ts`): one note at 400K tokens, then a note on every tool batch from 500K. Also run it when Jm asks for a handoff.

**Rule:** a session past 50% starts no new work. It runs the steps below, reports, and stops. If Jm is live in the session, the flow is the same: Jm opens the next session with `claude attach <name>`.

## Steps

1. **Reach a clean point.** Finish or revert the current edit. Leave tests in a known state: green, or red with the reason written in the handoff. If subagents still run, wait for their results; a result that arrives after this session stops is lost.

2. **Save the work.** In a worktree: commit, then `git push -u origin <branch>` if the repo has a remote. Do not merge unless the task already reached its merge step (Kaya: `bin/merge-to-main.sh`). Stop any dev servers this session started.

3. **Write the handoff file** with the template below. Write it for a reader with no context: absolute paths, branch names, exact commands.
   - If the project already keeps one (example: Intake `tracker/HANDOFF.md`), update that file and commit it.
   - Otherwise write `~/.kaya/handoffs/<YYYY-MM-DD>-<name>.md`. That folder is outside every repo, so a worktree cleanup cannot delete it.

4. **Start the next session** from the directory where the work lives (the worktree, or the project root):

   ```bash
   ~/.claude/bin/claude-handoff-spawn.sh <name>-<n+1> <handoff-file> <workdir>
   ```

   - The script drops this session's nesting vars and keeps the auth vars, then runs `claude --bg -n <name>-<n+1>` with a prompt that points at the handoff file.
   - Name the chain `<name>-2`, `<name>-3`, … so `claude agents` shows the order.
   - The new session gets the same settings (1M model, same hooks), so it hands off again at 40%.

5. **Check the start.** `claude agents` lists the new session, and `claude logs <id>` shows that it read the handoff. If it did not start, tell Jm with the error. Do not retry more than once.

6. **Release the worktree.** If this session entered a worktree, call `ExitWorktree` with `action: "keep"`. Then a later `claude rm` of this session cannot delete the worktree that the next session works in.

7. **Report and stop.** Give Jm the handoff file path, the branch or PR, the new session name and id, and the command `claude attach <id>`. Then stop.

## Handoff template

```markdown
# Handoff: <name> (session <n> → <n+1>), <YYYY-MM-DD HH:MM>

## Task
What Jm asked, in Jm's words, and the source (LucidTasks id, spec path, PR, conversation).

## Done when
The finish line and how to verify it.

## State
Worktree: <absolute path> · Branch: <branch> · PR: <url or none>
| Unit | Status | Evidence (file:line, test output, commit) |

## In progress
What was in flight and exactly where it stopped.

## Next steps
1. Ordered, concrete steps with commands.

## Open decisions
What waits on Jm, and any default taken with the reason.

## Rules
Jm's working rules for this task: scope limits, merge/push rules, things not to touch.

## Lessons
Traps hit and approaches that failed (with the reason), so the next session does not retry them.
```

## When you are the next session

1. Read the handoff file first.
2. If the handoff names a worktree and your cwd is not that worktree, call `EnterWorktree` with its `path`.
3. Check the state before new work: `git log --oneline -5`, `git status`, and the tests the handoff names. If the state differs from the handoff, trust the repo and note the difference.
4. Continue from **Next steps**. Keep the same rules. At the next guard note, run this skill again with `<n+1>`.
