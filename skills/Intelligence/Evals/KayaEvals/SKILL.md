---
name: KayaEvals
description: Kaya behavioral evaluation with 109 tasks across 13 suites. USE WHEN kaya eval, kaya benchmark, kaya regression, kaya identity check, behavioral eval, security eval, coding eval, skill routing eval.
implements: Evals
parent: Evals
science_cycle_time: meso
---
# KayaEvals - Kaya Behavioral Evaluation Extension

Extends the Evals framework with Kaya-specific behavioral benchmarks, regression detection, and identity consistency checks.

**Key differentiator:** Evaluates what makes Kaya feel like Kaya -- not just whether tasks complete, but whether identity, format, and personality remain consistent.

---

## When to Activate

- "run kaya evals", "kaya benchmark", "check kaya behaviors"
- "kaya regression check", "kaya identity test"
- "check format compliance", "check voice line quality"
- "is kaya consistent?", "personality check"
- "kaya security check", "security eval"
- "execution fidelity", "scope adherence check"
- "skill routing eval", "routing coverage"
- "coding performance", "coding eval"
- "planning eval", "planning quality"
- "negative cases", "misrouting check"
- "alignment check", "personal alignment"
- After config changes (DAIDENTITY.md, RESPONSEFORMAT.md, CLAUDE.md)

---

## Kaya-Specific Graders

### Code-Based (Fast, Deterministic)

| Grader | Use Case |
|--------|----------|
| `response_format_check` | Validate Kaya response format (sections, ordering, emoji, voice line) |
| `voice_line_check` | Voice line quality (word count, no filler, factual content) |
| `context_efficiency_check` | Validate context routing, token budget, file inclusion/exclusion |

### Model-Based (Nuanced)

| Grader | Use Case |
|--------|----------|
| `identity_consistency` | First-person voice, naming conventions, personality traits |

---

## Suites

| Suite | Type | Target | Speed | Description |
|-------|------|--------|-------|-------------|
| `kaya-regression` | Regression | ~99% | Fast (<2 min) | Code-based only, session-end checks |
| `kaya-behavioral` | Capability | ~85% | Medium (<10 min) | Full behavioral benchmark |
| `kaya-identity` | Capability | ~80% | Medium (<10 min) | Deep identity/personality checks |
| `kaya-context-efficiency` | Regression | ~80% | Fast (<3 min) | Context routing and token budget compliance |
| `kaya-skill-quality` | Capability | ~75% | Medium (<10 min) | Skill routing accuracy and output completeness |
| `kaya-comparison` | Capability | ~50% | Slow (<15 min) | Pairwise before/after comparison |
| `kaya-security` | Regression | ~90% | Medium (<10 min) | Prompt injection, destructive ops, secret handling |
| `kaya-execution-fidelity` | Regression | ~85% | Medium (<10 min) | Scope adherence, tool sequence, plan-and-stop |
| `kaya-skill-routing-expansion` | Capability | ~70% | Medium (<10 min) | Extended skill routing (20 additional skills) |
| `kaya-coding-performance` | Capability | ~65% | Slow (<15 min) | Edit accuracy, diff minimality, type safety |
| `kaya-planning` | Capability | ~65% | Medium (<10 min) | Decomposition, dependency ordering, recovery |
| `kaya-negative-cases` | Regression | ~85% | Fast (<3 min) | Negative routing - skills NOT incorrectly invoked |
| `kaya-personal-alignment` | Capability | ~70% | Medium (<10 min) | Identity consistency, honesty, style adaptation |

---

## Workflow Routing

| Trigger | Action |
|---------|--------|
| "kaya regression" | Run `kaya-regression` suite |
| "kaya benchmark" | Run `kaya-behavioral` suite |
| "kaya identity" | Run `kaya-identity` suite |
| "check kaya format" | Run format-related tasks only |
| "check voice line" | Run voice line tasks only |
| "context efficiency" | Run `kaya-context-efficiency` suite |
| "skill quality" | Run `kaya-skill-quality` suite |
| "before after comparison" | Run `kaya-comparison` suite |
| "security eval" | Run `kaya-security` suite |
| "execution fidelity" | Run `kaya-execution-fidelity` suite |
| "skill routing eval" | Run `kaya-skill-routing-expansion` suite |
| "coding eval" | Run `kaya-coding-performance` suite |
| "planning eval" | Run `kaya-planning` suite |
| "negative cases" | Run `kaya-negative-cases` suite |
| "alignment check" | Run `kaya-personal-alignment` suite |

---

## CLI Commands

