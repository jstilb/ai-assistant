---
name: AgentMonitor
description: Agent monitoring and evaluation system for Kaya workflows. Supports batch evaluation and live real-time monitoring with anomaly detection. USE WHEN monitor agent, evaluate agent, agent performance, check agent quality, review workflow, agent traces, retro analysis, baseline metrics, agent alerts, compliance check, live monitoring, watch agents, dashboard, anomaly detection.
triggers:
  - monitor agent
  - evaluate agent
  - agent performance
  - workflow evaluation
  - retro analysis
  - agent compliance
  - agent baseline
  - agent alerts
  - live monitoring
  - watch agents
  - anomaly detection
  - agent dashboard
---

# AgentMonitor - Agent Workflow Monitoring & Evaluation (v2.0)

Comprehensive monitoring system that evaluates agent workflows through both batch trace analysis and real-time live monitoring. Phase 1 provides post-execution evaluation with five evaluator pipelines. Phase 2 adds live monitoring with file watching, anomaly detection, real-time dashboards, and streaming alerts.

**USE WHEN:** monitor agent, evaluate agent, review workflow performance, run retro analysis, check compliance, manage baselines, agent alerts, live monitoring, watch agents, anomaly detection.
## Voice Notification

**You MUST send this notification BEFORE doing anything else when this skill is invoked.**

1. **Send voice notification**:
   ```bash
   curl -s -X POST http://localhost:8888/notify \
     -H "Content-Type: application/json" \
     -d '{"message": "Running the WORKFLOWNAME workflow in the AgentMonitor skill to ACTION"}' \
     > /dev/null 2>&1 &
   ```

2. **Output text notification**:
   ```
   Running the **WorkflowName** workflow in the **AgentMonitor** skill to ACTION...
   ```

**This is not optional. Execute this curl command immediately upon skill invocation.**

## Workflow Routing

| Workflow | Trigger | Command |
|----------|---------|---------|
| **Evaluate** | "evaluate workflow", "monitor agent" | `bun run Tools/MonitorCore.ts evaluate --workflow <id>` |
| **EvaluateAll** | "evaluate all today", "daily evaluation" | `bun run Tools/MonitorCore.ts evaluate-all --date <YYYY-MM-DD>` |
| **Status** | "monitor status", "agent status" | `bun run Tools/MonitorCore.ts status` |
| **Retro** | "retro analysis", "analyze work log" | `bun run Tools/MonitorCore.ts retro --work-dir <path>` |
| **Watch** | "watch agents", "live monitoring", "start dashboard" | `bun run Tools/MonitorCore.ts watch` |
| **Query** | "query workflow", "check workflow" | `bun run Tools/MonitorCore.ts query --workflow <id> [--live]` |
| **Intervene** | "approve intervention", "deny intervention", "emergency stop" | `bun run Tools/MonitorCore.ts intervene <subcommand>` |

## Commands / Usage

### Phase 1: Batch Evaluation

```bash
# Evaluate a specific workflow
bun run ~/.claude/skills/AgentMonitor/Tools/MonitorCore.ts evaluate --workflow <workflowId>

# Evaluate all workflows for a date
bun run ~/.claude/skills/AgentMonitor/Tools/MonitorCore.ts evaluate-all --date 2026-02-05

# Show monitoring status and recent evaluations
bun run ~/.claude/skills/AgentMonitor/Tools/MonitorCore.ts status

# Retrospective analysis of a MEMORY/WORK/ session log
bun run ~/.claude/skills/AgentMonitor/Tools/MonitorCore.ts retro --work-dir MEMORY/WORK/20260205-080013_tasks-daily

# Emit a trace from another agent (programmatic)
bun run ~/.claude/skills/AgentMonitor/Tools/TraceEmitter.ts --workflow <id> --agent <agentId> --event tool_call --tool ReadFile
```

### Phase 2: Live Monitoring

```bash
# Start live monitoring with real-time dashboard
bun run ~/.claude/skills/AgentMonitor/Tools/MonitorCore.ts watch

# Start live monitoring in log mode (no dashboard)
bun run ~/.claude/skills/AgentMonitor/Tools/MonitorCore.ts watch --no-dashboard

# Start live monitoring silently (background mode)
bun run ~/.claude/skills/AgentMonitor/Tools/MonitorCore.ts watch --quiet

# Query a workflow (historical data + optional live tail)
bun run ~/.claude/skills/AgentMonitor/Tools/MonitorCore.ts query --workflow <id>
bun run ~/.claude/skills/AgentMonitor/Tools/MonitorCore.ts query --workflow <id> --live

# Start streaming pipeline directly
bun run ~/.claude/skills/AgentMonitor/Tools/StreamingPipeline.ts
bun run ~/.claude/skills/AgentMonitor/Tools/StreamingPipeline.ts --no-dashboard
```

## Tools

