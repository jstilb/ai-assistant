---
name: _RALPHLOOP
description: Autonomous iteration engine based on Geoffrey Huntley's Ralph Wiggum technique. USE WHEN tasks need persistent iteration until success, long-running autonomous work, "iterate until", "keep trying until", "ralph loop", or when tests/builds need to pass before completion. Integrates with THEALGORITHM for ISC-driven execution.
tier: private
---

# _RALPHLOOP - Autonomous Iteration Engine

> **Private Skill** - Uses _ALLCAPS prefix to avoid merge conflicts with upstream Kaya updates.

**The technique that reduces software development costs to less than a fast food worker's wage.**
---

## Overview

Ralph Loop is Geoffrey Huntley's revolutionary technique for autonomous AI-assisted software development. Named after Ralph Wiggum from The Simpsons - "perpetually confused, always making mistakes, but never stopping" - the technique embodies the philosophy that **iteration beats perfection**.

**Core Insight:** Each iteration spawns a FRESH CONTEXT. Memory persists only through the filesystem - git commits, progress files, and specs. This solves the context accumulation problem that plagues standard agent loops.

**Results:**
- Full compilers built overnight for ~$297 in API costs
- $50,000 contracts reduced to under $300
- Integration tests converted from 4 minutes to 2 seconds
- Production APIs built with TDD methodology

---

## The Fundamental Mechanism

At its purest, Ralph is a bash loop:

```bash
while :; do cat PROMPT.md | claude ; done
```

This elegantly brutish approach:
1. Feeds the same prompt to Claude repeatedly
2. Each iteration gets fresh context (no accumulated history)
3. Agent sees previous work through git history and modified files
4. Loop continues until completion promise detected or max iterations reached

---

## Five Critical Phases

**Phase 1: CONVERSATION (30+ minutes)**
Discuss requirements thoroughly BEFORE coding. Vague specs = meh results.
- Identify Jobs To Be Done (JTBD)
- Break JTBD into discrete topics of concern
- Use subagents to load information from URLs into context

**Phase 2: SPEC GENERATION**
Create detailed specs in `specs/` directory:
- `overview.md` - High-level architecture
- `database.md` - Data models and schemas
- `api.md` - Endpoints and contracts
- `frontend.md` - UI components and flows

**Phase 3: INFRASTRUCTURE SETUP**
Establish the loop infrastructure:
- `AGENTS.md` - Operational guide loaded each iteration
- `PROMPT_build.md` - Building mode instructions
- `PROMPT_plan.md` - Planning mode instructions
- `loop.sh` - Outer loop orchestration script
- `IMPLEMENTATION_PLAN.md` - Generated task list

**Phase 4: PLANNING LOOP**
Generate implementation tasks:
```bash
./loop.sh plan 3  # Run 3 planning iterations
```
Subagents study specs and codebase, perform gap analysis, create prioritized tasks.

**Phase 5: BUILDING LOOP**
Execute one item per iteration:
```bash
./loop.sh 20  # Run up to 20 building iterations
```
Pick highest priority item, implement, test, commit, loop.

---

## Key Principles

### 1. Context Is Everything

With ~176K truly usable tokens from 200K advertised capacity:
- Allocate first ~5,000 tokens for specs
- Use main agent as scheduler, spawn subagents for expensive work
- Prefer Markdown over JSON for token efficiency
- One task per loop iteration maximizes "smart zone" utilization

### 2. Fresh Context Each Iteration

**The critical insight:** Standard agent loops suffer from context accumulation - every failed attempt stays in conversation history. Ralph solves this by starting each iteration with fresh context. Knowledge transfers only via persistent files:
- Git commits and history
- `IMPLEMENTATION_PLAN.md`
- `AGENTS.md` operational notes
- `progress.txt` log

### 3. Steering Ralph: Patterns + Backpressure

**Upstream Steering (Patterns):**
- Deterministic setup with consistent file allocation per loop
- Existing code patterns influence generated output
- Add utilities and patterns to guide toward correct implementations

**Downstream Steering (Backpressure):**
- Tests, type checks, lints, and builds create backpressure
- `AGENTS.md` specifies actual commands for project-specific validation
- Each commit MUST pass all tests and types
- LLM-as-judge tests can provide feedback on subjective criteria

### 4. Let Ralph Ralph

- Lean into LLM's ability to self-identify, self-correct, and self-improve
- Apply eventual consistency through iteration
- The plan is disposable - regenerate when trajectory goes wrong
- Move outside the loop: observe and course-correct rather than prescribe upfront

### 5. Never Blame The Model

"LLMs are amplifiers of operator skill" - when Ralph fails:
- Never blame the model
- Always be curious about what went wrong
- Add prompt constraints when problems appear
- Tune incrementally based on observed failure patterns

