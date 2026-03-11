---
name: CreateSkill
description: Skill lifecycle management for Kaya. USE WHEN create skill, new skill, validate skill, canonicalize skill, eval skill, test skill, optimize skill description, compare skill versions, A/B skill test, skill structure audit.
---
# CreateSkill

MANDATORY skill creation framework for ALL skill creation requests.

## Authoritative Source

**Before creating ANY skill, READ:** `~/.claude/docs/system/SKILLSYSTEM.md`

**Canonical example to follow:** `~/.claude/skills/Productivity/DailyBriefing/SKILL.md`

## TitleCase Naming Convention

**All naming must use TitleCase (PascalCase).** Full reference table and wrong-vs-correct examples in `Standards.md`.

## Flat Folder Structure

**See:** `~/.claude/docs/system/SKILLSYSTEM.md` (Flat Folder Structure section) for mandatory depth rules and allowed subdirectories.

## Dynamic Loading Pattern

**See:** `~/.claude/docs/system/SKILLSYSTEM.md` (Dynamic Loading Pattern section) for when and how to split large SKILL.md files.

---

## Voice Notification

-> Use `notifySync()` from `lib/core/NotificationService.ts`

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **CreateSkill** | "create a new skill" | `Workflows/CreateSkill.md` |
| **ValidateSkill** | "validate skill", "check skill" | `Workflows/ValidateSkill.md` |
| **UpdateSkill** | "update skill", "add workflow" | `Workflows/UpdateSkill.md` |
| **CanonicalizeSkill** | "canonicalize", "fix skill structure" | `Workflows/CanonicalizeSkill.md` |
| **EvalSkill** | "eval skill", "test skill" | `Workflows/EvalSkill.md` |
| **OptimizeDescription** | "optimize description", "improve triggers" | `Workflows/OptimizeDescription.md` |
| **CompareSkill** | "compare skills", "A/B skill test" | `Workflows/CompareSkill.md` |

## Examples

**Example 1: Create a new skill from scratch**
```
User: "Create a skill for managing my recipes"
→ Invokes CreateSkill workflow
→ Reads SkillSystem.md for structure requirements
→ Creates skill directory with TitleCase naming
→ Creates SKILL.md, Workflows/, Tools/
→ Generates USE WHEN triggers based on intent
```

**Example 2: Fix an existing skill that's not routing properly**
```
User: "The research skill isn't triggering - validate it"
→ Invokes ValidateSkill workflow
→ Checks SKILL.md against canonical format
→ Verifies TitleCase naming throughout
→ Verifies USE WHEN triggers are intent-based
→ Reports compliance issues with fixes
```

**Example 3: Evaluate a skill's quality and iterate**
```
User: "Eval the JobEngine skill"
→ Invokes EvalSkill workflow
→ Generates test prompts, spawns with-skill + baseline subagents
→ Grades outputs, aggregates benchmark, launches HTML viewer
→ Jm reviews results and provides feedback
→ Iterates until satisfied
```

---

## Integration

### Uses
- **CORE/SYSTEM/SKILLSYSTEM.md** - Skill structure requirements and standards
- **DailyBriefing/SKILL.md** - Canonical skill example
- **Glob/Grep** - File structure validation
- **EvalGrader.md**, **EvalComparator.md**, **EvalAnalyzer.md** — Subagent instructions for eval workflows
- **Tools/*.py** — Python scripts from Anthropic's skill-creator for benchmark aggregation, description optimization, and eval viewing

### Feeds Into
- **SkillAudit** - Skills created here are audited
- **Claude Code native discovery** - New SKILL.md files are discovered automatically at session start
- **System skill** - Integrity checks validate skills

### MCPs Used
- None (direct filesystem operations)

---

**Last Updated:** 2026-03-09
