# GenerateOutreach Workflow

Generates personalized outreach emails using Inference smart tier and creates Gmail drafts for Jm's review.

**CRITICAL: Never auto-send. Always create as Gmail draft.**

---

## Inputs

| Parameter | Required | Description |
|-----------|----------|-------------|
| contactId | Yes (one of) | Contact UUID from the pipeline |
| contactName | Yes (one of) | Contact name to look up in pipeline |
| tone | No | Override tone: "casual-friendly", "professional", "community-peer" |
| ask | No | Specific ask to include (default: coffee or virtual chat) |
| followUp | No | If true, generates a follow-up email instead |

---

## Preconditions

1. Contact must be at stage "profiled" or later (need enriched data for personalization)
2. Rate limit check: `bun Tools/OutreachState.ts rate-check` -- must have remaining weekly capacity
3. Contact must NOT be stage "opted-out"
4. If follow-up: contact must be stage "sent" and cool-down period (7 days) must have elapsed
5. Email address must be known (check contact record)

---

## Execution Steps

### Step 1: Load Contact and Context
```
bun Tools/OutreachState.ts get --id "[contactId]"
```

Load:
- Contact record (name, email, community, connection points, notes, tags)
- `EmailTemplates.md` for tone guidelines and anti-patterns
- `CommunityTargets.md` for community context
- Jm context snippets relevant to this contact's community

### Step 2: Rate Limit Verification
```
bun Tools/OutreachState.ts rate-check
```

If `remaining: 0`, STOP and report:
"Weekly outreach limit reached (10/week). [N] emails sent this week. Next available: [date]."

### Step 3: Select Tone
Priority for tone selection:
1. Explicit `tone` parameter if provided
2. ProfileAnalyzer's `suggestedTone` from contact record
3. Community default:
   - professional-ai -> "professional"
   - writing-sd, dsa-sd -> "community-peer"
   - surf-sd, volleyball-sd, music-sd -> "casual-friendly"

### Step 4: Construct Email Generation Prompt

Read `EmailTemplates.md` for full guidelines, then invoke Inference smart tier:

```bash
bun ~/.claude/lib/core/Inference.ts --level smart \
  "[system prompt]" \
  "[user prompt]"
```

**System Prompt:**
```
You are a personal email assistant helping write authentic, personalized outreach emails.

CRITICAL RULES:
- Under 150 words total
- One specific, low-friction ask (coffee, virtual chat, attend same event)
- Reference something specific about the recipient (their recent work, talk, project)
- Peer-to-peer tone, never fan-to-creator
- Include one brief line about who Jm is (relevant to this recipient)
- No corporate language, no buzzwords, no "picking your brain"
- Subject line must be specific and personal, not generic
- Sign off as "Jm"

TONE: [selected tone]
- casual-friendly: Relaxed, like messaging someone you met at an event
- professional: Direct, substance-focused, peer-level
- community-peer: Fellow member interested in the community

ANTI-PATTERNS (never use):
- "I'm a huge fan of your work"
- "I'd love to pick your brain"
- "I know you're busy, but..."
- "I have an amazing opportunity"
- "Hope this email finds you well"
- Multiple paragraphs about Jm
```

**User Prompt:**
```
Write an outreach email from Jm to [Name].

RECIPIENT INFO:
- Name: [name]
- Community: [community]
- Background: [notes/bio from profile]
- Connection Points: [connection points from profile]
- Recent Activity: [if known]

JM CONTEXT (use the most relevant 1-2):
- [relevant Jm context snippets from EmailTemplates.md]

SPECIFIC ASK: [ask parameter or default: "coffee or a virtual chat"]

Return JSON:
{
  "subject": "email subject line",
  "body": "full email body text",
  "wordCount": number
}
```

### Step 5: Validate Email Quality
Check the generated email against quality criteria:

- [ ] Under 150 words (if over, regenerate)
- [ ] Contains a specific reference to the recipient
- [ ] Has exactly one clear ask
- [ ] No anti-patterns detected
- [ ] Subject line is specific
- [ ] Includes brief Jm context
- [ ] Appropriate tone for community

If validation fails, regenerate with more specific instructions about the failure.

### Step 6: Create Gmail Draft
Use Gmail skill to create draft:

```
kaya-cli gmail draft \
  --to "[contact email]" \
  --subject "[generated subject]" \
  --body "[generated body]"
```

Capture the draft ID from the response.

### Step 7: Update Pipeline State
```
bun Tools/OutreachState.ts update \
  --id "[contactId]" \
  --stage "drafted" \
  --draft-id "[gmail-draft-id]" \
  --notes "[updated notes: draft created on [date], tone: [tone]]"
```

### Step 8: Report to Jm

```
## Outreach Draft Created

**To:** [Name] ([email])
**Subject:** [subject]
**Tone:** [tone]
**Word Count:** [count]

---

[Full email body displayed for review]

---

### Quality Checks
- [x] Under 150 words
- [x] Specific reference to recipient
- [x] One clear ask
- [x] No anti-patterns
- [x] Subject is specific

### Next Steps
- Review the draft in Gmail
- Edit as needed and send when ready
- After sending, update status: `bun Tools/OutreachState.ts update --id "[id]" --stage "sent" --last-contact "[ISO date]"`

### Weekly Outreach Status
- Sent this week: [N] / 10
- Remaining capacity: [N]
```

---

## Follow-Up Email Generation

If `followUp: true`:

### Additional Preconditions
- Contact stage must be "sent"
- `lastContactAt` + 7 days must have passed
- This must be the FIRST follow-up (check notes for "follow-up sent")

### Modified Prompt
Use the follow-up template from `EmailTemplates.md`:

```
Subject: Re: [original subject]

Hey [Name], just wanted to float this back up -- no pressure at all.
[One brief reminder or add something new like a relevant event].

Either way, keep up the great work on [specific thing].

Jm
```

### After Follow-Up
Update notes to include "follow-up sent on [date]" -- this prevents any future follow-ups.

---

## Error Handling

| Error | Action |
|-------|--------|
| No email address on contact | Report error, suggest running BuildProfile to find email |
| Weekly limit reached | Report remaining capacity and next available date |
| Contact opted out | STOP immediately, report opt-out status |
| Inference unavailable | Fall back to standard tier, or report error |
| Gmail draft creation fails | Report error, show email text so Jm can manually create draft |
| Contact not profiled | Suggest running BuildProfile first for better personalization |

---

*Workflow supports goals: G12 (Professional Community), G21 (Make Friends), G22 (Community Acquaintances), G26 (Cofounder)*
