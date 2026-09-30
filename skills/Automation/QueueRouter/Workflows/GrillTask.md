# GrillTask Workflow

**Clarify a parked spec-pipeline item via a GrillWithDocs interview, then drive it to the approvals queue.**

Items land in `needs-grilling` when the spec-pipeline determines they lack sufficient context for autonomous research. This workflow fills that gap through a structured human conversation.

This workflow runs **GrillWithDocs** (`Development/GrillWithDocs`), not bare GrillMe. Beyond filling the context gap, it challenges the item against the item's domain glossary, sharpens fuzzy terms to canonical ones, and **leaves a durable `CONTEXT.md` behind** so the same understanding feeds future grills and spec generation (`SpecPipelineRunner` injects the domain glossary into the spec prompt). See `QueueRouter/docs/adr/0001-grill-writes-docs-specgen-reads.md`.

## Trigger

- `/queue grill` — Interactive grill session

## WARNING — Human-Present Only

**This workflow MUST only be invoked interactively by Jm.**
- Never invoke headless, from cron, or via `claude -p`.
- Never call `grill finalize` autonomously — it spawns `processItem` which hits an LLM.
- The daily spec-pipeline job skips `needs-grilling` items by design.

---

## Step 0 — Guard Check

Before proceeding, confirm this is an interactive session. The grill requires `AskUserQuestion` at every decision point. If there is any doubt about interactivity, abort and surface the parked list for later.

---

## Step 1 — Load Parked Items

Show the top 5 items waiting for a grill:

```bash
bun ~/.claude/skills/Automation/QueueRouter/Tools/CLI.ts grill list
```

The header line reports the true backlog size and true truncation — e.g. `Parked for Grill (showing 5 of 74)` — never just the 5 displayed. Ages are computed from `created`, not `updated` (a bulk sweep can touch `updated` on every row without the item getting any newer).

Each item displays:
- Item ID, title, priority
- `grillBrief.missing` — what information is absent
- `grillBrief.suggested_questions` — the pipeline's recommended questions

To skip straight to the oldest-waiting item (display-only, no queue writes) instead of choosing from the list:

```bash
bun ~/.claude/skills/Automation/QueueRouter/Tools/CLI.ts grill next
```

This prints `N waiting, oldest X days`, auto-selects the oldest item, and shows its grill brief ready for Step 2.

**Optional pre-interview narrowing:** before sitting down with Jm, run `bun ~/.claude/skills/Automation/QueueRouter/Tools/GrillPreResearch.ts <id>` to spawn a read-only investigation pass that answers whatever `grillBrief.suggested_questions` it can from the codebase and rewrites the brief down to the human-only remainder — saves interview time on questions that don't need Jm.

---

## Step 2 — Choose Item + Present Grill Brief

Ask Jm which item to work on (if more than one):

```
AskUserQuestion: "Which item do you want to grill? [list IDs/titles]"
```

Once chosen, surface the full brief for that item:
- `grillBrief.missing` — gaps identified by the pipeline
- `grillBrief.suggested_questions` — starting questions

Optionally enrich with GrillMeLens directives to generate deeper Socratic questions:

```typescript
import { generateDirectives } from "~/.claude/skills/Agents/SpecSheet/Tools/GrillMeLens.ts";
const directives = await generateDirectives(item.payload.title, item.payload.description, "feature");
```

These directives add lens-based angles (Dependencies, Cascade, Reversibility, etc.) beyond the pipeline's initial questions.

---

## Step 3 — Socratic Interview (ONE Question at a Time)

**Interview Jm relentlessly about every aspect of this item until you reach shared understanding.** Walk down each branch of the design tree, resolving dependencies between decisions one-by-one — the `grillBrief` questions are a starting point, not the full scope. For each question, provide your recommended answer. Ask **one question at a time** with `AskUserQuestion` and wait for the answer before asking the next. If a question can be answered by exploring the codebase, explore it instead of asking.

