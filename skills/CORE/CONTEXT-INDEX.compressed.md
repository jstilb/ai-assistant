---
compressed_from: skills/CORE/CONTEXT-INDEX.md
compressed_at: 2026-02-09T03:14:41.529Z
original_lines: 320
compressed_lines: 140
---

# Kaya Context Index (Compressed)

## Quick Reference Card

| Task | Critical Context | Optional | Refresh |
|------|------------------|----------|---------|
| Scheduling | Calendar | Asana | `refresh calendar` |
| Task work | Asana | Calendar | `refresh asana` |
| Goals/Progress | TELOS | Obsidian | `refresh telos` |
| Personal knowledge | Obsidian | Learnings | `refresh obsidian` |
| Development | Projects | Skills | `refresh projects` |
| AI patterns | Learnings | Skills | `refresh learnings` |
| System info | Skills | — | `refresh skills` |
| File storage | Drive | — | `refresh drive` |

---

## Source Status (Last refreshed: 2026-02-03)

| Source | File | Updated | Status | Priority |
|--------|------|---------|--------|----------|
| LucidTasks | `context/LucidTasksContext.md` | 2026-02-03 | 🟢 Fresh | Critical |
| Calendar | `context/CalendarContext.md` | 2026-02-03 | 🟢 Fresh | Critical |
| Drive | `context/GoogleDriveContext.md` | 2026-02-01 | 🟡 Stale | Optional |
| Learnings | `context/LearningsContext.md` | 2026-02-03 | 🟢 Fresh | Important |
| Obsidian | `context/ObsidianContext.md` | 2026-01-14 | 🔴 Outdated | Important |
| Projects | `context/ProjectsContext.md` | 2026-02-03 | 🟢 Fresh | Important |
| Telos | `context/TelosContext.md` | 2026-02-03 | 🟢 Fresh | Critical |
| Skills | `context/SkillsContext.md` | 2026-01-14 | 🔴 Outdated | Optional |

---

## Context Routing Rules

**Scheduling**: Calendar (critical) | Skip: Projects, Learnings, Obsidian
**Task/Project**: Asana (critical) | Optional: Calendar, Projects
**Goals**: TELOS (critical) | Optional: Obsidian
**Knowledge**: Obsidian (critical) | Optional: Learnings
**Development**: Projects (critical) | Optional: Skills, Learnings
**AI Patterns**: Learnings (critical) | Optional: Skills
**System**: Skills (critical) | Optional: Learnings

---

## Freshness Guidelines

| Status | Action |
|--------|--------|
| 🟢 Fresh (<24h) | Use directly, high confidence |
| 🟡 Stale (24-72h) | Use but note uncertainty |
| 🔴 Outdated (>72h) | Refresh before proceeding |
| ⚪ Not gathered | Run gather command |

**Always refresh for**: Financial decisions, scheduling commitments, goal/progress reports, time-sensitive tasks
**Okay to use stale for**: General knowledge, system understanding, historical lookups

**Refresh commands**:
```bash
refresh asana / calendar / telos / obsidian / projects / learnings / skills / drive
gather all context
bun Tools/GatheringOrchestrator.ts --mode consolidate
```

---

## Source Registry

| Source | Purpose | Load When | Skip When | Freshness | Priority |
|--------|---------|-----------|-----------|-----------|----------|
| **Asana** | Task management, deadlines | tasks, todos, deadlines | scheduling, knowledge | Daily (stale: 24h) | Critical |
| **Calendar** | Schedule, meetings, availability | scheduling, meetings, free time | non-time-sensitive | Daily (stale: 24h) | Critical |
| **Drive** | File storage, cloud documents | files, document management | most tasks | Weekly | Optional |
| **Learnings** | AI patterns, insights, what worked | patterns, improvements | new tasks | Weekly | Important |
| **Obsidian** | Personal knowledge, notes, research | notes, knowledge lookup | task execution | Weekly | Important |
| **Projects** | Development, repos, tech stacks | development, coding | personal tasks | Weekly (stale: on changes) | Important |
| **Telos** | Life goals, metrics, alignment | goals, progress, habits | auto-loaded | User-maintained | Critical |
| **Skills** | Kaya capabilities, workflows | system questions, capabilities | execution | Monthly | Optional |

---

## TELOS Files (Auto-Loaded)

Core: `MISSIONS.md` | `GOALS.md` | `CHALLENGES.md` | `STATUS.md` | `STRATEGIES.md`

On-demand: `BELIEFS.md` | `NARRATIVES.md` | `MODELS.md` | `FRAMES.md` | `PROJECTS.md` | `PROBLEMS.md` | `BOOKS.md` | `MOVIES.md` | `IDEAS.md` | `PREDICTIONS.md`

---

## System Documentation

| Topic | File |
|--------|------|
| Architecture | `SYSTEM/KAYASYSTEMARCHITECTURE.md` |
| Skills | `SYSTEM/SKILLSYSTEM.md` |
| Hooks | `SYSTEM/THEHOOKSYSTEM.md` |
| Memory | `SYSTEM/MEMORYSYSTEM.md` |
| Notifications | `SYSTEM/THENOTIFICATIONSYSTEM.md` |
| Agents | `SYSTEM/PAIAGENTSYSTEM.md` |
| Security | `SYSTEM/KAYASECURITYSYSTEM/` |
| Index | `SYSTEM/DOCUMENTATIONINDEX.md` |

---

## Personal Configuration

| Topic | File |
|--------|------|
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
| Inference | `Tools/Inference.ts` | AI inference (fast/standard/smart) |

Full docs: `skills/CORE/Tools/README.md`

---

## Quick Lookups

| Need | Action |
|------|--------|
| All skills | `SKILL-INDEX.md` |
| All CLIs | `CLI-INDEX.md` |
| Past work | `MEMORY/WORK/` |
| Learnings | `MEMORY/LEARNING/` |
| Sessions | `MEMORY/sessions/` |

**Paths relative to `$KAYA_HOME/skills/CORE/` unless noted.**