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
7. **NEVER** write to `~/.claude/settings.json` — it is immutable. For tunable config (rateLimits, contextManager, wisdom, toon, notifications, model), use `ConfigLoader.writeRuntimeConfig()` which writes to `MEMORY/State/runtime-config.json`. Changes to permissions, hooks, daidentity, or principal are HUMAN-REQUIRED — flag via ISC human-required mechanism.

**If `report-done` rejects an item, the correct response is:**
- Read the rejection reason
- Use `retry <id> "<reason>"` to record the attempt and reset for retry
- The retry system handles strategy escalation automatically
- After 3 failures, it escalates to human review via `blocked` proxy

**The correct response is NEVER to bypass the pipeline.**

---

## BEHAVIORAL PRINCIPLES

These are architectural habits that prevent the most common failure modes observed in production sessions.

### Principle B0: Autonomous-First — Do NOT Escalate Whole Items
The default is that **Kaya does the work**. Bias HARD toward autonomous execution. The following are NOT reasons to escalate, bail on, or refuse a whole item:
- The work **touches live data** (migrations, local DB writes, real personal data) — this is routine autonomous work.
- The spec has a **live-verification gate** — Phase L runs autonomously in explorer mode on authorized/cron runs (and self-verifies interactively). A live-verify step is never grounds to declare an item "cannot be executed."
- The work **reinstalls launchd jobs, deploys, publishes, or builds a dashboard** — all automatable.

A step is genuinely human **only** when Kaya literally cannot perform it: entering a **secret/credential** Kaya doesn't hold, an **account-portal/consent** action only Jm can do, a **physical/on-device** action, or an **irreversible destructive** action on Jm's real accounts with no safe alternative. These are surfaced per-row/per-phase by the `disposition: human-required` mechanism (`prepare` rolls this up per phase as `isHumanGated`).

**Never escalate the whole item because some of it is human.** Execute every autonomous phase; file ONLY the genuinely-human phases as a separate "Kaya — Needs Jm" task (done automatically at `prepare` time for `isHumanGated` phases). If you believe a whole item is un-runnable, that is almost always wrong — re-read this principle before escalating.

### Principle B1: Understand Before Fixing
Before calling `retry` on any failed item, read the full error output and identify *why* it failed — not just *what* failed. A surface-level re-run of the same item with the same strategy will reproduce the same failure. If the error message is ambiguous, spawn a brief Explore agent to investigate before retrying.

### Principle B2: Item vs Infrastructure vs Environment Failures
`retry` re-derives the fault class from the failure reason (in code — `classifyFailure`), so you do not have to plumb it manually. Three classes route differently:
- **Item failure:** The work item itself has a problem (wrong code, missing test, etc.) → `retry` records an attempt and escalates after 3. This is the only class that burns the retry counter.
- **Infrastructure failure:** The pipeline tooling itself is broken (parseSpec throws, normalizeVerificationCommand crashes, SkepticalVerifier internal exception) → does NOT burn a retry counter; stores `infraErrors` and stops the item so the tool can be fixed first.
- **Environment block:** Verification could not RUN in this execution context, but the work is fine — e.g. Phase L live verification was classifier-blocked / found nothing runnable here (`LIVE_VERIFICATION_ENVIRONMENT_BLOCK`), or the verification inference backend was unavailable. → does NOT burn the retry counter and does NOT park on the human board; `retry` **re-stages the item to pending with a cooldown** (`restagePending`) so the next eligible run picks it up. A persistent block (≥ `KAYA_ENV_BLOCK_ESCALATE_CAP`, default 8) eventually escalates so nothing is silently stuck forever.

If 2+ consecutive items fail with the same error pattern, this is almost certainly an infrastructure OR environment failure, not coincidental item failures.

### Principle B3: Push Through Obstacles — but Honor Designed Gates
The main loop exits ONLY when `next-batch` returns empty OR budget >= 90%. An **obstacle** (transient error, a fixable tool break, a flaky check) is NOT a reason to stop — diagnose, fix, and continue. This is **autonomous** work.

But "never stop the loop" does **not** mean "never stop." Several stops are **by design** — they are correct terminal states, not malfunctions, and must be reported as such rather than pushed through:

