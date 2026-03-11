# ManagePipeline Workflow

View, filter, and manage the outreach contact pipeline. Provides pipeline summary, contact listings, and stage management.

---

## Inputs

| Parameter | Required | Description |
|-----------|----------|-------------|
| action | Yes | "summary", "list", "update", "search" |
| filters | No | Stage, community, tag, min-score filters |
| contactId | For update | Contact to update |
| newStage | For update | New stage to set |

---

## Actions

### summary
Display pipeline overview with counts by stage and community.

**Execution:**
```
bun Tools/OutreachState.ts summary
```

**Output format:**
```
## Outreach Pipeline Summary

### By Stage
| Stage | Count |
|-------|-------|
| Discovered | [N] |
| Profiled | [N] |
| Drafted | [N] |
| Sent | [N] |
| Responded | [N] |
| Connected | [N] |
| Opted-Out | [N] |
| **Total** | **[N]** |

### By Community
| Community | Count | Avg Score |
|-----------|-------|-----------|
| professional-ai | [N] | [X.XX] |
| writing-sd | [N] | [X.XX] |
| ... | ... | ... |

### Weekly Outreach Status
- Emails sent this week: [N] / 10
- Remaining capacity: [N]

### Top Contacts (Ready for Outreach)
| Name | Score | Community | Stage | Email |
|------|-------|-----------|-------|-------|
| [Name] | 0.85 | professional-ai | profiled | yes/no |
| ... | ... | ... | ... | ... |

### Recommended Actions
- [N] contacts ready for profiling (discovered with score > 0.3)
- [N] contacts ready for outreach (profiled with email)
- [N] follow-ups due (sent > 7 days ago)
```

---

### list
List contacts with optional filtering.

**Execution:**
```
bun Tools/OutreachState.ts list [--stage "discovered"] [--community "professional-ai"] [--min-score 0.5] [--tag "cofounder-potential"]
```

**Output format:**
```
## Contacts: [filter description]

| # | Name | Score | Community | Stage | Source | Tags |
|---|------|-------|-----------|-------|--------|------|
| 1 | [Name] | 0.85 | professional-ai | profiled | conference-speaker | cofounder-potential, local-sd |
| 2 | [Name] | 0.72 | writing-sd | discovered | blog-author | creative |
| ... | ... | ... | ... | ... | ... | ... |

Total: [N] contacts matching filters
```

---

### search
Search contacts by name, notes, connection points, or tags.

**Execution:**
```
bun Tools/OutreachState.ts search --query "[search term]" [--stage "..."] [--community "..."]
```

---

### update
Update a contact's stage or other fields.

**Execution:**
```
bun Tools/OutreachState.ts update --id "[contactId]" --stage "[newStage]" [additional fields]
```

**Stage transitions and side effects:**

| From | To | Side Effect |
|------|----|-------------|
| discovered | profiled | None |
| profiled | drafted | Should have draft ID |
| drafted | sent | Set `lastContactAt` to now, set `followUpAfter` to now + 7 days |
| sent | responded | Clear `followUpAfter` |
| responded | connected | Graduate to CONTACTS.md |
| any | opted-out | Clear all outreach data, preserve record for exclusion |
| any | discovered | Reset (re-enters pipeline) |

**Connected stage graduation:**
When a contact reaches "connected" stage, append their info to `~/.claude/USER/CONTACTS.md`:

```markdown
### [Name]
- **Met through:** [community] outreach ([source])
- **Connection:** [connection points summary]
- **Email:** [email]
- **Profiles:** [profile URLs]
- **Notes:** [relevant notes]
- **Connected:** [date]
```

---

## Pipeline Health Indicators

The summary should flag:

| Indicator | Threshold | Meaning |
|-----------|-----------|---------|
| Stale discovered | > 14 days at discovered | Need to profile or remove |
| Stale drafted | > 7 days at drafted | Jm should review and send or discard |
| Follow-ups due | sent + 7 days elapsed | Time for one follow-up |
| Low pipeline | < 5 profiled contacts | Need more discovery |
| High opt-out rate | > 20% opted out | Review outreach quality |

---

## Quick Commands

For common operations, provide shortcuts:

```bash
# Quick summary
bun Tools/OutreachState.ts summary

# Show all contacts ready for outreach (profiled + have email)
bun Tools/OutreachState.ts list --stage profiled

# Show high-value contacts
bun Tools/OutreachState.ts list --min-score 0.7

# Show cofounder candidates
bun Tools/OutreachState.ts list --tag cofounder-potential

# Show follow-ups due
bun Tools/OutreachState.ts list --stage sent
# (then check followUpAfter dates)

# Mark as sent after Jm sends manually
bun Tools/OutreachState.ts update --id "[id]" --stage sent --last-contact "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

---

*Workflow supports goals: G12 (Professional Community), G22 (Community Acquaintances), G26 (Cofounder)*
