---
name: Simulation
description: Sandboxed AI agent testing with fault injection, behavioral verification, workflow replay, and stress testing. USE WHEN simulate agent, test workflow, fault injection, chaos test, stress test, behavioral test, replay session, sandbox test, property test, agent resilience.
---
# Simulation

Hyper-testing framework for AI agent workflows, programs, and behaviors within sandboxed environments. Where Evals measures *what agents produce* (outputs, scores, pass rates), Simulation tests *how agents behave under conditions* -- replaying workflows, injecting faults, stress-testing decision paths, and verifying behavioral invariants.

Think of Evals as unit/integration tests and Simulation as load testing, chaos engineering, and behavioral fuzzing for AI agents.

## Architecture

```
SCENARIO DEFINITION:
[YAML Scenario File] --> ScenarioEngine (parse + validate)
    --> SandboxManager (create isolated env via git worktree or directory copy)
    --> MockGenerator (prepare synthetic data)
    --> FaultInjector (configure fault rules with triggers)

EXECUTION:
SandboxManager [isolated env] --> ScenarioEngine (drive agent through steps)
    --> FaultInjector (inject faults: network_timeout, malformed_response, rate_limit, tool_unavailable)
    --> BehaviorVerifier (assert invariants at checkpoints)
    --> JSONL Transcript (append per-event to .jsonl file)

REPLAY MODE:
[Captured Transcript] --> ReplayEngine (load + mutate)
    --> SandboxManager (fresh isolated env)
    --> ScenarioEngine (replay with modifications)
    --> BehaviorVerifier (compare original vs replayed behavior)

REPORTING:
[Execution Results] --> SimulationReporter
    --> 5-Section Report (Executive Summary, Fault Timeline, Agent Performance, Recommendations, Artifacts)
    --> Evals Bridge (feed findings into Evals suites)
    --> MEMORY capture (store to MEMORY/RESEARCH/)
```

### State Management

All tools use `StateManager` (from `CORE/Tools/StateManager.ts`) with Zod schema validation. State files are centralized in `skills/Simulation/state/`:

| State File | Owner | Purpose |
|------------|-------|---------|
| `fault-state.json` | FaultInjector | Fault rules, call counts, injection log |
| `sandbox-state.json` | SandboxManager | Sandbox registry, manifests, write logs |
| `engine-state.json` | ScenarioEngine | Active simulations, run tracking |
| `reports-state.json` | SimulationReporter | Report registry |

### Fault Types

| Mode | Behavior | Error Code |
|------|----------|------------|
| `network_timeout` | Tool call times out | ETIMEDOUT |
| `malformed_response` | Tool returns truncated/incomplete JSON | N/A |
| `rate_limit` | Tool returns rate limit error with retry-after | RATE_LIMITED |
| `tool_unavailable` | Tool binary not found | ENOENT |
| `partial_response` | Tool returns incomplete/truncated output | N/A |
| `delayed_response` | Tool responds after configurable delay | N/A |
| `intermittent_failure` | Tool fails randomly with configurable probability | ECONNRESET |
| `data_corruption` | Tool returns corrupted/garbled data | N/A |
| `resource_exhaustion` | Tool runs out of memory/disk/handles | ENOMEM |

### Trigger Conditions

| Trigger | Parameters | Description |
|---------|-----------|-------------|
| `call_count` | `call_count_threshold` | Inject after N calls to the tool |
| `random_probability` | `probability` (0-1) | Seeded random injection per call |
| `time_window` | `time_window_start`, `time_window_end` | Inject only within time range (seconds from start) |

### Sandbox Isolation

SandboxManager uses **git worktree** (primary) with **directory copy** (fallback). Path whitelisting restricts writes to `Sandboxes/`, `Reports/`, and `Transcripts/` directories only.

## Voice Notification

Before any action, send voice notification:
```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running simulation..."}'
```

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **RunScenario** | "run simulation", "simulate", "test scenario" | `Workflows/RunScenario.md` |
| **ReplaySession** | "replay session", "replay transcript" | `Workflows/ReplaySession.md` |
| **StressTest** | "stress test", "chaos test", "resilience test" | `Workflows/StressTest.md` |

## Components

