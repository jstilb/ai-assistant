---
name: AutonomousWork
description: Orchestrator of orchestrators for autonomous execution of development, research, and content work. Claude session drives orchestration, delegating to real Claude Code agents and ralph loops. USE WHEN work start, work status, work next, autonomous task execution, pick up from queue.
---

# AutonomousWork Skill

**You are the orchestrator.** Follow `Workflows/Orchestrate.md` step-by-step, using the Task tool to delegate work to agents and Bash for ralph loops. Never write implementation code yourself.

**USE WHEN:** work start, work status, work next, autonomous task, pick up from queue.

---

## Commands

| Command | Description |
|---------|-------------|
| `/work start` | Start orchestration (follow Orchestrate.md) |
| `/work status` | Show queue + budget status |
| `/work next` | Process next single item |

---

## Tools

| Tool | CLI | Purpose |
|------|-----|---------|
| `TaskOrchestrator.ts` | (programmatic) | Per-item Builder/Verifier loop: runs Builder Agent and Verifier Agent sequentially, injects structured feedback on FAIL, detects stall, escalates NEEDS_REVIEW |
| `WorkOrchestrator.ts` | `init`, `next-batch`, `prepare <id>`, `started <id>`, `verify <id>`, `complete <id>`, `fail <id>`, `status` | Queue orchestration, ISC prep, verification pipeline |
| `WorkQueue.ts` | (programmatic) | Single-file queue with DAG, status transitions |
| `format-isc-table` | (CLI subcommand) | Format ISC rows for agent prompts |
| `mark-phase-done` | (CLI subcommand) | Mark a phase complete and advance |
| `SkepticalVerifier.ts` | (programmatic) | Three-tier independent verification (supplementary post-loop check) |
| `SpecParser.ts` | (programmatic) | Parse spec markdown into ISC rows |

## Prompts

Agent prompt templates used by TaskOrchestrator. Template variables (`{{VAR}}`) are filled before spawning.

| Prompt | Location | Used By | Purpose |
|--------|----------|---------|---------|
| `BuilderPrompt.md` | `Prompts/BuilderPrompt.md` | TaskOrchestrator → Builder Agent (Engineer) | System prompt for the Builder: implement ISC rows, write tests, commit, return JSON. On iteration > 1: includes `{{VERIFIER_FEEDBACK}}` table of FAIL rows from previous Verifier run. |
| `VerifierPrompt.md` | `Prompts/VerifierPrompt.md` | TaskOrchestrator → Verifier Agent (Explore) | System prompt for the Verifier: independently extract ISC rows from spec, verify each row using Glob/Grep/Read, check test quality, return structured VerifierReport JSON. |

---

## Architecture

```
Executive (Claude orchestration per Workflows/Orchestrate.md, driving the WorkOrchestrator.ts CLI — queue management, final approval/rejection via Gates 1-3; the standalone ExecutiveOrchestrator.ts was deleted 2026-07-03 with zero runtime callers)
└── TaskOrchestrator (per-item Builder/Verifier loop)
    ├── Builder Agent (Engineer — writes code + tests, commits, returns JSON)
    ├── Verifier Agent (Explore — read-only independent verification, returns VerifierReport JSON)
    └── SkepticalVerifier (supplementary 3-tier check after loop converges)
```

### Builder/Verifier Loop Lifecycle

The TaskOrchestrator drives the Builder/Verifier loop for each work item:

```
Iteration 1:
  Builder Agent (Engineer) — implements ISC rows, writes tests (TDD), commits
  Verifier Agent (Explore) — independently extracts ISC from spec, verifies all rows
    → returns VerifierReport { rows, summary, allPass }

If allPass === true:
  SkepticalVerifier supplementary check → report to the Executive → done

If allPass === false:
  Convert FAIL rows to structured Verifier feedback table
  Inject into BuilderPrompt.md as {{VERIFIER_FEEDBACK}}
  Loop to next iteration

If stall (same rows failing 2+ consecutive iterations):
  Set item status NEEDS_REVIEW → break

If max iterations exceeded without allPass:
  Set item status NEEDS_REVIEW → break
```

**Feedback injection format (BuilderPrompt.md `{{VERIFIER_FEEDBACK}}`):**

```markdown
## Verifier Feedback (Iteration N)

| ISC Row | Verdict | Feedback |
|---------|---------|----------|
| 3 | FAIL | No test for success path |
| 7 | FAIL | Function returns stub value |

Address each FAIL row specifically before re-submitting.
```

**VerifierReport JSON format (Verifier Agent output):**

