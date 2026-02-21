# RunScenario Workflow

Execute a simulation scenario against an agent workflow in a sandboxed environment.

## Trigger
"run simulation", "simulate", "test scenario"

## Steps

1. Load scenario YAML from Scenarios/ directory
2. Validate scenario definition
3. Create sandbox via SandboxManager
4. Configure fault injection rules
5. Execute scenario runs (sequential or parallel)
6. Verify behavioral invariants
7. Generate report via SimulationReporter
8. Clean up sandbox

## Execution

```bash
# Run a scenario
bun ~/.claude/skills/Simulation/Tools/ScenarioEngine.ts run Scenarios/resilience-001.yaml

# With custom parameters
bun ~/.claude/skills/Simulation/Tools/ScenarioEngine.ts run Scenarios/resilience-001.yaml --runs=20 --seed=42

# Generate report after execution
bun ~/.claude/skills/Simulation/Tools/SimulationReporter.ts report <scenario-id>
```

## Notes
- All execution happens within sandboxed directories
- Sandboxes auto-clean after 1 hour (configurable TTL)
- Reports are saved to Reports/ and MEMORY/RESEARCH/
- Voice notification sent on completion
