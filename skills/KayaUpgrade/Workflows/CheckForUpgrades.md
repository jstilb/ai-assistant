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
bun ~/.claude/skills/KayaUpgrade/Tools/Anthropic.ts
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
bun ~/.claude/skills/KayaUpgrade/Tools/YouTube.ts
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

**Note:** Additional channels can be added in `~/.claude/skills/KayaUpgrade/youtube-channels.json`

---

### Step 2b: (Alternative) Manual YouTube Check

If the YouTube.ts tool is unavailable, you can manually check channels:

**Load channel configuration (merges base + user customizations):**
```bash
bun ~/.claude/skills/CORE/Tools/LoadSkillConfig.ts ~/.claude/skills/KayaUpgrade youtube-channels.json
```

**For each channel, check for new videos:**
```bash
yt-dlp --flat-playlist --dump-json "https://www.youtube.com/@channelhandle/videos" 2>/dev/null | head -5
```

**Compare against state:**
```bash
cat ~/.claude/skills/KayaUpgrade/State/youtube-videos.json
```

**For new videos, extract transcripts:**
```bash
bun ~/.claude/skills/CORE/Tools/GetTranscript.ts "<video-url>"
```

**Update state** with new video IDs (keep last 100 per channel).

---

### Step 3: Combine Results

Present a unified report:

```markdown
# Upgrade Check Results
**Date:** [timestamp]

## 🔥 HIGH PRIORITY
[Must-review features/changes for Kaya]

## 📌 MEDIUM PRIORITY
[Interesting updates to check]

## 📝 LOW PRIORITY
[FYI information]

## 🎬 New Videos
[List of new videos with transcripts and key insights]
```

---

### Step 4: Provide Recommendations

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
