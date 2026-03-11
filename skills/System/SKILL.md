---
name: System
description: System integrity, agent monitoring, simulation, skill audit, Kaya upgrades, Gemini sync, and public sync. USE WHEN system check, agent monitor, simulation, skill audit, upgrade kaya, gemini sync, public sync, OR infrastructure management.
---

# System

Core infrastructure management — covering system integrity checks, agent monitoring, simulation environments, skill auditing, Kaya upgrades, Gemini synchronization, and public repo sync.

## Sub-Skills

| Sub-Skill | Triggers | Load |
|-----------|----------|------|
| **System** | system, integrity, system check, system status | `System/System/SKILL.md` |
| **AgentMonitor** | agent monitor, monitor agents, trace, workflow trace | `System/AgentMonitor/SKILL.md` |
| **Simulation** | simulation, simulate, test environment, mock | `System/Simulation/SKILL.md` |
| **SkillAudit** | skill audit, audit skills, skill check, validate skills | `System/SkillAudit/SKILL.md` |
| **KayaUpgrade** | upgrade kaya, kaya upgrade, update system, self-upgrade | `System/KayaUpgrade/SKILL.md` |
| **GeminiSync** | gemini sync, sync gemini, gemini update | `System/GeminiSync/SKILL.md` |
| **PublicSync** | public sync, sync public, publish skills, public repo | `System/PublicSync/SKILL.md` |

## Workflow Routing

When a sub-skill is identified from the table above:
1. Read the sub-skill's SKILL.md for its full routing and workflow list
2. Execute the appropriate workflow from that sub-skill's directory

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`
