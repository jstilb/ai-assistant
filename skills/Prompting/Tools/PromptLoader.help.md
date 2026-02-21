# PromptLoader

Load prompts by registry ID with data injection.

## Overview

PromptLoader is the central interface for loading managed prompts from the PromptRegistry. It supports both CLI usage and programmatic imports, enabling prompts to be loaded by a simple ID rather than navigating the template directory structure.

## Usage

```bash
# Load a prompt by ID
bun PromptLoader.ts --prompt <registry_id> [options]

# List available prompts
bun PromptLoader.ts --list

# List prompts by category
bun PromptLoader.ts --list-categories
```

## Options

| Flag | Short | Description |
|------|-------|-------------|
| `--prompt <id>` | `-p` | Prompt registry ID (e.g., `sentiment_analysis`) |
| `--data <path>` | `-d` | Path to data file (YAML or JSON) |
| `--validate` | `-v` | Validate that all required data fields are present |
| `--list` | `-l` | List all available prompts |
| `--list-categories` | | List prompts organized by category |
| `--json` | `-j` | Output as JSON (includes metadata) |
| `--help` | `-h` | Show help |

## Examples

### Load sentiment analysis prompt with context

```bash
bun PromptLoader.ts -p sentiment_analysis -d ./context.yaml
```

### Load tab title prompt (no data needed)

```bash
bun PromptLoader.ts -p tab_title
```

### Load with validation

```bash
bun PromptLoader.ts -p agent_context -d ./agent.json --validate
```

### Output as JSON with metadata

```bash
bun PromptLoader.ts -p sentiment_analysis -d ./ctx.yaml --json
```

### List all available prompts

```bash
bun PromptLoader.ts --list
```

## Programmatic Usage

```typescript
import { loadPrompt, loadPromptSync, listPrompts } from '~/.claude/skills/Prompting/Tools/PromptLoader';

// Async loading with inline data
const result = await loadPrompt({
  promptId: 'sentiment_analysis',
  data: {
    principal: { name: 'User' },
    assistant: { name: 'Kaya' }
  }
});

console.log(result.content);       // Rendered prompt
console.log(result.meta.model_hint); // 'fast'

// Sync loading with data file
const prompt = loadPromptSync({
  promptId: 'agent_context',
  dataPath: './agent-data.yaml',
  validate: true
});

// List available prompts
const prompts = listPrompts();
// [{ id: 'sentiment_analysis', description: '...', model_hint: 'fast' }, ...]
```

## Data Files

Data files can be YAML or JSON:

```yaml
# context.yaml
principal:
  name: User
assistant:
  name: Kaya
include_examples: true
examples:
  - input: "What the fuck?"
    output: { rating: 2, sentiment: negative }
```

```json
{
  "principal": { "name": "User" },
  "assistant": { "name": "Kaya" }
}
```

## Validation

Use `--validate` to ensure all required fields are present:

```bash
bun PromptLoader.ts -p agent_context -d ./data.yaml --validate
# Error: Missing required data fields: agent.id, task.description
```

Required fields are defined in `PromptRegistry.yaml` for each prompt.

## Model Hints

Each prompt has a model hint indicating the recommended inference level:

| Hint | Model | Use Case |
|------|-------|----------|
| `fast` | Haiku | Quick, cheap operations (sentiment, classification) |
| `standard` | Sonnet | Balanced quality/speed (summaries, generation) |
| `smart` | Opus | Complex reasoning (synthesis, judging) |
| `null` | N/A | Static rendering, no inference needed |

## Related

- `PromptRegistry.yaml` - Central prompt inventory
- `RenderTemplate.ts` - Low-level template rendering
- `PromptAudit.ts` - Validate prompts against standards
