# Sync-Telos Workflow

Sync TELOS files from Google Sheets and update status.

**Category:** Sync (Source → Kaya)
**Trigger:** `sync telos`, `update telos`, `refresh goals`, `sync status`

## Purpose

Keep TELOS files synchronized with the source of truth in Google Sheets. This workflow:
- Pulls fresh data from tracking sheets
- Compares against current TELOS files
- Updates specified files with new data
- Preserves file structure while updating metrics

This is a **Sync** workflow: it pulls data from Google Sheets into TELOS files.

## Flags

| Flag | Purpose |
|------|---------|
| `--status-only` | Only update STATUS.md (fast, focused update) |
| (default) | Full sync of all TELOS files |

## Prerequisites

- `kaya-cli sheets` available
- Internet connectivity for Google Sheets access
- Write access to `~/.claude/skills/CORE/USER/TELOS/`

## Reference

See `TelosReference.md` for file locations and data sources.
See `SheetReference.md` for sheet IDs and ranges.

## TELOS File Locations

All TELOS files are in `~/.claude/skills/CORE/USER/TELOS/`:

| File | Primary Data Source |
|------|-------------------|
| MISSIONS.md | alignment (roles A2:H8) |
| GOALS.md | alignment (progress!A75:Z108) |
| CHALLENGES.md | habit_building + goal_achievement |
| STRATEGIES.md | goal_achievement (lead measures) |
| STATUS.md | All sheets (composite) |
| PROJECTS.md | Asana |

## Execution Steps

### 1. Fetch Fresh Data

Pull current data from all relevant sheets:

```bash
# Alignment - roles and goals
kaya-cli sheets get 1LFOEWT6FQPupiyWEAOu9bxwB7C1dLvqAAn-S_fpf69U --range "progress!A1:Z120"

# Goal achievement - WIGs and leads
kaya-cli sheets get 1iiX2qfRn6Gx1q1yLu5Xu8nV-x7S_KA45gykjgQKTJdw --range "A1:Z50"

# Habit building - consistency data
kaya-cli sheets get 1xrGAGvKlgckHbjnMevs9ZhlwtNWaUL5CzzgRQ82X9LA --range "A1:AM50"
```

### 2. Identify Changes

Compare fetched data against current TELOS files:
- New goals added?
- Metrics changed significantly?
- Lead measure percentages updated?
- Challenge status changed?

### 3. Determine Update Scope

Based on flags or request:

| Request | Files to Update |
|---------|----------------|
| `--status-only` | STATUS.md only |
| "update status" | STATUS.md only |
| "refresh everything" | All TELOS files |
| "update metrics" | STRATEGIES.md, STATUS.md |
| "sync challenges" | CHALLENGES.md, STATUS.md |

### 4. Update Files

For each file to update:

1. **Read current file** (to preserve structure)
2. **Update metrics/data sections** with fresh values
3. **Update Last Updated date** (for STATUS.md)
4. **Write updated file**

### 5. Confirm Updates

Report what was updated:
- Files modified
- Key metrics changed
- Any anomalies detected

### 6. Optional: Asana Sync

If PROJECTS.md needs updating:

```javascript
mcp__asana__asana_search_projects({
  workspace: "1204453550639466",
  name_pattern: ".*"
})
```

## --status-only Mode

For quick STATUS.md updates (merges former SyncDTRToCore functionality):

```bash
# Fetch only needed sheets
kaya-cli sheets get 1iiX2qfRn6Gx1q1yLu5Xu8nV-x7S_KA45gykjgQKTJdw --range "A1:Z50"
kaya-cli sheets get 1LFOEWT6FQPupiyWEAOu9bxwB7C1dLvqAAn-S_fpf69U --range "progress!A1:Z10"
```

Update `~/.claude/skills/CORE/USER/TELOS/STATUS.md` with:

```markdown
---
last_updated: {{CURRENT_TIMESTAMP}}
source: InformationManager/Sync-Telos
---

# STATUS - Current State Snapshot

## Q1 2026 WIG Progress

| Goal | Target | Current | Status |
|------|--------|---------|--------|
| G0: Reduce low-value media | 3 hrs/day | {{current}} | {{on_track/behind/ahead}} |
| G1: Make 2 good friends | 2 friends | {{current}} | {{on_track/behind/ahead}} |
| G2: Raise alignment | 3.0 | {{current}} | {{on_track/behind/ahead}} |

## Lead Measure Performance (7-Day Rolling)

| Measure | Target | Current | Trend |
|---------|--------|---------|-------|
| S0: Boredom Blocks | 80% | {{pct}} | {{up/down/stable}} |
| S1: Pomodoro | 80% | {{pct}} | {{up/down/stable}} |
...

---
*Synced from DTR via InformationManager at {{timestamp}}*
```

## Output

After completion, report:
- Files updated
- Metrics changed (with before/after)
- Any data issues found
- Recommendation for next actions

## Tools Called

- `GatheringOrchestrator.ts --sources telos` (optional)

## Related Workflows

- **Sync-Dtr** - DTR metrics to DtrContext.md
- **Sync-All** - Full context refresh
- **Sync-ContextIndex** - Updates index after this runs
