# ValidateWithEvals — Behavioral Testing

## Trigger

- "validate [skill] with evals"
- "run skill evals"
- "behavioral test [skill]"

## Overview

Run behavioral evals against a skill to objectively verify documented behavior matches actual implementation. Complements the deterministic/inferential analysis with dynamic testing. Cross-references eval failures with ComprehensiveAudit findings for root cause correlation.

## Phase 1: Load Evals

1. Run baseline eval suite from `skills/System/SkillAudit/Evals/baseline.eval.yaml` via `Evals/Tools/EvalExecutor.ts`
2. If `skills/[SkillName]/Evals/` exists, run skill-specific evals too

```bash
# Baseline evals (all skills)
bun ~/.claude/skills/Intelligence/Evals/Tools/EvalExecutor.ts suite \
  --name skill-baseline \
  --skill "${SKILL_NAME}"

# Skill-specific evals (if exist)
SKILL_EVALS="~/.claude/skills/${SKILL_NAME}/Evals"
if [ -d "$SKILL_EVALS" ]; then
  bun ~/.claude/skills/Intelligence/Evals/Tools/EvalExecutor.ts suite \
    --path "$SKILL_EVALS" \
    --skill "${SKILL_NAME}"
fi
```

## Phase 1.5: Simulation Scenarios (if available)

If Simulation scenarios exist for the audited skill in `skills/System/Simulation/Scenarios/`, run them to add a runtime behavioral sub-signal to the eval results.

```bash
SIM_SCENARIOS=$(find ~/.claude/skills/System/Simulation/Scenarios/ -iname "*${SKILL_NAME}*" 2>/dev/null)
if [ -n "$SIM_SCENARIOS" ]; then
  for scenario in $SIM_SCENARIOS; do
    bun ~/.claude/skills/System/Simulation/Tools/ScenarioEngine.ts run "$scenario"
  done
fi
```

Include the simulation pass rate as a behavioral fidelity sub-signal when correlating with ComprehensiveAudit findings in Phase 3.

## Phase 2: Execute

Run all eval tasks. Capture pass/fail, scores, and failure reasons.

The baseline suite tests:
- **Trigger recognition** — Does the skill activate on documented triggers?
- **Trigger negative case** — Does it correctly NOT activate on unrelated triggers?
- **Workflow execution** — Do workflows complete without errors?
- **Error handling** — Are errors caught gracefully?
- **Missing input handling** — Does it prompt for missing requirements?
- **Documentation accuracy** — Does SKILL.md match implementation?

## Phase 3: Analyze

| Pass Rate | Status | Meaning |
|-----------|--------|---------|
| >=90% | Production Ready | Skill can be relied upon |
| 70-89% | Needs Attention | Works but has gaps |
| <70% | Not Ready | Significant issues to address |

**Cross-reference with ComprehensiveAudit findings:**
- Load latest audit report from `MEMORY/SkillAudits/[SkillName]-*.md`
- For each failing eval, check if a corresponding finding exists in the audit
- Correlate: eval failure in trigger recognition → check Context Routing dimension
- Correlate: eval failure in workflow execution → check Behavioral Fidelity dimension
- Correlate: eval failure in error handling → check Implementation Quality dimension

## Phase 4: Report

Per-test table with status, score, notes. Save alongside audit report.

```markdown
## Eval Results: [SkillName]

| Test | Status | Score | Notes |
|------|--------|-------|-------|
| trigger_skill_invocation | Pass/Fail | 0.XX | ... |
| trigger_negative_case | Pass/Fail | 0.XX | ... |
| workflow_execution | Pass/Fail | 0.XX | ... |
| error_graceful_handling | Pass/Fail | 0.XX | ... |
| error_missing_input | Pass/Fail | 0.XX | ... |
| documentation_accuracy | Pass/Fail | 0.XX | ... |

**Overall Pass Rate:** XX%
**Status:** Production Ready / Needs Attention / Not Ready

### Audit Correlation
| Eval Failure | Related Audit Dimension | Audit Score | Root Cause |
|-------------|------------------------|-------------|------------|
| ... | ... | X.X | ... |
```

## Creating Custom Evals

1. Create `skills/${SKILL_NAME}/Evals/` directory
2. Add YAML eval definitions following the Evals schema
3. Reference skill-specific workflows and edge cases

## Related

- **baseline.eval.yaml** — Standard tests all skills should pass
- **BehaviorVerifier.ts** — Deterministic gap analysis tool
- **ComprehensiveAudit.md** — Full audit workflow (findings used for correlation)
- **Evals/SKILL.md** — Full eval framework documentation
