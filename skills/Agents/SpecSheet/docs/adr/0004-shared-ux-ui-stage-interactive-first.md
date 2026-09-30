# One shared UX/UI Stage, run before ISC derivation, rolled out interactive-first

The **UX/UI Stage** — the orchestration that spawns UXDesigner → UIDesigner → Designer — is a single shared module invoked by both the automated spec pipeline and the interactive `CurrentWork` / `CreateSpec` workflows, not forked per mode. Because **ISC Row**s are derived from the **Screen×State Matrix** and acceptance criteria the UX skill produces, the Stage must run *after* base-spec generation and *before* ISC derivation and the ISC quality gate (in the pipeline: between `generating-spec` and the gate). We roll it out **interactive-first** so UX/UI output quality is validated with a human in the loop before the pipeline runs it unattended into AutonomousWork.

## Considered Options

- **Fork pipeline vs interactive implementations.** Rejected: duplication-drift.
- **Pipeline-first rollout.** Rejected: runs unvetted UX/UI output autonomously before a human has seen its quality.
- **Pipeline-only (no interactive entry).** Rejected: interactive users miss the feature and the logic gets duplicated later to add it.
