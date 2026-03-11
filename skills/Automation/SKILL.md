---
name: Automation
description: Autonomous work execution, queue routing, proactive scheduling, maintenance, information management, and context management. USE WHEN autonomous work, queue router, proactive tasks, auto maintenance, information manager, context manager, OR background automation.
---

# Automation

System automation and orchestration — covering autonomous work execution, intelligent queue routing, proactive scheduling, auto-maintenance, information management, and context classification.

## Sub-Skills

| Sub-Skill | Triggers | Load |
|-----------|----------|------|
| **AutonomousWork** | autonomous work, auto work, background task, work queue, orchestrate | `Automation/AutonomousWork/SKILL.md` |
| **QueueRouter** | queue router, route task, queue item, dispatch task | `Automation/QueueRouter/SKILL.md` |
| **ProactiveEngine** | proactive, proactive engine, scheduled task, automatic trigger | `Automation/ProactiveEngine/SKILL.md` |
| **AutoMaintenance** | auto maintenance, maintenance, system cleanup, auto cleanup | `Automation/AutoMaintenance/SKILL.md` |
| **AutoInfoManager** | auto info manager, automatic information, auto context refresh | `Automation/AutoInfoManager/SKILL.md` |
| **ContextManager** | context manager, context, classify context, load context, context routing | `Automation/ContextManager/SKILL.md` |

## Workflow Routing

When a sub-skill is identified from the table above:
1. Read the sub-skill's SKILL.md for its full routing and workflow list
2. Execute the appropriate workflow from that sub-skill's directory

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`
