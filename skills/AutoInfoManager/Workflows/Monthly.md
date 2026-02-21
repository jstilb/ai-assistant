# Monthly Workflow

Deep monthly maintenance workflow including learning synthesis and orphan recovery.

## Schedule

**Time:** 1st of month at 5:00 AM
**Duration:** < 15 minutes
**Trigger:** `/autoinfo monthly`
**Inherits:** Daily + Weekly workflow steps

## Purpose

Perform deep learning synthesis across the month and recover orphaned notes.

## Steps

### Inherited from Daily
1. NotifyStart
2. OrganizeScratchPad
3. SyncAll (parallel)
4. SyncContextIndex
5. SaveReport (daily)
6. DailyBriefing

### Inherited from Weekly
7. NotifyWeeklyStart
8. RefreshAll (parallel)
9. SynthesizePatterns
10. CheckKayaUpgrade
11. SaveReport (weekly)

### Monthly-Specific Steps

### 12. NotifyMonthlyStart
Send voice notification that monthly workflow is starting.

### 13. DeepSynthesis
**Invokes:** ContinualLearning/GenerateIntelligence

Deep learning synthesis in monthly mode:
- Analyze all learning signals from past month
- Identify cross-session patterns
- Generate intelligence report
- Connect insights to TELOS goals

### 14. OrphanRecovery
**Invokes:** AutoInfoManager/OrphanRecovery workflow

Graph-based orphan note detection and recovery:
- Build note link graph
- Identify notes with zero incoming links
- Suggest connection opportunities
- Auto-link where confident

### 15. SaveReport
Save report to deterministic path:
- `MEMORY/AUTOINFO/monthly/{YYYY-MM}.md`

### 16. NotifyComplete
Send voice notification with completion status and key highlights.

## Output

**Report Path:** `MEMORY/AUTOINFO/monthly/{YYYY-MM}.md`

**Report Contents:**
- Executive summary
- All steps executed with detailed outcomes
- Deep synthesis from ContinualLearning
- Orphan recovery results
- Comprehensive metrics
- Recommendations for next month

## Error Handling

- Multi-level retry (step, group, workflow)
- Checkpoint saving after each group
- Resume from last successful step on failure
- Comprehensive error logging
- Push notification for critical failures
- Graceful degradation for non-critical steps

## Dependencies

| Skill | Workflow | Purpose |
|-------|----------|---------|
| All Daily/Weekly dependencies | - | Inherited |
| ContinualLearning | GenerateIntelligence | Deep monthly synthesis |
| AutoInfoManager | OrphanRecovery | Note recovery |

## Metrics Collected

| Metric | Description |
|--------|-------------|
| All weekly metrics | Inherited |
| orphansFound | Notes with no incoming links |
| orphansRecovered | Notes successfully linked |
| deepInsightsGenerated | Cross-session insights found |

## CLI Usage

```bash
# Execute monthly workflow
bun ~/.claude/skills/AutoInfoManager/Tools/AutoInfoRunner.ts --tier monthly

# Dry run (preview steps)
bun ~/.claude/skills/AutoInfoManager/Tools/AutoInfoRunner.ts --tier monthly --dry-run

# Resume from checkpoint (if interrupted)
bun ~/.claude/skills/AutoInfoManager/Tools/AutoInfoRunner.ts --resume <checkpoint-path>
```

## launchd Schedule

**Plist:** `~/Library/LaunchAgents/com.pai.autoinfo-monthly.plist`

Runs at 5:00 AM on the 1st of each month when user is logged in.
