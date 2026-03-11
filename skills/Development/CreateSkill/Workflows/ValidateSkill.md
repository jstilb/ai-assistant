# ValidateSkill Workflow

**Purpose:** Check if an existing skill follows the canonical structure with proper TitleCase naming.

---

## Step 1: Read the Authoritative Source

**REQUIRED FIRST:** Read the canonical structure:

```
~/.claude/docs/system/SKILLSYSTEM.md
```

---

## Step 2: Read the Target Skill

```bash
~/.claude/skills/[SkillName]/SKILL.md
```

---

## Step 3: Check TitleCase Naming

### Skill Directory
```bash
ls ~/.claude/skills/ | grep -i [skillname]
```

### Workflow Files
```bash
ls ~/.claude/skills/[SkillName]/Workflows/
```

### Tool Files
```bash
ls ~/.claude/skills/[SkillName]/Tools/
```

Verify all names against `Standards.md` — TitleCase Naming Convention.

---

## Step 4: Check YAML Frontmatter

Verify YAML has:

```yaml
---
name: SkillName
description: [What it does]. USE WHEN [intent triggers using OR]. [Additional capabilities].
---
```

Check for violations in `Standards.md` — YAML Frontmatter checklist.

---

## Step 5: Check Markdown Body

### Workflow Routing Section

Target format:
```markdown
## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **WorkflowOne** | "trigger phrase" | `Workflows/WorkflowOne.md` |
```

### Examples Section

Target format:
```markdown
## Examples

**Example 1: [Use case]**
```
User: "[Request]"
→ [Action]
→ [Result]
```
```

Check against `Standards.md` — Markdown Body checklist.

---

## Step 6: Check Workflow Files

```bash
ls ~/.claude/skills/[SkillName]/Workflows/
```

Verify:
- Every file uses TitleCase naming
- Every file has a corresponding entry in `## Workflow Routing` section
- Every routing entry points to an existing file
- Routing table names match file names exactly

---

## Step 7: Check Structure

```bash
ls -la ~/.claude/skills/[SkillName]/
```

Verify:
- `tools/` directory exists (even if empty)
- No `backups/` directory inside skill
- Reference docs at skill root (not in Workflows/)

---

## Step 7a: Check CLI-First Integration (for skills with CLI tools)

**If the skill has CLI tools in `tools/`:**

### CLI Tool Configuration Flags

Check each tool for flag-based configuration:
```bash
bun ~/.claude/skills/[SkillName]/Tools/[ToolName].ts --help
```

Verify the tool exposes behavioral configuration via flags:
- Mode flags (--fast, --thorough, --dry-run) where applicable
- Output flags (--format, --quiet, --verbose)
- Resource flags (--model, etc.) if applicable
- Post-processing flags if applicable

### Workflow Intent-to-Flag Mapping

For workflows that call CLI tools, check for intent-to-flag mapping tables:

```bash
grep -l "Intent-to-Flag" ~/.claude/skills/[SkillName]/Workflows/*.md
```

**Required pattern in workflows with CLI tools:**
```markdown
## Intent-to-Flag Mapping

| User Says | Flag | When to Use |
|-----------|------|-------------|
| "fast" | `--model haiku` | Speed priority |
| (default) | `--model sonnet` | Balanced |
```

**Reference:** `~/.claude/docs/system/CLIFIRSTARCHITECTURE.md`

---

## Step 7b: Check Output Configuration (for skills that produce files)

**If the skill produces output files:**

### Check for Output Configuration Section

```bash
grep -l "Output Configuration" ~/.claude/skills/[SkillName]/SKILL.md
```

Verify:
1. `## Output Configuration` section exists (or is noted as not applicable)
2. Uses standard MEMORY path convention: `MEMORY/[SkillName]/YYYY-MM-DD/`
3. Documents any override of the default path
4. References `OutputPathResolver` from `lib/core/OutputPathResolver.ts`

### Check Tool Usage

If skill has TypeScript tools that write files, verify they use OutputPathResolver:

```bash
grep -l "OutputPathResolver" ~/.claude/skills/[SkillName]/Tools/*.ts
```

**Required pattern in tools that produce output:**
```typescript
import { resolveOutputPath, ensureOutputDir } from '~/.claude/lib/core/OutputPathResolver';

const { path } = await resolveOutputPath({
  skill: 'SkillName',
  title: 'output-title'
});
ensureOutputDir(path);
await Bun.write(path, content);
```

