# PublicSync — DryRun Workflow

Preview what would be synced to the public repo WITHOUT pushing anything.
Safe to run at any time.

## Voice Notification

**When executing this workflow, do BOTH:**

1. **Send voice notification:**
   ```bash
   curl -s -X POST http://localhost:8888/notify \
     -H "Content-Type: application/json" \
     -d '{"message": "Running the DryRun workflow in the PublicSync skill to preview pending changes"}' \
     > /dev/null 2>&1 &
   ```

2. **Output text notification:**
   ```
   Running the **DryRun** workflow in the **PublicSync** skill to preview pending changes...
   ```

---

## Run Dry-Run

```bash
bun ~/.claude/skills/System/PublicSync/Tools/SyncRunner.ts --dry-run --verbose
```

---

## Understanding the Output

The dry-run output shows:

### Changed Files
Files that would be synced (content has changed since last sync):
```
[DRY RUN] Files that would be synced:
  + skills/Productivity/DailyBriefing/Tools/WeatherService.ts
  + skills/Intelligence/Research/SKILL.md
  + CLAUDE.md
```

### Blocked Files
Files containing secret patterns (would be excluded):
```
  [BLOCKED] skills/SomeSkill/config.ts: [A-Z_]+_KEY=
```

### Commit Preview
How changes would be grouped into commits:
```
[DRY RUN] Commit messages that would be generated:
  feat(DailyBriefing): sync 2 files
  feat(Research): update SKILL.md
```

---

## Interpreting Results

| Result | Meaning | Action |
|--------|---------|--------|
| "No changes to sync" | All files match last sync state | Nothing to do |
| Files listed | These would be pushed | Review, then run `--auto` |
| Files blocked | Secrets detected | Investigate those files |
| Unexpected files | Personal files in the list | Update blocklist.yaml |

---

## If Something Looks Wrong

**Personal file appearing in changed list:**
Add its path to `State/blocklist.yaml`:
```yaml
additionalExcludedPaths:
  - path/to/personal/file
```

**Too many files listed:**
Check if a bulk update happened. Review with:
```bash
bun ~/.claude/skills/System/PublicSync/Tools/SyncRunner.ts --dry-run 2>&1 | wc -l
```

**Secrets blocked unexpectedly:**
The scanner may have a false positive. Review the file:
```bash
# Check which line triggered the block
cat ~/.claude/path/to/file | grep -n "KEY\|SECRET\|TOKEN\|sk-ant\|ghp_"
```

---

## Run Live After Reviewing

Once dry-run output looks correct:

```bash
bun ~/.claude/skills/System/PublicSync/Tools/SyncRunner.ts --auto
```

See `Workflows/Sync.md` for full live sync instructions.
