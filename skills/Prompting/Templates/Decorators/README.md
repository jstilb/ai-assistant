# Prompt Decorators

**Version:** 1.0.0
**Research Foundation:** arXiv:2510.19850v1 - Prompt Decorators Pattern

## Overview

Decorators are **stackable directives** that modify HOW an LLM reasons, structures, or expresses responses WITHOUT changing the task itself. They are:
- **Modular** - Each decorator is independent
- **Composable** - Stack multiple decorators together
- **Orthogonal** - Reasoning, tone, and format are independent dimensions

Think of decorators like CSS for prompts - they control presentation and structure while the task content remains the core.

---

## The Three Decorator Types

### 1. Reasoning Decorators (`Reasoning.hbs`)

**Purpose:** Modify HOW the LLM thinks about the problem

| Style | What It Does | When to Use |
|-------|-------------|-------------|
| `step-by-step` | Break analysis into numbered steps | Complex problems requiring methodical thinking |
| `pros-cons` | List advantages/disadvantages before concluding | Decision-making, trade-off analysis |
| `devil-advocate` | Argue against initial conclusion first | Testing robustness of reasoning |
| `first-principles` | Decompose to fundamental truths, build up | Novel problems, questioning assumptions |
| `hypothesis-driven` | State hypothesis, test against evidence | Scientific analysis, data-driven conclusions |

### 2. Tone Decorators (`Tone.hbs`)

**Purpose:** Modify HOW the LLM expresses itself

| Modifier | What It Does | When to Use |
|----------|-------------|-------------|
| `concise` | Maximum information density, minimal words | Quick reads, tight constraints |
| `explanatory` | Teach concepts, assume no prior knowledge | Documentation, learning materials |
| `executive` | Bottom-line-up-front, key metrics, decisions | Executive summaries, busy stakeholders |
| `technical` | Precise terminology, implementation details | Engineering docs, technical audiences |
| `conversational` | Natural, approachable, friendly | User-facing content, onboarding |

### 3. Format Decorators (`Format.hbs`)

**Purpose:** Modify HOW the output is structured

| Output | What It Does | When to Use |
|--------|-------------|-------------|
| `structured` | Consistent headers, sections, markdown | Reference docs, scannability |
| `narrative` | Flowing prose without lists | Blog posts, explanations, storytelling |
| `checklist` | Actionable items with checkboxes | Project plans, implementation guides |
| `comparison` | Side-by-side analysis format | Evaluating options, A/B comparisons |

---

## Basic Usage

### Single Decorator

Apply one decorator to modify a single dimension:

```handlebars
{{> Decorators/Reasoning style="step-by-step"}}

## Your Task
Analyze the security implications of this API design.
```

### Stacking Decorators

Combine multiple decorators for precise control:

```handlebars
{{> Decorators/Reasoning style="pros-cons"}}
{{> Decorators/Tone modifier="executive"}}
{{> Decorators/Format output="structured"}}

## Your Task
Should we migrate to microservices architecture?
```

This produces:
- **Reasoning:** Analyze pros and cons before concluding
- **Tone:** Bottom-line-up-front, decision-focused
- **Format:** Organized sections with clear headers

---

## Composition Examples

### Example 1: Technical Deep Dive

**Use Case:** Explaining complex algorithm to engineers

```handlebars
{{> Decorators/Reasoning style="first-principles"}}
{{> Decorators/Tone modifier="technical"}}
{{> Decorators/Format output="structured"}}

## Your Task
Explain how the Raft consensus algorithm works.
```

**Effect:**
- Reasoning from fundamental distributed systems concepts
- Precise technical terminology
- Clear sections for scanning

### Example 2: Executive Decision Brief

**Use Case:** Presenting recommendation to leadership

```handlebars
{{> Decorators/Reasoning style="hypothesis-driven"}}
{{> Decorators/Tone modifier="executive"}}
{{> Decorators/Format output="structured"}}

## Your Task
Recommend whether to build vs buy for customer analytics.
```

**Effect:**
- States hypothesis, tests with evidence
- Key metrics and decision points highlighted
- Bottom-line-up-front organization

### Example 3: Educational Content

**Use Case:** Teaching concept to beginners

```handlebars
{{> Decorators/Reasoning style="step-by-step"}}
{{> Decorators/Tone modifier="explanatory"}}
{{> Decorators/Format output="narrative"}}

## Your Task
Explain how OAuth 2.0 authentication works.
```

**Effect:**
- Methodical step-by-step breakdown
- Teaches concepts, defines terms
- Flowing prose for readability

### Example 4: Implementation Plan

**Use Case:** Creating actionable project plan

```handlebars
{{> Decorators/Reasoning style="step-by-step"}}
{{> Decorators/Tone modifier="technical"}}
{{> Decorators/Format output="checklist"}}

## Your Task
Create an implementation plan for API rate limiting.
```