| Tool | Purpose |
|------|---------|
| `Tools/MonitorCore.ts` | Main CLI entry point and orchestrator (v2 with live commands) |
| `Tools/TraceCollector.ts` | JSONL trace ingestion and parsing |
| `Tools/TraceEmitter.ts` | Lightweight trace emission for agents |
| `Tools/EvaluatorPipeline.ts` | Runs evaluator chain on collected traces |
| `Tools/evaluators/ResourceEfficiencyEvaluator.ts` | Token usage and redundant tool call detection |
| `Tools/evaluators/LatencyEvaluator.ts` | P50/P95/P99 latency analysis |
| `Tools/evaluators/ErrorRateEvaluator.ts` | Failure rate and error clustering |
| `Tools/evaluators/DecisionQualityEvaluator.ts` | Hybrid rules + LLM-as-judge evaluation |
| `Tools/evaluators/ComplianceEvaluator.ts` | Kaya standards compliance checking |
| `Tools/ReportGenerator.ts` | Markdown and JSON report generation |
| `Tools/BaselineManager.ts` | Computes and stores baseline metrics |
| `Tools/AlertManager.ts` | Voice notifications and JSONL alerts |
| `Tools/SessionLogParser.ts` | Retrospective parser for MEMORY/WORK/ logs |
| `Tools/AuditLogger.ts` | Self-monitoring audit log |
| `Tools/LiveTraceWatcher.ts` | Real-time file watcher for trace JSONL files (Phase 2) |
| `Tools/AnomalyDetector.ts` | Real-time anomaly detection engine (Phase 2) |
| `Tools/LiveDashboard.ts` | CLI dashboard for real-time agent status (Phase 2) |
| `Tools/StreamingPipeline.ts` | Streaming pipeline orchestrator (Phase 2) |
| `Tools/InterventionManager.ts` | Anomaly-to-action policy engine (Phase 2) |
| `Tools/ApprovalManager.ts` | Human-in-the-loop approval for interventions |
| `Tools/PauseController.ts` | Workflow pause/resume control |
| `Tools/ThrottleManager.ts` | Per-agent resource throttling |
| `Tools/FeedbackManager.ts` | Targeted agent feedback delivery |
| `Tools/InterventionAuditor.ts` | Immutable intervention audit trail |

## Storage Layout

| Path | Purpose |
|------|---------|
| `MEMORY/MONITORING/traces/{workflowId}.jsonl` | Raw agent execution traces |
| `MEMORY/MONITORING/evaluations/{workflowId}-eval.json` | Evaluation results |
| `MEMORY/MONITORING/reports/{date}/{workflowId}-report.md` | Human-readable reports |
| `MEMORY/MONITORING/baselines/baselines.json` | Computed baseline metrics |
| `MEMORY/MONITORING/config/monitoring-config.json` | Evaluator thresholds, live monitoring, and alert settings |
| `MEMORY/MONITORING/audit/monitor-audit.jsonl` | Self-monitoring audit trail |
| `MEMORY/MONITORING/audit/alerts.jsonl` | Alert history |

## Evaluator Details

1. **ResourceEfficiencyEvaluator** - Flags excessive token usage (configurable thresholds), identifies redundant tool calls, detects retry storms
2. **LatencyEvaluator** - Tracks P50/P95/P99 latencies, flags slow operations (>2 sigma from baseline), identifies blocking patterns
3. **ErrorRateEvaluator** - Calculates failure rates by agent and task type, detects error clustering, categorizes error types
4. **DecisionQualityEvaluator** - Hybrid: rule-based primary (ISC completion rate, tool call efficiency, error recovery) + LLM-as-judge for nuanced assessment via Inference.ts
5. **ComplianceEvaluator** - Checks for raw fetch() usage, raw JSON.parse(readFileSync()), missing SKILL.md sections, output format violations

## Live Monitoring Details (Phase 2)

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

**Example 2: Evaluate a completed workflow**
```
User: "Evaluate the agent workflow for the daily maintenance run"
-> Loads traces from MEMORY/MONITORING/traces/<workflowId>.jsonl
-> Runs all 5 evaluators in the pipeline
-> Generates evaluation JSON + markdown report
-> Alerts if any evaluator score is critical
```

**Example 3: Query workflow with live tail**
```
User: "Show me workflow stats and watch for updates"
-> Displays historical trace statistics, tool distribution, errors
-> Shows last evaluation score
-> Tails live trace events for the workflow
```

**Example 4: Run retrospective analysis on a work session**
```
User: "Run retro on MEMORY/WORK/20260205-080013_tasks-daily"
-> SessionLogParser extracts events from the session log
-> Converts session events to AgentTrace format
-> Runs evaluator pipeline on reconstructed traces
-> Generates report with improvement recommendations
```

**Example 5: Check monitoring status**
```
User: "Show me the agent monitoring status"
-> Displays recent evaluations with scores
-> Shows baseline trends
-> Lists any active alerts
-> Summarizes compliance posture
```

## Integration

### Uses
- **Inference.ts** - LLM-as-judge for DecisionQualityEvaluator
- **MEMORY/WORK/** - Session logs for retrospective analysis
- **MEMORY/MONITORING/** - All trace, evaluation, and report storage
- **VoiceServer** - Alert notifications via AlertManager

### Feeds Into
- **Evals** - AgentMonitor findings can feed eval task creation
- **THEALGORITHM** - Performance data improves ISC verification
- **ContinualLearning** - Patterns feed learning captures
- **AutoMaintenance** - Compliance findings trigger maintenance tasks

### MCPs Used
- None (file-based monitoring, CLI inference)
