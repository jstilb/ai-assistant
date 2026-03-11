# Ideas & Future Improvements

> Capture ideas for enhancing this skill. Review during maintenance cycles.

## Implemented (2026-02-01)

### Central Prompt Management System
- [x] Created PromptRegistry.yaml - Central prompt inventory with 20+ registered prompts
- [x] Created PromptLoader.ts - Load prompts by registry ID with data injection
- [x] Created PromptAudit.ts - Validate prompts against Standards.md
- [x] Created ReviewPrompts.md workflow - Systematic prompt review process

### Skill-Specific Templates
- [x] Created Templates/Hooks/ with SentimentAnalysis.hbs and TabTitleGeneration.hbs
- [x] Created Templates/Agents/ with AgentContext.hbs and Orchestration.hbs
- [x] Created Templates/Research/ with QueryDecomposition.hbs and Synthesis.hbs
- [x] Created Templates/Data/AgentContextData/ with ClaudeResearcher.yaml and GeminiResearcher.yaml

### Documentation
- [x] Updated SKILL.md with Output Configuration, updated Workflow Routing, and Examples sections
- [x] Created PromptLoader.help.md and PromptAudit.help.md companion files
- [x] Added Prompting vs Fabric differentiation table

## Proposed Enhancements

### Hook Prompt Migration
- [x] Migrate ImplicitSentimentCapture.hook.ts to use PromptLoader with sentiment_analysis template
- [x] Migrate UpdateTabTitle.hook.ts to use PromptLoader with tab_title template
- [x] Update hooks to dynamically load prompts rather than inline strings

### Agent Orchestrator Integration
- [ ] Update lib/core/AgentOrchestrator.ts to use Agents/Orchestration.hbs template
- [ ] Add spotcheck-specific template variation
- [ ] Integrate with AgentContextData YAML files for researcher agents

### Template Versioning
- [ ] Add A/B testing support using TemplateRegistry.yaml ab_tests section
- [ ] Track template performance scores from eval results
- [ ] Implement automatic rollback for underperforming templates

### Research Integration
- [ ] Integrate QueryDecomposition.hbs with Research skill workflows
- [ ] Integrate Synthesis.hbs with ClaudeResearcher, GeminiResearcher, GrokResearcher

## Integration Opportunities

### Fabric Pattern Integration (2026-01-30)
- [ ] Add `analyze_claims` to validate prompt claims match actual capabilities and best practices
- [ ] Add `rate_ai_result` to rate quality of rendered templates and identify improvement opportunities
- [ ] Add `summarize_paper` to summarize latest prompt engineering research papers into actionable standards

### Evals Integration (2026-02-01)
- [ ] Register all eval templates in PromptRegistry.yaml
- [ ] Update Graders to load prompts via PromptLoader
- [ ] Add performance tracking for eval templates

### Agents Integration (2026-02-01)
- [ ] Agent context files generated from Prompting/Templates/Agents/AgentContext.hbs
- [ ] Data stored in Prompting/Templates/Data/AgentContextData/*.yaml
- [x] AgentFactory.ts updated to use shared Handlebars helpers from Prompting

## User Feedback

<!-- Notes from actual usage that suggest improvements -->

## Technical Debt

- [x] Remove deprecated TemplateRegistry.yaml (now replaced by PromptRegistry.yaml)
- [x] Consolidate duplicate helper registration between RenderTemplate.ts and PromptLoader.ts
- [ ] Add unit tests for PromptLoader and PromptAudit

---
*Last reviewed: 2026-02-06*

---

## SkillInvoker Integration (2026-02-02)

### Fabric Patterns
- **Priority:** MEDIUM
- **Patterns:** analyze_claims
- **Use Case:** Prompt quality analysis - validate that prompt templates make accurate claims and follow best practices

### Prompting Templates
- **Priority:** N/A
- **Primitives:** Self-reference not applicable
- **Use Case:** This IS the Prompting skill - templates are native, not invoked
