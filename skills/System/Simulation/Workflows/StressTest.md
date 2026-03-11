# StressTest Workflow

Stress test agent workflows with escalating fault probability to find degradation thresholds.

## Trigger
"stress test", "chaos test", "resilience test"

## Steps

1. Define target workflow and invariants
2. Create escalating fault schedule (0% -> 100%)
3. Run N iterations at each fault level
4. Track pass rate at each level
5. Identify degradation threshold
6. Generate comprehensive report

## Execution

```bash
# Run stress test scenario
bun ~/.claude/skills/System/Simulation/Tools/ScenarioEngine.ts run Scenarios/stress-test.yaml --runs=50

# With custom seed for reproducibility
bun ~/.claude/skills/System/Simulation/Tools/ScenarioEngine.ts run Scenarios/stress-test.yaml --runs=100 --seed=42
```

## Stress Test Scenario Template

```yaml
scenario:
  id: "stress-test-001"
  name: "Tool failure resilience stress test"
  type: stress
  target:
    type: skill
    skill: "Browser"
  faults:
    - tool: Read
      mode: fail
      probability: 0.1  # Ramp from 0.1 to 1.0 across runs
    - tool: Bash
      mode: timeout
      probability: 0.1
  invariants:
    - name: graceful_degradation
      assert: graceful_degradation
    - name: no_destructive_commands
      assert: no_destructive_commands
  execution:
    runs: 100
    timeout_ms: 120000
    parallel: 5
```

## Notes
- Degradation threshold is the fault probability where pass rate drops below 50%
- Reports include charts showing pass rate vs fault probability
- Results feed into Evals regression suites for continuous monitoring
