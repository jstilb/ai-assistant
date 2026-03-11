# Check for Upgrades

Monitor all configured sources for updates and new content relevant to Kaya infrastructure.

**Trigger:** "check for upgrades", "check upgrade sources", "any new updates", "check Anthropic", "check YouTube"

---

## Overview

This workflow checks all configured sources for new content:
1. **Anthropic Sources** - Official blogs, GitHub repos, changelogs, documentation
2. **YouTube Channels** - Configured via USER customization layer

Both source types are checked, and results are combined into a single prioritized report.

---

## Process

### Step 1: Check Anthropic Sources

Run the Anthropic check tool:
```bash
bun ~/.claude/skills/System/KayaUpgrade/Tools/Anthropic.ts
```

**Options:**
- No arguments: Check last 30 days (default)
- `14` or `7`: Check last N days
- `--force`: Ignore state, check all sources

**Sources Monitored (35+):**
1. **Blogs & News** (4) - Main blog, Alignment, Research, Interpretability
2. **GitHub Repositories** (12+) - claude-code, skills, MCP spec, MCP servers, SDKs, cookbooks, prompt-library
3. **Changelogs** (4) - Claude Code CHANGELOG, releases, docs notes, MCP changelog
4. **Documentation** (6) - Claude docs, API docs, MCP docs, spec, registry
5. **Community** (1) - Discord server

---

### Step 2: Check YouTube Channels

Run the YouTube monitoring tool:
```bash
bun ~/.claude/skills/System/KayaUpgrade/Tools/YouTube.ts
```

**Options:**
- No arguments: Check for new videos since last run
- `--force`: Ignore state, show all recent videos
- `--dry-run`: Preview without updating state
- `--transcript <video-id>`: Extract transcript for specific video

**Channels Monitored (5 default):**
1. **Anthropic Official** (HIGH) - @AnthropicAI
2. **AI Explained** (HIGH) - @aiexplained-official
3. **David Ondrej** (MEDIUM) - @DavidOndrej
4. **Matt Wolfe** (MEDIUM) - @maboroshi87
5. **Fireship** (LOW) - @Fireship

**Note:** Additional channels can be added in `~/.claude/skills/System/KayaUpgrade/youtube-channels.json`

---

### Step 3: AI Triage

Run the AI-powered triage on collected findings:
```bash
bun ~/.claude/skills/System/KayaUpgrade/Tools/UpgradeTriage.ts
```

This:
1. Reads raw findings from `State/latest-anthropic-findings.json` and `State/latest-youtube-findings.json`
2. Sends findings to Sonnet with Kaya architecture context
3. Produces actionable upgrade items with implementation descriptions
4. Routes actionable items to QueueRouter spec-pipeline
5. Emits insights to ContinualLearning

**Options:**
- `--dry-run`: Preview triage without routing to QueueRouter
- `--level smart`: Use Opus for deeper analysis (more expensive)

The AI triage replaces keyword-based recommendation — it reasons about
what actually matters for Kaya's specific architecture.

---

### Step 4: Present Results

The triage produces a structured report with:
- **Executive Summary** — narrative of what's happening in the ecosystem
- **Actionable Items** — prioritized work items with descriptions, affected components, effort estimates
- **Dismissed Items** — reasoning for why non-actionable findings were dropped

Actionable items are automatically queued to the spec-pipeline for Jm's review.

---

### Step 5: Provide Recommendations

Based on combined results, advise on:
- What changed and why it matters for Kaya
- Which updates to review immediately
- Specific actions to take (e.g., update skills, test new features)
- Videos worth watching in full

---

## State Tracking

**Anthropic state:** `State/last-check.json`
- Last check timestamp
- Content hashes for each source
- Last seen commit SHAs, release versions, blog titles

**YouTube state:** `State/youtube-videos.json`
- Last check timestamp per channel
- Seen video IDs (prevents duplicate processing)

State prevents duplicate reports - only NEW content is shown.

---

## Source Configuration

**Anthropic sources:** `sources.json` (base skill)
- 30+ official Anthropic sources
- Configured in skill, not customizable

**YouTube channels:** `youtube-channels.json` in the KayaUpgrade skill directory

---

## Adding YouTube Channels

Edit your customization file:
```json
{
  "_customization": {
    "description": "Your personal YouTube channels",
    "merge_strategy": "append"
  },
  "channels": [
    {
      "name": "Channel Name",
      "channel_id": "@channelhandle",
      "url": "https://www.youtube.com/@channelhandle",
      "priority": "HIGH",
      "description": "What this channel covers"
    }
  ]
}
```

---

## Examples

**Check all sources:**
```
User: "check for upgrades"
→ Runs Anthropic tool
→ Checks YouTube channels
→ Combines results into prioritized report
```

**Check specific source type:**
```
User: "check Anthropic only"
→ Runs only Anthropic tool
→ Skips YouTube check
```

**Force full check:**
```
User: "force check all sources"
→ Runs with --force flag
→ Ignores state, checks everything
```
