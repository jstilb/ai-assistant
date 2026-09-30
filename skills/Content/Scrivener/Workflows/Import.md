# Import Workflow

Bring external writing (Obsidian markdown, plain text, RTF) into a Scrivener project. Designed for "move my stories/writing into Scrivener" requests — Jm's writing lives in `~/Desktop/obsidian/Writing/`.

## Step 1: Scope and plan

1. List the source files and confirm the set with Jm (which stories, which project, new project vs existing).
2. Read `../FileFormat.md` and `../SafetyRules.md`.
3. Plan the target binder structure per `../BestPractices.md` — e.g. one folder per story with scenes as documents, or one document per story. Propose; don't assume.

## Step 2: Choose the import path (safest capable mechanism)

| Situation | Path |
|-----------|------|
| Default — any number of files | **Staged import**: convert + stage files, Jm runs File > Import in Scrivener (zero package risk) |
| Jm wants ongoing two-way editing outside Scrivener | **Sync with External Folder** — Jm enables it in Scrivener; Kaya then works in the sync folder, never the package |
| Jm explicitly asks Kaya to do it end-to-end, GUI path refused | **Direct package write** — all SafetyRules gates, on a copy first |

## Step 3a: Staged import (default)

```bash
# Convert markdown → RTF (macOS textutil; handles md poorly — go via HTML for formatting)
textutil -convert html <source.md> -output /tmp/story.html && textutil -convert rtf /tmp/story.html -output <staging>/<Title>.rtf
# Plain text is also fine — Scrivener imports .txt and .md directly (as plain text)
```

Stage into a clean folder mirroring the planned binder structure (subfolders become binder folders on import). Deliver: the staged folder path + a 3-line instruction for Jm (File > Import > Files… into which binder folder).

## Step 3b: Direct package write (exception path)

Only with explicit Jm approval for this specific run. Rehearse on a throwaway copy of the target project first; then, on the real one: SafetyRules Gates 1–3, then per document — generate a new UUID (`uuidgen`), create `Files/Data/<UUID>/content.rtf` (textutil-converted) + `synopsis.txt`, insert the `<BinderItem>` under the planned parent in `.scrivx`, preserving all unknown XML untouched. Paired mutations only; `search.indexes` untouched (Scrivener rebuilds).

## Step 4: Verify

`bun Tools/Inspect.ts <project.scriv> --check` — imported items present, no orphans, no parse errors. Word counts (`--words`) should roughly match the sources. Jm opens the project in Scrivener as final confirmation; source files are never deleted by this workflow (Jm archives them once satisfied).
