# UpdatePatterns Workflow

Update Fabric patterns from the upstream repository.

---

## Workflow Steps

### Step 1: Check Fabric CLI

```bash
if ! command -v fabric &> /dev/null; then
  echo "ERROR: fabric CLI not installed"
  echo "Install with: go install github.com/danielmiessler/fabric@latest"
  exit 1
fi
echo "Fabric CLI found: $(which fabric)"
```

### Step 2: Get Current Pattern Count

```bash
BEFORE_COUNT=$(ls -d ~/.claude/skills/Intelligence/Fabric/Patterns/*/ 2>/dev/null | wc -l | tr -d ' ')
echo "Current patterns: $BEFORE_COUNT"
```

### Step 3: Update Patterns

```bash
# Run fabric update command
fabric -U

# Check exit status
if [ $? -eq 0 ]; then
  echo "Fabric patterns updated successfully"
else
  echo "WARNING: fabric -U returned non-zero exit code"
fi
```

### Step 4: Sync to Local Storage (if needed)

If patterns are stored in a different location (e.g., `~/.config/fabric/patterns/`), sync them:

```bash
# Check where fabric stores patterns
FABRIC_PATTERNS="$HOME/.config/fabric/patterns"
LOCAL_PATTERNS="$HOME/.claude/skills/Intelligence/Fabric/Patterns"

if [ -d "$FABRIC_PATTERNS" ]; then
  echo "Syncing from $FABRIC_PATTERNS to $LOCAL_PATTERNS..."
  rsync -av --delete "$FABRIC_PATTERNS/" "$LOCAL_PATTERNS/"
fi
```

### Step 5: Report Results

```bash
AFTER_COUNT=$(ls -d ~/.claude/skills/Intelligence/Fabric/Patterns/*/ 2>/dev/null | wc -l | tr -d ' ')
echo ""
echo "=== Pattern Update Complete ==="
echo "Before: $BEFORE_COUNT patterns"
echo "After:  $AFTER_COUNT patterns"
echo "Change: $((AFTER_COUNT - BEFORE_COUNT)) patterns"
```

---

## Alternative: Manual Git Update

If fabric CLI update fails, update manually:

```bash
cd ~/.claude/skills/Fabric
# If tracking upstream fabric repo
git pull origin main

# Or download specific patterns
curl -sL "https://raw.githubusercontent.com/danielmiessler/fabric/main/patterns/{pattern_name}/system.md" \
  -o "Patterns/{pattern_name}/system.md"
```

---

## Troubleshooting

**"fabric: command not found"**
- Install fabric: `go install github.com/danielmiessler/fabric@latest`
- Or use Homebrew: `brew install fabric`

**Patterns not updating**
- Check network connectivity
- Verify fabric config: `fabric --help`
- Try manual git pull from fabric repo

**Permission denied**
- Check write permissions on `~/.claude/skills/Intelligence/Fabric/Patterns/`
- Run with appropriate permissions

---

## Output

Report pattern count before/after and any new patterns added.
