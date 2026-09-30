# CurrentWork Workflow

**Generate implementation specifications that bridge current state to grounded ideal.**

This workflow produces actionable implementation specs with ISC (Ideal State Criteria) rows that feed directly into the execution workflow. It's the final tier in the vision hierarchy—where planning becomes doing.

## Philosophy

> "What specific work do we need to do RIGHT NOW to move toward the grounded ideal?"

Current Work specs:
- Are immediately actionable
- Have clear scope boundaries
- Produce ISC rows for execution
- Apply task-type overlays as needed
- Track progress toward the Grounded Ideal

## Prerequisites

- Clear understanding of work to be done
- Grounded Ideal spec (preferred) for context
- Knowledge of task type (AI/Human/Coding)

---

## The Five-Step Protocol

### Step 1: Vision Context Detection

**Goal:** Detect and load existing vision specs for the domain.

**Process:**

1. **Search for existing specs:**
```bash
# Look for matching domain specs
ls ~/.claude/Plans/Specs/*{{domain}}*.md 2>/dev/null
```

2. **Hierarchy check:**
   - Solarpunk Vision exists? Load for context
   - Grounded Ideal exists? Load for alignment
   - Neither exists? Proceed without (flag as standalone)

3. **If Grounded Ideal exists:**
   - Extract current milestone
   - Load relevant non-negotiables
   - Note progress percentage
   - Identify which features this work addresses

4. **Context Loading Output:**
```markdown
## Vision Context

**Solarpunk Vision:** {{FOUND|NOT_FOUND}}
**Grounded Ideal:** {{FOUND|NOT_FOUND}}
**Current Milestone:** {{MILESTONE_NAME}}
**Progress to Grounded Ideal:** {{PERCENTAGE}}%

### Relevant Grounded Ideal Features
- {{FEATURE_1}}: {{STATUS}}
- {{FEATURE_2}}: {{STATUS}}
```

**Output:** Vision context loaded into working memory

---

### Step 2: Current State Analysis

**Goal:** Document exactly where we are today.

**Questions using AskUserQuestion:**

```
Header: "Work Summary"
Question: "What specific work needs to be done? (One sentence)"
Options: [Text input]
```

```
Header: "Current State"
Question: "What exists today that this work will build on or modify?"
Options: [Text input]
```

```
Header: "Task Type"
Question: "What type of task is this?"
Options:
- "AI Task" - Building an agent, automation, or AI-powered feature
- "Human Task" - Requires human involvement, approvals, or decisions
- "Coding Project" - Implementation work with code changes
- "Mixed" - Combination of above
```

```
Header: "Effort Size"
Question: "How large is this work? (If already established — Small/Medium/Large — confirm or override here)"
Options:
- "Small" - Single concern, < 1 day, few files
- "Medium" - Multiple concerns, 1-3 days, several changes
- "Large" - Cross-cutting, 3+ days, many files or subsystems
```

**For existing systems, gather:**
- Current functionality
- Current limitations
- Current metrics (if available)
- Known issues

**Output:** Current state documented, effort size confirmed (SMALL | MEDIUM | LARGE)

---

### Step 3: Gap Analysis

**Goal:** Define what this work accomplishes and what remains.

**Process:**

1. **Target State Definition:**
   - What will exist after this work?
   - How does it differ from current state?
   - What improvements does it deliver?

2. **Scope Definition:**

```
Header: "In Scope"
Question: "What specific deliverables are in scope for this work?"
Options: [Text input - list items]
```

```
Header: "Out of Scope"
Question: "What is explicitly NOT included (even if related)?"
Options: [Text input - list items]
```

**Scope Lock:** Record `SCOPE_IN` (the in-scope list) and `SCOPE_OUT` (the out-of-scope list) as canonical boundaries. Step 4 must not add ISC rows for items in `SCOPE_OUT` without classifying them as `SCOPE_EXPANSION`.

3. **Dependency Check:**

```
Header: "Dependencies"
Question: "What must exist or be true before this work can begin?"
Options: [Text input - list blocking dependencies]
```

