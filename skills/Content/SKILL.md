---
name: Content
description: AI art generation, content aggregation, mood boards, system flowcharts, and song-to-piano Synthesia videos. USE WHEN art, synthesia, piano video, generate art, content aggregator, notes, flowchart, diagram, mood board, collage, visual inspiration, OR content creation.
---

# Content

Content creation and management — covering AI art generation, content aggregation and curation, and system flowchart creation.

## Sub-Skills

| Sub-Skill | Triggers | Load |
|-----------|----------|------|
| **Art** | user wants to create visual content, illustrations, art, header images, visualizations, infographic, kaya icon, pack icon, or kaya pack icon | `Content/Art/SKILL.md` |
| **ContentAggregator** | content aggregation, news digest, rss feeds, content sources, morning news, aggregate content, news pipeline, add rss feed, manage sources, generate digest | `Content/ContentAggregator/SKILL.md` |
| **MoodBoard** | mood board, moodboard, pinterest board, collage, visual inspiration, inspo board, gather images, fashion inspiration, interior design ideas, style board, aesthetic board, visual references | `Content/MoodBoard/SKILL.md` |
| **PianoVideo** | synthesia, piano video, falling notes, transcribe song to piano, song to sheet music, audio to midi, piano cover, piano arrangement | `Content/PianoVideo/SKILL.md` |
| **Scrivener** | scrivener, scriv project, package, scrivener binder, organize, restructure scrivener, scrivener backup, or move stories, writing into scrivener | `Content/Scrivener/SKILL.md` |
| **SystemFlowchart** | kaya system diagram, kaya architecture flowchart, visualize kaya, kaya system map, how kaya operates, show kaya structure, update architecture diagram, mermaid diagram | `Content/SystemFlowchart/SKILL.md` |
| **VoiceNotes** | voice note, voice memo, transcribe audio, dictation to notes, capture voice into obsidian, process voice notes, voice journal, audio note | `Content/VoiceNotes/SKILL.md` |

## Workflow Routing

When a sub-skill is identified from the table above:
1. Read the sub-skill's SKILL.md for its full routing and workflow list
2. Execute the appropriate workflow from that sub-skill's directory

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`
