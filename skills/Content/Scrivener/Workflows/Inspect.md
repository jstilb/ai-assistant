# Inspect Workflow

Read-only inventory of a Scrivener project. Always safe — the tool never writes inside the package.

## Step 1: Locate the project

If Jm named a project, resolve it; otherwise discover candidates:

```bash
mdfind -name .scriv | grep '\.scriv$'
find ~/Desktop -maxdepth 3 -name "*.scriv" -type d 2>/dev/null
```

Never hardcode project paths — projects move between `~/Desktop/projects/` and Google Drive. If multiple match, ask which one (or report on all when Jm asked for an overview).

## Step 2: Run the inspector

## Intent-to-Flag Mapping

| User Says | Flags | Effect |
|-----------|-------|--------|
| (default), "show me the project" | `--check` | Structure + integrity, fast |
| "word counts", "how much have I written" | `--words --check` | Adds per-doc + draft totals (slower; textutil per doc) |
| "machine readable", feeding another tool | `--format json` | Full JSON report |
| "quick look", "just the structure" | *(no flags)* | Tree only, fastest |

## Execute Tool

```bash
bun ~/.claude/skills/Content/Scrivener/Tools/Inspect.ts <project.scriv> [FLAGS_FROM_INTENT_MAPPING]
```

## Step 3: Present

Relay the report conversationally: lead with what Jm asked (word count, structure, state), flag integrity warnings (lock file present, orphan Data dirs) in plain language. For a saved report, write to `MEMORY/Scrivener/YYYY-MM-DD/` via `resolveOutputPath()`.

If a lock file is reported, note that the project appears open in Scrivener and that no write operation may proceed (see `../SafetyRules.md`).
