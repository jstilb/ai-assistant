# Evals — Agent Evaluation

Kaya's agent-evaluation domain: tasks run as trials, graders score each trial, and each run gets one verdict on whether it counts and whether it passed. This glossary names the "does this run count?" vocabulary, so that the suite summary, the persisted results store, the nightly alert and Ablation use one set of words for one rule.

## Language

### Run verdict

**Run Verdict**:
The one answer for an `EvalRun`: it counts (pass or fail), or it is a **No-Signal Run** with a cause and a reason; computed by `TrialRunner.runVerdict()`, never stored on the run.
_Avoid_: "run status", "skip flag", one-off predicates such as "is infra skipped"

**No-Signal Run**:
A run whose result says nothing about the agent's behavior, so it is excluded from pass, mean and baselines; persisted as `status: "infra_skipped"` with `infra_reason` (value kept for stored-data compatibility).
_Avoid_: "infra-skipped run" in new prose (use it only for the persisted value), "zero score"

**Infra Trial**:
A trial whose agent spawn failed by structured signals (exit code, `is_error`, a known stderr signature), or whose judges all failed while other trials of the same run were judged; it is out of the run's pass rate and mean.
_Avoid_: "failed trial" (a failed trial is a real, counted result)

**Judge Failure**:
A no-signal cause: every behavioral trial's graders carry `details.judge_error`, so nobody judged the agent.
_Avoid_: "auth-shaped failure" (the 2026-07 name; the rule now covers any judge failure)

**Fixture Fallback**:
A no-signal cause: every grader carries `details.fixture_infra_error`, because most fixtures of a fixture-runner record errored and their answers are fallback defaults.
_Avoid_: "error-fallback fixture run"

**Outage Window**:
A human-declared time range in `Config/known-outages.json` whose stored runs the store reader (`shared/ResultsUtils.ts`) excludes; it acts on stored runs, not on a live **Run Verdict**.
_Avoid_: "blackout", "quarantine"

## Relationships

- A **Run Verdict** belongs to exactly one `EvalRun`; a no-signal verdict has exactly one cause: all trials infra, **Judge Failure**, or **Fixture Fallback** (checked in that order).
- An **Infra Trial** never makes a run a **No-Signal Run** alone; only when every trial is an **Infra Trial** does the run lose its signal.
- A partial **Judge Failure** (some trials judged) turns the unjudged trials into **Infra Trials** inside `TrialRunner.run()`; the run still counts.
- An **Outage Window** excludes stored runs that a **Run Verdict** had counted (a real-looking zero recorded during a declared outage).

## Example dialogue

> **Dev:** "The judge timed out on one of three trials. Is the run a **No-Signal Run**?"
> **Domain expert:** "No — that trial becomes an **Infra Trial** and the other two still count. Only if every trial's judge failed is the run a **Judge Failure**, and then the **Run Verdict** says it does not count."
> **Dev:** "And last week's zeros from the `claude -p` outage, already in the store?"
> **Domain expert:** "Those are covered by an **Outage Window** at the store reader; the **Run Verdict** only decides new runs."

## Flagged ambiguities

- "infra_skipped" names both the persisted status value and, in older comments, any run without signal — resolved: the concept is **No-Signal Run**; `infra_skipped` is only its stored value.
- "infra failure" was used for both a trial and a run — resolved: **Infra Trial** is trial-level; the run-level cause is "all trials infra".
