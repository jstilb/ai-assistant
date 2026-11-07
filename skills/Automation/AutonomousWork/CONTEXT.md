# AutonomousWork

A small support library for the spec pipeline and LucidTasks. It does not run work. The LucidTasks **Task Executor** (`skills/Productivity/LucidTasks/Tools/executor/`, disposition `autonomous`) runs work. The old **Spec Executor (Lane B)** (WorkOrchestrator, HeadlessWorkDriver, the verifier stack) was deleted on 2026-11-05.

## Language

**Work Item**:
One queued unit in `pipeline.db` = one spec. `WorkQueue.ts` is the facade over that store.
_Avoid_: ticket, job.

**ISC Row** (Ideal State Criterion):
A single, independently-verifiable acceptance criterion from the spec's ISC table. Carries an optional verification command. `LLMSpecComprehension.ts` extracts the rows from a spec in one LLM call.
_Avoid_: requirement, task, acceptance test.

**HUMAN proxy**:
A blocked Work Item that stands for one human-required ISC Row. It links to a `[Human Action]` LucidTask. `JmTaskBridge.ts` completes the proxy when Jm closes that task.

**Integrator**:
The merge lane for verified Work Items (`approve`, merge to `main`, PR mode). `WaitingOnJm.ts` reads its merge-approval state for the daily digest.

## Relationships

- **QueueRouter** owns `pipeline.db`; `WorkQueue.ts` and `QueueRouter/Tools/lib/vocabulary.ts` translate between WorkItem and PipelineItem (ADR-003).
- **LucidTasks** spawns `JmTaskBridge.ts resolve` when a task with a `queue_item_id` closes.
- The **Task Executor** imports nothing from this skill.
