# Daily Maintenance Workflow

Lightweight daily checks to ensure Kaya system health.

**Trigger:** `/maintenance daily`
**Schedule:** 8am daily via launchd
**Duration:** < 5 minutes
**CLI:** `bun run ~/.claude/skills/AutoMaintenance/Tools/Workflows.ts --tier daily`

## Prerequisites

- Kaya system installed and configured
- `~/.claude/skills/CORE/SKILL.md`, `~/.claude/settings.json`, `~/.claude/MEMORY/`, and `~/.claude/hooks/` must exist

## Execution

All steps run via the WorkflowExecutor with ISC validation.

### Step 1: Integrity Check (parallel)

Verifies critical Kaya paths exist and scans for broken symlinks:

- `~/.claude/skills/CORE/SKILL.md`
- `~/.claude/settings.json`
- `~/.claude/MEMORY/`
- `~/.claude/hooks/`

Also runs `find` to detect broken symlinks across `~/.claude`.

**Metrics:** `checked` (path count), `brokenLinks` (count)

### Step 2: Update Claude CLI (parallel)

Checks for and installs Claude CLI updates:

1. Record current version via `claude --version`
2. Run `claude update --yes` (60s timeout)
3. Record new version
4. Compare versions to detect update

**Metrics:** `updated` (0 or 1)

### Step 3: Generate Daily Report

Collects results from steps 1-2 and generates a markdown report.

**Report output:** `~/.claude/MEMORY/AutoMaintenance/daily/YYYY-MM-DD.md`

### Notifications

- Voice notification on workflow start
- Voice notification on workflow completion (or push on failure)

## Error Handling

If any step fails:
1. Error is logged to `MEMORY/AutoMaintenance/errors.jsonl`
2. Workflow continues to next step (non-blocking)
3. Failure is reflected in ISC score

## Output

- Report: `~/.claude/MEMORY/AutoMaintenance/daily/YYYY-MM-DD.md`
- Errors: `~/.claude/MEMORY/AutoMaintenance/errors.jsonl`

## ISC (Ideal State Criteria)

- [ ] Critical paths verified
- [ ] No broken symlinks
- [ ] Claude CLI version checked
- [ ] Daily report generated

## What This Workflow Does NOT Handle

| Concern | Handled By |
|---------|------------|
| Context refresh | InformationManager |
| Signal synthesis | ContinualLearning |
| State cleanup | Weekly workflow |
| Log rotation | Weekly workflow |
