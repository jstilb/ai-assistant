# EvalSkill Workflow

Iterative evaluation loop: draft test cases, spawn with-skill + baseline subagents, grade, aggregate, launch HTML viewer, collect feedback, iterate.

## Steps

### 1. Identify Target Skill
- Confirm skill name and path (e.g., `~/.claude/skills/Category/SkillName/`)
- Read the skill's SKILL.md to understand its purpose and workflows

### 2. Create Test Prompts
- Draft 2-3 realistic user requests that exercise the skill's core workflows
- Save to `evals/evals.json` in a workspace directory: `<skill-name>-workspace/iteration-N/`
- Each entry: `{ "query": "...", "expected_behavior": "..." }`

### 3. Spawn All Runs in ONE Turn
For each test case, spawn TWO subagents concurrently:
- **With-skill**: agent has access to the skill, saves outputs to `eval-N/with_skill/outputs/`
- **Baseline**: agent without the skill (or with old version), saves to `eval-N/without_skill/outputs/`
- Use the Agent tool to spawn all runs in a single message for maximum parallelism

### 4. Draft Assertions
While runs execute, draft grading criteria (assertions):
- What constitutes a pass vs fail for each test case?
- Update `eval_metadata.json` with assertions

### 5. Capture Timing
As runs complete, capture `total_tokens` and `duration_ms` from task notifications into `timing.json`

### 6. Grade Each Run
Spawn grader subagent using instructions from:
```
~/.claude/skills/Development/CreateSkill/EvalGrader.md
```
Feed it the outputs and assertions. Grader produces per-run scores and rationale.

### 7. Aggregate Benchmark
```bash
python3 ~/.claude/skills/Development/CreateSkill/Tools/AggregateBenchmark.py \
  <workspace>/iteration-N --skill-name <name>
```
Produces `benchmark.json` with aggregate stats.

### 8. Analyzer Pass
Spawn analyzer subagent using instructions from:
```
~/.claude/skills/Development/CreateSkill/EvalAnalyzer.md
```
Surfaces patterns the raw stats hide — e.g., "baseline wins on brevity but loses on accuracy."

### 9. Launch HTML Viewer
```bash
python3 ~/.claude/skills/Development/CreateSkill/Tools/EvalViewer.py \
  <workspace>/iteration-N --skill-name "<name>" \
  --benchmark <workspace>/iteration-N/benchmark.json
```
For iteration 2+, add: `--previous-workspace <workspace>/iteration-<N-1>`

Opens an interactive HTML report for Jm to review side-by-side outputs, grades, and stats.

### 10. Collect Feedback
Read `feedback.json` after Jm reviews:
- Empty feedback = satisfactory, stop iterating
- Specific complaints = focus improvements on those areas

### 11. Iterate (if needed)
If iterating:
1. Improve the skill based on feedback
2. Rerun into `iteration-<N+1>/`
3. Repeat from Step 3

## Schemas
See `~/.claude/skills/Development/CreateSkill/EvalSchemas.md` for JSON schemas for evals, grading, and benchmark files.
