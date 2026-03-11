---
name: Communication
description: Gmail, Telegram messaging, community outreach, and voice interaction. USE WHEN email, gmail, telegram, community outreach, message, voice interaction, OR communication tasks.
---

# Communication

Communication and outreach tools — covering Gmail email management, Telegram messaging, community outreach campaigns, and voice interaction workflows.

## Sub-Skills

| Sub-Skill | Triggers | Load |
|-----------|----------|------|
| **Gmail** | email, gmail, send email, read email, mail | `Communication/Gmail/SKILL.md` |
| **Telegram** | telegram, telegram message, send telegram | `Communication/Telegram/SKILL.md` |
| **CommunityOutreach** | community outreach, outreach, network message, contact outreach | `Communication/CommunityOutreach/SKILL.md` |
| **VoiceInteraction** | voice interaction, voice, speak, text to speech, voice event | `Communication/VoiceInteraction/SKILL.md` |

## Workflow Routing

When a sub-skill is identified from the table above:
1. Read the sub-skill's SKILL.md for its full routing and workflow list
2. Execute the appropriate workflow from that sub-skill's directory

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`