Guiding principles (from GrillWithDocs):
- Start broad ("What problem does this solve?") then narrow.
- Follow threads — if an answer surfaces a new ambiguity, pursue it before moving on.
- Test assumptions explicitly ("You said X — does that mean Y is also in scope?").
- Surface constraints ("What would make this solution unacceptable?").
- **Challenge against the domain glossary.** Resolve the item's primary-domain skill and read its `CONTEXT.md` (if one exists). When Jm uses a term that conflicts with the glossary, call it out: "Your glossary defines 'X' as A, but you seem to mean B — which is it?"
- **Sharpen fuzzy language.** When a term is vague or overloaded, propose the precise canonical term and confirm it ("You're saying 'account' — Customer or User? Those differ.").
- **Cross-reference with code.** When Jm states how something works, check the codebase; surface contradictions.
- **Capture inline.** When a term resolves, note it for the domain `CONTEXT.md` right then — don't batch it to the end.
- **Don't stop early.** Being able to answer "what should the spec's acceptance criteria look like?" is the *floor*, not the finish line. Keep going while any branch still has an unresolved dependency, an untested assumption, or a fuzzy term — end only when no open ambiguity remains or Jm calls it.

Typical question progression:
1. Problem & motivation — why does this matter? what breaks without it?
2. Scope — what is explicitly in/out of scope?
3. Constraints — performance, security, backward-compat, dependencies?
4. Success criteria — what does "done" look like concretely?
5. Risks — what could go wrong? any unknowns that need research?

---

## Step 4 — Write Grill Findings (ALWAYS)

The grill session has codebase access and just verified the premise in-session — write the research findings yourself instead of paying the 15–30 min autonomous research spawn (which is also classifier-blocked in interactive sessions; see ADR 0002).

**For high-effort / high-stakes / irreversible items, do a directed-investigation pass before writing findings.** This is the in-session substitute for the autonomous research spawn: take the GrillMeLens directives from Step 2 and *actually investigate each one against the codebase* (Read/Grep/Bash) rather than using them only as conversation prompts. Record each result as an evidence-backed `[RESOLVED: <claim> — <file>:<line>]` line. Running the directives down — instead of leaving them as angles — is what closes the depth gap versus the autonomous research agent.

**Optional: draft→confirm→finalize shortcut.** Instead of writing the findings markdown by hand, you can have an LLM draft it from the interview transcript and review the draft before saving:

```bash
# Pipe the transcript (or --file a saved one) in; the draft prints to stdout only — nothing is written or finalized.
echo "<interview transcript / your notes>" | bun ~/.claude/skills/Automation/QueueRouter/Tools/CLI.ts grill draft-findings <id>

# Once you've reviewed the draft and it's ready, re-run with output redirected to the canonical path:
bun ~/.claude/skills/Automation/QueueRouter/Tools/CLI.ts grill draft-findings <id> --file <transcript-path> \
  > ~/.claude/MEMORY/WORK/grill-<id>-findings.md
```

This is draft-only: `grill draft-findings` never persists anything and never calls `grill finalize` — it only prints a candidate findings doc in the template below for Jm to review, edit if needed, then save and finalize manually. Treat the draft the same as one you wrote yourself: read it before trusting the VERDICT.

Save findings to:

```
~/.claude/MEMORY/WORK/grill-<id>-findings.md
```

Use this template — the pipeline reads the `VERDICT` line (a missing verdict is bounced to `awaiting-context` for re-enrichment, not treated as `implement` — see ADR 0002):

```markdown
# Research Findings: <item title>

**Item ID:** <id>
**Researched At:** <ISO timestamp>
**Research Method:** Interactive grill session (GrillWithDocs)

---

## Premise Verification

- [RESOLVED] <claim> — confirmed in <file>:<line>
- [NEEDS_INPUT: <question>] <open point that required a human decision — record Jm's answer>

## Atomic Outcomes

1. <Deliverable — specific and measurable>

## Acceptance Criteria

- <What "done" looks like, measurable>

## Verification Methods

- <How to confirm each criterion — test / existence / runtime / manual>

## Dependencies and Risks

- <Dependency or risk>

## Scope Constraints

In scope: <explicit in-scope items>
Out of scope: <explicit exclusions>

---

## VERDICT: implement | skip | defer
- Reason: <one sentence>
- Scope estimate: small (<1hr) | medium (1-4hr) | large (4hr+)
```