```json
{
  "rows": [
    {
      "iscId": 3847,
      "verdict": "PASS",
      "evidence": "File exists at path. Grep confirms 'async run' method.",
      "linkedTest": "WorkOrchestrator.test.ts::init > succeeds with valid queue",
      "concern": null
    },
    {
      "iscId": 5291,
      "verdict": "FAIL",
      "evidence": "VerifierPrompt.md does not mention independent ISC extraction.",
      "linkedTest": null,
      "concern": "Prompt does not instruct Verifier to independently extract ISC from spec"
    }
  ],
  "summary": "14/17 ISC rows pass. 3 failures: prompt gaps and missing test coverage.",
  "allPass": false
}
```

---

## ISC Routing

Each ISC row routes to an execution mode based on effort and work type:

| Mode | When | How |
|------|------|-----|
| **task** | Non-TRIVIAL rows | `Task({ subagent_type, model })` |
| **ralph_loop** | Iterative rows | `Bash("./loop.sh")` with quality gates |
| **inline** | TRIVIAL only | Handle directly in orchestrator session |

---

## Model Routing per Effort Level

| Effort Level | Default Model | Rationale |
|-------------|--------------|-----------|
| **TRIVIAL** | inline (no agent) | Handle in orchestrator session, no spawn cost |
| **LOW** | `haiku` | Simple verification, file checks, quick research |
| **STANDARD** | `sonnet` | Implementation, research, analysis (80% of work) |
| **HIGH** | `sonnet` | Complex multi-file work (Sonnet handles well) |
| **CRITICAL** | `opus` | Architecture decisions, novel reasoning, algorithm work |

**Cost Impact:** Routing STANDARD work to Sonnet instead of Opus saves ~80% per call.

---

## Agent Frontmatter Requirements

All agents used by AutonomousWork must have correct frontmatter. The orchestrator relies on these fields.

### Required Fields

```yaml
---
name: AgentName                        # Matches subagent_type in Task()
model: sonnet                          # or opus for critical reasoning agents
maxTurns: 30                           # Prevents runaway agents
allowedTools:                          # Per-agent tool allowlist (replaces the deprecated blanket permission-bypass flag)
  - "Bash"
  - "Read(*)"
  - "Write(*)"
  # ... other required tools
---
```

### Agent Tier Configuration

| Agent | Model | maxTurns | allowedTools | Role |
|-------|-------|----------|--------------|------|
| Architect | opus | 50 | Bash(git *), Bash(bun *), Read, Write, Edit, Glob, Grep | Novel architectural reasoning |
| Algorithm | opus | 50 | Bash(git *), Bash(bun *), Read, Write, Edit, Glob, Grep | ISC precision reasoning |
| Engineer | sonnet | 50 | Bash(git *), Bash(bun *), Bash(npm *), Read, Write, Edit, MultiEdit, Glob, Grep | TDD implementation |
| Designer | sonnet | 30 | Bash(git *), Read, Write, Edit, Glob, Grep | Design work |
| Artist | sonnet | 30 | Read, Write, Glob, Grep | Visual content |
| QATester | sonnet | 30 | Read, Glob, Grep, Bash(bun test *), Bash(npx playwright *) | Verification |
| Intern | sonnet | 30 | Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Bash(ls *), Bash(cat *), Bash(git status), Bash(git diff *) | General/parallel work |
| Pentester | sonnet | 30 | Read, Glob, Grep, Bash(git diff *) | Security assessment |
| ClaudeResearcher | sonnet | 25 | WebSearch, WebFetch, Read, Glob, Grep | Research |
| GeminiResearcher | sonnet | 25 | WebSearch, WebFetch, Read, Glob, Grep | Multi-perspective research |
| GrokResearcher | sonnet | 25 | WebSearch, WebFetch, Read, Glob, Grep | Contrarian research |
| CodexResearcher | sonnet | 25 | WebSearch, WebFetch, Read, Glob, Grep | Technical research |
| Verifier (Explore) | sonnet | 30 | Read, Glob, Grep, Bash | Read-only independent verification |
| Executive | sonnet | 50 | Task, Read, Bash, Write | Queue management, approval |
| TaskOrchestrator | sonnet | 30 | Task, Read, Bash | Per-item Builder/Verifier loop driver |
| Wordsmith | opus | 40 | Read, Write, Edit, Glob, Grep, WebSearch | Creative writing / novel (M2) |
| Organizer | sonnet | 35 | Read, Write, Edit, Glob, Grep, WebSearch | Community organizing (M1) |
| Trailhead | sonnet | 35 | Read, Write, Edit, Glob, Grep, WebSearch | Travel & adventure (M0) |
| Companion | sonnet | 30 | Read, Write, Edit, Glob, Grep, WebSearch | Relationships (M3/M4) |
| Compass | opus | 35 | Read, Write, Edit, Glob, Grep, Bash | TELOS accountability (M6) |

**`allowedTools`** defines per-agent tool access, replacing the former blanket permission-bypass flag. Each agent gets only the tools it needs. Autonomous (off-hours, background) agents still need tools pre-approved — list them explicitly in frontmatter.

