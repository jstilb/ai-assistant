# Organize Workflow

Audit a project's organization against the lightweight doctrine, recommend changes, and apply only what Jm approves — safest path first.

## Step 1: Read the doctrine

Read `../BestPractices.md` (audit heuristics + Jm's house conventions) before judging anything.

## Step 2: Inspect

```bash
bun ~/.claude/skills/Content/Scrivener/Tools/Inspect.ts <project.scriv> --words --check --format json
```

## Step 3: Audit (judgment, not rules)

Evaluate the report against the heuristics in `BestPractices.md`. For each finding: what, where (title + UUID), why it costs Jm something, and the proposed change. Respect the house style — Jm's POV-label axis, status verbs, numbered chapters, and custom scene grid are to be extended, never replaced. When in doubt, restructure-and-flag beats rewrite.

## Step 4: Deliver the audit

Write the audit to `MEMORY/Scrivener/YYYY-MM-DD/` via `resolveOutputPath()` and present the summary. **Stop here by default** — recommendations are the deliverable; applying them is a separate, Jm-approved step.

## Step 5: Apply approved changes (only with explicit approval)

Route each approved change to the safest capable mechanism, in this order:

1. **Jm-in-Scrivener instructions** — for anything touching manuscript text, moves between special folders, or bulk metadata: a precise checklist Jm executes in the GUI in minutes. Default for first-time operations.
2. **Direct package edits** — only for changes the GUI path makes tedious (e.g. bulk-titling 30 "Scene" documents from synopses), and only after every gate in `../SafetyRules.md` passes: Scrivener closed (`pgrep -x Scrivener` empty), no lock file, sync idle, `Tools/Backup.ts` exit 0. Edits are `.scrivx`-only where possible (titles, label/status IDs, order within the same parent); never regenerate existing `content.rtf`.

## Step 6: Verify

After any applied change: `bun Tools/Inspect.ts <project.scriv> --check` parses cleanly and shows the intended result; diff the before/after JSON reports; Jm opens the project and confirms. Keep the Gate-2 backup until Jm confirms.
