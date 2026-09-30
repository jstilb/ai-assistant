---
status: accepted
supersedes-framing: ADR-0001, ADR-0002, ADR-0003 (terminology + ownership only — their decisions stand)
---

# Slice is realized as a vertical Phase; consumer-side retrofit only

Discovered mid-execution: a concurrent Claude session was already building the *producer* (spec-authoring) half of this retrofit on the same branch. It chose to express slices using the **existing `Phase` markdown format** — `Phase N` heading + `<!-- ISC: 1,2,3 -->` row mapping + Given/When/Then acceptance + a `<!-- HORIZONTAL: reason -->` escape hatch — and added a `validateSliceShape` gate (`SpecPipelineRunner.ts`) that rejects a horizontal `Phase 1` in a multi-phase spec. So **"Slice" and "Phase" are the same concept**: Slice is the principle, Phase is the token.

## Decision

This corrects ADR-0001/0002/0003's framing (which assumed a *new* Slice schema superseding Phase). In reality:

- A **Slice is a vertical Phase block**. The existing `SpecParser.detectPhasedSpec` + `<!-- ISC -->` parsing + `WorkOrchestrator.prepare` (returns `phases`) + Executive per-phase delegation (`Orchestrate.md`) **already consume the producer's slice format**. ADR-0001's "make the slice the loop unit" is largely *already in place* via per-phase delegation.
- The retrofit narrows to the **consumer side** (per Jm): AutonomousWork execution + live verification on files the concurrent session isn't touching (`AutonomousWork/Tools/*`, `Prompts/*`). The producer side (spec slicing in `QueueRouter`/`SpecSheet`, `validateSliceShape`) is **owned by the concurrent session — not re-done here.**
- A consumer-side "SliceGate that parks unsliced specs" (ADR-0002) is largely **redundant**: the producer's `validateSliceShape` enforces slice shape at spec-gen time, and there is no `needs-slicing` queue status — reuse `QueueManager.parkForGrill(id, {missing, suggested_questions})` → `needs-grilling` if a gap remains.

## Remaining consumer-side gaps (what this retrofit actually still builds)

1. **Slice 1 (done):** reconnect RuntimeVerifier at item completion.
2. **Per-slice live gate (S4, done):** run RuntimeVerifier as a **hard gate at the end of each Phase/Slice** (using that phase's surface + test files), blocking the next phase.
3. **S6 (done):** browser-slice screenshot→Read visual gate. The free-form `verify:` command path is NOT built — the producer emits ISC Verify Method columns (already run by CommandRunner), not free-form `verify:` fields. S6 delivered: `RuntimeVerificationResult.screenshots`, `verifyPhase` result `screenshots` field, `Orchestrate.md` visual hard-gate, `TestWriterPrompt.md` screenshot + console-error mandate.
4. **Parser gap-check:** ensure `SpecParser` surfaces per-phase acceptance (Given/When/Then) + the `<!-- HORIZONTAL -->` flag if the loop needs them.

## Consequence

Do not introduce a parallel "Slice" type or a new spec section — conform to the Phase format the producer emits. The retrofit's value is concentrated in the per-slice **live gate**, not in re-defining the schema.
