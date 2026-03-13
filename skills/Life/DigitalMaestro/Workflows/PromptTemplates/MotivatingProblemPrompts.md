# Motivating Problem Prompt Templates

Two-layer prompt system for generating motivating problem narratives.

---

## Layer 1: Concept Analysis Prompt

**Purpose:** Produce a structured analysis of the concept that will be used as input to Layer 2. This layer does NOT generate the narrative — it only extracts the raw materials.

**Input:** Concept name, domain, learner's current knowledge level, any known misconceptions.

**Prompt:**

```
You are preparing to teach the concept of [CONCEPT_NAME] to a learner at [KNOWLEDGE_LEVEL] level in the domain of [DOMAIN].

Your task is NOT to explain the concept. Your task is to produce a structured analysis that will be used to generate a motivating problem — a pre-teaching narrative that makes the learner feel the necessity of the concept before it is named.

Produce the following structured output:

## Concept Analysis: [CONCEPT_NAME]

### 1. Core Problem Statement
Describe the concrete problem that historically (or pedagogically) motivated the invention of this concept. This must be:
- Solvable with prior knowledge up to [KNOWLEDGE_LEVEL]
- Expressible in plain language without using [CONCEPT_NAME] or its synonyms
- Tied to a real, physical, or countable situation (not abstract)

### 2. Prerequisites
List the specific prior knowledge a [KNOWLEDGE_LEVEL] learner must have to engage with the hook:
- [prerequisite 1]
- [prerequisite 2]
...

### 3. Naive Attempts
List exactly 3 naive approaches a [KNOWLEDGE_LEVEL] learner would try. For each:
- **Attempt description**: What they try (in plain language)
- **Specific example**: A concrete instance with specific numbers or cases
- **Breakdown**: Exactly why it fails (with specific numbers or counterexample)
- **Why it feels reasonable**: Why a smart person would genuinely try this

### 4. The Aha Moment
Describe the insight that resolves the tension from the naive attempts. Frame it as the answer to this question:
- **The question**: A single question that points at the gap in all 3 naive attempts
- **The insight**: What the learner realizes when they sit with the question
- **Why it works**: How this insight sidesteps each of the 3 failures

### 5. Formal Bridge
Map the intuition to the formal concept:
- **Formal name**: [CONCEPT_NAME]
- **Formal definition**: [the standard definition in [DOMAIN]]
- **Intuition-to-formalism map**: For each element of the formal definition, identify which part of the aha moment it captures

### 6. Concept Name and Synonyms
List the concept name and all synonyms/related terms that must be FORBIDDEN in Phases 1-3 of the narrative:
- [concept name]
- [synonym 1]
- [synonym 2]
...
```

**Output:** A filled-in Concept Analysis following the structure above.

---

## Layer 2: Narrative Generation Prompt

**Purpose:** Take the Layer 1 Concept Analysis and produce the full 5-phase motivating problem narrative for the learner.

**Input:** The complete output from Layer 1, plus learner context (name, learning goal, current session state).

**Prompt:**

```
You are generating a motivating problem narrative for a learner. You have a structured Concept Analysis (produced separately) that provides all the raw materials. Your job is to turn that analysis into a compelling, pedagogically sound 5-phase narrative.

## Concept Analysis (your raw material)

[INSERT LAYER 1 OUTPUT HERE]

## Learner Context

- **Learner's current session goal:** [SESSION_GOAL]
- **Prior concepts covered today:** [PRIOR_CONCEPTS]
- **Known difficulty areas:** [DIFFICULTY_AREAS]
- **Preferred explanation style:** [STYLE: conversational | formal | Socratic]

## Narrative Requirements

Generate the following 5 phases. Each phase is a separate section of text you will present to the learner sequentially.

### PHASE 1: The Hook (target: 150-200 words)
- Open with the concrete problem from the Concept Analysis (Core Problem Statement)
- Use specific numbers, names, and physical situations
- Do NOT use any term from the Concept Name and Synonyms list
- End with an open question inviting the learner to try
- Tone: curious, conversational, direct

### PHASE 2: Naive Attempts & Breakdown (target: 250-350 words)
- Present exactly 2 of the 3 naive attempts from the Concept Analysis (choose the most surprising pair)
- For each attempt: describe it, show it in action with specific numbers, then show the breakdown with specific numbers
- Phrase the breakdown as a discovery, not a correction
- Do NOT use any term from the Concept Name and Synonyms list
- Do NOT reveal the solution

### PHASE 3: The Aha Moment (target: 100-150 words)
- MUST open with the question from the Concept Analysis (The question)
- After the question, give the learner a moment (a pause or reflection prompt)
- Offer the minimal hint needed to guide them toward the insight
- Do NOT answer the question directly — guide the learner to the edge
- Do NOT use any term from the Concept Name and Synonyms list

### PHASE 4: Naming the Concept (target: 80-120 words)
- Name the concept using exactly this anchor sentence: "What you just discovered is called [CONCEPT_NAME]."
- Connect the name to the specific experience from Phase 3
- Mention that this concept took [historically accurate time period, if known] for thinkers to formalize
- Tone: warm, rewarding

### PHASE 5: Formalization Bridge (target: 150-200 words)
- Walk through the formal definition element by element
- For each formal element, explicitly cite the corresponding part of the learner's experience
- End with one concrete worked example using both the intuition and the formalism
- Invite the learner to try a second example on their own

## Critical Constraints

1. The concept name and ALL synonyms from the Forbidden Terms list are PROHIBITED in Phases 1, 2, and 3
2. Phase 3 MUST begin with a question (first sentence ends with "?")
3. Phase 2 MUST contain at least 2 concrete examples with specific numbers
4. The total word count of Phases 1-3 MUST be between 500 and 800 words
5. The escape hatch is always available: if the learner says "just tell me" or "skip," jump to Phase 4

## Output Format

Return the narrative as five clearly labeled sections:

---
**[PHASE 1: THE HOOK]**
[phase 1 text]

---
**[PHASE 2: NAIVE ATTEMPTS]**
[phase 2 text]

---
**[PHASE 3: THE AHA MOMENT]**
[phase 3 text]

---
**[PHASE 4: NAMING THE CONCEPT]**
[phase 4 text]

---
**[PHASE 5: FORMALIZATION BRIDGE]**
[phase 5 text]
```

**Output:** A complete 5-phase motivating problem narrative ready to present to the learner.