**Exception — genuine deep research needed:** if the item requires research beyond what the interactive session can do (comprehensive library benchmarking, multi-repo surveys, long external research), either finalize *without* `--findings`, or pass both `--findings` and `--deep-research` to keep your findings as prior context while forcing the full spawn. **Caveat:** `grill finalize` runs `processItem` synchronously and the autonomous spawn is classifier-blocked in interactive sessions (ADR 0002) — so `--deep-research` *from an interactive grill* attempts a spawn that hangs/fails. In an interactive session, get depth from the directed-investigation pass above; reserve `--deep-research` for genuinely external research you'll route through an autonomous/cron run.

---

## Step 5 — Finalize: Synthesize + Drive to Approvals

Synthesize the interview into three fields:
- **notes** — concise problem context (2–5 sentences). What is the problem? Why does it matter?
- **researchGuidance** — what the LLM should investigate (key questions, tradeoffs, constraints to verify). Still required even with `--findings` — it feeds spec revision runs.
- **scopeHints** (optional) — explicit in/out-of-scope statements.

**Standard path (grill-provided findings — recommended):**

```bash
bun ~/.claude/skills/Automation/QueueRouter/Tools/CLI.ts grill finalize <id> \
  --notes "The auth service currently uses session tokens..." \
  --research "Verify OAuth2 migration checklist items during spec revision." \
  --scope "In: backend API. Out: mobile clients." \
  --findings ~/.claude/MEMORY/WORK/grill-<id>-findings.md
```

This:
1. Calls `attachContext` (→ transitions item to `researching`, records the findings artifact)
2. Calls `processItem` — the research phase **short-circuits** (no spawn) and dispatches your `VERDICT` directly, then spec generation runs
3. Transfers the item to `approvals` with a draft spec

**Traditional path (no `--findings`):** the pipeline spawns the autonomous research subagent (15–30 min). Only for the deep-research exception in Step 4.

**Safety:** a `skip` verdict on a grilled item never silently archives it — the pipeline holds it at `awaiting-context` and escalates a `manual-<id>` task to "Kaya — Needs Jm".

After success, the item appears in `/queue review` for spec approval.

### Persist domain docs (GrillWithDocs — always)

Every grill leaves a durable glossary behind. After finalize succeeds:

1. **Resolve the primary domain skill** — the single skill the item most lives in (its classified home / the skill its title and notes name). One item → one domain doc.
2. **Create or update `skills/<Category>/<Skill>/CONTEXT.md`** with the terms sharpened during the interview, using the format in `Development/GrillWithDocs/CONTEXT-FORMAT.md`.
   - **First touch is provisional:** seed only the `## Language` terms you actually resolved — no forced `## Relationships` until a later grill confirms them. A thin-but-correct glossary beats an opinionated-but-wrong one, because every future grill *challenges against* whatever is written here.
   - Only include terms meaningful to the domain — not general programming concepts.
3. **Maintain the root `CONTEXT-MAP.md`** — if you just created a skill's first `CONTEXT.md`, add (or confirm) its entry in the root map. The map is mandatory once more than one `CONTEXT.md` exists.
4. **Offer an ADR sparingly** — only when the decision is hard to reverse AND surprising without context AND a real trade-off (per `GrillWithDocs/ADR-FORMAT.md`). Write it to `skills/<Category>/<Skill>/docs/adr/NNNN-slug.md`. Most grills won't need one.

Why this matters: `SpecPipelineRunner.loadDomainVocabularyForItem` injects this `CONTEXT.md`'s `## Language` + `## Relationships` into the spec-gen prompt — so the vocabulary you sharpen here directly shapes this and every future spec in the domain, grilled or not.

---

## Step 6 — Alternative Outcomes

Not every item needs a spec. Use these when appropriate:

