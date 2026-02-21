# PromptAudit

Validate prompts against Standards.md best practices.

## Overview

PromptAudit validates all registered prompts in PromptRegistry.yaml against the Prompting skill's Standards.md. It checks for common issues like XML tags, missing instructions, and invalid Handlebars syntax.

## Usage

```bash
# Run full audit
bun PromptAudit.ts

# Quick scan (skip info-level checks)
bun PromptAudit.ts --fast

# Strict mode (fail on warnings)
bun PromptAudit.ts --strict

# JSON output
bun PromptAudit.ts --json

# Verbose output with all details
bun PromptAudit.ts --verbose

# Save report to file
bun PromptAudit.ts --output ./audit-report.md
```

## Options

| Flag | Short | Description |
|------|-------|-------------|
| `--fast` | `-f` | Quick scan, skip info-level checks |
| `--strict` | `-s` | Fail on warnings (not just errors) |
| `--json` | `-j` | Output as JSON |
| `--verbose` | `-v` | Show all issues, even for passing prompts |
| `--output <path>` | `-o` | Save report to file |
| `--help` | `-h` | Show help |

## Audit Rules

| Rule | Severity | Description |
|------|----------|-------------|
| `NO_XML_TAGS` | Error | Prompts should use markdown headers, not XML tags |
| `HANDLEBARS_SYNTAX` | Error | Handlebars template syntax must be valid |
| `CLEAR_INSTRUCTIONS` | Warning | Prompts should have explicit instructions section |
| `OUTPUT_FORMAT` | Warning | Prompts should specify expected output format |
| `POSITIVE_FRAMING` | Info | Instructions should tell what to do, not just forbid |
| `HAS_CONTEXT` | Info | Prompts should explain why behavior matters |
| `THINK_LANGUAGE` | Info | Avoid "think" language that triggers extended thinking issues |
| `HAS_EXAMPLES` | Info | Prompts benefit from concrete examples |

## Scoring

Each prompt receives a compliance score (0-100):

- **-20 points** per error
- **-10 points** per warning
- **-2 points** per info

A prompt **passes** if it has no errors (in normal mode) or no errors/warnings (in strict mode).

## Exit Codes

- `0` - All prompts passed
- `1` - One or more prompts failed

## Example Output

```
============================================================
PROMPT AUDIT REPORT
============================================================

Timestamp: 2026-02-01T10:30:00.000Z
Registry Version: 1.0.0

SUMMARY
----------------------------------------
Total Prompts: 15
Passed: 13
Failed: 2
Average Score: 85.3/100

Issues: 8 total
  Errors: 2
  Warnings: 3
  Info: 3

RESULTS BY PROMPT
----------------------------------------
✓ sentiment_analysis (92/100)
  Template: Hooks/SentimentAnalysis.hbs

✗ legacy_prompt (45/100)
  Template: Legacy/OldPrompt.hbs
  ❌ NO_XML_TAGS [line 15]: XML tag found: <instructions>
  ⚠️ OUTPUT_FORMAT: Prompt does not specify output format
  Recommendations:
    → No XML Tags: Prompts should use markdown headers, not XML tags
```

## Programmatic Usage

```typescript
import { runAudit, AUDIT_RULES } from '~/.claude/skills/Prompting/Tools/PromptAudit';

// Run audit
const summary = runAudit(
  false, // fast mode
  false  // strict mode
);

console.log(`Passed: ${summary.passedPrompts}/${summary.totalPrompts}`);
console.log(`Average Score: ${summary.averageScore}`);

// Check specific results
for (const result of summary.results) {
  if (!result.passed) {
    console.log(`Failed: ${result.promptId}`);
    result.issues.forEach(i => console.log(`  - ${i.message}`));
  }
}
```

## Integration with ReviewPrompts Workflow

PromptAudit is the core tool used by the ReviewPrompts workflow. The workflow provides intent-to-flag mapping:

| User Says | Flag | Effect |
|-----------|------|--------|
| "quick check" | `--fast` | Skip detailed analysis |
| (default) | (none) | Full validation |
| "strict" | `--strict` | Fail on warnings |
| "JSON output" | `--json` | Machine-readable |
| "verbose" | `--verbose` | Show all details |

## Related

- `PromptRegistry.yaml` - Central prompt inventory
- `Standards.md` - Prompt engineering best practices
- `ReviewPrompts.md` - Workflow for periodic prompt review
