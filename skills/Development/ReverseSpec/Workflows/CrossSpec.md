# CrossSpec Workflow

Read across every spec and maintain `docs/specs/CROSS-SPEC.md`: a ledger of redundancies,
synergies, contradictions, and system-level improvements that only become visible when specs
sit side by side. Per-spec Findings are local observations; this ledger is where they are
corroborated, merged, and given stable IDs.

**Input:** the current set of specs under `docs/specs/` (optionally restricted to a kind or a
list of subjects that a sweep just added).
**Output:** `docs/specs/CROSS-SPEC.md` created or updated in place; a short report.

## Step 1 — Load the corpus

```bash
T=skills/Development/ReverseSpec/Tools
bun $T/SpecLint.ts --all           # do not analyse a corpus with FAILs — fix or exclude them
bun $T/Inventory.ts list --current --json > /tmp/rs-current.json
```

For each current spec, read the frontmatter plus these sections only: **Ontology**,
**Interface**, **Context** (Uses / Feeds into / State it owns), **Findings**. Skip the rest —
the ledger is about seams, not internals. With more than ~15 specs, fan out one Explore
subagent per kind to extract those sections into a compact bullet digest per spec
(`subject → terms, entry points, state files, uses, feeds-into, findings`) and work from the
digests.

## Step 2 — Look for the four patterns

Work the corpus with these lenses, in order. Every candidate needs evidence on **both** sides
(`path:line` in each subject, or a quoted spec line).

1. **Redundancies** — two subjects doing the same job: same verb in USE WHEN, parallel
   registries (two inventories of skills, two hook lists), near-duplicate helpers, two writers
   to one state file, two classifiers of one input. Apply the deletion test to each side: if
   deleting one would make the other absorb it cleanly, that is a redundancy.
2. **Contradictions** — a term defined two ways across Ontologies; an ADR one spec honors and
   another violates; a spec's Interface promising an invariant a neighbor's Findings shows is
   broken; docs-vs-code gaps that two specs report differently; two specs naming different
   owners for the same state file.
3. **Synergies** — subjects that would be better sharing a seam: one produces exactly what
   another rebuilds (a scanner and an inventory), two subjects hand-roll the same vocabulary
   that a shared CONTEXT.md could own, an eval signal one subject emits that another's Evals
   section calls "no signal".
4. **System improvements** — Improvement findings that recur in ≥2 specs (the same lint rule
   missing, the same fail-open catch pattern, the same absent `--dry-run`) — those are one
   fix, not N.

Reject candidates that need only one spec to see — those stay in that spec's Findings.

## Step 3 — Write the ledger

`docs/specs/CROSS-SPEC.md` shape (create on first run; on later runs edit in place, never
renumber):

```markdown
# Cross-Spec Ledger

> Maintained by the ReverseSpec CrossSpec workflow. Last pass: YYYY-MM-DD over N specs.
> IDs are stable; closed entries stay with their resolution.

## Summary

| Type | Open | Closed |
|------|------|--------|
| Redundancy | … | … |
| Contradiction | … | … |
| Synergy | … | … |
| System improvement | … | … |

## Entries

### X-001 · Redundancy · <short title>
- **Subjects:** `subjectA`, `subjectB`
- **Evidence:** `pathA:line` …; `pathB:line` …
- **Why it matters:** one or two sentences (blast radius, drift risk, cost)
- **Proposed action:** the smallest change that removes the duplication / resolves the conflict
- **Status:** open | needs-jm | closed (commit/ADR/decision + date)
- **Found:** YYYY-MM-DD

### X-002 · Contradiction · …
```

Rules:
- One entry per *pair or cluster*; list every subject involved.
- `needs-jm` is for entries where the proposed action is a decision (which side wins), not a
  fix. Say what the question is in one line; do not decide it.
- Closed entries keep their evidence and add the resolution. Nothing is deleted.
- Severity is implied by order inside each type: most consequential first.

## Step 4 — Feed back and report

- Update each involved spec's Findings with a back-reference (`see X-00N`) so the per-spec and
  system views agree. This is the only edit CrossSpec makes to individual specs.
- Entries marked `needs-jm` are surfaced to Jm in the report as A/B questions. Do **not**
  create LucidTasks or edit code from this workflow; promoting an entry into work is Jm's
  call (via `/queue add` or the AutoMaintenance tech-debt registry).
- Report: pass date, corpus size, new / changed / closed entry counts, and the three entries
  with the largest blast radius, each in one sentence Jm can act on.

## Anti-patterns

- ❌ A ledger entry with evidence from only one subject.
- ❌ Resolving a Contradiction in the ledger by picking a side — that is `needs-jm` unless an
  ADR already settles it (cite the ADR and close it).
- ❌ Renumbering or deleting entries between passes.
- ❌ Running CrossSpec over specs that fail `SpecLint` — fix the corpus first.
