# SpecSubject Workflow

Reverse-engineer one subject into a spec at its canonical path. This is the unit of work; the
Sweep workflow runs it once per subagent, so it must be self-sufficient: everything an agent
needs is here or in `Template.md`.

**Input:** a subject path (`skills/<Cat>/<Name>`, `hooks/<Name>.hook.ts`, `lib/core/<Name>.ts`,
`agents/<Name>.md`, `bin/<name>`). If the user names a skill in words, resolve it with
`bun skills/Development/ReverseSpec/Tools/Inventory.ts list --kind skill | grep -i <name>`.

**Output:** the spec file, lint-clean, plus a refreshed `docs/specs/INDEX.md`.

Work from the repo root (`getKayaHome()`, normally `~/.claude`; in a worktree, that worktree).
Set `S=<subject>` and `T=skills/Development/ReverseSpec/Tools` mentally for the commands below.

## Step 1 — Resolve the subject and its files

```bash
bun $T/Inventory.ts show $S
```

Record `source_hash`, `source_files`, the spec path, and whether a spec already exists. If one
exists and is `current`, stop and say so unless the user asked for a rewrite. If it is `stale`,
read the old spec first — you are updating it, and prior Findings must be carried forward or
explicitly closed ("resolved by commit …").

If the subject is a skill over ~2,000 LOC (the `show` output has the total), decide the split
now: the skill spec covers routing, workflows, and the tool *interfaces*; each major tool in
`Tools/` with its own tests gets a component spec (`$S/Tools/<Name>.ts`) in a follow-up run.
Note the split in the skill spec's Context.

## Step 2 — Read everything that defines the subject

Read in this order, taking notes keyed by `path:line`:

1. **The subject's own files** — for a skill: SKILL.md, every Workflows/*.md, every Tools/*.ts
   (read the header docblock and every exported symbol; read bodies for anything with side
   effects), CONTEXT.md, docs/adr/*. For a hook or component: the file, its tests, its help.md.
2. **Registration and wiring** — where the subject is invoked:
   - skills: `Commands/<name>.md`, the category `skills/<Cat>/SKILL.md` row, `CONTEXT-MAP.md`,
     `CONTEXT-ROUTING.md`
   - hooks: `settings.json` (event + matcher + timeout), `hooks/README.md` registry row and any
     flow diagram mentioning it, `hooks/handlers/` if it orchestrates handlers
   - components: `grep -rn "from .*<Name>" --include=*.ts` for importers; `bin/` and
     `MEMORY/daemon/cron/jobs*/*.yaml` for CLI callers
   - crons: `grep -rln "<Name>" MEMORY/daemon/cron/jobs* bin/*.sh` and `bin/rebuild-plists.sh`
3. **Governing docs** — `docs/decisions/*` ADRs that name it, `docs/architecture.md`,
   `docs/system/*` pages that describe it, and the auto-memory index
   (`~/.kaya/memory/MEMORY.md`) for gotchas that name it. Query the graph:
   `bun skills/Intelligence/Graph/Tools/GraphQuerier.ts search "<Name>"`.
4. **Neighbors** — the two or three subjects it most obviously overlaps with (same verbs in the
   USE WHEN, same state files, same external API). These feed Redundancies and Synergies.

Use an Explore subagent for the grep-heavy parts (importers, cron callers, neighbors) so the
main context stays clean; ask it for `path:line` lists, not summaries.

## Step 3 — Run it

Confidence is earned by execution, not reading:

- Tests: `bun test "$PWD/<subject test path>"` with an ABSOLUTE path. Record `Ran N tests …
  X pass Y fail` verbatim. A run with `Ran 0` is not evidence.
- CLI tools: run `--help`, then a `--dry-run` or read-only subcommand against the real tree.
- Hooks: feed a minimal JSON payload on stdin (`echo '{"tool_name":"Bash","tool_input":{...}}'
  | bun hooks/<Name>.hook.ts`) and record stdout, stderr, exit code. Never feed a payload that
  triggers a destructive branch.
- Workflows (prompt-only skills): do not execute them; note "prompt-only, not executed" and set
  confidence `medium`.

If a run would write to live state (MEMORY/, ~/.kaya, Telegram, calendar), pin
`KAYA_HOME=<temp dir>` or skip the run and say so.

## Step 4 — Write the spec

Copy the skeleton from `Template.md` (frontmatter + twelve sections), fill every section to its
quality bar, delete the guidance comments. Specific rules:

- **Summary**: plain language, no paths or code, Jm can explain it back.
- **Ontology**: if the subject has a CONTEXT.md, reference it and add only missing terms; use
  `skills/Development/GrillWithDocs/CONTEXT-FORMAT.md` style (`**Term**: definition. _Avoid_: …`). Architecture words come from
  `ImproveCodebaseArchitecture/LANGUAGE.md`.
- **Interface**: invariants, error modes (fail loud / fail open / swallowed, with the catch
  site), side effects, and budgets — not just signatures.
- **Features**: tag `(undocumented)` for code-only behavior and `(documented, not implemented)`
  for doc-only claims. Both also become Contradictions.
- **Acceptance Criteria**: ≥4 rows; each Verification is a command or a precise manual check;
  Status is `observed` only if you saw it in Step 3.
- **Diagrams**: one structural (`classDiagram` / `flowchart`), one behavioral
  (`sequenceDiagram` / `stateDiagram-v2`), labels from the Ontology.
- **Rebuild Notes**: file layout, implementation order as vertical slices, lib/core modules to
  reuse, lint rules that will bite (`lib/lint/*`), traps from memory/comments.
- **Findings**: every item `- [SEV] Title — evidence (path:line) — proposed action`; write
  "none found" rather than deleting a subsection. Contradictions cite both sides.
- Frontmatter `generated_by`: `ReverseSpec` when run directly, `ReverseSpec/<agent>` inside a
  sweep. `status: draft` always — only Jm flips it to `reviewed`.

Write to the spec path from Step 1 (create directories as needed).

## Step 5 — Lint, index, report

```bash
bun $T/SpecLint.ts docs/specs/<path>.md      # must exit 0; fix every error, read every warning
bun $T/Inventory.ts index                    # refresh docs/specs/INDEX.md
```

A `stale` warning right after writing means the subject changed under you (or you edited it —
which this workflow forbids); re-run `hash` and update the frontmatter.

Report in the session: features count, AC count with observed/inferred split, the Findings
counts by subsection, and the one Contradiction most worth Jm's attention. If any Open Question
blocks a correct spec, say so — do not guess an answer into the spec.

## Anti-patterns

- ❌ Writing the spec from SKILL.md alone — that reproduces the claims, not the behavior.
- ❌ Fixing the subject while spec'ing it. Findings are proposals; the fix is a separate task.
- ❌ "Tests pass" without `Ran N`. ❌ `confidence: high` without a Step 3 run.
- ❌ Generic ontology terms (timeout, cache, config) or generic edge cases with no verdict.
- ❌ Leaving template guidance comments in the file (SpecLint warns).
