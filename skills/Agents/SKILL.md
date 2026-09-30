---
name: Agents
description: Agent context files and spec-pipeline support (screen-inventory parsing, UX/UI structural validation, grill research directives) backing the automated QueueRouter spec-pipeline. USE WHEN agents, multi-agent, the algorithm, optimize, spec-pipeline gating, screen inventory coverage, grill directive generation, OR agent orchestration.
---

# Agents

Agent context files (loaded by the native `agents/*.md` definitions) and spec sheet generation for new features.

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
