# Context Index

**Auto-loaded at session start.** Meta-documentation for context loading decisions.

This index answers three questions:
1. **WHETHER** - Is context loading necessary for this task?
2. **WHICH** - Which specific sources are relevant?
3. **HOW** - How to combine/use them effectively?

---

## Quick Reference Card

| Task | Critical Context | Optional | Refresh If Missing |
|------|------------------|----------|-------------------|
| Scheduling | Calendar | LucidTasks | `refresh calendar` |
| Task work | LucidTasks | Calendar | `refresh tasks` |
| Goals/Progress | TELOS | Obsidian | `refresh telos` |
| Personal knowledge | Obsidian | Learnings | `refresh obsidian` |
| Development | Projects | Skills | `refresh projects` |
| AI patterns | Learnings | Skills | `refresh learnings` |
| System info | Skills | — | `refresh skills` |
| File storage | Drive | — | `refresh drive` |

---

## Source Status (Dynamic)

Last refreshed: 2026-02-03

| Source | Context File | Last Updated | Status | Priority | Key Metric |
|--------|--------------|--------------|--------|----------|------------|
| LucidTasks | `context/LucidTasksContext.md` | 2026-02-20 | 🟢 | Critical | 495 tasks |
| Calendar | `context/CalendarContext.md` | 2026-02-03 | 🟢 | Critical | 0 events |
| Drive | `context/GoogleDriveContext.md` | 2026-02-01 | 🟡 | Optional | Unknown |
| Learnings | `context/LearningsContext.md` | 2026-02-03 | 🟢 | Important | 7 patterns |
| Obsidian | `context/ObsidianContext.md` | 2026-01-14 | 🔴 | Important | Unknown |
| Projects | `context/ProjectsContext.md` | 2026-02-03 | 🟢 | Important | 12 projects |
| Telos | `context/TelosContext.md` | 2026-02-03 | 🟢 | Critical | 5 files |
| Skills | `context/SkillsContext.md` | 2026-01-14 | 🔴 | Optional | Unknown |

**Legend:** 🟢 Fresh (<24h) | 🟡 Stale (24-72h) | 🔴 Outdated (>72h) | ⚪ Not gathered

---

## Context Routing Rules

### Scheduling Tasks
**Keywords**: meeting, calendar, schedule, appointment, availability, free time, block time
**Critical**: CalendarContext.md
**Optional**: LucidTasksContext.md
**Skip**: ProjectsContext.md, LearningsContext.md, ObsidianContext.md

### Task/Project Work
**Keywords**: task, lucidtasks, todo, project, deadline, work on, what's due
**Critical**: LucidTasksContext.md
**Optional**: CalendarContext.md, ProjectsContext.md
**Skip**: ObsidianContext.md, LearningsContext.md

### Goal Tracking & Progress
**Keywords**: goals, progress, how am I doing, alignment, tracking, metrics, WIG, lead measures
**Critical**: TelosContext.md, TELOS files
**Optional**: ObsidianContext.md
**Skip**: ProjectsContext.md, SkillsContext.md

### Personal Knowledge Lookup
**Keywords**: notes, obsidian, remember when, what do I know about, my notes on
**Critical**: ObsidianContext.md
**Optional**: LearningsContext.md
**Skip**: CalendarContext.md, LucidTasksContext.md

### Development Work
**Keywords**: code, project, repo, build, deploy, develop, implement
**Critical**: ProjectsContext.md
**Optional**: SkillsContext.md, LearningsContext.md
**Skip**: CalendarContext.md, ObsidianContext.md

### AI Patterns
**Keywords**: pattern, learning, what worked, what failed, improve, iterate
**Critical**: LearningsContext.md
**Optional**: SkillsContext.md
**Skip**: CalendarContext.md, LucidTasksContext.md, ObsidianContext.md

### System Understanding
**Keywords**: how does Kaya, skill, workflow, hook, system works
**Critical**: SkillsContext.md
**Optional**: LearningsContext.md
**Skip**: All personal context

---

## Sufficient Context Boundaries

### Minimum Required (Cannot Proceed Without)
| Task Type | Must Have | Why |
|-----------|-----------|-----|
| Scheduling | Calendar | Need availability data |
| Task work | LucidTasks | Need task list |
| Goal tracking | TELOS | Need goals, metrics, and definitions |
| Knowledge lookup | Obsidian | Need note content |

