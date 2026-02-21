---
name: InformationManager
description: Autonomous context collection and information management system organized around four purposes: Refresh (in-place updates), Sync (source → Kaya), Organize (routing), and Enhance (enrichment). USE WHEN gather context, update context, DTR, alignment, habits, goals, missions, challenges, strategies, status update, TELOS data, tracking data, goal progress, refresh context, context status, obsidian context, learnings, how am I doing, progress check, lucidtasks tasks, calendar events, projects context.
---

# InformationManager

Autonomously gather and maintain context from local file sources (Obsidian, code, documents) and personal tracking data (DTR, TELOS) for AI agent consumption.

## Purpose

Enable AI agents to work with up-to-date context through four core operations:

| Operation | Direction | Purpose |
|-----------|-----------|---------|
| **Refresh** | Source → Source | Update context files IN the source (Obsidian, Drive) |
| **Sync** | Source → Kaya | Pull data FROM sources INTO Kaya's context |
| **Organize** | Item → Destination | Route information to proper locations |
| **Enhance** | Existing → Better | Improve and enrich information (future) |

## The Four Purposes Framework

| Category | Purpose | Direction | Example |
|----------|---------|-----------|---------|
| **Refresh** | Update context in-place at source | Source → Source | Update _Context.md files IN Obsidian |
| **Sync** | Keep Kaya's context in sync with sources | Source → Kaya | Pull LucidTasks tasks → LucidTasksContext.md |
| **Organize** | Route/move information to proper location | Source → Destination | Scratch pad item → LucidTasks task |
| **Enhance** | Improve, enrich, keep info up to date | Existing → Better | (Not yet implemented) |

## Workflow Routing

### Refresh Workflows (In-Place at Source)

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| **Refresh-Vault** | `refresh vault`, `update vault context`, `summarize vault` | Update VaultContext.md + _Context.md files IN Obsidian |
| **Refresh-VaultFolder** | `refresh folder {path}`, `summarize folder` | Update _Context.md for specific folder |
| **Refresh-Drive** | `refresh drive`, `update drive context` | Update context.md files IN Google Drive |
| **Refresh-Projects** | `refresh projects`, `update project contexts` | Update _Context.md files IN project folders |
| **Refresh-Learnings** | `refresh learnings`, `update learning contexts` | Update _Context.md files IN MEMORY/LEARNING |

### Sync Workflows (Source → Kaya)

