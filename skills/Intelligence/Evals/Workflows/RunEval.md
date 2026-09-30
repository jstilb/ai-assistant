# RunEval Workflow

Run evaluations for a specific task or suite.

## Prerequisites

- Task YAML files exist under `UseCases/**/*.yaml` (flat `id:`/`description:`/`graders:` shape — not nested under a `task:` key; see `Types/schemas.ts`'s `TaskSchema`)
- Suites are defined at the `Suites/` root (`Suites/*.yaml`) — the live corpus has no `Capability/`/`Regression/` subdirectory tasks today

## Execution

### Step 1: Validate task or suite exists

```bash
# Find a task file by id (there is no id->filename convention — search):
grep -rl "^id: <task_id>" ~/.claude/skills/Intelligence/Evals/UseCases/

# Check a suite exists
ls ~/.claude/skills/Intelligence/Evals/Suites/<suite-name>.yaml
```

If a task is missing, use `CreateUseCase.md`.

### Step 2: Validate configs first, free of charge

```bash
bun ~/.claude/skills/Intelligence/Evals/Tools/EvalExecutor.ts smoke --name <suite-name>
```

Validates every task in the suite against the shared zod `TaskSchema` and the live grader registry — zero agent spawns, zero inference calls. Do this before a full `run`/`suite` invocation, which spends real money on any task whose grader(s) read agent output.

### Step 3: Run evaluation

**Run a single task:**
```bash
bun ~/.claude/skills/Intelligence/Evals/Tools/EvalExecutor.ts run \
  --task ~/.claude/skills/Intelligence/Evals/UseCases/<domain>/<task>.yaml \
  --trials 3
```

**Run an entire suite:**
```bash
bun ~/.claude/skills/Intelligence/Evals/Tools/EvalExecutor.ts suite \
  --name <suite-name>
```
(`--trials N` overrides every task's own `trials:`; omit it to use each task's configured value. `--quick` restricts to code-based-only tasks; `--sample N` randomly samples N tasks.)

**List available graders:**
```bash
bun ~/.claude/skills/Intelligence/Evals/Tools/EvalExecutor.ts list-graders
```

### Step 4: Collect results

- Per-task run (full transcript, per-trial grader results, pass@k/pass^k): `Results/<task-id>/run_<run-id>.json` — one JSON file, no separate `Transcripts/` directory or `summary.json`.
- Suite-level trend history (append-only, across days): `MEMORY/VALIDATION/evals/<YYYY-MM-DD>/<suite>-results.jsonl`.
- Latest structured suite summary (single snapshot, overwritten each run): `MEMORY/VALIDATION/evals/last-suite-run/<suite>.json`.
- Human-readable browsing: `bun ~/.claude/skills/Intelligence/Evals/Tools/TranscriptViewer.ts summary --last 10` (or `list`/`view <task-id>`).

### Step 5: Report summary

Use structured response format:

```markdown
📋 SUMMARY: Evaluation completed for <task/suite>

📊 STATUS:
| Metric | Value |
|--------|-------|
| Pass Rate | X% |
| Mean Score | X.XX |
| Failed Tasks | X |

📖 STORY EXPLANATION:
1. Ran evaluation against <N> tasks
2. Code-based graders completed first (string_match, tool_calls, fixture_accuracy, ...)
3. Model-based graders evaluated nuanced criteria (llm_rubric, natural_language_assert, ensemble_label, nightly_judge)
4. Calculated weighted scores per grader configuration
5. Compared each trial against its task's own pass_threshold (0.80 across the entire live corpus); a task passes the suite only when ALL its trials cleared that bar
6. <Key finding 1>
7. <Key finding 2>
8. <Recommendation>

🎯 COMPLETED: Evaluation finished with X% pass rate.
```

## Error Handling

**If eval fails:**
1. Check the `claude` CLI is on `PATH` and authenticated (model-based graders and any task whose grader reads agent output spawn a live `claude -p` subprocess)
2. Re-run `smoke --name <suite>` to isolate a config problem from a runtime problem
3. Check grader types match the live registry (`list-graders`)
4. Review terminal output — `EvalExecutor.ts` logs setup-command failures, context resolution, and per-trial pass/fail inline

## Done

Evaluation complete. Results available in `Results/<task-id>/` and, for suite runs, `MEMORY/VALIDATION/evals/`.
