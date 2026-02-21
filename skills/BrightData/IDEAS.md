# Ideas & Future Improvements

> Capture ideas for enhancing this skill. Review during maintenance cycles.

## Proposed Enhancements

<!-- Add ideas below. Format: - [ ] Idea description (source: session/date/context) -->

## Integration Opportunities

### Fabric Pattern Integration (2026-01-30)
- [ ] Add `analyze_claims` + `extract_wisdom` to process web content and extract verifiable facts and actionable insights
- [ ] Add `summarize` + `create_summary` to condense multi-page web content into digestible summaries
- [ ] Add `extract_references` to transform scraped HTML/text into structured markdown with key information highlighted
- [ ] Add `create_report_finding` to convert raw scraped competitor data into formatted intelligence reports

## User Feedback

<!-- Notes from actual usage that suggest improvements -->

---
*Last reviewed: Not yet reviewed*

---

## SkillInvoker Integration (2026-02-02)

### Fabric Patterns
- **Priority:** HIGH
- **Patterns:** summarize, extract_main_idea
- **Use Case:** Tiered content extraction - apply increasingly sophisticated analysis as content moves through scraping tiers (Tier 1 quick summary, Tier 2+ deep extraction)

### Prompting Templates
- **Priority:** LOW
- **Primitives:** Structure
- **Use Case:** Progressive tier escalation workflows - structured decision trees for when to escalate from basic to advanced scraping tiers