4. **Non-Functional Requirements Check (mandatory):**

   For each category, note if applicable. Results feed into ISC generation in Step 4.

   | Category | Prompt | If Yes → ISC Source |
   |----------|--------|---------------------|
   | **Performance** | "Any response time, throughput, or resource constraints?" | EXPLICIT or INFERRED |
   | **Security** | "Does this touch user input, auth, secrets, or external APIs?" | EXPLICIT or INFERRED |
   | **Accessibility** | "Does this have a UI component users interact with?" | IMPLICIT |

   - If user answers "none" to all three, record `NF: N/A` in spec Section 6.2 and move on
   - If any apply, generate corresponding ISC rows in Step 4 with specific verify methods
   - This replaces the THOROUGH+-only research agent probe for non-functional requirements

5. **Load User Stories and slice them vertically (Grounded Ideal if available):**
   - If Grounded Ideal exists and contains user stories, import them; otherwise derive stories from scope items.
   - **Slice vertically, not horizontally** (CLAUDE.md core principle). Each phase is a *thin end-to-end slice* — schema → API → UI → tests, all wired together — that is **demoable on its own**, not a horizontal layer.
     - **Phase 1 = the thinnest slice that delivers observable end-to-end behavior** — the highest-priority user story reduced to its minimum walking-skeleton path. Fold only the foundational pieces *that slice actually needs* into it.
     - **Phase 2+ = one slice per remaining user story** in priority order (P1 first, then P2, etc.), each independently demoable.
     - A standalone "Foundation"/infrastructure-only phase is a **last resort** — allowed only when a shared dependency genuinely cannot fold into Phase 1 (e.g. an irreducible migration every slice depends on). When used, place a `<!-- HORIZONTAL: <why this can't fold into a vertical slice> -->` comment next to the phase heading.

6. **Gap to Grounded Ideal:**
   - If Grounded Ideal exists, calculate remaining gap
   - Document what percentage of features this work addresses
   - Note which features remain for future work

**Output:** Gap analysis documented with user stories mapped to phases

---

### Step 4: ISC Generation

**Goal:** Create Ideal State Criteria rows for execution.

**This is the critical output that enables execution.**

**ISC Source Classification:**
- **EXPLICIT** — Directly stated in requirements
- **INFERRED** — Logically derived from explicit requirements and within `SCOPE_IN`
- **IMPLICIT** — Industry standard, best practice, or obvious need within `SCOPE_IN`
- **GROUNDED** — Inherited from Grounded Ideal constraints
- **RESEARCH** — Added by Step 4b research/council agents (THOROUGH+ only)
- **SCOPE_EXPANSION** — Discovered item that falls outside `SCOPE_IN` or inside `SCOPE_OUT`. Do NOT add to the ISC table. Collect in a separate "Scope Questions" list surfaced after the ISC table.

**ISC Generation Process:**

1. **Extract from requirements:**
   - Each deliverable becomes at least one ISC
   - Success criteria become ISC rows
   - Quality requirements become ISC rows

2. **Infer from context (effort-gated):**
   - **SMALL:** Skip inference entirely. Only extract from explicit requirements.
   - **MEDIUM:** Infer only within `SCOPE_IN`. Each inferred item must map to a stated scope item. Do not infer across domain boundaries not listed in scope.
   - **LARGE:** Full inference — what would a senior engineer expect, what would cause code review rejection, what would users complain about if missing. Check each inferred item against `SCOPE_OUT`; if it matches, classify as `SCOPE_EXPANSION`.

3. **Add from Grounded Ideal (if exists):**
   - Non-negotiables that apply to this work
   - Constraints that must be maintained
   - Verification requirements

4. **Add implicit best practices (NFR-gated and effort-gated):**
   Only add a best-practice ISC row if BOTH conditions are met: the NFR check in Step 3 flagged the relevant category, AND the effort level permits it:
   - **SMALL:** Suppress entirely. Best practices are not added regardless of NFR check.
   - **MEDIUM:** Add only the specific NFR categories that were flagged in Step 3. Do not add all four defaults unconditionally.
   - **LARGE:** Add all NFR categories flagged in Step 3. If none were flagged, do not add any.
   Items outside `SCOPE_IN` must be classified as `SCOPE_EXPANSION`, not silently added.

