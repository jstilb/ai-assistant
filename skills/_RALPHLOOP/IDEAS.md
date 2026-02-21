# Ideas & Future Improvements

> Capture ideas for enhancing this skill. Review during maintenance cycles.

## Proposed Enhancements

<!-- Add ideas below. Format: - [ ] Idea description (source: session/date/context) -->

## Integration Opportunities

### Fabric Pattern Integration (2026-01-30)
- [ ] Add `create_summary` after each Ralph loop iteration - synthesize progress, blockers, and next actions
- [ ] Add `analyze_logs` to parse test/build output - identify whether metrics are converging/diverging and extract key failure patterns

## User Feedback

<!-- Notes from actual usage that suggest improvements -->

---

## SkillInvoker Integration (2026-02-02)

### Fabric Patterns
- **Priority:** MEDIUM
- **Patterns:** extract_wisdom
- **Use Case:** Iteration insights extraction - apply extract_wisdom after each Ralph loop iteration to synthesize progress patterns, recurring blockers, and convergence indicators

### Prompting Templates
- **Priority:** HIGH
- **Primitives:** Briefing, Structure, Gate
- **Use Case:** Iteration context and completion gates - Briefing provides iteration context and success criteria, Structure defines the iterate-analyze-adapt loop, Gate enforces exit conditions (tests pass, build succeeds, metrics converge)

---
*Last reviewed: Not yet reviewed*
