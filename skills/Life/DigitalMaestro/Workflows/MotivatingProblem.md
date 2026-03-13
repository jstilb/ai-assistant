# Motivating Problem Workflow

## Purpose

The Motivating Problem workflow presents the original intellectual pressure behind a concept *before* naming or explaining the concept itself. The learner experiences the problem firsthand, struggles through natural but broken approaches, and arrives at the core insight organically. Only then is the concept formally introduced.

This models the pedagogical style of 3Blue1Brown and Steven Strogatz: making learners *feel the necessity* of a concept, not just its utility.

## When to Invoke

Trigger this workflow when ALL of the following conditions are met:

```
isNewConcept === true
conceptComplexity >= MODERATE
!learnerRequestedDirect
```

**Skip** this workflow when:
- The learner explicitly says "just tell me," "skip this," or "give me the definition"
- The concept is trivial (e.g., a vocabulary term, a simple formula with obvious meaning)
- The learner is in a timed review session
- `conceptComplexity < MODERATE`

---

## Phase 1: The Hook

**Goal:** Place a concrete, viscerally interesting problem in front of the learner — something they can immediately engage with using only their prior knowledge.

**Entry condition:** Workflow has been triggered. Learner has not seen the concept name yet.

**Tone guidance:**
- Speak in plain, jargon-free language. No technical vocabulary.
- Make the stakes feel real. Use numbers, names, physical objects.
- Frame it as a puzzle or a practical dilemma, not an abstract exercise.
- Write as if speaking to a curious friend, not a student.

**Anti-patterns to avoid:**
- Do NOT mention the concept name or any synonym that would give it away.
- Do NOT say "we're going to learn about X today."
- Do NOT use passive voice ("it can be shown that...").
- Do NOT start with a definition, even a simplified one.

**Exit condition:** The learner has been presented with the problem and is invited to think about how they would approach it. A response (even "I don't know") moves to Phase 2.

---

## Phase 2: Naive Attempts & Breakdown

**Goal:** Walk the learner through 2–3 natural but flawed approaches. Each attempt must be *concretely* shown to fail — with specific numbers, specific cases, or specific contradictions. Abstract failures ("this doesn't scale") are not allowed.

**Entry condition:** Phase 1 complete. Problem is established.

**Tone guidance:**
- Treat each naive attempt respectfully. These are the attempts a smart person would genuinely make.
- Show the breakdown gently, as if discovering it together.
- Use specific numbers in every example. "Let's try it with 5 and 7" — not "let's try it with some numbers."
- Each breakdown must surprise. If the failure is obvious, the attempt wasn't naive enough.

**Anti-patterns to avoid:**
- Do NOT reveal the correct approach in this phase.
- Do NOT say "of course, that won't work because..." — respect the attempt.
- Do NOT use the concept name or its synonyms.
- Do NOT present fewer than 2 concrete failed attempts.

**Exit condition:** At least 2 naive approaches have been tried and shown to fail in specific, concrete ways. The learner feels the tension: something is missing from their toolkit.

---

## Phase 3: The Aha Moment

**Goal:** Guide the learner to the edge of the insight. Open with a question — not a statement. Let the learner cross the threshold themselves.

**Entry condition:** Phase 2 complete. At least 2 naive attempts have concretely failed.

**Tone guidance:**
- Open with a question that points at the gap in the failed attempts.
- Slow down. This is the most important moment. Give the learner space.
- If the learner doesn't get it, offer a leading hint — not the answer.
- The aha moment should feel inevitable in retrospect.

**Anti-patterns to avoid:**
- Do NOT open Phase 3 with a statement. It MUST start with a question.
- Do NOT answer the question immediately after asking it.
- Do NOT name the concept in this phase.
- Do NOT rush. Premature formalism kills the insight.

**Exit condition:** The learner has articulated (or been guided to articulate) the core idea that resolves the tension from Phase 2. They've crossed the threshold without being handed the answer.

---

## Phase 4: Naming the Concept

**Goal:** Name the concept for the first time. Connect the name to the lived experience from Phases 1–3.

**Entry condition:** The learner has experienced the aha moment. They hold the intuition.

**Tone guidance:**
- Name the concept once, clearly.
- Immediately anchor the name to the experience: "What you just did — that's called [concept]."
- Express that mathematicians/scientists/thinkers struggled with exactly this problem for [X time].
- The naming should feel like a reward, not an introduction.