5. **Identify regression risks (effort-proportional):**
   - **SMALL:** 0-2 regression rows maximum. Only add if in-scope items directly touch specific existing behavior. Skip if greenfield.
   - **MEDIUM:** 2-4 regression rows. Name specific behaviors the scope items are most likely to disturb. Each row must name the concrete behavior, not a generic "nothing breaks" row.
   - **LARGE:** Comprehensive regression coverage. For each risk, generate an ISC row:
     - Source: `INFERRED`
     - Description format: "Existing [behavior] continues to work after changes"
     - Verify method: specific test command or assertion (not "manual review")
   - Skip only if this is greenfield work with no existing system to protect.
   All regression rows must reference behaviors within `SCOPE_IN` or directly adjacent to touched code paths. Risks for behaviors entirely outside scope must be classified as `SCOPE_EXPANSION`.

6. **Apply Splitting Test to each row:**
   Before finalizing, run each row through these 4 tests. If any fails, split the row.
   - **"And/With" test** — joins two verifiable things? Split.
   - **Independent failure test** — part A can pass while B fails? Separate rows.
   - **Scope word test** — "all/every/complete/full"? Enumerate.
   - **Domain boundary test** — crosses UI/API/data/logic? One row per boundary.
   Full methodology: apply the splitting test to each ISC row before finalizing.

7. **Apply row-count ceiling (soft guidance):**
   After splitting, check total ISC row count against the effort size:
   - **SMALL:** Target 5-10 rows. If over 10, review each row: is it truly in scope? Is it a point-4/5 addition that should be `SCOPE_EXPANSION` instead?
   - **MEDIUM:** Target 10-20 rows. If over 20, audit INFERRED and IMPLICIT rows first.
   - **LARGE:** Target 20-35 rows. Over 35 triggers a mandatory audit pass.
   The ceiling is advisory, not absolute. Exceeding it requires a one-line justification comment in the spec (e.g., `<!-- Row count: 23/20 — three separate API surfaces each require independent verification -->`).

**ISC Row Format:**

| # | What Ideal Looks Like | Source | Verify Method | Priority |
|---|----------------------|--------|---------------|----------|
| 1 | {{SPECIFIC_CRITERION}} | EXPLICIT | {{HOW_TO_VERIFY}} | smoke |
| 2 | {{SPECIFIC_CRITERION}} | INFERRED | {{HOW_TO_VERIFY}} | full |

**Priority values:** `smoke` (critical-path, run first for fast-fail), `full` (run in complete pass).
- Mark 2-4 rows as `smoke` — these represent the minimum viable verification
- All remaining rows default to `full`
- Smoke rows should be the ones that, if they fail, mean nothing else matters

**Scope Questions (SCOPE_EXPANSION items):**

After the ISC table, include this section if any `SCOPE_EXPANSION` items were identified during generation:

```markdown
### Scope Questions

The following items were discovered during ISC generation but fall outside the stated scope. Confirm whether any should be added before execution:

| # | Item | Why Flagged | Recommended Action |
|---|------|-------------|-------------------|
| SQ-1 | {{ITEM}} | {{REASON}} | Add to scope / Confirm out / Defer |
```

If no `SCOPE_EXPANSION` items were found, omit this section entirely.

8. **Assign ISC rows to phases:**
   - Group ISC rows by the phase they belong to
   - Phase 1 (Foundation) ISC rows cover core infrastructure criteria
   - Phase 2+ ISC rows map to their corresponding user story
   - After each `**Phase N: Name**` heading in Section 5.3, include `<!-- ISC: 1,2,3 -->` hint listing assigned ISC row numbers

9. **Add Given/When/Then per phase (slice acceptance):**
   - For each phase, derive acceptance criteria from the Grounded Ideal user stories
   - Use Gherkin format (Given/When/Then) inherited from user story acceptance criteria
   - Each phase must have at least one testable scenario whose **Then** is an *observable* end-to-end outcome (something a user or caller can see) — confirming the slice is demoable on its own, not an internal/structural state
   - Include an independent testability statement per phase. If a phase's only acceptance is internal (no observable outcome), it is a horizontal layer — fold it into the slice that consumes it, or justify it with the `<!-- HORIZONTAL: ... -->` marker from Step 3.5