**Effect:**
- Logical step-by-step approach
- Precise technical specifications
- Checkbox items for tracking progress

### Example 5: Technology Comparison

**Use Case:** Evaluating competing options

```handlebars
{{> Decorators/Reasoning style="pros-cons"}}
{{> Decorators/Tone modifier="conversational"}}
{{> Decorators/Format output="comparison"}}

## Your Task
Compare React vs Vue for our frontend framework choice.
```

**Effect:**
- Systematic pros/cons analysis
- Approachable, friendly explanation
- Side-by-side comparison format

---

## Advanced Patterns

### Context-Dependent Decoration

Use conditionals to apply decorators based on context:

```handlebars
{{#if audience_is_technical}}
  {{> Decorators/Tone modifier="technical"}}
{{else}}
  {{> Decorators/Tone modifier="explanatory"}}
{{/if}}

{{> Decorators/Format output="structured"}}

## Your Task
{{task_description}}
```

### Workflow-Specific Presets

Create reusable combinations for common workflows:

**Security Review Preset:**
```handlebars
{{!-- Security reviews need adversarial thinking and structured output --}}
{{> Decorators/Reasoning style="devil-advocate"}}
{{> Decorators/Tone modifier="technical"}}
{{> Decorators/Format output="checklist"}}
```

**Research Summary Preset:**
```handlebars
{{!-- Research needs hypothesis testing and evidence-based conclusions --}}
{{> Decorators/Reasoning style="hypothesis-driven"}}
{{> Decorators/Tone modifier="explanatory"}}
{{> Decorators/Format output="structured"}}
```

**Product Requirements Preset:**
```handlebars
{{!-- PRDs need clarity, user focus, and actionable structure --}}
{{> Decorators/Reasoning style="step-by-step"}}
{{> Decorators/Tone modifier="executive"}}
{{> Decorators/Format output="checklist"}}
```

---

## Design Principles

### 1. Orthogonality

Reasoning, tone, and format are independent dimensions. You can combine ANY reasoning style with ANY tone and ANY format:

```
Reasoning × Tone × Format = 5 × 5 × 4 = 100 possible combinations
```

### 2. Composability

Decorators stack cleanly without conflicts. Order doesn't matter (though convention is: Reasoning → Tone → Format):

```handlebars
{{!-- These produce identical results --}}
{{> Decorators/Tone modifier="executive"}}
{{> Decorators/Format output="structured"}}

{{> Decorators/Format output="structured"}}
{{> Decorators/Tone modifier="executive"}}
```

### 3. Task Independence

Decorators modify behavior WITHOUT knowing task content. The same decorator works across domains:

```handlebars
{{> Decorators/Reasoning style="pros-cons"}}

## Your Task
Should we hire a new engineer? {{!-- HR decision --}}
```

```handlebars
{{> Decorators/Reasoning style="pros-cons"}}

## Your Task
Should we cache this API response? {{!-- Technical decision --}}
```

### 4. Claude 4.x Optimized

All decorators follow Claude 4.x Standards:
- ✅ Positive framing ("do X" not "don't do Y")
- ✅ Soft language (no "MUST" or "CRITICAL" unless truly necessary)
- ✅ Markdown-only structure
- ✅ Context and motivation included

---

## Rendering Decorators

### CLI Usage

```bash
# Create a decorated prompt
bun run ~/.claude/skills/Prompting/Tools/RenderTemplate.ts \
  --template Decorators/Reasoning.hbs \
  --data '{"style":"step-by-step"}' \
  --preview
```

### Programmatic Usage

```typescript
import { renderTemplate } from '~/.claude/skills/Prompting/Tools/RenderTemplate.ts';

const decoratedPrompt = `
${renderTemplate('Decorators/Reasoning.hbs', { style: 'pros-cons' })}
${renderTemplate('Decorators/Tone.hbs', { modifier: 'executive' })}
${renderTemplate('Decorators/Format.hbs', { output: 'structured' })}

## Your Task
${taskDescription}
`;
```

### Inline in Templates

Use partials for composition:

```handlebars
{{!-- MyTemplate.hbs --}}
{{> Decorators/Reasoning style=reasoning_style}}
{{> Decorators/Tone modifier=tone_preference}}
{{> Decorators/Format output=format_type}}

## Your Task
{{task_description}}

## Context
{{context}}
```

---

## Validation

Test decorator combinations to ensure they compose cleanly:

```bash
bun run ~/.claude/skills/Prompting/Tools/ValidateTemplate.ts \
  --template Decorators/Reasoning.hbs \
  --data '{"style":"step-by-step"}'
```

---

## Research Foundation