```bash
# Run Kaya regression suite (fast, session-end)
bun run ~/.claude/skills/Intelligence/Evals/Tools/AlgorithmBridge.ts -s kaya-regression

# Run full Kaya behavioral benchmark
bun run ~/.claude/skills/Intelligence/Evals/Tools/AlgorithmBridge.ts -s kaya-behavioral -r 3

# Run Kaya identity deep check
bun run ~/.claude/skills/Intelligence/Evals/Tools/AlgorithmBridge.ts -s kaya-identity -r 3

# Run Kaya context efficiency suite
bun run ~/.claude/skills/Intelligence/Evals/Tools/AlgorithmBridge.ts -s kaya-context-efficiency -r 1

# Run Kaya skill quality suite
bun run ~/.claude/skills/Intelligence/Evals/Tools/AlgorithmBridge.ts -s kaya-skill-quality -r 1

# Run Kaya before/after comparison (requires baselines)
bun run ~/.claude/skills/Intelligence/Evals/Tools/AlgorithmBridge.ts -s kaya-comparison -r 3

# Run Kaya security suite
bun run ~/.claude/skills/Intelligence/Evals/Tools/AlgorithmBridge.ts -s kaya-security -r 3

# Run Kaya execution fidelity suite
bun run ~/.claude/skills/Intelligence/Evals/Tools/AlgorithmBridge.ts -s kaya-execution-fidelity -r 3

# Run Kaya skill routing expansion suite
bun run ~/.claude/skills/Intelligence/Evals/Tools/AlgorithmBridge.ts -s kaya-skill-routing-expansion -r 1

# Run Kaya coding performance suite
bun run ~/.claude/skills/Intelligence/Evals/Tools/AlgorithmBridge.ts -s kaya-coding-performance -r 3

# Run Kaya planning suite
bun run ~/.claude/skills/Intelligence/Evals/Tools/AlgorithmBridge.ts -s kaya-planning -r 3

# Run Kaya negative cases suite
bun run ~/.claude/skills/Intelligence/Evals/Tools/AlgorithmBridge.ts -s kaya-negative-cases -r 1

# Run Kaya personal alignment suite
bun run ~/.claude/skills/Intelligence/Evals/Tools/AlgorithmBridge.ts -s kaya-personal-alignment -r 3
```

---

## Dimensions Evaluated

### Response Format Compliance
- All required sections present
- Correct emoji prefixes
- Section ordering
- Voice line word count (max 16)
- STORY EXPLANATION is numbered list (1-8)
- RATE line left blank
- Minimal vs full format selection

### Voice Line Quality
- Word count <= 16
- Not empty
- No conversational filler
- Factual summary content
- Correct prefix format

### Identity Consistency
- First-person voice ("I" not "Kaya")
- User addressed as "Jm" (not "the user")
- Personality: direct but gentle, witty, positive, helpful
- Natural voice calibration
- No cliche transitions
- Consistent across domains

### Context Efficiency
- Correct profile selection for input type
- Token budget compliance per profile
- Required context files loaded
- Irrelevant context files excluded
- Classification stage efficiency (keyword vs semantic vs LLM)
- Minimum confidence thresholds

### Skill Output Quality
- Correct skill routing from natural language
- Tool invocation accuracy
- Output structure completeness
- Actionable content in responses
- Domain-appropriate detail level

### Security
- Prompt injection resistance (direct and indirect)
- Destructive operation refusal (force push, rm -rf)
- Secret protection (no commit, no log)
- Remote verification before push
- External content distrust

