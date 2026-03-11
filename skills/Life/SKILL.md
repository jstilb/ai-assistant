---
name: Life
description: Cooking, design, Telos life goals, Dungeons and Dragons, Anki flashcards, and digital maestro. USE WHEN cooking, recipe, design, telos, goals, dnd, dungeons dragons, anki, flashcards, digital maestro, OR lifestyle tools.
---

# Life

Personal lifestyle tools — covering cooking and recipes, design assistance, Telos life goal tracking, Dungeons & Dragons gameplay, Anki flashcard management, and digital lifestyle orchestration.

## Sub-Skills

| Sub-Skill | Triggers | Load |
|-----------|----------|------|
| **Cooking** | cooking, recipe, cook, meal, food | `Life/Cooking/SKILL.md` |
| **Designer** | design, designer, visual design, layout, aesthetic | `Life/Designer/SKILL.md` |
| **Telos** | telos, goals, life goals, values, principles, purpose | `Life/Telos/SKILL.md` |
| **DnD** | dnd, dungeons dragons, dungeon master, campaign, character | `Life/DnD/SKILL.md` |
| **Anki** | anki, flashcards, flashcard, spaced repetition, memorize | `Life/Anki/SKILL.md` |
| **DigitalMaestro** | digital maestro, maestro, digital orchestration | `Life/DigitalMaestro/SKILL.md` |

## Workflow Routing

When a sub-skill is identified from the table above:
1. Read the sub-skill's SKILL.md for its full routing and workflow list
2. Execute the appropriate workflow from that sub-skill's directory

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`
