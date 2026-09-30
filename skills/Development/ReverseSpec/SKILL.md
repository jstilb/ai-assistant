---
name: ReverseSpec
description: Reverse-engineer a rebuild-grade spec (purpose, interface, features, acceptance criteria, tests, evals, mermaid diagrams, ontology, findings) from an existing Kaya skill, hook, lib component, agent, or bin script, track spec coverage, and compare specs across the system. USE WHEN reverse spec, reverse-engineer a spec, spec this skill, spec this hook, spec this module, rebuild-from-scratch spec, spec coverage, which modules lack specs, stale specs, cross-spec analysis, find redundancies across skills, spec contradictions, spec synergies, spec sweep.
---

# ReverseSpec

Turns what Kaya *already is* into specs precise enough to rebuild it from scratch and to see
across it: one spec per subject at a canonical path, a deterministic inventory of what is
covered and what has drifted, and a cross-spec ledger where redundancies, synergies, and
contradictions between modules are recorded with evidence.

The specs are a **map of the territory, not the territory**: they describe observed behavior
with `path:line` evidence, and every place the docs disagree with the code is a Finding, not a
silent choice. Reading the spec should let Jm explain the module back; reading the Findings
should tell him what to fix, merge, or delete.

## Voice Notification

→ Use `notifySync()` from `lib/core/NotificationService.ts`

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **SpecSubject** | "reverse spec X", "spec this skill/hook/module", "rebuild-from-scratch spec for X" | `Workflows/SpecSubject.md` |
| **Sweep** | "spec sweep", "spec coverage", "which modules lack specs", "stale specs", "spec the next batch" | `Workflows/Sweep.md` |
| **CrossSpec** | "cross-spec analysis", "redundancies across skills", "spec contradictions", "spec synergies" | `Workflows/CrossSpec.md` |

## Subjects and where specs live

| Kind | Subject path | Spec path |
|------|--------------|-----------|
| skill | `skills/<Cat>/<Name>` (dir) | `docs/specs/skills/<Cat>/<Name>.md` |
| category | `skills/<Cat>` (its SKILL.md only) | `docs/specs/skills/<Cat>.md` |
| hook | `hooks/<Name>.hook.ts`, `hooks/<Name>.sh` | `docs/specs/hooks/<Name>.md` |
| component | `lib/**/<Name>.ts`, `hooks/handlers/*`, `hooks/lib/*`, any file inside a skill | `docs/specs/<path minus extension>.md` |
| agent | `agents/<Name>.md` | `docs/specs/agents/<Name>.md` |
| bin | `bin/<name>` | `docs/specs/bin/<name>.md` |

The mapping is code (`specPathFor` in `Tools/Inventory.ts`), never hand-chosen. Every spec
carries a `source_hash` of its subject's files; when the subject changes the spec shows as
**stale** in `docs/specs/INDEX.md`. Specs are durable repo docs (diffed and cross-compared over
time), which is why they live under `docs/specs/` and not under `MEMORY/`.

## Tools

| Tool | Purpose |
|------|---------|
| `Tools/Inventory.ts` | `list` subjects with coverage status (`--kind`, `--missing`, `--stale`, `--json`); `hash <subject>` for frontmatter; `show <subject>` for file list + LOC; `index` rewrites `docs/specs/INDEX.md` |
| `Tools/SpecLint.ts` | Structural gate: frontmatter provenance, 12 sections in order, Findings subsections, ≥4 acceptance rows, ≥2 mermaid blocks, no template leftovers, referenced paths resolve. `--all`, `--strict`, `--json`. Exit 1 on errors |

Both accept `--root <dir>` (tests use a temp tree; default is `getKayaHome()`).

## Spec shape

`Template.md` is the contract: frontmatter (subject, kind, spec_version, source_hash,
source_files, generated, generated_by, status, confidence) and twelve sections — Summary,
Purpose, Context, Ontology, Interface, Features, Acceptance Criteria, Tests And Edge Cases,
Evals And Metrics, Diagrams, Rebuild Notes, Findings (Improvements / Redundancies / Synergies /
Contradictions / Open Questions). Vocabulary: architecture terms from
`skills/Development/ImproveCodebaseArchitecture/LANGUAGE.md` (module, interface, seam, depth),
domain terms from the subject's own `CONTEXT.md` when it has one.

## Examples

**Example 1: Spec one hook**
```
User: "reverse spec the SecurityValidator hook"
→ SpecSubject workflow: `Inventory.ts show hooks/SecurityValidator.hook.ts` → read hook,
  tests, settings.json registration, hooks/README.md row, patterns.yaml → run the tests →
  write docs/specs/hooks/SecurityValidator.md → `SpecLint.ts` clean → `Inventory.ts index`
→ "Spec written: 9 features, 12 ACs (8 observed), 2 contradictions vs hooks/README.md"
```

**Example 2: Coverage-driven batch**
```
User: "spec sweep — do the next 8"
→ Sweep workflow: `Inventory.ts list --missing` → pick 8 by leverage (callers, cron, size)
  → one subagent per subject running SpecSubject.md → lint all → index → commit
→ "8 specs added (coverage 19/318), 3 stale specs flagged, ledger updated with 5 candidates"
```

**Example 3: See across the specs**
```
User: "cross-spec analysis"
→ CrossSpec workflow: read every spec's Ontology + Interface + Findings → cluster →
  write/refresh docs/specs/CROSS-SPEC.md (X-IDs, evidence, proposed action, status)
→ "2 redundancies (SystemScanner vs Inventory), 1 contradiction (README vs code), 3 synergies"
```

## Rules

- **Code is what it does; docs are what it claims.** Never reconcile a gap silently — file a
  Contradiction with `path:line` on both sides.
- **Run before you write.** Confidence `high` requires having executed the subject (tests with
  a nonzero `Ran N`, a CLI smoke, a dry-run). Reading-only specs are `medium` at best.
- **One subject per agent.** Sweeps parallelize across subagents; a subagent never specs two
  subjects, and never edits the subject it is describing.
- **Findings are proposals, not changes.** ReverseSpec never modifies a subject. Improvements
  go to the spec's Findings and, once cross-checked, to `docs/specs/CROSS-SPEC.md`; open items
  that need Jm go to LucidTasks, not into the spec.
- **Big subjects split.** A skill over ~2,000 LOC gets a skill-level spec plus component specs
  for its major Tools, linked from the skill spec's Context.

## Integration

### Uses
- `lib/core/KayaHome.ts` — root resolution for both tools
- `skills/Development/ImproveCodebaseArchitecture/LANGUAGE.md` — architecture vocabulary
- `skills/Development/GrillWithDocs/CONTEXT-FORMAT.md` — glossary format for Ontology
- Subagents (Explore for reading, general-purpose for spec writing) — Sweep fan-out

### Feeds Into
- `docs/specs/INDEX.md` — coverage view (regenerated by `Inventory.ts index`)
- `docs/specs/CROSS-SPEC.md` — findings ledger consumed by `/improvecodebasearchitecture`,
  `/prd`, and the AutoMaintenance tech-debt registry when Jm promotes an entry
- `/grillwithdocs` — a spec's Open Questions are grill fodder

**Last Updated:** 2026-09-20