| Component | Purpose | Location |
|-----------|---------|----------|
| **SandboxManager** | Creates/destroys isolated execution environments | `Tools/SandboxManager.ts` |
| **ScenarioEngine** | Parses YAML scenarios and drives execution | `Tools/ScenarioEngine.ts` |
| **MockGenerator** | Generates synthetic data, prompts, tool responses | `Tools/MockGenerator.ts` |
| **FaultInjector** | Injects failures, delays, corrupted data into tool calls | `Tools/FaultInjector.ts` |
| **BehaviorVerifier** | Asserts behavioral invariants at checkpoints | `Tools/BehaviorVerifier.ts` |
| **ReplayEngine** | Captures and replays session transcripts with mutations | `Tools/ReplayEngine.ts` |
| **SimulationReporter** | Generates structured reports with findings | `Tools/SimulationReporter.ts` |
| **AdvancedFaultTypes** | Extended fault types (partial, delayed, intermittent, corruption, exhaustion) | `Tools/AdvancedFaultTypes.ts` |
| **CascadingFaultEngine** | Cascading fault-during-recovery simulation | `Tools/CascadingFaultEngine.ts` |
| **EvalsIntegration** | Simulation-to-Evals bridge with structured scoring and suite export | `Tools/EvalsIntegration.ts` |

## Scenario Types

| Type | Purpose | Example |
|------|---------|---------|
| **chaos** | Inject random failures to test resilience | Tool calls fail 30% of the time |
| **replay** | Replay real sessions with modifications | Same workflow, different prompts |
| **property** | Verify invariants across randomized variants | "Always reads before editing" |
| **stress** | Escalating fault probability | 0% -> 100% failure rate ramp |
| **regression** | Detect behavioral drift from baseline | Compare v1 vs v2 behavior |

## Quick Reference

### Run a Scenario

```bash
# Run a single scenario
bun ~/.claude/skills/Simulation/Tools/ScenarioEngine.ts run Scenarios/resilience-001.yaml

# Run with custom seed for reproducibility
bun ~/.claude/skills/Simulation/Tools/ScenarioEngine.ts run Scenarios/resilience-001.yaml --seed=42

# Run 10 iterations
bun ~/.claude/skills/Simulation/Tools/ScenarioEngine.ts run Scenarios/resilience-001.yaml --runs=10
```

### Sandbox Management

```bash
# Create sandbox
bun ~/.claude/skills/Simulation/Tools/SandboxManager.ts create --copy-skills Browser,CORE

# List active sandboxes
bun ~/.claude/skills/Simulation/Tools/SandboxManager.ts list

# Destroy sandbox
bun ~/.claude/skills/Simulation/Tools/SandboxManager.ts destroy <sandbox-id>

# Clean up expired sandboxes
bun ~/.claude/skills/Simulation/Tools/SandboxManager.ts cleanup
```

### Replay a Session

```bash
# Replay from transcript
bun ~/.claude/skills/Simulation/Tools/ReplayEngine.ts replay path/to/transcript.json

# Replay with prompt mutation
bun ~/.claude/skills/Simulation/Tools/ReplayEngine.ts replay transcript.json --mutate-prompts

# Compare replay vs original
bun ~/.claude/skills/Simulation/Tools/ReplayEngine.ts compare original.json replayed.json
```

### Generate Report

```bash
# Generate report from simulation results
bun ~/.claude/skills/Simulation/Tools/SimulationReporter.ts report <simulation-id>

# Export to Evals format
bun ~/.claude/skills/Simulation/Tools/SimulationReporter.ts export-evals <simulation-id>
```

## Scenario Definition (YAML)

```yaml
scenario:
  id: "workflow-resilience-001"
  name: "Skill invocation under tool failures"
  description: "Verify agent handles Read tool failures gracefully"
  type: chaos

  target:
    type: workflow
    skill: "Browser"
    workflow: "Validate"

  environment:
    sandbox: true
    copy_skills: ["Browser", "CORE"]
    mock_files:
      - path: "~/Projects/test-site/index.html"
        content: "<html><body>Test</body></html>"

  faults:
    - tool: Read
      mode: network_timeout          # network_timeout | malformed_response | rate_limit | tool_unavailable
      trigger: random_probability     # random_probability | call_count | time_window
      probability: 0.3
      delay_ms: 5000
    - tool: Bash
      mode: tool_unavailable
      trigger: call_count
      call_count_threshold: 3
    - tool: WebFetch
      mode: rate_limit
      trigger: time_window
      time_window_start: 5
      time_window_end: 30

  mocks:
    - type: tool_response
      tool: WebFetch
      response: { "status": 200, "body": "mock content" }
    - type: user_prompt
      variants:
        - "Check the website"
        - "Is the site working?"

  cascading_faults:
    name: "recovery_under_fire"
    steps:
      - fault_type: network_timeout
        trigger_after: immediate
        parameters: { delay_ms: 5000 }
      - fault_type: rate_limit
        trigger_after: on_recovery
        parameters: {}
    recovery_check: true

  invariants:
    - name: "never_modifies_production"
      assert: "no_writes_outside_sandbox"
    - name: "graceful_error_handling"
      assert: "agent_reports_failure_not_hallucinate"

  execution:
    runs: 10
    timeout_ms: 120000
    parallel: 3
    seed: 42
```