| Designed gate | What it means | Loop behavior |
|---|---|---|
| `next-batch` empty, 0 blocked | All work done | Exit (success) |
| Budget >= 90% | Cost ceiling | Exit (report remaining) |
| `blocked-on-human` (human-required ISC rows) | A real human/device action is required | Item parks on "Kaya — Needs Jm"; **continue other items** |
| Environment block (Principle B2) | Verification can't run here | Item re-stages for the next eligible run; **continue other items** |
| `pending_approval` merge (Slice 3) | Verified locally; awaits merge approval | Item is DONE-but-unmerged; surfaced via `Integrator.ts pending`; **continue** |
| NEEDS_REVIEW verdict | SkepticalVerifier flagged genuine concerns | Stop THIS item; **continue others** |

Distinguishing the two is intentional: every designed gate is logged with a recognizable tag (`[env-block]`, `LIVE_VERIFICATION_HUMAN_REQUIRED`, `pending_approval`, `blocked-on-human`) so a by-design stop is never mistaken for a crash. If you hit a stop, classify it against this table before deciding whether to push through.

### Principle B4: Verify Before Claiming
Never report an item as complete or declare "all tests passing" based solely on a sub-agent's self-reported success. Before including any test count or pass/fail claim in your session summary, run the verification command yourself and confirm its output matches your claim.

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

Returns ISC rows, effort level, budget allocation.

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
5. **Files each LucidTask in the "Kaya — Needs Jm" project** (status `next`, pre-stamped to skip triage) so Jm sees them as a board column at localhost:7777

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

> **ANTI-PATTERN (PROHIBITED):** Spawning Engineer/Builder subagents directly from the Executive. The Executive's job is queue management, not code implementation. Each work item gets an Opus TaskOrchestrator (via `model: "opus"`) that runs the Builder/Verifier loop with Sonnet agents internally. Direct Engineer dispatch bypasses stall detection, feedback injection, and independent verification.

**For TRIVIAL effort items:** Skip the orchestrator agent. Handle ISC rows inline and proceed directly to step 2d (Collect Execution Logs).

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
| `{{WORK_SURFACE}}` | Surface classification from Phase 1 SurfaceClassifier result (`workSurface` field in item metadata) |

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

- If `converged: true` with `terminationReason: "allPass"` AND `needsReview: false` → proceed to Collect Execution Logs (step 2d)
- If `converged: true` with `terminationReason: "allPass"` AND `needsReview: true` → skip straight to `report-done` (step 2e). The supplementary SkepticalVerifier flagged concerns — let the `report-done` pipeline's independent SkepticalVerifier make the authoritative verdict.
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

0. **Human-gated phase? Skip it (do NOT build, do NOT escalate the item).** If `phase.isHumanGated === true`, the genuine human steps were already filed as a "Kaya — Needs Jm" task at `prepare` time. **Stop the phased loop here**: phases at/after the first human-gated phase depend on the human action, so they are HELD, not run. Mark the item `blocked-on-human` and **continue to other items** (Principle B3) — the held phases resume automatically when Jm marks the human task done (the item returns to pending and `prepare` sets `resumeFromPhase`). Never declare the whole item un-runnable.

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
   - `allPass` → per-phase RuntimeVerifier hard gate (step 6)
   - `stall` or `max_iterations` → retry phase once (re-spawn same phase). If retry also stalls, mark item NEEDS_REVIEW and stop phased loop.
   - `error` → use `retry <id> "<error>"` to record attempt and stop phased loop

