# GroundedIdeal Workflow

**Generate an achievable ideal specification grounded in today's technology.**

This workflow produces a specification for achievable excellence—the best possible solution with current technology and practical constraints. It serves as the bridge between the unconstrained Solarpunk Vision and actionable Current Work specs.

## Philosophy

> "What is the best we can build RIGHT NOW, while preserving the essence of the ideal?"

The Grounded Ideal:
- Applies technology constraints systematically
- Documents conscious compromises
- Preserves non-negotiable aspects of the vision
- Creates a realistic milestone path
- Maintains traceability to Solarpunk Vision

## Prerequisites

- Solarpunk Vision spec exists (preferred) OR clear problem domain
- Understanding of available technology stack
- Awareness of resource constraints

---

## The Five-Phase Protocol

### Phase 1: Solarpunk Loading

**Goal:** Load and parse the Solarpunk Vision if it exists.

**Process:**

1. **Check for existing Solarpunk Vision:**
```bash
# Look for matching domain spec
ls ~/.claude/Plans/Specs/*solarpunk*.md
ls ~/.claude/Plans/Specs/*ideal-end-state*.md
```

2. **If Solarpunk exists:**
   - Read the full specification
   - Extract all features from Section 8 (Grounding Assessment)
   - Categorize features by achievability
   - Note non-negotiables from the vision

3. **If no Solarpunk exists:**
   - Ask if user wants to create one first (recommended)
   - OR proceed with abbreviated problem definition

**Output if no Solarpunk:**
```
Header: "Solarpunk Vision"
Question: "No Solarpunk Vision found for this domain. Would you like to:"
Options:
- "Create Solarpunk first" - Run IdealEndState workflow, then return here
- "Proceed without" - Create Grounded Ideal directly (less traceability)
```

**If proceeding without Solarpunk, gather minimal context:**

```
Header: "Core Vision"
Question: "Describe the ideal outcome you're trying to achieve (the unconstrained vision):"
Options: [Text input]
```

```
Header: "Key Features"
Question: "List the 5-7 most important features/capabilities:"
Options: [Text input]
```

**Output:** `scratch/01-solarpunk-context.md`

---

### Phase 2: Technology Assessment

**Goal:** Assess current technology capabilities against vision requirements.

**Process:**

For each feature from the Solarpunk Vision (or gathered context):

1. **Capability Assessment:**
   - Can current AI models do this?
   - Do the required APIs/integrations exist?
   - Is the infrastructure mature enough?
   - What's the performance envelope?

2. **Maturity Classification:**
   | Maturity Level | Definition | Risk Level |
   |----------------|------------|------------|
   | **Proven** | Production use at scale | Low |
   | **Emerging** | Working but limited deployment | Medium |
   | **Experimental** | Demos exist, not production-ready | High |
   | **Theoretical** | Concept only, no working implementation | Very High |

3. **Gap Identification:**
   - What specifically can't be done today?
   - What would be degraded (slower, less accurate, etc.)?
   - What requires workarounds?

**Technology Assessment Template:**

```markdown
## Feature: {{FEATURE_NAME}}

**Solarpunk Requirement:** {{WHAT_IDEAL_NEEDS}}

**Current Technology:**
- Closest available: {{TECHNOLOGY}}
- Maturity: {{PROVEN|EMERGING|EXPERIMENTAL|THEORETICAL}}
- Gap: {{SPECIFIC_GAP}}

**Grounded Alternative:**
- Implementation: {{ACHIEVABLE_VERSION}}
- Trade-offs: {{WHAT_WE_LOSE}}
- Why acceptable: {{RATIONALE}}
```

**Output:** `scratch/02-technology-assessment.md`

---

### Phase 2.5: User Story Synthesis

**Goal:** Transform Solarpunk features into prioritized, testable user stories with acceptance criteria.

**Process:**

1. **Transform features into user stories:**
   - For each feature from the Solarpunk Vision (or gathered context), write a user story in As a/I want/So that format
   - Each story must represent a single, independently deliverable capability
   - Stories should capture the user's intent, not the implementation

