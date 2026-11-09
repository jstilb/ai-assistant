# Run Verdict is computed from the EvalRun, never stored on it

"Does this run count, and did it pass?" is answered by one pure function, `TrialRunner.runVerdict(run)`, computed from the `EvalRun` in the module that builds it, and every caller asks it instead of re-deriving predicates. Outage windows stay at the store reader (`shared/ResultsUtils.ts`), not in the verdict. AblationRunner calls `runVerdict` but keeps its old rule (only "all trials infra" is skipped) until plan P10 slice 2 makes it follow the full verdict.

## Considered Options

- **Producer-carried verdict (`run.verdict` stamped by `TrialRunner.run()`)** — rejected: it stores state that is derivable from `trials`, so a later change to `trials` makes it stale, and every hand-built `EvalRun` fixture (six or more test files) would have to supply a consistent `verdict`, which tests past the interface.
- **Full verdict ladder in a new `Tools/Verdict.ts` (`trial`, `run`, `suite`, `storedRunExcluded` with outage windows moved in)** — rejected: four entry points plus signal types are wider than any caller needs, and outage windows answer a different question ("which stored runs are excluded") whose only caller is the store reader, where they already have one home; moving them lowers locality.

## Consequences

- The persisted value stays `status: "infra_skipped"` for stored-data compatibility; the domain name is **No-Signal Run** (see `../../CONTEXT.md`).
- The trial-level rules (infra classification, partial judge-failure conversion) stay inside `TrialRunner.run()`: they must decide before graders run or before the run is aggregated.
