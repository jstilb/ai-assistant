# Ideas & Future Improvements

> Capture ideas for enhancing this skill. Review during maintenance cycles.

## Proposed Enhancements

- [ ] Review skill category assignments (Meta/Orchestration/Specialized) - ensure all skills are correctly categorized (source: 2026-02-01, plan implementation)
- [ ] Add interactive diagram mode - allow clicking on skill nodes to see details
- [ ] Consider automated regeneration trigger on skill/hook changes via hook
- [ ] Add diff visualization - show what changed between diagram versions

## Integration Opportunities

- [ ] Integrate with System skill integrity checks - verify diagrams match actual system state
- [ ] Add hook to auto-regenerate diagrams on significant system changes
- [ ] Consider feeding diagram data into Kaya onboarding flow

## User Feedback

<!-- Notes from actual usage that suggest improvements -->

---
*Last reviewed: 2026-02-01*

---

## SkillInvoker Integration (2026-02-02)

### Fabric Patterns
- **Priority:** LOW
- **Patterns:** extract_main_idea
- **Use Case:** System description extraction - distill core purpose from skill/component documentation before diagramming

### Prompting Templates
- **Priority:** MEDIUM
- **Primitives:** Structure
- **Use Case:** Diagram generation templates - standardized prompts for consistent mermaid diagram output formatting
