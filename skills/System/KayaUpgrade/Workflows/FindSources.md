# Find Sources

Discover and evaluate new sources to add to upgrade monitoring.

**Trigger:** "find upgrade sources", "find new sources", "discover channels", "expand monitoring"

---

## Overview

This workflow identifies new sources worth monitoring for Kaya-relevant updates:
- YouTube channels creating relevant content
- Blogs and newsletters covering AI development
- GitHub repositories with useful patterns
- Community resources and forums

---

## Inline Workflow Prompt

When this workflow is invoked, execute the following steps directly — no script required.

---

### Step 1: Determine scope

Check whether the request targets a specific category or all categories.

**Available categories** (with evaluation weight — higher = more important for Kaya):

| Key | Name | Weight | Description |
|-----|------|--------|-------------|
| `claude-code` | Claude Code | 1.5x | Claude Code tutorials, workflows, extensions, best practices |
| `mcp` | Model Context Protocol | 1.4x | MCP servers, tools, and integration patterns |
| `skills` | Skills & Plugins | 1.4x | Skill-based AI systems, Claude Skills, plugin architectures |
| `ai-agents` | AI Agents | 1.3x | Multi-agent systems, orchestration, and agent patterns |
| `ai-coding` | AI Coding | 1.2x | AI-assisted development tools and coding workflows |
| `llm-engineering` | LLM Engineering | 1.1x | LLM optimization, prompting techniques, RAG patterns |

If the user mentioned a specific category (e.g., "find MCP sources"), restrict to that category. Otherwise process all six.

---

### Step 2: Generate search queries

For each category being processed, generate the following queries. Replace `{year}` with the current year.

**claude-code** (keywords: claude code, claude-code, anthropic claude cli, claude terminal)
1. `Claude Code tutorial YouTube {year}`
2. `Claude Code best practices blog`
3. `claude-code GitHub projects`
4. `Claude Code workflow automation`
5. `Anthropic Claude Code tips`
6. `Claude Code vs Cursor comparison`
7. `claude code YouTube channel`
8. `best claude-code blogs {year}`
9. `site:github.com claude code`

**mcp** (keywords: model context protocol, mcp server, mcp tools, anthropic mcp)
1. `MCP server tutorial YouTube {year}`
2. `Model Context Protocol examples GitHub`
3. `building MCP servers TypeScript`
4. `MCP integration patterns blog`
5. `awesome MCP servers list`
6. `MCP server development guide`
7. `model context protocol YouTube channel`
8. `best mcp server blogs {year}`
9. `site:github.com model context protocol`

**skills** (keywords: claude skills, ai skills, plugin system, extension system)
1. `Claude Skills tutorial {year}`
2. `AI skill system architecture`
3. `building AI plugins blog`
4. `modular AI systems patterns`
5. `skill-based AI assistants`
6. `AI extension development`
7. `claude skills YouTube channel`
8. `best ai skills blogs {year}`
9. `site:github.com claude skills`

**ai-agents** (keywords: ai agents, multi-agent, agent orchestration, agentic ai)
1. `AI agent patterns tutorial YouTube {year}`
2. `multi-agent orchestration frameworks`
3. `building AI agents TypeScript`
4. `agent-based AI systems blog`
5. `AI agent architecture patterns`
6. `autonomous AI agents development`
7. `ai agents YouTube channel`
8. `best multi-agent blogs {year}`
9. `site:github.com ai agent orchestration`

**ai-coding** (keywords: ai coding, ai programming, ai development, llm coding)
1. `AI coding assistant comparison {year}`
2. `AI pair programming tools`
3. `LLM for software development blog`
4. `AI code generation best practices`
5. `AI-assisted development workflow YouTube`
6. `AI coding tools GitHub`
7. `ai coding YouTube channel`
8. `best ai programming blogs {year}`
9. `site:github.com ai coding`

**llm-engineering** (keywords: llm engineering, prompt engineering, rag, llm optimization)
1. `LLM engineering best practices {year}`
2. `advanced prompt engineering guide`
3. `RAG implementation patterns`
4. `LLM optimization techniques blog`
5. `production LLM systems YouTube`
6. `LLM application architecture`
7. `llm engineering YouTube channel`
8. `best prompt engineering blogs {year}`
9. `site:github.com llm engineering`

---

### Step 3: Execute searches

Use WebSearch to execute the **top 3-4 queries per category** (prioritize queries 1, 2, 3, 5 from each list). If scope is limited to one category, execute all 9 queries for that category.

For each search result, collect:
- Source name
- URL
- Type: `youtube` | `blog` | `github` | `newsletter` | `other`
- Brief description of what it covers

Deduplicate across categories — a source that appears in multiple categories only needs to be evaluated once.

---

### Step 4: Evaluate each source

For each candidate source, score 1-5 on each criterion and calculate the weighted total:

