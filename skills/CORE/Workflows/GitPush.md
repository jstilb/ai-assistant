# Git Workflow - Push Updates

**Purpose:** Complete workflow for committing and pushing changes to the PRIVATE Kaya repository (`~/.claude`)

**When User Says:** "push changes" or "update repo" or "commit and push"

---

## ⚠️ CRITICAL: TWO REPOS - NEVER CONFUSE

| Repository | Directory | Remote | Purpose |
|------------|-----------|--------|---------|
| **PRIVATE Kaya** | `~/.claude/` | `danielmiessler/.claude.git` | Personal Kaya instance |
| **PUBLIC Kaya** | `~/Projects/Kaya/` | `danielmiessler/Kaya.git` | Open source template |

**This workflow is for the PRIVATE repo ONLY.**

Before EVERY push: `git remote -v` must show `.claude.git` NOT `Kaya.git`

---

## What This Means

- Update documentation FIRST (before committing)
- Commit all current changes (staged and unstaged)
- Push to the private repository
- This is a FULL workflow: docs → git add → git commit → git push

---

## MANDATORY Workflow Steps

### 1. Verify Location and Remote (CRITICAL SECURITY)

```bash
# MUST be in ~/.claude (or $KAYA_DIR)
cd ~/.claude && pwd
# Expected output: $HOME/.claude (your home directory + .claude)

# MUST show the PRIVATE repo
git remote -v
# Expected: origin pointing to your PRIVATE .claude repo
# MUST NOT show: github.com/danielmiessler/Kaya.git (the public repo)
```

**⛔ STOP IMMEDIATELY if:**
- `pwd` shows `~/Projects/Kaya` or anything other than `~/.claude`
- `git remote -v` shows `danielmiessler/Kaya.git` - this is the PUBLIC repo, not your private one

**This is a HARD STOP condition.** Never proceed if verification fails.

### 2. Review Current Changes

```bash
git status  # See all changes
git diff  # Review unstaged changes
git diff --staged  # Review staged changes
```

### 3. Update Documentation (If Needed)

For significant changes, create a system update entry before committing:

```bash
# Create update entry (if changes are significant)
bun ~/.claude/skills/System/Tools/CreateUpdate.ts \
  --title "Your 4-8 Word Title" \
  --significance moderate \
  --change-type skill_update \
  --files "path/to/file1,path/to/file2" \
  --purpose "Why this change was made" \
  --improvement "What should be better now"

# Regenerate index
bun ~/.claude/skills/System/Tools/UpdateIndex.ts
```

**Skip documentation for:** Minor fixes, typos, MEMORY/ changes, auto-generated files.

This ensures documentation is INCLUDED in the commit, keeping docs in sync with code.

### 4. Stage All Changes (Including Doc Updates)

```bash
git add .  # Stage all changes including documentation updates
# OR selectively stage specific files if needed
```

### 5. Create Commit with Descriptive Message

```bash
git commit -m "$(cat <<'EOF'
<descriptive commit message>

- Key change 1
- Key change 2
- Key change 3

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

- Commit message should describe WHAT changed and WHY
- Follow repository's commit message style (check git log)
- Use HEREDOC format for proper formatting

### 6. Push to Remote

```bash
git push origin <branch-name>
```

- Push current branch to origin
- Confirm push successful

### 7. Verify and Report

```bash
git status  # Confirm clean working directory
```

- Report commit hash, files changed, and push status to user
- Confirm documentation was updated and included in commit

---

## What to Commit

- Modified files that are part of the work
- New files that should be tracked
- Deleted files (properly staged with git rm)

---

## What NOT to Commit

- Files that likely contain secrets (.env, credentials.json, etc.)
- Temporary test files (use scratchpad for those)
- Log files with sensitive data
- Warn user if attempting to commit sensitive files

---

## Security Checklist (ALWAYS)

- ✅ Verified we're in ~/.claude/ directory
- ✅ Verified remote is the correct private repository
- ✅ Reviewed changes for sensitive data
- ✅ Commit message is descriptive and professional
- ✅ No secrets or credentials in committed files

---

## Example Complete Workflow

```bash
# 1. Verify location and remote
pwd && git remote -v

# 2. Review changes
git status
git diff

# 3. Stage and commit
git add .
git commit -m "feat: add git workflow documentation to CORE skill"

# 4. Push
git push origin feature/enhanced-dashboard-metrics

# 5. Verify
git status
```

---

## CRITICAL

**This workflow is for the PRIVATE `~/.claude` repo ONLY.**

| If User Says... | What to Do |
|-----------------|------------|
| "push to Kaya repo" | ✅ Use this workflow (PRIVATE) |
| "update the Kaya repo" | ✅ Use this workflow (PRIVATE) |
| "push to Kaya repo" | ⚠️ STOP - use Kaya skill instead |
| "update Kaya" | ⚠️ STOP - clarify which repo |

For PUBLIC Kaya repo (`~/Projects/Kaya/`):
- Use the **Kaya skill** workflows
- ALWAYS sanitize content first
- See CRITICAL SECURITY section in CORE skill

---

**Related Documentation:**
- ~/.claude/skills/CORE/SKILL.md (CRITICAL SECURITY section)
- ~/.claude/skills/CORE/SecurityProtocols.md
