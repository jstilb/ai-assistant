# IdealEndState Workflow (Solarpunk Vision Generator)

**Generate a Solarpunk Vision specification through research, debate, and unconstrained imagination.**

This workflow produces the **Solarpunk Vision**—the utopian north star where humans, environment, and technology exist in harmony. It's the first tier of the vision hierarchy, intentionally unconstrained by current limitations.

## Philosophy

> "What does human flourishing look like when technology serves without dominating, and systems work in harmony with both people and planet?"

**Solarpunk Principles:**
- **Human-centered:** Technology amplifies human capabilities, not replaces human agency
- **Environmentally harmonious:** Systems integrate with rather than exploit the environment
- **Invisible technology:** The best tech disappears into the experience
- **Zero friction:** Ideal interactions require minimal or no effort
- **Anticipatory:** Systems know what you need before you ask
- **Delightful:** Experiences exceed expectations in meaningful ways

Most specs are constrained by:
- Current technical limitations
- Budget and timeline pressures
- "Realistic" expectations that limit imagination
- Incremental thinking based on what exists

This workflow explicitly removes those constraints to define the **Solarpunk Vision**—the destination worth striving toward, even if the path isn't fully clear.

## Prerequisites

- User has a problem domain or concept in mind
- User is available for initial problem definition (10-15 min)
- Willingness to think beyond "realistic" constraints

## The Eight-Phase Protocol

### Phase 1: Problem Excavation (The Why)

**Goal:** Uncover the deepest motivating problem, not just symptoms.

**Questions using AskUserQuestion:**

```
Header: "Core Problem"
Question: "What is the fundamental problem you're trying to solve? Go deeper than the surface—what's the pain that makes this problem worth solving?"
Options: [Text input]
```

```
Header: "Who Suffers"
Question: "Who experiences this problem most acutely? Describe the person and their context."
Options: [Text input]
```

```
Header: "Current State"
Question: "What does the current state look like? How do people cope with this problem today?"
Options: [Text input]
```

```
Header: "Stakes"
Question: "What happens if this problem is never solved? What's the cost of the status quo?"
Options:
- "Minor inconvenience" - Annoying but livable
- "Significant friction" - Measurable productivity/quality loss
- "Critical blocker" - Prevents important outcomes
- "Existential" - Fundamental to success/survival
```

**Output:** `scratch/01-problem-excavation.md`

---

### Phase 2: Extensive Research

**Goal:** Gather comprehensive understanding of the problem space, existing solutions, cutting-edge approaches, and domain expertise.

**Invoke Research Skill - ExtensiveResearch workflow:**

Research prompts (12 parallel agents):
1. "State of the art solutions for [problem domain]"
2. "Academic research on [core problem]"
3. "Best-in-class UX patterns for [problem domain]"
4. "Failed attempts and lessons learned in [problem domain]"
5. "Adjacent domains with solved versions of similar problems"
6. "Emerging technologies applicable to [problem domain]"
7. "Expert opinions on ideal solutions for [problem domain]"
8. "User research and pain points in [problem domain]"
9. "Future predictions for [problem domain]"
10. "First principles analysis of [core problem]"
11. "Unconventional approaches to [problem domain]"
12. "What would [domain] look like if unlimited resources were applied?"

**Synthesis Requirements:**
- Identify patterns across successful solutions
- Note what's missing from current approaches
- Extract principles that apply to ideal solutions
- Document breakthrough ideas worth incorporating

**Output:** `scratch/02-research-synthesis.md`

---

### Phase 3: Council Debate - Problem Framing

**Goal:** Challenge and refine the problem definition through multi-perspective debate.

**Invoke Council Skill - Debate workflow:**

**Council Members for Problem Framing:**

| Agent | Perspective | Question They Answer |
|-------|-------------|---------------------|
| **User Advocate** | End user's lived experience | "Is this the real problem users face, or a symptom?" |
| **Systems Thinker** | Interconnected effects | "What adjacent problems does this connect to?" |
| **Contrarian** | Devil's advocate | "What if this problem isn't worth solving at all?" |
| **Visionary** | Long-term thinking | "How might this problem evolve in 5-10 years?" |

**Debate Topic:** "What is the true core problem, and what does an ideal solution fundamentally require?"

**3 Rounds:**
1. Initial positions on the core problem
2. Responses to each other's framings
3. Convergence on refined problem definition

**Output:** `scratch/03-problem-debate.md`

---

### Phase 4: Vision Definition (The What)

**Goal:** Define the ideal end state without constraints.

**Prompting:**
```
You are defining the IDEAL end state for solving this problem.

CONSTRAINTS REMOVED:
- Unlimited budget
- No timeline pressure
- Current technical limitations don't apply
- "Impossible" is just "not yet figured out"

Your task: Describe what the PERFECT solution looks like from the user's perspective.

For EVERY interaction, describe:
1. What the user experiences (feelings, not features)
2. What effort is required from them (ideally: zero)
3. What the outcome looks like (specific and vivid)
4. Why this is meaningfully better than current state

Do NOT describe:
- Implementation details
- Technical architecture
- Compromises or trade-offs
- "Realistic" limitations
```

