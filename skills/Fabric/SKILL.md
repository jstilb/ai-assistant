---
name: Fabric
description: Intelligent prompt pattern system with 237 specialized patterns for content analysis, extraction, and transformation. USE WHEN user says 'use fabric', 'fabric pattern', 'run fabric', 'update fabric', 'update patterns', 'sync fabric', 'extract wisdom', 'summarize with fabric', 'create threat model', 'analyze with fabric', OR any request to apply Fabric patterns to content.
---
## Voice Notification

→ Use `notifySync()` from `skills/CORE/Tools/NotificationService.ts`

# Fabric

Intelligent prompt pattern system providing 237 specialized patterns for content analysis, extraction, summarization, threat modeling, and transformation.

## Fabric vs Prompting

**Fabric** = Pattern Library (consumption)
- 237 pre-built patterns for common content operations
- Use patterns as-is to transform content
- Example: `fabric extract_wisdom < article.md`

**Prompting** = Template System (creation)
- Meta-prompting for generating new prompts
- Build dynamic prompts from Handlebars templates + data
- Example: Compose agent briefings with `Primitives/Briefing.hbs`

| Need | Use |
|------|-----|
| Transform content (summarize, extract, analyze) | Fabric |
| Generate new prompts programmatically | Prompting |

**Patterns Location:** `~/.claude/skills/Fabric/Patterns/`

---

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **ExecutePattern** | "use fabric", "run pattern", "apply pattern", "extract wisdom", "summarize", "analyze with fabric" | `Workflows/ExecutePattern.md` |
| **UpdatePatterns** | "update fabric", "update patterns", "sync patterns" | `Workflows/UpdatePatterns.md` |

---

## Examples

**Example 1: Extract wisdom from content**
```
User: "Use fabric to extract wisdom from this article"
-> Invokes ExecutePattern workflow
-> Selects extract_wisdom pattern
-> Reads Patterns/extract_wisdom/system.md
-> Applies pattern to content
-> Returns structured IDEAS, INSIGHTS, QUOTES, etc.
```

**Example 2: Update patterns**
```
User: "Update fabric patterns"
-> Invokes UpdatePatterns workflow
-> Runs git pull from upstream fabric repository
-> Syncs patterns to local Patterns/ directory
-> Reports pattern count
```

**Example 3: Create threat model**
```
User: "Use fabric to create a threat model for this API"
-> Invokes ExecutePattern workflow
-> Selects create_threat_model pattern
-> Applies STRIDE methodology
-> Returns structured threat analysis
```

---

## Quick Reference

### Pattern Execution (Native - No CLI Required)

Instead of calling `fabric -p pattern_name`, Kaya executes patterns natively:
1. Reads `Patterns/{pattern_name}/system.md`
2. Applies pattern instructions directly as prompt
3. Returns results without external CLI calls

### When to Use Fabric CLI Directly

Only use `fabric` command for:
- **`-y URL`** - YouTube transcript extraction
- **`-u URL`** - URL content fetching (when native fetch fails)

### Most Common Patterns

| Intent | Pattern | Description |
|--------|---------|-------------|
| Extract insights | `extract_wisdom` | IDEAS, INSIGHTS, QUOTES, HABITS |
| Summarize | `summarize` | General summary |
| 5-sentence summary | `create_5_sentence_summary` | Ultra-concise |
| Threat model | `create_threat_model` | Security threat analysis |
| Analyze claims | `analyze_claims` | Fact-check claims |
| Improve writing | `improve_writing` | Writing enhancement |
| Code review | `review_code` | Code analysis |
| Main idea | `extract_main_idea` | Core message extraction |

### Full Pattern Catalog

See `PatternCatalog.md` for complete list of 240+ patterns organized by category.

---

## Native Pattern Execution

**How it works:**

```
User Request → Pattern Selection → Read system.md → Apply → Return Results
```

**Pattern Structure:**
```
Patterns/
├── loaded                  # Sentinel file (0-byte) - signals patterns loaded/synced
├── extract_wisdom/
│   └── system.md       # The prompt instructions
├── summarize/
│   └── system.md
├── create_threat_model/
│   └── system.md
└── ...237 patterns
```

