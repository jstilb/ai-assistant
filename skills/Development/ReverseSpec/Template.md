# ReverseSpec Spec Template

Every spec produced by this skill follows this exact skeleton. `Tools/SpecLint.ts` enforces the
frontmatter fields and the twelve `##` section titles verbatim. Guidance for each section is in
the HTML comments; delete the comments in the finished spec, keep the headings.

The bar for every section: **someone who has never seen the code could rebuild the subject from
this document and get the same observable behavior.** If a sentence would not help a rebuilder or
a reviewer looking for cross-module contradictions, cut it.

Evidence rule: every non-obvious claim cites its source as `path:line` (clickable) or a command
that was run and its output. An uncited claim about behavior is an inference — say so with
"(inferred)". Where the docs (SKILL.md, README, ADR) and the code disagree, the code is what the
subject *does*, the docs are what it *claims*; record the gap as a Contradiction finding, never
silently pick one.

```markdown
---
subject: skills/Development/Diagnose          # repo-relative path of the subject (dir for skills)
kind: skill                                   # skill | category | hook | component | agent | bin
spec_version: 1                               # bump when the template shape changes
source_hash: 0123456789ab                     # from `bun Tools/Inventory.ts hash <subject>`
source_files: 3                               # from the same command
generated: 2026-09-20                         # date the spec was (re)generated
generated_by: ReverseSpec                     # ReverseSpec | ReverseSpec/<agent-name>
status: draft                                 # draft | reviewed (Jm has read it)
confidence: medium                            # high | medium | low — how much was verified by running
---

# <Subject name> — Reverse-Engineered Spec

## Summary

<!-- 3–6 sentences of plain language. What it is, what it does for Jm, how it is invoked, and the
one thing most likely to surprise a newcomer. Jm must be able to explain the module back after
reading only this paragraph. No file paths, no code. -->

## Purpose

<!-- The problem this subject exists to solve and for whom (Jm, another skill, a cron, a hook
event). Apply the deletion test explicitly: "If deleted, complexity would {vanish | reappear across
N callers: ...}". Name the design principle it embodies if one is documented (e.g. an ADR). -->

## Context

<!-- Where the subject sits in the system. Cover every applicable bullet, write "none" otherwise:
- Location: directory / file, category, command (`/name`), skill-routing triggers
- Callers / entry points: who invokes it (user phrases, hooks, cron jobs + schedule, other skills)
- Uses: lib/core modules, external CLIs, APIs, MCPs, secrets (name only, never value)
- Feeds into: what consumes its output
- State it owns: files, DBs, MEMORY/ paths, env vars, config keys
- Governing docs: ADRs (`docs/decisions/*`), CONTEXT.md, README sections, memory gotchas
- History: notable dated decisions found in code comments / ADRs (one line each) -->

## Ontology

<!-- Two parts.
1. Glossary — the subject's own domain terms in CONTEXT-FORMAT style: **Term**: one-line definition.
   _Avoid_: synonyms. Only terms specific to this subject; no general programming concepts.
   If the subject already has a CONTEXT.md, reference it and list only terms it is missing.
2. Entities & relationships — a bullet list of the nouns the code manipulates and how they
   relate ("A Suite contains N Tasks; a Task has exactly one Grader"). Mirror these in the
   structural diagram below. -->

## Interface

<!-- Everything a caller must know (LANGUAGE.md sense — not just signatures):
- Entry points: CLI commands + flags, exported functions/types, hook event + matcher, trigger phrases
- Inputs: shape, required vs optional, where they come from (stdin JSON, argv, files, env)
- Outputs: stdout/JSON shape, exit codes, files written, notifications sent, return types
- Invariants & ordering constraints: what must be true before/after; idempotency
- Error modes: what fails loud, what fails open, what is swallowed (cite the catch site)
- Configuration: settings keys, env vars, defaults
- Side effects: network, filesystem, process spawns, voice/Telegram
- Performance characteristics: latency budget, timeouts, concurrency, size limits -->

## Features

<!-- Numbered list F1..Fn of observable behaviors, one line each, in the order a user would meet
them. Each feature is something a test could exercise. Mark features that exist only in docs
(never reached by code) as "(documented, not implemented)" and features found only in code as
"(undocumented)". -->

## Acceptance Criteria

<!-- ISC-style table. Minimum 4 rows; aim for one row per feature plus the important negative
cases. `Verification` is a runnable command or a precise manual check. `Status` is
`observed` (you ran/read it and saw it), `inferred` (from code reading only), or `unverified`.

| ID | Criterion | Verification | Status |
|----|-----------|--------------|--------|
| AC1 | ... | `bun ...` → expects ... | observed |
-->

## Tests And Edge Cases

<!-- - Existing tests: paths + what each file covers (one line each); how to run them with
  ABSOLUTE paths (`bun test "$PWD/…"`); the last observed result ("Ran N, 0 fail" — never claim
  green without a nonzero N).
- Coverage gaps: features/ACs with no test.
- Edge cases (enumerate, mark covered / uncovered): empty input, missing file/dir, malformed
  input, concurrency / double-run, partial failure, timeouts, huge input, permissions, env
  unset (KAYA_HOME), first run vs steady state. -->

## Evals And Metrics

<!-- - Existing evals: Evals suites / tasks that touch this subject (paths), or "none".
- Quality metrics: what "working well" means, measurably (accuracy, false-positive rate, delivery
  rate, freshness) and where the signal lives today (log, jsonl, dashboard) or "no signal".
- Performance metrics: latency / cost / size budgets, observed values if measurable.
- Proposed evals: 1–3 concrete eval tasks that would catch the subject's most likely regression. -->

## Diagrams

<!-- At least two fenced ```mermaid blocks:
1. Structural — classDiagram or C4-style flowchart of modules/entities and dependencies.
2. Behavioral — sequenceDiagram, stateDiagram-v2, or flowchart of the main path incl. error exits.
Keep node labels to the Ontology terms. Diagrams must render in Obsidian/GitHub. -->

## Rebuild Notes

<!-- The "from scratch" recipe: file layout to create, implementation order (vertical slices),
the non-obvious decisions and why (cite ADR / comment), infrastructure to reuse (lib/core
modules, lint rules that will bite), and the traps recorded in memory or comments. This is
where the reverse-engineered "why" lives. -->

## Findings

<!-- Every item: `- [SEV] Title — evidence (`path:line`) — proposed action`. SEV is HIGH, MED, or LOW.
Write "none found" under an empty subsection rather than deleting the subsection. -->

### Improvements

<!-- changes that would make THIS subject better on its own -->

### Redundancies

<!-- overlap with OTHER subjects: same job done twice, near-duplicate helpers, parallel registries -->

### Synergies

<!-- things that would be better if two subjects shared a seam, data, or vocabulary -->

### Contradictions

<!-- docs vs code, code vs code, subject vs ADR, subject vs another subject's spec, comment vs behavior -->

### Open Questions

<!-- things only Jm can answer; phrase each as a yes/no or A/B question -->
```

## Section-by-section quality bar

| Section | Fails the bar when |
|---------|--------------------|
| Summary | contains a path, a function name, or needs the reader to know Kaya internals |
| Purpose | does not answer the deletion test |
| Context | omits a cron/hook/caller that grep finds, or names a secret's value |
| Ontology | lists generic terms (timeout, cache) or defines a term the code never uses |
| Interface | lists signatures only — no invariants, error modes, or side effects |
| Features | a feature is a wish, not an observed/documented behavior |
| Acceptance Criteria | fewer than 4 rows, or a Verification column that says "check it works" |
| Tests And Edge Cases | claims tests pass without a "Ran N" count, or lists no uncovered edge case |
| Evals And Metrics | no metric is measurable, or "none" without a proposed eval |
| Diagrams | one diagram only, or labels that are not Ontology terms |
| Rebuild Notes | a rebuilder would have to read the source to know the file layout or the traps |
| Findings | a finding without `path:line` evidence, or a Contradiction resolved silently |
