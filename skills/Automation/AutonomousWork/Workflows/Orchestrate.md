---
name: Orchestrate
description: Main orchestration workflow for autonomous work execution. USE WHEN /work start, work start, begin autonomous processing.
---

# Orchestrate Workflow

**You (Claude) are the orchestrator.** Follow these steps, using the Task tool to delegate work to agents and Bash for ralph loops. Never write implementation code yourself.

---

## ABSOLUTE PROHIBITIONS

**These rules apply to YOU (the orchestrator). Violation = pipeline corruption.**

1. **NEVER** call `WorkQueue.ts updateStatus()` directly for completion — all completions MUST go through `report-done`
2. **NEVER** call `complete()` directly — the `complete()` method is an internal pipeline step, not a public API
3. **NEVER** bypass `report-done` — if it rejects, use `retry` to record the failure and reset. Do NOT route around the pipeline.
6. **NEVER** call `fail` directly — use `retry` for all failures. `fail --force` is for manual kills only.
4. **NEVER** set `verification.status` or `verification.verdict` directly — only the SkepticalVerifier pipeline writes these fields
5. **If the adversarial verifier returns HIGH severity concerns**, you MUST resolve them (re-delegate) or explicitly acknowledge them in the `report-done` call before proceeding

**If `report-done` rejects an item, the correct response is:**
- Read the rejection reason
- Use `retry <id> "<reason>"` to record the attempt and reset for retry
- The retry system handles strategy escalation automatically
- After 3 failures, it escalates to human review via `blocked` proxy

**The correct response is NEVER to bypass the pipeline.**

---

## Steps

### 1. Initialize

```bash
bun run ~/.claude/skills/Automation/AutonomousWork/Tools/WorkOrchestrator.ts init --output json
```

Returns queue items, budget state, DAG validation. If `success: false`, report error and stop.

**Emit trace (session start):**
```bash
bun run ~/.claude/skills/System/AgentMonitor/Tools/TraceEmitter.ts --workflow "aw-$(date +%Y%m%d-%H%M%S)" --agent executive --event start 2>/dev/null || true
```
Save the workflow ID (e.g. `aw-20260226-121000`) for subsequent trace calls in this session.

### 2. Main Loop

While items remain and budget allows:

#### 2a. Get Next Batch

```bash
bun run ~/.claude/skills/Automation/AutonomousWork/Tools/WorkOrchestrator.ts next-batch --output json
```

- If empty and all blocked: report blocked items via `status`, stop.
- If empty and none blocked: all work complete, go to step 3.

#### 2b. Prepare Each Item

```bash
bun run ~/.claude/skills/Automation/AutonomousWork/Tools/WorkOrchestrator.ts prepare <id> --output json
```

Returns ISC rows, effort level, budget allocation. Then route each row:

```bash
bun run ~/.claude/skills/Automation/AutonomousWork/Tools/CapabilityRouter.ts --row "<description>" --effort <EFFORT> --output json
```

#### 2b-human. Human-Required ISC Detection

During item preparation, if an ISC row description contains indicators of human-only work, the orchestrator creates a human dependency instead of delegating to an agent.

**Human-only indicators:**
- External portal access (Stripe dashboard, AWS console, Google Cloud console, etc.)
- Manual account creation or API key generation
- Physical action (mail a document, sign a form, etc.)
- 2FA/MFA-gated actions that require human browser login
- Third-party approval workflows (app store review, domain verification, etc.)

**Automated handling (via `report-done`):**

When `report-done` verifies an item and finds PENDING ISC rows with `disposition: "human-required"`, it automatically:

1. **Creates a LucidTask** for each human-required row (via direct TaskDB import)
2. **Creates a HUMAN proxy WorkItem** with `humanTaskRef` linking to the LucidTask
3. **Wires the proxy as a dependency** of the real work item
4. **Sets the item to blocked** with `manualRows` and `humanProxyIds` in metadata
5. **Creates a jm-tasks entry** as a fallback notification

The Executive does NOT need to manually create proxies or LucidTasks. The `report-done` pipeline handles it.

**Resolution:** When Jm completes a human task, use the JmTaskBridge to resolve the proxy:
```bash
bun run ~/.claude/skills/Automation/AutonomousWork/Tools/JmTaskBridge.ts resolve --lucid-task-id <id>
```
This unblocks the dependent work item automatically.

**Important:** Do not attempt to execute the human-required ISC row. Do not mark the row as failed. The proxy pattern ensures the real work item will resume automatically when Jm completes the LucidTask.

---

#### 2c. Mark Started + Delegate (Executive → TaskOrchestrator Opus Agent)

```bash
bun run ~/.claude/skills/Automation/AutonomousWork/Tools/WorkOrchestrator.ts started <id>
```

