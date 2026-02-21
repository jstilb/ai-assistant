---
name: CommunityOutreach
description: Discover people in target communities, build profiles, and generate personalized outreach emails. USE WHEN community outreach, find people, outreach email, discover contacts, professional networking, community finder, build profile, pipeline management.
---

# CommunityOutreach

Discovers people in target communities, gathers public contact information ethically, analyzes profiles for relevance, and generates personalized outreach emails as Gmail drafts.

**Privacy-first. Human-in-the-loop. Never auto-sends.**

---
---

## Voice Notification

> Use `notifySync()` from `skills/CORE/Tools/NotificationService.ts`

---

## Workflow Routing

| Trigger | Workflow | Description |
|---------|----------|-------------|
| "find people in [community]", "discover connections" | `Workflows/DiscoverPeople.md` | Search for people in a community |
| "build profile for [person]", "enrich [person]" | `Workflows/BuildProfile.md` | Enrich a discovered person with public info |
| "draft outreach to [person]", "write email to [contact]" | `Workflows/GenerateOutreach.md` | Generate personalized outreach email |
| "show pipeline", "outreach status", "pipeline summary" | `Workflows/ManagePipeline.md` | View and manage the outreach pipeline |

---

## Examples

**Discovery:**
- "find people in the AI community in SD"
- "discover writers in San Diego"
- "find potential cofounders in tech"

**Profile Building:**
- "build a profile for [person]"
- "enrich this contact"

**Outreach Generation:**
- "draft an outreach email to [person]"
- "generate outreach for top contacts"

**Pipeline Management:**
- "show outreach pipeline"
- "pipeline summary by community"

---

## Integration

### Uses
- **Research Skill** - Community discovery via web search
- **OSINT Skill** - People lookup for profile enrichment
- **Gmail Skill** - Draft creation for outreach emails
- **Apify Skill** - LinkedIn/Twitter profile data
- **Inference Tool** - Profile analysis (standard) and email generation (smart)

### Feeds Into
- **CONTACTS.md** - Graduated contacts (stage = "connected")
- **CalendarAssistant** - Meeting scheduling from outreach

### MCPs Used
- **gmail** - Draft email creation
- **Apify** - Social profile scraping

---

## State

| File | Format | Purpose |
|------|--------|---------|
| `MEMORY/STATE/outreach-pipeline.jsonl` | JSONL | Contact pipeline with stages |

Note: `Tools/OutreachState.ts` is a domain-specific JSONL state manager. JSONL format requires line-oriented I/O incompatible with the JSON-backed `StateManager` from CORE. This is an intentional architectural decision.

---

## Ethical Boundaries (REQUIRED)

**Before ANY outreach activity, verify compliance with `EthicalBoundaries.md`:**

- Only publicly available information
- Maximum 10 outreach emails per week
- 7-day follow-up cool-down
- Never scrape private or gated content
- Never purchase data or use breach databases
- Always create as draft -- NEVER auto-send

---

## Resource Index

| File | Purpose |
|------|---------|
| `EthicalBoundaries.md` | Privacy rules, rate limits, source restrictions |
| `CommunityTargets.md` | the user's active communities from TELOS goals |
| `EmailTemplates.md` | Outreach tone, structure, anti-patterns |
| `Tools/OutreachState.ts` | JSONL-backed CRM pipeline state management |
| `Tools/ProfileAnalyzer.ts` | Relevance scoring and compatibility analysis |

---

**Version:** 1.0
**Last Updated:** 2026-02-04
