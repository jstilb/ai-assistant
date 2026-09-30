# PublicSync — Recreate Workflow (delete the public mirror, republish clean)

Jm ruled 2026-09-21 (LucidTask `t-mu8nxxeu-nbcnj`, activity 10801): **Option 2 — delete the
public mirror and recreate it from a clean, correctly-blocklisted sync.** This workflow is the
runbook for that one-time operation. The strategy is decided; the only remaining human step is
the go-ahead immediately before the irreversible delete.

**Target repo: `github.com/[user]/ai-assistant`** (public, repo ID 1163161873, 1 fork
`sam00101011/ai-assistant`, 0 stars; verified with `gh` on 2026-09-27). `SyncRunner.ts` has always
pointed at `ai-assistant`.

> **DO NOT delete `[user]/kaya`.** The task text names "the public mirror github.com/[user]/kaya",
> but `[user]/kaya` is the **PRIVATE Kaya source repository** — the `origin` of `~/.claude` itself
> (`visibility: PRIVATE`, pushed 2026-09-25). It 404s anonymously because it is private, not because
> it is missing. The only repo this workflow deletes is `[user]/ai-assistant`.

## What "clean" means (all enforced by code, verified by FreshExport)

| Property | How it is enforced |
|---|---|
| Only allowed paths are published | `blocklist.yaml` `allowedTopLevel` — fail-closed top-level allowlist |
| No Sheet / Drive IDs anywhere | `InformationManager` + `LifeOS` skills excluded; `blockedIdentifiers` literal denylist aborts the sync on any hit |
| No `MEMORY/`, `context/`, `KAYASECURITYSYSTEM/`, `Commands/` stubs | not in `allowedTopLevel`; README preservation cannot re-admit them |
| No SQLite / WAL / logs / per-skill State, Data, config | extension + `excludedSkillSubdirs` rules |
| Orphans can never accumulate again | `SyncRunner` prunes mirror paths the blocklist no longer allows on every run |
| Broken/missing blocklist cannot weaken the sync | loader throws instead of falling back to the built-in default |

## Step 0 — Precondition + review the clean export (agent-doable)

Every command below runs the **live** `~/.claude` tree (`SOURCE_DIR`, `State/blocklist.yaml`), so
the fail-closed code must already be merged to `main`. Check first — if this fails, STOP: the old
fail-open runner would republish the Sheet-ID files into the recreated repo.

```bash
test -f ~/.claude/skills/System/PublicSync/Tools/FreshExport.ts \
  && grep -q '^allowedTopLevel:' ~/.claude/skills/System/PublicSync/State/blocklist.yaml \
  && grep -q -- '--fresh' ~/.claude/skills/System/PublicSync/Tools/SyncRunner.ts \
  && echo "fail-closed PublicSync is live" || echo "NOT MERGED — stop"

bun ~/.claude/skills/System/PublicSync/Tools/FreshExport.ts --remote [user]/ai-assistant
```

Writes the exact publish set to `/tmp/publicsync-fresh-export-<date>/` plus `REPORT.md` /
`report.json`, and diffs it against the live mirror tree. Every gate must read PASS. The
2026-09-27 run is archived at `plans/audits/remediation/theme4-fresh-mirror-export-2026-09-27.md`.

## Step 1 — Pre-flight (Jm, ~2 min)

1. Sheets already restricted? `t-mu8nww6i-1si89` reported all 8 items Restricted on 2026-09-23
   (read-back pending). The recreate does not depend on it, but do it first if still open.
2. Delete and create need the **keyring** OAuth token. The fine-grained `GITHUB_TOKEN` PAT in the
   environment takes precedence and gets HTTP 403 on both (no Administration / createRepository), so
   prefix every `gh auth` / `gh repo delete` / `gh repo create` / `gh repo edit` here with
   `env -u GITHUB_TOKEN`. Add `delete_repo` to the keyring token if it lacks it:
   ```bash
   env -u GITHUB_TOKEN gh auth refresh -h github.com -s delete_repo
   ```
   The push itself uses `secrets.json` `GITHUB_TOKEN`; if that PAT is limited to selected repos,
   add the recreated repo (new ID) to it at github.com/settings/personal-access-tokens
   (Contents: read and write) or the first push is rejected.
3. Pause the nightly so it cannot fire mid-recreate:
   ```bash
   launchctl bootout gui/$(id -u)/com.kaya.publicsync
   ```