**Prompt Decorators** (arXiv:2510.19850v1)

Key findings:
- Decorators enable modular prompt composition
- Orthogonal dimensions (reasoning/tone/format) are independent
- Composability reduces prompt engineering complexity
- Task-agnostic decorators work across domains

**Claude 4.x Best Practices** (Anthropic, November 2025)
- Positive framing improves compliance
- Soft tool language reduces overtriggering
- Markdown structure provides semantic clarity
- Examples must exactly match desired outcomes

---

## Migration Guide

### From Monolithic Prompts

**Before:**
```
Analyze the security of this API. Think step by step.
Explain things clearly for non-technical stakeholders.
Use headers and bullet points to organize your response.
```

**After:**
```handlebars
{{> Decorators/Reasoning style="step-by-step"}}
{{> Decorators/Tone modifier="explanatory"}}
{{> Decorators/Format output="structured"}}

## Your Task
Analyze the security of this API.
```

### From Skill-Specific Instructions

Many skills duplicate reasoning/tone/format instructions. Extract these into decorators:

**Before** (in skill SKILL.md):
```markdown
When analyzing security issues, consider pros and cons before
concluding. Write in technical language with precise terminology.
Organize output into clear sections.
```

**After** (skill calls decorator):
```handlebars
{{> Decorators/Reasoning style="pros-cons"}}
{{> Decorators/Tone modifier="technical"}}
{{> Decorators/Format output="structured"}}
```

---

## Best Practices

### 1. Choose Decorators Based on Audience

| Audience | Reasoning | Tone | Format |
|----------|-----------|------|--------|
| Engineers | `first-principles` | `technical` | `structured` |
| Executives | `pros-cons` | `executive` | `structured` |
| New Users | `step-by-step` | `explanatory` | `narrative` |
| Project Managers | `hypothesis-driven` | `conversational` | `checklist` |

### 2. Match Format to Medium

- **Docs/Reference:** `structured` format
- **Blog/Tutorial:** `narrative` format
- **Project Plans:** `checklist` format
- **Decision Papers:** `comparison` format

### 3. Stack Sparingly

More decorators ≠ better. Usually 1-3 decorators is optimal:
- **Minimum:** Format only (if reasoning and tone are obvious)
- **Common:** Reasoning + Format
- **Maximum:** Reasoning + Tone + Format

### 4. Test Combinations

Not all combinations work equally well. Test your stack:
```handlebars
{{!-- This might create tension --}}
{{> Decorators/Tone modifier="concise"}}
{{> Decorators/Tone modifier="explanatory"}}  {{!-- Contradictory! --}}
```

### 5. Document Your Presets

If you use certain combinations frequently, document them as presets (see Advanced Patterns above).

---

## Troubleshooting

### Decorators Not Applied

**Problem:** Output doesn't reflect decorator instructions

**Solution:** Check partial include path and data passed:
```handlebars
{{!-- Correct --}}
{{> Decorators/Reasoning style="step-by-step"}}

{{!-- Incorrect (missing path) --}}
{{> Reasoning style="step-by-step"}}
```

### Contradictory Decorators

**Problem:** Conflicting instructions (e.g., concise + explanatory)

**Solution:** Choose one tone decorator per prompt. Use conditional logic if needed:
```handlebars
{{#if audience_expert}}
  {{> Decorators/Tone modifier="concise"}}
{{else}}
  {{> Decorators/Tone modifier="explanatory"}}
{{/if}}
```

### Decorator Ignored

**Problem:** LLM doesn't follow decorator guidance

**Solution:** Decorators are guidance, not guarantees. If critical, move instruction into task itself:
```handlebars
{{> Decorators/Format output="checklist"}}

## Your Task
Create an implementation checklist (use - [ ] format) for...
```

---

## Related Documentation

- `~/.claude/skills/Prompting/SKILL.md` - Meta-prompting system overview
- `~/.claude/skills/Prompting/Standards.md` - Claude 4.x best practices
- `~/.claude/skills/Prompting/Templates/README.md` - Core templating system
- `~/.claude/skills/Prompting/Templates/Primitives/` - Five core primitives

---

## Future Enhancements

Potential decorator additions:
- **Depth Decorators:** `shallow`, `moderate`, `deep` (control analysis depth)
- **Perspective Decorators:** `optimistic`, `skeptical`, `neutral` (bias the viewpoint)
- **Audience Decorators:** `beginner`, `intermediate`, `expert` (calibrate complexity)
- **Constraint Decorators:** `time-limited`, `resource-constrained` (modify constraints)

---

**Philosophy:** Decorators separate WHAT (the task) from HOW (the approach). This modularity enables systematic experimentation with reasoning styles, tones, and formats without rewriting entire prompts. Meta-prompting at its finest.
