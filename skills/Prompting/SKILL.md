---
name: Prompting
description: Meta-prompting system for dynamic prompt generation using templates, standards, and patterns. USE WHEN meta-prompting, template generation, prompt optimization, or programmatic prompt composition.
---
# Prompting - Central Prompt Management System

**Invoke when:** meta-prompting, template generation, prompt optimization, programmatic prompt composition, creating dynamic agents, generating structured prompts from data, prompt review/audit.

## Overview

The Prompting skill is Kaya's **central prompt management system**, owning ALL prompt engineering concerns:
- **Registry** - Central inventory of all managed prompts (PromptRegistry.yaml)
- **Standards** - Anthropic best practices, Claude 4.x patterns, empirical research
- **Templates** - Handlebars-based system for programmatic prompt generation
- **Tools** - Template rendering, validation, loading, and audit utilities
- **Patterns** - Reusable prompt primitives and structures

This is the "standard library" for prompt engineering - other skills reference these resources when they need to generate or optimize prompts.

### Key Differentiation: Prompting vs Fabric

| Aspect | Fabric | Prompting |
|--------|--------|-----------|
| **Purpose** | Pattern Library (Consumption) | Template System (Creation) |
| **What it does** | Apply 239 pre-built patterns to content | Generate prompts from templates + data |
| **Analogy** | Unix commands (grep, sed) | Shell scripting |
| **File format** | Static `system.md` files | Parameterized `.hbs` templates |
| **User action** | "Summarize this with fabric" | "Build a prompt for this agent" |

## Voice Notification

Use `notifySync()` from `skills/CORE/Tools/NotificationService.ts`

## Workflow Routing

| Trigger | Description | Location |
|---------|-------------|----------|
| VALIDATEPROMPT | Lint prompts against Claude 4.x best practices with actionable fixes | `Workflows/ValidatePrompt.md` |
| REVIEWPROMPTS | Audit all registered prompts against Standards.md | `Workflows/ReviewPrompts.md` |

## Output Configuration

**Default path:** `~/.claude/MEMORY/Prompting/[YYYY-MM-DD]/`

Use `resolveOutputPath()` from `skills/CORE/Tools/OutputPathResolver.ts`:

```typescript
import { resolveOutputPath, ensureOutputDir } from '~/.claude/skills/CORE/Tools/OutputPathResolver';

const { path } = await resolveOutputPath({
  skill: 'Prompting',
  title: 'prompt-audit-report'
});
ensureOutputDir(path);
await Bun.write(path, content);
```

## Core Components

### 1. PromptRegistry.yaml - Central Prompt Inventory

The registry is the single source of truth for all managed prompts:

```yaml
prompts:
  sentiment_analysis:
    template: Hooks/SentimentAnalysis.hbs
    version: "1.0.0"
    used_by: ["hooks/ImplicitSentimentCapture.hook.ts"]
    model_hint: fast  # Haiku
  tab_title:
    template: Hooks/TabTitleGeneration.hbs
    model_hint: standard  # Sonnet
```

**Model Hints:**
- `fast` - Haiku (quick, cheap operations)
- `standard` - Sonnet (balanced quality/speed)
- `smart` - Opus (complex reasoning)
- `null` - Static rendering, no inference

### 2. Standards.md

Complete prompt engineering documentation based on:
- Anthropic's Claude 4.x Best Practices (November 2025)
- Context engineering principles
- The Fabric prompt pattern system
- 1,500+ academic papers on prompt optimization

**Key Topics:**
- Markdown-first design (NO XML tags)
- Claude 4.x behavioral characteristics
- Multi-context window workflows
- Agentic coding best practices
- Output format control
- The Ultimate Prompt Template

### 3. Templates/ - Organized by Domain

