---
name: AutoInfoManager
description: Autonomous information maintenance workflows with tiered execution. USE WHEN autoinfo daily, autoinfo weekly, autoinfo monthly, maintenance workflows, orphan recovery, scheduled maintenance.
---

# AutoInfoManager

Autonomous information management workflows using CLI-first deterministic execution, AgentOrchestrator-managed parallel processing, and comprehensive error handling.

## Purpose

Enable headless maintenance workflows that keep information context fresh, connected, and accessible without user involvement. This skill:
- Executes tiered workflows (daily, weekly, monthly)
- Integrates InformationManager for context sync and refresh
- Uses AgentOrchestrator for parallel agent spawning with synthesis
- Provides deterministic output paths and structured error logging
- Supports checkpointing for resumable workflows

## Architecture

```
launchd plist → shell script → AutoInfoRunner.ts → TierExecutor + AgentOrchestrator
```

### Core Components

| Component | Purpose |
|-----------|---------|
| **AutoInfoRunner.ts** | Main CLI entry point with config-driven TierExecutor integration |
| **TierExecutor.ts** | AgentOrchestrator wrapper for parallel workflow management |
| **ErrorLogger.ts** | Structured error logging to JSONL |
| **OrphanRecovery.ts** | MEMORY orphan detection - scans for unreferenced files |

## Voice Notification

-> Use `notifySync()` from `skills/CORE/Tools/NotificationService.ts`

## Workflow Routing

| Trigger | Workflow | Schedule |
|---------|----------|----------|
| `/autoinfo daily` | Daily tier execution | 7am daily |
| `/autoinfo weekly` | Weekly tier execution | Sunday 6am |
| `/autoinfo monthly` | Monthly tier execution | 1st of month 5am |
| `/autoinfo status` | Show last run times and health | Manual |
| `/autoinfo errors` | View recent errors | Manual |
| `/autoinfo --dry-run` | Preview steps without executing | Manual |

## Tier Overview

| Tier | Purpose | Key Operations |
|------|---------|----------------|
| **Daily** | Organize inbox, sync all sources, briefing | OrganizeScratchPad → Sync All → DailyBriefing |
| **Weekly** | Refresh sources, synthesize patterns | Daily + Refresh All → SynthesizePatterns → Kaya Check |
| **Monthly** | Deep synthesis, orphan recovery | Weekly + GenerateIntelligence → OrphanRecovery |

### Daily Workflow

**Steps:**
1. Notify start via NotificationService
2. **OrganizeScratchPad** (InformationManager/Organize-ScratchPad) — FIRST
3. **Sync All** via TierExecutor parallel group:
   - Sync-LucidTasks, Sync-Calendar, Sync-Dtr, Sync-Learnings
   - Sync-Obsidian, Sync-Projects, Sync-Skills, Sync-Telos
4. **Sync-ContextIndex** (after syncs complete)
5. Save report to deterministic path
6. **DailyBriefing** (InformationManager/DailyBriefing) — delivers to voice/telegram/push
7. Notify complete

**InformationManager workflows invoked:**
- `Organize-ScratchPad`, `Sync-LucidTasks`, `Sync-Calendar`, `Sync-Dtr`, `Sync-Learnings`, `Sync-Obsidian`, `Sync-Projects`, `Sync-Skills`, `Sync-Telos`, `Sync-ContextIndex`, `DailyBriefing`

### Weekly Workflow

**Steps (includes Daily):**
1. Daily steps (inherited)
2. **Refresh Non-Vault** via TierExecutor parallel group:
   - Refresh-Drive, Refresh-Learnings, Refresh-Projects
3. **Refresh Vault Folders** via parallel agents (48 folders, max 8 concurrent):
   - Dynamically reads folders from `~/Desktop/obsidian/`
   - Each agent runs `Refresh-VaultFolder` for one folder
4. **Refresh-Vault** (aggregates folder contexts into VaultContext.md)
5. **SynthesizePatterns** (ContinualLearning/SynthesizePatterns)
6. **CheckKayaUpgrade** (check for updates, no auto-update)
7. Save report
8. Notify complete

**InformationManager workflows invoked:**
- All daily + `Refresh-Drive`, `Refresh-Learnings`, `Refresh-Projects`, `Refresh-VaultFolder` (×48), `Refresh-Vault`

**Other skills invoked:**
- `ContinualLearning/SynthesizePatterns`
- `KayaUpgrade` (check only)

### Monthly Workflow

**Steps (includes Weekly):**
1. Weekly steps (inherited)
2. **DeepSynthesis** (ContinualLearning/GenerateIntelligence) — monthly deep learning synthesis
3. **OrphanRecovery** (AutoInfoManager/OrphanRecovery) — graph-based orphan finder
4. Save report
5. Notify complete

**Other skills invoked:**
- `ContinualLearning/GenerateIntelligence` (monthly mode)
- `AutoInfoManager/OrphanRecovery`

## CLI Usage

