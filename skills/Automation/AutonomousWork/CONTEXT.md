# AutonomousWork

The orchestrator-of-orchestrators that executes queued development work autonomously: it decomposes a spec into units, drives independent build/verify agent loops, and gates completion behind verification. This document fixes the vocabulary so "slice", "phase", and "verification" mean one thing each.

## Language

**Slice**:
A vertical feature cut through every layer it touches (schema → API → UI → tests), demoable on its own, that ends with a live-verification run before the next slice starts. The unit the build→verify loop iterates over. **Realized in the spec as a vertical `Phase` block** (see Phase) — "Slice" is the design principle, "Phase" is the markdown token.
_Avoid_: chunk, batch.

**Phase**:
The markdown realization of a **Slice** in a spec: a `Phase N: Title` heading followed by a `<!-- ISC: 1,2,3 -->` row-mapping comment, Given/When/Then acceptance bullets, and an optional `<!-- HORIZONTAL: reason -->` escape hatch. The spec-pipeline's `validateSliceShape` gate guarantees a multi-phase spec's `Phase 1` is vertical (demoable), not infra-only. _Deprecated_ is only the **positional/horizontal** use of phases (splitting a flat ISC list into equal context-management chunks) — that fallback fires solely when no `<!-- ISC -->` mapping exists.
_Avoid_: using "phase" to mean a horizontal layer.

**ISC Row** (Ideal State Criterion):
A single, independently-verifiable acceptance criterion from the spec's ISC table. Belongs to exactly one **Slice**. Carries an optional verification command.
_Avoid_: requirement, task, acceptance test.

**Work Item**:
One queued unit = one spec. Contains one or more ordered **Slices**.
_Avoid_: ticket, job.

**Live verification**:
Verification by running the actual system — real browser interaction, real CLI/API calls, e2e against a running server — not grep, file-existence, or unit-tests-alone. The mandatory per-slice gate.
_Avoid_: validation, QA (too broad).

**RuntimeVerifier**:
The module that performs **live verification** (a.k.a. "Gate D"): boots a dev server, health-polls, then runs Playwright (browser) / bun test (cli, api, integration) against the running system. Wired and mandatory: `WorkOrchestrator` populates `liveVerificationInput` for every item and effort tier, and **Phase L** (`Tools/lib/verifier/PhaseL.ts`, driven by `LiveVerifier.ts` inside `SkepticalVerifier`) hard-blocks completion on "no live evidence."
_Avoid_: e2e runner, test runner.

**Work Surface**:
What kind of interface a **Work Item** touches — it selects the **RuntimeVerifier** live-verification strategy. The consumer's `WorkSurface` type is `browser | cli | api | integration | native` (`SurfaceClassifier.ts`). The **producer** (spec-pipeline) emits a different enum — `browser | native | cli | api | library` (`KayaTaskClassifier.ts`) — so the consumer **bridges**: it reads the producer's LLM-classified `surface` first (`browser→browser, cli→cli, api→api, native→native, library→integration, daemon→integration`), and only falls back to the keyword/diff heuristic when no producer surface is present (ADR-0006). Strategies: `browser` → dev server + Playwright + screenshot→Read; `cli`/`api`/`integration` → `bun test`; `native` → **human/device-required** (no iOS sim / Android emulator / Detox / Appium in this environment) — runs available unit/integration tests as non-gating evidence, then dispositions the native UI rows `human-required` so the item is never auto-DONE without a device check.
_Avoid_: platform, target.

**HeadlessWorkDriver**:
The headless queue driver (`Tools/HeadlessWorkDriver.ts`) that selects work items and invokes the current work orchestration path.

**WorkOrchestrator**:
The per-work-item orchestrator (`Tools/WorkOrchestrator.ts`) that drives the build→verify loop over **Slices**. The older `TaskOrchestrator` name refers to a deleted class.

**Builder**:
The agent role that writes implementation and tests for a slice.

**Verifier**:
The independent agent role that adversarially checks the Builder's work against the ISC rows. Structurally forbidden from trusting the Builder's claims.
_Avoid_: reviewer, checker.

**TestWriter**:
The agent that writes spec-driven tests before implementation exists. Today runs once per work item (all tests up front); the hybrid-retrofit decision re-scopes it to once per slice.

## Relationships

- A **Work Item** contains one or more ordered **Slices**.
- A **Slice** is realized as a vertical **Phase** block (`Phase N` heading + `<!-- ISC: … -->` mapping).
- A **Slice** groups one or more **ISC Rows** and owns one **Live verification** command.
- **WorkOrchestrator** drives one **Builder** → **Verifier** loop per **Slice**, not per work item.
- **Live verification** is performed by **RuntimeVerifier**; a **Slice** is not done until its live-verification command passes.
- **HeadlessWorkDriver** selects work items for **WorkOrchestrator**.

## Example dialogue

> **Dev:** "The spec has 14 ISC rows — is that 14 slices?"
> **Domain expert:** "No. A **Slice** is a demoable vertical cut. Those 14 **ISC Rows** might group into 3 **Slices** — e.g. 'read a post end-to-end' is one slice owning 5 of those rows plus its own live-verify command."
> **Dev:** "And a slice passes when its unit tests pass?"
> **Domain expert:** "No — unit tests are a behaviour lock. The slice passes when **live verification** passes: the real page renders in a browser with zero console errors, or the real CLI returns real data. That's the gate before the next slice."

## Flagged ambiguities

- "phase" was used to mean both (a) a positional ISC chunk for context management and (b) a vertical feature slice. **Resolved:** **Slice** and **Phase** are the same concept — a Slice is *realized* as a vertical `Phase` block, and the spec-pipeline's `validateSliceShape` guarantees verticality. Only the *positional/horizontal* use of phases is deprecated (it survives as a fallback when no `<!-- ISC -->` mapping is present).
- "verification" was used for both static checks (grep/file-exists/unit tests) and running the real system. **Resolved:** running the real system is **Live verification**; reserve "verification" unqualified for the adversarial Builder-vs-**Verifier** check.

## Determinism boundary

The LLM **judge** (Gate 3) **always runs** and owns all content judgment — completeness, convention,
quality, "is this a stub". The deterministic floor keeps only objective ground-truth: command/test
**exit codes**, git-diff presence + independent cross-validation, the state-transition matrix, locks,
the dependency DAG, the git-safety boundary, atomic partial-completion state, the `native → HUMAN_REQUIRED`
lock, fault-aware re-staging, and the attempt-cap escalate-loud backstop. That exit-code re-run (a cheap
pre-gate) lives in Gate 1 (`WorkOrchestrator.verify()`/`verifyPhase()`'s per-row command re-run) — the
standalone **Executive** spot-check was deleted in L3 as a duplicate of Gate 1 — and `classifyFailure`/retry
read **structured** fault signals, not error prose. Heuristics that re-interpreted ISC-description prose or
guessed code quality were removed. See **ADR-0007** for the full cut + keep-ledger and the guiding principle
("determinism must earn its place").

## Retrofit plan disposition

`docs/RETROFIT-PLAN.md` (the S1–S6 execution roadmap) is removed — superseded by **ADR-0005**
(Slice realized as vertical Phase), which reconciles what shipped (S1, S4, S6 — via the existing
Phase mechanism, not a new Slice schema) against what was dropped as redundant (S2/S3/S5: no
separate Slice type/section; `needs-grilling` reused instead of a new `needs-slicing` status).
See `docs/adr/0005-slice-realized-as-vertical-phase.md` for the full disposition.
