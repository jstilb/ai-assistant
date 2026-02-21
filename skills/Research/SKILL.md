---
name: Research
description: Comprehensive research, analysis, and content extraction system. USE WHEN user says 'do research', 'do extensive research', 'quick research', 'minor research', 'research this', 'find information', 'investigate', 'extract wisdom', 'extract alpha', 'analyze content', 'can't get this content', 'use fabric', OR requests any web/content research. Supports three research modes (quick/standard/extensive), deep content analysis, intelligent retrieval, and 242+ Fabric patterns. NOTE: For due diligence, OSINT, or background checks, use OSINT skill instead.
---
# Research Skill

Comprehensive research, analysis, and content extraction system.

## MANDATORY: URL Verification

**READ:** `UrlVerificationProtocol.md` - Every URL must be verified before delivery.

Research agents hallucinate URLs. A single broken link is a catastrophic failure.

## MANDATORY: Confidence Scoring

**READ:** `ConfidenceScoring.md` - Every research output must include confidence levels and source tier attribution.

Every finding gets a confidence badge (HIGH/MEDIUM/LOW) based on source count, authority, agreement, and freshness. Sources are attributed by tier (T1: verified → T2: reputable → T3: community → T4: inferred). Conflicts between sources are flagged explicitly.

---

## Voice Notification

→ Use `notifySync()` from `skills/CORE/Tools/NotificationService.ts`

## Workflow Routing

Route to the appropriate workflow based on the request.

**CRITICAL:** For due diligence, company/person background checks, or vetting -> **INVOKE OSINT SKILL INSTEAD**

### Research Modes (Primary Workflows)
- Quick/minor research (1 Claude agent, 1 query) -> `Workflows/QuickResearch.md`
- Standard research - DEFAULT (2 agents: Claude + Gemini) -> `Workflows/StandardResearch.md`
- Extensive research (3 types x 3 threads = 9 agents) -> `Workflows/ExtensiveResearch.md`

### Deep Content Analysis
- Extract alpha / deep analysis / highest-alpha insights -> `Workflows/ExtractAlpha.md`

### Content Retrieval
- Difficulty accessing content (CAPTCHA, bot detection, blocking) -> `Workflows/Retrieve.md`
- YouTube URL extraction (use `fabric -y URL` immediately) -> `Workflows/YoutubeExtraction.md`
- Web scraping -> `Workflows/WebScraping.md`

### Specific Research Types
- Claude WebSearch only (free, no API keys) -> `Workflows/ClaudeResearch.md`
- Single-agent Claude research (use Quick for single-agent) -> `Workflows/QuickResearch.md`
- Interview preparation (Tyler Cowen style) -> `Workflows/InterviewResearch.md`
- AI trends analysis -> `Workflows/AnalyzeAiTrends.md`

### Fabric Pattern Processing
- Use Fabric patterns (242+ specialized prompts) -> `Workflows/Fabric.md`

### Content Enhancement
- Enhance/improve content -> `Workflows/Enhance.md`
- Extract knowledge from content -> `Workflows/ExtractKnowledge.md`

---

## Quick Reference

**READ:** `QuickReference.md` for detailed examples and mode comparison.

| Trigger | Mode | Speed |
|---------|------|-------|
| "quick research" | 1 Claude agent | ~10-15s |
| "do research" | 2 agents (default) | ~15-30s |
| "extensive research" | 9 agents | ~60-90s |

---

## Integration

### Feeds Into
- **blogging** - Research for blog posts
- **newsletter** - Research for newsletters
- **xpost** - Create posts from research

### Uses
- **be-creative** - deep thinking for extract alpha
- **OSINT** - MANDATORY for company/people comprehensive research
- **BrightData MCP** - CAPTCHA solving, advanced scraping
- **Apify MCP** - RAG browser, specialized site scrapers

---

## Tools

The Research skill includes TypeScript utilities in `Tools/`:

| Tool | Purpose | Usage |
|------|---------|-------|
| `ClaudeResearch.ts` | Query decomposition for multi-angle searches | `bun Tools/ClaudeResearch.ts "question"` |
| `UrlVerifier.ts` | Validate URLs before including in output | `bun Tools/UrlVerifier.ts "url"` |

## Configuration

See `CONFIG.md` for configurable parameters including:
- Default research mode
- Agent counts and timeouts
- URL verification settings
- Rate limits for paid APIs

## Examples

See `Examples/` for sample outputs:
- `QuickResearchOutput.md` - Quick mode output format
- `ExtractAlphaOutput.md` - Deep analysis output format

---

## File Organization

**Scratch (temporary work artifacts):** `~/.claude/MEMORY/WORK/{current_work}/scratch/`
- Read `~/.claude/MEMORY/STATE/current-work.json` to get the `work_dir` value
- All iterative work artifacts go in the current work item's scratch/ subdirectory
- This ties research artifacts to the work item for learning and context

**History (permanent):** `~/.claude/History/research/YYYY-MM/YYYY-MM-DD_[topic]/`
