# CreateUseCase Workflow

Create a new evaluation task — one YAML file, validated against `Types/schemas.ts`'s `TaskSchema`.

## Prerequisites

- A documented production failure mode this eval proves/guards (the "WHY" every task carries)
- Clear pass/fail criteria and which grader type(s) can check them

## Execution

### Step 1: Gather requirements

1. What decision/behavior is this evaluating, and what production failure motivates it? (Every task in the live corpus opens with a `# WHY:` comment citing this.)
2. What does "correct" look like — an exact string, a tool-call sequence, a filesystem/test outcome, or something only an LLM judge can assess?
3. Does the real work already happen live (an agent needs to be spawned), or does it need to happen in `setup_commands` first (a fixture-net pattern — see below)?

### Step 2: Pick the real target directory

Tasks live under `UseCases/<Category>/<filename>.yaml` — one flat YAML file per task, NOT a directory with `config.yaml`/`test-cases/`/`golden-outputs/`/`prompts/` subfolders (that structure does not exist anywhere in the live corpus). Existing categories: `AutonomousWork/`, `Evals/`, `EventScout/`, `Kaya/`, `QueueRouter/`, `SpecSheet/`. Reuse an existing category if the task fits, or create a new one — `SuiteManager`/`EvalExecutor` discover tasks by scanning `UseCases/**/*.yaml` recursively (`Tools/shared/TaskUtils.ts`'s `findTaskFile()`), not by a fixed directory list.

### Step 3: Write the task YAML

The real, complete shape (`Types/schemas.ts`'s `TaskSchema` — every field below is what that schema actually accepts, not an aspirational format):

```yaml
# WHY: <the production failure mode / incident this eval guards against>
id: my_new_task_id                 # unique across the whole UseCases/ tree
description: "What this eval measures"
type: regression                    # or capability
domain: general                     # coding | conversational | research | computer_use | general
source: manual                      # optional: manual | failure_log | generated | simulation

setup:
  scenario_prompt: "The exact prompt to send the agent"   # optional — falls back to `description` if omitted
  setup_commands:                                          # optional — shell commands run in the trial's sandbox first
    - "echo 'fixture content' > /tmp/fixture.txt"
  working_dir: /some/path                                  # optional
  isolation: sandbox                                       # optional: sandbox (default, fresh tmpdir) | shared | none
  timeout_ms: 300000                                        # optional, default 300000
  env_vars: { KEY: value }                                  # optional
  sandbox_paths:                                            # optional — escape hatch for the destructive-scenario guard
    "/a/real/path": copy

graders:
  - type: tool_calls
    weight: 0.50
    required: true                  # optional — task fails overall if a required grader fails
    params:
      required: [{ tool: Bash }]
  - type: natural_language_assert
    weight: 0.50
    params:
      require_all: true
      assertions:
        - "Agent provides evidence of verification"

trials: 3                           # optional, default 1
pass_threshold: 0.80                # optional, default 0.75 — every task in the live corpus uses 0.80
tags: [my, tags]                    # optional
notes: |                             # optional — free-form authoring notes, red/green evidence, known limitations
  Why this task exists, what it replaces, any live-wiring TODOs.
```

Pick grader type(s) from the live registry (`bun Tools/EvalExecutor.ts list-graders` — 6 code-based, 4 model-based; see `SKILL.md`'s Graders section for what each checks). Weights need not sum to exactly 1.0 — `runGraders()` computes a weighted average over whatever weights are present.

### Step 4: If the real work needs to happen live in `setup_commands` (fixture-net pattern)

If this task is baselining a real classifier/production function against a fixture set (rather than grading a live agent turn), follow the fixture-net pattern (`SKILL.md`'s "Fixture-Net Pattern" section):
1. Add fixtures to `Data/golden/<name>-fixtures.jsonl` (one JSON object per line: `{id, category, input, expected, notes?}`).
2. Write (or reuse) a runner script using `Tools/FixtureRunnerShared.ts`'s `loadFixturesJsonl`/`buildSummary`/`writeSummary`/`parseFixtureRunnerArgs` — it must call the REAL classifier/inference function once per fixture and write `{accuracy, total, correct, results}` to a `record_path`.
3. In the task YAML, `setup_commands` invokes the runner (`--fixtures <jsonl> --out <record_path>`), and the grader is `fixture_accuracy` with `params.record_path` pointing at that same output file.

If no grader on the task reads agent output (`fixture_accuracy` and `nightly_judge` never do), `EvalExecutor.ts` skips the live agent spawn entirely (see SKILL.md's "Live-Agent-Spawn Skip") — no extra config needed to get that for free.

### Step 5: Validate the task file

```bash
bun ~/.claude/skills/Intelligence/Evals/Tools/TaskValidator.ts --file ~/.claude/skills/Intelligence/Evals/UseCases/<Category>/<file>.yaml --verbose
```
Reports schema errors (blocking) and warnings (e.g. capability task with 1 trial, no `pass_threshold` set, regression task with no `required` grader).

### Step 6: Add it to a suite (optional but usual)

Add the task's `id` to the relevant `Suites/<suite>.yaml`'s `tasks:` list (a plain list of task ids — `EvalSuiteSchema` requires every id to resolve via the real task index, or the suite fails to load). Then confirm the suite still loads cleanly:
```bash
bun ~/.claude/skills/Intelligence/Evals/Tools/EvalExecutor.ts smoke --name <suite-name>
```

### Step 7: Run it for real

```bash
bun ~/.claude/skills/Intelligence/Evals/Tools/EvalExecutor.ts run \
  --task ~/.claude/skills/Intelligence/Evals/UseCases/<Category>/<file>.yaml \
  --trials 1
```
Review: did the grader(s) produce a sensible score and reasoning? Did `setup_commands` (if any) succeed? Is the pass/fail verdict what you expected for this specific input?

## Best Practices

- **Golden-fixture-before-deletion**: if this task's purpose is to prove an LLM judgment can replace a deterministic rule slated for deletion, prove the rubric against a frozen fixture set BEFORE the old rule is deleted — see `SKILL.md`'s doctrine section and `scripts/judge-voice-line-quality-fixtures.ts` / `scripts/label-*.ts` for the pattern.
- **Every eval has a WHY** — cite the specific production failure or incident in a `# WHY:` comment and/or `notes:`.
- **Weight deterministic + model-based deliberately** — a fast, cheap code-based grader as a first gate (e.g. `tool_calls`) paired with a model-based grader for nuance is a common, effective split; see existing tasks under `UseCases/` for real examples.
- **Match `pass_threshold` to the corpus norm (0.80)** unless there's a specific reason to diverge — a lower threshold on a regression task should be a deliberate, documented decision.

## Done

Task created, validated (`TaskValidator.ts --file`), and — if suite-scoped — confirmed via `smoke`. Ready to run.
