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
| `WorkOrchestrator.ts` | `init`, `next-batch`, `prepare <id>`, `started <id>`, `verify <id>`, `complete <id>`, `fail <id>`, `status` | Queue orchestration, ISC prep, verification pipeline |
| `WorkQueue.ts` | (programmatic) | Single-file queue with DAG, status transitions |
| `CapabilityRouter.ts` | `--row "..." --effort STANDARD --output json` | Map ISC rows to Task invocation specs |
| `BudgetManager.ts` | `init`, `check --queue`, `status` | Dual-scope budget tracking |
| `SkepticalVerifier.ts` | (programmatic) | Three-tier independent verification |
| `ProjectRegistry.ts` | `resolve-batch --ids "..."` | Project path resolution |
| `SpecParser.ts` | (programmatic) | Parse spec markdown into ISC rows |
| `ConvergenceDetector.ts` | (programmatic) | Track loop trajectory for ralph loops |

---

## ISC Routing

Each ISC row routes via CapabilityRouter to an execution mode:

| Mode | When | How |
|------|------|-----|
| **task** | Non-TRIVIAL rows | `Task({ subagent_type, model })` |
| **ralph_loop** | Iterative rows | `Bash("./loop.sh")` with quality gates |
| **inline** | TRIVIAL only | Handle directly in orchestrator session |

---

## Safety Model

- **Git is the safety net** — feature branches, frequent commits
- **Catastrophic actions always blocked** — `git push --force main`, `rm -rf /`, `DROP DATABASE`
- **Verification required** — SkepticalVerifier (3-tier) before any item marked complete
- **Budget guardrails** — hard stop at 95%, warning at 75%

---

## Integration

### Uses
- **THEALGORITHM** — EffortClassifier, CapabilitySelector (called as subprocesses)
- **_RALPHLOOP** — loop.sh template, BudgetTracker, ConvergenceDetector
- **QueueRouter** — Approval flow, approved-work queue (JSONL source)

### Output Locations
| Type | Location |
|------|----------|
| Queue state | `MEMORY/WORK/work-queue.json` |
| Budget state | `MEMORY/WORK/budget-state.json` |
| Work reports | `MEMORY/WORK/archive/{item-id}.json` |

---

## Examples

**Start autonomous processing:**
```
User: work start
Kaya: Loaded 5 items. DAG valid. 3 ready, 2 blocked.
      Batch 1: Engineer agent (project A), Architect agent (project B).
      Batch 1 complete. 2/2 verified. Budget: $23/$100.
      Queue complete. 5/5 done.
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

**Last Updated:** 2026-02-17
