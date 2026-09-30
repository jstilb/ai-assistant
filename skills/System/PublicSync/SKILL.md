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
| "what would the mirror contain", "audit the public repo", "orphans on the mirror" | `bun Tools/FreshExport.ts --remote [user]/ai-assistant` |
| "recreate the public repo", "fresh mirror", "delete and republish" | `Workflows/Recreate.md` (Jm gate before the delete) |

## Slash Commands

| Command | Description |
|---------|-------------|
| `/sync` | Run an immediate manual sync. Reports commit count or "nothing to sync". |

## Quick Reference

- **Remote:** `https://<GITHUB_TOKEN>@github.com/[user]/ai-assistant.git` (token from `secrets.json`; SSH fallback interactively)
- **Staging:** `/tmp/pai-public-staging/` (separate clone, never a worktree)
- **Blocklist:** `State/blocklist.yaml` — **fail-closed**: `allowedTopLevel` is the gate, everything else narrows it. Missing/invalid yaml aborts the sync.
- **State:** `State/sync-state.json` — SHA-256 hash registry for incremental diffs
- **Automation:** `bun Tools/LaunchdPlist.ts install` — daily 2am launchd job
- **Dry-run:** `bun Tools/SyncRunner.ts --dry-run` — safe preview, no push (also lists orphans it would prune)
- **Full audit:** `bun Tools/FreshExport.ts --remote [user]/ai-assistant` — exact publish set + mirror diff + gate report, read-only
- **Recreate:** `bun Tools/SyncRunner.ts --auto --fresh` — one baseline commit into a recreated EMPTY repo (`Workflows/Recreate.md`)

## Three-Pass Pipeline

| Pass | Component | Purpose |
|------|-----------|---------|
| 1 | `BlocklistFilter` | Top-level allowlist, then exclude personal skills, State/Data/logs/config dirs, SQLite journals, listed paths |
| 2 | `SecretScanner` | Detect sk-ant-*, ghp_*, *_KEY=, *_SECRET=, absolute paths, **and the `blockedIdentifiers` literal denylist** (private Sheet/Drive IDs) |
| 3 | `ContentTransformer` | Normalize `~/.claude` → `~/.claude`, strip usernames, replace owner e-mail / LinkedIn handle |

**Prune:** every live run also deletes mirror paths the current blocklist no longer allows (its own `chore(publicsync): prune …` commit), so a file blocklisted after publication does not stay public forever.

## Safety (3 Independent Layers)

All three must pass before any push:
1. **Pattern scan** — regex scan on staged git diff output
2. **Path audit** — blocklist check on every staged path
3. **Size anomaly** — blocks files >500KB

## Published by Default (everything else is private)

- Top-level: `skills/`, `lib/`, `hooks/`, `tools/`, `.github/`, and the root project files (`README.md`, `CLAUDE.md`, `INSTALL.md`, `CONTEXT-*.md`, `install.ts`, `package.json`, `bunfig.toml`, `statusline*.sh`, `.gitignore`, `.gitattributes`)
- Inside those, still excluded: personal skills (Gmail, Telegram, JobHunter, JobBlitz, JobEngine, CalendarAssistant, NetworkMatch, Shopping, Instacart, Designer, Cooking, CommunityOutreach, **InformationManager, LifeOS**); `State/ Data/ data/ logs/ Config/ config/ Transcripts/` inside any skill; `secrets.json`, `settings*.json`, `.active-agents.json`, `.env*` at any depth; `.db*`, `.log*`, `.jsonl`, media/binary extensions; prompt-injection / command-guard hook code (publication decision, see `blocklist.yaml`)
- README.md at the root of an excluded **skill** is preserved; excluded top-level dirs get nothing

## Customization

Edit `State/blocklist.yaml` to customize what gets synced:

```yaml
# The gate: only these top-level entries can ever be published
allowedTopLevel:
  - skills
  - lib
  - README.md

# Defence in depth — top-level directories to exclude
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

# Exclude these directories at any depth inside a skill
excludedStateDirs: true
excludedSkillSubdirs:
  - State
  - Data
  - logs

# Add custom path prefixes to exclude
additionalExcludedPaths:
  - custom/private/path

# Exact private identifiers that must never be published (any file, any line)
blockedIdentifiers:
  - "1AbCdEf…44-char Google Sheet ID…"
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

**Example 3: Audit before publishing a new directory**
```
User: "I want to publish the new tools/ dir — what would go out?"
→ Add it to allowedTopLevel in State/blocklist.yaml
→ bun Tools/FreshExport.ts --remote [user]/ai-assistant
→ Review REPORT.md gates + the export tree; fix exclusions until every gate is PASS
```

**Example 4: Check sync status**
```
User: "sync status"
→ bun Tools/SyncRunner.ts --status
→ Shows last sync timestamp, commit hash, tracked file count
```

## Integration

### Uses
- `lib/core/StateManager.ts` — hash registry persistence (via pattern)
- `State/blocklist.yaml` — configurable exclusion rules
- `plugins/blocklist.json` — existing repo blocklist (read-only)

### Feeds Into
- `git@github.com:[user]/ai-assistant.git` — public mirror
- `State/sync-state.json` — incremental diff state
- `MEMORY/logs/publicsync.log` — audit trail
