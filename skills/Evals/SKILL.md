---
name: Evals
description: Agent evaluation framework based on Anthropic's best practices. USE WHEN eval, evaluate, test agent, benchmark, verify behavior, regression test, capability test. Includes three grader types (code-based, model-based, human), transcript capture, pass@k/pass^k metrics, and ALGORITHM integration.
implements: Science
science_cycle_time: meso
---
## 🚨 MANDATORY: Voice Notification (REQUIRED BEFORE ANY ACTION)

**You MUST send this notification BEFORE doing anything else when this skill is invoked.**

1. **Send voice notification**:
   ```bash
   curl -s -X POST http://localhost:8888/notify \
     -H "Content-Type: application/json" \
     -d '{"message": "Running the WORKFLOWNAME workflow in the Evals skill to ACTION"}' \
     > /dev/null 2>&1 &
   ```

2. **Output text notification**:
   ```
   Running the **WorkflowName** workflow in the **Evals** skill to ACTION...
   ```

**This is not optional. Execute this curl command immediately upon skill invocation.**

# Evals - AI Agent Evaluation Framework

Comprehensive agent evaluation system based on Anthropic's "Demystifying Evals for AI Agents" (Jan 2026).

**Key differentiator:** Evaluates agent *workflows* (transcripts, tool calls, multi-turn conversations), not just single outputs.

---

## When to Activate

- "run evals", "test this agent", "evaluate", "check quality", "benchmark"
- "regression test", "capability test"
- Compare agent behaviors across changes
- Validate agent workflows before deployment
- Verify ALGORITHM ISC rows
- Create new evaluation tasks from failures

---

## Core Concepts

### Three Grader Types

| Type | Strengths | Weaknesses | Use For |
|------|-----------|------------|---------|
| **Code-based** | Fast, cheap, deterministic, reproducible | Brittle, lacks nuance | Tests, state checks, tool verification |
| **Model-based** | Flexible, captures nuance, scalable | Non-deterministic, expensive | Quality rubrics, assertions, comparisons |
| **Human** | Gold standard, handles subjectivity | Expensive, slow | Calibration, spot checks, A/B testing |

### Evaluation Types

| Type | Pass Target | Purpose |
|------|-------------|---------|
| **Capability** | ~70% | Stretch goals, measuring improvement potential |
| **Regression** | ~99% | Quality gates, detecting backsliding |

### Key Metrics

- **pass@k**: Probability of at least 1 success in k trials (measures capability)
- **pass^k**: Probability all k trials succeed (measures consistency/reliability)

---

## Workflow Routing

| Trigger | Workflow |
|---------|----------|
| "run evals", "evaluate suite" | Run suite via `Tools/AlgorithmBridge.ts` |
| "log failure" | Log failure via `Tools/FailureToTask.ts log` |
| "convert failures" | Convert to tasks via `Tools/FailureToTask.ts convert-all` |
| "create suite" | Create suite via `Tools/SuiteManager.ts create` |
| "check saturation" | Check via `Tools/SuiteManager.ts check-saturation` |

---

## Quick Reference

### CLI Commands

```bash
# Run an eval suite
bun run ~/.claude/skills/Evals/Tools/AlgorithmBridge.ts -s <suite>

# Log a failure for later conversion
bun run ~/.claude/skills/Evals/Tools/FailureToTask.ts log "description" -c category -s severity

# Convert failures to test tasks
bun run ~/.claude/skills/Evals/Tools/FailureToTask.ts convert-all

# Manage suites
bun run ~/.claude/skills/Evals/Tools/SuiteManager.ts create <name> -t capability -d "description"
bun run ~/.claude/skills/Evals/Tools/SuiteManager.ts list
bun run ~/.claude/skills/Evals/Tools/SuiteManager.ts check-saturation <name>
bun run ~/.claude/skills/Evals/Tools/SuiteManager.ts graduate <name>
```

### ALGORITHM Integration

Evals is a verification method for THE ALGORITHM ISC rows:

```bash
# Run eval and update ISC row
bun run ~/.claude/skills/Evals/Tools/AlgorithmBridge.ts -s regression-core -r 3 -u
```

ISC rows can specify eval verification:
```
| # | What Ideal Looks Like | Verify |
|---|----------------------|--------|
| 1 | Auth bypass fixed | eval:auth-security |
| 2 | Tests all pass | eval:regression |
```

---

## Available Graders

### Code-Based (Fast, Deterministic)

