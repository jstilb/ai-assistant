---
name: RetroAnalysis
description: Retrospective analysis of a completed work session. USE WHEN retro analysis, analyze work log, review session, post-mortem.
---

# RetroAnalysis Workflow

Analyze a completed MEMORY/WORK/ session log to evaluate agent decision quality, resource efficiency, error recovery, and compliance.

## Steps

### 1. Identify Session

If the user provides a work directory path, use it directly. Otherwise, list recent sessions:

```bash
ls -dt ~/.claude/MEMORY/WORK/2026*/ | head -10
```

### 2. Run Retrospective

```bash
bun run ~/.claude/skills/System/AgentMonitor/Tools/MonitorCore.ts retro --work-dir <path>
```

This parses the session log, converts events to traces, runs the full evaluator pipeline, and generates a report.

### 3. Review Results

Present the evaluation report with:
- Overall score and pass/fail status
- Per-evaluator breakdown (Resource Efficiency, Latency, Error Rate, Decision Quality, Compliance)
- Key findings and recommendations
- Comparison to baseline (if available)

### 4. Capture Learnings

If the evaluation reveals actionable patterns, note them for the ContinualLearning pipeline.
