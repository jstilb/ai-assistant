---
status: accepted
---

# Auto-slice in the pipeline, gated by an automated validity check

The spec-pipeline LLM authors the Slices section during spec generation. There is **no human checkpoint** on slice boundaries. Boundary quality rests on the LLM plus an automated **slice-validity check** that enforces: every ISC row maps to exactly one slice, no overlaps or gaps, and each slice declares a surface + a verify method.

## Why

AutonomousWork is autonomous by design (the LucidTasks→spec-pipeline triage is already LLM-driven with no manual tagging). A human-confirm step on every spec's slicing would break that posture. Human-confirmed slicing was rejected for this reason; the automated validity check substitutes for the human eye on the one thing the downstream live gates cannot catch — a malformed *boundary* (the per-slice live gate only loops the Builder on bad implementation; it never re-slices).

## Consequences

- The validity check is a hard gate alongside the SliceGate (ADR-0002): a spec whose slices fail validity is parked back to grilling, same as an unsliced spec.
- Slice-boundary *taste* (is this genuinely the thinnest demoable cut?) is not enforced — only structural completeness. If boundary quality proves poor in practice, revisit with a "slice critic" agent before adding a human checkpoint.
