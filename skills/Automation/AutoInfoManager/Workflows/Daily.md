# Daily Workflow

Lightweight daily maintenance workflow designed to complete in under 5 minutes.

## Schedule

**Time:** 7:00 AM daily
**Duration:** < 5 minutes
**Trigger:** `/autoinfo daily`

## Purpose

Organize inbox items, sync all context sources, and deliver morning briefing.

## Steps

### 1. NotifyStart
Send voice notification that daily workflow is starting.

### 2. OrganizeScratchPad
**Invokes:** InformationManager/Organize-ScratchPad

Triage inbox items from the Obsidian scratch pad:
- Sort items by type (task, note, reference)
- Route to appropriate destinations (calendar, LucidTasks, vault)
- Archive processed items

### 3. SyncAll (Parallel Group)
**Uses TierExecutor parallel execution**

Sync all context sources in parallel:

| Workflow | Purpose |
|----------|---------|
| Sync-LucidTasks | LucidTasks → context/LucidTasksContext.md |
| Sync-Calendar | Calendar → context/CalendarContext.md |
| Sync-Dtr | DTR sheets → context/DtrContext.md |
| Sync-Learnings | MEMORY/LEARNING → context/LearningsContext.md |
| Sync-Obsidian | Vault → context/ObsidianContext.md |
| Sync-Projects | ~/Desktop/projects → context/ProjectsContext.md |
| Sync-Telos | TELOS files → context/TelosContext.md |

### 4. SyncContextIndex
**Invokes:** InformationManager/Sync-ContextIndex

Update CONTEXT-INDEX.md with freshness timestamps after all syncs complete.

### 5. SaveReport
Save report to deterministic path:
- `MEMORY/AUTOINFO/daily/{YYYY-MM-DD}.md`

### 6. DailyBriefing
**Invokes:** InformationManager/DailyBriefing

Generate and deliver morning briefing:
- Aggregate calendar, tasks, goals
- Deliver to all channels (voice, telegram, push)
- Save briefing log to MEMORY/BRIEFINGS/

### 7. NotifyComplete
Send voice notification with completion status.

## Output

**Report Path:** `MEMORY/AUTOINFO/daily/{YYYY-MM-DD}.md`

**Report Contents:**
- Summary table with date, duration, status
- Steps executed with outcomes
- Metrics (items organized, sources synced)
- Next scheduled run

## Error Handling

- Step-level retry with 2 attempts
- Errors logged to `MEMORY/AUTOINFO/errors/{YYYY-MM-DD}.jsonl`
- Voice notification on failure
- Graceful degradation (continue if non-critical step fails)

## Dependencies

| Skill | Workflow | Purpose |
|-------|----------|---------|
| InformationManager | Organize-ScratchPad | Inbox triage |
| InformationManager | Sync-* (8 workflows) | Source sync |
| InformationManager | Sync-ContextIndex | Update freshness index |
| InformationManager | DailyBriefing | Morning briefing |
| NotificationService | - | Voice alerts |

## Metrics Collected

| Metric | Description |
|--------|-------------|
| itemsOrganized | Number of scratchpad items processed |
| sourcesSynced | Number of context sources synced |
| errors | Number of errors encountered |

## CLI Usage

```bash
# Execute daily workflow
bun ~/.claude/skills/Automation/AutoInfoManager/Tools/AutoInfoRunner.ts --tier daily

# Dry run (preview steps)
bun ~/.claude/skills/Automation/AutoInfoManager/Tools/AutoInfoRunner.ts --tier daily --dry-run

# Check status
bun ~/.claude/skills/Automation/AutoInfoManager/Tools/AutoInfoRunner.ts --status
```

## launchd Schedule

**Plist:** `~/Library/LaunchAgents/com.pai.autoinfo-daily.plist`

Runs at 7:00 AM daily when user is logged in.
