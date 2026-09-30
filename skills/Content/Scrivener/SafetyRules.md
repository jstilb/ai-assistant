# Scrivener Write-Safety Rules

**Read this before ANY operation that writes inside a `.scriv` package.** These are hard gates, not guidelines — the payload is Jm's manuscripts, and corruption modes documented in the wild include reordered, blank, and missing documents.

## Gate 0: Prefer not writing at all

Scrivener's own **File > Import** and **Sync with External Folder** are the vendor-sanctioned ways to get content in (see `FileFormat.md`). If the task can be done by staging files for Jm to import in the GUI, do that — zero package risk. Direct package writes are the last resort, used only when the GUI path can't do the job and Jm has asked for it.

## Gate 1: Scrivener must be closed, sync settled

- `pgrep -x Scrivener` must return nothing. If Scrivener is running, STOP and tell Jm — never kill the process yourself (unsaved work).
- No lock file (`*.lock`) in the package root. A stale lock after a crash is Jm's call to clear, not Kaya's.
- If the project lives under a cloud-sync path (Google Drive `CloudStorage`, Dropbox, iCloud), confirm sync is idle. Jm's Drive-hosted projects are extra risk: a write mid-transfer can propagate a half-consistent state to every replica.

## Gate 2: Verified backup first

`bun Tools/Backup.ts <project.scriv>` must exit 0 (written AND verified) before the first byte changes. The backup lands in `~/Documents/ScrivenerBackups/` — outside `~/.claude` on purpose: the kaya repo auto-commits its whole tree, and manuscripts must never enter git.

## Gate 3: Consistency-preserving edits only

- `.scrivx` and `Files/Data/<UUID>/` mutate **together** (add/remove = paired).
- Never regenerate an existing `content.rtf` from plain text — it destroys comments, styles, links, and images (see `FileFormat.md`). New documents may be created from `textutil`-converted RTF; existing ones are edited only additively or left to Scrivener.
- Never touch `search.indexes`, `docs.checksum`, `QuickLook/`, or `binder.backup` — all derived.
- Unknown XML elements/attributes round-trip untouched.

## Gate 4: Verify after writing

- Re-run `bun Tools/Inspect.ts <project.scriv> --check` — it must parse cleanly, show the expected structure, and report no new orphan Data dirs.
- Have Jm open the project in Scrivener and confirm before the change is called done. The backup from Gate 2 is retained until Jm confirms.

## Testing rule

Write operations are **never** exercised against Jm's real projects. Test on a throwaway copy (`cp -R` to a scratch dir) or the fixture pattern used at build time. Read-only inspection of real projects is fine.