**Anti-patterns to avoid:**
- Do NOT introduce the concept name before Phase 4.
- Do NOT immediately launch into the formal definition (that's Phase 5).
- Do NOT use the name more than 2–3 times in this phase — let it breathe.

**Exit condition:** The concept has been named and anchored to the learner's experience.

---

## Phase 5: Formalization Bridge

**Goal:** Introduce the formal definition, notation, or procedure — and show how it maps directly to the intuition built in Phases 1–4.

**Entry condition:** Concept has been named. Learner holds the intuition.

**Tone guidance:**
- Walk through the formal definition piece by piece, connecting each element to the intuition.
- "The notation looks like this: [X]. The X here corresponds to the [Y] you discovered in Phase 3."
- Don't assume the formal version is obvious from the intuitive version.
- End with a concrete example that uses both the intuition and the formalism.

**Anti-patterns to avoid:**
- Do NOT present the formal definition as if the intuition didn't just happen.
- Do NOT overwhelm with all notation at once.
- Do NOT leave the learner without a concrete worked example.

**Exit condition:** The learner can state the formal definition AND explain why it takes the form it does, by reference to the motivating problem. Transition to the main ConceptIntro or Practice workflow.

---

## Escape Hatch

If at any point the learner says a variant of:
- "Just tell me"
- "Skip this"
- "What is it called?"
- "I already know this"
- "Give me the definition"
- "I don't want to figure it out"

Then:
1. **Acknowledge** the request without judgment: "Happy to jump ahead."
2. **Skip directly to Phase 4** — name the concept and give the brief anchor.
3. **Proceed to Phase 5** — offer the formal definition.
4. Do NOT restart the workflow from Phase 1.
5. Do NOT penalize or comment on skipping.

The escape hatch exits gracefully into the concept introduction, not into a void.

---

## Quality Checklist

Run this checklist against any generated motivating problem narrative before presenting it to the learner:

1. **Concept name absent from Phases 1–3**: Grep the Phase 1, 2, and 3 sections for the concept name and any synonyms. Zero matches required.
2. **>=2 concrete naive attempts in Phase 2**: Count the explicitly failed approaches. Each must include specific numbers, names, or concrete cases — not abstract reasoning.
3. **Phase 3 opens with a question**: The first sentence of Phase 3 must end with a "?". Statements are not acceptable as openers.
4. **Aha moment framed as discovery, not delivery**: Phase 3 must guide the learner to cross the threshold — not hand them the answer in the second sentence.
5. **Phase 4 names the concept exactly once in the naming moment**: The first use of the concept name should be in an anchoring sentence ("What you just discovered is called...").
6. **Phase 5 maps formalism to intuition element by element**: Each piece of notation or formal definition must be explicitly connected to something from the motivating problem.
7. **Escape hatch documented and reachable**: The workflow file must contain an Escape Hatch section with clear trigger phrases and a defined skip target (Phase 4-5).
8. **Phases 1-3 total 500-800 words**: Count words in Phase 1, 2, and 3 combined. Below 500 means insufficient depth; above 800 means too dense for a single sitting.

---

## Domain Adaptation Notes

This workflow is domain-agnostic. The same 5-phase structure applies across:

| Domain | Hook Style | Naive Attempt Style |
|--------|-----------|---------------------|
| Mathematics | Concrete counting or measurement problem | Arithmetic approaches that break at edge cases |
| Physics | Physical observation that defies intuition | Newtonian reasoning that fails to predict outcome |
| Programming | A task that seems simple but scales badly | Direct implementations that are correct but impossibly slow |
| Music Theory | A practical communication problem (conveying a melody) | Verbal or visual hacks that lose precision |
| Economics | A market behavior that common sense can't explain | Supply/demand reasoning that predicts the wrong direction |
| Philosophy | A claim that seems obvious but collapses under scrutiny | Common-sense defenses that contain hidden contradictions |
| History | A decision that seemed rational but led to disaster | Strategic reasoning that ignores second-order effects |

**Cross-domain rule:** The hook must use the *vocabulary of that domain's non-experts*. A music theory hook uses "song" and "tune" — not "pitch" and "interval." The concept vocabulary arrives in Phase 4.
