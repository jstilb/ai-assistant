# STARTLOOP Workflow

Start a new Ralph Loop for autonomous iteration.

## Prerequisites

1. **Clear spec exists** - Either ISC row, spec file, or detailed requirements
2. **Success criteria defined** - Measurable completion promise
3. **Tests/validation available** - Backpressure mechanism in place

## Steps

### Step 1: Validate Requirements

Before starting, confirm:

```
[ ] Task has clear success criteria (not vague)
[ ] Tests exist or will be created as part of loop
[ ] Iteration limit is appropriate (10-20 default, 50+ for large tasks)
[ ] Environment is sandboxed if using --dangerously-skip-permissions
```

### Step 2: Create Loop Configuration

Determine parameters:

| Parameter | How to Determine |
|-----------|------------------|
| `prompt` | ISC row description OR detailed task spec |
| `completion-promise` | ISC verification criteria OR "All tests pass" |
| `max-iterations` | 10 for small, 20 for medium, 50+ for large |
| `isc-row` | If triggered from THEALGORITHM, include row ID |

### Step 3: Initialize Ralph Loop

```bash
bun run ~/.claude/skills/THEALGORITHM/Tools/RalphLoopExecutor.ts \
  --prompt "YOUR_PROMPT_HERE" \
  --completion-promise "YOUR_SUCCESS_CRITERIA" \
  --max-iterations 15
```

### Step 4: Announce Loop Start

Voice notification:
```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Ralph Loop activated. Iterating until success criteria met."}' \
  > /dev/null 2>&1 &
```

### Step 5: Monitor (Optional)

For long-running loops:
```bash
# Watch status
watch -n 30 "bun run RalphLoopExecutor.ts --status"

# Or check manually
bun run RalphLoopExecutor.ts --status
```

## Output

The loop state file is created at `.claude/ralph-loop.local.md` with:
- Active status
- Current iteration
- Max iterations
- Completion promise
- Start timestamp
- Associated ISC row (if applicable)

## Next Steps

- Monitor progress via `--status`
- Cancel with `--cancel` if needed
- Loop auto-completes when promise detected or max iterations reached
