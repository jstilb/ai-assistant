---
status: accepted
---

# Slice-based hybrid retrofit of AutonomousWork

AutonomousWork verified work statically (grep + `git diff --stat` + one LLM judgment) and decomposed specs into flat ISC rows with positional "phases", while the methodology that actually shipped Information Venture and EventScout was a per-slice loop that ended in a live run. We are retrofitting AutonomousWork so the **Slice** (a demoable vertical cut, authored in the spec) is the unit the build→verify loop iterates over — keeping the multi-agent verification depth rather than replacing it with the lighter ralph loop.

## Loop shape

- **Per slice:** test-first TestWriter → Builder → independent Verifier (static + unit) → **RuntimeVerifier live gate** (deterministic Playwright/CLI/API + a visual screenshot→Read check for browser slices) that **hard-blocks** the next slice.
- **Once at item end:** the heavyweight SkepticalVerifier completion gate, now fed the aggregated `runtimeVerifierInput` + `testExecutionResults` (previously never populated — the dead wiring), plus Executive spot-check and `report-done`.

## Considered options

- **Adopt the lightweight per-slice ralph loop wholesale** (the IV/EventScout engine) — rejected to preserve multi-agent verification depth (independent Builder/Verifier, immutable TestWriter, SkepticalVerifier).
- **Orchestrator-derived slices from flat specs** — rejected; slicing is a design decision better authored upstream where the grill/spec-pipeline can refine it, and LLM clustering drifts back toward the positional-chunk failure it would replace.
- **Deterministic Playwright-only live verification** — rejected; DOM assertions are necessary but not sufficient (mirage UI renders 200 yet looks broken), so browser slices add a visual screenshot→Read gate.
- **Run the full completion pipeline per slice** — rejected on cost (~Nx LLM judgment + pipeline runs); per-slice rigor comes from the RuntimeVerifier live gate instead.

## Consequences

- The spec format, `SpecParser.ts`, and the in-flight spec-pipeline (`feat/kaya-spec-grill-pipeline`) must learn to author/parse Slices (in-scope/deferred + a live-verify command + ISC membership).
- `RuntimeVerifier.ts` (currently dead code) is reconnected; `WorkOrchestrator.verify()` must populate `runtimeVerifierInput` and `testExecutionResults`.
- The once-per-item TestWriter is re-scoped to once-per-slice; its immutability contract now applies per slice.
- Legacy flat specs (no Slices section) need a handling decision — see ADR-0002.