---

## Workflow Routing

| Trigger | Description | Workflow |
|---------|-------------|----------|
| "ralph loop", "iterate until" | Start a new Ralph loop | `STARTLOOP` |
| "check ralph", "loop status" | Check current loop status | `STATUS` |
| "cancel ralph", "stop loop" | Cancel active loop | `CANCEL` |
| "ralph plan", "planning loop" | Run planning iterations | `PLANLOOP` |
| "ralph build", "building loop" | Run building iterations | `BUILDLOOP` |

**Integration Triggers:**
- ISC row with `execution.ralph_loop` capability → Auto-spawn via THEALGORITHM
- Tasks requiring persistent iteration → Auto-suggest Ralph approach
- "Until tests pass", "until it works" → Ralph keywords detected

---

## Integration with THEALGORITHM

Ralph Loop is registered as a capability in THEALGORITHM:

```yaml
execution:
  ralph_loop:
    type: iterative_loop
    model: sonnet
    effort_min: QUICK
    icon: "🔄"
    keywords:
      - "iterate until"
      - "keep trying"
      - "until tests pass"
      - "ralph"
    use_when: "Need persistent iteration until success criteria met"
```

**ISC-Driven Ralph Loops:**

When THEALGORITHM assigns `ralph_loop` to an ISC row:

