# ValidatePrompt Workflow

**Trigger:** User says "validate prompt", "check prompt", "lint prompt", "validate this prompt"

## Overview

Validates prompts against Claude 4.x best practices from Standards.md. Detects anti-patterns, provides actionable suggestions, and optionally shows fix recommendations.

## Steps

### Step 1: Identify Input Source

Determine where the prompt to validate comes from:

| Source | Detection | Action |
|--------|-----------|--------|
| File path | User provides path (e.g., "validate ~/prompts/agent.md") | Use `--file` flag |
| Inline text | User provides text in quotes | Use `--text` flag |
| Recent context | User says "validate this prompt" referring to conversation | Extract from context, use `--text` |

### Step 2: Run Validation

Execute the ValidatePrompt.ts tool with appropriate flags:

```bash
# File validation
bun run ~/.claude/skills/Prompting/Tools/ValidatePrompt.ts --file <path> --fix

# Inline text validation
bun run ~/.claude/skills/Prompting/Tools/ValidatePrompt.ts --text "<prompt>" --fix

# Piped input
echo "<prompt>" | bun run ~/.claude/skills/Prompting/Tools/ValidatePrompt.ts --fix
```

**Available Flags:**
- `--fix` - Show fix suggestions inline (recommended)
- `--strict` - Fail on any warning (exit code 2)
- `--json` - Output results as JSON for programmatic use

### Step 3: Report Findings

Present results organized by severity:

| Severity | Icon | Meaning | Action Required |
|----------|------|---------|-----------------|
| ERROR | 🔴 | Critical anti-pattern | Must fix before use |
| WARNING | 🟡 | Suboptimal pattern | Should improve |
| INFO | 🔵 | Suggestion | Nice to have |

**Rules Checked:**
- `xml-tags` - XML tags in prompt (use markdown instead)
- `aggressive-tool-language` - Overly forceful tool instructions
- `think-with-extended-thinking` - "think" verbs when extended thinking disabled
- `negative-only-constraint` - Missing positive alternatives
- `vague-language` - Hedging words ("might want to", "could consider")
- `example-overload` - More than 3 examples (diminishing returns)
- `verbose-explanations` - Overly long lines without structure
- `missing-output-format` - No explicit output format section
- `bold-italic-overuse` - Excessive formatting emphasis

### Step 4: Offer Auto-Fix

If errors or warnings are found:

1. Show the specific issues with line numbers
2. Display the suggested fix for each issue
3. Ask: "Would you like me to apply these fixes?"
4. If yes, modify the prompt and re-validate to confirm fixes

### Step 5: Voice Notification

On completion, send voice notification:

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Prompt validation complete"}' \
  > /dev/null 2>&1 &
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | No errors |
| 1 | Errors found |
| 2 | Warnings found (with `--strict`) |

## Examples

**Validate a skill file:**
```
"validate the prompt in skills/Agents/Templates/DynamicAgent.hbs"
```

**Check a prompt I just wrote:**
```
"lint this prompt: You are a helpful assistant..."
```

**Strict mode for production prompts:**
```
"validate this prompt strictly" → uses --strict flag
```

## Related

- **Standards.md** - The source of validation rules
- **Templates/** - Validated template primitives
- **RenderTemplate.ts** - Template rendering (pair with validation)
