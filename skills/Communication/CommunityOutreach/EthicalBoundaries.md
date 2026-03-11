# Ethical Boundaries

Privacy rules, rate limits, and source restrictions for all CommunityOutreach operations.

**These boundaries are non-negotiable. Violation of any rule halts the workflow.**

---

## Data Collection Rules

### ALLOWED Sources
- Personal websites and blogs
- Public social media profiles (LinkedIn, Twitter/X, GitHub)
- Conference and meetup speaker pages
- Published articles, podcasts, and interviews
- Public directories and community member lists
- Open source project contributor pages
- Public event listings (Meetup.com, Eventbrite, Luma)
- Professional portfolios and public resumes

### PROHIBITED Sources
- Private or gated content (paywalls, members-only areas)
- Purchased contact lists or data brokers
- Breach databases or leaked data
- Social engineering or impersonation
- Private messages, DMs, or closed group content
- Scraping that violates a site's Terms of Service
- Company internal directories
- Data obtained through unauthorized access

---

## Rate Limits

| Limit | Value | Rationale |
|-------|-------|-----------|
| Outreach emails per week | 10 max | Quality over quantity; avoid spam behavior |
| Follow-up cool-down | 7 days minimum | Respect recipient's time |
| Maximum follow-ups per person | 1 | One polite follow-up, then silence |
| Discovery searches per session | 5 max | Prevent excessive scraping |
| Profile enrichments per session | 10 max | Responsible data gathering |

---

## Outreach Rules

1. **Never auto-send.** All emails are created as Gmail drafts for Jm to review and send manually.
2. **One follow-up maximum.** If no response after one follow-up, mark as no-contact and move on.
3. **Opt-out honored immediately.** If anyone asks not to be contacted, update their stage to "opted-out" and never contact again.
4. **Transparent sourcing.** Emails should naturally reference how Jm found them (e.g., "I saw your talk at SD AI Meetup").
5. **No deception.** Never misrepresent Jm's identity, intentions, or affiliations.
6. **CAN-SPAM compliance.** Include Jm's real name, provide opt-out mechanism, honor opt-out within 24 hours.

---

## Data Handling

- All contact data stored locally in `MEMORY/STATE/outreach-pipeline.jsonl`
- No data transmitted to third parties
- Contact records include `source` field documenting where each piece of information was found
- Data retained indefinitely for pipeline management, but opted-out contacts are permanently excluded from outreach
- No personally identifiable information in git-tracked files

---

## Verification Checklist

Before any outreach operation, verify:

- [ ] All contact info sourced from public channels
- [ ] Weekly email limit not exceeded (check pipeline for "sent" stage this week)
- [ ] Follow-up cool-down respected (check `lastContactAt` + 7 days)
- [ ] No duplicate outreach to same person
- [ ] Email created as draft, not sent
- [ ] Tone and content comply with `EmailTemplates.md` guidelines

---

## Escalation

If uncertain about whether a data source is ethical:
1. **Default to NOT using it**
2. Ask Jm for explicit approval
3. Document the decision in contact notes

---

*These boundaries align with Kaya's security-first philosophy and OSINT ethical framework.*
