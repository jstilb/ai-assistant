# Inspect.ts

Read-only inventory and integrity report for a Scrivener 3 `.scriv` project.

**Read-only guarantee:** never writes inside the package; safe to run any time, including while Scrivener is open.

## Usage

```bash
bun ~/.claude/skills/Content/Scrivener/Tools/Inspect.ts <project.scriv> [options]
```

## Options

| Flag | Effect |
|------|--------|
| `--format md\|json` | Output format (default `md`) |
| `--words` | Per-document + draft word counts via macOS `textutil` (slower — one spawn per doc) |
| `--check` | Integrity checks: lock files, binder↔`Files/Data` consistency, derived-file presence |
| `--help` | Usage |

## Report contents

- Project header: scrivx version, Scrivener creator build, package format version, last modified
- Label axis (project-renamable, e.g. Jm's "POV") and status axis with value counts
- Full binder tree with per-item type, title, resolved label/status names, compile inclusion, word count
- Stats: items by type, in-compile count, trash count, draft word total
- `--check`: lock files (project open?), orphan `Files/Data` dirs not in the binder, Text items with no Data dir (empty docs — usually fine), presence of `binder.backup` / `search.indexes`

## Exit codes

`0` success · `1` bad arguments, missing/invalid package, or scrivx parse failure (fails loud — a parse error may mean format drift; see `FileFormat.md`)

## Examples

```bash
# Quick structure look
bun Inspect.ts ~/Desktop/projects/on_set/on_set.scriv

# Full audit input (what the Organize workflow uses)
bun Inspect.ts ~/Desktop/projects/on_set/on_set.scriv --words --check --format json
```
