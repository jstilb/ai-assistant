# ViewResults Workflow

Query and display evaluation results, generate reports, and track trends.

## Voice Notification

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the ViewResults workflow in the Evals skill to display eval results"}' \
  > /dev/null 2>&1 &
```

Running the **ViewResults** workflow in the **Evals** skill to display eval results...

---

## Prerequisites

- Evaluations have been run
- Results exist in Results/ directory or SQLite database

## Execution

### Step 1: Identify Query

Ask the user:
1. Which use case?
2. What time range? (latest, last week, specific run)
3. What to show? (summary, details, comparison, trends)
4. What format? (table, report, chart)

### Step 2: Quick Status Check

**Browse Results Directory:**

```bash
# List all result directories
ls ~/.claude/skills/Intelligence/Evals/Results/

# Show most recent run for a task
ls -lt ~/.claude/skills/Intelligence/Evals/Results/<task-id>/
```

### Step 3: View Detailed Results

**Read a specific run result:**

```bash
# View the run JSON
cat ~/.claude/skills/Intelligence/Evals/Results/<task-id>/run_<id>.json
```

**View transcript for a trial:**

```bash
# Browse transcripts
ls ~/.claude/skills/Intelligence/Evals/Transcripts/<task-id>/
cat ~/.claude/skills/Intelligence/Evals/Transcripts/<task-id>/trial_1_<timestamp>.json
```

### Step 4: Check Suite Saturation

**Use SuiteManager to check suite health:**

```bash
bun run ~/.claude/skills/Intelligence/Evals/Tools/SuiteManager.ts show <suite-name>
bun run ~/.claude/skills/Intelligence/Evals/Tools/SuiteManager.ts check-saturation <suite-name>
```

### Step 5: Compare Runs

Compare results by reading JSON files from `Results/` and analyzing the `pass_rate`, `mean_score`, and per-trial scores.

### Step 7: Report Summary

Use structured response format:

```markdown
📋 SUMMARY: Evaluation results for <use-case>

📊 STATUS:
| Metric | Value |
|--------|-------|
| Run ID | <run-id> |
| Date | <date> |
| Model | <model> |
| Pass Rate | X% |
| Mean Score | X.XX |
| Total Tests | N |
| Passed | N |
| Failed | N |

📖 STORY EXPLANATION:
1. Retrieved evaluation run from <date>
2. <N> test cases were evaluated
3. Deterministic scorers ran first (format, length, voice)
4. AI judges evaluated accuracy and style
5. Weighted scores calculated
6. <Pass rate>% passed the 0.75 threshold
7. <Key finding about top/bottom performers>
8. <Recommendation based on results>

🎯 COMPLETED: Results retrieved for <use-case>, <pass-rate>% pass rate.
```

## Query Patterns

### By Time Range

```bash
# Last 24 hours
--since "24 hours ago"

# Last week
--since "7 days ago"

# Specific date range
--from "2024-01-01" --to "2024-01-15"
```

### By Score Threshold

```bash
# Only failed runs
--min-pass-rate 0 --max-pass-rate 0.74

# Only excellent runs
--min-pass-rate 0.90
```

### By Model

```bash
# Specific model
--model claude-3-5-sonnet-20241022

# Compare models
--compare-models
```

### By Test Case

```bash
# Specific test
--test-id 001-basic

# All failures
--failures-only
```

## Output Formats

### Table (Default)

```
┌──────────┬────────────────────────────┬───────────┬────────────┐
│ Run ID   │ Model                      │ Pass Rate │ Mean Score │
├──────────┼────────────────────────────┼───────────┼────────────┤
│ abc123   │ claude-3-5-sonnet-20241022 │ 92%       │ 4.3        │
│ def456   │ gpt-4o                     │ 88%       │ 4.1        │
└──────────┴────────────────────────────┴───────────┴────────────┘
```

### JSON

```bash
--format json
```

```json
{
  "run_id": "abc123",
  "use_case": "newsletter_summaries",
  "model": "claude-3-5-sonnet-20241022",
  "summary": {
    "total_cases": 12,
    "passed": 11,
    "failed": 1,
    "pass_rate": 0.917,
    "mean_score": 4.3,
    "std_dev": 0.5
  },
  "per_test_case": [...]
}
```

### Markdown Report

```bash
--format markdown
```

Uses Report.hbs template to generate full report.

### CSV Export

```bash
--format csv --output results.csv
```

For spreadsheet analysis.

## Trend Analysis

### Saturation Monitoring

Use SuiteManager to check if a suite is saturated (consistently passing above threshold):

```bash
bun run ~/.claude/skills/Intelligence/Evals/Tools/SuiteManager.ts check-saturation <suite-name>
```

### Performance Over Time

Compare run JSON files in `Results/<task-id>/` sorted by timestamp to identify trends.

## Common Queries

### "How did the last eval go?"

```bash
# Find latest result
ls -lt ~/.claude/skills/Intelligence/Evals/Results/<task-id>/ | head -5

# Read the result
cat ~/.claude/skills/Intelligence/Evals/Results/<task-id>/run_<latest>.json
```

### "Why did a trial fail?"

```bash
# Check the transcript for details
cat ~/.claude/skills/Intelligence/Evals/Transcripts/<task-id>/trial_<n>_<timestamp>.json
```

### "Is a suite saturated?"

```bash
bun run ~/.claude/skills/Intelligence/Evals/Tools/SuiteManager.ts check-saturation <suite-name>
```

### "What suites are available?"

```bash
bun run ~/.claude/skills/Intelligence/Evals/Tools/SuiteManager.ts list
```

## Done

Results retrieved and reported. Use findings to guide prompt/model decisions.
