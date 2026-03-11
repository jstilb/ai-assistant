---
name: Intelligence
description: Research, analysis, argument mapping, knowledge graph, evaluation, prompting, and Fabric patterns. USE WHEN research, analyze, evaluate agents, argument mapping, knowledge graph, meta-prompting, fabric patterns, OR any deep investigative or analytical task.
---

# Intelligence

Deep research and analytical intelligence — covering research workflows, argument analysis, knowledge graph navigation, agent evaluation, meta-prompting, and pattern-based reasoning.

## Sub-Skills

| Sub-Skill | Triggers | Load |
|-----------|----------|------|
| **Research** | research, investigate, analyze topic, deep dive | `Intelligence/Research/SKILL.md` |
| **ArgumentMapper** | argument mapping, claim verification, debate analysis, logical claims | `Intelligence/ArgumentMapper/SKILL.md` |
| **KnowledgeGraph** | knowledge graph, graph navigation, concept map | `Intelligence/KnowledgeGraph/SKILL.md` |
| **Graph** | temporal graph, property graph, trace error, graph query | `Intelligence/Graph/SKILL.md` |
| **Evals** | eval, evaluate agents, benchmark, agent evaluation framework | `Intelligence/Evals/SKILL.md` |
| **Prompting** | meta-prompting, prompt engineering, system prompt, prompt optimization | `Intelligence/Prompting/SKILL.md` |
| **Fabric** | fabric, pattern, prompt pattern, fabric pattern | `Intelligence/Fabric/SKILL.md` |

## Workflow Routing

When a sub-skill is identified from the table above:
1. Read the sub-skill's SKILL.md for its full routing and workflow list
2. Execute the appropriate workflow from that sub-skill's directory

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`
