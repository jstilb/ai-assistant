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
| `ExecutiveOrchestrator.ts` | (programmatic) | Top-level queue management: loads batches, spawns TaskOrchestrators, spot-checks 2–3 ISC rows per item, approves or rejects completion |
| `TaskOrchestrator.ts` | (programmatic) | Per-item Builder/Verifier loop: runs Builder Agent and Verifier Agent sequentially, injects structured feedback on FAIL, detects stall, escalates NEEDS_REVIEW |
| `WorkOrchestrator.ts` | `init`, `next-batch`, `prepare <id>`, `started <id>`, `verify <id>`, `complete <id>`, `fail <id>`, `status` | Queue orchestration, ISC prep, verification pipeline |
| `WorkQueue.ts` | (programmatic) | Single-file queue with DAG, status transitions |
| `CapabilityRouter.ts` | `--row "..." --effort STANDARD --output json` | Map ISC rows to Task invocation specs |
| `format-isc-table` | (CLI subcommand) | Format ISC rows for agent prompts |
| `mark-phase-done` | (CLI subcommand) | Mark a phase complete and advance |
| `SkepticalVerifier.ts` | (programmatic) | Three-tier independent verification (supplementary post-loop check) |
| `ProjectRegistry.ts` | `resolve-batch --ids "..."` | Project path resolution |
| `SpecParser.ts` | (programmatic) | Parse spec markdown into ISC rows |
| `ConvergenceDetector.ts` | (programmatic) | Track loop trajectory for ralph loops |

## Prompts

Agent prompt templates used by TaskOrchestrator. Template variables (`{{VAR}}`) are filled before spawning.

| Prompt | Location | Used By | Purpose |
|--------|----------|---------|---------|
| `BuilderPrompt.md` | `Prompts/BuilderPrompt.md` | TaskOrchestrator → Builder Agent (Engineer) | System prompt for the Builder: implement ISC rows, write tests, commit, return JSON. On iteration > 1: includes `{{VERIFIER_FEEDBACK}}` table of FAIL rows from previous Verifier run. |
| `VerifierPrompt.md` | `Prompts/VerifierPrompt.md` | TaskOrchestrator → Verifier Agent (Explore) | System prompt for the Verifier: independently extract ISC rows from spec, verify each row using Glob/Grep/Read, check test quality, return structured VerifierReport JSON. |

---

## Architecture

```
ExecutiveOrchestrator (queue management, spot-check 2-3 rows, final approval/rejection)
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
  SkepticalVerifier supplementary check → report to ExecutiveOrchestrator → done

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
      "linkedTest": "ExecutiveOrchestrator.test.ts::should load queue and spawn task orchestrators",
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

Each ISC row routes via CapabilityRouter to an execution mode:

| Mode | When | How |
|------|------|-----|
| **task** | Non-TRIVIAL rows | `Task({ subagent_type, model })` |
| **ralph_loop** | Iterative rows | `Bash("./loop.sh")` with quality gates |
| **inline** | TRIVIAL only | Handle directly in orchestrator session |

---

## Model Routing per Effort Level

CapabilityRouter maps effort classifications to models. Override explicitly when needed.

| Effort Level | Default Model | Rationale |
|-------------|--------------|-----------|
| **TRIVIAL** | inline (no agent) | Handle in orchestrator session, no spawn cost |
| **LOW** | `haiku` | Simple verification, file checks, quick research |
| **STANDARD** | `sonnet` | Implementation, research, analysis (80% of work) |
| **HIGH** | `sonnet` | Complex multi-file work (Sonnet handles well) |
| **CRITICAL** | `opus` | Architecture decisions, novel reasoning, algorithm work |

**Cost Impact:** Routing STANDARD work to Sonnet instead of Opus saves ~80% per call.

```typescript
// CapabilityRouter output example
{
  "mode": "task",
  "subagent_type": "Engineer",
  "model": "sonnet",     // Automatically selected from effort classification
  "rationale": "STANDARD effort, implementation task → sonnet"
}
```

---

## Agent Frontmatter Requirements

All agents used by AutonomousWork must have correct frontmatter. The orchestrator relies on these fields.

### Required Fields

```yaml
---
name: AgentName                        # Matches subagent_type in Task()
model: sonnet                          # or opus for critical reasoning agents
maxTurns: 30                           # Prevents runaway agents
permissionMode: bypassPermissions      # Required for autonomous (off-hours) agents
permissions:
  allow:
    - "Bash"
    - "Read(*)"
    - "Write(*)"
    # ... other required tools
---
```

### Agent Tier Configuration

| Agent | Model | maxTurns | permissionMode | Role |
|-------|-------|----------|----------------|------|
| Architect | opus | 50 | — | Novel architectural reasoning |
| Algorithm | opus | 50 | — | ISC precision reasoning |
| Engineer | sonnet | 50 | — | TDD implementation |
| Designer | sonnet | 30 | — | Design work |
| Artist | sonnet | 30 | — | Visual content |
| QATester | sonnet | 30 | — | Verification |
| Intern | sonnet | 30 | bypassPermissions | General/parallel work |
| Pentester | sonnet | 30 | — | Security assessment |
| ClaudeResearcher | sonnet | 25 | bypassPermissions | Research |
| GeminiResearcher | sonnet | 25 | bypassPermissions | Multi-perspective research |
| GrokResearcher | sonnet | 25 | bypassPermissions | Contrarian research |
| CodexResearcher | sonnet | 25 | bypassPermissions | Technical research |

**`permissionMode: bypassPermissions`** is required on agents that run autonomously (off-hours, background). Without it, agents stall on permission prompts.

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

// When CapabilityRouter returns mode=task and agent will git:
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

1. **Never run opus when sonnet suffices** — CapabilityRouter enforces this by default
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
- **Catastrophic actions always blocked** — `git push --force main`, `rm -rf /`, `DROP DATABASE`
- **Verification required** — SkepticalVerifier (3-tier) before any item marked complete
- **Loop guardrails** — retry escalation and stall detection prevent infinite loops

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
