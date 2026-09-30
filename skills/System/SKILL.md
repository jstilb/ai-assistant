---
name: System
description: System integrity, agent monitoring, Kaya upgrades, and public sync. USE WHEN system check, agent monitor, upgrade kaya, public sync, OR infrastructure management.
---

# System

Core infrastructure management — covering system integrity checks, agent monitoring, Kaya upgrades, and public repo sync.

## Sub-Skills

| Sub-Skill | Triggers | Load |
|-----------|----------|------|
| **AgentMonitor** | monitor agent, agent performance, agent alerts, live monitoring, watch agents, anomaly detection | `System/AgentMonitor/SKILL.md` |
| **KayaUpgrade** | upgrade, improve system, system upgrade, analyze for improvements, check anthropic, new claude features | `System/KayaUpgrade/SKILL.md` |
| **PublicSync** | sync public repo, mirror to github, push to ai-assistant, public sync, sync skills to github | `System/PublicSync/SKILL.md` |

## Workflow Routing

When a sub-skill is identified from the table above:
1. Read the sub-skill's SKILL.md for its full routing and workflow list
2. Execute the appropriate workflow from that sub-skill's directory

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`
