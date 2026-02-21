# Validate Skill with Behavioral Evals

## Trigger
- "validate skill with evals", "run skill evals", "behavioral test skill"
- "audit-skill <name> --with-evals"
- Part of CreateSkill validation pipeline

## Purpose

Run behavioral evals against a skill to objectively verify that documented behavior matches actual implementation. This complements SkillAudit's static analysis with dynamic testing.

## Workflow Steps

### 1. Load Baseline Evals

```bash
# Baseline evals apply to all skills
bun ~/.claude/skills/Evals/Tools/EvalExecutor.ts suite \
  --name skill-baseline \
  --skill "${SKILL_NAME}"
```

The baseline suite tests:
- **Trigger recognition** - Does the skill activate on documented triggers?
- **Trigger negative case** - Does it correctly NOT activate on unrelated triggers?
- **Workflow execution** - Do workflows complete without errors?
- **Error handling** - Are errors caught gracefully?
- **Missing input handling** - Does it prompt for missing requirements?
- **Documentation accuracy** - Does SKILL.md match implementation?

### 2. Check for Skill-Specific Evals

```bash
# Check if skill has custom evals
SKILL_EVALS="~/.claude/skills/${SKILL_NAME}/Evals"
if [ -d "$SKILL_EVALS" ]; then
  bun ~/.claude/skills/Evals/Tools/EvalExecutor.ts suite \
    --path "$SKILL_EVALS" \
    --skill "${SKILL_NAME}"
fi
```

### 3. Analyze Results

```typescript
import { runBehaviorEvals } from '../Tools/BehaviorGapAnalyzer';

const results = await runBehaviorEvals(skillName);

// Interpretation
if (!results) {
  console.log('No evals available for this skill');
} else if (results.passRate >= 0.9) {
  console.log('✓ Skill behavior verified');
} else if (results.passRate >= 0.7) {
  console.log('⚠️ Skill has behavioral issues');
} else {
  console.log('✗ Skill behavior does not match documentation');
}
```

### 4. Generate Report

Output format:

```
## Eval Results: ${SKILL_NAME}

| Test | Status | Score | Notes |
|------|--------|-------|-------|
| trigger_skill_invocation | ✓ Pass | 0.95 | Correctly triggered on "audit skill" |
| trigger_negative_case | ✓ Pass | 1.0 | Did not trigger on "create skill" |
| workflow_execution | ⚠️ Warn | 0.72 | AuditSingle completed with warnings |
| error_graceful_handling | ✓ Pass | 0.88 | Errors caught, messages helpful |
| error_missing_input | ✗ Fail | 0.45 | Did not prompt for missing skill name |
| documentation_accuracy | ✓ Pass | 0.90 | Docs match implementation |

**Overall Pass Rate:** 83%
**Recommendation:** Fix missing input handling before production use
```

## Integration with CreateSkill

When creating a new skill, this workflow runs as the final validation step:

```bash
# After skill structure is created
/createskill MyNewSkill

# Final validation step
bun ~/.claude/skills/SkillAudit/Workflows/ValidateWithEvals.md MyNewSkill
```

## Integration with SkillAudit

The audit commands support eval integration:

```bash
# Run audit with evals
bun ~/.claude/skills/SkillAudit/Tools/SkillScorer.ts Browser --with-evals

# Check eval coverage across ecosystem
bun ~/.claude/skills/SkillAudit/Tools/SkillScorer.ts --all --with-evals
```

## Pass Criteria

| Level | Pass Rate | Meaning |
|-------|-----------|---------|
| Production Ready | ≥90% | Skill can be relied upon |
| Needs Attention | 70-89% | Works but has gaps |
| Not Ready | <70% | Significant issues to address |

## Creating Custom Evals for a Skill

To add custom evals beyond the baseline:

1. Create `skills/${SKILL_NAME}/Evals/` directory
2. Add YAML eval definitions following the Evals schema
3. Reference skill-specific workflows and edge cases

Example custom eval:

```yaml
# skills/Browser/Evals/screenshot.eval.yaml
name: browser-screenshot
description: Test screenshot capture functionality

tasks:
  - id: capture_visible_page
    description: Screenshot captures visible viewport
    type: capability
    graders:
      - type: state_check
        params:
          check_files:
            - path: /tmp/screenshot.png
              exists: true
      - type: llm_rubric
        params:
          rubric: |
            Does the screenshot show a web page correctly?
            Score 5 if page content is visible and readable
            Score 1 if screenshot is blank or corrupted
```

## Related

- **baseline.eval.yaml** - Standard tests all skills should pass
- **BehaviorGapAnalyzer.ts** - Tool that integrates evals with gap analysis
- **SkillScorer.ts** - Includes eval metrics in scoring
- **Evals/SKILL.md** - Full eval framework documentation