6. **Per-phase RuntimeVerifier hard gate (Slice 4 + S6 visual gate)** — run BEFORE mark-phase-done:
   ```bash
   bun run ~/.claude/skills/Automation/AutonomousWork/Tools/WorkOrchestratorCLI.ts verify-phase <id> <phaseNum> \
     --surface <workSurface> --phase-rows <comma-separated iscRowIds for this phase> --output json
   ```
   **Always pass `--phase-rows` with this phase's `iscRowIds`.** For the native surface they are required so the gate can disposition exactly this phase's rows `human-required`; omitting them makes the gate conservatively flag ALL the item's rows instead.

   Parse result `{ phaseNumber, passed, evidence, screenshots, humanVerificationRequired }`:
   - `passed: true` → see visual gate / native gate below, then proceed to mark-phase-done (step 7).
   - `passed: false` → **PHASE FAILURE: do NOT call mark-phase-done. Stop the phased loop immediately.**
     - Retry the phase once by re-spawning the same TaskOrchestrator for this phase.
     - If the retry also fails the RuntimeVerifier gate → call `retry <id> "phase <N> failed RuntimeVerifier: <evidence>"`, mark item NEEDS_REVIEW, and stop the phased loop. Phase N+1 and beyond do NOT start.

   **This gate is a hard block.** A phase that fails the live RuntimeVerifier gate indicates broken artifacts that would corrupt the next phase's baseline. The next phase must not start until the current phase's artifacts are verified.

   **S6 visual hard-gate (browser surface only):** When `workSurface === "browser"` and the gate returns `screenshots` (non-empty array), the Executive MUST visually verify the rendered UI BEFORE calling mark-phase-done:

   1. For each path in `screenshots`, open it with the **Read tool**:
      ```
      Read({ file_path: "<screenshot path>" })
      ```
   2. Visually confirm the rendered UI matches the phase's Given/When/Then acceptance criteria.
   3. **Gate FAIL conditions (do NOT call mark-phase-done):**
      - Rendered output is blank, placeholder, or clearly not the intended UI (mirage UI / white screen)
      - Any console error captured by the spec (non-favicon) — Playwright test itself should have failed these; treat any that slipped through as gate failures
      - Layout is fundamentally broken (overlapping critical elements, key content missing)
   4. **Gate PASS conditions:** UI renders the expected content per the spec's Given/When/Then, no broken renders, no console errors.

   When `screenshots` is empty AND `workSurface === "browser"` AND `passed: true`:
   - Check `evidence` for the warning "no screenshots produced by browser run".
   - This means the spec did not call `page.screenshot()` as required by TestWriterPrompt.md.
   - Do NOT treat as a pass on visuals — flag it: record a concern in the `report-done` call (`--adversarial-concerns "browser phase passed but no screenshots captured — visual gate cannot execute"`) so the SkepticalVerifier surfaces it.

   Favicon-404 console errors are the one allowed exception — ignore them in visual judgment.

   **Native gate (native surface — ADR-0006):** When `workSurface === "native"` the gate returns `humanVerificationRequired: true` and an EMPTY `screenshots` array. This environment has no iOS simulator / Android emulator / Detox / Appium, so native UI cannot be auto-verified.
   - **Do NOT** run the browser screenshot Read gate, and do NOT flag "no screenshots" — that warning applies to the browser surface only.
   - The unit/integration tests are non-gating evidence: if `passed: false`, treat it as a normal PHASE FAILURE (the code is broken at the unit level — block as above). If `passed: true`, the automatable portion is verified.
   - `verify-phase` has ALREADY dispositioned this phase's ISC rows `human-required`, so `report-done` will automatically create a LucidTask for the on-device check and hold the item (see the human-required proxy pattern above). You may proceed to mark-phase-done for the automatable portion, but **do NOT treat the item as fully DONE** — the native UI verification is a real, pending human/device task. Do NOT attempt to verify the native UI yourself.

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

#### 2d. Collect Execution Logs

After TaskOrchestrator returns `converged: true` (Gates 1-3 — WorkOrchestrator's per-row command re-run, Phase L live verification, and SkepticalVerifier's LLM judgment — own verification from here; there is no separate Executive spot-check step), and before calling `report-done`, the Executive MUST populate the item's `executionLog` metadata. The SkepticalVerifier checks execution logs to verify that ISC verification commands were actually run — empty logs cause rejection.

**Collect logs from:**
1. The TaskOrchestrator's `programmaticResults` (Step 2b ISC verification commands)
2. The Builder's test/build output
3. Any verification commands you ran directly

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

**Use the ISC row IDs** (from `format-isc-table`) as `<completed-row-ids>`.

#### 2e. Report Done (atomic pipeline)

After the TaskOrchestrator loop converges and execution logs are collected (step 2d), run the single atomic completion command:

```bash
bun run ~/.claude/skills/Automation/AutonomousWork/Tools/WorkOrchestrator.ts report-done <id> <completed-row-ids...> --interactive-session [--budget <amount>] --output json
```

This atomically: marks rows done → records execution → runs SkepticalVerifier → completes (or fails).

