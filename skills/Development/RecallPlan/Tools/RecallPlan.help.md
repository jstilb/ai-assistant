# RecallPlan.ts

List and recall Claude Code plan-mode plans from `~/.claude/plans/*.md`, with a readable
title/date/excerpt derived from each file's content instead of its raw filename.

## Usage

```bash
bun RecallPlan.ts list [--limit N] [--dir <path>] [--json]
bun RecallPlan.ts show <selector> [--dir <path>] [--json] [--lines N]
```

## Commands

### `list`

Prints the most recent plans, newest first.

| Flag | Default | Effect |
|------|---------|--------|
| `--limit N` | `10` | Max number of plans to show |
| `--dir <path>` | `~/.claude/plans` | Override the plans directory (mainly for testing) |
| `--json` | off | Emit an array of `PlanSummary` objects instead of formatted text |

Each entry shows: 1-based index, ISO date (from file mtime), title (first markdown `# H1`,
or a title-cased filename fallback), the filename, and a short excerpt (the first few
non-heading lines after the title).

Excluded from listings: `TEMPLATE-plan-prompt.md` (a reusable prompt template, not a plan)
and anything that isn't a top-level `.md` file (e.g. the `Specs/` subdirectory).

### `show <selector>`

Prints one plan's path, title, date, and content — for injecting into a session's
context after Jm picks a plan from `list`.

`<selector>` is resolved, in order:
1. A 1-based numeric index (matches the position from `list`'s same directory/limit)
2. An exact filename (with or without the `.md` extension)
3. A case-insensitive substring match against the filename or title

If more than one plan matches a substring, the tool throws an **"Ambiguous selector"**
error listing the candidates (index + filename) instead of guessing — resolve it by
passing the numeric index or a more specific string.

| Flag | Default | Effect |
|------|---------|--------|
| `--lines N` | full file | Cap the printed body to the first N lines |
| `--dir <path>` | `~/.claude/plans` | Override the plans directory |
| `--json` | off | Emit `{ ...PlanSummary, content }` as JSON |

## Examples

```bash
# Last 5 plans, human-readable
bun RecallPlan.ts list --limit 5

# Recall the 2nd most recent plan, full content
bun RecallPlan.ts show 2

# Find a plan by topic (throws if ambiguous)
bun RecallPlan.ts show calendarassistant

# JSON output for programmatic use
bun RecallPlan.ts list --json
bun RecallPlan.ts show 1 --json --lines 20
```

## Tests

```bash
bun test ~/.claude/skills/Development/RecallPlan/Tools/RecallPlan.test.ts
```

Hermetic — uses a `mkdtemp`'d directory standing in for `~/.claude/plans`, never touches
live plan files.
