# TELOS Reference

Quick reference for TELOS file locations, purposes, and data sources.

## TELOS File Locations

All TELOS files are in `~/.claude/skills/CORE/USER/TELOS/`:

| File | Purpose | Primary Data Source |
|------|---------|-------------------|
| MISSIONS.md | 7 life missions (M0-M6) | alignment (roles A2:H8) |
| GOALS.md | 36 annual goals by mission | alignment (progress!A75:Z108) |
| CHALLENGES.md | Current obstacles (C0-C6) | habit_building, goal_achievement |
| STRATEGIES.md | 6 lead measures (S0-S5) | goal_achievement |
| STATUS.md | Current state snapshot | All sheets (composite) |
| PROJECTS.md | Asana project mapping | Asana |

## File Purposes

### MISSIONS.md
Contains the 7 life missions defining who {principal.name} strives to be:
- **M0: Adventurer** - Free spirit who braves adventure
- **M1: Community Member** - Leader driving positive change
- **M2: Creative** - Soul exploring through art
- **M3: Family Man** - Loving partner and family member
- **M4: Friend** - Dependable man to his friends
- **M5: Professional** - Leader improving the world at scale
- **M6: Self** - Conscious being improving all aspects

### GOALS.md
36 annual goals organized by mission with progress tracking.

### CHALLENGES.md
Current obstacles categorized by type:
- C0-C6: Mission-specific challenges
- Includes root causes and mitigation strategies

### STRATEGIES.md
6 lead measures (S0-S5) that drive goal achievement:
- S0: Boredom Blocks
- S1: Pomodoro technique
- S2: STORER framework
- S3: Community Events
- S4: Social Invitations
- S5: Alignment Hour

### STATUS.md
Real-time snapshot of current state across all metrics.

### PROJECTS.md
Active projects mapped from Asana with priorities and dependencies.

## Asana Integration

**Workspace GID:** `1204453550639466`

```javascript
mcp__asana__asana_search_projects({
  workspace: "1204453550639466",
  name_pattern: ".*"
})
```

## Update Scopes

When updating TELOS files, use these scopes:

| Request | Files to Update |
|---------|----------------|
| "update status" | STATUS.md only |
| "refresh everything" | All TELOS files |
| "update metrics" | STRATEGIES.md, STATUS.md |
| "sync challenges" | CHALLENGES.md, STATUS.md |
| "sync projects" | PROJECTS.md |

## Data Flow

```
Google Sheets (DTR)
    |
InformationManager/SyncTelos workflow
    |
TELOS files (CORE/USER/TELOS/)
    |
RegenerateUserContext workflow
    |
CORE/USER/UserContext.md
```

---

*Reference file for TELOS-related workflows. Contains file locations and data sources.*
