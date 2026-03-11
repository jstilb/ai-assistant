# Ideas & Future Improvements

> Capture ideas for enhancing this skill. Review during maintenance cycles.

## Proposed Enhancements

- [ ] **Pattern Categories Directory Structure** - Reorganize `Patterns/` with subdirectories by category (extraction/, analysis/, creation/, etc.) for better organization
- [ ] **Pattern Chaining** - Compose multiple patterns in sequence (e.g., `extract_wisdom` -> `summarize` -> `create_flash_cards`)
- [ ] **Custom Patterns** - Support user-defined custom patterns directory
- [ ] **Pattern Search** - Fuzzy search for patterns by description/purpose, not just name
- [ ] **Pattern Usage Stats** - Track which patterns are used most frequently for optimization

## Integration Opportunities

- [ ] **Prompting Skill Integration** - Consider if Fabric patterns could use Prompting templates for customization of output format
- [ ] **Research Skill** - Fabric patterns already enhance research; formalize the integration points
- [ ] **Evals Skill** - Use Fabric patterns for eval grading (e.g., `rate_ai_response`, `judge_output`)
- [ ] **Blog Skill** - Integrate `improve_writing`, `enrich_blog_post` into blogging workflow

## Fabric vs Prompting Clarification

**Fabric** = Pattern Library (consumption)
- 239 pre-built patterns for common content operations
- Use patterns as-is to transform content
- Analogous to Unix commands (`grep`, `sed`, `awk`)

**Prompting** = Template System (creation)
- Meta-prompting for generating new prompts
- Build dynamic prompts from Handlebars templates + data
- Analogous to shell scripting

**When to use which:**
| Need | Use |
|------|-----|
| "Summarize this article" | Fabric (`summarize`) |
| "Extract wisdom from video" | Fabric (`extract_wisdom`) |
| "Generate a briefing prompt for an agent" | Prompting (Briefing.hbs) |
| "Create a custom eval grader prompt" | Prompting (templates) |

## User Feedback

<!-- Notes from actual usage that suggest improvements -->

---
*Last reviewed: 2026-02-01*

---

## SkillInvoker Integration (2026-02-02)

### Fabric Patterns
- **Priority:** N/A
- **Patterns:** Self-reference not applicable
- **Use Case:** This IS the Fabric skill - patterns are native, not invoked

### Prompting Templates
- **Priority:** MEDIUM
- **Primitives:** Structure
- **Use Case:** Pattern execution workflow templates - standardized prompts for consistent pattern input/output formatting and chaining
