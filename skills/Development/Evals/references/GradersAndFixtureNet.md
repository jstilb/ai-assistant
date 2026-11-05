# Evals: graders and the fixture-net pattern

Moved out of `SKILL.md`. Read it when you choose a grader or build a live classifier baseline.

## Graders

Ten grader types are registered (`Graders/Base.ts`'s live registry — run `Tools/EvalExecutor.ts list-graders` to confirm at any time).

### Code-Based (6)
| Type | What it does |
|------|--------------|
| `string_match` | Exact substring matching |
| `regex_match` | Pattern matching |
| `binary_tests` | Runs a test command, checks exit code |
| `state_check` | Verifies filesystem/system state after execution |
| `tool_calls` | Verifies required/forbidden/sequenced tool calls |
| `fixture_accuracy` | Grades a JSON record a live fixture-runner already wrote (see "Fixture-Net Pattern" below) — never reads agent output |

### Model-Based (4)
| Type | What it does |
|------|--------------|
| `llm_rubric` | Scores a detailed rubric against transcript + tool results |
| `natural_language_assert` | Checks a list of plain-language assertions against agent output |
| `ensemble_label` | Consensus labeling via parallel fast/standard/smart inference calls; divergence is flagged, not averaged away |
| `nightly_judge` | Static-input grader: scores a **pre-existing** decision record (from a live system path — `autoinfo`, `spec-pipeline`, `work-queue`, `live-verification`) against a golden label. Never spawns a live agent turn. |

Judgment-style quality is graded by `natural_language_assert` (evals-rebuild slice B2, Jm's ruling R1 — no deterministic word-count/regex gate) — see `UseCases/DailyBriefing/dailybriefing_no_fabricated_numbers.yaml`. (The voice-line task was retired 2026-09-29 when CLAUDE.md's response format was removed.)

`nightly_judge`, `natural_language_assert`, and `llm_rubric` (plus `RegressionAlert.ts`'s and `EvalHealthDigest.ts`'s own judges) share one structured judge protocol (`Graders/JudgeProtocol.ts`, evals-rebuild slice B1): `expectJson: true` + zod validation on the response + an always-present `reasoning` field, fail loud on a malformed/unparseable judge reply — never a silent score-0 default. `ensemble_label` sits outside this migration — it predates `JudgeProtocol.ts` and is in fact the grader `JudgeProtocol.ts` was modeled on (per `JudgeProtocol.ts`'s own docblock: "mirrors the ONE grader that already did this right — EnsembleLabelGrader"); it calls `inference({expectJson: true})` directly with its own vote/abstention semantics, has no `reasoning` field on its consensus-pass path, and folds per-member inference failures into abstentions rather than failing loud (`Graders/ModelBased/EnsembleLabel.ts`).

---

## Fixture-Net Pattern (live classifier baselines)

Two tasks (`kaya_capture_routing`, `kaya_learning_capture`) baseline a real production classifier against a golden fixture set — proving an LLM judgment call is safe to replace a regex/heuristic gate BEFORE that gate is deleted (the determinism-remediation "let-the-model-speak" doctrine's S0 step).

The split that makes this cheap and honest:
- **The RUNNER makes the live call.** Each task's `setup_commands` shells out to a dedicated fixture-runner script (`Tools/CaptureRoutingFixtureRunner.ts`, `Tools/LearningCaptureFixtureRunner.ts` — CLI shape `--fixtures <path.jsonl> --out <path.json>`, sharing load/write plumbing via `Tools/FixtureRunnerShared.ts`). It reads a JSONL fixture file from `Data/golden/*-fixtures.jsonl`, calls the REAL production classifier (e.g. `Router.classify()`) or a real `inference()` call once per fixture, and writes a JSON summary (`{ accuracy, total, correct, results }`) to `MEMORY/EVALS/live-fixture-runs/<name>.json`.
- **The `fixture_accuracy` GRADER only reads the record.** `Graders/CodeBased/FixtureAccuracy.ts` reads `params.record_path` (the file the runner just wrote) — it never touches `context.output` or `context.transcript` (`readsOutput = false`). A missing file, malformed JSON, or `total === 0` all score 0/fail — there's no path to a trivial pass.

This is distinct from `nightly_judge`'s fully-static pattern (reads a pre-existing decision record from a live system path — no per-run classification happens at all). Fixture-net tasks are "live per run, but the live work is invisible to the grader"; `nightly_judge` tasks are "static every run."

Adding a 4th net: new runner script (reuse `FixtureRunnerShared.ts`) + new `Data/golden/*.jsonl` + new task YAML (`setup_commands` calls the runner, `fixture_accuracy` grader reads its `record_path`) + one line in the target suite's `tasks:` list.

---
