---
name: Life
description: Cooking, adventure & travel, design, Telos life goals, Dungeons and Dragons, Anki flashcards, and randomized rewards for motivation. USE WHEN cooking, recipe, travel, trip, itinerary, adventure, date planning, camping, packing list, design, telos, goals, dnd, dungeons dragons, anki, flashcards, reward me, incentivize good work, motivate me, OR lifestyle tools.
---

# Life

Personal lifestyle tools — covering cooking and recipes, adventure & travel planning, design assistance, Telos life goal tracking, Dungeons & Dragons gameplay, and Anki flashcard management.

## Sub-Skills

| Sub-Skill | Triggers | Load |
|-----------|----------|------|
| **Adventure** | travel, trip, itinerary, adventure, date idea, date night, plan a date, spontaneous, road trip, camping, backpacking, packing list, what to pack, national park, weekend trip, baja, mexico, surf trip, getaway, vacation, explore | `Life/Adventure/SKILL.md` |
| **Anki** | create flashcard, anki card, deck management, review stats, note type, batch cards, anki sync, voice review, quiz me, review my cards out loud, answer flashcards verbally | `Life/Anki/SKILL.md` |
| **Cooking** | cooking, recipe, meal plan, what to make, dinner ideas, grocery list, what's in season, substitute, cuisine, meal prep, fermentation, sourdough, kimchi, kombucha, sauerkraut, ferment | `Life/Cooking/SKILL.md` |
| **Designer** | interior design, decorate, room layout, furniture, cozy, color scheme, reading nook, home decor, style room, room analysis, mood board, lighting, cozify | `Life/Designer/SKILL.md` |
| **DnD** | d&d, dungeon master, dm, encounter, monster, stat block, campaign, session prep, spell lookup, homebrew, vtt | `Life/DnD/SKILL.md` |
| **RewardEngine** | reward me, claim reward, roll reward, randomized reward, variable reward, incentivize good work, treat myself, i earned a reward, loot box, gamify habits, motivate me | `Life/RewardEngine/SKILL.md` |
| **Telos** | telos, life goals, goal dashboard, projects, dependencies, weekly review, goal progress, books, movies, life direction | `Life/Telos/SKILL.md` |

## Workflow Routing

When a sub-skill is identified from the table above:
1. Read the sub-skill's SKILL.md for its full routing and workflow list
2. Execute the appropriate workflow from that sub-skill's directory

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`
