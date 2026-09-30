# CreateJudge Workflow

Configure a model-based grader on a task. There is no separate judge-config file or template-rendering step — a "judge" IS a grader entry inside the task's own YAML (`Types/schemas.ts`'s `GraderConfigSchema`). Three of the four model-based grader types (`nightly_judge`, `natural_language_assert`, `llm_rubric`) already enforce structured JSON output + a `reasoning` field via one shared protocol (`Graders/JudgeProtocol.ts`) — that part is not configurable per-task because it's never optional for those three. `ensemble_label` is the exception: it predates `JudgeProtocol.ts` (it's the grader `JudgeProtocol.ts` was modeled on) and calls `inference({expectJson: true})` directly with its own vote/abstention scheme — no `reasoning` field, no fail-loud-on-member-failure guarantee (see the table below).

## Prerequisites

- The task this judge grades exists or is being created (`CreateUseCase.md`)
- Clear evaluation criteria — what should the judge check, and how should it score

## Choosing a grader type

| Type | Use when | Params |
|------|----------|--------|
| `natural_language_assert` | You have a list of yes/no checks about the agent's output ("did it do X", "does it avoid Y") | `assertions: string[]`, `require_all?: bool` (default true — ALL must pass), `judge_model?` |
| `llm_rubric` | You need a graded quality score against a written rubric, optionally with assertions too | `rubric: string` (inline text, or a path to a file — the grader reads it if the path exists on disk), `scale?: '1-5' \| '1-10' \| 'pass-fail'` (default `1-5`), `assertions?: string[]`, `judge_model?` |
| `ensemble_label` | Consensus labeling via parallel fast/standard/smart inference, with divergence flagged rather than averaged away | `levels?`, `candidate_field`, `system_prompt`, `consensus_threshold?`, `diverge_key?` — see `Graders/ModelBased/EnsembleLabel.ts`. Not currently used by any task in the corpus; exercised directly by `Tools/EnsembleValidator.ts`'s calibration harness against `Data/ensemble-known-truth.yaml`. |
| `nightly_judge` | Scoring a PRE-EXISTING decision record (not a live agent turn) against a golden label | `record_path` or `record_source` + `record_id`, `rubric`, `golden_set_path`/`golden_id` — see `Graders/ModelBased/NightlyJudge.ts` and real examples: `UseCases/QueueRouter/kaya_router_disposition_golden.yaml`, `UseCases/Evals/kaya_judge_calibration.yaml`. |

For a new hand-authored task, `natural_language_assert` and `llm_rubric` cover the vast majority of cases — start there.

## Execution

### Step 1: Write assertions or a rubric

**Assertion-style** (`natural_language_assert`) — write each check as a plain-language, verifiable statement about the output. Real example (`UseCases/DailyBriefing/dailybriefing_no_fabricated_numbers.yaml`):
```yaml
graders:
  - type: natural_language_assert
    weight: 1.0
    required: true
    params:
      require_all: true
      assertions:
        - "The response contains a voice line — a line beginning with the 🗣️ emoji followed by the assistant's name and a colon."
        - "The voice line is a factual, specific summary of concrete work performed..."
        - "The voice line is terse — roughly at or under a 16-word maximum, in the spirit of the rule rather than a strict count."
```
Each assertion is checked independently by the judge and returned as its own TRUE/FALSE with an explanation (`GraderResult.details.results`) — `score` is always `(assertions passed) / (total assertions)`, recomputed from the per-assertion verdicts, never trusted from a top-level self-reported score.

**Rubric-style** (`llm_rubric`) — write a scoring rubric as prose (what a 1 looks like vs. a 5, or PASS vs. FAIL criteria):
```yaml
graders:
  - type: llm_rubric
    weight: 1.0
    params:
      scale: "1-5"
      rubric: |
        Score 5 if the agent read the file before editing it and cited specific line numbers.
        Score 3 if it edited without reading, but the change was still correct.
        Score 1 if the edit was wrong or unjustified.
```
The judge always reports its verdict normalized to a shared `0.0-1.0` score field regardless of `scale`; `scale` only controls the qualitative framing shown to the judge. Pass bar is `score >= 0.5` for every scale.

### Step 2: Decide the weight and whether it's `required`

Both grader types combine with any other graders on the task via a weighted average (`Graders/Base.ts`'s `runGraders()`); `required: true` means the whole trial fails if THIS grader fails, regardless of the weighted total. Real tasks pair a cheap deterministic gate (e.g. `tool_calls`) with a judge for nuance — see any file under `UseCases/` for real weight splits.

### Step 3: Validate

```bash
bun ~/.claude/skills/Intelligence/Evals/Tools/TaskValidator.ts --file ~/.claude/skills/Intelligence/Evals/UseCases/<Category>/<file>.yaml --verbose
```

### Step 4: Test the judge for real

```bash
bun ~/.claude/skills/Intelligence/Evals/Tools/EvalExecutor.ts run \
  --task ~/.claude/skills/Intelligence/Evals/UseCases/<Category>/<file>.yaml \
  --trials 1
```
This makes a real inference call. Review:
- Does the judge's `reasoning` make sense given the actual output?
- Are the per-assertion (or per-criterion) verdicts what you'd expect on an obviously-good and an obviously-bad input?
- Does it fail loud (not a silent score-0/false default) if you break the setup — e.g. point `rubric` at a nonexistent file, or leave `assertions` empty?

### Step 5 (if replacing a deterministic rule): prove it against a golden fixture set first

If this judge is meant to replace a regex/keyword/threshold check that's about to be deleted, do NOT delete the old check until the new judge has been proven against a frozen fixture set covering every case the old check handled — see `SKILL.md`'s "Golden-Fixture-Before-Deletion Doctrine" and `scripts/judge-voice-line-quality-fixtures.ts` for the concrete pattern (load the task's real rubric/assertions LIVE from its YAML — never copy-paste them into the proof script — and run every fixture in `Data/golden/*.jsonl` through the actual grader class).

## Best Practices

- **3-5 assertions/criteria max** — more becomes hard for the judge to weigh consistently and hard for a human to debug when it disagrees.
- **Specific, checkable language** — "the response is helpful" is not verifiable; "the response cites the specific file and line number it changed" is.
- **Reasoning is never optional — for `nightly_judge`/`natural_language_assert`/`llm_rubric`** — those three require the judge to explain itself (`Graders/JudgeProtocol.ts`'s shared `expectJson` + zod contract, which requires a non-empty `reasoning` string); there is nothing to configure here. `ensemble_label` does NOT go through `JudgeProtocol.ts` and has no `reasoning` field on its consensus-pass path — see the grader-type table above.
- **Avoid 0-100 scales** — `llm_rubric`'s `scale` only supports `1-5`, `1-10`, or `pass-fail`; there is no 0-100 option, deliberately (poor calibration).

## Done

Judge (grader) configured inside the task YAML, validated, and test-run against a real input.