### Improves Quality (Helpful but Optional)
| Task Type | Nice to Have | Benefit |
|-----------|--------------|---------|
| Scheduling | LucidTasks | See task deadlines to avoid conflicts |
| Task work | Calendar | See time available for tasks |
| Goal tracking | Obsidian | Personal notes add context |
| Development | Learnings | Past patterns prevent mistakes |

### Stop Loading When
- **Simple questions**: Don't load context for "what time is it" or "tell me a joke"
- **System-only tasks**: Skip personal context for system maintenance
- **Single-source tasks**: If task clearly maps to one source, don't load others
- **Already have answer**: If TELOS (loaded at start) answers the question, stop

---

## Freshness Actions

| Status | Meaning | Action |
|--------|---------|--------|
| 🟢 Fresh | Updated <24h ago | Use directly, high confidence |
| 🟡 Stale | Updated 24-72h ago | Use but note uncertainty in response |
| 🔴 Outdated | Updated >72h ago | Refresh before high-stakes work; warn user for time-sensitive tasks |
| ⚪ Not gathered | Never collected | Run gather command before proceeding |

### When to Refresh Before Proceeding

**Always refresh** for:
- Financial decisions
- Scheduling commitments
- Goal/progress reports to user
- Any task where user says "make sure it's current"

**Okay to use stale** for:
- General knowledge questions
- System understanding
- Historical lookups ("what did I work on last month")

### Refresh Commands

```bash
# Individual sources
refresh tasks
refresh calendar
refresh telos
refresh obsidian
refresh projects
refresh learnings
refresh skills
refresh drive

# All sources at once
gather all context
bun Tools/GatheringOrchestrator.ts --mode consolidate
```

---

## Source Registry (Detailed)

### LucidTasks
- **Purpose**: Task management, deadlines, project tracking
- **Load When**: tasks, todos, deadlines, LucidTasks, what's due
- **Skip When**: scheduling, knowledge lookup, system questions
- **Freshness**: Update daily; stale after 24h for active work
- **Prerequisites**: None
- **Priority**: Critical
- **Access**: `context/LucidTasksContext.md` or `refresh tasks`

### Calendar
- **Purpose**: Schedule, availability, meetings, time blocks
- **Load When**: scheduling, availability, meetings, when am I free
- **Skip When**: non-time-sensitive tasks, knowledge lookup
- **Freshness**: Update daily; stale after 24h for scheduling
- **Prerequisites**: None
- **Priority**: Critical
- **Access**: `context/CalendarContext.md` or `refresh calendar`

### Drive
- **Purpose**: File storage structure, shared documents, cloud files
- **Load When**: files, document management, where's my file
- **Skip When**: most tasks
- **Freshness**: Update weekly; tolerant of staleness
- **Prerequisites**: None
- **Priority**: Optional
- **Access**: `context/GoogleDriveContext.md` or `refresh drive`

### Learnings
- **Purpose**: AI patterns, what worked/failed, system improvements, captured insights
- **Load When**: patterns, what worked, what failed, improve
- **Skip When**: new tasks without history
- **Freshness**: Update weekly; tolerant of staleness
- **Prerequisites**: None
- **Priority**: Important
- **Access**: `context/LearningsContext.md` or `refresh learnings`

### Obsidian
- **Purpose**: Personal knowledge base, notes, thoughts, research
- **Load When**: notes, knowledge lookup, my notes on, research
- **Skip When**: task execution, scheduling, system work
- **Freshness**: Update weekly; tolerant of staleness
- **Prerequisites**: None
- **Priority**: Important
- **Access**: `context/ObsidianContext.md` or `refresh obsidian`

### Projects
- **Purpose**: Active development projects, repos, tech stacks
- **Load When**: development, project, coding, deployment
- **Skip When**: personal tasks, scheduling, goal tracking
- **Freshness**: Update weekly; stale after changes
- **Prerequisites**: None
- **Priority**: Important
- **Access**: `context/ProjectsContext.md` or `refresh projects`

