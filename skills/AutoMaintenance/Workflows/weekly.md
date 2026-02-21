# Weekly Maintenance Workflow

Comprehensive system maintenance with security scanning, cleanup, and reporting.

**Trigger:** `/maintenance weekly`
**Schedule:** Staggered across Sunday/Monday/Tuesday via launchd (or unified via `weekly-orchestrated`)
**Duration:** < 10 minutes total
**CLI:** `bun run ~/.claude/skills/AutoMaintenance/Tools/Workflows.ts --tier weekly`

## Prerequisites

- Kaya system installed and configured
- TruffleHog installed (optional, for secret scanning)

## Staggered Schedule

To avoid rate limits, weekly tasks are spread across three days:

| Day | Tier | Steps |
|-----|------|-------|
| Sunday 8am | `weekly-security` | Full audit, secret scanning, privacy validation |
| Monday 8am | `weekly-cleanup` | State cleanup, log rotation |
| Tuesday 8am | `weekly-reports` | Memory consolidation, weekly report |

Alternatively, use `weekly-orchestrated` to run everything on Sunday with correct ordering (learning before cleanup).

## Execution

### Phase 1: Security (Sunday)

#### Full Audit
Scans 16 domains for broken symlinks: skills, hooks, memory, config, tools, workflows, templates, agents, sessions, learning, work, archive, docs, tests, integrations, secrets.

**Metrics:** `domainsChecked`, `issuesFound`

#### Secret Scanning (parallel)
Runs TruffleHog filesystem scan against `~/.claude`, excluding gitignored directories (file-history, projects, paste-cache, .cache, debug, backups, logs, node_modules, .bun). Only counts VERIFIED secrets as critical.

**Metrics:** `secretsFound`, `verifiedSecrets`

#### Privacy Validation (parallel)
Checks that USER content (code/config files) does not appear in SYSTEM locations. Excludes documentation files and templates.

**Metrics:** `violations`

### Phase 2: Cleanup (Monday)

#### State Cleanup
Archives completed WORK items older than 7 days by moving `completed_*` directories to `MEMORY/ARCHIVE/WORK/`.

**Metrics:** `archived`

#### Log Rotation
- Deletes debug logs older than 14 days from `~/.claude/debug/`
- Deletes file-history directories older than 30 days from `~/.claude/file-history/`
- Deletes validation JSONL files older than 7 days from `MEMORY/VALIDATION/`
- Deletes ephemeral agent todo files older than 3 days from `~/.claude/todos/`
- Deletes StateManager `.backup.json` files older than 7 days from `MEMORY/daemon/cron/`

**Metrics:** `filesRemoved`

### Phase 3: Reports (Tuesday)

#### Memory Consolidation
Runs `MemoryStore.ts consolidate --json` to archive hot entries and enforce TTL.

**Metrics:** `entriesArchived`, `ttlExpired`

#### Weekly Report Generation
Collects all step results and generates a markdown report with summary table.

**Report output:** `~/.claude/MEMORY/AutoMaintenance/weekly/YYYY-MM-DD.md`

### Notifications

- Voice notification on workflow start
- Voice notification on completion
- Push notification (high priority) if security issues found

## Error Handling

If any step fails:
1. Error is logged to `MEMORY/AutoMaintenance/errors.jsonl`
2. Workflow continues to next step
3. Failed sections are marked in the report

## Output

- Report: `~/.claude/MEMORY/AutoMaintenance/weekly/YYYY-MM-DD.md`
- Errors: `~/.claude/MEMORY/AutoMaintenance/errors.jsonl`

## ISC (Ideal State Criteria)

- [ ] Full integrity audit completed
- [ ] Secret scan passed
- [ ] Privacy validation passed
- [ ] State cleanup completed
- [ ] Log rotation completed
- [ ] Memory consolidation completed
- [ ] Weekly report generated

## What This Workflow Does NOT Handle

| Concern | Handled By |
|---------|------------|
| Context refresh | InformationManager |
| Signal synthesis | ContinualLearning |
| Learning consolidation | ContinualLearning |
