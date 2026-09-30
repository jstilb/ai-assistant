# Surface is a declared field set by the classifier, not re-derived downstream

Today a spec's surface (browser / cli / api / library) exists only as an in-prompt judgment in `CurrentWork.md:322-331`; `SpecPipelineRunner.ts` and `SpecValidator.ts` are surface-blind. We decided the **classifier** (`KayaTaskClassifier`, which already does LLM triage) will emit a `surface` verdict once (`browser | native | cli | api | library`), the work item / spec will carry it, and orchestration, the UX/UI skills, and the validator will all read that one field. UX/UI generation fires when `surface ∈ {browser, native}`.

We chose this over scattering keyword heuristics across multiple consumers (the duplication-drift failure mode that disabled the Designer agent) and over a human-only gate (which misses untagged UI work).

## Consequences

- `surface` becomes a first-class stored property; the classifier's output schema gains a field.
- Downstream consumers must tolerate an absent field on legacy items — fallback: unset → unknown → skip auto UX/UI, allow manual trigger.
- The in-prompt surface judgment in `CurrentWork.md` should eventually read the declared field rather than re-deriving it.
