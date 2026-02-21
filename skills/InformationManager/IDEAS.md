# Ideas & Future Improvements

> Capture ideas for enhancing this skill. Review during maintenance cycles.

## Proposed Enhancements

<!-- Add ideas below. Format: - [ ] Idea description (source: session/date/context) -->

## Integration Opportunities

### Fabric Pattern Integration (2026-01-30)
- [ ] Add `extract_wisdom` to process Obsidian notes and surface key ideas, patterns, and learnings
- [ ] Add `create_ai_context` to generate AI-optimized context summaries for agent consumption
- [ ] Add `create_report_finding` to document all available context sources and their contents in structured format
- [ ] Add `analyze_claims` + `extract_main_idea` to identify missing context areas and recommend knowledge to gather

### Agent-Based Gathering (2026-02-01)
- [ ] Parallel agent gathering for each source type
- [ ] Intelligent aggregation strategies (merge, synthesis, voting)
- [ ] Source-specific agents with domain expertise

### Context Feeding (2026-02-01)
- [ ] Direct context injection to AI sessions via hooks
- [ ] Format options: markdown, JSON, structured
- [ ] Output modes: stdout (for hooks), clipboard, file

## User Feedback

<!-- Notes from actual usage that suggest improvements -->

---
*Last reviewed: 2026-02-01*

---

## SkillInvoker Integration (2026-02-02)

### Fabric Patterns
- **Priority:** HIGH
- **Patterns:** summarize, extract_main_idea
- **Use Case:** Context summarization - distill gathered context from multiple sources into AI-optimized summaries for session injection

### Prompting Templates
- **Priority:** HIGH
- **Primitives:** Briefing, Structure, Gate
- **Use Case:** MasterContext layout composition - structure multi-source context with quality gates for determining what context to include and how to format it
