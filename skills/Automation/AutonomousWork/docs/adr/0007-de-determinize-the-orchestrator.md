---
status: accepted
---

# De-determinize the AutonomousWork orchestrator

Following the Kaya-wide principle **"Determinism must earn its place"** (default to the LLM; keep
determinism only where it guards the LLM's own judgment — exit codes, safety boundaries, atomic
state, orchestration plumbing — never as silent content-interpretation), this refactor strips the
orchestrator of the heuristic machinery that second-guessed the now-always-running LLM judge. The
judge (Gate 3) owns completeness/convention/quality; the deterministic floor keeps only objective
ground-truth. Earlier rounds did the same for the queue, spec-sheet, and comprehension layers; this
ADR records the same cut applied to `WorkOrchestrator` / `ExecutiveOrchestrator` / `SkepticalVerifier`
themselves. Done as slices S0–S7 on `refactor/orchestrator-dedeterminize`.

## What was cut (and why it didn't earn its place)

- **S1 — CostTracker** removed entirely; `nextBatch` never refuses on budget. Cost gating was a
  silent containment that hid work, not a correctness guard.
- **S2 — verification skip-gating + `category`/`ISCRowCategory`/`inferCategory`.** The LLM judge now
  **always runs** (no category-based skip), and the two category-coupled completion gates +
  Tier1 Checks 9/10 went with it.
- **S3 — `classifyFailure` regex → structured `faultClass`.** Fault class flows from structured
  signals set at origin (the verifier's `SkepticalReviewResult.faultClass`, `ISCRow.infraFault`
  tagged at the `CommandRunner` throw-site, `metadata.environmentBlockCount`, and the exact
  `LIVE_VERIFICATION_ENVIRONMENT_BLOCK` sentinel) instead of regexing error prose. `OrphanRecovery`
  derives a structured class from item metadata rather than passing a bare string.
- **S4 — the retry-strategy ladder.** Deleted `RetryStrategy`/`nextRetryStrategy`, the `"re-prepare"`
  branch (prepare() now always regenerates a fresh ISC), and `mergePreserved`/`_preservedRows`.
- **S5a — the `weakRatio>0.5` ISC quality gate** in `prepare()` (grading the LLM's own ISC output).
- **S5b — title-regex phase-DAG inference** (`wirePhaseDependencies`/`parsePhaseNumber` + the
  getReadyItems phase tiebreaker). Replaced with a **warn-on-detect** in `init()`; ordering now comes
  from explicit dependencies + the follow-on engine.
- **S5c — pre-judge precomputation:** `annotateWithTestStrategy`, `inferVerificationFromSpecContext`,
  and `ExecutiveOrchestrator.spotCheck` Steps 2–4 (FAIL-first row selection, evidence/linkedTest
  content concerns, linkedTest null-ratio "signals"). The `verify()` circuit breaker's
  `JSON.stringify(concerns)` content compare became a plain consecutive-FAIL counter (fires at ≥3).
- **S5d — Tier1 content-interpretation checks 13/14/15** (HTTP/state keyword regex →
  CachedHTTPClient/StateManager convention penalties; code-density "stub" score; ISC-description
  file-ref vs diff coherence).
- **S6 — silent swallows → `lib/core/FailureLog.ts`.** Fire-and-forget/empty catches in
  `CompletionPipeline`, `FollowOnLoops`, `TransitionGuard.appendAuditLog`, and `WorkOrchestrator`
  now route to the central failure log. Silent machinery = false confidence = blindness.
- **S7 — `ExecutiveOrchestrator` class → plain functions** `spotCheck()` / `status()` (no cross-call
  state, zero programmatic callers). The file + CLI entrypoint stay (Orchestrate.md hardcodes them).

## Keep-ledger (deliberately retained — these earn their place)

The state-transition matrix, file/process locks, the dependency DAG, the git-safety boundary
(`isCatastrophic`/protected-branch), **real command/test exit-code verification** (Tier1 Checks 17–19
+ `spotCheck`'s verification-command re-run), atomic partial-completion state
(`ISCManager.markDone`/`completedPhases`/`triagePending`), the `native → HUMAN_REQUIRED` lock,
**fault-aware re-staging** (infra/env faults do not burn the retry counter), and the **attempt-cap →
escalate-loud to a human-proxy `blocked` item** (the endorsed generous backstop that fails loud).

## Consequences

- A stale `category`/`nextRetryStrategy`/`_preservedRows` on an in-flight item is a harmless orphan
  key — no live code reads it (same precedent as prior de-determinization rounds). Not scrubbed.
- Tier1 (Gate 1) is now an objective-ground-truth floor only; any "is this complete / does it follow
  convention / is it a stub" judgment is the always-running judge's call.
- Phase ordering must be expressed as explicit dependencies (spec-gen / the follow-on engine emit
  them); a phase-named item without explicit deps is now *ready*, with a loud `init()` warning.
- Built and verified in an isolated `git worktree` (`EnterWorktree`) to survive the serialized
  Integrator's concurrent churn of the shared tree.