**Always pass `--interactive-session` from this workflow.** `report-done`'s auto-merge step defers to an active `interactive-session.lock` by DEFAULT (protects a concurrent Jm session's uncommitted work from a racing background merge — see Integrator's `checkInteractiveSessionLock`). This Orchestrate.md flow runs INSIDE Jm's own attended interactive session (that's the session that wrote the lock in the first place), so it explicitly opts out of deferring to itself. The unattended `HeadlessWorkDriver` (nightly cron) never passes this flag — a fresh lock always defers its merges.

If the adversarial Verifier found concerns during the loop, pass them through:

```bash
bun run ~/.claude/skills/Automation/AutonomousWork/Tools/WorkOrchestrator.ts report-done <id> <rows...> --interactive-session --adversarial-concerns "concern1||concern2"
```

**Record tech debt you introduced.** If, while completing this item, you knowingly left a workaround, shortcut, skipped test, TODO, or deferred cleanup, you MUST report it so it lands in the tech-debt registry (triaged later, can be auto-promoted). Pass a JSON array of `{description, location, category}` — category ∈ `complexity, workaround, reliability, maintainability, performance, correctness, tech-debt`:

```bash
bun run ~/.claude/skills/Automation/AutonomousWork/Tools/WorkOrchestrator.ts report-done <id> <rows...> --interactive-session \
  --debt-incurred '[{"description":"Polls every 5s instead of a webhook — temporary","location":"skills/Foo/Bar.ts","category":"workaround"}]'
```

Omit the flag when the work introduced no debt. Only report debt THIS work item added — not pre-existing debt you happened to notice.

**CRITICAL: Never set verification.status directly. Never call `complete` directly.
Only `report-done` (which runs the full SkepticalVerifier pipeline) can complete items.
The pipeline will reject items where verifiedBy !== "skeptical_verifier" for non-TRIVIAL items.**

#### 2f. Retry on Failure

When any step fails (agent error, report-done rejection):

```bash
bun run ~/.claude/skills/Automation/AutonomousWork/Tools/WorkOrchestrator.ts retry <id> "<error description>" --output json
```

The orchestrator handles strategy selection internally:
- **Attempt 1 failed** → retries with `"standard"` strategy (transient failures self-heal)
- **Attempt 2 failed** → retries with `"re-prepare"` strategy (regenerates ISC from spec)
- **Attempt 3 failed** → escalates to human review via `blocked` proxy + creates a "Kaya — Needs Jm" LucidTask

The workflow **never calls `fail` directly**. The `retry` command records the attempt, resets the item to `pending`, and selects the next strategy. After 3 failures, it creates a human review proxy, blocks the item on it, and creates an escalation LucidTask (`manual-<itemId>`) in the "Kaya — Needs Jm" project so Jm sees it on the board.

**Environment blocks do NOT escalate (Principle B2).** When the failure reason is an environment block (`LIVE_VERIFICATION_ENVIRONMENT_BLOCK`, "inference unavailable"), `retry` re-stages the item to pending with a cooldown instead of recording an attempt — the work is fine, only the execution context could not verify it. Such items reappear in a later `next-batch` (after the cooldown) and are NOT parked on the human board. This is what lets an interactive `/work` session hand a live-verification-gated item off to the next authorized/cron run instead of dead-ending it.

**Interactive Phase L uses self-verify, not the blocked Explorer (Slice 1).** Phase L's default engine is a headless `claude -p --dangerously-skip-permissions` Explorer, which the auto-mode classifier hard-blocks in interactive sessions. `LiveVerifyContext` detects context: in authorized autonomous/cron runs (`KAYA_CRON_JOB_ID`/`KAYA_AUTONOMOUS`) the Explorer runs as before; in an interactive session it falls back to a **non-dangerous self-verify harness** (`SelfVerifyRunner`) that actually runs the artifact with plain allowlisted commands (the item's ISC verify commands + a typecheck smoke) — real PASS/FAIL, no blocked spawn. Force a mode with `KAYA_LIVE_VERIFY_MODE=explorer|self-verify`.

**Exception:** If `report-done` returns `{ success: false }` with a **NEEDS_REVIEW or FAIL verdict**:
- **STOP processing THIS item** — do not retry it.
- Log it for the final report under "Items Needing Human Review."
- A "Kaya — Needs Jm" escalation LucidTask is created automatically so Jm sees it.
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