**ISC Quality Checklist:**
- [ ] Each row passes the Splitting Test (no compound criteria)
- [ ] Each row is verifiable (not vague)
- [ ] Each row has clear verification method
- [ ] No duplicate criteria
- [ ] Covers happy path AND edge cases
- [ ] Includes non-functional requirements
- [ ] 2-4 ISC rows marked as `smoke` priority (critical-path fast-fail subset)
- [ ] Each ISC row is assigned to exactly one phase
- [ ] Each phase has Given/When/Then acceptance criteria
- [ ] Phases are vertical slices — Phase 1 is demoable end-to-end (not infrastructure-only); any horizontal/setup-only phase carries a `<!-- HORIZONTAL: <reason> -->` justification
- [ ] ≥60% of verify methods are behavioral for STANDARD+ items (bun test, curl, playwright — not test -f or grep)
- [ ] No description-verify mismatch (rows describing render/display/show/visible behavior paired with structural verify)
- [ ] No ISC row addresses a `SCOPE_OUT` item without being classified as `SCOPE_EXPANSION`
- [ ] Row count is within the effort-size ceiling (or has a justification comment)
- [ ] `SCOPE_EXPANSION` items are collected in the Scope Questions section, not silently added to the ISC table

**Output:** ISC rows documented, assigned to phases, with per-phase acceptance criteria

---

### Step 4c: Behavioral Classification Pass

**Goal:** Ensure ISC verify methods match the behavioral intent of each criterion.

**Trigger:** Run after generating all ISC rows in Step 4a. Required for STANDARD+ effort items.

**Process:**

For each ISC row, classify the verify method:
- **Behavioral** — executes code and asserts on runtime output: `bun test`, `curl`, `playwright`, `bun run ... | grep`, `node -e`, exit code assertions
- **Structural** — confirms code artifacts exist without running them: `test -f`, `grep -r`, `ls`, file existence checks
- **Mixed** — ambiguous runtime commands (e.g., `bun run validate.ts` without clear output assertion)

**Behavioral Ratio Rule (STANDARD+ items):**
- Count: `behavioralRows / totalRows * 100`
- If score < 60%: the spec will fail the `prepare()` quality gate. Upgrade structural verify methods to behavioral ones OR add a `<!-- STRUCTURAL: <reason why structural is acceptable here> -->` comment explaining why static verification is sufficient for that specific row.

**Surface-Specific ISC Rules:**

Apply the following decision table based on the spec's target surface:

| Surface | Requirement | WRONG Example | RIGHT Example |
|---------|-------------|---------------|---------------|
| **browser** | At least one ISC row must assert on a side effect after user interaction (click, submit, navigate, type, select, focus) | "Submit button exists on the form" verified with `test -f src/Form.tsx` | "After clicking Submit, form POST is sent and success toast appears" verified with `bun test e2e/submit.spec.ts` |
| **cli** | At least one ISC row must capture and assert on stdout content or exit code | "CLI script exists" verified with `test -f cli.ts` | "Running `bun run cli.ts --help` outputs usage text" verified with `bun run cli.ts --help \| grep 'Usage:'` |
| **api** | At least one ISC row must assert on response body content (not just HTTP status) | "POST /users returns 201" verified with `curl -s -o /dev/null -w "%{http_code}"` | "POST /users returns user object with id field" verified with `curl ... \| jq '.id' \| grep -v null` |
| **library** | At least one ISC row must import and call the exported function and assert on the return value | "Function is exported" verified with `grep 'export function' src/index.ts` | "classifyVerifyMethod('bun test') returns 'behavioral'" verified with `bun test src/__tests__/classify.test.ts` |

**Upgrading Structural Rows:**

When a row's description implies behavioral outcomes (renders, returns, displays, behaves) but the verify method is structural-only:
1. **Preferred:** Replace `test -f src/Component.tsx` with `bun test src/__tests__/Component.test.ts`
2. **Acceptable when behavioral test doesn't exist yet:** Add `<!-- STRUCTURAL: acceptance test not yet written; file existence confirms the component was created -->` and flag for TestWriter follow-up
3. **Acceptable for pure existence criteria:** File/directory structure checks for config files, deployment artifacts, or pure file-creation ISC rows do not need behavioral verify

