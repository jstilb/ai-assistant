# ViewResults Workflow

Browse past evaluation results, inspect transcripts, and check for regressions/trends.

## Prerequisites

- Evaluations have been run at least once (`Results/` and, for suite runs, `MEMORY/VALIDATION/evals/` are populated)

## Where results actually live

There is no database and no CSV/JSON export flag anywhere in this system — results are plain files:

| What | Where | Written by |
|------|-------|------------|
| One task's latest/all runs (full transcript, per-trial grader results, pass@k/pass^k) | `Results/<task-id>/run_<run-id>.json` — one JSON file per run | `EvalExecutor.ts`'s `runTask()` |
| Suite-level trend history, across days | `MEMORY/VALIDATION/evals/<YYYY-MM-DD>/<suite>-results.jsonl` (append-only) | `ResultsPersistence.ts` |
| Latest structured suite snapshot (single point, overwritten every run) | `MEMORY/VALIDATION/evals/last-suite-run/<suite>.json` | `EvalExecutor.ts`'s `suite` command |
| Weekly trend digest (markdown, dated) | `MEMORY/VALIDATION/evals/digests/<date>.md` | `EvalHealthDigest.ts` |

There is no `Transcripts/` directory — each trial's full turn-by-turn transcript is embedded inside its `Results/<task-id>/run_<run-id>.json` file, under `trials[i].transcript`.

## Execution

### Step 1: Identify the query

1. Which task or suite?
2. Latest run, or a trend across recent runs?
3. Summary-level, or full transcript detail for a specific trial?

### Step 2: Quick status check — `TranscriptViewer.ts`

```bash
# All tasks with results, most recent first, with pass/fail/score/tool-sequence/turns/wall-time
bun ~/.claude/skills/Intelligence/Evals/Tools/TranscriptViewer.ts list

# Only failures, sorted by score
bun ~/.claude/skills/Intelligence/Evals/Tools/TranscriptViewer.ts list --status fail --sort score

# Aggregate stats across the N most recently-run tasks (default 10)
bun ~/.claude/skills/Intelligence/Evals/Tools/TranscriptViewer.ts summary --last 20
```
`summary` also reports the most common failing grader types and the most common tool-call sequences across recent runs.

### Step 3: View one task/trial in detail

```bash
# Trial 1, grader-score summary
bun ~/.claude/skills/Intelligence/Evals/Tools/TranscriptViewer.ts view <task-id>

# A specific trial, full turn-by-turn transcript + per-grader reasoning
bun ~/.claude/skills/Intelligence/Evals/Tools/TranscriptViewer.ts view <task-id> --trial 2 --format detail
```

### Step 4: Read the raw JSON directly (when you need a field `TranscriptViewer.ts` doesn't surface)

```bash
ls -lt ~/.claude/skills/Intelligence/Evals/Results/<task-id>/   # newest run file last (lexicographic == chronological, run ids embed a timestamp)
cat ~/.claude/skills/Intelligence/Evals/Results/<task-id>/run_<id>.json
```

### Step 5: Check suite health / task list

```bash
bun ~/.claude/skills/Intelligence/Evals/Tools/SuiteManager.ts show <suite-name>
```

### Step 6: Check for regressions (trend, not just latest)

```bash
bun ~/.claude/skills/Intelligence/Evals/Tools/RegressionAlert.ts check <suite-name> --last 7
```
Reads `MEMORY/VALIDATION/evals/` history, flags per-task score drops vs. a rolling baseline, and classifies each candidate via an LLM judge (real regression vs. noise vs. known-flake vs. environmental) given the task's full recent history — not a bare threshold. See `SKILL.md`'s "Weekly Eval-Health Digest & Regression Alerting" section.

### Step 7: Report summary

Use structured response format:

```markdown
📋 SUMMARY: Evaluation results for <task/suite>

📊 STATUS:
| Metric | Value |
|--------|-------|
| Run ID | <run-id> |
| Date | <date> |
| Pass Rate | X% |
| Mean Score | X.XX |
| Total Trials | N |
| Passed | N |
| Failed | N |

📖 STORY EXPLANATION:
1. Retrieved evaluation run(s) from <date/range>
2. <N> trials were evaluated across the task/suite
3. Code-based graders ran deterministically; model-based graders judged nuanced criteria
4. Weighted scores calculated per grader configuration
5. <Pass rate>% cleared each trial's own pass_threshold (0.80 across the live corpus)
6. <Key finding about a specific failing grader/task>
7. <Trend note, if a regression check was run>
8. <Recommendation based on results>

🎯 COMPLETED: Results retrieved for <task/suite>, <pass-rate>% pass rate.
```

## Common Queries

### "How did the last eval go?"
```bash
bun ~/.claude/skills/Intelligence/Evals/Tools/TranscriptViewer.ts summary --last 1
```

### "Why did a trial fail?"
```bash
bun ~/.claude/skills/Intelligence/Evals/Tools/TranscriptViewer.ts view <task-id> --format detail
```
Shows every grader's `reasoning` field (the judge's explanation, for model-based graders) plus the full conversation transcript.

### "What suites/tasks are available?"
```bash
bun ~/.claude/skills/Intelligence/Evals/Tools/SuiteManager.ts list
bun ~/.claude/skills/Intelligence/Evals/Tools/TaskValidator.ts --all --verbose
```

### "Is anything regressing?"
```bash
bun ~/.claude/skills/Intelligence/Evals/Tools/RegressionAlert.ts check <suite-name>
```
Or wait for the weekly digest (`EvalHealthDigest.ts`, delivered via `AlertGate` at `tier: 'digest'`) rather than checking manually.

## Done

Results retrieved and reported. Use findings to guide task/grader/prompt changes.
