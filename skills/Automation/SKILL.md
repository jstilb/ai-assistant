---
name: Automation
description: Autonomous work execution, queue routing, proactive scheduling, maintenance, and information management. USE WHEN autonomous work, queue router, proactive tasks, auto maintenance, information manager, OR background automation.
---

# Automation

System automation and orchestration — covering autonomous work execution, intelligent queue routing, proactive scheduling, auto-maintenance, information management, and context classification.

## Sub-Skills

| Sub-Skill | Triggers | Load |
|-----------|----------|------|
| **AutoInfoManager** | daily upkeep, autoinfo, scratchpad processing, inbox triage schedule, context digests, vault map refresh, freshness sentinel, or context staleness alerts | `Automation/AutoInfoManager/SKILL.md` |
| **AutoMaintenance** | maintenance daily, maintenance weekly, maintenance monthly, system health, automated cleanup, cron scheduling, system integrity, security audit, log cleanup, workspace cleanup, kaya health, auto-remediation, gap detection | `Automation/AutoMaintenance/SKILL.md` |
| **AutonomousWork** | work start, work status, work next, autonomous task execution, pick up from queue | `Automation/AutonomousWork/SKILL.md` |
| **ProactiveEngine** | scheduling proactive tasks, setting up cron jobs, creating proactive behaviors, evening summaries, periodic checks, or managing automated outreach | `Automation/ProactiveEngine/SKILL.md` |
| **QueueRouter** | queue task, queue add, queue list, route task, approval queue, approved-work queue, background queue, process queue, queue status, promote queue, spec pipeline, context gathering, reject spec, pipeline status | `Automation/QueueRouter/SKILL.md` |

## Workflow Routing

When a sub-skill is identified from the table above:
1. Read the sub-skill's SKILL.md for its full routing and workflow list
2. Execute the appropriate workflow from that sub-skill's directory

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`
