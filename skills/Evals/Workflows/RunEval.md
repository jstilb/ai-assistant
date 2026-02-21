# RunEval Workflow

Run evaluations for a specific use case.

## Voice Notification

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the RunEval workflow in the Evals skill to execute evaluation"}' \
  > /dev/null 2>&1 &
```

Running the **RunEval** workflow in the **Evals** skill to execute evaluation...

---

## Prerequisites

- Task YAML files exist in `UseCases/<domain>/<task_id>.yaml`
- Task defines graders (code-based, model-based, or human)
- Suites defined in `Suites/<domain>/<suite-name>.yaml`

## Execution

### Step 1: Validate Task or Suite

```bash
# Check task exists
ls ~/.claude/skills/Evals/UseCases/<domain>/<task>.yaml

# Or check suite exists
ls ~/.claude/skills/Evals/Suites/<domain>/<suite>.yaml
```

If missing, redirect to `CreateUseCase.md` workflow.

### Step 2: Run Evaluation

**Run a single task:**
```bash
bun run ~/.claude/skills/Evals/Tools/EvalExecutor.ts run \
  --task UseCases/<domain>/<task>.yaml \
  --trials 3
```

**Run an entire suite:**
```bash
bun run ~/.claude/skills/Evals/Tools/EvalExecutor.ts suite \
  --name <suite-name> \
  --trials 3
```

**List available graders:**
```bash
bun run ~/.claude/skills/Evals/Tools/EvalExecutor.ts list-graders
```

### Step 3: Collect Results

Results are stored in:
- `Results/<task-id>/run_<id>.json`
- `Transcripts/<task-id>/trial_<n>_<timestamp>.json`

### Step 4: Report Summary

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
2. Code-based graders completed first (string_match, response_format_check, voice_line_check)
3. Model-based graders evaluated nuanced criteria (llm_rubric, identity_consistency)
4. Calculated weighted scores per grader configuration
5. Compared against pass threshold
6. <Key finding 1>
7. <Key finding 2>
8. <Recommendation>

🎯 COMPLETED: Evaluation finished with X% pass rate.
```

## Error Handling

**If eval fails:**
1. Check model API key is configured (for model-based graders)
2. Verify task YAML has valid grader configurations
3. Check grader types match available graders (`list-graders` command)
4. Review error logs in terminal

## Done

Evaluation complete. Results available in `Results/` and `Transcripts/` directories.