| Criterion | Weight | What to score |
|-----------|--------|---------------|
| **Relevance** | 30% | How directly relevant to Kaya's goals (claude code, agents, skills, MCP, TypeScript/CLI tooling) |
| **Quality** | 25% | Content depth, accuracy, production value — not just news aggregation |
| **Frequency** | 20% | How often new content is published (5 = weekly+, 3 = monthly, 1 = dormant) |
| **Uniqueness** | 15% | Unique perspective or expertise not found in currently-monitored sources |
| **Stack Alignment** | 10% | TypeScript, CLI-first, modern tooling alignment |

```
total_score = (relevance x 0.30) + (quality x 0.25) + (frequency x 0.20) +
              (uniqueness x 0.15) + (stack_alignment x 0.10)
```

**Priority assignment:**
- `total_score >= 4.0` -> HIGH — add immediately
- `total_score 3.0-3.9` -> MEDIUM — consider adding after brief review
- `total_score < 3.0` -> LOW — low impact, skip

Apply the category evaluation weight as a tiebreaker (not multiplied into score — used when two sources have the same priority to decide which to recommend first).

---

### Step 5: Present recommendations

Output in this format:

```
# New Source Recommendations
**Discovery Date:** {today}
**Categories Searched:** {list}

---

## HIGH PRIORITY (Add Now)

### [Source Name]
**Type:** YouTube / Blog / GitHub / Other
**URL:** [url]
**Category:** [category key]
**Score:** [total_score] (relevance:[n] quality:[n] frequency:[n] uniqueness:[n] stack:[n])
**Relevance:** [One sentence on why this matters for Kaya]
**Content Focus:** [What they cover]
**Update Frequency:** [How often they post]

**To Add:**
[See config template below for the appropriate type]

---

## MEDIUM PRIORITY (Consider)

[Same format]

---

## LOW PRIORITY (Mentioned for completeness)

[Name + URL + one-line reason]
```

---

### Step 6: Config templates

Use the appropriate template when adding a source:

**YouTube Channel** (youtube-channels.json):
```json
{
  "name": "[Channel Name]",
  "channel_id": "@[handle]",
  "url": "https://www.youtube.com/@[handle]",
  "priority": "[HIGH|MEDIUM|LOW]",
  "description": "[What this channel covers]"
}
```

**GitHub Repository** (sources.json):
```json
{
  "name": "[Repo Name]",
  "owner": "[owner]",
  "repo": "[repo]",
  "priority": "[HIGH|MEDIUM|LOW]",
  "check_commits": true,
  "check_releases": true
}
```

**Blog/Newsletter** (sources.json):
```json
{
  "name": "[Blog Name]",
  "url": "[URL]",
  "priority": "[HIGH|MEDIUM|LOW]",
  "type": "blog"
}
```

**Config file locations:**

| Source Type | Config File | Path |
|-------------|-------------|------|
| YouTube Channels | `youtube-channels.json` | `~/.claude/skills/System/KayaUpgrade/` |
| GitHub Repos | `sources.json` | `~/.claude/skills/System/KayaUpgrade/` |
| Blogs/Changelogs | `sources.json` | `~/.claude/skills/System/KayaUpgrade/` |

---

### Step 7: Offer to add

If the user approves any recommendations, read the current config and merge in the new entries:

```bash
cat ~/.claude/skills/System/KayaUpgrade/youtube-channels.json
cat ~/.claude/skills/System/KayaUpgrade/sources.json
```

Then write the updated file with the new entry appended to the appropriate array.

---

## Discovery Strategies

### Follow the Experts
- Find who Anthropic engineers follow/reference
- Check who creates content cited in official docs
- Look at conference speaker lists (AI Engineer World's Fair, NeurIPS, etc.)

### Community Mining
- Search Discord/Slack for recommended resources
- Check Reddit threads (r/ClaudeAI, r/LocalLLaMA) for learning resources
- Look at "awesome" lists on GitHub (awesome-mcp-servers, awesome-claude, etc.)

### Algorithm Surfing
- Start from known good channels, explore their recommendations
- Check related channels on YouTube
- Follow citation chains in blog posts

---

## Examples

**General discovery:**
```
User: "find new upgrade sources"
-> Process all 6 categories with top 3-4 queries each
-> Evaluate all discovered sources with the 5-criterion scoring formula
-> Output prioritized recommendations with config snippets
```

**Specific category:**
```
User: "find YouTube channels about MCP servers"
-> Execute all 9 MCP queries
-> Evaluate and score MCP-specific results
-> Recommend best MCP resources
```

**Add recommended source:**
```
User: "add that channel"
-> Read current youtube-channels.json
-> Append new channel entry
-> Write updated file
-> Confirm addition
```

---

## Integration

**With Other Workflows:**
- **CheckForUpgrades** — Newly added sources feed into the next monitoring run
- **ResearchUpgrade** — Discovered sources can be deep-dived immediately

**With USER Customization:**
- Sources are added to the skill directory config files
- Personal monitoring preferences are preserved across upgrades