```bash
# Execute tiers
bun ~/.claude/skills/AutoInfoManager/Tools/AutoInfoRunner.ts --tier daily
bun ~/.claude/skills/AutoInfoManager/Tools/AutoInfoRunner.ts --tier weekly
bun ~/.claude/skills/AutoInfoManager/Tools/AutoInfoRunner.ts --tier monthly

# Dry run (show steps without executing)
bun ~/.claude/skills/AutoInfoManager/Tools/AutoInfoRunner.ts --tier weekly --dry-run

# Resume from checkpoint
bun ~/.claude/skills/AutoInfoManager/Tools/AutoInfoRunner.ts --resume <checkpoint-path>

# Status and health
bun ~/.claude/skills/AutoInfoManager/Tools/AutoInfoRunner.ts --status
bun ~/.claude/skills/AutoInfoManager/Tools/AutoInfoRunner.ts --health

# View recent errors
bun ~/.claude/skills/AutoInfoManager/Tools/AutoInfoRunner.ts --errors
```

## Output Files

### Deterministic Naming

```
MEMORY/AUTOINFO/
├── daily/
│   └── {YYYY-MM-DD}.md          # 2026-02-01.md
├── weekly/
│   └── {YYYY-WW}.md             # 2026-05.md (week 5)
├── monthly/
│   └── {YYYY-MM}.md             # 2026-02.md
├── errors/
│   └── {YYYY-MM-DD}.jsonl       # Error log
└── state/
    └── last-runs.json           # Execution tracking
```

### Report Format

Each report includes:
1. **Header**: Tier, date, duration, status
2. **Steps executed**: With timing and outcome
3. **Synthesized summary**: Via AgentOrchestrator
4. **Metrics**: Items processed, sources synced/refreshed
5. **Issues**: Any errors with recovery status
6. **Footer**: Next run scheduled

## Scheduling

### launchd Plists

| Plist | Schedule | Command |
|-------|----------|---------|
| `com.pai.autoinfo-daily.plist` | 7am daily | `bun AutoInfoRunner.ts --tier daily` |
| `com.pai.autoinfo-weekly.plist` | Sunday 6am | `bun AutoInfoRunner.ts --tier weekly` |
| `com.pai.autoinfo-monthly.plist` | 1st 5am | `bun AutoInfoRunner.ts --tier monthly` |

### Shell Runner

```bash
# bin/pai-autoinfo.sh
exec bun ~/.claude/skills/AutoInfoManager/Tools/AutoInfoRunner.ts "$@"
```

## Error Handling

### Structured Error Logging

Errors are logged to `MEMORY/AUTOINFO/errors/{YYYY-MM-DD}.jsonl`:

```json
{
  "timestamp": "2026-02-01T07:05:23.456Z",
  "tier": "daily",
  "step": "Sync-LucidTasks",
  "error": "Connection timeout",
  "stack": "...",
  "recoveryAttempted": true,
  "recoverySucceeded": false
}
```

### Recovery Mechanisms

1. **Step-level retry** - TierExecutor handles retries with exponential backoff
2. **Checkpoint resume** - Resume from last successful step
3. **Graceful degradation** - Continue with available sources if one fails
4. **Notification on failure** - Voice alert with failed step name

## Integration

### Uses
- **TierExecutor** (`Tools/TierExecutor.ts`) - Parallel workflow execution
- **AgentOrchestrator** (`skills/CORE/Tools/AgentOrchestrator.ts`) - Parallel agent spawning
- **NotificationService** (`skills/CORE/Tools/NotificationService.ts`) - Voice notifications
- **MemoryStore** (`skills/CORE/Tools/MemoryStore.ts`) - Report storage
- **InformationManager** - Context sync and refresh workflows
- **ContinualLearning** - Learning synthesis (weekly/monthly)

### Feeds Into
- **MEMORY/AUTOINFO/** - All maintenance reports
- **Context files** - Updated by InformationManager workflows
- **Learning patterns** - Synthesized by ContinualLearning

### Dependencies

| Skill | Workflows Used | Purpose |
|-------|----------------|---------|
| InformationManager | Organize-ScratchPad | Inbox triage |
| InformationManager | Sync-* (8 workflows) | Source → context sync |
| InformationManager | Sync-ContextIndex | Update context freshness index |
| InformationManager | Refresh-Drive/Learnings/Projects | In-place source refresh |
| InformationManager | Refresh-VaultFolder (×48) | Individual folder context refresh |
| InformationManager | Refresh-Vault | Aggregate vault context |
| InformationManager | DailyBriefing | Morning briefing delivery |
| ContinualLearning | SynthesizePatterns | Weekly pattern analysis |
| ContinualLearning | GenerateIntelligence | Monthly deep synthesis |
| KayaUpgrade | Check | Weekly update check |
| AutoInfoManager | OrphanRecovery | Monthly orphan detection |

### MCPs Used
- None directly (delegates to InformationManager for external access)

## Examples

**Example 1: Run daily maintenance**
```
User: autoinfo daily
Kaya: Running daily autoinfo workflow...
      Organized 5 scratchpad items
      Synced 8 sources
      Daily briefing delivered
      Report saved to MEMORY/AUTOINFO/daily/2026-02-01.md
```

**Example 2: Check status**
```
User: autoinfo status
Kaya: AutoInfo Status:
      Daily: Last run 2026-02-01 07:00, SUCCESS
      Weekly: Last run 2026-01-26 06:00, SUCCESS
      Monthly: Last run 2026-02-01 05:00, SUCCESS
      Next daily: 2026-02-02 07:00
```

**Example 3: View errors**
```
User: autoinfo errors
Kaya: Recent errors (last 7 days):
      2026-01-30: Weekly/SynthesizePatterns - Timeout (recovered)
      No critical errors.
```

---

**Last Updated:** 2026-02-06