4. Discard the stale staging clone (a rebase of old history onto the new repo would republish
   every orphan). `--fresh` does this too; belt and braces:
   ```bash
   mv /tmp/pai-public-staging ~/.Trash/pai-public-staging-$(date +%s) 2>/dev/null || true
   ```

## Step 2 — GATE: irreversible delete (Jm only)

Deleting loses: the repo's stars (0), watchers, issues, the 7 refs of history, inbound links
(`github.com/[user]/ai-assistant` will 404 until Step 3), and the repo ID. **It does not delete
the existing fork `sam00101011/ai-assistant`** — GitHub reparents forks; S-01's PII takedown
against that fork stays a separate action (`project_security_audit_20260901`, checklist 8b/8c).

```bash
gh repo view [user]/ai-assistant --json id,forkCount,stargazerCount   # confirm target
env -u GITHUB_TOKEN gh repo delete [user]/ai-assistant --yes
```

## Step 3 — Recreate EMPTY, then first push (Jm; ~1 min + ~30 s sync)

Create with **no** README / .gitignore / license — an initial commit on the remote would make the
runner rebase and is exactly the failure mode the `--fresh` guard exists to prevent.

```bash
# Restore the old repo's description + topics (capture them with `gh repo view` before Step 2)
env -u GITHUB_TOKEN gh repo create [user]/ai-assistant --public \
  --description "Personal AI Infrastructure — 60+ composable skills, autonomous task execution, voice interaction, and persistent memory. Built on Claude Code."
env -u GITHUB_TOKEN gh repo edit [user]/ai-assistant --add-topic ai-agent,claude,context-engineering,llm,mcp,typescript

# Optional preview (no push):
bun ~/.claude/skills/System/PublicSync/Tools/SyncRunner.ts --dry-run --fresh --verbose

# First push: one baseline commit, hash registry rebuilt from scratch
bun ~/.claude/skills/System/PublicSync/Tools/SyncRunner.ts --auto --fresh
```

`--fresh` discards the staging clone and the SHA-256 registry, treats every allowed file as
changed, runs all three safety layers on the full diff, commits once
(`chore(publicsync): fresh public mirror baseline (N files, fail-closed allowlist)`), pushes
`main` with `-u`, then writes the new `sync-state.json` baseline.

## Step 4 — Verify (agent-doable)

```bash
# Remote tree must now equal the allowed set: 0 orphans, 0 additions, all gates PASS
bun ~/.claude/skills/System/PublicSync/Tools/FreshExport.ts --remote [user]/ai-assistant

# Full-history grep of a throwaway clone for the exact blocked identifiers — expect 0 and 0
git clone -q https://github.com/[user]/ai-assistant /tmp/ai-assistant-verify
sed -n '/^blockedIdentifiers:/,/^[A-Za-z]/p' ~/.claude/skills/System/PublicSync/State/blocklist.yaml | sed -nE 's/^[[:space:]]+- "([^"]{8,})".*/\1/p' > /tmp/ai-assistant-ids.txt
cd /tmp/ai-assistant-verify && git log --all -p | grep -cFf /tmp/ai-assistant-ids.txt ; git ls-files | grep -E '^(MEMORY|context|KAYASECURITYSYSTEM|Commands|\.playwright-mcp)/' | wc -l

bun ~/.claude/skills/System/PublicSync/Tools/SyncRunner.ts --status
```

Expected: `matchesAllowedSet: yes` in the report, `0` for both greps, `--status` showing today's
`lastSync` and the new baseline commit.

## Step 5 — Resume the nightly

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kaya.publicsync.plist
```

From here the ordinary `Sync.md` flow applies: incremental commits by skill group, orphan
pruning on every run, fail-closed on any blocklist problem, secret, or identifier.

## If something goes wrong

- `Remote has no main branch but the staging clone has history` → the repo was recreated and the
  runner refused to push old history. Re-run with `--fresh`.
- `SecretScanError … blocked-identifier:…` → a newly allowed file embeds one of the private IDs.
  Exclude the path (or the skill) in `blocklist.yaml`; never delete the identifier from the denylist.
- `blocklist.yaml … refusing to sync (fail-closed)` → fix the YAML; the runner will not fall back.
- Push rejected (non-fast-forward) → someone committed directly on GitHub. Pull it into the
  staging clone by hand and re-run `--auto`; **never** force-push.