2. **Assign priorities:**
   | Priority | Definition | Handling |
   |----------|------------|----------|
   | **P1** | Non-negotiable features | Must be preserved in Grounded Ideal |
   | **P2** | Degraded-but-present | Implemented with conscious compromises |
   | **P3** | Consciously deferred | Documented for future iteration |

3. **Generate acceptance criteria per story:**
   - Write Given/When/Then acceptance criteria for each user story
   - Each story should have 1-3 acceptance criteria blocks
   - Criteria must be specific and measurable

4. **Verify independent testability:**
   - Each story must be testable in isolation
   - Document how the story can be verified without dependencies on other stories
   - Identify edge cases that could cause failures

5. **Generate Functional Requirements:**
   - Derive FR-001, FR-002, etc. from user stories
   - Each requirement must trace back to a user story ID
   - Each requirement must be independently testable (Yes/No)

**User Story Template:**

```markdown
## US-{{NNN}}: {{STORY_TITLE}}

**Story:** As a {{PERSONA}}, I want {{GOAL}} so that {{BENEFIT}}
**Priority:** P{{1|2|3}}
**Justification:** {{WHY_THIS_PRIORITY}}

**Acceptance Criteria:**
​```gherkin
Given {{PRECONDITION}}
When {{ACTION}}
Then {{EXPECTED_OUTCOME}}
​```

**Independent Testability:** {{HOW_TO_TEST_IN_ISOLATION}}

**Edge Cases:**
- {{EDGE_CASE_1}}
- {{EDGE_CASE_2}}

**Functional Requirements:**
- FR-{{NNN}}: {{REQUIREMENT}}
```

**Output:** `scratch/02.5-user-stories.md`

---

### Phase 3: Constraint Mapping

**Goal:** Systematically map user stories to grounded alternatives with constraint analysis.

**Process:**

1. **Constraint Categories:**
   - **TECH** — Technology limitation
   - **COST** — Resource/budget constraint
   - **TIME** — Timeline pressure
   - **LEGAL** — Regulatory/compliance requirement
   - **SOCIAL** — User behavior/adoption barrier

2. **For each user story, create mapping:**

| # | User Story | Grounded Implementation | Constraint | Preservation % |
|---|------------|-------------------------|------------|----------------|
| US-001 | {{STORY_SUMMARY}} | {{IMPLEMENTATION}} | {{TYPE}} | {{0-100}}% |

3. **Identify Non-Negotiables (P1 stories):**
   - Which user stories MUST be preserved at ≥80%?
   - What defines the "essence" of the vision?
   - What would make this not worth building if compromised?

4. **Identify Conscious Deferrals (P3 stories):**
   - What's intentionally punted to future?
   - What trigger would allow reconsideration?
   - What dependency must be resolved first?

**Constraint Mapping Questions (if clarification needed):**

```
Header: "Must-Haves"
Question: "Which of these features are non-negotiable (must be preserved even if degraded)?"
Options: [Multi-select from feature list]
```

```
Header: "Acceptable Deferrals"
Question: "Which features can be consciously deferred to a future version?"
Options: [Multi-select from feature list]
```

**Output:** `scratch/03-constraint-mapping.md`

---

### Phase 4: Architecture Design

**Goal:** Design practical architecture that maximizes alignment with the vision.

**Process:**

1. **Component Identification:**
   - What components are needed?
   - What's their maturity level?
   - How do they integrate?

2. **Integration Design:**
   - Define integration points
   - Specify SLAs and fallbacks
   - Document data flows

3. **Risk Assessment:**
   - What are the key technical risks?
   - What mitigation strategies exist?
   - What's the contingency plan?

**Architecture Questions (use if needed):**

```
Header: "Primary Model"
Question: "What AI model tier should be the default for this system?"
Options:
- "Haiku" - Fast, cheap, good for simple tasks
- "Sonnet" - Balanced speed/quality for most tasks
- "Opus" - Highest quality for complex reasoning
- "Mixed" - Different models for different components
```

