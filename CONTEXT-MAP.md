# Context Map

Kaya is a multi-context repo: domain glossaries live next to the skill they describe as `CONTEXT.md`, with architectural decisions in that skill's `docs/adr/`. This map lists the contexts and how they relate. It is maintained by the GrillWithDocs interactive grill (`/queue grill`) — every grill that creates a skill's first `CONTEXT.md` adds its entry here (see `skills/Automation/QueueRouter/docs/adr/0001-grill-writes-docs-specgen-reads.md`).

## Contexts

- [QueueRouter — Spec Pipeline](./skills/Automation/QueueRouter/CONTEXT.md) — routes LucidTasks into the spec pipeline, grills for context, researches, generates specs, and gates them by approval. The **producer** of approved work.
- [SpecSheet — UX/UI Spec Generation](./skills/Agents/SpecSheet/CONTEXT.md) — produces development-ready UX/UI specifications; runs as a stage inside the spec pipeline when an item's surface is `browser`/`native`.
- [AutonomousWork](./skills/Automation/AutonomousWork/CONTEXT.md) — executes an approved spec by decomposing it into vertical slices and driving build→verify agent loops. The **consumer** of approved work.
- [InformationManager — Scratchpad & Vault Context](./skills/Productivity/InformationManager/CONTEXT.md) — routes scratchpad captures into tasks/notes/lists using the vault folder map, and owns the freshness machinery that keeps that map current. Captures are **dumb writes** (tasks land in inbox with `disposition=null`); unified context-driven triage via `Workflows/Triage-Inbox.md` + `Workflows/Organize-ScratchPad.md` (both reading `docs/InformationLayout.md`) assigns dispositions, replacing the retired TypeScript `KayaRouter`. The **upstream feeder** of QueueRouter's triage (scratchpad → LucidTasks inbox → InboxTriage agent).
- [CalendarAssistant — Proactive Scheduling](./skills/Productivity/CalendarAssistant/CONTEXT.md) — Jm's calendar domain: the reactive CRUD/intelligence skill plus the planned two-agent planning loop (Planner / Feedback-Learner / Kaya Blocks / Tiered Authority).
- [Canvas — Kaya Desktop Surface](./apps/Canvas/CONTEXT.md) — the greenfield Kaya desktop UI (Bun-served localhost web app): Mission Control visibility, code-first Panels, Agent SDK Session Backend. Replaces archived canvas v1.
- [LifeOS — Personal Operating System](./skills/Productivity/LifeOS/CONTEXT.md) — Jm's life-capture domain: Captures route through the Router into per-domain Logs (today: Workbook tabs), read back via a planned Query API and a local web Dashboard.
- [AutoMaintenance — Recurring Upkeep & Tech Debt](./skills/Automation/AutoMaintenance/CONTEXT.md) — scheduled maintenance jobs plus the tech-debt registry: broad capture (Self-Report / Audit Scan / Manual Capture), pure-LLM Priority Scoring, and weekly throttled Promotion of top debt into the spec-pipeline. A **second upstream producer** feeding QueueRouter.
- [Adventure — Experiences & Plans](./skills/Life/Adventure/CONTEXT.md) — experience ideas, plans, and recorded outings.
- [Cooking — Recipes & Cuisine Practice](./skills/Life/Cooking/CONTEXT.md) — recipes, cuisine projects, and cooking practice.
- [LucidTasks — Task State & Routing](./skills/Productivity/LucidTasks/CONTEXT.md) — task status, disposition, priority, Icebox parking, and the Task Executor (Lane A).

## How they relate

The pipeline runs producer → consumer: **QueueRouter** turns a raw task into an approved spec (invoking **SpecSheet** for UI surfaces along the way), then **AutonomousWork** executes that spec. The **Task Executor (Lane A)** is a separate path from LucidTasks' autonomous disposition to bounded task execution; the **Spec Executor (Lane B)** consumes approved spec-pipeline work. Vocabulary is owned where it is produced: task state in LucidTasks, routing/grilling terms in QueueRouter, UX/UI artifact terms in SpecSheet, build/verify terms in AutonomousWork. When a term crosses a seam (e.g. **Surface**, **Slice**/**Phase**), the owning context defines it and the others reference it. **AutoMaintenance** feeds QueueRouter from the side: its weekly Promotion turns top-scored Tech Debt Items into spec-pipeline items (with context pre-attached, skipping the grill).
