# Sync-Skills Workflow

Regenerate the skill index for faster skill discovery.

**Category:** Sync (Source → Kaya)
**Trigger:** `sync skills`, `refresh skills`, `regenerate skill index`, `update skill index`

## Purpose

Keep the skill index (`skills/skill-index.json`) up to date with the current skill set. This enables faster skill loading and discovery without scanning the filesystem.

This is a **Sync** workflow: it scans skills and updates the index file.

## Prerequisites

- `bun` runtime available
- `skills/CORE/Tools/GenerateSkillIndex.ts` exists

## Execution Steps

### 1. Run GenerateSkillIndex

```bash
bun ~/.claude/skills/CORE/Tools/GenerateSkillIndex.ts
```

This scans all skills and regenerates `skills/skill-index.json` with:
- Skill names and paths
- Workflow listings
- Trigger keywords
- Tool inventories

### 2. Verify Output

Check that the index was updated:
```bash
ls -la ~/.claude/skills/skill-index.json
```

### 3. Report Results

Report the number of skills indexed and any changes detected.

## Output

- Updated `skills/skill-index.json`
- Summary of skills indexed

## Schedule

Runs as part of the weekly AutoInfoManager tier. Can also be run manually after skill changes.

## Tools Called

- `skills/CORE/Tools/GenerateSkillIndex.ts` - Index generator

## Related Workflows

- **Sync-All** - Full context refresh (includes this)

## Integration

### Uses
- `skills/CORE/Tools/GenerateSkillIndex.ts` - Index generator

### Feeds Into
- Session startup (faster skill loading)
- Skill discovery and routing