### Telos
- **Purpose**: Life goals, missions, challenges, strategies, status, habit metrics, alignment scores, lead measures
- **Load When**: goals, life planning, alignment, progress, how am I doing, metrics, WIG, lead measures, habits, tracking
- **Skip When**: auto-loaded at session start
- **Freshness**: User-maintained; update when goals change; tracking metrics weekly
- **Prerequisites**: None
- **Priority**: Critical (auto-loaded)
- **Access**: `context/TelosContext.md` or `refresh telos`

### Skills
- **Purpose**: Available skills, capabilities, workflows
- **Load When**: system questions, can you do X, capability lookup
- **Skip When**: execution tasks
- **Freshness**: Update monthly; stable
- **Prerequisites**: None
- **Priority**: Optional
- **Access**: `context/SkillsContext.md` or `refresh skills`

---

## Your Life Context (TELOS)

Core files loaded at session start. For full details, read these files directly.

| Topic | File | Loaded |
|-------|------|--------|
| Missions | `USER/TELOS/MISSIONS.md` | Yes |
| Goals | `USER/TELOS/GOALS.md` | Yes |
| Challenges | `USER/TELOS/CHALLENGES.md` | Yes |
| Status | `USER/TELOS/STATUS.md` | Yes |
| Strategies | `USER/TELOS/STRATEGIES.md` | Yes |

### Additional TELOS Files (Load On-Demand)

| Topic | File |
|-------|------|
| Beliefs | `USER/TELOS/BELIEFS.md` |
| Narratives | `USER/TELOS/NARRATIVES.md` |
| Mental Models | `USER/TELOS/MODELS.md` |
| Mental Frames | `USER/TELOS/FRAMES.md` |
| Projects | `USER/TELOS/PROJECTS.md` |
| Problems | `USER/TELOS/PROBLEMS.md` |
| Books | `USER/TELOS/BOOKS.md` |
| Movies | `USER/TELOS/MOVIES.md` |
| Ideas | `USER/TELOS/IDEAS.md` |
| Predictions | `USER/TELOS/PREDICTIONS.md` |

---

## System Documentation

| Topic | File |
|-------|------|
| Architecture | `SYSTEM/KAYASYSTEMARCHITECTURE.md` |
| Skills Guide | `SYSTEM/SKILLSYSTEM.md` |
| Hooks | `SYSTEM/THEHOOKSYSTEM.md` |
| Memory | `SYSTEM/MEMORYSYSTEM.md` |
| Notifications | `SYSTEM/THENOTIFICATIONSYSTEM.md` |
| Agents | `SYSTEM/PAIAGENTSYSTEM.md` |
| Security | `SYSTEM/KAYASECURITYSYSTEM/` |
| Documentation Index | `SYSTEM/DOCUMENTATIONINDEX.md` |

---

## Personal Configuration

| Topic | File |
|-------|------|
| Identity | `settings.json`, `USER/DAIDENTITY.md` |
| Assets | `USER/ASSETMANAGEMENT.md` |
| Tech Stack | `USER/TECHSTACKPREFERENCES.md` |
| Contacts | `USER/CONTACTS.md` |
| Definitions | `USER/DEFINITIONS.md` |

---

## Core Tools

| Tool | Location | Purpose |
|------|----------|---------|
| StateManager | `Tools/StateManager.ts` | Type-safe state persistence |
| NotificationService | `Tools/NotificationService.ts` | Multi-channel notifications |
| ConfigLoader | `Tools/ConfigLoader.ts` | SYSTEM/USER tiered config |
| MemoryStore | `Tools/MemoryStore.ts` | Learning/research storage |
| Inference | `Tools/Inference.ts` | AI model inference (fast/standard/smart) |

**Full tools documentation:** `skills/CORE/Tools/README.md`

---

## Quick Lookups

| Need | Action |
|------|--------|
| All skills | Read `SKILL-INDEX.md` |
| All CLIs | Read `CLI-INDEX.md` |
| Past work | `MEMORY/WORK/` directories |
| Learnings | `MEMORY/LEARNING/` |
| Session history | `MEMORY/sessions/` |

---

*Paths relative to `~/.claude/skills/CORE/` unless otherwise noted.*
*Source status auto-generated by GenerateContextIndex.ts*
