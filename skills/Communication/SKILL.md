---
name: Communication
description: Gmail, Telegram messaging, and voice interaction. USE WHEN email, gmail, telegram, message, voice interaction, OR communication tasks.
---

# Communication

Communication tools — covering Gmail email management, Telegram messaging, and voice interaction workflows.

## Sub-Skills

| Sub-Skill | Triggers | Load |
|-----------|----------|------|
| **Gmail** | send email, draft email, search emails, gmail inbox, email labels, email filters, batch email operations, read email | `Communication/Gmail/SKILL.md` |
| **Telegram** | send telegram, telegram message, message me, notify mobile, text me, mobile notification, or telegram | `Communication/Telegram/SKILL.md` |
| **VoiceInteraction** | voice conversation, talk to kaya, voice mode, voice chat, speak to kaya, desktop voice, voice interaction, push to talk, hands free, real-time voice | `Communication/VoiceInteraction/SKILL.md` |

## Workflow Routing

When a sub-skill is identified from the table above:
1. Read the sub-skill's SKILL.md for its full routing and workflow list
2. Execute the appropriate workflow from that sub-skill's directory

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`
