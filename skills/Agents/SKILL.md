---
name: Agents
description: Designer Briefs and spec-pipeline support (screen-inventory parsing, UX/UI structural validation, grill research directives) backing the automated QueueRouter spec-pipeline. USE WHEN agents, multi-agent, the algorithm, optimize, spec-pipeline gating, screen inventory coverage, grill directive generation, OR agent orchestration.
---

# Agents

Designer Briefs (`UIDesignerBrief.md`, `UXDesignerBrief.md`, `DesignerBrief.md`, used by the spec pipeline; the other agent briefs now live in `agents/*.md`) and the SpecSheet support library behind the automated QueueRouter spec-pipeline (the interactive `/specsheet` workflows were retired 2026-07-02).

## Sub-Skills

| Sub-Skill | Triggers | Load |
|-----------|----------|------|
| **SpecSheet** | debugging spec-pipeline ux/ui gating, screen inventory coverage, or grill directive generation | `Agents/SpecSheet/SKILL.md` |

## Workflow Routing

When a sub-skill is identified from the table above:
1. Read the sub-skill's SKILL.md for its full routing and workflow list
2. Execute the appropriate workflow from that sub-skill's directory

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`
