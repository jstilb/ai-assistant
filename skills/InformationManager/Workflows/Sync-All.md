# Sync-All Workflow

Comprehensive context sync across all configured sources using parallel agents.

**Category:** Sync (Source → Kaya)
**Trigger:** `sync all`, `gather all context`, `full context refresh`, `update all context`

## Purpose

Pull data FROM all external sources INTO Kaya's context directory:
- Obsidian vault (notes, _Context.md files, MOCs)
- Kaya skills configuration
- Project repositories
- Google Drive (DTR folder, tracking sheets)
- TELOS life framework
- Memory system learnings
- LucidTasks tasks
- Calendar events

This is a **Sync** workflow: it pulls data from sources into `~/.claude/context/`.

## Mode

| Mode | Description |
|------|-------------|
| **consolidate** | Gather all sources and create unified MasterContext.md |

Default mode: **consolidate**

## Execution Steps

### 1. Voice Notification

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Starting full context sync"}' \
  > /dev/null 2>&1 &
```

### 2. Option A: Use GatheringOrchestrator CLI (Sequential)

```bash
bun ~/.claude/skills/InformationManager/Tools/GatheringOrchestrator.ts --mode consolidate
```

### 2. Option B: Use AgentGatherer (Parallel Agents)

For faster execution with parallel agents:

```bash
bun ~/.claude/skills/InformationManager/Tools/AgentGatherer.ts \
  --sources obsidian,dtr,telos,learnings,projects,lucidtasks,calendar \
  --strategy merge
```

### 3. Gather Each Source

Use the GatheringOrchestrator tool to gather all sources:

```bash
bun ~/.claude/skills/InformationManager/Tools/GatheringOrchestrator.ts --mode consolidate
```

This internally handles:
- Obsidian vault context (VaultContext.md)
- DTR/TELOS data from sheets
- Projects from ~/Desktop/projects/
- Tasks from LucidTasks
- Calendar events
- Learnings from MEMORY/

### 4. Create Master Context Index

Generate `~/.claude/context/MasterContext.md`:

```markdown
---
tags: [context, ai-context, master]
last_updated: {{CURRENT_TIMESTAMP}}
gathered_by: InformationManager
---

# Master Context Index

## Context Sources

| Source | Location | Last Updated | Content |
|--------|----------|--------------|---------|
| Obsidian | `obsidian/VaultContext.md` | {{timestamp}} | Vault structure, 35 folder contexts |
| Skills | `context/SkillsContext.md` | {{timestamp}} | Kaya skills summary |
| Projects | `context/ProjectsContext.md` | {{timestamp}} | Code projects |
| Google Drive | `context/GoogleDriveContext.md` | {{timestamp}} | DTR metrics, tracking data |
| DTR | `context/DtrContext.md` | {{timestamp}} | Focused DTR metrics |
| TELOS | `context/TelosContext.md` | {{timestamp}} | Life framework, missions, goals |
| Learnings | `context/LearningsContext.md` | {{timestamp}} | Patterns, preferences, signals |
| LucidTasks | `context/LucidTasksContext.md` | {{timestamp}} | Tasks and projects |
| Calendar | `context/CalendarContext.md` | {{timestamp}} | Events and schedule |

## Quick Load Commands

**Load all context:**
- Read MasterContext.md for overview
- Load specific context files as needed

**For Obsidian tasks:**
- Load VaultContext.md for structure
- Load relevant folder's _Context.md for detail

**For development tasks:**
- Load ProjectsContext.md
- Load relevant project README

**For life planning tasks:**
- Load TelosContext.md for framework
- Load DtrContext.md for current metrics

**For understanding AI behavior:**
- Load LearningsContext.md for patterns
- Check ~/.claude/CLAUDE.md for preferences

## Context Freshness

