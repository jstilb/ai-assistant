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

**For existing systems, gather:**
- Current functionality
- Current limitations
- Current metrics (if available)
- Known issues

**Output:** Current state documented

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

5. **Load User Stories from Grounded Ideal (if available):**
   - If Grounded Ideal exists and contains user stories, import them
   - Map user stories to implementation phases:
     - **Phase 1 = Foundation** — Core infrastructure, shared dependencies, base setup
     - **Phase 2+ = One per user story** in priority order (P1 first, then P2, etc.)
   - If no Grounded Ideal user stories exist, derive stories from scope items

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
- **INFERRED** — Logically derived from explicit requirements
- **IMPLICIT** — Industry standard, best practice, or obvious need
- **GROUNDED** — Inherited from Grounded Ideal constraints
- **RESEARCH** — Added by Step 4b research/council agents (THOROUGH+ only)

**ISC Generation Process:**

1. **Extract from requirements:**
   - Each deliverable becomes at least one ISC
   - Success criteria become ISC rows
   - Quality requirements become ISC rows

2. **Infer from context:**
   - What would a senior engineer expect?
   - What would cause rejection in code review?
   - What would users complain about if missing?

3. **Add from Grounded Ideal (if exists):**
   - Non-negotiables that apply to this work
   - Constraints that must be maintained
   - Verification requirements

4. **Add implicit best practices:**
   - Error handling
   - Edge cases
   - Security considerations
   - Performance requirements

5. **Identify regression risks (mandatory):**
   - What existing behavior must this work preserve?
   - What could break if this change has unintended side effects?
   - For each risk, generate an ISC row:
     - Source: `INFERRED`
     - Description format: "Existing [behavior] continues to work after changes"
     - Verify method: specific test command or assertion (not "manual review")
   - Skip only if this is greenfield work with no existing system to protect

6. **Apply Splitting Test to each row:**
   Before finalizing, run each row through these 4 tests. If any fails, split the row.
   - **"And/With" test** — joins two verifiable things? Split.
   - **Independent failure test** — part A can pass while B fails? Separate rows.
   - **Scope word test** — "all/every/complete/full"? Enumerate.
   - **Domain boundary test** — crosses UI/API/data/logic? One row per boundary.
   Full methodology: apply the splitting test to each ISC row before finalizing.

**ISC Row Format:**

| # | What Ideal Looks Like | Source | Verify Method | Priority |
|---|----------------------|--------|---------------|----------|
| 1 | {{SPECIFIC_CRITERION}} | EXPLICIT | {{HOW_TO_VERIFY}} | smoke |
| 2 | {{SPECIFIC_CRITERION}} | INFERRED | {{HOW_TO_VERIFY}} | full |

**Priority values:** `smoke` (critical-path, run first for fast-fail), `full` (run in complete pass).
- Mark 2-4 rows as `smoke` — these represent the minimum viable verification
- All remaining rows default to `full`
- Smoke rows should be the ones that, if they fail, mean nothing else matters

7. **Assign ISC rows to phases:**
   - Group ISC rows by the phase they belong to
   - Phase 1 (Foundation) ISC rows cover core infrastructure criteria
   - Phase 2+ ISC rows map to their corresponding user story
   - After each `**Phase N: Name**` heading in Section 5.3, include `<!-- ISC: 1,2,3 -->` hint listing assigned ISC row numbers

8. **Add Given/When/Then per phase:**
   - For each phase, derive acceptance criteria from the Grounded Ideal user stories
   - Use Gherkin format (Given/When/Then) inherited from user story acceptance criteria
   - Each phase must have at least one testable scenario
   - Include independent testability statement per phase

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

**Output:** ISC rows documented, assigned to phases, with per-phase acceptance criteria

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

**Fill all sections:**
1. Summary from Steps 1-2
2. Current → Target State from Step 3
3. Scope Definition from Step 3
4. ISC Rows from Step 4 (CRITICAL)
5. Implementation Approach (synthesize from context)
6. Verification Plan (derive from ISC verification methods)
7. Workflow Diagram placeholder
8. Overlay content from Step 5

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