---

## Worktree Strategy

Git-operating agents MUST run in isolated worktrees to prevent branch contamination (the #1 recurring bug, documented in MEMORY).

### When to Provision Worktrees

```
ISC row involves git operations (commit, branch, merge)?
├── YES → Provision worktree before spawning agent
└── NO  → Standard delegation without worktree
```

### Worktree Provisioning in AutonomousWork

```typescript
import { WorktreeManager } from '~/.claude/lib/core/WorktreeManager.ts';

// When routing mode=task and agent will git:
const wt = await WorktreeManager.create(`work-${itemId}-${Date.now()}`);

Task({
  description: `[${itemId}] Implement feature`,
  prompt: buildPrompt(item, context, wt.path),
  subagent_type: "Engineer",
  model: "sonnet",
  workingDir: wt.path  // Agent operates in isolation
});

// WorktreeCleanup.hook.ts handles cleanup after SubagentStop
```

### Parallel Agents on Same Repo

When spawning multiple agents on the same repository:
- Each agent gets its own worktree: `wt-{itemId}-{role}`
- Explicit file ownership boundaries in each agent's prompt
- Merge via PR after each agent completes

---

## Verification Gate Integration

SkepticalVerifier runs three independent verification tiers before any item is marked complete.

### Tier Architecture

```
Tier 1: Fast automated checks (grep, file existence, syntax)
    ↓ pass
Tier 2: SkepticalVerifier agent (independent review of claimed deliverables)
    ↓ pass
Tier 3: Integration test or browser validation (if web/UI work)
    ↓ pass
Mark item COMPLETE
```

### Phase L — Mandatory Live Verification

Running tests is **not** sufficient proof. Every item — no matter the surface or
effort — must be **actually run and observed** before it can be marked
VERIFIED/DONE. This catches work that passes tests but does not actually work.

> **Live verification is autonomous — it is NOT a reason to escalate.** Phase L
> runs the artifact itself (Explorer in authorized/cron runs, self-verify
> interactively). "This needs live verification" or "this touches live data" is
> **never** grounds to declare an item un-runnable and escalate the whole thing.
> Only genuinely-human steps (secret entry, account consent, physical/on-device,
> irreversible-destructive) park — and only those specific rows/phases, never the
> whole item. See Orchestrate.md Principle B0.

Two enforcement points share one engine + recipe library:

- **Builder self-verification (build loop, Step 1.5):** after the Builder implements a
  slice, the orchestrator actually runs the artifact (per `{{WORK_SURFACE}}`) and records a
  `liveVerificationTranscript`. A live mismatch loops back to the Builder — a slice that
  does not actually run is never advanced. (`TaskOrchestratorPrompt.md` Step 1.5, `BuilderPrompt.md` Step 1.5)
- **Independent Phase L gate (`SkepticalVerifier`):** a fresh independent run re-drives the
  artifact from the spec — it never trusts the builder's transcript. A live FAIL, **including
  "no live evidence" (the artifact was never actually run)**, is a HARD BLOCK: Phase 2 does not
  run, the verdict is FAIL, and the item flows to the normal verify-fail → auto-retry path.

  **Context-aware engine (`LiveVerifyContext`).** Phase L picks its engine from the execution
  context, without weakening the classifier:
  - **Authorized autonomous/cron** (`KAYA_CRON_JOB_ID`/`KAYA_AUTONOMOUS`) → the **LLM Explorer**
    (`LiveVerifier.ts`, headless `claude -p` with Bash + Read), as before.
  - **Interactive session** (`CLAUDECODE`) → a **non-dangerous self-verify harness**
    (`SelfVerifyRunner.ts`). The headless `claude -p --dangerously-skip-permissions` Explorer is
    classifier-blocked in interactive sessions, so instead of hard-blocking + parking the item
    forever, self-verify ACTUALLY RUNS the artifact with plain allowlisted commands (the item's
    ISC verify commands + a typecheck smoke), captures a real transcript, and emits a real
    PASS/FAIL. It never spawns `claude`. Override with `KAYA_LIVE_VERIFY_MODE=explorer|self-verify`.
  - **Environment-blocked** (neither engine could run anything here, or inference unavailable) →
    surfaced as `LIVE_VERIFICATION_ENVIRONMENT_BLOCK`, classified `environment`, and **re-staged
    to pending for the next eligible run** — NOT escalated to the human board (Principle B2).

```
Phase 1   deterministic checks
Phase 1.5 RuntimeVerifier (boots server / runs tests — cheap floor)
Phase L   LIVE EXERCISE (mandatory, ALL tiers) — Explorer actually runs the artifact
            FAIL or no-evidence → hard block (no Phase 2), verdict FAIL
Phase 2   Sonnet judgment (only if Phase L passed)
```

**Per-surface recipes** (`LiveExerciseRecipes.ts`): cli → run the binary with edge args;
api → boot + health + curl; browser → Playwright + screenshot Read gate; integration →
import + call public API; refactor → typecheck + run callers; docs/config → render/lint +
validate with the real loader; **native → HUMAN_REQUIRED** (no simulator here — never auto-DONE).

**Complexity scaling** (`LIVE_BUDGETS`, keyed by effort): exploration depth and time budget
grow with complexity — TRIVIAL = one real execution (~60s); DETERMINED = 15+ scenarios incl.
adversarial/chaos (~40 min, loop-until-no-new-failures).

Live transcripts are persisted under `MEMORY/AutonomousWork/live-verification/<itemId>/`.
The post-verify `SimulationGate` does NOT re-run the artifact (Phase L already did); it only
checks complementary structural/sandbox invariants.

### Hook Coverage

Two quality gate hooks enforce verification at the agent level:

| Hook | Fires When | Blocks When |
|------|-----------|-------------|
| `hooks/TaskCompleted.sh` | Agent marks task complete | Deliverables missing or have FIXME/TODO markers |
| `hooks/TeammateIdle.sh` | Agent goes idle | Unclaimed/unblocked tasks remain in task list |

These hooks are registered in `settings.json` or team configs.

---

## Model Routing

### Cost Conservation Rules

1. **Never run opus when sonnet suffices** — enforced by effort-based model selection
2. **haiku for verification** — Spotcheck agents and quick validation use haiku

### Lean Variants for High-Volume Parallel Work

For background/parallel spawning at scale, use lean agent variants to reduce context overhead:
- `Intern-lean.md` — ~1.7KB vs Intern.md (minimal context overhead)
- `ClaudeResearcher-lean.md` — parallel research without voice config
- `GeminiResearcher-lean.md` — parallel multi-perspective research
- `GrokResearcher-lean.md` — parallel contrarian research

Use lean variants when: `parallel: true`, `run_in_background: true`, or spawning 3+ concurrent agents.

---

## Safety Model

- **Git is the safety net** — feature branches, frequent commits
- **Catastrophic actions always blocked** — `git push --force main`, `rm -rf /`, `DROP DATABASE` (the self-verify harness re-checks the FULL command string against these patterns and an executable allowlist; `claude` is never runnable there)
- **Verification required** — SkepticalVerifier (3-tier) + mandatory Phase L live exercise before any item marked complete; Phase L falls back to a non-dangerous self-verify harness in interactive context (never weakens the classifier)
- **No merge to main without approval** — settings/secrets/deploy items become `pending_approval` (verified-locally, unmerged); approval is a first-class resumable step via `Integrator approve`/`drain`, never a dead end
- **Loop guardrails** — retry escalation and stall detection prevent infinite loops; environment blocks re-stage (bounded by `KAYA_ENV_BLOCK_ESCALATE_CAP`) instead of burning retries; designed gates (human-required, pending-approval, environment-block) are logged with recognizable tags so a by-design stop is never mistaken for a malfunction

---

## Integration

### Uses
- **Templates/loop.sh** — Ralph loop iteration engine (self-contained)
- **QueueRouter** — Approval flow, approved-work queue (JSONL source)
- **WorktreeManager** — Isolation for git-operating agents
- **hooks/TeammateIdle.sh** — Prevents premature agent idle
- **hooks/TaskCompleted.sh** — Prevents false task completion

### Output Locations
| Type | Location |
|------|----------|
| Queue state | `MEMORY/WORK/work-queue.json` |
| Work reports | `MEMORY/WORK/archive/{item-id}.json` |

---

## Examples

**Start autonomous processing:**
```
User: work start
Kaya: Loaded 5 items. DAG valid. 3 ready, 2 blocked.
      Batch 1: Engineer agent (project A, sonnet), Architect agent (project B, opus).
      Budget check: $12/$100 (12%). OK.
      Batch 1 complete. 2/2 verified. Budget: $23/$100.
      Queue complete. 5/5 done.
```

**Parallel research:**
```typescript
// 4 parallel researchers
Task({ subagent_type: "ClaudeResearcher", model: "sonnet", prompt: "Research X..." })
Task({ subagent_type: "GeminiResearcher", model: "sonnet", prompt: "Research X..." })
Task({ subagent_type: "GrokResearcher", model: "sonnet", prompt: "Research X..." })
Task({ subagent_type: "CodexResearcher", model: "sonnet", prompt: "Research X..." })
```

---

## Voice Notification

Voice lines summarize progress factually:
- "Loaded five items. Spawning three agents across two projects."
- "Queue complete. Five done, zero failed, twenty-three dollars spent."

---

## Customization

- `--max-parallel N` — Control concurrent agents (default: 3)
- `--total-budget N` — Set budget cap (default: $100)

---

**Last Updated:** 2026-02-22
