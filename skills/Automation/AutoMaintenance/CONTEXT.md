# AutoMaintenance — Recurring Upkeep & Tech Debt

Kaya's recurring-upkeep domain: scheduled daily/weekly/monthly maintenance jobs, and (per the 2026-06-12 grill of mnt5g1se) the home of the tech-debt registry — capture, scoring, and weekly promotion of debt into the spec-pipeline.

## Language

**Tech Debt Item**:
A recorded imperfection in the Kaya system — intake is deliberately broad with no severity bar; the Priority Score carries the signal.
_Avoid_: issue, finding, TODO

**Tech Debt Registry**:
The machine-first JSONL store (`MEMORY/QUEUES/tech-debt.jsonl`) holding all Tech Debt Items, reusing QueueManager CRUD.
_Avoid_: tracker file, debt log, TECH_DEBT.md

**Write Path**:
One of exactly three ways a Tech Debt Item is created: **Self-Report**, **Audit Scan**, or **Manual Capture**.

**Self-Report**:
An AutonomousWork build agent recording shortcuts it took (workarounds, skipped tests, suppressed errors) via the `debtIncurred` field in its completion results — always optional and non-blocking.

**Audit Scan**:
The weekly AutoMaintenance LLM scan of the codebase that files new Tech Debt Items; its first run produces the **Baseline Inventory**.

**Manual Capture**:
Jm filing a Tech Debt Item directly via CLI/chat command.

**Priority Score**:
The pure-LLM composite (severity × impact × effort) assigned at intake — no human review; the approvals gate on promoted work is the backstop.
_Avoid_: severity (alone), ranking

**Promotion**:
Converting a top-scored Tech Debt Item into a spec-pipeline item with notes + researchGuidance attached (so it skips grilling) — automatic, weekly, throttled.
_Avoid_: escalation, scheduling

**In-Flight Cap**:
The throttle on Promotion: at most N (1–2) promoted Tech Debt Items may be active in the work loop at once.

**Baseline Inventory**:
The one-time population of the Registry by the first Audit Scan over the existing codebase.

## Relationships

- A **Write Path** creates a **Tech Debt Item** in the **Tech Debt Registry**
- Every **Tech Debt Item** receives a **Priority Score** at intake (pure LLM)
- **Promotion** moves the top-scored **Tech Debt Item** into the spec-pipeline, subject to the **In-Flight Cap**
- A Tech Debt Item's lifecycle: open → promoted → fixed / wontfix
- KayaUpgrade **reads** the Registry; it never writes or promotes

## Example dialogue

> **Dev:** "An audit found 40 nitpicks — should I filter them before they hit the **Registry**?"
> **Domain expert:** "No — intake is broad by design. File them all; the **Priority Score** decides what surfaces, and **Promotion** only ever moves the top item within the **In-Flight Cap**."

## Flagged ambiguities

- "tracker" was used to mean both the store and the whole feature — resolved: the store is the **Tech Debt Registry**; the feature is the registry plus its three **Write Paths** and **Promotion** loop.
- Home was ambiguous between KayaUpgrade and AutoMaintenance — resolved: AutoMaintenance owns scan + promotion (weekly jobs); KayaUpgrade is read-only consumer.
