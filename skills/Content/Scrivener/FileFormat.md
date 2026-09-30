# Scrivener 3 File Format

Ground truth verified 2026-08-14 against Jm's live Scrivener 3.5.2 projects (macOS), cross-checked with community documentation. Literature & Latte publishes **no official schema** — treat field-level detail as reliable community consensus, not vendor spec, and expect unknown elements: **any tool that rewrites `.scrivx` must round-trip elements it doesn't understand, untouched.**

## Package Layout

A `.scriv` is a macOS document package (a folder). Contents:

```
Project.scriv/
├── Project.scrivx        # The spine: binder tree + all project settings (XML)
├── Files/
│   ├── version.txt       # Package format version (currently "23")
│   ├── styles.xml        # Named paragraph/character styles
│   ├── search.indexes    # DERIVED search cache — never edit; Scrivener rebuilds it
│   ├── writing.history   # Word-count history
│   ├── binder.backup     # Regenerated binder snapshot
│   └── Data/
│       └── <UUID>/       # One dir per binder document (folders/empty docs may lack one)
│           ├── content.rtf    # Body text (Apple Cocoa RTF)
│           ├── synopsis.txt   # Index-card text (plain text)
│           ├── notes.rtf      # Inspector notes
│           └── content.comments  # Linked comments/footnotes (when present)
├── Settings/             # Compile presets, UI state, sync markers
├── Snapshots/            # <UUID>.snapshots per-document version history
└── QuickLook/            # Derived macOS preview — non-authoritative
```

A lock file (e.g. `user.lock`) appears in the package root while the project is open. A crash can leave it stale; presence means **do not touch**.

## The `.scrivx` Spine

Root: `<ScrivenerProject Version="2.0" Identifier=… Creator="SCRMAC-…" Modified=…>`.

**Binder tree:** `<Binder>` holds nested `<BinderItem>`:
- Attributes: `UUID` (uppercase hyphenated — the only reliable handle; titles are NOT unique), `Type`, `Created`, `Modified`
- `Type` values seen live: `DraftFolder`, `ResearchFolder`, `TrashFolder`, `Folder`, `Text`, `Image`, `PDF` (extensible enum — special roots are identified by Type, never by title or position)
- Children elements: `<Title>`, `<MetaData>`, `<TextSettings>`, `<Children>` (containers only)

**Per-item `<MetaData>`:** `<IncludeInCompile>Yes</IncludeInCompile>`, `<LabelID>`/`<StatusID>` (foreign keys into project-level settings; `-1` = none), `<CustomMetaData>` with `<MetaDataItem><FieldID>…<Value>…` pairs.

**Project-level settings** (siblings of `<Binder>`):
- `<LabelSettings>`: `<Title>` (the axis name — Jm renames it, e.g. "POV"), `<Labels><Label ID Color>Name</Label>…`
- `<StatusSettings>`: `<Title>`, `<StatusItems><Status ID>Name</Status>…`
- `<CustomMetaDataSettings>`: `<MetaDataField ID Type>` — exactly four types: Text, Checkbox, List, Date
- Also: `Collections`, `Keywords`, `ProjectTargets`, `ProjectBookmarks`

## Content Format

Document text is **Apple Cocoa-flavor RTF** (not RTFD). Quirks that make naive rewrite destructive:
- Comments/footnotes anchor inline as `HYPERLINK` fields targeting `scrivcmt://<UUID>`, bodies in `content.comments`
- Named styles marked with `<$Scr_H::n>…<!$Scr_H::n>` tokens
- Images embed as `\pict`/`pngblip`; internal links point at binder UUIDs

Plain text can be **imported into** a document (becomes minimal RTF), but regenerating an existing `content.rtf` from plain text silently orphans comments, drops styles, breaks links, and deletes images. Convert markdown/text → RTF with macOS `textutil -convert rtf`.

## Consistency Invariants (for external writes)

1. Every added/removed binder item = paired `.scrivx` `<BinderItem>` mutation **and** `Files/Data/<UUID>/` dir mutation, together.
2. `search.indexes` is fully derivative — never maintain it by hand; Scrivener rebuilds on open.
3. `docs.checksum` (when present) is advisory — stale entries are normal, never assert on it.
4. Unknown XML elements round-trip untouched (future-version fields).

## Sanctioned External-Content Paths

- **File > Import** in Scrivener: creates binder items from external files. Zero package risk; needs the GUI.
- **Sync with External Folder**: Scrivener writes `Draft/` and `Notes/` subfolders as Markdown/plain text/RTF, one file per document named `Title [integer-id]`, and maintains the mapping itself. The vendor-sanctioned round-trip for outside editors.
