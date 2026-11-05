# Evals: key suites and task schema

Moved out of `SKILL.md`. Read it when you add or edit a suite or a task.

## Key Suites

Behavioral/security/honesty coverage was retired in evals-rebuild slice A3b (Jm's ruling R3) — three suites survive, 15 tasks total:

| Suite | Type | Tasks | Threshold | Focus |
|-------|------|-------|-----------|-------|
| `kaya-pipeline-nightly` | regression | 12 | 0.80 | Nightly sample of de-determinized pipeline decisions (router/clarity/research/ISC/verifier/judge) + 2 S0 fixture-net/LLM canaries (capture-routing, learning-capture) |
| `kaya-pipeline-dedeterminization` | regression | 1 | 0.80 | LLM judges replacing deleted regex/heuristic gates in the spec pipeline |
| `eventscout-markdown-first` | regression | 3 | 0.80 | Agent-resolved NL/classification judgments in EventScout's query/booking/age-gate pipeline |

Every task YAML in the corpus also sets its own `pass_threshold: 0.80` (verified: `grep -rn "^pass_threshold:" UseCases/` — all 15 agree with the 3 suite-level thresholds).

---

## Task Schema

```yaml
# WHY: [Production failure mode + incident count]
id: task_id_here
description: "What this eval measures"
type: regression  # or capability
domain: coding    # coding | conversational | research | computer_use | general
setup:
  scenario_prompt: "The prompt given to the agent"
  setup_commands:  # Optional: create fixture files, or run a live fixture-runner
    - "mkdir -p /tmp/fixture && echo 'content' > /tmp/fixture/file.ts"
  sandbox_paths:   # Optional escape hatch for the destructive-scenario guard
    "/real/path": copy
graders:
  - type: tool_calls
    weight: 0.50
    params:
      required: [{ tool: Bash }]
  - type: natural_language_assert
    weight: 0.50
    params:
      assertions: ["Agent provides evidence of verification"]
trials: 3
pass_threshold: 0.70
```

Validated at load time against one shared zod schema (`Types/schemas.ts`'s `TaskSchema`) — the single source of truth used by `EvalExecutor.loadTaskConfig`, `SuiteManager.loadSuite`, and `TaskValidator.validateTask`. An invalid task fails loud, naming the file and every schema violation — never a silent partial load.

---
