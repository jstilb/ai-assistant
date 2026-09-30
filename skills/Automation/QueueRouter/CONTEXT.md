# QueueRouter — Spec Pipeline

How LucidTasks become approved, executable work: items are routed into the spec pipeline, gain context (autonomously or via a human grill), are researched, turned into a spec, and gated by approval before AutonomousWork executes them. This document fixes the routing and grilling vocabulary so "grill", "context", and "verdict" mean one thing each. Terms about *building* a spec's work (Slice, Phase, ISC Row, Live verification) belong to [AutonomousWork](../AutonomousWork/CONTEXT.md); terms about *UX/UI spec generation* (Stage, Surface, Screen Inventory) belong to [SpecSheet](../../Agents/SpecSheet/CONTEXT.md).

## Language

**Spec Pipeline**:
The queue that carries an item from `intake` or `needs-grilling` through `researching`, `generating-spec`, and `awaiting-approval`. These are persisted `pipeline_items.stage` values; one item = one prospective spec.
_Avoid_: workflow, flow.

**Interactive Grill**:
The human-present **GrillWithDocs** interview run by `/queue grill` (`GrillTask.md`) on a `needs-grilling` item. Fills the context gap *and* sharpens the item's domain glossary. Human-only — never headless/cron/`claude -p`.
_Avoid_: grill (ambiguous — see Flagged ambiguities), interview, GrillMe.

