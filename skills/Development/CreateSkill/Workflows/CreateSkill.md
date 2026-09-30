# CreateSkill Workflow

Create a new skill following the canonical structure with proper TitleCase naming.

## Step 1: Read the Authoritative Sources

**REQUIRED FIRST:**

1. Read the skill system documentation: `~/.claude/docs/system/SKILLSYSTEM.md`
2. Read the canonical example: `~/.claude/skills/Productivity/DailyBriefing/SKILL.md`

## Step 2: Understand the Request

Ask the user:
1. What does this skill do?
2. What should trigger it?
3. What workflows does it need?

## Step 2.5: Infrastructure Discovery (MANDATORY)

**Before designing the skill, review available infrastructure to avoid reinventing existing tools.**

### 1. Read Infrastructure Inventory

```
Read: ~/.claude/docs/system/INFRASTRUCTURE.md
```

This contains:
- All CORE tools with import patterns and CLI usage
- External CLIs available on the system
- UnixCLI tools for external services
- Composable skills to build on
- Anti-patterns to avoid

### 2. Identify Applicable CORE Tools

Based on skill requirements, determine which tools to use:

| Requirement | CORE Tool |
|-------------|-----------|
| Needs persistent state? | StateManager |
| Sends notifications? | NotificationService |
| Fetches external URLs? | CachedHTTPClient |
| Stores outputs/learnings? | MemoryStore + OutputPathResolver |
| Requires human approval? | ApprovalQueue |
| Uses multiple agents? | the Agent tool (spawn subagents directly) |
| Needs AI inference? | Inference.ts |
| Loads configuration? | ConfigLoader |

### 3. Check for External CLIs

Does the skill interact with external services? Check if a CLI exists:

| Service | CLI |
|---------|-----|
| Calendar | `gcalcli` |
| YouTube/Media | `yt-dlp` |
| Cloud storage | `rclone` |
| GitHub | `gh` |
| Social (Bluesky) | `bsky` |
| JSON processing | `jq` |

### 4. Check for Composable Skills

Does the skill overlap with existing capabilities?

| Need | Skill to Compose With |
|------|----------------------|
| Deep research | Research skill |
| Web verification | Browser skill |
| Named agents with voices | Agents skill |
| Content transformation | Fabric skill |
| Testing/verification | Evals skill |
| Complex multi-step | AutonomousWork skill |

### 5. Determine Execution Pattern

```
Read: ~/.claude/docs/system/PATTERNGUIDANCE.md
```

Choose the appropriate pattern:

| Pattern | When to Use |
|---------|-------------|
| **Deterministic** | Same input → same output, testable, scriptable |
| **Intelligent** | Requires semantic understanding, classification |
| **Hybrid** | Structured extraction + intelligent analysis |

**Document your infrastructure decisions before proceeding to Step 2.7.**

## Step 2.7: Design Quality Evaluation (MANDATORY)

**Before committing to structure, evaluate the design.**

### Q1: Scope Coherence

Can you describe what this skill does in one sentence without "and"?

If the honest description requires "and", each clause likely has independent utility
and should be a separate skill or a workflow in an existing skill.

### Q2: Standalone Justification

A standalone skill is justified when:
- It has (or will clearly have) multiple distinct workflows
- It has non-trivial state, tools, or configuration of its own
- Users would invoke it directly by name
- Its trigger vocabulary doesn't substantially overlap with any existing skill

If any are false, evaluate whether this should be a workflow addition to an existing skill.
Check existing USE WHEN triggers for overlap.

### Q3: Workflow Decomposition

List the planned workflows. Each should be one atomic deliverable.

Warning signs of wrong decomposition:
- Workflow A always calls Workflow B → should be one workflow
- Two workflows share >80% of steps → should be parameterized into one
- A workflow name contains "and" → SRP violation

### Q4: Execution Pattern Fit

Reference: `~/.claude/docs/system/PATTERNGUIDANCE.md`

| Problem Nature | Correct Pattern |
|----------------|-----------------|
| Same input → same output | Deterministic |
| Requires semantic understanding | Intelligent |
| Structured extraction then analysis | Hybrid |

Start Deterministic. Add intelligence only where semantic judgment is actually needed.

### Q5: Abstraction Level