| Workflow | Trigger | Output |
|----------|---------|--------|
| **Sync-All** | `sync all`, `gather all context`, `full context refresh` | All context files + MasterContext.md |
| **Sync-LucidTasks** | `sync lucidtasks`, `refresh tasks`, `/info tasks` | context/LucidTasksContext.md |
| **Sync-Calendar** | `sync calendar`, `refresh calendar`, `/info calendar` | context/CalendarContext.md |
| **Sync-Dtr** | `sync dtr`, `refresh dtr`, `/info dtr` | context/DtrContext.md |
| **Sync-Learnings** | `sync learnings`, `refresh learnings`, `/info learnings` | context/LearningsContext.md |
| **Sync-Obsidian** | `sync obsidian`, `refresh obsidian`, `/info obsidian` | context/ObsidianContext.md |
| **Sync-Projects** | `sync projects`, `refresh projects`, `/info projects` | context/ProjectsContext.md |
| **Sync-Skills** | `sync skills`, `refresh skills`, `regenerate skill index` | skill-index.json |
| **Sync-Telos** | `sync telos`, `update telos`, `refresh goals` | TELOS/*.md files |
| **Sync-Telos --status-only** | `sync status`, `update status` | TELOS/STATUS.md only |
| **Sync-ContextIndex** | `sync context index`, `context status` | CONTEXT-INDEX.md |

### Organize Workflows (Route/Move)

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| **Organize-ScratchPad** | `organize scratch pad`, `process scratch pad`, `triage inbox` | Route items → LucidTasks, Calendar, Notes |
| **Organize-Note** | `organize note`, `integrate note`, `add backlinks` | Add backlinks, update indexes |

### Enhance Workflows (Future)

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| (Not yet implemented) | — | Enrich notes, update stale info, add metadata |

### Delivery Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| **DailyBriefing** | `morning briefing`, `daily briefing`, `what's on today` | Aggregate + deliver via voice/push/telegram |

## Tools

Tools are GENERIC utilities with NO hardcoded domain knowledge. Domain-specific configuration lives in `config/*.json` files.

### Generic Execution Tools

| Tool | Purpose | Usage |
|------|---------|-------|
| **SyncEngine.ts** | Generic context file writer | `bun Tools/SyncEngine.ts --source lucidtasks --title "Title" --output path --content "..."` |
| **GatheringOrchestrator.ts** | Config-driven multi-source gathering | `bun Tools/GatheringOrchestrator.ts --mode consolidate` |
| **GenerateContextIndex.ts** | Generate CONTEXT-INDEX.md from existing files | `bun Tools/GenerateContextIndex.ts` |
| **AgentGatherer.ts** | Parallel agent gathering | `bun Tools/AgentGatherer.ts --sources "obsidian,telos"` |
| **FolderContextGenerator.ts** | Generate context.md for folders | Used by Refresh workflows |
| **AggregateContextGenerator.ts** | Combine multiple contexts | Used by Refresh workflows |
| **ProcessScratchPad.ts** | Organize inbox items to destinations | `bun Tools/ProcessScratchPad.ts --dry-run` |
| **DailyBriefingGenerator.ts** | Morning briefing generation | `bun Tools/DailyBriefingGenerator.ts` |

### Source Configs

Domain knowledge (paths, IDs, APIs) lives in `config/*.json`:
- `lucidtasks.json` - LucidTasks CLI commands, freshness rules
- `calendar.json` - Calendar CLI, date ranges
- `drive.json` - Remote name, excluded folders
- `learnings.json` - Memory paths, rating extraction
- `obsidian.json` - Vault path, exclude patterns
- `projects.json` - Projects dir, tech stack detection
- `skills.json` - Skills dir, include private flag
- `telos.json` - TELOS dir, sheet IDs and ranges

### Design Principle

```
WORKFLOW             →      CONFIG FILE          →      GENERIC TOOL
┌──────────────────┐       ┌──────────────────┐        ┌──────────────────────┐
│Sync-LucidTasks.md│       │config/           │        │GatheringOrchestrator │
│                  │       │lucidtasks.json   │        │                      │
│"sync lucidtasks" │ loads │                  │  uses  │ - loadConfig()       │
│                  │ ────► │ cli command      │ ─────► │ - gatherFromSource() │
│                  │       │ output path      │        │ - syncToContext()    │
│                  │       │ freshness rule   │        │                      │
└──────────────────┘       └──────────────────┘        └──────────────────────┘
```

## Configuration

**Context Sources:**
| Source | Path/ID | Context Type |
|--------|---------|--------------|
| Obsidian | `~/obsidian/` | Personal knowledge, notes, references |
| Kaya Skills | `~/.claude/skills/` | AI system configuration, workflows |
| Projects | `~/projects/` | Code projects, READMEs |
| Google Drive DTR | Folder ID: `1YwEOAblX29O18kTNqqoktetNGD9iX30c` | Personal tracking sheets, life data |
| TELOS | `skills/CORE/USER/TELOS/` | Missions, goals, challenges, strategies |
| Memory Learnings | `MEMORY/LEARNING/SYNTHESIS/` | Aggregated learning patterns, ratings |
| LucidTasks | `~/.claude/skills/LucidTasks/Data/lucidtasks.db` | Tasks and projects |
| Calendar | Google Calendar | Events and schedules |

**Google Drive Sheets (via DTR):**
| Sheet | ID | Content |
|-------|-----|---------|
| alignment | `1LFOEWT6FQPupiyWEAOu9bxwB7C1dLvqAAn-S_fpf69U` | Roles, missions, 2026 goals |
| goal_achievement | `1iiX2qfRn6Gx1q1yLu5Xu8nV-x7S_KA45gykjgQKTJdw` | WIGs, lead measures |
| habit_building | `1xrGAGvKlgckHbjnMevs9ZhlwtNWaUL5CzzgRQ82X9LA` | Daily habits, consistency |
| health | `1cY_1c5pJxyPBiQNlXeYGo9CFAJ8Khl91qQXhyP6ztBc` | Health metrics |
| skill_mastery | `1DWv7VCy-a7lOqAZNWud8aEUDDF0hvtM3rCwUVrCjrTk` | Skill development tracking |

**Context Output (Two-Tier):**
| Tier | Location | Content |
|------|----------|---------|
| Obsidian | `~/obsidian/VaultContext.md` | Vault-specific context (structure, folders) |
| Aggregated | `~/.claude/context/` | Master context (all sources combined) |

## Output Configuration

This skill produces context files to non-standard locations for cross-skill accessibility.

| Output Type | Path | Purpose |
|-------------|------|---------|
| Master Context | `~/.claude/context/MasterContext.md` | Unified context from all sources |
| Source Contexts | `~/.claude/context/{Source}Context.md` | Per-source context files |
| Vault Context | `~/obsidian/VaultContext.md` | Obsidian-specific context |
| DTR Status | `skills/CORE/USER/TELOS/STATUS.md` | Current metrics snapshot |

**Note:** This skill intentionally uses `context/` rather than `MEMORY/InformationManager/` because:
1. Context files are loaded by other skills and hooks
2. `context/` is a well-known location for cross-skill context
3. Files are overwritten on refresh, not date-partitioned

## Voice Notification

-> Use `notifySync()` from `skills/CORE/Tools/NotificationService.ts`

## Reference Files

| File | Purpose |
|------|---------|
| `SheetReference.md` | Google Sheets IDs, ranges, intent mapping |
| `TelosReference.md` | TELOS file locations and data sources |
| `ObsidianSyntax.md` | Obsidian-flavored markdown syntax reference |

## Context File Format

All generated context files follow this structure:

```markdown
---
tags: [context, ai-context, {{source}}]
last_updated: {{timestamp}}
gathered_by: InformationManager
---

# {{Context Title}}

## Summary
[Brief overview of what this context covers]

## Contents
[Structured context information]

## Usage
[How AI agents should use this context]
```

## Integration

### Uses
- **MemoryStore** (`skills/CORE/Tools/MemoryStore.ts`) - Read/write learnings
- **AgentOrchestrator** (`skills/CORE/Tools/AgentOrchestrator.ts`) - Parallel agent spawning
- **NotificationService** (`skills/CORE/Tools/NotificationService.ts`) - Voice notifications
- **TELOS** (`skills/CORE/USER/TELOS/`) - Life framework files
- **kaya-cli** - Google Sheets, Calendar, LucidTasks access

### Feeds Into
- **ContinualLearning** - Woven context for session prep
- **AutoMaintenance** - Context refresh workflows
- **THEALGORITHM** - Goal-connected execution
- **Session start** - Optional MasterContext loading via LoadContext hook

### Obsidian Vault
- Runs `Refresh-Vault` and `Refresh-VaultFolder` workflows for vault-specific context
- `Organize-ScratchPad` triages inbox items to calendar/tasks/notes
- `Organize-Note` creates backlinks and updates indexes
- Basic vault operations (create, edit, search) use `obs` CLI via UnixCLI skill
- Context stored in `Meta/` and per-folder context files

### Other Skills
- Context files loadable by any skill's Context workflow
- Standard format enables cross-skill context sharing

### AI Agents
- Context can be loaded at task start
- Enables agents to work with local knowledge

## Examples

**Example 1: Refresh Obsidian vault context (in-place)**
```
User: "Refresh the vault"
-> Invokes Refresh-Vault workflow
-> Scans vault structure and key notes
-> Updates context IN each folder
-> Updates VaultContext.md IN the vault
-> Returns summary of generated context
```

**Example 2: Sync all context to Kaya**
```
User: "Sync all context"
-> Invokes Sync-All workflow
-> Spawns parallel agents for each source
-> Updates all context files in ~/.claude/context/
-> Creates unified MasterContext.md
-> Returns comprehensive status report
```

**Example 3: Sync TELOS from sheets**
```
User: "Sync my goals from sheets"
-> Invokes Sync-Telos workflow
-> Fetches current metrics from sheets
-> Updates TELOS files
-> Shows changes detected
```

**Example 4: Organize scratch pad**
```
User: "Process my scratch pad"
-> Invokes Organize-ScratchPad workflow
-> Categorizes each item (task, event, note, unclear)
-> Routes to proper destinations (LucidTasks, Calendar, Vault)
-> Updates scratch pad (removes processed, flags unclear)
```
