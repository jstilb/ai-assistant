# UpdatePatterns Workflow

Update Fabric patterns from the upstream repository. Captures pre-pull state, shows diffs of new/modified patterns, and writes an accurate pattern count to the `loaded` sentinel.

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

### Step 2: Capture Pre-Pull State

Record existing patterns and their sizes before any update:

```bash
LOCAL_PATTERNS="$HOME/.claude/skills/Intelligence/Fabric/Patterns"

# Capture list of existing patterns and their sizes before pull
BEFORE_LIST=$(ls -d "$LOCAL_PATTERNS"/*/ 2>/dev/null | xargs -I{} basename {} | sort)
BEFORE_COUNT=$(echo "$BEFORE_LIST" | grep -c . || echo 0)
echo "Before: $BEFORE_COUNT patterns"

# Snapshot sizes for modified-pattern detection
declare -A BEFORE_SIZES
while IFS= read -r pattern; do
  SYSTEM_MD="$LOCAL_PATTERNS/$pattern/system.md"
  if [ -f "$SYSTEM_MD" ]; then
    BEFORE_SIZES[$pattern]=$(wc -c < "$SYSTEM_MD" | tr -d ' ')
  fi
done <<< "$BEFORE_LIST"
```

### Step 3: Run pinned git checkout (or fabric -U, opt-in)