| Grader | Use Case |
|--------|----------|
| `string_match` | Exact substring matching |
| `regex_match` | Pattern matching |
| `binary_tests` | Run test files |
| `static_analysis` | Lint, type-check, security scan |
| `state_check` | Verify system state after execution |
| `tool_calls` | Verify specific tools were called |

### Model-Based (Nuanced)

| Grader | Use Case |
|--------|----------|
| `llm_rubric` | Score against detailed rubric (supports Fabric patterns) |
| `natural_language_assert` | Check assertions are true |
| `pairwise_comparison` | Compare to reference with position swap |

### Human-Based (Gold Standard)

| Grader | Use Case |
|--------|----------|
| `human_review` | Queue for human judgment, calibration tracking |
| `spot_check` | Sample outputs for calibration against model graders |

Human reviews integrate with the Kaya approval queue system. See `Workflows/HumanReview.md`.

---

## Domain Patterns

Pre-configured grader stacks for common agent types:

| Domain | Primary Graders |
|--------|-----------------|
| `coding` | binary_tests + static_analysis + tool_calls + llm_rubric |
| `conversational` | llm_rubric + natural_language_assert + state_check |
| `research` | llm_rubric + natural_language_assert + tool_calls |
| `computer_use` | state_check + tool_calls + llm_rubric |

See `Data/DomainPatterns.yaml` for full configurations.

---

## Task Schema (YAML)

```yaml
task:
  id: "fix-auth-bypass_1"
  description: "Fix authentication bypass when password is empty"
  type: regression  # or capability
  domain: coding

  graders:
    - type: binary_tests
      required: [test_empty_pw.py]
      weight: 0.30

    - type: tool_calls
      weight: 0.20
      params:
        sequence: [read_file, edit_file, run_tests]

    - type: llm_rubric
      weight: 0.50
      params:
        rubric: prompts/security_review.md

  trials: 3
  pass_threshold: 0.75
```

---

## Resource Index

| Resource | Purpose |
|----------|---------|
| `Tools/EvalExecutor.ts` | **Main execution engine** - runs tasks and suites |
| `Tools/AlgorithmBridge.ts` | ALGORITHM ISC integration |
| `Tools/TrialRunner.ts` | Multi-trial execution with pass@k |
| `Tools/SuiteManager.ts` | Suite management and saturation |
| `Tools/FailureToTask.ts` | Convert failures to test tasks |
| `Tools/TranscriptCapture.ts` | Capture agent trajectories |
| `Types/index.ts` | Core type definitions |
| `Graders/CodeBased/` | Deterministic graders |
| `Graders/ModelBased/` | LLM-powered graders |
| `Graders/HumanBased/` | Human review graders with queue integration |
| `Templates/fabric-adapters.yaml` | Fabric pattern → grader mappings |
| `Data/DomainPatterns.yaml` | Domain-specific grader configs |
| `Workflows/HumanReview.md` | Process human review queue |
| `CLIReference.md` | Full CLI command reference |

---

## Key Principles (from Anthropic)

1. **Start with 20-50 real failures** - Don't overthink, capture what actually broke
2. **Unambiguous tasks** - Two experts should reach identical verdicts
3. **Balanced problem sets** - Test both "should do" AND "should NOT do"
4. **Grade outputs, not paths** - Don't penalize valid creative solutions
5. **Calibrate LLM judges** - Against human expert judgment
6. **Check transcripts regularly** - Verify graders work correctly
7. **Monitor saturation** - Graduate to regression when hitting 95%+
8. **Build infrastructure early** - Evals shape how quickly you can adopt new models

---

## Examples

**Example 1: Run a regression suite**
```
User: "Run the core regression tests"
→ Invokes EvalExecutor with regression-core suite
→ Executes each task with configured graders
→ Returns pass/fail summary with pass@k metrics
```

**Example 2: Log a failure for conversion**
```
User: "Log this failure: agent edited without reading"
→ Invokes FailureToTask.ts log
→ Captures failure with category and severity
→ Ready for conversion to eval task
```

**Example 3: Run evals with ALGORITHM integration**
```
User: "Verify ISC row 3 passes evals"
→ Invokes AlgorithmBridge with --row 3
→ Runs associated eval suite
→ Updates ISC verification status
```

---

## Related

- **ALGORITHM**: Evals is a verification method for ISC rows
- **Science**: Evals implements scientific method
- **Browser**: For visual verification graders
- **Fabric**: Arbiter patterns can be used as LLM rubric templates
- **SkillAudit**: Behavioral evals for skill validation (see `ValidateWithEvals.md`)
