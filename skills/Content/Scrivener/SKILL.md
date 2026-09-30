---
name: Scrivener
description: Scrivener 3 project administration — read-only inspection, lightweight organization audits, safe restructuring, and importing external writing into .scriv projects. USE WHEN scrivener, scriv project or package, scrivener binder, organize or restructure scrivener, scrivener backup, OR move stories or writing into scrivener.
---

# Scrivener

Administrative management of Scrivener 3 projects: inventory, organization audit, and safe restructuring/import. Maximizes value with minimal structure — the skill's doctrine is *lightweight organization* (see `BestPractices.md`), and its write discipline is *never risk a manuscript* (see `SafetyRules.md`).

## Voice Notification

→ Use `notifySync()` from `lib/core/NotificationService.ts`

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **Inspect** | "what's in my scrivener project", "show the binder", "scrivener status" | `Workflows/Inspect.md` |
| **Organize** | "organize/clean up/audit my scrivener project", "restructure the binder" | `Workflows/Organize.md` |
| **Import** | "move/import stories, markdown, or notes into scrivener" | `Workflows/Import.md` |

## Hard Rules (non-negotiable)

1. **Read `SafetyRules.md` before ANY operation that writes inside a `.scriv` package.** No exceptions.
2. **Never modify a project while Scrivener is running or a cloud sync is mid-transfer.** Tools check for lock files; workflows also check `pgrep -x Scrivener`.
3. **Verified backup before every write** — `Tools/Backup.ts` must exit 0 first.
4. **Prefer Scrivener's own Import / External Folder Sync over touching package internals** — the vendor-sanctioned write path.
5. **Never run write operations against Jm's real projects for testing** — use a throwaway copy.

## Quick Reference

- **Inventory a project:** `bun Tools/Inspect.ts <path.scriv> [--words] [--check] [--format json]` (read-only, always safe)
- **Backup a project:** `bun Tools/Backup.ts <path.scriv>` → verified zip in `~/Documents/ScrivenerBackups/`
- **Discover Jm's projects:** `mdfind -name .scriv` (never hardcode paths — projects move)
- **Format internals:** read `FileFormat.md` · **Write gates:** read `SafetyRules.md` · **Organization doctrine:** read `BestPractices.md`

## Examples

**Example 1: Project inventory**
```
User: "What's the state of my On Set scrivener project?"
→ Invokes Inspect workflow
→ Runs Tools/Inspect.ts --words --check (read-only)
→ Returns binder tree with labels/statuses, word counts, compile state, integrity notes
```

**Example 2: Organization audit**
```
User: "My scrivener binder is a mess — help me organize it"
→ Invokes Organize workflow
→ Inspects project, judges against BestPractices.md
→ Delivers a recommendations report; applies only Jm-approved changes, backup-first
```

**Example 3: Import writing from Obsidian**
```
User: "Move my short stories into scrivener"
→ Invokes Import workflow
→ Plans the target binder structure, converts markdown via textutil
→ Uses Scrivener's sanctioned import path; direct package writes only with backup + closed project
```

## Output Configuration

- **Reports/audits:** `MEMORY/Scrivener/YYYY-MM-DD/` via `resolveOutputPath()` from `lib/core/OutputPathResolver.ts`
- **Backups (documented override):** `~/Documents/ScrivenerBackups/` — deliberately outside `~/.claude`, whose repo auto-commits its whole tree; Jm's manuscripts must never land in git.