**Output:** All ISC rows have classify annotations, ratio ≥60% for STANDARD+ confirmed, surface rules satisfied

---

### Step 4b: ISC Enhancement (Optional — THOROUGH+ Only)

**Goal:** Surface gaps, edge cases, and failure modes in the ISC before execution begins.

**Trigger conditions (any):**
- ISC row count > 6
- Work domain has significant unknowns (new technology, complex integrations, unfamiliar codebase)
- User indicates complex scope during Step 2/3

**When triggered, offer via AskUserQuestion:**

```
Header: "ISC Enhancement"
Question: "This spec has {{N}} ISC rows for THOROUGH+ work. Want to stress-test the ISC before execution?"
Options:
- "Yes — run research agents" - 3-5 targeted agents investigate common failure modes, edge cases, non-functional requirements, and code review blockers for this domain
- "Yes — run mini-council" - 2 agents (Completeness Checker + Edge Case Hunter) debate the ISC for 1 round
- "Yes — both" - Research first, then council reviews findings
- "No — ISC is sufficient" - Skip enhancement, proceed to overlay
```

**Research Agent Prompts (when selected):**
1. "What are the 3 most common failure modes when implementing {{DOMAIN}}?"
2. "What edge cases are typically missed in {{TASK_TYPE}} work like {{TITLE}}?"
3. "What non-functional requirements (performance, security, accessibility) apply to {{DOMAIN}}?"
4. "What would a senior code reviewer flag as missing in a spec for {{TITLE}}?"
5. (If applicable) "What integration or backward-compatibility issues arise when modifying {{AFFECTED_FILES}}?"

**Council Roles (when selected):**
- **Completeness Checker:** "Review the ISC rows. What requirements or acceptance criteria are missing? What would cause stakeholder rejection?"
- **Edge Case Hunter:** "For each ISC row, what's the most likely way it could pass verification but still be wrong in production?"

**Processing results:**
1. Deduplicate findings against existing ISC rows
2. Convert new findings into ISC rows with source: `RESEARCH`
3. Append RESEARCH rows after existing ISC rows (preserve original numbering, new rows get next sequential IDs)
4. Re-run ISC Quality Checklist on the expanded set

**Cost control:** One-time cost at spec creation (~$0.05-0.20 for 3-5 agents), not per-execution.

**Output:** ISC rows optionally enhanced with RESEARCH-sourced rows

---

### Step 4d: UX/UI Spec Generation

**Goal:** Produce a development-ready UX/UI Spec for any browser or native surface, inserted into the spec before ISC derivation (ADR 0004 — Stage runs before ISC, interactive-first rollout).

**Canonical rule source:** `skills/Agents/SpecSheet/Tools/UXUIStage.ts` — thresholds below mirror it exactly.

**Surface determination (interactive):**

This is an interactive spec session; there is no classifier verdict yet. Infer surface from the work description:
- Web UI / browser app / React / Next.js / SPA / form / page / component / screen → `browser`
- iOS / Android / React Native / Flutter / mobile app / native app → `native`
- CLI / command-line tool / script / terminal → `cli` (skip UX/UI)
- REST API / GraphQL / gRPC / backend service → `api` (skip UX/UI)
- npm package / library / SDK / importable module → `library` (skip UX/UI)

If the surface is ambiguous from the description, ask:
```
Header: "Surface"
Question: "What kind of thing is this work targeting?"
Options:
- "Browser / web app (React, Next.js, SPA, form, page, component)"
- "Native mobile app (iOS, Android, React Native, Flutter)"
- "CLI / command-line tool"
- "API / backend service"
- "Library / SDK / package"
```

**Trigger:** Run this step only when surface ∈ {`browser`, `native`}. Skip entirely for `cli`, `api`, `library`, or unknown surfaces — proceed to Step 5.

**Effort → model mapping (mirrors UXUIStage.ts `modelForEffort`):**
- Small or Medium effort → **Sonnet**
- Large effort → **Opus**

**Agent sequence (mirrors UXUIStage.ts `planUXUIStage`):**

Run the following agents in order. Each agent prepends its `*Context.md` before loading its skill workflow.