**Output:** `scratch/04-vision-definition.md`

---

### Phase 5: Ideal UX Design

**Goal:** Design interfaces so seamless they feel like magic.

**UX Design Principles for Ideal State:**

| Principle | Meaning | Example |
|-----------|---------|---------|
| **Zero Friction** | No unnecessary steps | Voice command instead of 5-click workflow |
| **Anticipatory** | System knows what you need before you ask | Pre-loaded context, suggested actions |
| **Invisible** | Technology disappears, only outcome remains | Results appear, no awareness of processing |
| **Delightful** | Exceeds expectations in small ways | Thoughtful details that surprise |
| **Accessible** | Works for everyone, every context | Works eyes-free, one-handed, while distracted |
| **Recoverable** | Mistakes are trivially correctable | Undo anything, no destructive operations |

**For each user interaction, design:**

1. **Entry Point** - How does the user initiate?
   - Best: They don't—system anticipates
   - Good: Single word/gesture/thought
   - Acceptable: Clear, obvious action

2. **Information Gathering** - What does the system need?
   - Best: Already knows from context
   - Good: Single clarifying question
   - Acceptable: Progressive disclosure

3. **Processing** - What happens while working?
   - Best: Instantaneous (perceived)
   - Good: Engaging progress with real value
   - Acceptable: Clear status with useful preview

4. **Output Delivery** - How are results presented?
   - Best: Exactly what was needed, perfectly formatted
   - Good: Clear result with smart defaults
   - Acceptable: Options with recommendations

5. **Iteration** - How to refine?
   - Best: Natural language adjustments
   - Good: Direct manipulation
   - Acceptable: Clear modification paths

**Even "Unrealistic" is Fine:**
- Describe UI that would require technology that doesn't exist yet
- Include interactions that seem like science fiction
- The point is to know what we're aiming for

**Output:** `scratch/05-ideal-ux.md`

---

### Phase 6: Red Team Challenge

**Goal:** Stress-test the vision to ensure it's genuinely ideal, not just wishful thinking.

**Invoke RedTeam Skill - ParallelAnalysis workflow:**

**Attack Vectors:**

| Attacker | Challenge |
|----------|-----------|
| **Pragmatist** | "What's the smallest viable version of this ideal?" |
| **User Researcher** | "Are we sure users actually want this?" |
| **Edge Case Hunter** | "What scenarios break this ideal?" |
| **Complexity Spotter** | "Where does hidden complexity lurk?" |
| **Adoption Skeptic** | "Why wouldn't people actually use this?" |
| **Unintended Consequences** | "What problems does this ideal CREATE?" |

**Red Team Output Requirements:**
- Identify gaps in the ideal state definition
- Surface unstated assumptions
- Highlight potential failure modes
- Suggest refinements (not compromises)

**Output:** `scratch/06-red-team-challenge.md`

---

### Phase 7: Synthesis - Solarpunk Vision Spec

**Goal:** Produce the Solarpunk Vision specification document.

**Use Template:** `Templates/VisionTiers/SolarpunkVision.md`

**Compile all phases into the template, filling:**
- Section 1 (Ideal World State) from Phase 4 vision definition
- Section 2 (Ideal User Journey) from Phase 5 UX design
- Section 3 (Council Wisdom) from Phase 3 debate
- Section 4 (Research Synthesis) from Phase 2 research
- Section 5 (Red Team Challenges) from Phase 6 challenge
- Section 6 (Success Indicators) from Phase 1 stakes + Phase 4 outcomes
- Section 7 (Vision Diagram) - placeholder for Art skill
- Section 8 (Grounding Assessment) from Phase 8 below

---

### Phase 8: Grounding Assessment

**Goal:** Categorize each feature/aspect for transition to Grounded Ideal.

**This phase bridges the Solarpunk Vision to practical implementation.**

**Achievability Categories:**

| Category | Definition | Examples |
|----------|------------|----------|
| **ACHIEVABLE_NOW** | Can build with current technology | Standard AI models, existing APIs, proven patterns |
| **ACHIEVABLE_SOON** | Requires emerging tech (1-2 years) | Near-future AI capabilities, emerging standards |
| **REQUIRES_BREAKTHROUGH** | Needs tech that doesn't exist yet | AGI-level capabilities, impossible physics |
| **BLOCKED_BY_NON_TECH** | Legal, social, or other barriers | Regulation, social acceptance, privacy laws |

**Process:**

1. **Review all features from Phases 4-5:**
   - List every capability described in vision
   - List every UX interaction described

2. **Classify each feature:**
   ```markdown
   | Feature | Category | Notes |
   |---------|----------|-------|
   | Zero-effort capture | ACHIEVABLE_NOW | Voice + OCR exists |
   | Thought anticipation | ACHIEVABLE_SOON | Requires better context models |
   | Mind reading | REQUIRES_BREAKTHROUGH | No current path |
   | Autonomous purchasing | BLOCKED_BY_NON_TECH | Legal/consent issues |
   ```

