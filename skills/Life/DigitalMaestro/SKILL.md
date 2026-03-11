---
name: DigitalMaestro
description: AI-powered adaptive learning engine with FSRS spaced repetition, concept graphs, and domain-aware exercise generation. USE WHEN learn topic, study, practice, review cards, spaced repetition, learning session, study session, teach me, quiz me, test knowledge, master concept.
---

# DigitalMaestro - Adaptive Learning Engine

AI-powered learning system that combines FSRS v4 spaced repetition, concept graph navigation, adaptive difficulty, and domain-aware exercise generation to create personalized learning sessions.

---

## Workflow Routing

| Trigger | Workflow | Action |
|---------|----------|--------|
| "learn [topic]", "study [topic]" | **NewSession** | Start a full learning session |
| "review cards", "review due" | **ReviewOnly** | Quick SRS card review |
| "quiz me on [topic]" | **PracticeOnly** | Generate and evaluate exercises |
| "my progress", "learning stats" | **ProgressReport** | Show progress across all topics |
| "teach me [concept]" | **ConceptIntro** | Introduce a specific concept with exercises |

---

## Customization

| Setting | Default | Description |
|---------|---------|-------------|
| Default session duration | 30 min | Max session length |
| Review card limit | 20 | Max cards per warm-up |
| New concepts per session | 3 | Concepts introduced each session |
| Target retention | 90% | FSRS target retention rate |

---

## Voice Notification

```bash
curl -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message":"Starting DigitalMaestro learning session","voice_id":"iLVmqjzCGGvqtMCk6vVQ","title":"DigitalMaestro"}'
```

---

## Execution Steps

### NewSession Workflow

1. **Classify Domain** - Detect if topic is programming, language, science, math, or humanities
2. **Load/Create State** - Load existing progress or initialize new topic
3. **Generate Concept Graph** - AI creates prerequisite-ordered concept map (if new)
4. **Warm-Up Phase** - Review due SRS cards (sorted by overdue priority)
5. **New Content Phase** - Introduce next concepts from the concept graph
6. **Practice Phase** - Generate domain-appropriate exercises for concepts
7. **Evaluation** - AI evaluates answers with feedback, score, and suggestions
8. **Reflection Phase** - Summarize session, update difficulty, save progress
9. **Update Streaks** - Track daily study streaks

### ReviewOnly Workflow

1. **Load State** - Get all due cards across topics
2. **Sort by Priority** - Most overdue and lowest retrievability first
3. **Present Cards** - Show front, accept answer, show back
4. **Schedule** - FSRS v4 algorithm schedules next review based on rating
5. **Save** - Persist updated card states

### PracticeOnly Workflow

1. **Load Topic** - Get concept graph and progress
2. **Select Concepts** - Choose concepts based on current mastery
3. **Generate Exercises** - Domain-appropriate exercises at adaptive difficulty
4. **Evaluate** - AI evaluation with detailed feedback
5. **Update Mastery** - Adjust concept mastery and difficulty tier

### ProgressReport Workflow

1. **Load All Topics** - Get progress for every tracked topic
2. **Calculate Metrics** - Mastery %, due cards, streaks, session history
3. **Format Report** - Display comprehensive progress summary

---

## Examples

### Starting a Learning Session
```
User: learn TypeScript generics
Assistant: [Classifies as programming domain, generates concept graph,
           starts warm-up with any due cards, introduces new concepts,
           generates code challenges and exercises, evaluates answers]
```

### Quick Card Review
```
User: review my cards
Assistant: [Loads all due cards across topics, presents them one by one,
           records ratings, schedules next reviews via FSRS v4]
```

### Practice Quiz
```
User: quiz me on organic chemistry
Assistant: [Loads chemistry topic, selects concepts at current difficulty,
           generates science-domain exercises, evaluates answers with AI]
```

### Check Progress
```
User: my learning progress
Assistant: [Shows all topics with mastery %, due cards, streaks,
           recent session stats, difficulty tier for each topic]
```

---

## Integration

### Kaya Tools Used
- **Inference.ts** - AI-powered concept graphs, exercise generation, answer evaluation
- **StateManager.ts** - Persistent state with Zod validation, atomic transactions, backups

### State Location
`~/.claude/skills/Life/DigitalMaestro/state/maestro-state.json`

### Architecture

```
src/
  types/index.ts              - TypeScript interfaces for all domain objects
  algorithms/
    fsrs.ts                   - FSRS v4 spaced repetition scheduler
    concept-graph.ts          - AI concept graph generation and navigation
  core/
    domain-classifier.ts      - 5-domain classification (AI + heuristic)
    adaptive-difficulty.ts    - 5-tier difficulty adjustment system
    session-orchestrator.ts   - Session lifecycle management
  generators/
    exercise-generator.ts     - Domain-aware exercise generation
  evaluators/
    exercise-evaluator.ts     - AI + heuristic answer evaluation
  state/
    state-manager.ts          - Kaya StateManager wrapper for persistence
```

### Key Algorithms

**FSRS v4** - Free Spaced Repetition Scheduler using the DSR model (Difficulty, Stability, Retrievability). Cards are scheduled based on 19 optimized parameters for 90% target retention.

**Concept Graphs** - Directed acyclic graphs of learning prerequisites. AI generates nodes (concepts) and edges (prerequisite/related/builds-on/applies). Topological sorting determines optimal learning path.

**Adaptive Difficulty** - Five tiers (novice through expert) adjusted by rolling window of evaluation performance. Promotion at 80%+ correct rate, demotion below 40%.

---

## Five Learning Domains

| Domain | Exercise Types | Key Features |
|--------|---------------|--------------|
| Programming | Code challenges, multiple choice | Syntax highlighting, code review |
| Language | Translation, fill-in-blank | Conjugation, vocabulary drills |
| Science | Problem-solve, diagram-label | Experiment design, hypothesis testing |
| Math | Problem-solve, fill-in-blank | Step-by-step solutions, proofs |
| Humanities | Essay prompts, short answer | Critical analysis, argumentation |

---

## Session Phases

1. **Warm-Up** - SRS review of due cards (spaced repetition)
2. **New Content** - Introduction of concepts from the concept graph
3. **Practice** - Domain-appropriate exercises with AI evaluation
4. **Reflection** - Session summary, difficulty adjustment, streak update
