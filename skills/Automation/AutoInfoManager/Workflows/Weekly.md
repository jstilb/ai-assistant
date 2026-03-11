# Weekly Workflow

Comprehensive weekly maintenance workflow including context refresh, learning synthesis, and Kaya update check.

## Schedule

**Time:** Sunday 6:00 AM
**Duration:** < 15 minutes
**Trigger:** `/autoinfo weekly`
**Inherits:** Daily workflow steps

## Purpose

Perform full context refresh (in-place updates), synthesize learning patterns, and check for Kaya updates.

## Steps

### Inherited from Daily
1. NotifyStart
2. OrganizeScratchPad
3. SyncAll (parallel)
4. SyncContextIndex
5. SaveReport (daily)
6. DailyBriefing

### Weekly-Specific Steps

### 7. NotifyWeeklyStart
Send voice notification that weekly workflow is starting.

### 8. RefreshNonVault (Parallel Group)
**Uses TierExecutor parallel execution**

Refresh non-vault sources in parallel:

| Workflow | Purpose |
|----------|---------|
| Refresh-Drive | Refresh Google Drive context IN Drive |
| Refresh-Learnings | Regenerate learning patterns IN MEMORY |
| Refresh-Projects | Refresh project READMEs IN projects |

### 9. RefreshVaultFolders (Parallel Agents)
**Uses TierExecutor with parallel agents (max 8 concurrent)**

Dynamically spawn agents to refresh each Obsidian folder:
- Reads folders from `~/Desktop/obsidian/`
- Excludes hidden folders (`.`) and system folders (`_`)
- Each agent runs `Refresh-VaultFolder` for one folder
- Currently: **48 folders** refreshed in parallel

This step uses the obsidian.json config to locate the vault:
```json
{
  "vaultPath": "/Users/[user]/Desktop/obsidian"
}
```

### 10. RefreshVault
**Invokes:** InformationManager/Refresh-Vault

Aggregate all folder contexts into VaultContext.md after individual folders are refreshed.

### 11. SynthesizePatterns
**Invokes:** ContinualLearning/SynthesizePatterns

Analyze learning signals from past week:
- Identify recurring patterns
- Connect insights to TELOS goals
- Generate weekly intelligence summary

### 12. CheckKayaUpgrade
Check for available Kaya updates:
- Run `git fetch --dry-run` in Kaya directory
- Report if updates are available
- Do not auto-update (requires approval)

### 13. SaveReport
Save report to deterministic path:
- `MEMORY/AUTOINFO/weekly/{YYYY-WW}.md`

### 14. NotifyComplete
Send voice notification with completion status.

## Output

**Report Path:** `MEMORY/AUTOINFO/weekly/{YYYY-WW}.md`

Where WW is the ISO week number (01-52).

**Report Contents:**
- Summary table with date, duration, status
- All steps executed with outcomes
- Folder refresh results (48 folders)
- Pattern synthesis summary
- Kaya update status
- Next scheduled run

## Error Handling

- Step-level retry with exponential backoff
- Parallel groups continue if one workflow fails
- Errors logged to `MEMORY/AUTOINFO/errors/{YYYY-MM-DD}.jsonl`
- Voice notification on critical failure
- Checkpointing for resume capability

## Dependencies

| Skill | Workflow | Purpose |
|-------|----------|---------|
| All Daily dependencies | - | Inherited |
| InformationManager | Refresh-Drive | Google Drive refresh |
| InformationManager | Refresh-Learnings | Learning patterns refresh |
| InformationManager | Refresh-Projects | Project READMEs refresh |
| InformationManager | Refresh-VaultFolder | Individual folder refresh (×48) |
| InformationManager | Refresh-Vault | Aggregate vault context |
| ContinualLearning | SynthesizePatterns | Weekly pattern analysis |
| KayaUpgrade | - | Update check |
| NotificationService | - | Voice alerts |

## Metrics Collected

| Metric | Description |
|--------|-------------|
| All daily metrics | Inherited |
| sourcesRefreshed | Number of non-vault sources refreshed |
| foldersRefreshed | Number of Obsidian folders refreshed |
| patternsFound | Patterns identified by ContinualLearning |
| paiUpdateAvailable | Boolean - Kaya updates available |

## CLI Usage

```bash
# Execute weekly workflow
bun ~/.claude/skills/Automation/AutoInfoManager/Tools/AutoInfoRunner.ts --tier weekly

# Dry run (preview steps)
bun ~/.claude/skills/Automation/AutoInfoManager/Tools/AutoInfoRunner.ts --tier weekly --dry-run

# List Obsidian folders that will be refreshed
bun ~/.claude/skills/Automation/AutoInfoManager/Tools/TierExecutor.ts --list-folders
```

## launchd Schedule

**Plist:** `~/Library/LaunchAgents/com.pai.autoinfo-weekly.plist`

Runs at 6:00 AM every Sunday when user is logged in.
