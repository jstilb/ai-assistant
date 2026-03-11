---
name: PublicSync
description: Mirror private ~/.claude/ codebase to the public [user]/ai-assistant GitHub repo with sanitization. USE WHEN sync public repo OR mirror to github OR push to ai-assistant OR public sync OR sync skills to github.
---

# PublicSync

Continuously mirrors the private `~/.claude/` codebase to the public `[user]/ai-assistant` GitHub repo.
Runs a three-pass sanitization pipeline to ensure no personal data, secrets, or absolute paths leak.

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`

## Workflow Routing

| Trigger | Workflow |
|---------|----------|
| `/sync`, "sync", "sync now", "push to github" | `Workflows/Sync.md` |
| "sync status", "last sync" | `bun Tools/SyncRunner.ts --status` |
| "dry run", "preview sync", "what would sync" | `Workflows/DryRun.md` |

## Slash Commands

| Command | Description |
|---------|-------------|
| `/sync` | Run an immediate manual sync. Reports commit count or "nothing to sync". |

## Quick Reference

- **Remote:** `git@github.com:[user]/ai-assistant.git`
- **Staging:** `/tmp/pai-public-staging/` (separate clone, never a worktree)
- **Blocklist:** `State/blocklist.yaml` — edit to add/remove exclusions
- **State:** `State/sync-state.json` — SHA-256 hash registry for incremental diffs
- **Automation:** `bun Tools/LaunchdPlist.ts install` — daily 2am launchd job
- **Dry-run:** `bun Tools/SyncRunner.ts --dry-run` — safe preview, no push

## Three-Pass Pipeline

| Pass | Component | Purpose |
|------|-----------|---------|
| 1 | `BlocklistFilter` | Exclude MEMORY/, USER/, personal skills, State/ dirs |
| 2 | `SecretScanner` | Detect sk-ant-*, ghp_*, *_KEY=, *_SECRET=, absolute paths |
| 3 | `ContentTransformer` | Normalize `~/.claude` → `~/.claude`, strip usernames |

## Safety (3 Independent Layers)

All three must pass before any push:
1. **Pattern scan** — regex scan on staged git diff output
2. **Path audit** — blocklist check on every staged path
3. **Size anomaly** — blocks files >500KB

## Excluded by Default

- `MEMORY/`, `USER/`, `context/`, `plans/`
- `secrets.json` at any depth
- Personal skills: Gmail, Telegram, JobHunter, JobBlitz, JobEngine, CalendarAssistant, NetworkMatch, Shopping, Instacart, Designer, Cooking
- `State/` directories within any skill
- README.md files in excluded dirs are preserved

## Customization

Edit `State/blocklist.yaml` to customize what gets synced:

```yaml
# Add top-level directories to exclude
excludedDirs:
  - MEMORY
  - context
  - USER
  - plans

# Add specific filenames to exclude at any depth
excludedFiles:
  - secrets.json
  - .env

# Add personal skill names to exclude entirely
excludedSkills:
  - JobHunter
  - Gmail
  - MyPrivateSkill  # Add custom skills here

# Preserve README.md at root of excluded directories
preserveReadmes: true

# Exclude State/ directories within any skill
excludedStateDirs: true

# Add custom path prefixes to exclude
additionalExcludedPaths:
  - custom/private/path
```

To add a new exclusion without touching code, edit `State/blocklist.yaml` and run `/sync` again.

## Examples

**Example 1: Manual sync**
```
User: "sync the public repo"
→ Invokes Sync workflow
→ Runs --dry-run preview
→ If clean, runs full sync
→ Commits grouped by skill (feat(DailyBriefing): ...)
→ Pushes to [user]/ai-assistant
```

**Example 2: Preview without pushing**
```
User: "dry run the public sync"
→ Invokes DryRun workflow
→ Shows changed files, blocked files, commit preview
→ No push occurs
```

**Example 3: Check sync status**
```
User: "sync status"
→ bun Tools/SyncRunner.ts --status
→ Shows last sync timestamp, commit hash, tracked file count
```

## Integration

### Uses
- `CORE/Tools/StateManager.ts` — hash registry persistence (via pattern)
- `State/blocklist.yaml` — configurable exclusion rules
- `plugins/blocklist.json` — existing repo blocklist (read-only)

### Feeds Into
- `git@github.com:[user]/ai-assistant.git` — public mirror
- `State/sync-state.json` — incremental diff state
- `MEMORY/logs/publicsync.log` — audit trail