The `started` command returns JSON: `{ success, status, worktreePath, worktreeBranch }`.

Generate the ISC table for agents (includes Verification Command column):
```bash
bun run ~/.claude/skills/Automation/AutonomousWork/Tools/WorkOrchestrator.ts format-isc-table <id> --output markdown
```
Use this output as `{{ISC_TABLE}}` in the TaskOrchestratorPrompt.
- Parse the JSON output. Use `worktreePath` as `{{WORKTREE_PATH}}` for the TaskOrchestrator prompt.
- If `worktreePath` is `null`, call `bun run WorkOrchestrator.ts retry <id> "Worktree creation failed"` and skip to step 2g.

The **Executive** (you, the Claude session) delegates each item to an **Opus orchestrator agent** that drives the Builder/Verifier loop by spawning its own sub-agents (Engineer for Builder, Explore for Verifier).

**For TRIVIAL effort items:** Skip the orchestrator agent. Handle ISC rows inline and proceed directly to step 2d.

**Check the PrepareResult for phased execution:** If `prepare` returned `phases` (non-empty array), use the **Phased Delegation** path below. Otherwise, use the **Single-Shot Delegation** path.

---

##### Single-Shot Delegation (no phases, or phases undefined)

1. Read `TaskOrchestratorPrompt.md` from `skills/Automation/AutonomousWork/Prompts/TaskOrchestratorPrompt.md`
2. Fill template variables from the PrepareResult and work item:

| Variable | Source |
|---|---|
| `{{ITEM_ID}}` | Work queue item ID |
| `{{ITEM_TITLE}}` | Work item title |
| `{{SPEC_PATH}}` | Absolute path to spec file |
| `{{SPEC_CONTENT}}` | Full spec content (inlined) |
| `{{ISC_TABLE}}` | Markdown table of ISC rows from prepare |
| `{{TEST_STRATEGY}}` | If `item.testStrategyPath` exists and file is readable, inline content (truncate to 3000 chars). Else `"(no test strategy — use best judgment for test types)"` |
| `{{EFFORT}}` | Effort level from prepare (QUICK/STANDARD/THOROUGH/DETERMINED) |
| `{{MAX_ITERATIONS}}` | From prepare: maxIterations (QUICK:3, STANDARD:10, THOROUGH:25, DETERMINED:100) |
| `{{WORKTREE_PATH}}` | Git worktree path — returned by `started` command as `worktreePath` in JSON output |
| `{{PRIOR_WORK}}` | Summary of previously completed rows (empty on first run) |
| `{{PHASE_CONTEXT}}` | Empty string (single-shot) |
| `{{VERIFIER_MODEL}}` | `"opus"` for STANDARD/THOROUGH/DETERMINED, `"sonnet"` for QUICK/TRIVIAL |

3. Spawn the Opus orchestrator agent:

```typescript
Task({
  description: "<item-title>: TaskOrchestrator",
  subagent_type: "general-purpose",
  model: "opus",
  prompt: <filled TaskOrchestratorPrompt.md>
})
```

**After the TaskOrchestrator returns**, parse its JSON result:

- If `converged: true` with `terminationReason: "allPass"` AND `needsReview: false` → proceed to spot-check (step 2d)
- If `converged: true` with `terminationReason: "allPass"` AND `needsReview: true` → skip spot-check, go directly to `report-done` (step 2e). The supplementary SkepticalVerifier flagged concerns — let the `report-done` pipeline's independent SkepticalVerifier make the authoritative verdict.
- If `converged: false` with `terminationReason: "stall"` or `"max_iterations"` → mark item NEEDS_REVIEW, skip to step 2g
- If `terminationReason: "error"` → mark item failed with the error message, skip to step 2g

---

##### Phased Delegation (prepare returned `phases`)

When `prepare` returns a `phases` array, the spec has multiple phases with enough ISC rows (>= 8 total, >= 2 phases) to warrant per-phase delegation. This prevents context exhaustion on large specs.

**Initialize:**
- `allCompletedRowIds = completedRowIds from prepare (resume case) or []`
- `phasesPriorWork = ""`
- `startPhase = resumeFromPhase from prepare (resume case) or first phase number`

**For each phase** (ordered by phaseNumber, skip phases < startPhase):

1. **Get phase ISC rows**: Filter the full ISC table to only rows matching `phase.iscRowIds`
2. **Build phase-scoped ISC table**: Markdown table with only this phase's ISC rows
3. **Fill TaskOrchestratorPrompt.md** with:
   - `{{ISC_TABLE}}` = phase ISC only (not all rows)
   - `{{MAX_ITERATIONS}}` = `phase.maxIterations`
   - `{{PRIOR_WORK}}` = `phasesPriorWork` (git log from prior phases)
   - `{{PHASE_CONTEXT}}` = `"**Phase {{phaseNumber}}/{{totalPhases}}: {{phaseName}}** — You are working on a SUBSET of the full spec. ONLY address the ISC rows listed above. Do not work on other phases."`
   - All other variables same as single-shot

