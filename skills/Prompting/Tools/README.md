# Prompting Tools

TypeScript utilities for template rendering, validation, and prompt quality checking.

## Tools

### ValidatePrompt.ts - Prompt Quality Linter

Validates prompts against Claude 4.x best practices from Standards.md. Detects anti-patterns and provides actionable suggestions.

**Usage:**
```bash
# Validate a file
bun run ValidatePrompt.ts --file path/to/prompt.md

# Validate inline text
bun run ValidatePrompt.ts --text "Your prompt text here"

# Validate from stdin
cat prompt.md | bun run ValidatePrompt.ts

# Show fix suggestions
bun run ValidatePrompt.ts --file path/to/prompt.md --fix

# Strict mode (fail on warnings)
bun run ValidatePrompt.ts --file path/to/prompt.md --strict

# JSON output
bun run ValidatePrompt.ts --file path/to/prompt.md --json
```

**Anti-Patterns Detected:**

| Pattern | Detection | Severity | Suggestion |
|---------|-----------|----------|------------|
| XML tags in prompts | `/<[a-z]+>.*<\/[a-z]+>/i` | 🔴 ERROR | "Use markdown headers instead" |
| Aggressive tool language | `/CRITICAL.*MUST/i`, `/YOU MUST use/i` | 🔴 ERROR | "Use 'when...' framing instead" |
| "Think" with extended thinking | `/\bthink\b/i`, `/think about/i` | 🔴 ERROR | "Use 'consider', 'evaluate', 'reflect'" |
| Negative-only constraints | `/\bNEVER\b.*\./`, `/\bDON'T\b.*\.$/` | 🟡 WARNING | "Add positive alternative: what TO do" |
| Vague language | `/might want to/i`, `/could consider/i` | 🟡 WARNING | "Be direct and specific" |
| Example overload | Count examples > 3 | 🟡 WARNING | "1-3 examples optimal, diminishing returns" |
| Excessive verbosity | Long explanatory passages | 🟡 WARNING | "Prefer clear, direct language" |
| Missing output format | No "Output Format" section | 🟡 WARNING | "Add explicit output format specification" |
| Bold/italic overuse | Many **bold** or *italic* blocks | 🔵 INFO | "Use formatting sparingly" |

**Exit Codes:**
- `0`: No errors
- `1`: Errors found
- `2`: Warnings found (with --strict)

**Example Output:**
```
Validating: prompt.md

🔴 ERRORS
🔴 ERROR [line 15]: Aggressive tool language
   Found: "CRITICAL: You MUST use this tool"
   Aggressive language detected: "CRITICAL: You MUST use this tool"
   Fix: Use this tool when...

🟡 WARNINGS
🟡 WARNING [line 42]: Negative-only constraint
   Found: "NEVER use markdown"
   Negative-only constraint: "NEVER use markdown"
   Fix: Add positive alternative: what TO do instead

Summary: 1 error, 1 warning, 0 info
```

**Integration with Hooks:**

The linter can be integrated into quality hooks for real-time validation:

```typescript
// Example quality hook
import { validateText } from './ValidatePrompt.ts';

export function validatePrompt(text: string): boolean {
  const results = validateText(text);
  const errors = results.filter(r => r.severity === 'ERROR');
  return errors.length === 0;
}
```

**Performance:**
- Fast execution: <100ms for typical prompts
- Designed for pre-commit hook integration
- Support for piped input enables chaining with other tools

---

### RenderTemplate.ts - Template Rendering Engine

Renders Handlebars templates with YAML/JSON data.

**Usage:**
```bash
bun run RenderTemplate.ts \
  --template Primitives/Briefing.hbs \
  --data path/to/data.yaml \
  --output path/to/output.md
```

**Programmatic Usage:**
```typescript
import { renderTemplate } from './RenderTemplate.ts';

const output = renderTemplate('Primitives/Briefing.hbs', {
  agent: { id: 'EN-1', name: 'Skeptical Thinker' },
  briefing: { type: 'Analysis', questions: ['...'] }
});
```

---

### ValidateTemplate.ts - Template Syntax Checker

Validates template syntax and data compatibility.

**Usage:**
```bash
bun run ValidateTemplate.ts \
  --template Primitives/Briefing.hbs \
  --data path/to/sample-data.yaml
```

---

## Template System

All templates use Handlebars notation (Anthropic's official syntax):

| Syntax | Purpose | Example |
|--------|---------|---------|
| `{{variable}}` | Simple interpolation | `Hello {{name}}` |
| `{{object.property}}` | Nested access | `{{agent.voice_id}}` |
| `{{#each items}}...{{/each}}` | Iteration | List generation |
| `{{#if condition}}...{{/if}}` | Conditional | Optional sections |
| `{{> partial}}` | Include partial | Reusable components |

**Five Core Primitives:**
- **ROSTER**: Agent/skill definitions from data
- **VOICE**: Personality calibration settings
- **STRUCTURE**: Multi-step workflow patterns
- **BRIEFING**: Agent context handoff
- **GATE**: Validation checklists

---

## Standards

All validation rules are derived from `Standards.md`, which includes:
- Anthropic's Claude 4.x Best Practices (November 2025)
- Context engineering principles
- The Fabric system
- 1,500+ academic papers on prompt optimization

**Key Topics:**
- Markdown-first design (NO XML tags)
- Claude 4.x behavioral characteristics
- Multi-context window workflows
- Agentic coding best practices
- Output format control

---

## Development

**Requirements:**
- Bun runtime
- TypeScript

**Adding New Rules:**

Edit `ValidatePrompt.ts` and add to the `rules` array:

```typescript
{
  id: "rule-id",
  name: "Rule name",
  severity: "ERROR" | "WARNING" | "INFO",
  pattern: /regex/ | (text) => boolean,
  message: (match) => `Description`,
  fix: (match) => `Suggested fix`,
}
```

**Testing:**

```bash
# Test with sample prompt
echo "CRITICAL: You MUST use this tool" | bun run ValidatePrompt.ts

# Test with file
bun run ValidatePrompt.ts --file test-prompt.md --fix
```
