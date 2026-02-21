# Evals CLI Reference

## Overview

The Evals skill provides a CLI-first evaluation framework for testing AI agent behaviors. Commands are run via `bun` from the skill's Tools directory.

---

## Core Commands

### Execute Evaluations

```bash
# Run a single eval task
bun ~/.claude/skills/Evals/Tools/EvalExecutor.ts run \
  --task "UseCases/Regression/task_verification_before_done.yaml"

# Run an eval suite
bun ~/.claude/skills/Evals/Tools/EvalExecutor.ts suite \
  --name "regression-core"

# Run suite with multiple trials
bun ~/.claude/skills/Evals/Tools/EvalExecutor.ts suite \
  --name "regression-core" \
  --trials 3
```

### ALGORITHM Integration

```bash
# Run eval and update ISC row
bun ~/.claude/skills/Evals/Tools/AlgorithmBridge.ts \
  -s regression-core \
  -r 3 \
  -u

# Verify specific ISC row with eval
bun ~/.claude/skills/Evals/Tools/AlgorithmBridge.ts \
  --suite auth-security \
  --row 1
```

### Failure Management

```bash
# Log a failure for later conversion to eval task
bun ~/.claude/skills/Evals/Tools/FailureToTask.ts log \
  "Agent modified file without reading it first" \
  -c "workflow" \
  -s high

# Convert all logged failures to eval tasks
bun ~/.claude/skills/Evals/Tools/FailureToTask.ts convert-all

# List unconverted failures
bun ~/.claude/skills/Evals/Tools/FailureToTask.ts list
```

### Suite Management

```bash
# Create a new eval suite
bun ~/.claude/skills/Evals/Tools/SuiteManager.ts create \
  "my-suite" \
  -t capability \
  -d "Testing new feature X"

# List all suites
bun ~/.claude/skills/Evals/Tools/SuiteManager.ts list

# Check if suite is saturated (ready for regression)
bun ~/.claude/skills/Evals/Tools/SuiteManager.ts check-saturation \
  "my-suite"

# Graduate capability suite to regression
bun ~/.claude/skills/Evals/Tools/SuiteManager.ts graduate \
  "my-suite"
```

### Human Review Queue

```bash
# List pending human reviews
bun ~/.claude/skills/CORE/Tools/ApprovalQueue.ts list \
  --status pending \
  --queue ~/.claude/MEMORY/QUEUES/evals-human-review.json

# Approve a review item
bun ~/.claude/skills/CORE/Tools/ApprovalQueue.ts approve <id> \
  --notes "Score: 0.85\nNotes: Good response" \
  --queue ~/.claude/MEMORY/QUEUES/evals-human-review.json
```

---

## Grader-Specific Commands

### Run Individual Graders

```bash
# Test a code-based grader
bun ~/.claude/skills/Evals/Graders/CodeBased/ToolCalls.ts \
  --transcript "/path/to/transcript.json" \
  --config '{"required":[{"tool":"Read"}]}'

# Test a model-based grader with Fabric pattern
bun ~/.claude/skills/Evals/Graders/ModelBased/LLMRubric.ts \
  --output "Agent output to evaluate" \
  --template "fabric:arbiter-evaluate-quality"
```

---

## File Locations

| Path | Purpose |
|------|---------|
| `Tools/EvalExecutor.ts` | Main execution engine |
| `Tools/AlgorithmBridge.ts` | ALGORITHM ISC integration |
| `Tools/TrialRunner.ts` | Multi-trial execution with pass@k |
| `Tools/SuiteManager.ts` | Suite lifecycle management |
| `Tools/FailureToTask.ts` | Failure log → eval task conversion |
| `Tools/TranscriptCapture.ts` | Agent trajectory capture |
| `Graders/CodeBased/` | Deterministic graders |
| `Graders/ModelBased/` | LLM-powered graders |
| `Graders/HumanBased/` | Human review graders |
| `UseCases/` | Eval task definitions (YAML) |
| `Suites/` | Suite definitions |
| `Templates/` | Grader templates including Fabric adapters |
| `Types/index.ts` | TypeScript type definitions |

---

## Task Definition Format

Eval tasks are defined in YAML:

```yaml
# UseCases/Regression/task_read_before_edit.yaml
task:
  id: "read_before_edit_001"
  description: "Agent must read a file before editing it"
  type: regression
  domain: coding

  graders:
    - type: tool_calls
      weight: 0.5
      params:
        sequence: [Read, Edit]

    - type: llm_rubric
      weight: 0.5
      params:
        rubric: |
          Did the agent read the file before modifying it?
          Score 5 if read happened before any edit
          Score 1 if edit happened without reading
        scale: "1-5"

  trials: 1
  pass_threshold: 0.75
```

---

## Using Fabric Patterns as Graders

```yaml
# In eval task definition
graders:
  - type: llm_rubric
    template: fabric:arbiter-evaluate-quality
    params:
      axes: [clarity, accuracy, completeness]
      scale: "1-10"
```

Available Fabric adapters: See `Templates/fabric-adapters.yaml`

---

## Output Format

Results are stored in `Results/<suite>/<run-id>/`:

```
Results/
└── regression-core/
    └── 2026-02-01_093000/
        ├── run.json          # Run metadata and aggregate scores
        ├── summary.json      # pass@k, pass^k metrics
        └── trials/
            ├── trial_001.json
            ├── trial_002.json
            └── trial_003.json
```

---

## Related Documentation

- **SKILL.md** - Full skill documentation and concepts
- **Types/index.ts** - Type definitions
- **BestPractices.md** - Eval design best practices (from Anthropic)
- **Templates/fabric-adapters.yaml** - Fabric pattern integration