## Examples

**Example 1: Chaos test a skill**
```
User: "Simulate Browser skill with 30% tool failure rate"
--> ScenarioEngine loads chaos scenario
--> SandboxManager creates isolated env
--> FaultInjector configured for 30% Read failures
--> 10 runs executed, behavior tracked
--> BehaviorVerifier checks invariants
--> SimulationReporter: "8/10 passed. Agent hallucinated on 2 runs when Read failed."
```

**Example 2: Replay with mutation**
```
User: "Replay last session with different prompts"
--> ReplayEngine loads transcript from Evals TranscriptCapture
--> Applies prompt mutations (synonyms, rephrasing)
--> Re-executes in sandbox
--> BehaviorVerifier compares original vs replay
--> "Behavioral drift detected: agent skipped validation step with rephrased prompt"
```

**Example 3: Stress test**
```
User: "Stress test the THEALGORITHM skill"
--> StressTest workflow: ramp fault probability 0% -> 100%
--> 20 runs at each level (0%, 10%, 20%, ..., 100%)
--> SimulationReporter: "Degradation threshold at 40% - agent stops recovering after this point"
```

**Example 4: Property-based test**
```
User: "Verify all skills read before editing"
--> PropertyTest: randomize 50 prompt variants
--> For each: check if Read is called before Edit
--> BehaviorVerifier: "Property holds in 48/50 runs. 2 failures when agent used cached context."
```

## Sandbox Architecture

```
~/.claude/skills/Simulation/
    +-- Sandboxes/          (ephemeral, auto-cleaned via git worktree or dir copy)
    |   +-- sim-{uuid}/     (one per simulation run)
    |       +-- MEMORY/     (isolated copy)
    |       +-- skills/     (isolated copy)
    |       +-- state/      (sandbox-local state)
    |       +-- artifacts/  (captured outputs)
    |
    +-- Scenarios/          (scenario definitions - version controlled)
    +-- Reports/            (generated reports)
    +-- Transcripts/        (JSONL session transcripts)
    +-- state/              (centralized StateManager files)
```

## File Structure

```
skills/Simulation/
+-- SKILL.md                            # This file
+-- Tools/
|   +-- SandboxManager.ts               # Sandbox lifecycle (git worktree + dir copy)
|   +-- ScenarioEngine.ts               # YAML scenario parser and executor
|   +-- MockGenerator.ts                # Synthetic data generation
|   +-- FaultInjector.ts                # Deterministic fault injection (4 modes, 3 triggers)
|   +-- BehaviorVerifier.ts             # Invariant assertion engine
|   +-- ReplayEngine.ts                 # Session transcript replay
|   +-- SimulationReporter.ts           # 5-section report generation
+-- Workflows/
|   +-- RunScenario.md                  # Single scenario execution
|   +-- ReplaySession.md               # Session replay workflow
|   +-- StressTest.md                   # Stress/chaos testing workflow
+-- Scenarios/                          # YAML scenario definitions
|   +-- resilience-001.yaml             # Example: tool failure resilience
+-- Reports/                            # Generated reports (gitignored)
+-- Transcripts/                        # JSONL transcripts (gitignored)
+-- state/                              # StateManager state files
|   +-- fault-state.json
|   +-- sandbox-state.json
|   +-- engine-state.json
|   +-- reports-state.json
```

## Integration

### Uses
- `skills/Evals/Tools/TranscriptCapture.ts` - Capture agent execution traces
- `skills/Evals/Graders/` - Code-based and model-based graders for verification
- `skills/Evals/Tools/SuiteManager.ts` - Export results as eval suites
- `skills/CORE/Tools/StateManager.ts` - Sandbox state tracking
- `skills/CORE/Tools/MemoryStore.ts` - Store simulation results to MEMORY
- `skills/CORE/Tools/NotificationService.ts` - Voice notifications on completion
- `skills/CORE/Tools/AgentOrchestrator.ts` - Parallel simulation run execution
- `skills/CORE/Tools/Inference.ts` - Mock data generation, simulated agent responses

### Feeds Into
- `MEMORY/RESEARCH/` - Simulation reports and findings
- `skills/Evals/Suites/` - Exported regression tests from invariants
- Quality dashboard for behavioral drift tracking

### MCPs Used
- None (all execution is local, sandboxed)
