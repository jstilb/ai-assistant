# ValidateSkill Workflow

**Purpose:** Check if an existing skill follows the canonical structure with proper TitleCase naming.

---

## Step 1: Read the Authoritative Source

**REQUIRED FIRST:** Read the canonical structure:

```
~/.claude/skills/CORE/SYSTEM/SKILLSYSTEM.md
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

Verify TitleCase:
- ✓ `Blogging`, `Daemon`, `CreateSkill`
- ✗ `createskill`, `create-skill`, `CREATE_SKILL`

### Workflow Files
```bash
ls ~/.claude/skills/[SkillName]/Workflows/
```

Verify TitleCase:
- ✓ `Create.md`, `UpdateDaemonInfo.md`, `SyncRepo.md`
- ✗ `create.md`, `update-daemon-info.md`, `SYNC_REPO.md`

### Tool Files
```bash
ls ~/.claude/skills/[SkillName]/Tools/
```

Verify TitleCase:
- ✓ `ManageServer.ts`, `ManageServer.help.md`
- ✗ `manage-server.ts`, `MANAGE_SERVER.ts`

---

## Step 4: Check YAML Frontmatter

Verify the YAML has:

### Single-Line Description with USE WHEN
```yaml
---
name: SkillName
description: [What it does]. USE WHEN [intent triggers using OR]. [Additional capabilities].
---
```

**Check for violations:**
- Multi-line description using `|` (WRONG)
- Missing `USE WHEN` keyword (WRONG)
- Separate `triggers:` array in YAML (OLD FORMAT - WRONG)
- Separate `workflows:` array in YAML (OLD FORMAT - WRONG)
- `name:` not in TitleCase (WRONG)

---

## Step 5: Check Markdown Body

Verify the body has:

### Workflow Routing Section
```markdown
## Workflow Routing

**When executing a workflow, output this notification:**

```
Running the **WorkflowName** workflow from the **SkillName** skill...
```

| Workflow | Trigger | File |
|----------|---------|------|
| **WorkflowOne** | "trigger phrase" | `Workflows/WorkflowOne.md` |
```

**Check for violations:**
- Missing `## Workflow Routing` section
- Workflow names not in TitleCase
- File paths not matching actual file names

### Examples Section
```markdown
## Examples

**Example 1: [Use case]**
```
User: "[Request]"
→ [Action]
→ [Result]
```
```

**Check:** Examples section required (WRONG if missing)

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

**Reference:** `~/.claude/skills/CORE/SYSTEM/CLIFIRSTARCHITECTURE.md`

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
4. References `OutputPathResolver` from `skills/CORE/Tools/OutputPathResolver.ts`

### Check Tool Usage

If skill has TypeScript tools that write files, verify they use OutputPathResolver:

```bash
grep -l "OutputPathResolver" ~/.claude/skills/[SkillName]/Tools/*.ts
```

**Required pattern in tools that produce output:**
```typescript
import { resolveOutputPath, ensureOutputDir } from '~/.claude/skills/CORE/Tools/OutputPathResolver';

const { path } = await resolveOutputPath({
  skill: 'SkillName',
  title: 'output-title'
});
ensureOutputDir(path);
await Bun.write(path, content);
```

**Reference:** `~/.claude/skills/CORE/Tools/OutputPathResolver.help.md`

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
bun ~/.claude/skills/CORE/Tools/SkillInvoker.ts --exists "[SkillName]"
```

**Required pattern:**
```typescript
import { invokeSkill } from '~/.claude/skills/CORE/Tools/SkillInvoker';

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

Reference: `~/.claude/skills/CORE/SYSTEM/INFRASTRUCTURE.md`

---

## Step 8: Report Results

Run the **Final Verification Checklist** from `Standards.md`.

**COMPLIANT** if all applicable checks pass.

**NON-COMPLIANT** if any check fails. Recommend using CanonicalizeSkill workflow.