| Level | Belongs In |
|-------|-----------|
| General-purpose infrastructure | `CORE/Tools/` — don't create a skill |
| Domain-specific with own triggers | `skills/SkillName/` — create a skill |
| Combines existing capabilities | Workflow in existing skill — don't create a skill |

### Design Quality Gate

**PROCEED** if all five questions yield clean answers.

**STOP AND REVISE** if any question surfaces a design problem. Return to Step 2
and revise scope before proceeding.

Document your evaluation before moving to Step 3:
- Scope: [one sentence, no "and"]
- Standalone justification: [brief rationale]
- Workflows: [list with atomic deliverables]
- Pattern: [Deterministic/Intelligent/Hybrid — why?]
- Level: [CORE / Domain / Composite]

## Step 3: Determine TitleCase Names

**All names must use TitleCase (PascalCase).**

**See:** `Standards.md` (TitleCase Naming Convention section) for the full naming reference table and wrong-vs-correct examples.

## Step 4: Create the Skill Directory

Skills can live in two locations:
- **Standalone:** `skills/[SkillName]/` — for skills with their own category
- **Under a category:** `skills/[Category]/[SkillName]/` — for sub-skills within an existing category (e.g., `skills/Intelligence/Research/`)

Only `Workflows/` is created unconditionally. `Tools/` is created in Step 4.5 when, and only when, the Design Quality Gate (Step 2.7 Q4) produced a pattern requiring deterministic scripts.

```bash
# Standalone skill
mkdir -p ~/.claude/skills/[SkillName]/Workflows

# Sub-skill under existing category
mkdir -p ~/.claude/skills/[Category]/[SkillName]/Workflows
```

## Step 4.5: Create Tools/ ONLY If the Execution Pattern Requires Scripts

Review the Step 2.7 Q4 answer. Apply the Tool-vs-Prompt rubric below before creating `Tools/`.

**Tool-vs-Prompt Rubric (ask both questions per prospective script):**
1. Does this script do something a prompt structurally cannot? (deterministic I/O, cryptographic operation, hot-loop throughput, cursor/state atomicity, binary parsing, shell orchestration, compile-time type safety for machine-consumed data)
2. If you removed the `inference()` call(s), is there still work worth scripting?

If either answer is "no", the capability belongs in a workflow prompt — do not create `Tools/` for it.

| Q4 Answer | Create `Tools/`? | Rationale |
|-----------|------------------|-----------|
| **Intelligent** (pure prompt work: classification, semantic analysis, judgment) | NO | Everything lives in `Workflows/*.md`. An empty `Tools/` is dead weight that invites later bloat. |
| **Deterministic** | YES, if the skill has at least one genuine deterministic need (I/O glue, hot-loop math, state atomicity, CLI wrapper). If all "scripted" work is actually LLM-wrapping, revisit Q4. | `Tools/` holds real scripts. |
| **Hybrid** | YES, but only for the deterministic half. The intelligent half stays in `Workflows/`. | Mixed skill; scripts coexist with prompt-only workflows. |

```bash
# Only run if Q4 = Deterministic or Hybrid AND the rubric produced at least one justified script
mkdir -p ~/.claude/skills/[SkillName]/Tools
# (or, for sub-skills)
mkdir -p ~/.claude/skills/[Category]/[SkillName]/Tools
```

If you are in doubt, skip `Tools/`. A skill can always add it later when a concrete scripted need is identified; removing unused scripted scaffolding after the fact is the hard direction.

## Step 5: Create SKILL.md

Follow this exact structure:

```yaml
---
name: SkillName
description: [What it does]. USE WHEN [intent triggers using OR]. [Additional capabilities].
---

# SkillName

[Brief description]

## Voice Notification

→ Use `notifySync()` from `lib/core/NotificationService.ts`

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **WorkflowOne** | "trigger phrase" | `Workflows/WorkflowOne.md` |
| **WorkflowTwo** | "another trigger" | `Workflows/WorkflowTwo.md` |

## Output Configuration (Optional - for skills that produce files)

**Default path:** `~/.claude/MEMORY/[SkillName]/[YYYY-MM-DD]/`

Use `resolveOutputPath()` from `lib/core/OutputPathResolver.ts`:

\`\`\`typescript
import { resolveOutputPath, ensureOutputDir } from '~/.claude/lib/core/OutputPathResolver';

const { path } = await resolveOutputPath({
  skill: 'SkillName',
  title: 'output-title'
});
ensureOutputDir(path);
await Bun.write(path, content);
\`\`\`

**Output types:**
| Type | Path | Use Case |
|------|------|----------|
| `memory` (default) | `MEMORY/[SkillName]/YYYY-MM-DD/` | Permanent skill outputs |
| `work` | `MEMORY/WORK/{session}/scratch/` | Work-session artifacts |
| `downloads` | `~/Downloads/` | User preview |
| `custom` | User-specified | Special needs |

## Examples

**Example 1: [Common use case]**
```
User: "[Typical user request]"
→ Invokes WorkflowOne workflow
→ [What skill does]
→ [What user gets back]
```

**Example 2: [Another use case]**
```
User: "[Different request]"
→ [Process]
→ [Output]
```

## [Additional Documentation]

[Any other relevant info]
```

