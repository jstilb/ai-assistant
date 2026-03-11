# BuildProfile Workflow

Enriches a discovered contact with publicly available information using OSINT skill, Research skill, and web search.

---

## Inputs

| Parameter | Required | Description |
|-----------|----------|-------------|
| contactId | Yes (one of) | Contact UUID from the pipeline |
| contactName | Yes (one of) | Contact name to look up in pipeline |
| depth | No | Enrichment depth: "quick" (web search) or "standard" (OSINT) -- default: "standard" |

---

## Preconditions

1. Contact must exist in the pipeline at stage "discovered" or later
2. Ethical boundaries verified (see `EthicalBoundaries.md`)
3. Session limit check: max 10 profile enrichments per session

---

## Execution Steps

### Step 1: Load Contact
```
bun Tools/OutreachState.ts get --id "[contactId]"
```

Verify the contact exists and load their current data (name, source, community, notes, profile URL).

### Step 2: Quick Enrichment (Web Search)
Use Claude WebSearch or Research Skill (Quick mode) to find:

**Search queries:**
- "[Name] [community/industry] San Diego"
- "[Name] LinkedIn profile"
- "[Name] personal website blog"
- "[Name] [organization from notes]"

**Extract:**
- Personal website or blog URL
- LinkedIn profile URL
- Twitter/X handle
- GitHub profile (if tech)
- Recent talks, posts, or projects
- Professional background
- Shared interests with Jm
- Email (if publicly listed on personal site or speaker page)

### Step 3: Standard Enrichment (OSINT) -- if depth = "standard"
Invoke **OSINT Skill** PeopleLookup workflow:

```
Target: [Name]
Known info: [community], [source], [existing notes], [profile URL if any]
Scope: Public information only -- website, social media, professional background
Location: San Diego / Southern California
```

**OSINT will gather:**
- Professional history and current role
- Public social media presence
- Published content (articles, talks, podcasts)
- Community involvement
- Contact information (public email, contact forms)
- Mutual connections or shared communities

### Step 4: Identify Connection Points
Analyze gathered information to find specific connection points with Jm:

**Check for overlaps in:**
- Technology interests (AI, ML, security, agents)
- Creative interests (writing, music, fiction)
- Sports/activities (volleyball, surfing)
- Location (San Diego neighborhoods, local hangouts)
- Professional goals (startups, entrepreneurship)
- Community involvement (same events, same groups)
- Recent projects or content that relates to Jm's work

### Step 5: Run Profile Analysis
```
bun Tools/ProfileAnalyzer.ts analyze \
  --name "[Name]" \
  --community "[community]" \
  --bio "[assembled bio]" \
  --location "[location]" \
  --interests "[interests found]" \
  --occupation "[role/title]" \
  --projects "[projects found]"
```

Or for deeper analysis:
```
bun Tools/ProfileAnalyzer.ts deep \
  --name "[Name]" \
  --community "[community]" \
  --bio "[assembled bio]" \
  --location "[location]" \
  --interests "[interests found]"
```

### Step 6: Update Contact Record
```
bun Tools/OutreachState.ts update \
  --id "[contactId]" \
  --stage "profiled" \
  --email "[email if found]" \
  --score [relevanceScore] \
  --profile-url "[best profile URL]" \
  --tags "[updated tags]" \
  --notes "[enriched notes with connection points and why-connect summary]"
```

### Step 7: Report Profile
Present the enriched profile:

```
## Profile: [Name]

**Score:** [0.XX] | **Stage:** profiled | **Community:** [community]

### Background
[2-3 sentences on who they are and what they do]

### Connection Points with Jm
- [Specific shared interest or overlap 1]
- [Specific shared interest or overlap 2]
- [Specific shared interest or overlap 3]

### Why Connect
[2-3 sentence summary from ProfileAnalyzer]

### Contact Info
- Email: [email or "not found"]
- LinkedIn: [URL or "not found"]
- Website: [URL or "not found"]
- Twitter/X: [handle or "not found"]

### Suggested Outreach Tone: [casual-friendly | professional | community-peer]

### Flags: [cofounder-potential, community-leader, cross-community, high-value]

### Recommended Next Step
- [Draft outreach email / Skip (low score) / Need more info]
```

---

## Error Handling

| Error | Action |
|-------|--------|
| Contact not found in pipeline | Report error, suggest running DiscoverPeople first |
| OSINT skill unavailable | Fall back to quick enrichment only |
| No public info found | Update notes with "limited public info", suggest manual research |
| Email not found | Note in profile, outreach may need alternative channel |

---

## Privacy Enforcement

At every step, verify:
- All information is from public sources
- No gated content was accessed
- Source of each data point is documented in notes
- No Terms of Service were violated

If any data point's source is questionable, exclude it and note "excluded: uncertain source" in notes.

---

*Workflow supports goals: G12 (Professional Community), G22 (Community Acquaintances), G26 (Cofounder)*
