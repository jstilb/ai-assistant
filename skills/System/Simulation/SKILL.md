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

All tools use `StateManager` (from `CORE/Tools/StateManager.ts`) with Zod schema validation. State files are centralized in `skills/System/Simulation/state/`:

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

> Use `notifySync()` from `lib/core/NotificationService.ts`
> Triggers on: simulation completion, invariant violations, pass rate below 50%

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
bun ~/.claude/skills/System/Simulation/Tools/ScenarioEngine.ts run Scenarios/resilience-001.yaml

# Run with custom seed for reproducibility
bun ~/.claude/skills/System/Simulation/Tools/ScenarioEngine.ts run Scenarios/resilience-001.yaml --seed=42

# Run 10 iterations
bun ~/.claude/skills/System/Simulation/Tools/ScenarioEngine.ts run Scenarios/resilience-001.yaml --runs=10
```

### Sandbox Management

```bash
# Create sandbox
bun ~/.claude/skills/System/Simulation/Tools/SandboxManager.ts create --copy-skills Browser,CORE

# List active sandboxes
bun ~/.claude/skills/System/Simulation/Tools/SandboxManager.ts list

# Destroy sandbox
bun ~/.claude/skills/System/Simulation/Tools/SandboxManager.ts destroy <sandbox-id>

# Clean up expired sandboxes
bun ~/.claude/skills/System/Simulation/Tools/SandboxManager.ts cleanup
```

### Replay a Session

```bash
# Replay from transcript
bun ~/.claude/skills/System/Simulation/Tools/ReplayEngine.ts replay path/to/transcript.json

# Replay with prompt mutation
bun ~/.claude/skills/System/Simulation/Tools/ReplayEngine.ts replay transcript.json --mutate-prompts

# Compare replay vs original
bun ~/.claude/skills/System/Simulation/Tools/ReplayEngine.ts compare original.json replayed.json
```

### Generate Report

```bash
# Generate report from simulation results
bun ~/.claude/skills/System/Simulation/Tools/SimulationReporter.ts report <simulation-id>

# Export to Evals format
bun ~/.claude/skills/System/Simulation/Tools/SimulationReporter.ts export-evals <simulation-id>
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
User: "Stress test the AutonomousWork skill"
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
~/.claude/skills/System/Simulation/
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
skills/System/Simulation/
+-- SKILL.md                            # This file
+-- fault-sim                           # CLI entry point for fault injection simulation
+-- Tools/
|   +-- SandboxManager.ts               # Sandbox lifecycle (git worktree + dir copy)
|   +-- ScenarioEngine.ts               # YAML scenario parser and executor
|   +-- ScenarioEngineM2.ts             # Multi-agent scenario extensions
|   +-- MultiAgentRunner.ts             # Multi-agent orchestration engine
|   +-- MockGenerator.ts                # Synthetic data generation
|   +-- FaultInjector.ts                # Deterministic fault injection (4 modes, 3 triggers)
|   +-- AdvancedFaultTypes.ts           # Extended fault types (partial, delayed, intermittent, etc.)
|   +-- CascadingFaultEngine.ts         # Cascading fault-during-recovery simulation
|   +-- BehaviorVerifier.ts             # Invariant assertion engine
|   +-- ReplayEngine.ts                 # Session transcript replay
|   +-- SimulationReporter.ts           # 5-section report generation
|   +-- ReportGenerator.ts              # Markdown report generation core
|   +-- SimulationDashboard.ts          # Aggregate results, trend analysis, agent comparison
|   +-- EvalsIntegration.ts             # Simulation-to-Evals bridge with scoring/suite export
|   +-- TriggerEngine.ts                # Fault trigger condition evaluation
|   +-- AgentRunner.ts                  # Agent process spawning and lifecycle
|   +-- TranscriptLogger.ts             # JSONL transcript append-only logging
|   +-- ConfigValidator.ts              # Scenario config validation with Zod schemas
|   +-- PathWhitelist.ts                # Path safety validation for sandbox writes
|   +-- __tests__/                      # Test suite (223 tests)
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

## Customization

### Fault Type Registry
Add new fault types in `AdvancedFaultTypes.ts` by extending the `ADVANCED_FAULT_TYPES` array and adding a handler in `generateFaultResponse()`.

### Trigger Conditions
Custom trigger logic in `TriggerEngine.ts`. Three built-in triggers: `call_count`, `random_probability`, `time_window`.

### Sandbox TTL
Default sandbox TTL is 3600s (1 hour). Override per-sandbox via `--ttl=<seconds>` CLI flag or `ttlSeconds` in `CreateOptions`.

### Parallel Execution
Multi-agent scenarios support `max_parallel` in the coordination block. Staggered start with `stagger_delay_ms`.

### Scenario Seeds
All scenarios accept `seed` for reproducibility. Each run within a batch increments the seed by 1.

## Integration

### Uses
- `lib/core/StateManager.ts` - Sandbox state, reports registry, engine state
- `lib/core/SkillIntegrationBridge.ts` - `emitInsight()`, `emitEvalSignal()`, `emitNotification()`
- `lib/core/NotificationService.ts` - Voice notifications on completion
- `lib/core/Inference.ts` - Mock data generation, simulated agent responses
- `skills/System/AgentMonitor/Tools/TraceEmitter.ts` - Emit execution traces for monitoring

### Feeds Into
- `skills/Intelligence/Evals/Suites/` - Exported regression tests via `exportToEvalsSuite()`
- `skills/Productivity/ContinualLearning/` - Simulation insights via `emitInsight()` with `pattern` tag
- `MEMORY/MONITORING/traces/` - Execution traces for AgentMonitor
- `MEMORY/LEARNING/` - Findings stored via SkillIntegrationBridge

### MCPs Used
- None (all execution is local, sandboxed)
