---
name: Status
description: Check current AgentMonitor state — trace file count, baseline summary, recent alerts, and audit stats. USE WHEN monitor status, agent status, check monitoring, show anomalies, monitoring health.
---

# Status Workflow

Display the current state of the AgentMonitor system: trace file count, baseline summary (historical — no live writer since evals-rebuild slice C2), recent alerts, and audit stats.

## Trigger

- "monitor status", "agent status", "check monitoring", "show anomalies"

## Command

```bash
bun run ~/.claude/skills/System/AgentMonitor/Tools/MonitorCore.ts status
```

## Steps

### 1. Run Status Check

```bash
bun run ~/.claude/skills/System/AgentMonitor/Tools/MonitorCore.ts status
```

This reads and displays:
- Trace file count from `MEMORY/MONITORING/traces/`
- Baseline summary from `MEMORY/MONITORING/baselines/baselines.json` (if present)
- Recent alerts from `MEMORY/MONITORING/audit/alerts.jsonl` (last 5)
- Audit stats (total events, error count) from `MEMORY/MONITORING/audit/monitor-audit.jsonl`

### 2. Interpret Results

Present the output with:
- Most recent alert timestamps and types
- Whether the live monitoring pipeline appears active (recent trace files / alerts)

### 3. Identify Action Items

If alerts are stale (no recent activity):
- Confirm whether the live pipeline is running or has stopped
- Suggest `watch` command to restart live monitoring if needed

If a workflow needs root-cause analysis:
- Suggest `bun Tools/TraceAuditor.ts --workflow <id>`
- Check `intervention-config.json` for pending intervention approvals
