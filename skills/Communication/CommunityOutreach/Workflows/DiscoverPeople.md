# DiscoverPeople Workflow

Discovers people in target communities using Research skill, web search, and social platform scraping.

---

## Inputs

| Parameter | Required | Description |
|-----------|----------|-------------|
| community | Yes | Community ID from `CommunityTargets.md` (e.g., "professional-ai", "writing-sd") |
| query | No | Additional search terms to narrow discovery |
| location | No | Geographic filter (default: "San Diego") |
| maxResults | No | Maximum people to discover (default: 10) |

---

## Execution Steps

### Step 1: Load Context
1. Read `CommunityTargets.md` to get discovery sources for the target community
2. Read `EthicalBoundaries.md` to confirm compliance
3. Check session limits (max 5 discovery searches per session)

### Step 2: Build Search Queries
Based on the community, construct search queries. Examples:

**professional-ai:**
- "San Diego AI meetup speakers organizers"
- "San Diego machine learning startup founders"
- "AI security professionals San Diego LinkedIn"
- "San Diego tech community leaders"

**writing-sd:**
- "San Diego writers ink members"
- "San Diego fiction writing workshop"
- "San Diego authors Substack Medium"
- "San Diego literary community"

**surf-sd:**
- "San Diego surf groups clubs"
- "San Diego beginner surf community"
- "Pacific Beach surf meetup"

**volleyball-sd:**
- "San Diego beach volleyball league"
- "San Diego rec volleyball meetup"

**music-sd:**
- "San Diego open mic jam session"
- "San Diego music meetup"

**dsa-sd:**
- "San Diego DSA chapter events"
- "San Diego progressive community"

### Step 3: Execute Research
Invoke the **Research Skill** with StandardResearch mode:

```
Research query: "[constructed search query]"
Mode: Standard (3 agents: Perplexity + Claude + Gemini)
Focus: Find specific people (names, roles, organizations) in [community] in [location]
```

For each research result, extract:
- Person name
- Role/title
- Organization/affiliation
- Source where they were found
- Any public contact info mentioned
- Notable projects or contributions

### Step 4: Social Platform Discovery (Optional)
If Apify is available, supplement with:

**LinkedIn Search:**
```
Query: "[community keywords] San Diego"
Actor: LinkedIn profile search
Extract: Name, headline, location, profile URL
```

**Twitter/X Search:**
```
Query: "[community keywords] San Diego"
Actor: Twitter profile search
Extract: Name, bio, location, profile URL
```

### Step 5: Process Results
For each discovered person:

1. **Deduplication check** against existing pipeline:
   ```
   bun Tools/OutreachState.ts search --query "[person name]"
   ```

2. **If new:** Add to pipeline:
   ```
   bun Tools/OutreachState.ts add \
     --name "[Person Name]" \
     --community "[community-id]" \
     --source "[source-type]" \
     --notes "[how they were found, role, affiliation]" \
     --profile-url "[URL if found]" \
     --tags "[relevant tags]"
   ```

3. **Source types:** Use the most specific applicable:
   - `conference-speaker` - Found via conference/event speaker page
   - `meetup-organizer` - Organizes community meetups
   - `blog-author` - Found through their writing
   - `social-media` - Discovered via LinkedIn/Twitter/X
   - `open-source` - Found through open source contributions
   - `podcast-host` - Hosts or guests on relevant podcasts
   - `community-member` - General community presence
   - `referral` - Mentioned or recommended by another contact

### Step 6: Initial Scoring
Run ProfileAnalyzer on each new contact (local mode for speed):

```
bun Tools/ProfileAnalyzer.ts analyze \
  --name "[Name]" \
  --community "[community-id]" \
  --bio "[any bio text found]" \
  --location "[location if known]" \
  --interests "[comma-separated interests]"
```

Update the contact's relevance score:
```
bun Tools/OutreachState.ts update --id "[contact-id]" --score [relevance-score] --tags "[suggested-tags]"
```

### Step 7: Report Results
Present discovered contacts sorted by relevance score:

```
## Discovery Results: [Community Name]

Found [N] new contacts (searched [sources]):

| # | Name | Score | Source | Key Connection Points |
|---|------|-------|--------|----------------------|
| 1 | [Name] | 0.85 | conference-speaker | [points] |
| 2 | [Name] | 0.72 | blog-author | [points] |
| ... | ... | ... | ... | ... |

### Recommended Next Steps
- Build profiles for top [3-5] contacts (run BuildProfile workflow)
- [N] contacts flagged as cofounder-potential
- [N] contacts already in pipeline (skipped)
```

---

## Error Handling

| Error | Action |
|-------|--------|
| Research skill unavailable | Fall back to Claude WebSearch only |
| Apify unavailable | Skip social platform discovery, use Research only |
| Session limit reached | Report partial results, suggest continuing next session |
| All results are duplicates | Report no new contacts, suggest broadening search terms |

---

## Rate Limits

- Maximum 5 discovery searches per session
- Each search may invoke 3-12 research agents (depending on mode)
- Respect Apify rate limits if used

---

*Workflow supports goals: G12 (Professional Community), G26 (Cofounder), G22 (Community Acquaintances)*