**Reference:** `~/.claude/lib/core/OutputPathResolver.help.md`

---

## Step 7c: Check Skill Invocation Patterns

**If the skill invokes other skills programmatically:**

### Check for proper SkillInvoker usage

Verify tools that invoke other skills:
1. Use `CORE/Tools/SkillInvoker` for skill invocation
2. Do NOT use raw `Bun.spawn(["claude", ...])` for skill calls
3. Do NOT use deprecated `AutoMaintenance/Tools/SkillInvoker`

### Check invoked skills exist

For each skill invoked, verify it exists:
```bash
bun ~/.claude/lib/core/SkillInvoker.ts --exists "[SkillName]"
```

**Required pattern:**
```typescript
import { invokeSkill } from '~/.claude/lib/core/SkillInvoker';

const result = await invokeSkill({
  skill: 'InformationManager',
  args: 'ProcessScratchPad',
});
```

**Anti-patterns to flag:**
```typescript
// WRONG: Raw spawn bypasses validation
Bun.spawn(["claude", "-p", "/System integrity"]);

// WRONG: Deprecated import path
import { invokeSkill } from '../AutoMaintenance/Tools/SkillInvoker';
```

---

## Step 7d: Check Infrastructure Utilization

**Scan for anti-patterns that indicate missed infrastructure opportunities.**

### 1. State Management Anti-Patterns

```bash
grep -r "JSON.parse.*Bun.file\|await Bun.write.*\.json" ~/.claude/skills/[SkillName]/Tools/
```

**If found:** Recommend using StateManager for type-safe state with validation, transactions, and backups.

### 2. Notification Anti-Patterns

```bash
grep -r "curl.*localhost:8888\|fetch.*localhost:8888\|VOICE_SERVER" ~/.claude/skills/[SkillName]/Tools/
```

**If found:** Recommend using `NotificationService.notifySync()` for batching, retry, and multi-channel support.

### 3. Skill Invocation Anti-Patterns

```bash
grep -r 'Bun.spawn.*claude' ~/.claude/skills/[SkillName]/Tools/
```

**If found:** Recommend using `SkillInvoker` from CORE for validation and case correction.

### 4. HTTP Request Anti-Patterns

```bash
grep -r "fetch\(" ~/.claude/skills/[SkillName]/Tools/ | grep -v "cachedFetch\|CachedHTTPClient"
```

**If found:** Consider using `CachedHTTPClient` for external APIs (caching, retry, rate limiting).

### 5. API Key Anti-Patterns

```bash
grep -r "ANTHROPIC_API_KEY\|anthropic\.messages\|@anthropic-ai/sdk" ~/.claude/skills/[SkillName]/Tools/
```

**If found:** CRITICAL - Must use `Inference.ts` instead (uses subscription, consistent tiers).

### 6. Output Path Anti-Patterns

```bash
grep -r "Bun.write\|writeFileSync" ~/.claude/skills/[SkillName]/Tools/ | grep -v "OutputPathResolver"
```

**If file outputs don't use OutputPathResolver:** Recommend using for consistent paths.

### Report Infrastructure Findings

If any anti-patterns detected, report as:

```
INFRASTRUCTURE UNDERUTILIZATION DETECTED:

1. [Pattern]: [File:Line]
   Current: [What it does now]
   Recommended: Use [CORE Tool] for [benefit]

2. ...
```

Reference: `~/.claude/docs/system/INFRASTRUCTURE.md`

---

## Step 7e: Design Quality Evaluation (for new or substantially changed skills)

Apply the design quality questions from CreateSkill workflow Step 2.7:
1. Scope coherence — one sentence, no "and"?
2. Standalone justification — why not a workflow elsewhere?
3. Workflow decomposition — each workflow one atomic deliverable?
4. Execution pattern fit — matches problem nature per PATTERNGUIDANCE.md?
5. Abstraction level — correct placement in system hierarchy?

**Skip if:** Routine validation of an established, stable skill.
**Report as:** DESIGN findings (separate from STRUCTURAL), severity ADVISORY.

---

## Step 8: Report Results

Run the **Final Verification Checklist** from `Standards.md`.

**COMPLIANT** if all applicable checks pass.

**NON-COMPLIANT** if any check fails. Recommend using CanonicalizeSkill workflow.
