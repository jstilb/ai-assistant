# FULLPROJECT Workflow

Execute the complete Ralph methodology for a new project or major feature.

## Overview

This workflow implements all five phases of Geoffrey Huntley's original Ralph technique:
1. Conversation (30+ minutes)
2. Spec Generation
3. Infrastructure Setup
4. Planning Loop
5. Building Loop

## Phase 1: CONVERSATION (30+ minutes)

**Goal:** Thoroughly understand requirements before any code is written.

### Step 1.1: Identify Jobs To Be Done (JTBD)

Ask the user:
- What is the high-level outcome you want?
- Who will use this and how?
- What would make this "done"?
- What should this definitely NOT do?
- What existing thing is this most similar to?

### Step 1.2: Break Down Into Topics of Concern

Each topic should pass the "one sentence test":
- ✓ "Color extraction analyzes images to identify dominant colors"
- ✗ "User system handles authentication, profiles, and billing" (3 topics)

Typical topics for a web app:
- Overview/Architecture
- Database/Data Models
- API Endpoints
- Frontend Components
- Authentication
- Testing Strategy

### Step 1.3: Research If Needed

For each topic, optionally spawn research agents:
```bash
Task({
  prompt: "Research best practices for [topic]",
  subagent_type: "ClaudeResearcher"
})
```

---

## Phase 2: SPEC GENERATION

**Goal:** Create detailed specs that will guide every iteration.

### Step 2.1: Create Specs Directory

```bash
mkdir -p specs
```

### Step 2.2: Generate Spec Files

For each topic of concern, create a spec file:

```markdown
# [Topic Name]

## Overview
[1-2 sentences describing this topic's purpose]

## Requirements
- [ ] Requirement 1
- [ ] Requirement 2
- [ ] Requirement 3

## Constraints
- Must use TypeScript
- Must have tests
- Must follow existing patterns

## Examples
[Concrete examples of expected behavior]

## Anti-Patterns
- Don't do X
- Avoid Y
```

### Step 2.3: Validate Coverage

Ensure every JTBD maps to at least one spec topic.

---

## Phase 3: INFRASTRUCTURE SETUP

**Goal:** Establish the files that make Ralph work.

### Step 3.1: Create AGENTS.md

```markdown
# Project Operational Guide

## Commands
- Build: `bun run build`
- Test: `bun run test`
- Lint: `bun run lint`
- Type Check: `bun run typecheck`

## Architecture
- Source code: `src/`
- Shared utilities: `src/lib/`
- Tests: `src/__tests__/`

## Patterns
- Use functional components
- Prefer composition over inheritance
- All functions must have types

## Known Issues
[Track any gotchas discovered during iterations]
```

### Step 3.2: Create PROMPT Files

Copy templates from:
- `~/.claude/skills/RalphLoop/Templates/PROMPT_plan.md`
- `~/.claude/skills/RalphLoop/Templates/PROMPT_build.md`

Customize the `ULTIMATE GOAL` section for your project.

### Step 3.3: Create loop.sh

```bash
cp ~/.claude/skills/RalphLoop/Templates/loop.sh ./loop.sh
chmod +x loop.sh
```

---

## Phase 4: PLANNING LOOP

**Goal:** Generate a prioritized implementation plan.

### Step 4.1: Run Planning Iterations

```bash
./loop.sh plan 3
```

This will:
- Study all specs
- Analyze existing code (if any)
- Perform gap analysis
- Generate `IMPLEMENTATION_PLAN.md`

### Step 4.2: Review Plan

Verify the plan makes sense:
- Tasks are appropriately sized (one task = one iteration)
- Dependencies are correctly ordered
- No missing steps

### Step 4.3: Iterate if Needed

If plan is incomplete:
```bash
./loop.sh plan 2  # Run 2 more planning iterations
```

---

## Phase 5: BUILDING LOOP

**Goal:** Implement everything in the plan.

### Step 5.1: Start Building

```bash
./loop.sh 20  # Start with conservative limit
```

### Step 5.2: Monitor Progress

Watch for:
- Commits being made
- Tests passing
- Plan items getting checked off

### Step 5.3: Handle Issues

If Ralph goes off-track:
1. Cancel current loop: `bun run RalphLoopExecutor.ts --cancel`
2. Review what went wrong
3. Update AGENTS.md with learnings
4. Regenerate plan: `./loop.sh plan 2`
5. Resume building: `./loop.sh 20`

### Step 5.4: Iterate Until Complete

Repeat planning/building cycles until all specs are implemented.

---

## Completion Criteria

Project is complete when:
- [ ] All spec requirements have corresponding implementations
- [ ] All tests pass
- [ ] Build succeeds
- [ ] IMPLEMENTATION_PLAN.md shows all items done

---

## Cost Estimation

| Project Size | Planning Iterations | Building Iterations | Estimated Cost |
|--------------|--------------------|--------------------|----------------|
| Small feature | 2-3 | 10-20 | $10-30 |
| Medium feature | 3-5 | 20-50 | $30-80 |
| Large project | 5-10 | 50-200 | $80-300+ |

---

## Tips

1. **Don't skip conversation** - 30 minutes of discussion saves hours of misdirected iteration
2. **Specs are sacred** - Ralph can only be as good as your specs
3. **Observe the loop** - Watch early iterations to catch systematic errors
4. **Regenerate plans freely** - Plans are disposable, specs are not
5. **Add constraints reactively** - When you see a pattern you don't like, add a constraint to PROMPT files