### Kill — item no longer relevant

```bash
bun ~/.claude/skills/Automation/QueueRouter/Tools/CLI.ts grill kill <id> [--lucid <lucidTaskId>]
```

Use when: the task is obsolete, duplicated, or Jm decides it won't be done.
Archives the spec-pipeline item and optionally cancels the linked LucidTask.

### Split — item is too broad

```bash
bun ~/.claude/skills/Automation/QueueRouter/Tools/CLI.ts grill split <id> \
  --titles "Subtask A|Subtask B|Subtask C" \
  [--lucid <parentLucidTaskId>]
```

Use when: the interview reveals the item is actually multiple independent tasks.
Creates new LucidTasks for each subtask and archives the parent.

### Defer — not enough information yet

```bash
bun ~/.claude/skills/Automation/QueueRouter/Tools/CLI.ts grill defer <id> [--until 2026-07-01T00:00:00Z]
```

Use when: the right answer depends on an external decision, a meeting, or future work.
Moves the item back to `awaiting-context` with a `deferUntil` timestamp.

---

## Notes on the Approvals Budget

Once a draft spec lands in `approvals`, it has a **3-rejection revision budget**. On the third rejection, it escalates and requires manual intervention. Invest time in the grill to produce high-quality notes/researchGuidance — it directly determines spec quality.

---

## CLI Quick Reference

| Command | Description |
|---------|-------------|
| `bun CLI.ts grill list` | Show top 5 parked items (header reports true total, e.g. "showing 5 of 74") |
| `bun CLI.ts grill next` | Auto-select the oldest-waiting item + print its brief (display-only) |
| `bun ~/.claude/skills/Automation/QueueRouter/Tools/GrillPreResearch.ts <id> [--dry-run]` | Pre-interview: narrow `suggested_questions` to human-only via a read-only investigation pass |
| `echo "<transcript>" \| bun CLI.ts grill draft-findings <id> [--file <path>]` | Draft a findings doc from a transcript (prints only — never persists/finalizes) |
| `bun CLI.ts grill finalize <id> --notes "..." --research "..." --findings <path>` | Attach context + drive to approvals (research short-circuited) |
| `bun CLI.ts grill finalize <id> --notes "..." --research "..."` | Same, but runs the autonomous research spawn (15–30 min) |
| `bun CLI.ts grill finalize ... --findings <path> --deep-research` | Keep findings as context but force the autonomous spawn |
| `bun CLI.ts grill kill <id> [--lucid <ltid>]` | Archive item (+ cancel LucidTask) |
| `bun CLI.ts grill split <id> --titles "a\|b\|c"` | Split into LucidTasks, archive parent |
| `bun CLI.ts grill defer <id> [--until <iso>]` | Defer to awaiting-context |

## Related

- `Development/GrillWithDocs/SKILL.md` — the grilling method this workflow runs
- `Development/GrillWithDocs/CONTEXT-FORMAT.md` — `CONTEXT.md` / `CONTEXT-MAP.md` format
- `Development/GrillWithDocs/ADR-FORMAT.md` — when and how to write an ADR
- `QueueRouter/docs/adr/0001-grill-writes-docs-specgen-reads.md` — why grill writes docs and spec-gen reads them
- `QueueRouter/docs/adr/0002-grill-emits-findings-research-short-circuit.md` — why the grill writes the research findings and the spawn is skipped
- `Tools/GrillRunner.ts` — implements all grill actions (injectable deps), including `draftFindings`
- `Tools/GrillPreResearch.ts` — pre-interview directed-investigation pass that narrows `grillBrief.suggested_questions`
- `Tools/QueueManager.ts` — `parkForGrill`, `listParkedForGrill`, `attachContext`
- `Tools/SpecPipelineRunner.ts` — `processItem`, `research`, `loadDomainVocabularyForItem`
- `skills/Agents/SpecSheet/Tools/GrillMeLens.ts` — Socratic lens directives (autonomous research path)
- `Workflows/ReviewSpecs.md` — next step after finalize lands a draft spec