**Agent 1 — UXDesigner** (always when surface fires):
```
- subagent_type: "general-purpose"
- prepend_context: "skills/Agents/UXDesignerContext.md"
- model: <Sonnet for Small/Medium | Opus for Large>
- prompt: |
    You are the UXDesigner. Surface: {{SURFACE}}. Effort: {{EFFORT}}.
    Work title: {{TITLE}}.
    Work description: {{DESCRIPTION}}.

    Load skills/Development/UXSpec/Workflows/GenerateUXSpec.md and generate
    the full UX Spec scaled to effort tier {{EFFORT}}. Output a Screen Inventory
    yaml block (tagged `screen-inventory`) + per-screen UX sections with user
    flows (Mermaid), screen×state matrix, microcopy, and Given/When/Then
    acceptance criteria. Return your complete output.
```

**Agent 2 — UIDesigner** (always when surface fires; consumes UXDesigner output):
```
- subagent_type: "general-purpose"
- prepend_context: "skills/Agents/UIDesignerContext.md"
- model: <Sonnet for Small/Medium | Opus for Large>
- prompt: |
    You are the UIDesigner. Surface: {{SURFACE}}. Effort: {{EFFORT}}.
    UX Spec output (Screen Inventory + per-screen sections):
    {{UXDESIGNER_OUTPUT}}

    Load skills/Development/UISpec/Workflows/GenerateUISpec.md and generate
    the UI realization for every screen and every state in the Screen×State Matrix.
    Co-locate wireframes (annotated HTML+Tailwind skeletons), component inventory,
    design tokens (by name — never raw hex/px), and WCAG 2.2 AA accessibility
    notes into the per-screen sections keyed by screen id. Return your complete output.
```

**Agent 3 — Designer review** (Medium or Large effort only):
```
- subagent_type: "general-purpose"
- prepend_context: "skills/Agents/DesignerContext.md"
- model: Opus   ← always Opus for review, regardless of effort tier
- prompt: |
    You are the Designer (review-only, not a generator). Effort: {{EFFORT}}.
    Review the combined UX/UI Spec below for quality, completeness, and
    consistency. Check: every screen in the Screen Inventory has a wireframe
    for every state; acceptance criteria are behavioral (Given/When/Then);
    no raw hex/px values; all interactive components have ARIA roles + contrast
    notes; no lorem ipsum. Return a structured critique with specific gaps and
    suggested improvements.
    UX/UI Spec:
    {{UXDESIGNER_OUTPUT}}
    {{UIDESIGNER_OUTPUT}}
```
_Note: Small effort → Designer review is skipped (ADR 0006: effort = scope + depth, never skip the skills themselves)._

**After all agents complete:**

Append a single **"## UX/UI Specification"** section to the saved spec (after Section 4 ISC
rows, before Section 5 overlays), followed immediately by the per-screen `## Screen:` sections.
The canonical structure is defined in `skills/Agents/SpecSheet/UXUISpecFormat.md`:

```markdown
## UX/UI Specification

> Generated by UXDesigner + UIDesigner ({{MODEL}}). Surface: {{SURFACE}}. Effort: {{EFFORT}}.
> {{IF REVIEW}}Reviewed by Designer.{{/IF}}

` ` `yaml screen-inventory
{{SCREEN_INVENTORY_YAML}}
` ` `

### User Flows

{{MERMAID_FLOWS}}

## Screen: {{SCREEN_NAME}} (`{{SCREEN_ID}}`)

**Purpose / Entry / Exits:** {{PURPOSE_ENTRY_EXITS}}

**Acceptance Criteria:**
- Given {{precondition}}, when {{action}}, then {{outcome}}.

### State: {{state}}

{{WIREFRAME_AND_A11Y_NOTES}}

### Component Inventory

{{COMPONENT_TABLE}}

### Accessibility (WCAG 2.2 AA)

- ARIA: role=… / aria-… on interactive elements
- Contrast: 4.5:1 text / 3:1 UI; touch targets ≥ min-h-[44px]

## Screen: {{NEXT_SCREEN_NAME}} (`{{NEXT_SCREEN_ID}}`)

... (one ## Screen: H2 per screen in the inventory)
```