**Directory Structure:**
```
Templates/
├── PromptRegistry.yaml   # Central prompt inventory
├── Primitives/           # Five core template patterns
│   ├── Roster.hbs        # Agent/skill definitions from data
│   ├── Voice.hbs         # Personality calibration settings
│   ├── Structure.hbs     # Multi-step workflow patterns
│   ├── Briefing.hbs      # Agent context handoff
│   └── Gate.hbs          # Validation checklists
├── Hooks/                # Hook-specific templates
│   ├── SentimentAnalysis.hbs
│   └── TabTitleGeneration.hbs
├── Agents/               # Agent context templates
│   ├── AgentContext.hbs
│   └── Orchestration.hbs
├── Research/             # Research workflow templates
│   ├── QueryDecomposition.hbs
│   └── Synthesis.hbs
├── Evals/                # Evaluation templates
├── Decorators/           # Output modifiers
└── Data/                 # Template data files
    └── AgentContextData/ # Agent-specific context data
```

**The Five Primitives:**

| Primitive | Purpose | Use Case |
|-----------|---------|----------|
| **ROSTER** | Data-driven definitions | 32 RedTeam agents, 83 skills, voice configs |
| **VOICE** | Personality calibration | Voice parameters, rate, archetype mapping |
| **STRUCTURE** | Workflow patterns | Phased analysis, round-based debate, pipelines |
| **BRIEFING** | Agent context handoff | Research queries, delegation, task assignment |
| **GATE** | Validation checklists | Quality gates, completion checks, verification |

### 4. Tools/

**PromptLoader.ts** - Load prompts by registry ID
```bash
# Load by ID
bun PromptLoader.ts --prompt sentiment_analysis --data ./context.yaml

# List available prompts
bun PromptLoader.ts --list

# Output with metadata
bun PromptLoader.ts -p tab_title --json
```

**PromptAudit.ts** - Validate prompts against standards
```bash
# Full audit
bun PromptAudit.ts

# Quick check
bun PromptAudit.ts --fast

# Strict mode
bun PromptAudit.ts --strict --json
```

**RenderTemplate.ts** - Core rendering engine
```bash
bun RenderTemplate.ts --template Primitives/Briefing.hbs --data path/to/data.yaml
```

**ValidateTemplate.ts** - Template syntax checker
```bash
bun ValidateTemplate.ts --template Primitives/Briefing.hbs --data path/to/sample-data.yaml
```

### 5. Template Syntax