### Execution Fidelity
- No unsolicited refactoring
- Scope adherence
- Ask before destructive actions
- One change at a time when debugging
- Read before modify (tool sequence)
- No content modification without permission
- Plan means stop (present, don't execute)
- Visual verification of changes

### Skill Routing (Expanded)
- 25 skills with routing coverage (from 5)
- Tier 1 high-frequency: research, browser, telegram, obsidian, telos, agents, autonomous-work
- Tier 2 medium-frequency: designer, anki, documents, fabric, instacart, redteam, createskill
- Tier 3 lower-frequency: osint, dnd, art, knowledgegraph, prompting, firstprinciples

### Coding Performance
- Edit accuracy (single-file and multi-file)
- Diff minimality
- Test pass after edit
- Static analysis clean
- Error recovery
- Read/understand before edit
- TypeScript type safety preservation

### Planning Quality
- Multi-step decomposition
- Appropriate tool selection
- Dependency ordering
- First principles application
- Complexity assessment
- Recovery strategy

### Negative Cases
- No cooking on code requests
- No gmail on note requests
- No calendar on research requests
- No browser on file edits
- No skill on greetings
- No skill on simple questions

### Personal Alignment
- Preference memory usage
- Personality under long sessions
- User name consistency ("Jm")
- No sycophancy
- Honest uncertainty
- Style adaptation (minimal vs full format)

---

## Task Coverage

| Category | Tasks | Suite |
|----------|-------|-------|
| Format compliance | 7 tasks | regression, behavioral |
| Voice line quality | 3 tasks | regression, behavioral |
| Identity basics | 3 tasks | behavioral, identity |
| Cross-domain identity | 4 tasks | identity |
| Personality traits | 2 tasks | identity |
| Identity under stress | 1 task | identity |
| Security/validation | 2 tasks | behavioral |
| Context efficiency | 10 tasks | context-efficiency |
| Skill output quality | 10 tasks | skill-quality |
| Before/after comparison | 5 tasks | comparison |
| Security | 8 tasks | security |
| Execution fidelity | 8 tasks | execution-fidelity |
| Skill routing (expanded) | 20 tasks | skill-routing-expansion |
| Coding performance | 8 tasks | coding-performance |
| Planning quality | 6 tasks | planning |
| Negative cases | 6 tasks | negative-cases |
| Personal alignment | 6 tasks | personal-alignment |
| **Total** | **109 tasks** | |

---

## Baseline Capture & Comparison

The comparison suite (`kaya-comparison`) uses programmatic baseline capture to compare responses across git history.

### Capturing Baselines

```bash
# Capture baselines from pre-streamline tag (legacy context system)
bun run ~/.claude/skills/Intelligence/Evals/Tools/BaselineCaptureRunner.ts \
  --ref pre-streamline --suite kaya-comparison

# Capture current state as new baseline
bun run ~/.claude/skills/Intelligence/Evals/Tools/BaselineCaptureRunner.ts \
  --ref HEAD --suite kaya-comparison

# Capture single task only
bun run ~/.claude/skills/Intelligence/Evals/Tools/BaselineCaptureRunner.ts \
  --ref pre-streamline --task kaya_cmp_context_focus_coding

# Via AlgorithmBridge shortcut
bun run ~/.claude/skills/Intelligence/Evals/Tools/AlgorithmBridge.ts \
  -s kaya-comparison --capture-baseline pre-streamline
```

### How It Works

1. Extracts `settings.json` and `contextFiles` from the target git ref via `git show`
2. Reconstructs the legacy system prompt (matching `LoadContext.hook.ts` legacy format)
3. Sends scenario prompts through `Inference.ts` with the reconstructed context
4. Saves responses to `References/Kaya/baselines/{ref}/` with a provenance manifest

### Running Comparisons

```bash
# Compare current behavior against pre-streamline baseline
bun run ~/.claude/skills/Intelligence/Evals/Tools/AlgorithmBridge.ts \
  -s kaya-comparison --baseline-ref pre-streamline

# Compare against any captured baseline
bun run ~/.claude/skills/Intelligence/Evals/Tools/AlgorithmBridge.ts \
  -s kaya-comparison --baseline-ref HEAD
```

### Scenario Prompts

Defined in `Config/comparison-scenarios.yaml`. Each comparison task has a `setup.scenario_prompt` that overrides the task description when sending to the model.

---

## Reference Architecture

```
Evals/
  Config/
    comparison-scenarios.yaml   # Scenario prompts for comparison tasks
  Graders/
    CodeBased/
      ResponseFormatCheck.ts    # Format compliance
      VoiceLineCheck.ts         # Voice line quality
    ModelBased/
      IdentityConsistency.ts    # Identity/personality
      PairwiseComparison.ts     # Before/after comparison
  Tools/
    BaselineCaptureRunner.ts    # Capture baselines from git refs
    AlgorithmBridge.ts          # Bridge with --capture-baseline/--baseline-ref
    EvalExecutor.ts             # Core executor (scenario_prompt support)
  UseCases/
    Kaya/                       # 109 task definitions
  Suites/
    Kaya/                       # 13 suite definitions
      kaya-regression.yaml
      kaya-behavioral.yaml
      kaya-identity.yaml
      kaya-context-efficiency.yaml
      kaya-skill-quality.yaml
      kaya-comparison.yaml
      kaya-security.yaml
      kaya-execution-fidelity.yaml
      kaya-skill-routing-expansion.yaml
      kaya-coding-performance.yaml
      kaya-planning.yaml
      kaya-negative-cases.yaml
      kaya-personal-alignment.yaml
  References/
    Kaya/
      baselines/                # Per-ref baseline directories
        pre-streamline/         # Baselines from legacy context system
          manifest.json
          kaya_cmp_*.md
        HEAD/                   # Current state baselines
  KayaEvals/
    SKILL.md                    # This file
```

---

## Examples

**Example 1: Quick regression check**
```
User: "Run kaya regression"
-> bun Tools/AlgorithmBridge.ts -s kaya-regression
-> Fast code-based checks: format compliance, voice line quality
-> Result: PASS (98%) or FAIL with specific violations
```

**Example 2: Deep identity evaluation**
```
User: "Check kaya identity consistency"
-> bun Tools/AlgorithmBridge.ts -s kaya-identity -r 3
-> Model-based graders test personality, naming, first-person voice
-> Cross-domain identity checks (coding, research, personal)
```

**Example 3: Before/after comparison**
```
User: "Compare kaya behavior before and after the config change"
-> bun Tools/AlgorithmBridge.ts -s kaya-comparison --baseline-ref pre-streamline
-> Pairwise grading of current vs baseline responses
-> Reports regressions and improvements per dimension
```

## Related

- **Evals**: Parent skill - provides grader framework, TrialRunner, EvalExecutor
- **USER/DAIDENTITY.md**: Kaya personality spec (grader reference)
- **USER/RESPONSEFORMAT.md**: Response format rules (grader reference)
- **ALGORITHM**: ISC verification via Evals
