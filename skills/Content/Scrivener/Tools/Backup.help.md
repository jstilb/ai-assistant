# Backup.ts

Timestamped, verified zip backup of a Scrivener 3 `.scriv` project. Mandatory Gate 2 of `SafetyRules.md` — no write operation touches a package until this exits 0.

## Usage

```bash
bun ~/.claude/skills/Content/Scrivener/Tools/Backup.ts <project.scriv> [options]
```

## Options

| Flag | Effect |
|------|--------|
| `--out-dir <dir>` | Destination (default `~/Documents/ScrivenerBackups/`) |
| `--force` | Proceed despite a lock file (warns; risks an inconsistent copy) |
| `--help` | Usage |

## Behavior

1. Refuses if a `*.lock` file is present in the package root (project likely open in Scrivener) unless `--force`.
2. Zips the package to `<out-dir>/<name>-backup-YYYYMMDD-HHMMSS.zip`.
3. Verifies: `unzip -t` integrity **and** file-count parity between the zip and the on-disk package. Any mismatch → exit 1 with the zip retained for inspection.

## Why the default is outside `~/.claude`

The kaya repo auto-commits its whole tree. Backups contain Jm's manuscripts and must never land in git history — so they default to `~/Documents/ScrivenerBackups/`, not `MEMORY/`.

## Exit codes

`0` backup written and verified · `1` refusal (lock), zip/verify failure, or bad arguments

## Example

```bash
bun Backup.ts ~/Desktop/projects/on_set/on_set.scriv
# OK: backup written and verified (312 files)
# /Users/[user]/Documents/ScrivenerBackups/on_set-backup-20260814-101500.zip
```
