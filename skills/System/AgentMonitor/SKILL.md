---
name: AgentMonitor
description: Live agent trace monitoring and anomaly detection. USE WHEN monitor agent, agent performance, agent alerts, live monitoring, watch agents, anomaly detection.
---

# AgentMonitor - Agent Workflow Monitoring (v3.0)

Live monitoring system for agent workflows: file watching, anomaly detection, real-time dashboards, and streaming alerts. Trace collection (TraceCollector/TraceEmitter) is shared infrastructure. The Phase-1 batch-evaluation pipeline (evaluate/evaluate-all/retro, the five Evaluator classes, EvaluatorPipeline, ReportGenerator) was deleted in evals-rebuild slice C2 — the two signals with real data (ErrorRate, DecisionQuality) now live as Evals UseCases under `skills/Intelligence/Evals/UseCases/AgentTraces/`, run nightly via the `kaya-pipeline-nightly` suite (see that skill's SKILL.md). ResourceEfficiency/Latency/Compliance had no real signal in the live trace corpus (tokensUsed/latencyMs/skillDir populated in only ~4/1096 files) and were deleted with no replacement.

**USE WHEN:** monitor agent, review live workflow status, agent alerts, live monitoring, watch agents, anomaly detection. For ErrorRate/DecisionQuality regression signal, see the Evals skill instead.
## Workflow Routing

| Workflow | Trigger | Command |
|----------|---------|---------|
| **Status** | "monitor status", "agent status" | `bun run Tools/MonitorCore.ts status` |
| **Watch** | "watch agents", "live monitoring", "start dashboard" | `bun run Tools/MonitorCore.ts watch` |
| **Query** | "query workflow", "check workflow" | `bun run Tools/MonitorCore.ts query --workflow <id> [--live]` |
| **Intervene** | "approve intervention", "deny intervention", "emergency stop" | `bun run Tools/MonitorCore.ts intervene <subcommand>` |

## Commands / Usage

### Trace Emission

```bash
# Emit a trace from another agent (programmatic)
bun run ~/.claude/skills/System/AgentMonitor/Tools/TraceEmitter.ts --workflow <id> --agent <agentId> --event tool_call --tool ReadFile
```

### Live Monitoring

```bash
# Start live monitoring with real-time dashboard
bun run ~/.claude/skills/System/AgentMonitor/Tools/MonitorCore.ts watch

# Start live monitoring in log mode (no dashboard)
bun run ~/.claude/skills/System/AgentMonitor/Tools/MonitorCore.ts watch --no-dashboard

# Start live monitoring silently (background mode)
bun run ~/.claude/skills/System/AgentMonitor/Tools/MonitorCore.ts watch --quiet

# Query a workflow (historical data + optional live tail)
bun run ~/.claude/skills/System/AgentMonitor/Tools/MonitorCore.ts query --workflow <id>
bun run ~/.claude/skills/System/AgentMonitor/Tools/MonitorCore.ts query --workflow <id> --live

# Start streaming pipeline directly
bun run ~/.claude/skills/System/AgentMonitor/Tools/StreamingPipeline.ts
bun run ~/.claude/skills/System/AgentMonitor/Tools/StreamingPipeline.ts --no-dashboard
```

## Tools

| Tool | Purpose |
|------|---------|
| `Tools/MonitorCore.ts` | Main CLI entry point and orchestrator (v3, live-monitoring only) |
| `Tools/TraceCollector.ts` | JSONL trace ingestion and parsing (dual-format: legacy + UnifiedEventSink) |
| `Tools/TraceEmitter.ts` | Lightweight trace emission for agents |
| `Tools/Percentiles.ts` | Shared P50/P95/P99 latency stats (used by ReplayEngine + BaselineManager) |
| `Tools/BaselineManager.ts` | Reads persisted baseline metrics (read-only — no live writer since C2) |
| `Tools/AlertManager.ts` | Voice notifications and JSONL alerts |
| `Tools/TraceAuditor.ts` | LLM root-cause analysis for a workflow trace (manual CLI / `loadAudit()` for GraphQuerier) |
| `Tools/AuditLogger.ts` | Self-monitoring audit log |
| `Tools/LiveTraceWatcher.ts` | Real-time file watcher for trace JSONL files |
| `Tools/AnomalyDetector.ts` | Real-time anomaly detection engine |
| `Tools/LiveDashboard.ts` | CLI dashboard for real-time agent status |
| `Tools/StreamingPipeline.ts` | Streaming pipeline orchestrator |
| `Tools/ReplayEngine.ts` | Threshold replay / what-if anomaly-detection analysis |
| `Tools/SyntheticInjector.ts` | Synthetic scenario injection for testing |
| `Tools/PolicyComparator.ts` | Compares intervention policies against the same trace window |
| `Tools/InterventionManager.ts` | Anomaly-to-action policy engine |
| `Tools/ApprovalManager.ts` | Human-in-the-loop approval for interventions |
| `Tools/PauseController.ts` | Workflow pause/resume control |
| `Tools/ThrottleManager.ts` | Per-agent resource throttling |
| `Tools/FeedbackManager.ts` | Targeted agent feedback delivery |
| `Tools/InterventionAuditor.ts` | Immutable intervention audit trail |

## Storage Layout

| Path | Purpose |
|------|---------|
| `MEMORY/MONITORING/traces/{workflowId}.jsonl` | Raw agent execution traces |
| `MEMORY/MONITORING/baselines/baselines.json` | Persisted baseline metrics (historical — no live writer since C2) |
| `MEMORY/MONITORING/audit/monitor-audit.jsonl` | Self-monitoring audit trail |
| `MEMORY/MONITORING/audit/alerts.jsonl` | Alert history |
| `MEMORY/MONITORING/audits/{workflowId}-audit.json` | TraceAuditor LLM root-cause analyses (manual CLI / GraphQuerier) |

For ErrorRate and DecisionQuality regression signal (formerly Phase-1 evaluators), see
`skills/Intelligence/Evals/UseCases/AgentTraces/` and the `kaya-pipeline-nightly` suite —
results land in `MEMORY/VALIDATION/evals/`, not this skill's storage.

## Live Monitoring Details

### Anomaly Detection

The AnomalyDetector runs inline with the streaming pipeline and detects:

- **Token Spike** - Excessive token consumption within a sliding time window
- **Error Burst** - Multiple errors clustered in a short time period
- **Infinite Loop** - Same tool called consecutively beyond threshold, or repeating 2-element cycle
- **Stale Workflow** - No traces received from a workflow for extended period
- **High Load** - System-wide events per second exceeding capacity threshold

Anomalies trigger voice notifications and JSONL alerts within 2 seconds of detection.

### Live Dashboard

The dashboard displays real-time:
- System overview (uptime, events/sec, active workflows, active anomalies)
- Workflow health table with status indicators (OK/WARN/FAIL)
- Per-agent activity metrics (tokens, tool calls, errors, latest tool)
- Active anomaly list with severity and age
- Recent trace feed

Supports 10+ concurrent agents with 1-second refresh rate.

## Examples

**Example 1: Start live monitoring**
```
User: "Watch the agents"
-> Starts LiveTraceWatcher on MEMORY/MONITORING/traces/
-> Opens real-time dashboard with workflow health, anomaly alerts
-> Anomalies trigger voice notifications automatically
```

**Example 2: Query workflow with live tail**
```
User: "Show me workflow stats and watch for updates"
-> Displays historical trace statistics, tool distribution, errors
-> Tails live trace events for the workflow
```

**Example 3: Check monitoring status**
```
User: "Show me the agent monitoring status"
-> Displays trace file count, baseline summary (if any), recent alerts, audit stats
```

**Example 4: Root-cause a failed workflow**
```
User: "Why did workflow <id> fail?"
-> bun Tools/TraceAuditor.ts --workflow <id>
-> LLM analyzes the trace and produces rootCause/failureCategory/decisionErrors
```

## Customization

| Setting | Location | Default | Description |
|---------|----------|---------|-------------|
| Intervention dry run | `MEMORY/MONITORING/policies/intervention-config.json` → `intervention.dryRun` | `false` | Log interventions without executing them |
| Intervention policies | `intervention-config.json` → `intervention.policies[]` | 3 defaults | Anomaly-to-action rules (pause, throttle, feedback) |
| Rate limiting | `intervention-config.json` → `intervention.rateLimiting` | `3 pauses/5min` | Max pauses per window, max throttles per agent |

## Integration

### Uses
- **Inference.ts** - LLM root-cause analysis (TraceAuditor)
- **MEMORY/MONITORING/** - Trace, baseline, and audit storage
- **NotificationService** - Alert notifications via AlertManager

### Feeds Into
- **Evals** - ErrorRate/DecisionQuality regression signal (`skills/Intelligence/Evals/UseCases/AgentTraces/`)
- **Graph** - GraphQuerier's `audit` command reads TraceAuditor's `loadAudit()`
- **AgentMetacognition** - Patterns feed learning captures

### MCPs Used
- None (file-based monitoring, CLI inference)