**Autonomous Lens**:
The headless `GrillMeLens` directive generator run inside the research phase: a fast inference call turns the item into 3–5 analytical research directives (Dependencies, Pre-mortem, …). No human, produces no docs.
_Avoid_: grill, GrillMe (it is *derived from* GrillMe's lens pool, but is not the interview).

**needs-grilling**:
The parked state an item enters when the pipeline judges it lacks sufficient context for autonomous research. Cleared only by an **Interactive Grill**.
_Avoid_: blocked, stuck.

**Grill Brief**:
The pipeline-generated starting kit for a grill — `missing` (identified gaps) + `suggested_questions`. The opening move, not the whole interview.
_Avoid_: ticket, brief.

**Item Context**:
The grill's output contract fed to research + spec-gen: `notes` (problem context), `researchGuidance` (what to investigate), and optional `scopeHints` (in/out of scope). Distinct from a domain **CONTEXT.md**, which the grill *also* writes but which is consumed as canonical vocabulary, not as item-specific input.
_Avoid_: payload, metadata.

**Research Verdict**:
The required `implement | skip | defer` decision a research run emits. `skip` archives the item (false positive / not worth it); `defer` holds it at `awaiting-context`; `implement` advances it to spec generation.
_Avoid_: result, status.

**Quality Gate**:
The pre-approvals checks a generated spec must pass: the **ISC quality gate** (≥4 specific, non-skeleton ISC rows) and the **slice-shape gate** (a multi-phase spec's Phase 1 is a vertical, demoable **Slice**, not an infra-only layer). A failure bounces the item to `awaiting-context` with remediation guidance.
_Avoid_: lint, validation.

**Revision Budget**:
The 3-rejection allowance a draft spec has in `awaiting-approval`. The third rejection escalates the item for manual intervention.
_Avoid_: retries, attempts.

**Provisional Seed**:
A domain `CONTEXT.md` on its first grill-write — `## Language` terms only, no forced `## Relationships`. Provisional because every later grill *challenges against* whatever is written, so a thin-but-correct seed beats an opinionated-but-wrong one.
_Avoid_: draft, stub.

**Disposition**:
The visible terminal outcome every triaged task must reach: `clear` → spec pipeline, ambiguous → **needs-grilling**, confident human-only → **Skip Digest**. "Zero silent discards" means every task has exactly one recorded disposition, auditable from the run log. (Resolved in the 2026-06-10 grill of mq4kdqs0; pre-dating behavior — `not-executable` → invisible `notExecutable` tag — is the banned **Silent Discard**.)
_Avoid_: outcome, result, silent skip.

**Skip Digest**:
The per-run Telegram message listing the triage run's confident human-only skips — one line each with the classifier's reasoning, plus **Promote**/**Dismiss** inline buttons (mirrors the `aq:*` approvals button pattern). **Promote** parks the task as **needs-grilling**; **Dismiss** records a confirmed discard in the ledger and never deletes or cancels the LucidTask.
_Avoid_: report, notification, summary.

**Softened Tiebreak**:
The classifier's ambiguity rule after the 2026-06-10 grill: when torn between `not-executable` and `needs-grill`, prefer `needs-grill` (parks directly for an **Interactive Grill**). Wrong-clear protection is unchanged — the `clear` confidence bar (`KAYA_TRIAGE_CONFIDENCE`) stays conservative because wrong `clear` verdicts burn research/spec runs and the **Revision Budget**.
_Avoid_: loosened bias (the clear bar did not move).

**Context Digest**:
A compact, maintained one-line-per-entry summary injected into the classifier prompt so "can Kaya do this?" is judged against reality. Four digests: skill capabilities (from SKILL.md descriptions), active projects + TELOS Active-heading goals, recent AutonomousWork completions (track record), and the vault folder map. Distinct from **Item Context** (per-item grill output) and from a domain **CONTEXT.md** (canonical vocabulary).
_Avoid_: context (unqualified), prompt context.

## Relationships

- A LucidTask is routed into the **Spec Pipeline**; if it lacks context it parks as **needs-grilling**, otherwise it goes straight to `researching`.
- An **Interactive Grill** consumes a **Grill Brief**, produces **Item Context**, and writes/updates the primary-domain **CONTEXT.md** (a **Provisional Seed** on first touch).
- The research phase emits a **Research Verdict**; only `implement` reaches spec generation.
- Spec generation injects the domain **CONTEXT.md** vocabulary into its prompt, then enforces the **Quality Gate** before transferring the item to `awaiting-approval` under a **Revision Budget**.
- The **Autonomous Lens** enriches the research phase in parallel; it never replaces the **Interactive Grill** (no human, no docs).
- Triage assigns every task a **Disposition**; the **Softened Tiebreak** routes ambiguity to **needs-grilling**, and confident human-only skips land in the **Skip Digest** (Promote → needs-grilling, Dismiss → confirmed discard).
- The classifier reads the four **Context Digests**; the vault folder map digest is produced by InformationManager's refresh machinery (see [InformationManager](../../Productivity/InformationManager/CONTEXT.md)).

## Example dialogue

> **Dev:** "So `/queue grill` just runs GrillMe on the parked items?"
> **Domain expert:** "It runs the **Interactive Grill** — GrillWithDocs, not GrillMe. The thing called GrillMe in the codebase is the **Autonomous Lens** (`GrillMeLens`), and that runs headless in research. Different path, different output: the lens writes research directives, the grill writes a glossary."
> **Dev:** "And the grill's answers go into the spec how?"
> **Domain expert:** "Two channels. The item-specific answers become **Item Context** (`notes`/`researchGuidance`). The vocabulary becomes the domain **CONTEXT.md**, which spec-gen reads as canonical terms — so even an item that was never grilled inherits it."

## Flagged ambiguities

- "grill" / "GrillMe" meant both the human interview and the headless lens. **Resolved:** the human GrillWithDocs interview is the **Interactive Grill**; the headless directive generator is the **Autonomous Lens** (`GrillMeLens`). Only the Interactive Grill writes docs.
- "context" meant both the grill's per-item output and the durable domain glossary. **Resolved:** per-item output is **Item Context** (`notes`/`researchGuidance`/`scopeHints`); the durable glossary is the domain **CONTEXT.md**; the classifier's injected reality summaries are **Context Digests**.
- "default more tasks to Kaya" (item mq4kdqs0) read as a threshold change. **Resolved in the 2026-06-10 grill:** it means zero **Silent Discards** — every triaged task gets a visible **Disposition**; the `clear` bar itself did not move.
- "skip" meant both the research verdict and the triage discard. **Resolved:** the research-phase decision stays **Research Verdict** `skip`; the triage outcome for human-only tasks is a **Disposition** that lands in the **Skip Digest** — never an invisible tag.
