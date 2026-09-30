# Monthly Maintenance Workflow

Workspace cleanup and comprehensive skill health review.

**Trigger:** `/maintenance monthly`
**Schedule:** First week of month, staggered Thursday/Friday/Saturday via launchd
**Duration:** < 15 minutes total
**CLI:** `bun run ~/.claude/skills/Automation/AutoMaintenance/Tools/Workflows.ts --tier monthly`

## Prerequisites

- Kaya system installed and configured
- Git repository initialized in `~/.claude`

## Staggered Schedule (First Week Only)

| Day | Tier | Steps |
|-----|------|-------|
| Thursday 8am | `monthly-workspace` | Workspace cleanup |
| Friday 8am | `monthly-skills` | Skill audit |
| Saturday 8am | `monthly-reports` | Monthly report generation |

## Execution

The full `monthly` tier includes all daily and weekly steps plus the monthly-specific steps below.

### Phase 1: Workspace Cleanup (Thursday)

#### Workspace Cleanup
1. **Stale branches:** Finds git branches already merged into main (excludes `main`, `master`, and current branch)
2. **Orphaned files:** Counts `.DS_Store` files across `~/.claude`
3. **Temp files:** Deletes files older than 7 days from `~/.claude/scratch/`

**Metrics:** `staleBranches`, `orphanedFiles`, `tempDirsCleaned`

### Phase 2: Skill Audit (Friday)

#### Skill Audit
Iterates all directories under `~/.claude/skills/` and checks:
1. `SKILL.md` exists in each skill directory
2. No broken symlinks within each skill directory

Skills without `SKILL.md` or with broken symlinks are flagged as needing attention.

**Metrics:** `skillsChecked`, `healthySkills`, `brokenReferences`

### Phase 3: Monthly Report (Saturday)

#### Monthly Report Generation
Collects workspace cleanup and skill audit results, plus counts of daily and weekly report files for the month.

**Report output:** `~/.claude/MEMORY/AutoMaintenance/monthly/YYYY-MM-DD.md`

### Notifications

- Voice notification on workflow start
- Voice notification on completion

## Error Handling

If any step fails:
1. Error is logged to `MEMORY/AutoMaintenance/errors.jsonl`
2. Workflow continues to next step
3. Failed sections are marked in the report

## Output

- Report: `~/.claude/MEMORY/AutoMaintenance/monthly/YYYY-MM-DD.md`
- Errors: `~/.claude/MEMORY/AutoMaintenance/errors.jsonl`

## ISC (Ideal State Criteria)

- [ ] Workspace cleanup completed
- [ ] Skill audit completed
- [ ] Monthly report generated

## What This Workflow Does NOT Handle

| Concern | Handled By |
|---------|------------|
| Kaya upgrade monitoring | KayaUpgrade |
| Context refresh | InformationManager |
| Security scanning | Weekly workflow |
| Learning consolidation | ContinualLearning |
