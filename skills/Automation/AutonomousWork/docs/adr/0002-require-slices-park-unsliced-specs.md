---
status: accepted
---

# Require slices: park unsliced specs instead of running them

A spec with no Slices section is **parked** at prepare-time and routed back through the grill/spec-pipeline to acquire slices before it can execute. It is never run as an implicit single slice. Chosen over an implicit-single-slice fallback and over a one-time queue migration.

## Why

The retrofit's purpose (ADR-0001) is that AutonomousWork genuinely builds in vertical slices with per-slice live verification. A coarse "whole item = one slice" fallback would quietly bypass the methodology for exactly the large, risky specs that most need slicing — so the gate is hard, not degraded.

## Consequences

- **The spec-pipeline becomes a hard upstream dependency:** it MUST emit sliced specs. The retrofit's value is bounded by the pipeline's slicing quality.
- **Reuse existing machinery:** detection of `spec.slices.length === 0` parks the item via the `parkForGrill` / `needs-grilling` mechanism (a `needs-slicing` disposition, or an extension of `needs-grilling`) rather than a bespoke gate.
- **A SliceGate runs at prepare-time**, before any agent spawn — an unsliced spec produces zero Builder/Verifier/Runtime activity.
- **Migration is implicit-by-attrition:** each parked flat spec gets sliced when it is re-grilled; no big-bang migration pass. In-flight flat specs are parked until then — accepted.
