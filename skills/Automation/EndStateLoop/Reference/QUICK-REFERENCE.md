# EndStateLoop: quick reference

Moved from SKILL.md (PLAN-25). Each workflow step writes in full the command that it uses; this page is a short list.

Shell variables do not last between Bash calls, and zsh does not split `$B` into words. Set `T` in the same call and write `bun $T …`. `bun $T` and `bun $S` with no command print the full usage; `bun $S post --help` also prints what to write in each field.

```bash
T=$HOME/.claude/skills/Automation/EndStateLoop/Tools/Board.ts
S=$HOME/.claude/skills/Automation/EndStateLoop/Tools/Status.ts
bun $T show <board> [--json]         # shipped live changes (last 10 units), proven support line, stall, table; --json: nextUnit
bun $T validate <board>              # schema, ids, evidence paths; exit 1 when invalid
bun $T gate <board>                  # exit 5: two units with no move → re-plan (unit-open refuses too)
bun $T set-test <board> --row R --name N --kind known-answer --pass-rule "…" [--command C] [--rule-file F]
RUNLOCK_FIRST=1 ~/.claude/skills/Automation/EndStateLoop/Tools/runlock.sh <memory lock> <session name> <merge check…>   # only the merge check of a proven unit
~/.claude/skills/Automation/EndStateLoop/Tools/waitboard.sh <board> [cap s, default 3000]   # run_in_background: keeps a waiting session alive
bun $S show <board> [--last N] [--json]   # newest updates + feedback with no answer yet
bun $S post <board> --by NAME … --number "LABEL|NOW|BEFORE|BAR"   # a driver number per item (repeat); 2-3 in every post
bun $T unit-audit <board> --unit U<n> --result pass|fail --by NAME --note TEXT [--evidence p1,p2]   # claim audit result; fail revokes the move
bun ~/.claude/skills/Automation/EndStateLoop/Tools/ClaimAudit.ts next <board> [--since U<n>]   # prints the next merged unit with no audit, or "none"
bun ~/.claude/skills/Automation/EndStateLoop/Tools/ClaimAudit.ts run <board> --unit U<n> --by NAME [--results FILE]   # one fresh headless sonnet (plan mode) writes units/U<n>/AUDIT.md + unit-audit
python3 -I ~/.kaya/state/endstate-setup/page-lag.py [--wake]   # the watch's status-page lag check (untracked; Workflows/Watch.md)
```
