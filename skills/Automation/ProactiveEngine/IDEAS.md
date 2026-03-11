# Ideas & Future Improvements

> Capture ideas for enhancing this skill. Review during maintenance cycles.

## Proposed Enhancements

<!-- Add ideas below. Format: - [ ] Idea description (source: session/date/context) -->

## Integration Opportunities

### Direct API Integrations (Future - Not Yet Implemented)

These were previously documented as if implemented in SendProactiveMessage.md workflow.
They are aspirational -- currently, briefings use CLI tools (`kaya-cli gcal`, `kaya-cli tasks`)
and the DailyBriefing skill modules instead.

- [ ] **Calendar API** - Direct Google Calendar / iCloud / Outlook integration for fetching
  events by date, without CLI subprocess. Would return `{time, title, location, attendees}`.
- [ ] **LucidTasks API** - Direct LucidTasks integration for task queries with filters
  (priority, dueDate, status). Would eliminate CLI dependency.
- [ ] **Weather API** - Direct OpenWeather / Weather.com integration using location from
  settings.json. Would return `{temp, conditions, precipitation, alerts}`.
- [ ] **Email API** - Direct Gmail/Outlook integration for unread email summaries.

*Source: Extracted from aspirational code in SendProactiveMessage.md (2026-02-06)*

## User Feedback

<!-- Notes from actual usage that suggest improvements -->

---

## SkillInvoker Integration (2026-02-02)

### Fabric Patterns
- **Priority:** MEDIUM
- **Patterns:** extract_wisdom
- **Use Case:** Context analysis for proactive suggestions

### Prompting Templates
- **Priority:** HIGH
- **Primitives:** Briefing, Voice
- **Use Case:** Personalized message composition templates

---
*Last reviewed: 2026-02-06*
