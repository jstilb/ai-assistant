# Human Review Workflow

## Trigger
- "review evals", "human review", "check eval queue", "calibrate graders"
- "/queue list evals-human-review"
- "pending human reviews"

## Purpose

Process the human review queue for evals, providing human judgment on agent outputs
and calibrating model-based graders against human assessments.

## Workflow Steps

### 1. Check Queue Status

```bash
# List pending human reviews
bun ~/.claude/skills/CORE/Tools/ApprovalQueue.ts list --status pending \
  --queue ~/.claude/MEMORY/QUEUES/evals-human-review.json
```

### 2. Review Individual Items

For each pending item:

1. **Display context:**
   - Task description and ID
   - Agent output being evaluated
   - Rubric/criteria if specified
   - Model grader score (for calibration)

2. **Human provides:**
   - Score (0-1 scale)
   - Pass/Fail judgment
   - Optional notes/reasoning

3. **Record review:**
```bash
bun ~/.claude/skills/CORE/Tools/ApprovalQueue.ts approve <id> \
  --notes "Score: 0.85\nNotes: Good response but minor issues" \
  --reviewer "{principal.name}" \
  --queue ~/.claude/MEMORY/QUEUES/evals-human-review.json
```

### 3. Calibration Analysis

After completing reviews, analyze calibration:

```typescript
import { analyzeSpotChecks } from '../Graders/HumanBased/SpotCheck.ts';

const analysis = await analyzeSpotChecks();
console.log(`Calibration: ${analysis.overallCalibration}`);
console.log('Recommendations:', analysis.recommendations);
```

## Rating Interface

When presenting items for review, use this format:

```
┌─────────────────────────────────────────────────────────────┐
│ EVAL REVIEW: task_tool_sequence_read_before_edit            │
│ Trial: trial_1 | Model Score: 0.78 (llm_rubric)             │
├─────────────────────────────────────────────────────────────┤
│ RUBRIC:                                                      │
│ Evaluate if the agent follows the "read before edit"        │
│ principle: Did the agent read the file BEFORE editing?      │
├─────────────────────────────────────────────────────────────┤
│ AGENT OUTPUT (truncated):                                    │
│ "I'll read the file first to understand its structure..."   │
│ [Shows Read tool call, then Edit tool call]                 │
├─────────────────────────────────────────────────────────────┤
│ YOUR RATING:                                                 │
│ Score (0-1): ___                                            │
│ Pass/Fail: ___                                              │
│ Notes: ___                                                  │
└─────────────────────────────────────────────────────────────┘
```

## Calibration Thresholds

| Agreement Rate | Status | Action |
|---------------|--------|--------|
| ≥85% | Good | Continue monitoring |
| 70-85% | Needs Attention | Review rubrics |
| <70% | Poor | Revise grader configuration |

## Queue Paths

- **Human Review Queue:** `~/.claude/MEMORY/QUEUES/evals-human-review.json`
- **Calibration Reports:** `~/.claude/skills/Evals/Results/calibration/`

## Related

- **HumanReview.ts** - Grader implementation
- **SpotCheck.ts** - Sampling for calibration
- **QueueRouter** - General queue management
