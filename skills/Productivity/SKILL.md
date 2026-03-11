---
name: Productivity
description: Task management, calendar, daily briefing, information management, and continual learning. USE WHEN tasks, lucid tasks, calendar, daily briefing, information manager, learning, OR productivity tools.
---

# Productivity

Personal productivity tools — covering task management with Lucid, calendar assistance, daily briefings, information management, and continual learning workflows.

## Sub-Skills

| Sub-Skill | Triggers | Load |
|-----------|----------|------|
| **LucidTasks** | tasks, lucid tasks, task list, to-do, task management | `Productivity/LucidTasks/SKILL.md` |
| **CalendarAssistant** | calendar, schedule, meeting, appointment, calendar assistant | `Productivity/CalendarAssistant/SKILL.md` |
| **DailyBriefing** | daily briefing, briefing, morning briefing, daily summary | `Productivity/DailyBriefing/SKILL.md` |
| **InformationManager** | information manager, info manager, context refresh, manage info | `Productivity/InformationManager/SKILL.md` |
| **ContinualLearning** | continual learning, learning, learn from session, capture learning | `Productivity/ContinualLearning/SKILL.md` |

## Workflow Routing

When a sub-skill is identified from the table above:
1. Read the sub-skill's SKILL.md for its full routing and workflow list
2. Execute the appropriate workflow from that sub-skill's directory

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`