4. **Spawn TaskOrchestrator** (same as single-shot):
   ```typescript
   Task({
     description: "<item-title>: Phase <N>/<total> <phaseName>",
     subagent_type: "general-purpose",
     model: "opus",
     prompt: <filled TaskOrchestratorPrompt.md>
   })
   ```

5. **Parse result** — same convergence checks as single-shot:
   - `allPass` → phase spot-check (step 2d scoped to phase rows)
   - `stall` or `max_iterations` → retry phase once (re-spawn same phase). If retry also stalls, mark item NEEDS_REVIEW and stop phased loop.
   - `error` → use `retry <id> "<error>"` to record attempt and stop phased loop

6. **Phase spot-check** (step 2d scoped to this phase's row IDs only)

7. **Collect completed row IDs**: Append this phase's `iscRowIds` to `allCompletedRowIds`

8. **Mark phase done**:
   ```bash
   bun run ~/.claude/skills/Automation/AutonomousWork/Tools/WorkOrchestrator.ts mark-phase-done <id> <phaseNum> <totalPhases> --json
   ```

9. **Collect git log** for next phase's `PRIOR_WORK`:
   ```bash
   git -C <worktree-path> log --oneline -20
   ```
   Set `phasesPriorWork` to this output.

10. **Budget check**: If budget >= 95% exhausted, stop phased loop, report partial progress.

**After all phases complete:** Pass `allCompletedRowIds` to `report-done` (step 2e). The SkepticalVerifier and completion gates run once at the end, aggregated across all phases.

---

**For ralph_loop rows**, use `skills/Automation/AutonomousWork/Templates/loop.sh` via Bash:

1. Run `loop.sh` via Bash (it iterates until TASK_COMPLETE or max iterations)
2. After `loop.sh` exits, the item is built but **NOT completed**
3. **MUST** call `WorkOrchestrator.ts report-done <id> <completed-row-ids...>` to run the SkepticalVerifier pipeline and gate completion
4. If `report-done` rejects, use `retry <id> "<reason>"` — never bypass the pipeline

**Same project = sequential (git safety). Different projects = parallel.**

#### 2d. Executive Spot-Check

After TaskOrchestrator returns `converged: true`:

1. Run the spot-check CLI (uses ExecutiveOrchestrator.spotCheck internally):
   ```bash
   bun run ~/.claude/skills/Automation/AutonomousWork/Tools/ExecutiveOrchestrator.ts spot-check <id> \
     --spec <specPath> --effort <EFFORT> --worktree <worktreePath> \
     --verifier-report '<last VerifierReport JSON>' --output json
   ```

2. Parse result `{ approved, concerns }`:
   - `approved: true` → proceed to report-done (step 2e)
   - `approved: false` → re-delegate to TaskOrchestrator with concerns as feedback (one retry)
   - If re-delegation also fails spot-check → `retry <id> "spot-check: <concerns>"`, go to step 2g

#### 2d½. Collect Execution Logs

Before calling `report-done`, the Executive MUST populate the item's `executionLog` metadata. The SkepticalVerifier checks execution logs to verify that ISC verification commands were actually run — empty logs cause rejection.

**Collect logs from:**
1. The TaskOrchestrator's `programmaticResults` (Step 2b ISC verification commands)
2. The Builder's test/build output
3. Any commands you ran during spot-check

**Store them via programmatic API:**
```typescript
bun -e "
import { WorkQueue } from './skills/Automation/AutonomousWork/Tools/WorkQueue.ts';
const q = new WorkQueue();
q.setMetadata('<id>', {
  executionLog: [
    '<command> → exit <code> | <first 200 chars of output>',
    // ... one entry per verification command run
  ]
});
q.save();
"
```

**Use the 4-digit ISC row IDs** (from `format-isc-table`) as `<completed-row-ids>` — NOT sequential spec numbers (1, 2, 3...).

#### 2e. Report Done (atomic pipeline)

After the TaskOrchestrator loop and Executive spot-check both pass, run the single atomic completion command:

```bash
bun run ~/.claude/skills/Automation/AutonomousWork/Tools/WorkOrchestrator.ts report-done <id> <completed-row-ids...> [--budget <amount>] --output json
```

This atomically: marks rows done → records execution → runs SkepticalVerifier → completes (or fails).

If the adversarial Verifier found concerns during the loop, pass them through:

```bash
bun run ~/.claude/skills/Automation/AutonomousWork/Tools/WorkOrchestrator.ts report-done <id> <rows...> --adversarial-concerns "concern1||concern2"
```

**CRITICAL: Never set verification.status directly. Never call `complete` directly.
Only `report-done` (which runs the full SkepticalVerifier pipeline) can complete items.
The pipeline will reject items where verifiedBy !== "skeptical_verifier" for non-TRIVIAL items.**

#### 2f. Retry on Failure

When any step fails (agent error, report-done rejection, spot-check failure):

```bash
bun run ~/.claude/skills/Automation/AutonomousWork/Tools/WorkOrchestrator.ts retry <id> "<error description>" --output json
```

The orchestrator handles strategy selection internally:
- **Attempt 1 failed** → retries with `"standard"` strategy (transient failures self-heal)
- **Attempt 2 failed** → retries with `"re-prepare"` strategy (regenerates ISC from spec)
- **Attempt 3 failed** → escalates to human review via `blocked` proxy + creates `jm-tasks` queue entry

The workflow **never calls `fail` directly**. The `retry` command records the attempt, resets the item to `pending`, and selects the next strategy. After 3 failures, it creates a human review proxy, blocks the item on it, and routes to the `jm-tasks` queue so Jm sees it in normal task workflow.

**Exception:** If `report-done` returns `{ success: false }` with a **NEEDS_REVIEW or FAIL verdict**:
- **STOP processing THIS item** — do not retry it.
- Log it for the final report under "Items Needing Human Review."
- A `jm-tasks` queue entry is created automatically so Jm sees it.
- **Continue processing remaining items** — do not end the session.

**For inference unavailability:** Retry `report-done` up to 3 times with 30s delay. After 3 failures, use `retry <id> "Verification inference unavailable after 3 retries"`.

#### 2g. Re-enter Loop

Call `next-batch` again:
- If items returned → loop back to step 2b (prepare each item).
- If empty and blocked > 0 → report blocked items, go to step 3.
- If empty and blocked = 0 → all work complete, go to step 3.

**This loop MUST continue until no pending items remain.**
Items reset via `retry()` will appear in subsequent `next-batch` calls.
NEEDS_REVIEW items will NOT appear — they require Jm's decision.

### 3. Report Results

```bash
bun run ~/.claude/skills/Automation/AutonomousWork/Tools/WorkOrchestrator.ts report --json
```

**Emit trace (session completion):**
```bash
bun run ~/.claude/skills/System/AgentMonitor/Tools/TraceEmitter.ts --workflow "$WORKFLOW_ID" --agent executive --event completion 2>/dev/null || true
```

Use the JSON output to write the session summary. Do NOT override statuses — if report says `inProgress`, report `in_progress`. Items without `verification.status === "verified"` are NOT completed.

**Session Summary Template** (fill slots from report JSON):
```
## Session Summary
- Completed: {completed.length} items — {list titles}
- In Progress: {inProgress.length} items — {list titles with verification concerns}
- Failed: {failed.length} items — {list titles with error reasons}
- Needs Review: {needsReview.length} items — {list titles with reviewer concerns}
- Blocked: {blocked.length} items — {list titles with dependency info}
- Retried: {retried items with strategy used}
```

**Items Needing Human Review:** If any items appear in `needsReview`, list them with their full concerns from the SkepticalVerifier. These require Jm's decision before proceeding.

---

### 4. Cleanup Worktrees

Worktree cleanup runs automatically inside `complete` and `fail`. As a safety net after all items are processed:

```bash
bun run ~/.claude/lib/core/WorktreeManager.ts prune
```

This catches any orphaned worktrees missed by per-item cleanup (e.g., if the orchestrator crashed mid-run).

### 4b. Merge Completed Feature Branches

After worktree cleanup, merge completed feature branches back to main:

```bash
bun run ~/.claude/skills/Automation/AutonomousWork/Tools/MergeOrchestrator.ts merge --strategy pr --json
```

This iterates verified-completed items with `metadata.worktreeBranch` and for each:
1. Resolves the project repo path from `item.projectPath` (falls back to cwd)
2. Pushes the feature branch to the remote (`git push -u origin <branch>`)
3. Creates a PR via `gh pr create`
4. Auto-merges the PR via `gh pr merge --auto --merge`
5. Records `prUrl` and `mergeStatus: "merged"` in item metadata

For the `--strategy direct` variant, it merges locally and pushes main to remote.

**Important:** Items must have `projectPath` set for cross-repo work. The `started` command sets `projectPath` during worktree creation from the item's project configuration.

---

## Error Handling

- **Agent fails:** Use `retry <id> "<error>"` — never call `fail` directly. The retry system handles strategy escalation and human escalation after 3 attempts.
- **Budget exhausted:** Save state, report, stop gracefully
- **All blocked:** Report via `status`, let user decide
- **DAG cycle:** Report error, do not process
- **Catastrophic command detected:** Block and report