> **ANTI-PATTERN (PROHIBITED):** Declaring work "done", asking Jm to re-prompt, or stopping after completing only one batch. The loop exits ONLY when `next-batch` returns empty. Completing a batch is an iteration boundary, not a stopping point. Verified items now auto-merge inline (via `reportDone` → `Integrator.mergeItem()`), so there is no need to defer merging to Step 4b.
>
> **Budget gate:** Call `getBudgetStatus()` before each batch dispatch. If usage >= 90%, report remaining items and stop gracefully — this is the ONLY acceptable early exit besides an empty queue.

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

### 4. Cleanup Worktrees (MANDATORY)

**This step is REQUIRED after every loop exit, not optional.**

Worktree cleanup runs automatically inside `complete` and `fail` for individual items. After all items are processed, run the prune sweep to catch orphans:

```bash
bun run ~/.claude/lib/core/WorktreeManager.ts prune
```

Also delete any merged feature branches:

```bash
git branch --list 'feature/work-*' --merged main | xargs git branch -d 2>/dev/null || true
```

### 4b. Merge Deferred Items + Push (MANDATORY)

**ALWAYS run this step after the loop, regardless of whether inline auto-merge fired.** Items may have been deferred due to conflicts or human-approval requirements. This catches them.

```bash
bun run ~/.claude/skills/Automation/AutonomousWork/Tools/Integrator.ts merge --strategy direct --json
```

This iterates verified-completed items with `metadata.worktreeBranch` where `mergeStatus !== "merged"` and for each:
1. Resolves the project repo path from `item.projectPath` (falls back to cwd)
2. Merges locally via `git merge --no-ff <branch>`
3. Pushes main to remote via `git push origin HEAD`
4. Records `mergeStatus: "merged"` and `mergedAt` in item metadata

**After the merge sweep**, push main to ensure all changes are on the remote:

```bash
git push origin main
```

**Important:** Items must have `projectPath` set for cross-repo work. The `started` command sets `projectPath` during worktree creation from the item's project configuration.

#### 4c. Merge Bridge — Approval-Gated Drain (Slice 3)

`merge` (and inline auto-merge) refuse to merge an item that touches settings/secrets or is a deploy/publish — these need human approval. Such an item is **verified-locally, pending-approval** (`mergeStatus: "pending_approval"`), NOT a dead end. Surface and drain them:

```bash
# List items verified locally and waiting on a merge approval
bun run ~/.claude/skills/Automation/AutonomousWork/Tools/Integrator.ts pending --json

# Approve one (records a first-class, resumable approval) — optionally merge immediately
bun run ~/.claude/skills/Automation/AutonomousWork/Tools/Integrator.ts approve <id> [--merge]

# Drain everything that has been approved (mergeApproved === true)
bun run ~/.claude/skills/Automation/AutonomousWork/Tools/Integrator.ts drain --strategy direct
```

"No merge to main without approval" still holds — `approve` is the only way to clear the gate, and only a human (or an explicitly-authorized step) runs it. List pending-approval items in the session report so they are never silently stuck.

#### 4d. Loop/Epic Continuation (Slice 4)

When an item that declares **follow-on loops** verifies + completes, `report-done` auto-enqueues the NEXT loop (via `enqueueNextFollowOn`), gated on the just-completed item, so the queue refills. Strict sequential live-verification gating holds: the next loop DEPENDS on this one (DAG won't release it until this loop completes, which requires it to have verified), and only ONE follow-on is enqueued at a time (the rest are carried forward on the new item). Declare forward stubs either as `item.metadata.followOnLoops` or in the spec:

```markdown
## Follow-On Loops

- Canvas Loop 2 — Multiplayer | spec: apps/Canvas/LOOP2-SPEC.md
- Canvas Loop 3 — Realtime Sync | spec: apps/Canvas/LOOP3-SPEC.md
```

This is why the queue no longer empties after Loop 1 of a multi-loop epic. The newly-enqueued loop appears in the next `next-batch` automatically.

---

## Error Handling

- **Agent fails:** Use `retry <id> "<error>"` — never call `fail` directly. The retry system handles strategy escalation and human escalation after 3 attempts.
- **Budget exhausted:** Save state, report, stop gracefully
- **All blocked:** Report via `status`, let user decide
- **DAG cycle:** Report error, do not process
- **Catastrophic command detected:** Block and report
