---
name: Intelligence
description: Research, analysis, argument mapping, System Graph and Obsidian vault graph, cross-session pattern synthesis (AgentMetacognition), Fabric patterns, and Socratic interviewing. USE WHEN research, analyze, argument mapping, system graph, vault graph, knowledge graph, find patterns, fabric patterns, grillme, grill me, interview me, socratic interview, OR any deep investigative or analytical task.
---

# Intelligence

Deep research and analytical intelligence — covering research workflows, argument analysis, knowledge graph navigation, agent evaluation, and pattern-based reasoning.

## Sub-Skills

| Sub-Skill | Triggers | Load |
|-----------|----------|------|
| **AgentMetacognition** | find patterns, what patterns have you noticed, connect to goals, enrich knowledge, what should i know, weekly intelligence, synthesize learnings | `Intelligence/AgentMetacognition/SKILL.md` |
| **ArgumentMapper** | argument mapping, verify claims, track stance, debate analysis, position tracking, who owns x, parent company, ultimate owner, subsidiaries, corporate structure, who funds x, political donations, conflict of interest | `Intelligence/ArgumentMapper/SKILL.md` |
| **Fabric** | user says 'use fabric', 'fabric pattern', 'run fabric', 'update fabric', 'update patterns', 'sync fabric', 'extract wisdom', 'summarize with fabric', 'create threat model', 'analyze with fabric', or any request to apply fabric patterns to content, extract insights, summarize content, analyze document | `Intelligence/Fabric/SKILL.md` |
| **Graph** | system graph, trace error, root cause, decision trace, system graph stats, connections, top nodes, entry points, goal decisions, visualize session graph | `Intelligence/Graph/SKILL.md` |
| **Grilling** | the user wants to stress-test their thinking, or uses any 'grill' trigger phrases | `Intelligence/Grilling/SKILL.md` |
| **IssueTrace** | track an issue, trace a bug, why does this file keep breaking, recurring errors, regression, issue lifecycle, what bugs keep coming back, development health | `Intelligence/IssueTrace/SKILL.md` |
| **Research** | research, find information, investigate, analyze a topic, research and analyze, quick research, extensive research | `Intelligence/Research/SKILL.md` |
| **VaultGraph** | knowledge graph, obsidian graph, vault navigation, what i know about, knowledge gaps, concept clusters, related notes, graph analysis, vault exploration, visualize vault graph, show vault graph, interactive graph | `Intelligence/VaultGraph/SKILL.md` |

## Workflow Routing

When a sub-skill is identified from the table above:
1. Read the sub-skill's SKILL.md for its full routing and workflow list
2. Execute the appropriate workflow from that sub-skill's directory

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`