**Key rules (enforced by SpecValidator):**
- Each screen is a top-level `## Screen: <Name> (`<id>`)` H2 — not nested under `### Per-Screen Specifications`.
- `### State: <state>` (H3) is the machine-detectable wireframe coverage marker.
- Every `## Screen:` section must contain ≥1 `Given … when … then …` criterion AND a `### Accessibility` subsection with ARIA + contrast.

**Output:** `## UX/UI Specification` section + `## Screen:` sections appended to the spec; Screen Inventory available for ISC derivation in subsequent steps.

---

### Step 5: Overlay Selection

**Goal:** Apply the appropriate task-type overlay.

**Based on task type from Step 2:**

| Task Type | Overlay | Key Additions |
|-----------|---------|---------------|
| AI Task | `Templates/Overlays/AITask.overlay.md` | Autonomy boundaries, observability, escalation |
| Human Task | `Templates/Overlays/HumanTask.overlay.md` | Approval workflow, handoff points, communication |
| Coding Project | `Templates/Overlays/CodingProject.overlay.md` | Tech stack, PR requirements, code quality |
| Mixed | Multiple overlays | Combine relevant sections |

**Process:**

1. Load appropriate overlay template
2. Fill overlay sections based on gathered context
3. Integrate into Section 8 of Current Work spec

**Effort-Proportional Overlay (CodingProject tasks):**

When the task type is Coding Project, include only the overlay sections appropriate to the effort size:

| Effort | Include | Omit |
|--------|---------|------|
| **SMALL** | A (Technical Stack), B (Code Quality) | C, D, E, F, G |
| **MEDIUM** | A, B, C (PR Requirements), D (Architecture) | E, F, G |
| **LARGE** | All sections A-G | None |

For SMALL and MEDIUM specs, add a one-line note in Section 8: `<!-- Overlay sections [list omitted] deferred — not proportional to effort size -->`

For AI Task and Human Task overlays, apply the full overlay regardless of effort size.

**Overlay Questions (if needed):**

For AI Task:
```
Header: "Autonomy Level"
Question: "How autonomous should this agent be?"
Options:
- "Fully autonomous" - Acts without approval
- "Mostly autonomous" - Asks for high-impact decisions only
- "Supervised" - Asks before most actions
- "Assisted" - Suggests but human executes
```

For Human Task:
```
Header: "Approval Chain"
Question: "Who needs to approve work at key stages?"
Options: [Text input - roles/names]
```

For Coding Project:
```
Header: "Test Coverage"
Question: "What test coverage target applies?"
Options:
- "≥90%" - Critical path, high risk
- "≥80%" - Standard production code
- "≥70%" - Lower risk, move fast
- "Best effort" - Prototype/experiment
```

**Output:** Overlay content generated

---

## Final Synthesis

**Compile all steps into the Current Work specification.**

**Use Template:** `Templates/VisionTiers/CurrentWork.md`

**Fill sections conditionally:**
1. Summary from Steps 1-2
2. Current → Target State from Step 3
3. Scope Definition from Step 3 (including Scope Questions section if `SCOPE_EXPANSION` items exist)
4. ISC Rows from Step 4 (CRITICAL)
5. Implementation Approach (synthesize from context)
6. Verification Plan (derive from ISC verification methods)
7. **Behavioral Verification** (required for STANDARD+ items; omit for QUICK/documentation-only)
8. Workflow Diagram placeholder
9. Overlay content from Step 5 (effort-proportional — see Step 5)

**Vision sections (template Sections 1.2, 2.3, 3.4) are conditional:**
- If a Grounded Ideal spec was found in Step 1: fill Sections 1.2, 2.3, and 3.4 normally
- If NO Grounded Ideal exists (standalone): replace Section 1.2 with "No Grounded Ideal exists for this domain — spec is standalone." Replace Section 2.3 with "N/A — no Grounded Ideal to measure against." Replace Section 3.4 with stories derived from scope items. Do NOT generate placeholder percentage values.

### Behavioral Verification Section Template

Include the following section in every STANDARD+ spec output, after the Verification Plan:

```markdown
## Behavioral Verification

Top 3 user-facing flows this spec must verify at runtime:

**Flow 1: {{FLOW_1_NAME}}**
Given {{precondition}}
When {{user_action_or_system_event}}
Then {{observable_outcome_that_confirms_correct_behavior}}

**Flow 2: {{FLOW_2_NAME}}**
Given {{precondition}}
When {{user_action_or_system_event}}
Then {{observable_outcome_that_confirms_correct_behavior}}

**Flow 3: {{FLOW_3_NAME}}**
Given {{precondition}}
When {{user_action_or_system_event}}
Then {{observable_outcome_that_confirms_correct_behavior}}
```

**Rules for filling this section:**
- Each Given/When/Then scenario must map to at least one ISC row's verify method
- "Then" must describe an **observable** outcome (output appears in terminal, HTTP response body contains X, UI shows Y) — not an internal state
- For non-behavioral specs (documentation-only, config-only, QUICK items), this section may be omitted or replaced with "N/A — no runtime-observable behavior"

**Example (for this spec's own Behavioral Verification):**

```markdown
## Behavioral Verification

**Flow 1: Structural verify method classification**
Given a spec with ISC rows using test -f and bun test verify methods
When classifyVerifyMethod() is called on each verify method string
Then test -f returns "structural" and bun test returns "behavioral"

**Flow 2: Behavioral quality gate enforcement**
Given a STANDARD item with 3/5 ISC rows using test -f verify methods (40% behavioral)
When prepare() is called
Then prepare() returns success: false with error containing "behavioral quality gate" and naming the 3 structural rows

**Flow 3: QUICK item bypass with warning**
Given a QUICK item with 2 all-structural ISC rows
When prepare() is called
Then prepare() returns success: true with warnings array containing a behavioral quality notice
```

---

## Output Location

Save to: `~/.claude/Plans/Specs/{{WorkName}}-current-work.md`

**Naming convention:**
- Use kebab-case
- Include date if ephemeral: `2026-02-01-add-auth-endpoint-current-work.md`
- Omit date if persistent: `pkm-capture-agent-current-work.md`

---

## Integration with AutonomousWork

**The ISC rows are designed for direct use with AutonomousWork.**

To execute:
```
"Execute with AutonomousWork on this spec"
→ AutonomousWork loads ISC rows from Section 4
→ Executes toward each criterion
→ Verifies using specified methods
→ Reports status
```

---

## Post-Generation Options

Offer next steps:

1. **"Execute with AutonomousWork"** → Execute against ISC rows
2. **"Generate workflow diagram"** → Visual via Art skill
3. **"Create subtasks"** → Break into smaller work items
4. **"Add to Asana"** → Create task with spec attached

---

## Example Usage

```
User: "Create current work spec for adding priority field to tasks"

→ Step 1: Check for TaskManagement Grounded Ideal (found, Milestone 2)
→ Step 2: "Add priority field" work, Coding Project type
          Current: Tasks have no priority
          Target: Tasks have LOW/MEDIUM/HIGH/URGENT priority
→ Step 3: In scope: DB migration, API update, UI dropdown
          Out of scope: Auto-prioritization, priority-based sorting
→ Step 4: Generate 8 ISC rows:
          #1: DB has priority column (EXPLICIT, check schema)
          #2: API accepts priority param (EXPLICIT, test endpoint)
          #3: API validates priority values (INFERRED, test invalid)
          #4: UI shows priority dropdown (EXPLICIT, screenshot)
          #5: Default priority is MEDIUM (INFERRED, create task)
          #6: Priority persists on reload (IMPLICIT, refresh test)
          #7: Migration is reversible (IMPLICIT, check rollback)
          #8: No N+1 queries introduced (GROUNDED, query log)
→ Step 5: Apply CodingProject overlay (TypeScript, 80% coverage)
→ Output: Complete implementation-ready spec
```

---

## Quick Mode

For simple tasks, use abbreviated flow:

```
User: "Quick current work spec for fixing the login button"

→ Skip vision context detection
→ Minimal current state: "Button doesn't work"
→ Minimal gap: "Button works"
→ Generate 3-5 ISC rows directly
→ Skip overlay (or apply minimal)
→ Output: Lean but actionable spec
```

---

**Last Updated:** 2026-02-01