The pinned git checkout is the default — it pulls a known-good upstream tag instead of
tracking `main` unpinned. `fabric -U` cannot be pinned to a tag (it always takes whatever
is newest on fabric's own update channel), so it stays an explicit opt-in via
`FABRIC_UNPINNED=1`, not the default.

```bash
FABRIC_PIN_TAG="${FABRIC_PIN_TAG:-v1.4.478}"
FABRIC_PATTERNS="$HOME/.config/fabric/patterns"

if [ "${FABRIC_UNPINNED:-0}" = "1" ]; then
  echo "FABRIC_UNPINNED=1 — using unpinned fabric -U"
  fabric -U
  FABRIC_UPDATE_STATUS=$?
else
  if [ -d "$FABRIC_PATTERNS" ]; then
    (cd "$FABRIC_PATTERNS" && git fetch --tags origin && git checkout --detach "refs/tags/$FABRIC_PIN_TAG")
    FABRIC_UPDATE_STATUS=$?
  else
    echo "WARNING: $FABRIC_PATTERNS does not exist — nothing to pin"
    FABRIC_UPDATE_STATUS=1
  fi
fi

if [ "$FABRIC_UPDATE_STATUS" -eq 0 ]; then
  echo "Fabric patterns updated successfully"
else
  echo "WARNING: update failed (pinned tag $FABRIC_PIN_TAG, or fabric -U) — check network/tag validity"
fi
```

### Step 4: Sync to Local Storage

If patterns are stored in a different location (e.g., `~/.config/fabric/patterns/`), sync them:

```bash
FABRIC_PATTERNS="$HOME/.config/fabric/patterns"
LOCAL_PATTERNS="$HOME/.claude/skills/Intelligence/Fabric/Patterns"

if [ -d "$FABRIC_PATTERNS" ]; then
  echo "Syncing from $FABRIC_PATTERNS to $LOCAL_PATTERNS..."
  rsync -av --delete "$FABRIC_PATTERNS/" "$LOCAL_PATTERNS/"
fi
```

### Step 5: Compute Diff — New and Modified Patterns

```bash
AFTER_LIST=$(ls -d "$LOCAL_PATTERNS"/*/ 2>/dev/null | xargs -I{} basename {} | sort)

# New patterns (in AFTER but not in BEFORE)
NEW_PATTERNS=$(comm -13 <(echo "$BEFORE_LIST") <(echo "$AFTER_LIST"))
NEW_COUNT=$(echo "$NEW_PATTERNS" | grep -c . 2>/dev/null || echo 0)

# Deleted patterns (in BEFORE but not in AFTER)
DELETED_PATTERNS=$(comm -23 <(echo "$BEFORE_LIST") <(echo "$AFTER_LIST"))
DELETED_COUNT=$(echo "$DELETED_PATTERNS" | grep -c . 2>/dev/null || echo 0)

# Modified patterns (existed before, still exist, but size changed)
MODIFIED_PATTERNS=""
while IFS= read -r pattern; do
  SYSTEM_MD="$LOCAL_PATTERNS/$pattern/system.md"
  if [ -f "$SYSTEM_MD" ] && [ -n "${BEFORE_SIZES[$pattern]+_}" ]; then
    AFTER_SIZE=$(wc -c < "$SYSTEM_MD" | tr -d ' ')
    if [ "$AFTER_SIZE" != "${BEFORE_SIZES[$pattern]}" ]; then
      MODIFIED_PATTERNS="$MODIFIED_PATTERNS $pattern"
    fi
  fi
done <<< "$AFTER_LIST"
MODIFIED_COUNT=$(echo "$MODIFIED_PATTERNS" | tr ' ' '\n' | grep -c . 2>/dev/null || echo 0)
```

### Step 6: Display Summary of Changes

```bash
echo ""
echo "=== Pattern Update Summary ==="

if [ -n "$NEW_PATTERNS" ]; then
  # Cap display at 10 items with "... and N more" for large batches
  NEW_DISPLAY=$(echo "$NEW_PATTERNS" | head -10)
  NEW_OVERFLOW=$(( NEW_COUNT - 10 ))
  echo "New patterns ($NEW_COUNT): $NEW_DISPLAY"
  if [ $NEW_OVERFLOW -gt 0 ]; then
    echo "  ... and $NEW_OVERFLOW more"
  fi
else
  echo "New patterns: none"
fi

if [ -n "$MODIFIED_PATTERNS" ]; then
  MOD_DISPLAY=$(echo "$MODIFIED_PATTERNS" | tr ' ' '\n' | head -10)
  MOD_OVERFLOW=$(( MODIFIED_COUNT - 10 ))
  echo "Modified patterns ($MODIFIED_COUNT): $MOD_DISPLAY"
  if [ $MOD_OVERFLOW -gt 0 ]; then
    echo "  ... and $MOD_OVERFLOW more"
  fi

  # Show first 200 chars of diff for modified patterns (up to 3)
  echo ""
  echo "--- Modified pattern diffs (first 200 chars) ---"
  for pattern in $(echo "$MODIFIED_PATTERNS" | tr ' ' '\n' | head -3); do
    SYSTEM_MD="$LOCAL_PATTERNS/$pattern/system.md"
    if [ -f "$SYSTEM_MD" ]; then
      DIFF_PREVIEW=$(head -c 200 "$SYSTEM_MD")
      echo "[$pattern]: $DIFF_PREVIEW"
    fi
  done
else
  echo "Modified patterns: none"
fi

if [ -n "$DELETED_PATTERNS" ]; then
  echo "Deleted patterns ($DELETED_COUNT): $DELETED_PATTERNS"
fi

if [ -z "$NEW_PATTERNS" ] && [ -z "$MODIFIED_PATTERNS" ] && [ -z "$DELETED_PATTERNS" ]; then
  echo "No changes — patterns already up to date."
fi
```

### Step 7: Report Count and Update Sentinel

```bash
# Count total patterns after pull (dynamic — not hardcoded)
PATTERN_COUNT=$(ls -d "$LOCAL_PATTERNS"/*/ 2>/dev/null | wc -l | tr -d ' ')

echo ""
echo "=== Pattern Update Complete ==="
echo "Before: $BEFORE_COUNT patterns"
echo "After:  $PATTERN_COUNT patterns"
echo "Change: $((PATTERN_COUNT - BEFORE_COUNT)) patterns"

# Update loaded sentinel with accurate count metadata
echo "${PATTERN_COUNT}" > "$LOCAL_PATTERNS/loaded"
echo "Sentinel updated: $LOCAL_PATTERNS/loaded (count: $PATTERN_COUNT)"
```

---

## Alternative: Manual Git Update

If the pinned checkout in Step 3 fails, update manually — same pin, never `main` unpinned:

```bash
cd ~/.claude/skills/Fabric
FABRIC_PIN_TAG="${FABRIC_PIN_TAG:-v1.4.478}"
git fetch --tags origin && git checkout --detach "refs/tags/$FABRIC_PIN_TAG"
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

Reports:
- Pattern count before and after pull
- New patterns added (list, capped at 10 + overflow count)
- Modified patterns with first 200-char diff preview
- Deleted patterns
- "No changes" if already up to date
- Updated `loaded` sentinel with accurate count
