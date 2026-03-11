# PublicSync — Sync Workflow

Mirrors `~/.claude/` to the public `[user]/ai-assistant` GitHub repo.

## Voice Notification

**When executing this workflow, do BOTH:**

1. **Send voice notification:**
   ```bash
   curl -s -X POST http://localhost:8888/notify \
     -H "Content-Type: application/json" \
     -d '{"message": "Running the Sync workflow in the PublicSync skill to mirror the private codebase to the public repo"}' \
     > /dev/null 2>&1 &
   ```

2. **Output text notification:**
   ```
   Running the **Sync** workflow in the **PublicSync** skill to mirror ~/.claude/ to the public GitHub repo...
   ```

---

## Pre-flight Checks

Before running the sync, verify:

1. **SSH key available:**
   ```bash
   ssh -T git@github.com 2>&1 | head -1
   ```
   Expected: `Hi [user]! You've successfully authenticated...`

2. **Git identity configured:**
   ```bash
   git config --global user.email
   git config --global user.name
   ```

3. **Staging area accessible:**
   ```bash
   ls /tmp/pai-public-staging 2>/dev/null && echo "EXISTS" || echo "FRESH CLONE"
   ```

---

## Step 1: Dry Run First (MANDATORY)

Always preview before pushing:

```bash
bun ~/.claude/skills/System/PublicSync/Tools/SyncRunner.ts --dry-run --verbose
```

Review the output:
- Check which files would be synced
- Verify no personal files are listed
- Confirm commit messages look correct

---

## Step 2: Run Full Sync

If dry-run output looks correct:

```bash
bun ~/.claude/skills/System/PublicSync/Tools/SyncRunner.ts --auto
```

The runner will:
1. Clone or pull the staging repo (`/tmp/pai-public-staging/`)
2. Walk source files with blocklist filtering (Pass 1)
3. Scan each file for secret patterns (Pass 2)
4. Transform content: normalize paths, strip usernames (Pass 3)
5. Copy only changed files (incremental via SHA-256)
6. Run 3-layer safety validator on staged diff
7. Generate semantic commits grouped by skill
8. Push to `git@github.com:[user]/ai-assistant.git`
9. Update `State/sync-state.json` with new hashes

---

## Step 3: Verify

After sync completes:

```bash
# Check last sync status
bun ~/.claude/skills/System/PublicSync/Tools/SyncRunner.ts --status

# Verify the remote repo has the new commits
git -C /tmp/pai-public-staging log --oneline -10
```

---

## Troubleshooting

### Safety check failed
If the validator blocks the push:
- Read the error message — it will name the layer (pattern-scan, path-audit, size-anomaly)
- For pattern-scan: Check the flagged file for actual secrets
- For path-audit: Update `State/blocklist.yaml` if a new path needs blocking
- For size-anomaly: The file is >500KB — investigate before proceeding

### Clone fails
```bash
# Test SSH access
ssh -T git@github.com

# Re-clone manually
rm -rf /tmp/pai-public-staging
git clone git@github.com:[user]/ai-assistant.git /tmp/pai-public-staging
```

### Push conflicts
```bash
git -C /tmp/pai-public-staging pull --rebase
bun ~/.claude/skills/System/PublicSync/Tools/SyncRunner.ts --auto
```

---

## Blocklist Management

To add paths to the exclusion list, edit:
```
~/.claude/skills/System/PublicSync/State/blocklist.yaml
```

No code changes required — the blocklist is config-driven.

---

## Safety Rules

- NEVER bypass the safety validator
- NEVER force-push the public repo
- NEVER add personal data to excluded skill allowlists
- Run `--dry-run` before every production sync
- The sync is idempotent — running twice with no changes = 0 commits