1. **ISC row becomes the spec** - The "What Ideal Looks Like" description becomes the task
2. **Completion promise from verification** - ISC verification criteria define success
3. **Loop infrastructure from Templates/** - Use `Templates/loop.sh` as the base
4. **Status updates ISC** - Loop completion updates ISC row status

---

## File Structure

```
project-root/
├── loop.sh                    # Outer loop orchestration
├── PROMPT_build.md           # Building mode instructions
├── PROMPT_plan.md            # Planning mode instructions
├── AGENTS.md                 # Operational guide (loaded each iteration)
├── IMPLEMENTATION_PLAN.md    # Prioritized task list (generated)
├── progress.txt              # Iteration log
├── specs/                    # Requirement specifications
│   ├── overview.md
│   ├── [topic-a].md
│   └── [topic-b].md
├── src/                      # Application source code
└── src/lib/                  # Shared utilities
```

---

## Loop Script Template

```bash
#!/bin/bash
# loop.sh - Ralph Loop Orchestrator

if [ "$1" = "plan" ]; then
  MODE="plan"
  PROMPT_FILE="PROMPT_plan.md"
  MAX_ITERATIONS=${2:-0}
elif [[ "$1" =~ ^[0-9]+$ ]]; then
  MODE="build"
  PROMPT_FILE="PROMPT_build.md"
  MAX_ITERATIONS=$1
else
  MODE="build"
  PROMPT_FILE="PROMPT_build.md"
  MAX_ITERATIONS=0
fi

ITERATION=0
while true; do
  [ $MAX_ITERATIONS -gt 0 ] && [ $ITERATION -ge $MAX_ITERATIONS ] && break

  cat "$PROMPT_FILE" | claude -p \
    --output-format=stream-json \
    --model sonnet \
    --verbose

  git push origin "$(git branch --show-current)"
  ITERATION=$((ITERATION + 1))
done
```

**Usage:**
- `./loop.sh` - Build mode, unlimited iterations
- `./loop.sh 20` - Build mode, max 20 iterations
- `./loop.sh plan` - Plan mode, unlimited
- `./loop.sh plan 5` - Plan mode, max 5 iterations

---

## Prompt Templates

### PROMPT_plan.md

```markdown
0a. Study `specs/*` with up to 250 parallel Sonnet subagents to learn
    application specifications.
0b. Study @IMPLEMENTATION_PLAN.md (if present).
0c. Study `src/lib/*` to understand shared utilities & components.
0d. Application source code is in `src/*`.

1. Study @IMPLEMENTATION_PLAN.md and use up to 500 Sonnet subagents
   to study existing source code and compare against `specs/*`. Use
   Opus subagent to analyze findings, prioritize tasks, and
   create/update @IMPLEMENTATION_PLAN.md. Ultrathink. Consider
   searching for TODO, minimal implementations, placeholders,
   skipped tests, inconsistent patterns.

IMPORTANT: Plan only. Do NOT implement. "Don't assume not
implemented; confirm with code search first." Treat `src/lib` as
standard library. Prefer consolidated implementations there.

ULTIMATE GOAL: [project-specific goal]. If missing, search first,
then author specification at specs/FILENAME.md if needed.
```

### PROMPT_build.md

```markdown
0a. Study `specs/*` with up to 500 parallel Sonnet subagents.
0b. Study @IMPLEMENTATION_PLAN.md.
0c. Application source code is in `src/*`.

1. Implement functionality per specifications using parallel
   subagents. Follow @IMPLEMENTATION_PLAN.md, choose most important
   item. Before making changes, search codebase (don't assume not
   implemented). Use up to 500 Sonnet subagents for
   searches/reads, only 1 for build/tests. Use Opus subagents for
   complex reasoning. Ultrathink.

2. After implementing, run tests. "If functionality is missing then
   it's your job to add it as per specifications."

3. When discovering issues, immediately update
   @IMPLEMENTATION_PLAN.md. When resolved, update and remove item.

4. When tests pass, update @IMPLEMENTATION_PLAN.md, then
   `git add -A`, `git commit`, `git push`.

99999. When authoring documentation, capture the why.
999999. Single sources of truth, no migrations/adapters.
9999999. Implement functionality completely—no placeholders.
```

---

## Critical Language Patterns

Use these specific phrases in prompts for optimal behavior:

| Pattern | Why It Works |
|---------|--------------|
| "study" | More thorough than "read" or "look at" |
| "don't assume not implemented" | Forces verification before creation |
| "using parallel subagents" | Enables concurrent exploration |
| "only 1 subagent for build/tests" | Prevents race conditions |
| "Ultrathink" | Triggers deeper reasoning |
| "capture the why" | Documents decisions, not just code |
| "keep it up to date" | Maintains living documentation |
| "if functionality is missing then it's your job to add it" | Ownership mindset |

---

## Best Practices

### DO:
- Spend 30+ minutes on requirements BEFORE coding
- Create detailed specs covering distinct JTBD topics
- Set conservative iteration limits (10-20 to start)
- Monitor token consumption and costs
- Keep CI green - each commit must pass tests
- Observe the loop and tune prompts based on failures
- Run on isolated VMs when using `--dangerously-skip-permissions`

### DON'T:
- Skip the conversation phase
- Allow multiple items per loop iteration
- Ignore "signs" (reimplementation, placeholders, forgotten commits)
- Run with unlimited iterations on large codebases
- Use Ralph for exploratory/discovery phases
- Use for judgment-heavy architectural decisions
- Run on your main machine without sandboxing

---

## When To Use Ralph

**Optimal Use Cases:**
- Large refactors (class → functional components)
- Framework migrations (Jest → Vitest)
- TDD workflows (implement to pass existing tests)
- Test coverage expansion
- TypeScript adoption
- Greenfield builds with clear specs
- Code generation tasks with verifiable outputs

**When NOT To Use:**
- Ambiguous requirements lacking clear success criteria
- Architectural decisions requiring human judgment
- Security-sensitive code (auth, payments, data handling)
- Exploratory tasks without defined endpoints
- Iterative discovery phases
- When you need tight control over implementation choices

---

## Cost Management

**Token consumption scales with:**
- Codebase size and complexity
- Number of iterations
- Context window requirements per cycle

**Safety mechanisms:**
- Set `--max-iterations` as primary safety mechanism
- Monitor with `--output-format=stream-json`
- Budget: 10-20 iterations for small tasks (~$10-20)
- Budget: 50+ iterations for large tasks (~$50-100+)

---

## Budget Tracking (BudgetTracker.ts)

Ralph loops now include budget tracking that pulls actual usage from Claude CLI output.

### Budget Levels

| Level | Amount | Use Case |
|-------|--------|----------|
| QUICK | $1 | Quick fixes, simple iterations, single-file changes |
| STANDARD | $10 | Typical development tasks, moderate complexity |
| THOROUGH | $50 | Comprehensive implementations, significant scope |
| DETERMINED | $200 | Large-scale work, overnight runs |

### Usage

```bash
# Initialize budget tracking
bun run Tools/BudgetTracker.ts --init STANDARD

# After each iteration, parse the session output
bun run Tools/BudgetTracker.ts --parse-session iteration-output.log

# Check if budget allows continuation
bun run Tools/BudgetTracker.ts --check && ./loop.sh 1

# View current status
bun run Tools/BudgetTracker.ts --status
```

### Integration with loop.sh

```bash
#!/bin/bash
# Enhanced loop.sh with budget tracking

bun run Tools/BudgetTracker.ts --init ${BUDGET_LEVEL:-STANDARD}

while bun run Tools/BudgetTracker.ts --check; do
  cat "$PROMPT_FILE" | claude -p \
    --output-format=stream-json \
    --model sonnet \
    2>&1 | tee iteration-${ITERATION}.log

  # Parse cost from output and update budget
  bun run Tools/BudgetTracker.ts --parse-session iteration-${ITERATION}.log

  ITERATION=$((ITERATION + 1))
done
```

### Safety Thresholds

- **Hard stop at 95%** - Loop terminates automatically
- **Warning at 75%** - Caution message displayed
- **Warning at 90%** - Critical warning displayed

---

## Convergence Detection (ConvergenceDetector.ts)

Track loop trajectory to detect when iteration is helping vs hurting.

### Trajectories

| Trajectory | Emoji | Meaning | Action |
|------------|-------|---------|--------|
| CONVERGING | ✅ | Metrics improving | Continue |
| STABLE | ➖ | Metrics steady | Monitor |
| OSCILLATING | 🔄 | Metrics fluctuating | Pause after 5 |
| DIVERGING | ❌ | Metrics worsening | Rollback after 3 |
| UNKNOWN | ❓ | Insufficient data | Continue |

### Usage

```bash
# Initialize tracking
bun run Tools/ConvergenceDetector.ts --init

# After each iteration, parse test output and record
npm test 2>&1 | bun run Tools/ConvergenceDetector.ts --parse -

# Or record metrics manually
bun run Tools/ConvergenceDetector.ts --record '{"testsPassed":10,"testsFailed":2,"buildSuccess":true}'

# Check if loop should continue
bun run Tools/ConvergenceDetector.ts --should-continue && ./loop.sh 1

# View status
bun run Tools/ConvergenceDetector.ts --status
```

### Auto-Actions

- **3 consecutive DIVERGING** → Auto-rollback to last good commit
- **5 consecutive OSCILLATING** → Pause loop for review
- **10 iterations no-progress** → Stop loop

### Integration with loop.sh

```bash
#!/bin/bash
# Enhanced loop.sh with convergence detection

bun run Tools/ConvergenceDetector.ts --init

while bun run Tools/ConvergenceDetector.ts --should-continue; do
  cat "$PROMPT_FILE" | claude -p --model sonnet

  # Run tests and record metrics
  npm test 2>&1 | bun run Tools/ConvergenceDetector.ts --parse -

  git add -A && git commit -m "Iteration $ITERATION"
done
```

### Rollback Support

When diverging is detected, the system can automatically rollback:

```bash
# Manual rollback to last good commit
bun run Tools/ConvergenceDetector.ts --rollback
```

---

## Quality Gates Workflow

The quality gates workflow for autonomous Ralph execution:

```
┌─────────────────────────────────────────────────────────────────┐
│                     QUALITY GATES WORKFLOW                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  1. BUDGET CHECK (before each iteration)                        │
│     └── BudgetTracker.ts verifies budget remaining              │
│     └── Hard stop at 95% of budget                              │
│                                                                   │
│  2. CONVERGENCE CHECK (after each iteration)                    │
│     └── ConvergenceDetector.ts analyzes trajectory              │
│     └── Rollback on diverging, pause on oscillating             │
│                                                                   │
│  3. APPROVAL GATE (before merge/deploy)                         │
│     └── ApprovalQueue.ts queues for user review                 │
│     └── Feature branch model with PR workflow                   │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Three States of Ralph

Ralph has three possible outcomes:

1. **Underbaked** - Stopped too early, work incomplete
2. **Baked** - Perfect amount, specifications fulfilled
3. **Overbaked** - Ran too long, bizarre emergent behaviors (unexpected cryptography implementations, etc.)

---

## Tool Reference

**Tools (kept):**
- `Tools/BudgetTracker.ts` — Per-loop budget tracking from Claude CLI output
- `Tools/ConvergenceDetector.ts` — Track loop trajectory (converging/diverging/oscillating)
- `Templates/loop.sh` — The core ralph loop template

---

## Sources & Credits

This skill synthesizes research from:

- [Geoffrey Huntley - ghuntley.com/ralph](https://ghuntley.com/ralph/) - Original creator
- [Everything is a Ralph Loop](https://ghuntley.com/loop/) - Philosophy expansion
- [Dev Interrupted Podcast](https://linearb.io/dev-interrupted/podcast/inventing-the-ralph-wiggum-loop) - 58-minute interview
- [HumanLayer Brief History](https://www.humanlayer.dev/blog/brief-history-of-ralph) - Historical context
- [GitHub how-to-ralph-wiggum](https://github.com/ghuntley/how-to-ralph-wiggum) - Implementation guide
- [Matt Pocock's YouTube Overview](https://x.com/mattpocockuk/status/2008200878633931247) - Practical walkthrough
- [VentureBeat Coverage](https://venturebeat.com/technology/how-ralph-wiggum-went-from-the-simpsons-to-the-biggest-name-in-ai-right-now/) - Industry analysis

---

## Version History

- **v1.0.0** (2026-01-20): Initial creation - comprehensive Ralph Loop skill with THEALGORITHM integration
