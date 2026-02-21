---
name: Orchestrate
description: Main orchestration workflow for autonomous work execution. USE WHEN /work start, work start, begin autonomous processing.
---

# Orchestrate Workflow

**You (Claude) are the orchestrator.** Follow these steps, using the Task tool to delegate work to agents and Bash for ralph loops. Never write implementation code yourself.

---

## Steps

### 1. Initialize

```bash
bun run ~/.claude/skills/AutonomousWork/Tools/WorkOrchestrator.ts init --output json
```

Returns queue items, budget state, DAG validation. If `success: false`, report error and stop.

### 2. Main Loop

While items remain and budget allows:

#### 2a. Get Next Batch

```bash
bun run ~/.claude/skills/AutonomousWork/Tools/WorkOrchestrator.ts next-batch --output json
```

- If empty and all blocked: report blocked items via `status`, stop.
- If empty and none blocked: all work complete, go to step 3.

#### 2b. Prepare Each Item

```bash
bun run ~/.claude/skills/AutonomousWork/Tools/WorkOrchestrator.ts prepare <id> --output json
```

Returns ISC rows, effort level, budget allocation. Then route each row:

```bash
bun run ~/.claude/skills/AutonomousWork/Tools/CapabilityRouter.ts --row "<description>" --effort <EFFORT> --output json
```

#### 2c. Mark Started + Delegate

```bash
bun run ~/.claude/skills/AutonomousWork/Tools/WorkOrchestrator.ts started <id>
```

**Delegate by project** — group items by project path, spawn one Task agent per project:

```
Task({
  description: "<project-name>: <item titles>",
  subagent_type: "<from CapabilityRouter>",
  model: "<from CapabilityRouter>",
  prompt: "
    Working in: <project-path>

    Complete these work items in order:

    ## Item: <title>
    Work Item ID: <item-id>
    Spec: <spec-path>
    ISC Rows:
    1. <description> — Verify: <criteria> — Command: <command>
    ...

    After each row: run verification command, commit progress.

    Do NOT call complete — the orchestrator handles verification and completion.
    Report results as JSON: { success, completedRows, failedRows }
  "
})
```

**For ralph_loop rows**, use `_RALPHLOOP/Templates/loop.sh` via Bash.
**For TRIVIAL rows**, handle inline.
**Same project = sequential (git safety). Different projects = parallel.**

#### 2d. Mark Done + Record Execution + Verify + Complete

After the agent finishes, run the full pipeline:

```bash
# 1. Transition ISC rows from PENDING → DONE
bun run ~/.claude/skills/AutonomousWork/Tools/WorkOrchestrator.ts mark-done <id> <row-ids...>

# 2. Record execution metrics (iteration + optional budget spend)
bun run ~/.claude/skills/AutonomousWork/Tools/WorkOrchestrator.ts record-execution <id> [--budget <amount>]

# 3. Run verification pipeline (local checks + skeptical review)
bun run ~/.claude/skills/AutonomousWork/Tools/WorkOrchestrator.ts verify <id> --output json

# 4. Mark completed (only succeeds if verify passed)
bun run ~/.claude/skills/AutonomousWork/Tools/WorkOrchestrator.ts complete <id>
# OR: fail <id> [reason]
```

**CRITICAL: Never set verification.status directly. Only the `verify` command
(which runs SkepticalVerifier) can set verification to "verified". The `complete`
command will reject items where verifiedBy !== "skeptical_verifier" for non-TRIVIAL items.**

#### 2d-bis. Post-Verification Retry (when verify returns FAIL or NEEDS_REVIEW)

If `verify` returns FAIL or NEEDS_REVIEW, inspect the concerns JSON:

- **NEEDS_REVIEW verdict**: **STOP processing this item.** Do NOT auto-retry. Include it in the final report under "Items Needing Human Review" with full concerns. User decides next action.
- **"template ISC" or "requirement coverage" or "INFERRED"**: The ISC rows were auto-generated and don't match the spec. Re-run `prepare <id>` to regenerate spec-based ISC, then re-delegate and re-verify.
- **"paper completion" or "near-zero budget"**: The agent didn't do real work. Mark the item failed: `fail <id> "Paper completion detected"`
- **"inference unavailable"**: Verification inference is down. Retry up to 3 times with 30s delay between attempts. After 3 failures, mark failed: `fail <id> "Verification inference unavailable after 3 retries"`

```bash
# Example: re-prepare after template ISC detection
bun run ~/.claude/skills/AutonomousWork/Tools/WorkOrchestrator.ts prepare <id> --output json
# Then re-delegate, mark-done, record-execution, verify again
```

#### 2e. Budget Check

```bash
bun run ~/.claude/skills/AutonomousWork/Tools/BudgetManager.ts check --queue --output json
```

- `>= 95%`: stop processing, go to step 3.
- `>= 75%`: log warning, continue.

Loop back to 2a.

### 3. Report Results

```bash
bun run ~/.claude/skills/AutonomousWork/Tools/WorkOrchestrator.ts status
```

Report: items completed/failed, budget spent, blocked items.

**Items Needing Human Review:** If any items received a NEEDS_REVIEW verdict and were not auto-retried, list them here with their full concerns from the SkepticalVerifier. These require the user's decision before proceeding.

---

### 4. Cleanup Worktrees

Worktree cleanup runs automatically inside `complete` and `fail`. As a safety net after all items are processed:

```bash
bun run ~/.claude/skills/CORE/Tools/WorktreeManager.ts prune
```

This catches any orphaned worktrees missed by per-item cleanup (e.g., if the orchestrator crashed mid-run).

---

## Error Handling

- **Agent fails:** Mark item failed, continue with next batch
- **Budget exhausted:** Save state, report, stop gracefully
- **All blocked:** Report via `status`, let user decide
- **DAG cycle:** Report error, do not process
- **Catastrophic command detected:** Block and report
