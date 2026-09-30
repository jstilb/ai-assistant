# PublicSync — Sync Workflow

Mirrors `~/.claude/` to the public `[user]/ai-assistant` GitHub repo.

## Pre-flight Checks

Before running the sync, verify:

1. **GitHub auth available:** `GITHUB_TOKEN` in `~/.claude/secrets.json` (used by launchd), or SSH interactively:
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
1. Load `State/blocklist.yaml` — **aborts** if it is missing, invalid, or has no `allowedTopLevel`
2. Clone or pull the staging repo (`/tmp/pai-public-staging/`) — aborts if the remote lost `main` (repo recreated → use `--fresh`)
3. Walk source files with blocklist filtering (Pass 1) — only allowed top-level entries are even descended into
4. Transform content: normalize paths, strip usernames / owner e-mail (Pass 2)
5. Scan each file for secret patterns AND blocked identifiers (Pass 3) — any hit aborts the whole run
6. Copy only changed files (incremental via SHA-256) and delete mirror paths the blocklist no longer allows (prune)
7. Run 3-layer safety validator on the staged diff
8. Commit: one prune commit (if any), then semantic commits grouped by skill
9. Push `main` to `github.com/[user]/ai-assistant`
10. Update `State/sync-state.json` with new hashes

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

## Recreating the repo from scratch

See `Workflows/Recreate.md` — delete + recreate EMPTY + `--auto --fresh`. Jm-gated at the delete.

## Safety Rules

- NEVER bypass the safety validator
- NEVER force-push the public repo
- NEVER add a top-level dir to `allowedTopLevel` without running `Tools/FreshExport.ts` first
- NEVER remove an entry from `blockedIdentifiers` — exclude the offending path instead
- Run `--dry-run` before every production sync
- The sync is idempotent — running twice with no changes = 0 commits