3. **Identify non-negotiables:**
   - Which features define the essence of the vision?
   - What would make this not worth building if removed?

4. **Document the path forward:**
   - What can start immediately?
   - What requires waiting for technology?
   - What requires societal/legal change?

**Output:** `scratch/08-grounding-assessment.md`

---

### Final Output Structure

**Compile into Solarpunk Vision template:**

```markdown
# [Name] - Solarpunk Vision Specification

## Executive Summary
[One paragraph: What is this, why does it matter, what does ideal look like?]

## The Core Problem
### The Pain
[Vivid description of the problem as experienced by real people]

### The Stakes
[What's lost by not solving this perfectly?]

### Why Current Solutions Fall Short
[Research-backed gaps in existing approaches]

## The Ideal End State

### Vision Statement
[One sentence that captures the ideal future state]

### User Experience Narrative
[Story of a user interacting with the ideal solution - specific, vivid, emotional]

### Key Interactions
[For each major user interaction:]
- **Trigger:** [What initiates this?]
- **Experience:** [What does the user feel/see/do?]
- **Outcome:** [What result do they get?]
- **Why It's Ideal:** [What makes this better than alternatives?]

## Ideal UI/UX Specifications

### Core Principles
[3-5 principles that guide all design decisions]

### Key Screens/Interactions
[For each major touchpoint:]
- **Purpose:** [What user need does this serve?]
- **Ideal Behavior:** [How should it work perfectly?]
- **Anticipatory Features:** [How does it predict needs?]
- **Delight Moments:** [Where does it exceed expectations?]

### Accessibility & Inclusion
[How does the ideal work for everyone?]

## Debate Insights
### Convergent Wisdom
[What did all perspectives agree on?]

### Key Tensions
[Where did debate reveal important trade-offs?]

### Refined Understanding
[How did debate improve the problem/solution framing?]

## Red Team Findings
### Acknowledged Challenges
[What genuine obstacles exist?]

### Unstated Assumptions
[What are we assuming that might not be true?]

### Edge Cases to Consider
[Scenarios that need special handling]

## Success Criteria (Ideal State)

### User Outcomes
- [Measurable improvement in user's life/work]
- [Emotional/qualitative outcomes]

### System Performance
- [What "instant" means in this context]
- [What "perfect" accuracy looks like]

### Adoption Indicators
- [How we know users actually want this]

## The Path Forward

### What Must Be True
[Prerequisites for this ideal to be achievable]

### Nearest Achievable State
[Closest practical approximation to the ideal]

### Research & Development Needs
[What we'd need to figure out to close the gap]

---

*This specification represents the ideal end state—the north star guiding all implementation decisions. Every compromise from this ideal should be conscious and documented.*

**Generated:** [Date]
**Problem Domain:** [Domain]
**Research Depth:** Extensive (12 agents)
**Debate Rounds:** 3
**Red Team Perspectives:** 6
```

---

## Output Location

Save to: `~/.claude/Plans/Specs/[Name]-solarpunk-vision.md`

Also save working artifacts:
- `scratch/01-problem-excavation.md`
- `scratch/02-research-synthesis.md`
- `scratch/03-problem-debate.md`
- `scratch/04-vision-definition.md`
- `scratch/05-ideal-ux.md`
- `scratch/06-red-team-challenge.md`
- `scratch/07-synthesis.md`
- `scratch/08-grounding-assessment.md`

---

## Timing Expectations

| Phase | Approach | Duration |
|-------|----------|----------|
| Problem Excavation | Interview | ~10 min |
| Extensive Research | 12 parallel agents | ~60-90 sec |
| Council Debate | 3 rounds, 4 agents | ~30-60 sec |
| Vision Definition | Synthesis | ~30 sec |
| Ideal UX Design | Design thinking | ~60 sec |
| Red Team Challenge | 6 parallel attackers | ~30-60 sec |
| Synthesis | Compilation | ~30 sec |
| Grounding Assessment | Classification | ~30 sec |

**Total:** ~15-20 minutes (mostly user interview time)

---

## Post-Generation Options

Offer next steps:
1. **"Create Grounded Ideal"** → Apply technology constraints via `GroundedIdeal.md` workflow
2. **"Generate vision diagram"** → Visual via `GenerateVisionDiagram.md` workflow
3. **"Prototype key interaction"** → Design/Browser skill for mockup
4. **"Compare to existing"** → Gap analysis vs current state

---

## Example Usage

```
User: "Ideal end state spec for personal knowledge management"

→ Phase 1: Deep dive into PKM pain points
→ Phase 2: Research Notion, Obsidian, Roam, Mem, academic literature
→ Phase 3: Council debates "What does ideal knowledge capture look like?"
→ Phase 4: Vision of PKM that requires zero effort, perfect recall
→ Phase 5: UI that anticipates what you need before you know you need it
→ Phase 6: Red Team challenges assumptions about user behavior
→ Phase 7: Synthesize into comprehensive ideal spec
```

---

**Last Updated:** 2026-02-01