## Step 6: Create Workflow Files

For each workflow in the routing section:

```bash
touch ~/.claude/skills/[SkillName]/Workflows/[WorkflowName].md
```

### Workflow-to-Tool Integration (REQUIRED for workflows with CLI tools)

**If a workflow calls a CLI tool, it MUST include intent-to-flag mapping tables.**

This pattern translates natural language user requests into appropriate CLI flags:

```markdown
## Intent-to-Flag Mapping

### Model/Mode Selection

| User Says | Flag | When to Use |
|-----------|------|-------------|
| "fast", "quick", "draft" | `--model haiku` | Speed priority |
| (default), "best", "high quality" | `--model opus` | Quality priority |

### Output Options

| User Says | Flag | Effect |
|-----------|------|--------|
| "JSON output" | `--format json` | Machine-readable |
| "detailed" | `--verbose` | Extra information |

## Execute Tool

Based on user request, construct the CLI command:

\`\`\`bash
bun ToolName.ts \
  [FLAGS_FROM_INTENT_MAPPING] \
  --required-param "value"
\`\`\`
```

**Why this matters:**
- Tools have rich configuration via flags
- Workflows should expose this flexibility, not hardcode single patterns
- Users speak naturally; workflows translate to precise CLI

**Examples (TitleCase):**
```bash
touch ~/.claude/skills/Daemon/Workflows/UpdateDaemonInfo.md
touch ~/.claude/skills/Daemon/Workflows/UpdatePublicRepo.md
touch ~/.claude/skills/Productivity/DailyBriefing/Workflows/Generate.md
touch ~/.claude/skills/Productivity/DailyBriefing/Workflows/Configure.md
```

## Step 7: Verify TitleCase

Run this check:
```bash
ls ~/.claude/skills/[SkillName]/
ls ~/.claude/skills/[SkillName]/Workflows/
# Only if Tools/ was created in Step 4.5:
[ -d ~/.claude/skills/[SkillName]/Tools ] && ls ~/.claude/skills/[SkillName]/Tools/
```

Verify ALL files use TitleCase:
- `SKILL.md` ✓ (exception - always uppercase)
- `WorkflowName.md` ✓
- `ToolName.ts` ✓ (if applicable)
- `ToolName.help.md` ✓ (if applicable)

## Step 8: Final Checklist

Run the **Final Verification Checklist** from `Standards.md`.

Confirm all naming, YAML frontmatter, markdown body, structure, CLI-first integration, and output configuration checks pass.

## Step 9: Verify Discovery

Verify the new skill is visible to the system:

```bash
test -f ~/.claude/skills/*/[SkillName]/SKILL.md && echo present
bun ~/.claude/lib/core/ValidateSkillStructure.ts --skills-dir ~/.claude/skills
```

## Step 10: Update Category Routing Table & Slash Command (Sub-Skills Only)

If the new skill was created inside a category directory (e.g., `skills/Intelligence/NewSkill/`), regenerate the parent category's routing table and auto-generate a slash command:

```bash
bun ~/.claude/lib/core/GenerateRoutingTables.ts --category [CategoryName]
```

This does two things:
1. Updates the category's `## Sub-Skills` table so the LLM can discover it
2. Generates `Commands/[skillname].md` so the skill is invokable as `/skillname`

Verify the new skill appears in both locations:
- Category SKILL.md `## Sub-Skills` table
- `Commands/[skillname].md` exists

Then validate structural integrity:

```bash
bun ~/.claude/lib/core/ValidateSkillStructure.ts
```

Expected: 0 errors.

## Done

Skill created following canonical structure with proper TitleCase naming throughout.