The system uses Handlebars notation (Anthropic's official syntax):

| Syntax | Purpose | Example |
|--------|---------|---------|
| `{{variable}}` | Simple interpolation | `Hello {{name}}` |
| `{{object.property}}` | Nested access | `{{agent.voice_id}}` |
| `{{#each items}}...{{/each}}` | Iteration | List generation |
| `{{#if condition}}...{{/if}}` | Conditional | Optional sections |
| `{{> partial}}` | Include partial | Reusable components |
| `{{default value fallback}}` | Default values | `{{default name "Unknown"}}` |
| `{{json obj}}` | JSON stringify | `{{json output}}` |

## Examples

### Example 1: Load a registered prompt

```typescript
import { loadPrompt } from '~/.claude/skills/Prompting/Tools/PromptLoader';

// Load sentiment analysis prompt with context
const result = await loadPrompt({
  promptId: 'sentiment_analysis',
  data: {
    principal: { name: 'User' },
    assistant: { name: 'Kaya' }
  }
});

console.log(result.content);        // Rendered prompt
console.log(result.meta.model_hint); // 'fast'
```

### Example 2: Audit all prompts

```bash
# Run prompt audit
bun ~/.claude/skills/Prompting/Tools/PromptAudit.ts --verbose

# Output:
# ============================================================
# PROMPT AUDIT REPORT
# ============================================================
# Total Prompts: 20
# Passed: 18
# Failed: 2
# Average Score: 87.5/100
```

### Example 3: Using Briefing Template (Agent Skill)

```typescript
import { renderTemplate } from '~/.claude/skills/Prompting/Tools/RenderTemplate.ts';

const prompt = renderTemplate('Primitives/Briefing.hbs', {
  briefing: { type: 'research' },
  agent: { id: 'EN-1', name: 'Skeptical Thinker', personality: {...} },
  task: { description: 'Analyze security architecture', questions: [...] },
  output_format: { type: 'markdown' }
});
```

### Example 4: Using Structure Template (Workflow)

```yaml
# Data: phased-analysis.yaml
phases:
  - name: Discovery
    purpose: Identify attack surface
    steps:
      - action: Map entry points
        instructions: List all external interfaces...
  - name: Analysis
    purpose: Assess vulnerabilities
    steps:
      - action: Test boundaries
        instructions: Probe each entry point...
```

```bash
bun RenderTemplate.ts --template Primitives/Structure.hbs --data phased-analysis.yaml
```

## Integration with Other Skills

### Hooks
- `ImplicitSentimentCapture.hook.ts` uses `sentiment_analysis` prompt
- `UpdateTabTitle.hook.ts` uses `tab_title` prompt

### Agents Skill
- Uses `Templates/Agents/AgentContext.hbs` for agent briefings
- Uses `Templates/Data/AgentContextData/*.yaml` for agent data
- Uses `RenderTemplate.ts` to compose dynamic agents

### Evals Skill
- Uses eval-specific templates: Judge, Rubric, TestCase, Comparison, Report
- Leverages `RenderTemplate.ts` for eval prompt generation

### Development Skill
- References `Standards.md` for prompt best practices
- Uses `Structure.hbs` for workflow patterns
- Applies `Gate.hbs` for validation checklists

## Token Efficiency

The templating system eliminated **~35,000 tokens (65% reduction)** across Kaya:

| Area | Before | After | Savings |
|------|--------|-------|---------|
| SKILL.md Frontmatter | 20,750 | 8,300 | 60% |
| Agent Briefings | 6,400 | 1,900 | 70% |
| Voice Notifications | 6,225 | 725 | 88% |
| Workflow Steps | 7,500 | 3,000 | 60% |
| **TOTAL** | ~53,000 | ~18,000 | **65%** |

## Best Practices

### 1. Separation of Concerns
- **Templates**: Structure and formatting only
- **Data**: Content and parameters (YAML/JSON)
- **Logic**: Rendering and validation (TypeScript)

### 2. Keep Templates Simple
- Avoid complex logic in templates
- Use Handlebars helpers for transformations
- Business logic belongs in TypeScript, not templates

### 3. DRY Principle
- Extract repeated patterns into partials
- Use presets for common configurations
- Single source of truth for definitions

### 4. Version Control
- Templates and data in separate files
- Track changes independently
- Enable A/B testing of structures

### 5. Use the Registry
- Always register new prompts in PromptRegistry.yaml
- Load prompts by ID, not by file path
- Include model hints for appropriate inference level

## References

**Primary Documentation:**
- `Standards.md` - Complete prompt engineering guide
- `Templates/PromptRegistry.yaml` - Central prompt inventory
- `Tools/PromptLoader.ts` - Load prompts by registry ID
- `Tools/PromptAudit.ts` - Validate against standards

**Research Foundation:**
- Anthropic: "Claude 4.x Best Practices" (November 2025)
- Anthropic: "Effective Context Engineering for AI Agents"
- Anthropic: "Prompt Templates and Variables"
- The Fabric System (January 2024)
- "The Prompt Report" - arXiv:2406.06608
- "The Prompt Canvas" - arXiv:2412.05127

**Related Skills:**
- Agents - Dynamic agent composition
- Evals - LLM-as-Judge prompting
- Development - Spec-driven development patterns
- Fabric - Pattern library for content transformation

---

**Philosophy:** Prompts that write prompts. Structure is code, content is data. Meta-prompting enables dynamic composition where the same template with different data generates specialized agents, workflows, and evaluation frameworks. This is core Kaya DNA - programmatic prompt generation at scale.