```
Header: "Infrastructure"
Question: "What deployment environment is appropriate?"
Options:
- "Local only" - Runs entirely on user's machine
- "Hybrid" - Local with cloud APIs
- "Cloud-first" - Primarily cloud-hosted
- "Edge" - Distributed edge computing
```

4. **Verification Strategy:**
   - Define acceptance criteria
   - Specify test strategy
   - Establish quality gates

**Output:** `scratch/04-architecture-design.md`

---

### Phase 5: Milestone Planning

**Goal:** Define the path from current state to Grounded Ideal.

**Process:**

1. **Current State Assessment:**
   - What exists today?
   - What's the baseline?
   - What works, what doesn't?

2. **Milestone Definition:**
   - Break journey into 2-4 milestones
   - Each milestone should be independently valuable
   - Define clear success criteria for each

3. **Dependency Mapping:**
   - What must happen before each milestone?
   - What external dependencies exist?
   - What's the critical path?

**Milestone Template:**

```markdown
## Milestone {{N}}: {{NAME}}

**Objective:** {{OBJECTIVE}}

**Deliverables:**
- {{DELIVERABLE_1}}
- {{DELIVERABLE_2}}

**Success Criteria:**
- {{CRITERION_1}}
- {{CRITERION_2}}

**Dependencies:**
- {{DEPENDENCY_1}}
- {{DEPENDENCY_2}}

**Risks:**
- {{RISK_1}}: {{MITIGATION}}
```

4. **Resource Assessment:**
   - What resources are needed?
   - What's the rough scope?
   - What's the critical path?

**Output:** `scratch/05-milestone-plan.md`

---

## Final Synthesis

**Compile all phases into the Grounded Ideal specification.**

**Use Template:** `Templates/VisionTiers/GroundedIdeal.md`

**Fill all sections from phase outputs:**
- Section 1 (Executive Summary) from constraint mapping synthesis
- Section 2 (User Stories & Requirements) from Phase 2.5 user story synthesis
- Section 3 (Practical Architecture) from technology assessment (3.0) + architecture design (3.1-3.3)
- Section 4 (Constraints Applied) from constraint mapping
- Section 5 (Milestone Path) from milestone planning
- Section 6 (Verification Strategy) from technology assessment (6.0 performance targets) + user stories (6.1 acceptance criteria grouped by story ID)

---

## Output Location

Save to: `~/.claude/Plans/Specs/{{Domain}}-grounded-ideal.md`

Also save working artifacts:
- `scratch/01-solarpunk-context.md`
- `scratch/02-technology-assessment.md`
- `scratch/02.5-user-stories.md`
- `scratch/03-constraint-mapping.md`
- `scratch/04-architecture-design.md`
- `scratch/05-milestone-plan.md`

---

## Post-Generation Options

Offer next steps:

1. **"Create Current Work spec"** → Generate implementation spec for first milestone
2. **"Generate architecture diagram"** → Visual via Art skill
3. **"Review with stakeholders"** → Format for human review
4. **"Update Solarpunk Vision"** → Incorporate learnings back to vision

---

## Example Usage

```
User: "Create grounded ideal for personal knowledge management"

→ Phase 1: Load existing PKM Solarpunk Vision (or gather context)
→ Phase 2: Assess: Can we do semantic search? (Yes, with embeddings)
           Can we do thought anticipation? (Partially, with heuristics)
           Can we do zero-effort capture? (Degraded, requires some input)
→ Phase 3: Map 12 Solarpunk features to grounded alternatives
           3 non-negotiables, 4 deferrals, 5 degraded implementations
→ Phase 4: Design architecture with Obsidian + embeddings + AI processing
           Define fallbacks for each integration point
→ Phase 5: Define 3 milestones: Foundation → Intelligence → Anticipation
→ Output: Comprehensive grounded ideal specification
```

---

**Last Updated:** 2026-02-01
