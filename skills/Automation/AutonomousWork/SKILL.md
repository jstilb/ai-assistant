---
name: AutonomousWork
description: Small support library for the spec pipeline and LucidTasks (WorkQueue, Integrator, JmTaskBridge, LLM spec comprehension). It does not run work; the LucidTasks autonomous executor runs work. USE WHEN WorkQueue internals, Integrator merge approval, JmTaskBridge resolve, spec comprehension, OR comprehension fidelity log.
---

# AutonomousWork

This skill is now a small library. It does not run work.

**The real engine is the LucidTasks autonomous executor** (`skills/Productivity/LucidTasks/Tools/executor/executor.ts`, launchd `com.kaya.cron.autonomous-executor`, 19:00 daily). To have Kaya do work, give a LucidTask `disposition=autonomous`. See `Commands/work.md` and `skills/Productivity/LucidTasks/SKILL.md`.

The old Spec Executor (Lane B) — WorkOrchestrator, HeadlessWorkDriver, CompletionPipeline, SkepticalVerifier, LiveVerifier, prompts and workflows — was deleted on 2026-11-05 (Jm: "we only really use the autonomous executor"). The nightly job `autonomous-work-nightly` was retired with it. It processed 0 items in 32 runs after 2026-10-05.

## What is left

| File | What it does | Live caller |
|------|--------------|-------------|
| `Tools/WorkQueue.ts` | Work-item facade over the QueueRouter `pipeline.db` store (DAG, status transitions) | QueueRouter (`lib/vocabulary.ts`, tests), Integrator, JmTaskBridge |
| `Tools/Integrator.ts` | Merge lane for verified work items (`approve`, merge to `main`, PR mode) | `QueueRouter/Tools/WaitingOnJm.ts` (daily SystemHealthDigest) |
| `Tools/JmTaskBridge.ts` | Resolves HUMAN proxy items when Jm closes the linked LucidTask | `LucidTasks/Tools/TaskManager.ts` (spawned on task close) |
| `Tools/LLMSpecComprehension.ts` | One LLM call that reads a spec and returns its ISC rows | `QueueRouter/Tools/TestStrategyGenerator.ts` |
| `Tools/ComprehensionFidelityLog.ts` | Appends each live comprehension to `MEMORY/MONITORING/comprehension-parity.jsonl` | LLMSpecComprehension; read by the Evals isc-extraction eval |
| `Tools/Types.ts` | Shared types (ISCRow, ComprehendedSpec, InferenceFn, …) | the files above |

`Tools/__tests__/EscalationHelper.test.ts` is the real-TaskDB test for `lib/core/EscalationHelper.ts`.

## CLI

```bash
bun skills/Automation/AutonomousWork/Tools/WorkQueue.ts status
bun skills/Automation/AutonomousWork/Tools/Integrator.ts approve <id> [--merge] [--strategy pr|direct]
bun skills/Automation/AutonomousWork/Tools/JmTaskBridge.ts resolve --lucid-task-id <id>
bun skills/Automation/AutonomousWork/Tools/JmTaskBridge.ts list
```

## Runtime data

`MEMORY/AutonomousWork/` holds old run data (live-verification snapshots, work-queue history). The Evals NightlyJudge still reads it. Do not delete it with this skill.
