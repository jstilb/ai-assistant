---
name: Productivity
description: Task management, calendar, information management, and LifeOS learning. USE WHEN tasks, lucid tasks, calendar, information manager, learning, OR productivity tools.
---

# Productivity

Personal productivity tools — covering task management with Lucid, calendar assistance, information management, and LifeOS learning workflows.

## Sub-Skills

| Sub-Skill | Triggers | Load |
|-----------|----------|------|
| **AppUsageTracker** | appusagetracker | `Productivity/AppUsageTracker/SKILL.md` |
| **CalendarAssistant** | schedule meeting, calendar, list events, add event, find free time, time blocking, calendar agenda, kaya scheduler, calendar blocks, day plan | `Productivity/CalendarAssistant/SKILL.md` |
| **EventScout** | find events, things to do, what's happening, concerts, shows, activities, comedy, sports, things this weekend, recommend an outing, events near me, free things to do, save an event to my list, anything to do in san diego, looking for something fun | `Productivity/EventScout/SKILL.md` |
| **InformationManager** | gather context, refresh context, dtr, telos data, obsidian context, calendar events, sync calendar | `Productivity/InformationManager/SKILL.md` |
| **LifeOS** | capturing habits, leads, experiences (ate/went/watched/read), ideas, tasks, decisions, insights, reflections, or calendar events;, when viewing the loop dashboard (the live web dashboard at http://localhost:31337);, when pre-populating a weekly/monthly/quarterly/annual review;, "what should i learn next", "resume learning", "where did i leave off in <piano/climbing/…>", "learning dashboard" (learning resume — http://localhost:31337/learn) | `Productivity/LifeOS/SKILL.md` |
| **LucidTasks** | tasks, task management, add task, complete task, task inbox, task projects, task search, task stats, lucid tasks, lt, todo, to-do, my tasks, next task, task migration | `Productivity/LucidTasks/SKILL.md` |
| **YouTubeCuration** | youtubecuration | `Productivity/YouTubeCuration/SKILL.md` |

## Workflow Routing

When a sub-skill is identified from the table above:
1. Read the sub-skill's SKILL.md for its full routing and workflow list
2. Execute the appropriate workflow from that sub-skill's directory

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`
