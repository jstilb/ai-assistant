# ReviewPrompts Workflow

**Trigger:** "review prompts", "prompt audit", "audit prompts", "check prompts", "validate prompts"

## Purpose

Systematic review of all registered prompts against Standards.md best practices. Use during maintenance cycles, after low rating signals, or when Standards.md updates.

## When to Review

- **Monthly:** During regular maintenance cycles
- **After feedback:** When user rating signals indicate issues
- **After updates:** When Standards.md changes
- **Before release:** When preparing Kaya updates for public repository

## Intent-to-Flag Mapping

### Mode Selection

| User Says | Flag | Effect |
|-----------|------|--------|
| "quick check" | `--fast` | Skip info-level analysis |
| "thorough review" | (default) | Full validation |
| "strict" | `--strict` | Fail on warnings |

### Output Options

| User Says | Flag | Effect |
|-----------|------|--------|
| "JSON output" | `--json` | Machine-readable output |
| "verbose" | `--verbose` | Show all issue details |
| "save report" | `--output <path>` | Write to file |

## Execute

```bash
# Standard review
bun ~/.claude/skills/Prompting/Tools/PromptAudit.ts

# Quick check
bun ~/.claude/skills/Prompting/Tools/PromptAudit.ts --fast

# Strict mode with verbose output
bun ~/.claude/skills/Prompting/Tools/PromptAudit.ts --strict --verbose

# Save JSON report
bun ~/.claude/skills/Prompting/Tools/PromptAudit.ts --json --output ~/Desktop/prompt-audit.json
```

## Workflow Steps

### 1. Run Audit

Execute PromptAudit.ts against PromptRegistry.yaml:

```bash
cd ~/.claude/skills/Prompting
bun Tools/PromptAudit.ts --verbose
```

### 2. Review Results

Examine the audit report:

- **Errors (❌):** Must be fixed immediately
- **Warnings (⚠️):** Should be addressed
- **Info (ℹ️):** Consider for improvement

### 3. Prioritize Issues

Order fixes by:
1. Templates used by hooks (highest impact)
2. Templates used by agents
3. Templates with lowest scores
4. Templates with most issues

### 4. Fix Issues

For each failing prompt:

1. Load the template
2. Review the specific issues
3. Apply fixes following Standards.md
4. Re-run audit to verify

### 5. Update Registry

If templates were modified:

1. Update version in PromptRegistry.yaml
2. Update `last_updated` date
3. Document changes in IDEAS.md

### 6. Capture Learning

If significant patterns were found:

1. Note in MEMORY/LEARNING/SYSTEM/
2. Consider updating Standards.md
3. Add to maintenance checklist

## Quality Gates

### Passing Criteria

| Mode | Pass Condition |
|------|----------------|
| Normal | No errors |
| Strict | No errors AND no warnings |

### Score Thresholds

| Score | Assessment |
|-------|------------|
| 90-100 | Excellent |
| 80-89 | Good |
| 70-79 | Acceptable |
| 60-69 | Needs attention |
| Below 60 | Critical - fix immediately |

## Common Issues and Fixes

### NO_XML_TAGS

**Problem:** Using `<instructions>` or similar XML tags
**Fix:** Convert to markdown headers `## Instructions`

### CLEAR_INSTRUCTIONS

**Problem:** No explicit instructions section
**Fix:** Add `## Rules` or numbered instruction list

### OUTPUT_FORMAT

**Problem:** No output format specified
**Fix:** Add `## Output Format` section with examples

### HANDLEBARS_SYNTAX

**Problem:** Unclosed `{{#each}}` or `{{#if}}` blocks
**Fix:** Ensure every `{{#block}}` has matching `{{/block}}`

### POSITIVE_FRAMING

**Problem:** Too many "NEVER" and "DON'T" instructions
**Fix:** Reframe as positive guidance ("Use X" instead of "Don't use Y")

## Integration

### With Maintenance Workflows

Add to monthly maintenance checklist:

```yaml
monthly_tasks:
  - name: "Prompt Review"
    command: "bun ~/.claude/skills/Prompting/Tools/PromptAudit.ts --strict"
    threshold: 80
```

### With CI/CD

For Kaya public releases:

```yaml
- name: Prompt Audit
  run: bun skills/Prompting/Tools/PromptAudit.ts --strict
  continue-on-error: false
```

## Related

- `PromptAudit.ts` - The audit tool
- `PromptRegistry.yaml` - Central prompt inventory
- `Standards.md` - Best practices reference
- `ValidatePrompt.md` - Single prompt validation workflow