Run `sync all` periodically to keep context current.
Recommended: Weekly refresh or after major changes.
```

### 5. Ensure Directories Exist

```bash
mkdir -p ~/.claude/context
```

### 6. Report Results

Output summary:
- Files created/updated (9 context files)
- Sources scanned (Obsidian, Skills, Projects, Drive, DTR, TELOS, Learnings, LucidTasks, Calendar)
- Any errors or gaps
- Recommendations for missing context

### 7. Update CONTEXT-INDEX.md

After gathering all sources, regenerate the CONTEXT-INDEX.md with freshness status:

```bash
bun ~/.claude/skills/InformationManager/Tools/GenerateContextIndex.ts
```

This updates the Source Status table in CONTEXT-INDEX.md with:
- Freshness indicators (Fresh, Stale, Outdated)
- Last-updated timestamps
- Key metrics per source

### 8. Voice Completion

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Context sync complete. All sources updated."}' \
  > /dev/null 2>&1 &
```

## Output Files

| File | Location | Content |
|------|----------|---------|
| VaultContext.md | `obsidian/` | Vault structure and folder map |
| SkillsContext.md | `.claude/context/` | Kaya skills summary |
| ProjectsContext.md | `.claude/context/` | Projects summary |
| GoogleDriveContext.md | `.claude/context/` | DTR metrics and tracking data |
| DtrContext.md | `.claude/context/` | Focused DTR metrics |
| TelosContext.md | `.claude/context/` | Life framework summary |
| LearningsContext.md | `.claude/context/` | Learning patterns and preferences |
| LucidTasksContext.md | `.claude/context/` | LucidTasks tasks and projects |
| CalendarContext.md | `.claude/context/` | Calendar events |
| MasterContext.md | `.claude/context/` | Index of all context sources |

## Intent-to-Flag Mapping

### GatheringOrchestrator.ts

| User Says | Flag | When to Use |
|-----------|------|-------------|
| "full", "complete", "all context" | `--mode consolidate` | Full context rebuild with MasterContext.md |
| "fast", "quick", "in place" | `--mode refresh` | Quick in-place updates only |
| "just obsidian", "only telos" | `--sources obsidian` or `--sources telos` | Single source gathering |
| "obsidian and telos", "multiple sources" | `--sources obsidian,telos` | Comma-separated sources |
| "dry run", "preview", "what would happen" | `--dry-run` | Preview without changes |
| "json output", "as json" | `--json` | Output as JSON |

### AgentGatherer.ts

| User Says | Flag | When to Use |
|-----------|------|-------------|
| "parallel", "fast gather", "with agents" | `--parallel` | Parallel agent execution (default) |
| "sequential", "one at a time" | `--parallel false` | Sequential execution |
| "merge results" | `--strategy merge` | Simple merge aggregation (default) |
| "synthesize", "combine intelligently" | `--strategy synthesis` | AI-synthesized aggregation |
| "direct", "skip agents", "no overhead" | `--direct` | Direct gathering without spawning agents |
| "limit concurrent" | `--max-concurrent 3` | Limit parallel agents |

### Source Values

| Source | Description |
|--------|-------------|
| `obsidian` | Obsidian vault notes |
| `dtr` | DTR tracking sheets |
| `telos` | TELOS life framework |
| `learnings` | Memory system learnings |
| `projects` | Code projects |
| `lucidtasks` | LucidTasks tasks |
| `calendar` | Calendar events |

## Tools Called

- `GatheringOrchestrator.ts` - Core sync engine (config-driven)
- `AgentGatherer.ts` - Parallel agent execution
- `GenerateContextIndex.ts` - Update CONTEXT-INDEX.md

## Related Workflows

- **Sync-ContextIndex** - Update CONTEXT-INDEX.md with freshness status
- **Refresh-Vault** - Update vault context IN Obsidian
- **Sync-Telos** - Sync TELOS files from sheets
- **Refresh-Drive** - Refresh context.md files in Google Drive
- **Sync-Skills** - Regenerate skill index
- **Sync-LucidTasks** - LucidTasks-specific sync
- **Sync-Calendar** - Calendar-specific sync
- **Sync-Dtr** - DTR-specific sync
- **Sync-Learnings** - Learnings-specific sync
- **Sync-Obsidian** - Obsidian-specific sync
- **Sync-Projects** - Projects-specific sync
