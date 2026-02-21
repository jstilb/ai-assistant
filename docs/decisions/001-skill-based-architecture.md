# ADR-001: Skill-Based Architecture

## Status

Accepted

## Date

2024-11-01

## Context

Building a personal AI assistant requires extensibility -- new capabilities need to be added frequently without breaking existing ones. The system must work within Claude Code's constraint of loading context from files at session start.

Options considered:
1. **Monolithic prompt** -- One large system prompt with all capabilities
2. **Plugin system** -- Code-based plugins loaded at runtime
3. **Skill-based architecture** -- Self-contained Markdown modules discovered by keyword matching

## Decision

Use a skill-based architecture where each capability is a self-contained directory with a `SKILL.md` manifest that defines triggers, workflows, and integration points.

## Rationale

- **Claude Code native**: Markdown files are Claude Code's natural input format. No compilation, no runtime loading -- just `read skills/SkillName/SKILL.md`.
- **Composability**: Skills can reference and invoke each other through natural language, matching how Claude Code already works.
- **Discoverability**: The `USE WHEN` trigger clause in each SKILL.md enables the CORE router to match user intent to capabilities without maintaining a central registry.
- **Isolation**: Each skill's state, context, and tools are co-located in its directory. Adding or removing a skill has no side effects on others.
- **Documentation-as-code**: The SKILL.md files serve as both machine-readable configuration and human-readable documentation.

## Consequences

- **Positive**: Adding new skills is trivial -- create a directory with SKILL.md and it is immediately discoverable.
- **Positive**: Skills are independently testable and auditable (see SkillAudit).
- **Negative**: No compile-time validation of skill interfaces. Malformed SKILL.md files fail silently.
- **Negative**: Keyword-based routing can produce false positives. Mitigated by the USE WHEN clause specificity requirements.
