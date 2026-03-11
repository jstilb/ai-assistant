---
name: Content
description: AI art generation, content aggregation, Obsidian notes, and system flowcharts. USE WHEN art, generate art, content aggregator, obsidian, notes, flowchart, diagram, OR content creation.
---

# Content

Content creation and management — covering AI art generation, content aggregation and curation, Obsidian notes management, and system flowchart creation.

## Sub-Skills

| Sub-Skill | Triggers | Load |
|-----------|----------|------|
| **Art** | art, generate art, image, AI art, create image | `Content/Art/SKILL.md` |
| **ContentAggregator** | content aggregator, aggregate content, curate content, feed | `Content/ContentAggregator/SKILL.md` |
| **Obsidian** | obsidian, notes, vault, obsidian note, markdown notes | `Content/Obsidian/SKILL.md` |
| **SystemFlowchart** | flowchart, diagram, system diagram, flow chart, architecture diagram | `Content/SystemFlowchart/SKILL.md` |

## Workflow Routing

When a sub-skill is identified from the table above:
1. Read the sub-skill's SKILL.md for its full routing and workflow list
2. Execute the appropriate workflow from that sub-skill's directory

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`