**Sentinel File:** The `loaded` file is a 0-byte marker in the Patterns directory that signals patterns have been successfully loaded and synced from the upstream Fabric repository. Check modification time to verify last sync.

Each pattern's `system.md` contains the full prompt that defines:
- IDENTITY (who the AI should be)
- PURPOSE (what to accomplish)
- STEPS (how to process input)
- OUTPUT (structured format)

---

## Pattern Categories

| Category | Count | Examples |
|----------|-------|----------|
| **Extraction** | 30+ | extract_wisdom, extract_insights, extract_main_idea |
| **Summarization** | 20+ | summarize, create_5_sentence_summary, youtube_summary |
| **Analysis** | 35+ | analyze_claims, analyze_code, analyze_threat_report |
| **Creation** | 50+ | create_threat_model, create_prd, create_mermaid_visualization |
| **Improvement** | 10+ | improve_writing, improve_prompt, review_code |
| **Security** | 15 | create_stride_threat_model, create_sigma_rules, analyze_malware |
| **Rating** | 8 | rate_content, judge_output, rate_ai_response |

---

## Integration

### Feeds Into
- **Research** - Fabric patterns enhance research analysis
- **Blogging** - Content summarization and improvement
- **Security** - Threat modeling and analysis
- **Evals** - Arbiter patterns used as LLM rubric graders (see below)

### Uses
- **fabric CLI** - For YouTube transcripts (`-y`) and URL fetching (`-u`)
- **Native execution** - Direct pattern application (preferred)
- **Evals skill** - Patterns as grader rubrics via `fromFabricPattern()`

---

## Using Fabric Patterns with Evals

Certain Fabric patterns (especially `arbiter-*` and `judge_*`) can be used as LLM rubric graders in the Evals skill. This allows reusing proven evaluation criteria without duplication.

### Adapter Configuration

The mapping is defined in `skills/Evals/Templates/fabric-adapters.yaml`. Currently supported:

| Pattern | Evals Usage |
|---------|-------------|
| `arbiter-evaluate-quality` | Multi-axis quality scoring (clarity, completeness, accuracy) |
| `arbiter-general-evaluator` | Universal judgment for any content |
| `judge_output` | Binary good/bad assessment |
| `analyze_answers` | Grade answers against reference solutions |

### Usage in Eval Definitions

```yaml
# In your eval task definition
graders:
  - type: llm_rubric
    template: fabric:arbiter-evaluate-quality
    params:
      axes: [clarity, accuracy, completeness]
      scale: "1-10"
```

### Programmatic Usage

```typescript
import { LLMRubricGrader } from '../Evals/Graders/ModelBased/LLMRubric';

// Create grader from Fabric pattern
const grader = await LLMRubricGrader.fromFabricPattern('arbiter-evaluate-quality', {
  scale: '1-10',
});

// Use grader
const result = await grader.grade(context);
```

### Patterns NOT for Evals

These patterns serve different purposes and should NOT be used as eval graders:
- `rate_ai_response` - Human-level comparison (different scale)
- `rate_ai_result` - 4096-dimension rating (too complex)
- `rate_content` - General content quality (not agent evaluation)

See `skills/Evals/SKILL.md` for full evaluation framework documentation.

---

## File Organization

| Path | Purpose |
|------|---------|
| `~/.claude/skills/Fabric/Patterns/` | Local pattern storage (237) |
| `~/.claude/skills/Fabric/PatternCatalog.md` | Full pattern documentation |
| `~/.claude/skills/Fabric/Workflows/` | Execution workflows |

---

## Changelog

### 2026-02-01
- Fixed missing UpdatePatterns workflow (now implemented)
- Created PatternCatalog.md with categorized pattern reference
- Removed non-existent Tools/ directory reference
- Added Fabric vs Prompting differentiation section
- Updated pattern count to 237 (accurate count)

### 2026-01-18
- Initial skill creation (extracted from CORE/Tools/fabric)
- Native pattern execution (no CLI dependency for most patterns)
- Two workflows: ExecutePattern, UpdatePatterns
- 237 patterns organized by category
- Kaya Pack ready structure
