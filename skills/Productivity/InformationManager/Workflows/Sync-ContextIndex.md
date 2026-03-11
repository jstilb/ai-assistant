# Sync-ContextIndex Workflow

Update CONTEXT-INDEX.md with source freshness status.

**Category:** Sync (Source → Kaya)
**Trigger:** `sync context index`, `refresh context index`, `update context index`, `context status`

## Purpose

Orchestrate context status checking and regenerate CONTEXT-INDEX.md with:
- Source status table with freshness indicators
- Key metrics per source
- Last-updated timestamps
- Links to detailed context files

This is a **Sync** workflow: it reads context file metadata and updates the index.

## Execution Steps

### 1. Voice Notification (Start)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Starting context index refresh"}' \
  > /dev/null 2>&1 &
```

### 2. Option A: Full Refresh (All Sources)

Run sub-workflows in parallel via AgentGatherer:

```bash
bun ~/.claude/skills/Productivity/InformationManager/Tools/AgentGatherer.ts \
  --sources lucidtasks,calendar,dtr,learnings,obsidian,projects,telos \
  --strategy merge
```

Or sequentially via GatheringOrchestrator:

```bash
bun ~/.claude/skills/Productivity/InformationManager/Tools/GatheringOrchestrator.ts --mode consolidate
```

### 2. Option B: Index Only (No Re-gather)

Skip gathering, just regenerate the index from existing context files:

```bash
bun ~/.claude/skills/Productivity/InformationManager/Tools/GenerateContextIndex.ts
```

### 3. Run GenerateContextIndex.ts

After gathering (if applicable), regenerate the CONTEXT-INDEX.md:

```bash
bun ~/.claude/skills/Productivity/InformationManager/Tools/GenerateContextIndex.ts
```

This:
1. Reads all context files in `~/.claude/context/`
2. Extracts metadata (timestamps, entry counts)
3. Calculates freshness status (Fresh/Stale/Outdated)
4. Generates new CONTEXT-INDEX.md

### 3b. Run GenerateContextRouting.ts

After regenerating CONTEXT-INDEX.md, rebuild the on-demand context routing table:

```bash
bun ~/.claude/skills/Productivity/InformationManager/Tools/GenerateContextRouting.ts
```

This:
1. Scans `context/*.md`, `USER/**/*.md` (non-compressed), `skills/*/SKILL.md`
2. Assigns each file to one of 7 topic categories (Kaya System, User Identity, Life Goals/Telos, Projects, Live Context Sources, Memory System, Configuration)
3. Writes a compact markdown lookup table to `~/.claude/CONTEXT-ROUTING.md` (atomic write)
4. On failure: keeps existing file, logs error to stderr, does not block the workflow

### 4. Report Results

Output summary:
- Sources analyzed
- Freshness breakdown (Fresh/Stale/Outdated)
- Any missing context files
- Recommendations

### 5. Voice Notification (Complete)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Context index refresh complete"}' \
  > /dev/null 2>&1 &
```

## Output

Updates `skills/ContextManager/CONTEXT-INDEX.md` with:

```markdown
## Source Status (Dynamic)

Last refreshed: 2026-02-03

| Source | Context File | Last Updated | Status | Key Metric |
|--------|--------------|--------------|--------|------------|
| LucidTasks | `context/LucidTasksContext.md` | 2026-02-03 | 🟢 | 12 tasks |
| Calendar | `context/CalendarContext.md` | 2026-02-03 | 🟢 | 4 events |
| DTR | `context/DtrContext.md` | 2026-02-01 | 🟡 | 5 metrics |
...

**Legend:** 🟢 Fresh (<24h) | 🟡 Stale (24-72h) | 🔴 Outdated (>72h)
```

## Intent-to-Flag Mapping

| User Says | Action |
|-----------|--------|
| "refresh context index" | Full refresh + regenerate index |
| "update context index" | Full refresh + regenerate index |
| "context status" | Index only (no re-gather) |
| "quick context check" | Index only (no re-gather) |
| "full context refresh" | Full refresh + regenerate index |

## Tools Called

- `GenerateContextIndex.ts` - Regenerate CONTEXT-INDEX.md
- `GenerateContextRouting.ts` - Regenerate CONTEXT-ROUTING.md on-demand lookup table
- `GatheringOrchestrator.ts` - Full source gathering (optional)
- `AgentGatherer.ts` - Parallel gathering (optional)

## Related Workflows

- **Sync-All** - Full context refresh (calls this at end)
- **Sync-LucidTasks** - LucidTasks-specific sync
- **Sync-Calendar** - Calendar-specific sync
- **Sync-Dtr** - DTR-specific sync
- **Sync-Learnings** - Learnings-specific sync
- **Sync-Obsidian** - Obsidian-specific sync
- **Sync-Projects** - Projects-specific sync
- **Sync-Telos** - TELOS-specific sync

## CLI Usage

```bash
# Full refresh with index regeneration
bun ~/.claude/skills/Productivity/InformationManager/Tools/GatheringOrchestrator.ts --mode consolidate && \
bun ~/.claude/skills/Productivity/InformationManager/Tools/GenerateContextIndex.ts

# Index only (check freshness of existing files)
bun ~/.claude/skills/Productivity/InformationManager/Tools/GenerateContextIndex.ts

# Dry run (preview without writing)
bun ~/.claude/skills/Productivity/InformationManager/Tools/GenerateContextIndex.ts --dry-run

# JSON output
bun ~/.claude/skills/Productivity/InformationManager/Tools/GenerateContextIndex.ts --json
```
